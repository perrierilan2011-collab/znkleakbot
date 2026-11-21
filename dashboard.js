// dashboard.js — panel web du bot (aucune dépendance : module http natif)
// Variables Railway : PANEL_PASSWORD (obligatoire) — PORT est fourni automatiquement par Railway.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  const { client, commands, handlers, autocomplete, getG, CMD_CATEGORIES, ALWAYS_ON, PUBLIC_COMMANDS, OWNER_ONLY } = ctx;
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
    req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
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
          name: t.name, categoryId: t.categoryId, staffRoles: t.staffRoles || [], logChannelId: t.logChannelId, counter: t.counter || 0, dm: !!t.dm,
          panels: (t.panels || []).map((p) => ({ channelId: p.channelId, messageId: p.messageId, button: !!p.button })),
          reasons: (t.reasons || []).map((r) => ({ label: r.label, emoji: r.emoji, description: r.description, categoryId: r.categoryId, staffRoleId: r.staffRoleId })),
        })),
        channels: guild.channels.cache.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        roles: guild.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      };
    },
    'GET /api/emojis': async (_r, q) => {
      const first = q.get('id');
      return [...client.guilds.cache.values()].sort((a, b) => (b.id === first) - (a.id === first))
        .map((g) => ({ name: g.name, emojis: g.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated })) }))
        .filter((g) => g.emojis.length);
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
