// dashboard.js — panel web du bot (aucune dépendance : module http natif)
// Variables Railway : PANEL_PASSWORD (obligatoire) — PORT est fourni automatiquement par Railway.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sb = require('./supabase');

const F = (id, label, long, max, req) => ({ id, label, long, max, req });
const ANN = (t) => [F('titre', 'Titre', 0, 256), F('texte', t, 1, 4000, 1), F('image_url', "URL d'image", 0, 500),
  F('footer', 'Pied de page', 0, 2048), F('couleur', 'Couleur hex', 0, 7)];
const MODALS = {
  annonce: ANN("Texte de l'annonce"),
  'autorole/creer': ANN('Texte du message'),
  'message-mp': [F('titre', 'Titre', 0, 256), F('texte', 'Message', 1, 2000, 1), F('couleur', 'Couleur hex', 0, 7)],
  'bienvenue/configurer': [F('content', 'Texte au-dessus', 0, 500), F('title', "Titre de l'embed", 0, 256),
    F('description', 'Description', 1, 4000), F('image', "URL de l'image", 0, 500), F('color', 'Couleur hex', 0, 7)],
  'ticket/message': [F('content', 'Texte au-dessus', 1, 1000), F('title', 'Titre', 0, 256), F('description', 'Description', 1, 4000),
    F('image', "URL de l'image", 0, 500), F('color', 'Couleur hex', 0, 7)],
};

module.exports = function startDashboard(ctx) {
  const { client, commands, handlers, autocomplete, getG, CMD_CATEGORIES, ALWAYS_ON, PUBLIC_COMMANDS, OWNER_ONLY, db, save, DB_FILE } = ctx;
  const PASS = process.env.PANEL_PASSWORD;
  if (!PASS) return console.warn('[panel] PANEL_PASSWORD absent : panel désactivé.');
  const KEY = crypto.createHash('sha256').update('panel:' + PASS).digest();
  const sign = (s) => crypto.createHmac('sha256', KEY).update(s).digest('hex');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const authed = (req) => {
    const m = /(?:^|; )panel=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
    return !!m && Number(m[1]) > Date.now() && same(m[2], sign(m[1]));
  };
  const HTML = () => fs.readFileSync(path.join(__dirname, 'panel.html'));
  const catOf = {};
  for (const [k, c] of Object.entries(CMD_CATEGORIES)) for (const n of c.commands) catOf[n] = k;

  const send = (res, code, data, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  const body = (req) => new Promise((ok) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 3e7) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
  });
  const ser = (m) => {
    if (typeof m === 'string') return { content: m };
    const j = (x) => (x?.toJSON ? x.toJSON() : x);
    return { content: m.content || '', embeds: (m.embeds || []).map(j), components: (m.components || []).map(j),
      files: (m.files || []).map((f) => f.name || 'fichier') };
  };

  // Interaction virtuelle : les handlers du bot s'exécutent comme si le propriétaire tapait la commande
  function virtual(guild, owner, cmd, sub, o, modal, out) {
    const need = (v, n, r) => { if (r && (v == null || v === '')) throw new Error(`Option manquante : ${n}`); return v == null || v === '' ? null : v; };
    const opt = {
      getSubcommand: (r = true) => { if (!sub && r) throw new Error('Sous-commande manquante'); return sub || null; },
      getString: (n, r) => need(o[n], n, r),
      getInteger: (n, r) => { const v = need(o[n], n, r); return v == null ? null : parseInt(v, 10); },
      getNumber: (n, r) => { const v = need(o[n], n, r); return v == null ? null : Number(v); },
      getBoolean: (n) => (o[n] == null || o[n] === '' ? null : o[n] === true || o[n] === 'true'),
      getUser: (n, r) => { const v = need(o[n], n, r); return v ? (guild.members.cache.get(v)?.user || client.users.cache.get(v) || null) : null; },
      getMember: (n) => guild.members.cache.get(o[n]) || null,
      getChannel: (n, r) => { const v = need(o[n], n, r); return v ? guild.channels.cache.get(v) || null : null; },
      getRole: (n, r) => { const v = need(o[n], n, r); return v ? guild.roles.cache.get(v) || null : null; },
      getAttachment: (n) => (o[n] ? { url: o[n], name: 'image.png', contentType: 'image/png' } : null),
      get: (n) => (o[n] ? { name: n, value: o[n], role: guild.roles.cache.get(o[n]) || null, user: guild.members.cache.get(o[n])?.user || null } : null),
      getFocused: () => '',
    };
    const put = (m) => { if (out[0] && out.edit) out[0] = ser(m); else { out.push(ser(m)); out.edit = true; } };
    const base = {
      id: String(Date.now()), commandName: cmd, guild, guildId: guild.id, member: owner, user: owner.user,
      channel: guild.systemChannel || guild.channels.cache.find((c) => c.isTextBased?.() && !c.isThread?.()),
      options: opt, replied: false, deferred: false,
      reply: async (m) => { base.replied = true; put(m); return { id: '0' }; },
      deferReply: async () => { base.deferred = true; },
      editReply: async (m) => { put(m); return { id: '0' }; },
      followUp: async (m) => { out.push(ser(m)); return { id: '0' }; },
      showModal: async () => {},
      awaitModalSubmit: async () => {
        if (!modal) throw new Error('Formulaire non rempli');
        return { ...base, customId: '', fields: { getTextInputValue: (k) => String(modal[k] ?? '') } };
      },
    };
    base.channelId = base.channel?.id;
    return base;
  }

  async function ctxFor(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Serveur introuvable');
    const owner = await guild.members.fetch(guild.ownerId);
    return { guild, owner };
  }


  // ---------- Édition directe : message d'ouverture des tickets et sous-panels ----------
  const txt = (v, max) => { const t = String(v ?? '').replace(/\r/g, '').trim(); return t ? t.slice(0, max) : undefined; };
  const urlOk = (v) => { const t = String(v ?? '').trim(); return /^https?:\/\/\S+$/i.test(t) ? t.slice(0, 500) : undefined; };
  const colorOk = (v) => { const t = String(v ?? '').trim(); return /^#?[0-9a-f]{6}$/i.test(t) ? '#' + t.replace('#', '') : undefined; };
  const cleanOpenMsg = (m) => {
    const out = {
      content: txt(m.content, 1000), title: txt(m.title, 256), description: txt(m.description, 4000),
      image: urlOk(m.image), thumbnail: urlOk(m.thumbnail), color: colorOk(m.color), footer: txt(m.footer, 2048),
      claimLabel: txt(m.claimLabel, 80), closeLabel: txt(m.closeLabel, 80), claimEmoji: txt(m.claimEmoji, 64), closeEmoji: txt(m.closeEmoji, 64),
      showInfo: typeof m.showInfo === 'boolean' ? m.showInfo : undefined,
      timestamp: m.timestamp === false ? false : undefined,
      fields: (Array.isArray(m.fields) ? m.fields : []).slice(0, 10)
        .map((f) => ({ name: txt(f?.name, 256), value: txt(f?.value, 1024), inline: !!f?.inline })).filter((f) => f.name && f.value),
    };
    if (!out.fields.length) delete out.fields;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  };
  // Éléments qui peuvent porter leur propre message d'ouverture (le plus précis gagne à l'ouverture du ticket)
  const openTargets = (cfg, s) => {
    if (s.type === 'config') return [cfg];
    if (s.type === 'panel') return (cfg.panels || []).filter((p) => p.messageId === s.id);
    if (s.type === 'reason') return [...(cfg.reasons || []), ...(cfg.dmChoices || [])].filter((r) => r.id === s.id);
    if (s.type === 'sub') {
      const [spId, chId] = String(s.id || '').split('/');
      const c = cfg.subPanels?.find((x) => x.id === spId)?.choices?.find((x) => x.id === chId);
      return c ? [c] : [];
    }
    return [];
  };
  const guildCfg = (guildId, name) => {
    if (!client.guilds.cache.has(guildId)) throw new Error('Serveur introuvable');
    const cfg = getG(guildId).tickets?.[name];
    if (!cfg) throw new Error('Configuration introuvable');
    return cfg;
  };

  const routes = {
    'GET /api/schema': async () => ({
      commands: commands.map((c) => ({ ...c.toJSON(), category: catOf[c.name] || 'autres',
        flags: { owner: OWNER_ONLY.has(c.name), public: PUBLIC_COMMANDS.has(c.name), always: ALWAYS_ON.has(c.name) } })),
      categories: { ...Object.fromEntries(Object.entries(CMD_CATEGORIES).map(([k, c]) => [k, c.label])), autres: '📦 Autres' },
      modals: MODALS,
    }),
    'GET /api/guilds': async () => client.guilds.cache.map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), members: g.memberCount })),
    'GET /api/guild': async (_r, q) => {
      const { guild } = await ctxFor(q.get('id'));
      return {
        id: guild.id, name: guild.name, count: guild.memberCount, disabled: getG(guild.id).disabledCommands || [],
        welcome: getG(guild.id).welcome,
        tickets: Object.values(getG(guild.id).tickets || {}).map((t) => ({
          name: t.name, categoryId: t.categoryId, staffRoles: t.staffRoles || [], logChannelId: t.logChannelId, counter: t.counter || 0, dm: !!t.dm, openMsg: t.openMsg || null,
          panels: (t.panels || []).map((p) => ({ channelId: p.channelId, messageId: p.messageId, button: !!p.button, openMsg: p.openMsg || null })),
          reasons: (t.reasons || []).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, description: r.description, categoryId: r.categoryId, staffRoleId: r.staffRoleId, openMsg: r.openMsg || null })),
          dmChoices: (t.dmChoices || []).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, openMsg: r.openMsg || null })),
          subPanels: t.subPanels || [], subLinks: t.subLinks || {}, defaultSub: t.defaultSubPanelId || null,
        })),
        channels: guild.channels.cache.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        roles: guild.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      };
    },
    'POST /api/ticket-open-msg': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const targets = openTargets(cfg, b.scope || {});
      if (!targets.length) throw new Error('Élément introuvable (il a peut-être été supprimé).');
      const msg = b.reset ? {} : cleanOpenMsg(b.msg || {});
      const empty = !Object.keys(msg).length;
      for (const t of targets) {
        if (t === cfg) cfg.openMsg = empty ? null : msg;
        else if (empty) delete t.openMsg;
        else t.openMsg = JSON.parse(JSON.stringify(msg));
      }
      save();
      return { ok: true, empty };
    },
    'POST /api/subpanel-update': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const sp = cfg.subPanels?.find((x) => x.id === b.subId);
      if (!sp) throw new Error('Sous-panel introuvable');
      const f = b.fields || {};
      if ('name' in f) {
        const n = txt(f.name, 60);
        if (!n) throw new Error('Le nom est obligatoire');
        if (cfg.subPanels.some((x) => x !== sp && x.name.toLowerCase() === n.toLowerCase())) throw new Error('Un sous-panel porte déjà ce nom.');
        sp.name = n;
      }
      if ('title' in f) sp.title = txt(f.title, 256) || null;
      if ('description' in f) sp.description = txt(f.description, 4000) || null;
      if ('placeholder' in f) sp.placeholder = txt(f.placeholder, 100) || null;
      if ('color' in f) sp.color = colorOk(f.color) || null;
      if ('image' in f) sp.image = urlOk(f.image) || null;
      if ('thumbnail' in f) sp.thumbnail = urlOk(f.thumbnail) || null;
      if ('footer' in f) sp.footer = txt(f.footer, 2048) || null;
      if ('payment' in f) sp.payment = !!f.payment; // sous-panel « mode de paiement » (variable {paiement})
      save();
      return { ok: true };
    },
    'GET /api/emojis': async (_r, q) => {
      const first = q.get('id');
      // Liste relue sur Discord à chaque ouverture : un emoji ajouté, renommé ou supprimé apparaît tout de suite
      await Promise.all([...client.guilds.cache.values()].map((g) => g.emojis.fetch().catch(() => {})));
      return [...client.guilds.cache.values()].sort((a, b) => (b.id === first) - (a.id === first))
        .map((g) => ({ name: g.name, emojis: g.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated })) }))
        .filter((g) => g.emojis.length);
    },
    'GET /api/storage': async () => {
      const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH, st = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE) : null;
      return { path: DB_FILE, size: st?.size || 0, mtime: st?.mtimeMs || Date.now(), guilds: Object.keys(db).length,
        persistent: !!mount && path.resolve(DB_FILE).startsWith(path.resolve(mount)), supabase: sb.status() };
    },
    'POST /api/supabase-push': async () => { await sb.pushNow(db); return { ok: true }; },
    'POST /api/restore': async (_r, _q, b) => {
      const d = b.data;
      if (!d || typeof d !== 'object' || Array.isArray(d) || Object.values(d).some((v) => !v || typeof v !== 'object')) throw new Error('Fichier de sauvegarde invalide');
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.avant-restauration');
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, d);
      save();
      return { ok: true, guilds: Object.keys(db).length };
    },
    'GET /api/members': async (_r, q) => {
      const { guild } = await ctxFor(q.get('id'));
      const s = (q.get('q') || '').toLowerCase();
      if (guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => {});
      return guild.members.cache.filter((m) => !s || m.user.username.toLowerCase().includes(s) || m.displayName.toLowerCase().includes(s))
        .first(25).map((m) => ({ id: m.id, name: m.displayName, tag: m.user.username, avatar: m.displayAvatarURL({ size: 32 }) }));
    },
    'POST /api/autocomplete': async (_r, _q, b) => {
      const { guild, owner } = await ctxFor(b.guildId);
      let choices = [];
      const i = { ...virtual(guild, owner, b.command, b.sub, b.options || {}, null, []),
        isAutocomplete: () => true, respond: async (c) => { choices = c; } };
      i.options.getFocused = (full) => (full ? { name: b.option, value: b.value || '' } : b.value || '');
      i.options.getSubcommand = () => b.sub || null;
      await autocomplete(i);
      return choices;
    },
    'POST /api/run': async (_r, _q, b) => {
      const { guild, owner } = await ctxFor(b.guildId);
      const { command: cmd, sub } = b;
      if (!handlers[cmd]) throw new Error('Commande inconnue');
      if (getG(guild.id).disabledCommands?.includes(cmd) && !ALWAYS_ON.has(cmd)) throw new Error('Cette commande est désactivée (réactive-la avec la commande « commandes »).');
      const schema = commands.find((c) => c.name === cmd)?.toJSON();
      const sc = sub ? schema.options.find((x) => x.name === sub) : schema;
      for (const x of sc?.options || []) {
        if (x.type === 6 && b.options?.[x.name]) await guild.members.fetch(b.options[x.name]).catch(() => {});
        if (x.type === 9 && b.options?.[x.name] && !guild.roles.cache.has(b.options[x.name])) await guild.members.fetch(b.options[x.name]).catch(() => {});
      }
      const out = [];
      const i = virtual(guild, owner, cmd, sub, b.options || {}, b.modal || null, out);
      const job = handlers[cmd](i).then(() => 'done', (e) => { throw e; });
      const r = await Promise.race([job, new Promise((ok) => setTimeout(() => ok('running'), 12000))]);
      if (r === 'done' && !out.length) out.push({ content: '✅ Commande exécutée.' });
      return { ok: true, running: r === 'running', replies: out };
    },
  };

  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, HTML(), 'text/html');
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const b = await body(req);
        if (!b.password || !same(sign(String(b.password)), sign(PASS))) return send(res, 401, { error: 'Mot de passe incorrect' });
        const exp = String(Date.now() + 7 * 864e5);
        res.setHeader('Set-Cookie', `panel=${exp}.${sign(exp)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup') {
        if (!authed(req)) return send(res, 401, { error: 'Connexion requise' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="sauvegarde-bot-${new Date().toISOString().slice(0, 10)}.json"` });
        return res.end(JSON.stringify(db, null, 2));
      }
      if (url.pathname === '/api/me') return send(res, 200, { authed: authed(req) });
      const fn = routes[`${req.method} ${url.pathname}`];
      if (!fn) return send(res, 404, { error: 'Introuvable' });
      if (!authed(req)) return send(res, 401, { error: 'Connexion requise' });
      const b = req.method === 'POST' ? await body(req) : {};
      send(res, 200, await fn(req, url.searchParams, b));
    } catch (e) {
      console.error('[panel]', e);
      send(res, 500, { error: e.message || 'Erreur' });
    }
  }).listen(process.env.PORT || 3000, () => console.log('[panel] en ligne sur le port', process.env.PORT || 3000));
};
