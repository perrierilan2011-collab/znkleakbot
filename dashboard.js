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
  const { client, commands, handlers, autocomplete, getG, refreshPanels, refreshSalesPanel, CMD_CATEGORIES, ALWAYS_ON, PUBLIC_COMMANDS, OWNER_ONLY, db, save, DB_FILE } = ctx;
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
  /* ---------- Sauvegardes : copies automatiques sur le bot + export / import ---------- */
  const BK_DIR = path.join(path.dirname(DB_FILE), 'backups');
  try { fs.mkdirSync(BK_DIR, { recursive: true }); } catch { /* rien */ }
  const bkOk = (n) => /^sauvegarde-[\w.-]+\.json$/.test(String(n || ''));
  const listBk = () => { try {
    return fs.readdirSync(BK_DIR).filter(bkOk).map((f) => { const s = fs.statSync(path.join(BK_DIR, f)); return { name: f, size: s.size, mtime: s.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; } };
  const pruneBk = () => { // garde les 100 plus récentes + les 5 plus grosses (jamais effacées par une série de copies vides)
    const l = listBk(), keep = new Set([...l.slice(0, 100), ...[...l].sort((a, b) => b.size - a.size).slice(0, 5)].map((x) => x.name));
    for (const x of l) if (!keep.has(x.name)) try { fs.unlinkSync(path.join(BK_DIR, x.name)); } catch { /* rien */ }
  };
  let lastHash = '';
  const snapshot = (tag = 'auto') => {
    try {
      if (!Object.keys(db).length) return null;
      const json = JSON.stringify(db, null, 2), h = crypto.createHash('sha1').update(json).digest('hex');
      if (tag === 'auto' && h === lastHash) return null;
      lastHash = h;
      const name = `sauvegarde-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${tag}.json`;
      fs.writeFileSync(path.join(BK_DIR, name), json);
      pruneBk();
      return name;
    } catch (e) { console.error('[backup]', e.message); return null; }
  };
  setTimeout(() => snapshot('demarrage'), 20000).unref?.();
  setInterval(() => snapshot('auto'), 30 * 60e3).unref?.();
  async function restore(d) { // remet les serveurs du fichier ; les autres serveurs ne sont pas touchés
    const ids = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : [];
    if (!ids.some((k) => /^\d{5,}$/.test(k)) || ids.some((k) => !d[k] || typeof d[k] !== 'object')) throw new Error('Fichier de sauvegarde invalide');
    snapshot('avant-restauration'); // copie de l'état actuel, toujours
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.avant-restauration');
    for (const k of ids) db[k] = d[k];
    sb.forceNext(); // une restauration voulue peut être plus petite que Supabase
    save();
    let warn = null;
    try { await sb.pushNow(db); } catch (e) { warn = e.message; }
    return { ok: true, guilds: Object.keys(db).length, restored: ids.length, warn };
  }
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
    if (s.type === 'preset') return (cfg.openPresets || []).filter((p) => p.id === s.id);
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
      const d = getG(guild.id);
      return {
        id: guild.id, name: guild.name, count: guild.memberCount, disabled: d.disabledCommands || [],
        welcome: d.welcome,
        panelColor: d.panelColor || '#5865F2',
        vouch: {
          channelId: d.vouch?.channelId || null, enabled: d.vouch?.enabled !== false, count: (d.vouches || []).length,
          average: (d.vouches || []).length ? (d.vouches.reduce((n, v) => n + (v.stars || 0), 0) / d.vouches.length) : 0,
        },
        vouches: (d.vouches || []).slice(-12).reverse().map((v) => ({
          id: v.id, from: v.from, stars: v.stars, message: v.message, image: v.image || null,
          at: v.at, ticketName: v.ticketName || null, config: v.config || null,
          name: client.users.cache.get(v.from)?.globalName || client.users.cache.get(v.from)?.username || null,
          avatar: client.users.cache.get(v.from)?.displayAvatarURL({ size: 64 }) || null,
        })),
        sales: {
          channelId: d.sales?.channelId || null, messageId: d.sales?.messageId || null,
          count: d.sales?.count || 0, total: d.sales?.total || 0, currency: d.sales?.currency || '€',
          entries: (d.sales?.entries || []).slice(-15).reverse().map((e) => ({
            ...e,
            name: client.users.cache.get(e.buyerId)?.username || e.buyerName || null,
          })),
        },
        openTickets: Object.keys(d.open || {}).length,
        invites: {
          total: Object.values(d.invites?.stats || {}).reduce((n, s) => n + (s.joins || 0), 0),
          members: Object.keys(d.invites?.stats || {}).length,
        },
        tickets: Object.values(d.tickets || {}).map((t) => ({
          name: t.name, categoryId: t.categoryId, staffRoles: t.staffRoles || [], logChannelId: t.logChannelId, counter: t.counter || 0,
          dm: !!t.dm, openMsg: t.openMsg || null, openMsgId: t.openMsgId || null,
          color: t.color || null, placeholder: t.placeholder || null,
          openPresets: (t.openPresets || []).map((p) => ({ id: p.id, name: p.name, openMsg: p.openMsg || null })),
          panels: (t.panels || []).map((p) => ({ channelId: p.channelId, messageId: p.messageId, button: !!p.button, btnLabel: p.btnLabel || null, btnStyle: p.btnStyle || null, openMsg: p.openMsg || null, openMsgId: p.openMsgId || null })),
          reasons: (t.reasons || []).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, description: r.description, categoryId: r.categoryId, staffRoleId: r.staffRoleId, openMsg: r.openMsg || null, openMsgId: r.openMsgId || null })),
          dmChoices: (t.dmChoices || []).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, openMsg: r.openMsg || null, openMsgId: r.openMsgId || null })),
          subPanels: t.subPanels || [], subLinks: t.subLinks || {}, defaultSub: t.defaultSubPanelId || null,
        })),
        channels: guild.channels.cache.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        roles: guild.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      };
    },
    // ---------- Configuration d'un ticket (créer / modifier / supprimer) ----------
    'POST /api/ticket-config': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      const name = String(b.name || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{1,30}$/.test(name)) throw new Error('Nom invalide : lettres minuscules, chiffres et tirets (30 max).');
      if (b.action === 'create') {
        if (d.tickets[name]) throw new Error('Une configuration porte déjà ce nom.');
        const categoryId = b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null;
        if (!categoryId) throw new Error('Choisis une catégorie Discord valide.');
        const staffRoles = (Array.isArray(b.staffRoles) ? b.staffRoles : []).filter((id) => id !== guild.id && guild.roles.cache.has(id));
        if (!staffRoles.length) throw new Error('Choisis au moins un rôle staff.');
        d.tickets[name] = {
          name, categoryId, staffRoles,
          logChannelId: b.logChannelId && guild.channels.cache.has(b.logChannelId) ? b.logChannelId : null,
          reasons: [], counter: 0, panels: [], placeholder: null, openMsg: null,
          dm: false, dmMigrated: true, dmChoices: [], dmTexts: null, dmImage: null,
          subPanels: [], subLinks: {}, defaultSubPanelId: null, openPresets: [],
          color: colorOk(b.color) || null,
        };
        save();
        return { ok: true, name };
      }
      const cfg = d.tickets[name];
      if (!cfg) throw new Error('Configuration introuvable');
      if (b.action === 'delete') {
        delete d.tickets[name];
        save();
        return { ok: true };
      }
      if (b.action === 'update') {
        if ('categoryId' in b) {
          const id = b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null;
          if (!id) throw new Error('Catégorie invalide.');
          cfg.categoryId = id;
        }
        if ('staffRoles' in b) {
          const ids = (Array.isArray(b.staffRoles) ? b.staffRoles : []).filter((id) => id !== guild.id && guild.roles.cache.has(id));
          if (!ids.length) throw new Error('Garde au moins un rôle staff.');
          cfg.staffRoles = ids;
        }
        if ('logChannelId' in b) cfg.logChannelId = b.logChannelId && guild.channels.cache.has(b.logChannelId) ? b.logChannelId : null;
        if ('placeholder' in b) cfg.placeholder = txt(b.placeholder, 150) || null;
        if ('color' in b) cfg.color = colorOk(b.color) || null;
        save();
        if (b.refresh !== false) await refreshPanels(guild, name).catch(console.error);
        return { ok: true };
      }
      throw new Error('Action inconnue');
    },

    // ---------- Couleur / vouch / ventes (réglages du serveur) ----------
    'POST /api/guild-settings': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      let recolor = false;
      if ('panelColor' in b) {
        const c = colorOk(b.panelColor);
        if (!c) throw new Error('Couleur invalide (hex, ex : #5865F2).');
        d.panelColor = c;
        recolor = true;
      }
      if ('vouchChannelId' in b) d.vouch.channelId = b.vouchChannelId && guild.channels.cache.has(b.vouchChannelId) ? b.vouchChannelId : null;
      if ('vouchEnabled' in b) d.vouch.enabled = b.vouchEnabled === true || b.vouchEnabled === 'true' || b.vouchEnabled === 1;
      if ('salesCurrency' in b) d.sales.currency = txt(b.salesCurrency, 8) || '€';
      if ('salesChannelId' in b) {
        const id = b.salesChannelId && guild.channels.cache.has(b.salesChannelId) ? b.salesChannelId : null;
        if (id !== d.sales.channelId) {
          const oldChannelId = d.sales.channelId;
          const oldMessageId = d.sales.messageId;
          d.sales.channelId = id;
          d.sales.messageId = null;
          d.sales.sig = null;
          save();
          if (oldChannelId && oldMessageId && oldChannelId !== id) {
            const oldCh = await guild.channels.fetch(oldChannelId).catch(() => null);
            const oldMsg = oldCh && await oldCh.messages.fetch(oldMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(console.error);
          }
          await refreshSalesPanel(guild, !!id).catch(console.error);
        }
      }
      save();
      if (recolor) {
        await refreshPanels(guild).catch(console.error);
        await refreshSalesPanel(guild, false).catch(console.error);
      } else if ('salesCurrency' in b) {
        await refreshSalesPanel(guild, false).catch(console.error);
      }
      return { ok: true };
    },
    'POST /api/sales-panel': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      if (!d.sales.channelId) throw new Error("Choisis d'abord un salon pour le suivi des ventes.");
      const msg = await refreshSalesPanel(guild, true);
      if (!msg) throw new Error('Impossible de créer le panel : vérifie les permissions du bot dans le salon.');
      return { ok: true, messageId: msg.id };
    },
    'POST /api/sales-reset': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      if (!b.confirm) throw new Error('Confirmation requise');
      d.sales.count = 0;
      d.sales.total = 0;
      d.sales.entries = [];
      d.sales.sig = null;
      save();
      await refreshSalesPanel(guild, false).catch(console.error);
      return { ok: true };
    },

    // ---------- Catégories du menu (raisons) ----------
    'POST /api/ticket-reason': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      cfg.reasons ??= [];
      if (b.action === 'add') {
        if (cfg.reasons.length >= 25) throw new Error('25 catégories maximum.');
        const label = txt(b.label, 100);
        if (!label) throw new Error('Le nom est obligatoire.');
        if (cfg.reasons.some((r) => r.label.toLowerCase() === label.toLowerCase())) throw new Error('Cette catégorie existe déjà.');
        cfg.reasons.push({
          id: crypto.randomUUID().slice(0, 8), label,
          description: txt(b.description, 100) || '',
          emoji: txt(b.emoji, 64) || null,
          staffRoleId: b.staffRoleId && b.staffRoleId !== guild.id && guild.roles.cache.has(b.staffRoleId) ? b.staffRoleId : null,
          categoryId: b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null,
        });
      } else {
        const r = cfg.reasons.find((x) => x.id === b.id);
        if (!r) throw new Error('Catégorie introuvable');
        if (b.action === 'remove') {
          cfg.reasons = cfg.reasons.filter((x) => x !== r);
          if (cfg.subLinks) delete cfg.subLinks[r.id];
        } else if (b.action === 'update') {
          if ('label' in b) {
            const label = txt(b.label, 100);
            if (!label) throw new Error('Le nom est obligatoire.');
            if (cfg.reasons.some((x) => x !== r && x.label.toLowerCase() === label.toLowerCase())) throw new Error('Une autre catégorie porte déjà ce nom.');
            r.label = label;
          }
          if ('description' in b) r.description = txt(b.description, 100) || '';
          if ('emoji' in b) r.emoji = txt(b.emoji, 64) || null;
          if ('categoryId' in b) r.categoryId = b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null;
          if ('staffRoleId' in b) r.staffRoleId = b.staffRoleId && b.staffRoleId !== guild.id && guild.roles.cache.has(b.staffRoleId) ? b.staffRoleId : null;
        } else throw new Error('Action inconnue');
      }
      save();
      await refreshPanels(guild, cfg.name).catch(console.error);
      return { ok: true };
    },

    // ---------- Sous-panels ----------
    'POST /api/subpanel': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      cfg.subPanels ??= [];
      if (b.action === 'create') {
        if (cfg.subPanels.length >= 100) throw new Error('100 sous-panels maximum.');
        const name = txt(b.name, 60);
        if (!name) throw new Error('Le nom est obligatoire.');
        if (cfg.subPanels.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error('Un sous-panel porte déjà ce nom.');
        const sp = {
          id: crypto.randomUUID().slice(0, 8), name,
          title: txt(b.title, 256) || null, description: txt(b.description, 4000) || null,
          placeholder: txt(b.placeholder, 100) || null, color: colorOk(b.color) || null,
          image: urlOk(b.image) || null, thumbnail: urlOk(b.thumbnail) || null,
          footer: txt(b.footer, 2048) || null, payment: !!b.payment, choices: [],
        };
        cfg.subPanels.push(sp);
        save();
        return { ok: true, id: sp.id };
      }
      const sp = cfg.subPanels.find((s) => s.id === b.id);
      if (!sp) throw new Error('Sous-panel introuvable');
      if (b.action === 'delete') {
        cfg.subPanels = cfg.subPanels.filter((s) => s !== sp);
        if (cfg.defaultSubPanelId === sp.id) cfg.defaultSubPanelId = null;
        for (const [k, v] of Object.entries(cfg.subLinks || {})) if (v === sp.id) delete cfg.subLinks[k];
        for (const other of cfg.subPanels) for (const c of other.choices || []) if (c.nextSubId === sp.id) c.nextSubId = null;
        save();
        return { ok: true };
      }
      if (b.action === 'update') {
        if ('name' in b) {
          const name = txt(b.name, 60);
          if (!name) throw new Error('Le nom est obligatoire.');
          if (cfg.subPanels.some((s) => s !== sp && s.name.toLowerCase() === name.toLowerCase())) throw new Error('Un sous-panel porte déjà ce nom.');
          sp.name = name;
        }
        if ('title' in b) sp.title = txt(b.title, 256) || null;
        if ('description' in b) sp.description = txt(b.description, 4000) || null;
        if ('placeholder' in b) sp.placeholder = txt(b.placeholder, 100) || null;
        if ('color' in b) sp.color = colorOk(b.color) || null;
        if ('image' in b) sp.image = urlOk(b.image) || null;
        if ('thumbnail' in b) sp.thumbnail = urlOk(b.thumbnail) || null;
        if ('footer' in b) sp.footer = txt(b.footer, 2048) || null;
        if ('payment' in b) sp.payment = !!b.payment;
        save();
        return { ok: true };
      }
      throw new Error('Action inconnue');
    },
    'POST /api/subpanel-choice': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      const sp = (cfg.subPanels || []).find((s) => s.id === b.subId);
      if (!sp) throw new Error('Sous-panel introuvable');
      sp.choices ??= [];
      const nextId = () => {
        if (!('nextSubId' in b)) return undefined;
        if (!b.nextSubId || b.nextSubId === 'aucun') return null;
        if (b.nextSubId === sp.id) throw new Error('Un choix ne peut pas renvoyer vers son propre sous-panel.');
        if (!cfg.subPanels.some((s) => s.id === b.nextSubId)) throw new Error('Sous-panel suivant introuvable.');
        return b.nextSubId;
      };
      if (b.action === 'add') {
        if (sp.choices.length >= 25) throw new Error('25 choix maximum par menu.');
        const label = txt(b.label, 100);
        if (!label) throw new Error('Le nom du choix est obligatoire.');
        sp.choices.push({
          id: crypto.randomUUID().slice(0, 8), label,
          description: txt(b.description, 100) || '',
          emoji: txt(b.emoji, 64) || null,
          categoryId: b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null,
          staffRoleId: b.staffRoleId && b.staffRoleId !== guild.id && guild.roles.cache.has(b.staffRoleId) ? b.staffRoleId : null,
          nextSubId: nextId() ?? null,
        });
        save();
        return { ok: true };
      }
      const ch = sp.choices.find((c) => c.id === b.id);
      if (!ch) throw new Error('Choix introuvable');
      if (b.action === 'remove') {
        sp.choices = sp.choices.filter((c) => c !== ch);
      } else if (b.action === 'update') {
        if ('label' in b) {
          const label = txt(b.label, 100);
          if (!label) throw new Error('Le nom du choix est obligatoire.');
          ch.label = label;
        }
        if ('description' in b) ch.description = txt(b.description, 100) || '';
        if ('emoji' in b) ch.emoji = txt(b.emoji, 64) || null;
        if ('categoryId' in b) ch.categoryId = b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null;
        if ('staffRoleId' in b) ch.staffRoleId = b.staffRoleId && b.staffRoleId !== guild.id && guild.roles.cache.has(b.staffRoleId) ? b.staffRoleId : null;
        const n = nextId();
        if (n !== undefined) ch.nextSubId = n;
      } else throw new Error('Action inconnue');
      save();
      return { ok: true };
    },
    'POST /api/subpanel-link': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const val = b.subId === 'none' ? 'none' : b.subId && cfg.subPanels?.some((s) => s.id === b.subId) ? b.subId : null;
      if (b.pour === 'all') cfg.defaultSubPanelId = val === 'none' ? null : val;
      else {
        cfg.subLinks ??= {};
        if (!val) delete cfg.subLinks[b.pour];
        else cfg.subLinks[b.pour] = val;
      }
      save();
      return { ok: true };
    },
    'POST /api/panel-delete': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      const p = (cfg.panels || []).find((x) => x.messageId === b.messageId);
      if (!p) throw new Error('Panel introuvable');
      if (b.removeMessage) {
        const ch = await guild.channels.fetch(p.channelId).catch(() => null);
        const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
        if (msg) await msg.delete().catch(console.error);
      }
      cfg.panels = cfg.panels.filter((x) => x !== p);
      save();
      return { ok: true };
    },

    'POST /api/ticket-open-msg': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      cfg.openPresets ??= [];
      // un ou plusieurs éléments à la fois (scopes) : utile pour relier un modèle à tous les choix d'un sous-panel
      const targets = [...new Set((Array.isArray(b.scopes) ? b.scopes : [b.scope || {}]).flatMap((s) => openTargets(cfg, s || {})))];
      if (!targets.length) throw new Error('Élément introuvable (il a peut-être été supprimé).');
      if (b.presetId) { // relier les éléments à un modèle : ils n'ont plus de message propre
        const p = cfg.openPresets.find((x) => x.id === b.presetId);
        if (!p) throw new Error('Modèle introuvable');
        for (const t of targets) {
          if (t === p) continue;
          t.openMsgId = p.id;
          if (t === cfg) cfg.openMsg = null; else delete t.openMsg;
        }
        save();
        return { ok: true, count: targets.length };
      }
      const msg = b.reset ? {} : cleanOpenMsg(b.msg || {});
      const empty = !Object.keys(msg).length;
      for (const t of targets) {
        if (t === cfg) cfg.openMsg = empty ? null : msg;
        else if (empty) delete t.openMsg;
        else t.openMsg = JSON.parse(JSON.stringify(msg));
        if (t.openMsgId) { if (t === cfg) cfg.openMsgId = null; else delete t.openMsgId; } // message propre : on quitte le modèle
      }
      save();
      return { ok: true, empty };
    },
    // Modèles de message d'ouverture : créer / renommer / supprimer
    'POST /api/open-preset': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      cfg.openPresets ??= [];
      const nameOk = (n, self) => {
        const v = txt(n, 60);
        if (!v) throw new Error('Donne un nom au modèle');
        if (cfg.openPresets.some((x) => x !== self && x.name.toLowerCase() === v.toLowerCase())) throw new Error('Un modèle porte déjà ce nom.');
        return v;
      };
      if (b.action === 'create') {
        if (cfg.openPresets.length >= 50) throw new Error('50 modèles maximum.');
        const p = { id: crypto.randomUUID().slice(0, 8), name: nameOk(b.name) };
        const src = b.fromMsg ? cleanOpenMsg(b.fromMsg) : {};
        if (Object.keys(src).length) p.openMsg = src;
        cfg.openPresets.push(p);
        save();
        return { ok: true, id: p.id };
      }
      const p = cfg.openPresets.find((x) => x.id === b.id);
      if (!p) throw new Error('Modèle introuvable');
      if (b.action === 'rename') { p.name = nameOk(b.name, p); save(); return { ok: true }; }
      if (b.action === 'delete') {
        cfg.openPresets = cfg.openPresets.filter((x) => x !== p);
        const all = [cfg, ...(cfg.panels || []), ...(cfg.reasons || []), ...(cfg.dmChoices || []), ...(cfg.subPanels || []).flatMap((s) => s.choices || [])];
        for (const t of all) {
          if (t.openMsgId !== p.id) continue;
          if (p.openMsg) t.openMsg = JSON.parse(JSON.stringify(p.openMsg)); // les éléments gardent une copie du message
          if (t === cfg) cfg.openMsgId = null; else delete t.openMsgId;
        }
        save();
        return { ok: true };
      }
      throw new Error('Action inconnue');
    },
    // Import d'une liste d'articles : chaque article devient un choix du menu (nom) avec son prix en description
    'POST /api/bulk-choices': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      const isReasons = b.target === 'reasons';
      const sp = isReasons ? null : cfg.subPanels?.find((x) => x.id === b.target);
      if (!isReasons && !sp) throw new Error('Sous-panel introuvable');
      cfg.reasons ??= [];
      const list = isReasons ? cfg.reasons : sp.choices;
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200)
        .map((i) => ({ label: txt(i?.label, 100), description: txt(i?.description, 100) || '' })).filter((i) => i.label);
      if (!items.length) throw new Error('Aucun article reconnu dans ta liste.');
      const emoji = txt(b.emoji, 64) || null;
      const categoryId = b.categoryId && guild.channels.cache.has(b.categoryId) ? b.categoryId : null;
      const staffRoleId = b.staffRoleId && b.staffRoleId !== guild.id && guild.roles.cache.has(b.staffRoleId) ? b.staffRoleId : null;
      // Sous-panel proposé après chaque article importé (facultatif) : on refuse les boucles
      let nextSubId = null;
      if (!isReasons && b.nextSubId) {
        const n = cfg.subPanels.find((x) => x.id === b.nextSubId);
        if (!n || n === sp) throw new Error('Sous-panel suivant introuvable');
        const reaches = (from, target, seen = new Set()) => {
          if (from === target) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return !!cfg.subPanels.find((x) => x.id === from)?.choices.some((c) => c.nextSubId && reaches(c.nextSubId, target, seen));
        };
        if (reaches(n.id, sp.id)) throw new Error('Boucle impossible : ce sous-panel mène déjà à celui-ci.');
        nextSubId = n.id;
      }
      let added = 0, updated = 0, skipped = 0;
      if (b.mode === 'replace') {
        const removed = list.splice(0, list.length);
        if (isReasons) for (const r of removed) if (cfg.subLinks) delete cfg.subLinks[r.id];
      }
      for (const it of items) {
        const ex = list.find((x) => x.label.toLowerCase() === it.label.toLowerCase());
        if (ex) { if (it.description) ex.description = it.description; if (nextSubId) ex.nextSubId = nextSubId; updated++; continue; } // même nom : on met à jour le prix
        if (list.length >= 25) { skipped++; continue; } // limite Discord : 25 choix par menu
        list.push({ id: crypto.randomUUID().slice(0, 8), label: it.label, description: it.description, emoji, staffRoleId, categoryId, ...(isReasons ? {} : { nextSubId }) });
        added++;
      }
      save();
      if (isReasons && guild) await refreshPanels(guild, b.config).catch(console.error); // les panels déjà envoyés se mettent à jour
      return { ok: true, added, updated, skipped, total: list.length };
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
    'POST /api/restore': async (_r, _q, b) => restore(b.data),
    'GET /api/backups': async () => ({ dir: BK_DIR, list: listBk(), current: Object.fromEntries(Object.entries(db).map(([k, v]) => [k, JSON.stringify(v).length])) }),
    'POST /api/backup-now': async () => ({ ok: true, name: snapshot('manuel') }),
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
        const gid = url.searchParams.get('id'), file = url.searchParams.get('file');
        let out, nom = `sauvegarde-bot-${new Date().toISOString().slice(0, 10)}`;
        if (file) { // une copie automatique gardée sur le bot
          if (!bkOk(file) || !fs.existsSync(path.join(BK_DIR, file))) return send(res, 404, { error: 'Sauvegarde introuvable' });
          out = fs.readFileSync(path.join(BK_DIR, file), 'utf8'); nom = file.replace(/\.json$/, '');
        } else if (gid) { // un seul serveur
          if (!db[gid]) return send(res, 404, { error: 'Serveur inconnu' });
          out = JSON.stringify({ [gid]: db[gid] }, null, 2); nom = `sauvegarde-serveur-${gid}-${new Date().toISOString().slice(0, 10)}`;
        } else out = JSON.stringify(db, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${nom}.json"` });
        return res.end(out);
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
