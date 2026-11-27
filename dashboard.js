// dashboard.js — panel web du bot (aucune dépendance : module http natif)
// Variables Railway : PANEL_PASSWORD (obligatoire) — PORT est fourni automatiquement par Railway.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sb = require('./supabase');
const keysLib = require('./keys');

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
  'product/creer': [F('titre', 'Titre', 0, 256), F('texte', 'Description (Markdown)', 1, 4000, 1),
    F('liens', 'Boutons-liens : Libellé | https://url | emoji', 1, 2000), F('image_url', "URL de l'image", 0, 500),
    F('footer', 'Pied de page', 0, 2048)],
  'restock/creer': [F('titre', 'Titre', 0, 256), F('lignes', 'Variantes : Variante | Prix | Stock', 1, 4000, 1),
    F('liens', 'Boutons-liens : Libellé | https://url | emoji', 1, 2000), F('image_url', "URL de l'image", 0, 500),
    F('footer', 'Pied de page', 0, 2048)],
};

module.exports = function startDashboard(ctx) {
  const { client, commands, handlers, autocomplete, getG, refreshPanels, refreshSalesPanel,
    buildCatalogPayload, buildSinglePanel, buildMultiPanel, multiPanelSig, rich, syncCommandChannel,
    sendRestockAnnouncement, buildRoleClaimPanel, publishRoleClaimPanel,
    backupMembers, restoreMembers,
    CMD_CATEGORIES, ALWAYS_ON, PUBLIC_COMMANDS, OWNER_ONLY, db, save, DB_FILE } = ctx;
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
      getAttachment: (n) => {
        const v = o[n];
        if (!v) return null;
        if (typeof v === 'string') return { url: v, name: 'image.png', contentType: 'image/png' };
        return { url: v.url, name: v.name || 'image.png', contentType: v.contentType || 'image/png' };
      },
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
  // Lien http(s) ou image importée depuis le dashboard (base64).
  const imgOk = (v) => {
    const t = String(v ?? '').trim();
    if (/^https?:\/\/\S+$/i.test(t)) return t.slice(0, 500);
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(t) && t.length <= 8e6) return t;
    return undefined;
  };
  const colorOk = (v) => { const t = String(v ?? '').trim(); return /^#?[0-9a-f]{6}$/i.test(t) ? '#' + t.replace('#', '') : undefined; };
  // Les images importées (data URL) ne sont pas renvoyées dans la liste : trop lourdes.
  const light = (v) => (String(v ?? '').startsWith('data:') ? '' : (v || null));
  // Métadonnées d'une image de la bibliothèque (le contenu lourd reste côté serveur).
  const imgMeta = (i) => ({
    id: i.id, name: i.name, url: light(i.src),
    kind: String(i.src || '').startsWith('data:') ? 'file' : 'url', at: i.at || null,
  });
  const cleanOpenMsg = (m) => {
    const infoLabels = {};
    if (m.infoLabels && typeof m.infoLabels === 'object') {
      for (const k of ['config', 'category', 'sub', 'payment']) {
        const v = txt(m.infoLabels[k], 256);
        if (v) infoLabels[k] = v;
      }
    }
    const out = {
      content: txt(m.content, 1000), title: txt(m.title, 256), description: txt(m.description, 4000),
      image: imgOk(m.image), thumbnail: imgOk(m.thumbnail), color: colorOk(m.color), footer: txt(m.footer, 2048),
      claimLabel: txt(m.claimLabel, 80), closeLabel: txt(m.closeLabel, 80), claimEmoji: txt(m.claimEmoji, 64), closeEmoji: txt(m.closeEmoji, 64),
      showInfo: typeof m.showInfo === 'boolean' ? m.showInfo : undefined,
      timestamp: m.timestamp === false ? false : undefined,
      noDefaultDesc: m.noDefaultDesc === true ? true : undefined,
      infoLabels: Object.keys(infoLabels).length ? infoLabels : undefined,
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
    // Rôles d'un autre serveur (utilisé par l'onglet Rôle auto inter-serveurs).
    'GET /api/guild-roles': async (_r, q) => {
      const guild = client.guilds.cache.get(q.get('id'));
      if (!guild) throw new Error('Serveur introuvable');
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const highest = me?.roles?.highest?.position ?? -1;
      return {
        id: guild.id,
        name: guild.name,
        roles: guild.roles.cache
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id, name: r.name, color: r.hexColor || null, position: r.position,
            assignable: r.position < highest,
          })),
      };
    },
    'GET /api/guild': async (_r, q) => {
      const { guild } = await ctxFor(q.get('id'));
      const d = getG(guild.id);
      const permUserIds = new Set([
        ...(d.fullUsers || []), ...Object.values(d.cmdUsers || {}).flat(), ...Object.values(d.catUsers || {}).flat(),
      ]);
      const memberNames = {};
      for (const id of permUserIds) {
        const m = guild.members.cache.get(id);
        if (m) memberNames[id] = m.displayName;
      }
      // Demandes en attente : elles vivent sur le serveur cible, on ne compte que celles
      // qui viennent de ce serveur source.
      const crossTarget = d.crossRole?.targetGuildId && d.crossRole.targetGuildId !== guild.id
        ? getG(d.crossRole.targetGuildId)
        : null;
      const crossPending = crossTarget
        ? Object.values(crossTarget.crossRole?.pending || {}).filter((p) => p.sourceGuildId === guild.id).length
        : 0;
      return {
        id: guild.id, name: guild.name, count: guild.memberCount, disabled: d.disabledCommands || [],
        memberNames,
        welcome: d.welcome,
        panelColor: d.panelColor || '#5865F2',
        panelLogo: d.panelLogo || null,
        vouch: {
          channelId: d.vouch?.channelId || null, enabled: d.vouch?.enabled !== false, count: (d.vouches || []).length,
          average: (d.vouches || []).length ? (d.vouches.reduce((n, v) => n + (v.stars || 0), 0) / d.vouches.length) : 0,
          logo: d.vouch?.logo || null,
          title: d.vouch?.title || null, footer: d.vouch?.footer || null,
          details: d.vouch?.details || '',
        },
        vouches: (d.vouches || []).slice().reverse().map((v) => ({
          id: v.id, from: v.from, stars: v.stars, message: v.message, image: v.image || null,
          at: v.at, ticketName: v.ticketName || null, ticketId: v.ticketId || null, config: v.config || null,
          hasTranscript: !!v.transcript,
          name: client.users.cache.get(v.from)?.globalName || client.users.cache.get(v.from)?.username || null,
          avatar: client.users.cache.get(v.from)?.displayAvatarURL({ size: 64 }) || null,
        })),
        sales: {
          channelId: d.sales?.channelId || null, messageId: d.sales?.messageId || null,
          count: d.sales?.count || 0, total: d.sales?.total || 0, currency: d.sales?.currency || '€',
          logo: d.sales?.logo || null,
          entries: (d.sales?.entries || []).slice(-15).reverse().map((e) => ({
            ...e,
            name: client.users.cache.get(e.buyerId)?.username || e.buyerName || null,
          })),
        },
        openTickets: Object.keys(d.open || {}).length,
        announce: d.announce || {},
        restock: d.restock || {},
        claim: {
          channelId: d.claim?.channelId || null, messageId: d.claim?.messageId || null,
          title: d.claim?.title || '', description: d.claim?.description || '',
          footer: d.claim?.footer || '', color: d.claim?.color || null,
          image: d.claim?.image || null, thumb: d.claim?.thumb || null,
          showLogo: d.claim?.showLogo !== false, btnStyle: d.claim?.btnStyle || 'Primary',
          mode: d.claim?.mode === 'add' ? 'add' : 'toggle',
          roles: (d.claim?.roles || []).map((r) => ({ id: r.id, roleId: r.roleId, label: r.label, emoji: r.emoji || null, style: r.style || null, text: r.text || '' })),
        },
        crossRole: {
          enabled: !!d.crossRole?.enabled,
          targetGuildId: d.crossRole?.targetGuildId || null,
          roleId: d.crossRole?.roleId || null,
          pending: crossPending,
        },
        keys: {
          cmd: {
            message: d.keyCmd?.message || keysLib.DEFAULT_MESSAGE,
            default: keysLib.DEFAULT_MESSAGE,
          },
          limits: { folders: keysLib.MAX_FOLDERS, lists: keysLib.MAX_LISTS },
          folders: (d.keyFolders || []).map((f) => {
            const lists = (f.lists || []).map((l) => ({
              id: l.id, name: l.name, remaining: (l.keys || []).length,
              sent: l.sent || 0, createdAt: l.createdAt || null,
            }));
            return {
              id: f.id, name: f.name, createdAt: f.createdAt || null, lists,
              remaining: lists.reduce((n, l) => n + l.remaining, 0),
              sent: lists.reduce((n, l) => n + l.sent, 0),
            };
          }),
        },
        memberBackup: d.memberBackup ? { at: d.memberBackup.at, count: (d.memberBackup.members || []).length, guildName: d.memberBackup.guildName || null } : null,
        shopPosts: (d.shopPosts || []).slice(-8).reverse().map((p) => ({
          ...p,
          // Les images importées (data URL) ne sont pas renvoyées dans la liste : elles sont
          // chargées uniquement au clic sur « Modifier » (voir /api/shop-get).
          params: { ...p.params, image: '', thumb: '' },
        })),
        // Bibliothèque d'images : uniquement les métadonnées (le contenu est servi par /api/image-file).
        images: (d.images || []).map(imgMeta),
        invites: {
          total: Object.values(d.invites?.stats || {}).reduce((n, s) => n + (s.joins || 0), 0),
          members: Object.keys(d.invites?.stats || {}).length,
        },
        tickets: Object.values(d.tickets || {}).map((t) => ({
          name: t.name, categoryId: t.categoryId, staffRoles: t.staffRoles || [], staffMode: t.staffMode || 'any', logChannelId: t.logChannelId, counter: t.counter || 0,
          nameTemplate: t.nameTemplate || null, vouchButton: !!t.vouchButton,
          dm: !!t.dm, openMsg: t.openMsg || null, openMsgId: t.openMsgId || null,
          color: t.color || null, placeholder: t.placeholder || null, logo: t.logo || null, translate: !!t.translate,
          openPresets: (t.openPresets || []).map((p) => ({ id: p.id, name: p.name, openMsg: p.openMsg || null })),
          stats: t.stats || {},
          panels: (t.panels || []).map((p) => ({ channelId: p.channelId, messageId: p.messageId, button: !!p.button, multi: !!p.multi, showLogo: p.showLogo !== false, statsButton: !!p.statsButton, btnLabel: p.btnLabel || null, btnStyle: p.btnStyle || null, openMsg: p.openMsg || null, openMsgId: p.openMsgId || null, translate: !!p.translate, thumb: light(p.thumb), image: light(p.image), hasThumb: !!p.thumb, hasImage: !!p.image })),
          reasons: (t.reasons || []).map((r) => ({ id: r.id, label: r.label, btnLabel: r.btnLabel || null, emoji: r.emoji, description: r.description, panelText: r.panelText || '', price: r.price || '', nameTemplate: r.nameTemplate || null, categoryId: r.categoryId, staffRoleId: r.staffRoleId, staffRoles: Array.isArray(r.staffRoles) ? r.staffRoles : (r.staffRoleId ? [r.staffRoleId] : []), staffMode: r.staffMode || null, openMsg: r.openMsg || null, openMsgId: r.openMsgId || null })),
          dmChoices: (t.dmChoices || []).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, openMsg: r.openMsg || null, openMsgId: r.openMsgId || null })),
          subPanels: t.subPanels || [], subLinks: t.subLinks || {}, defaultSub: t.defaultSubPanelId || null,
        })),
        channels: guild.channels.cache.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        roles: guild.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        perms: {
          cmdPerms: d.cmdPerms || {}, cmdUsers: d.cmdUsers || {},
          catPerms: d.catPerms || {}, catUsers: d.catUsers || {},
          fullRoles: d.fullRoles || [], fullUsers: d.fullUsers || [], modRoles: d.modRoles || [],
        },
      };
    },
    // ---------- Dossiers et listes de clés (/key) ----------
    // Contenu complet d'une liste, chargé seulement au clic sur « Modifier ».
    'GET /api/key-get': async (_r, q) => {
      const { guild } = await ctxFor(q.get('guildId'));
      const d = getG(guild.id);
      const { folder, list } = keysLib.findListById(d.keyFolders, q.get('folderId'), q.get('listId'));
      if (!folder || !list) throw new Error('Liste introuvable.');
      return {
        folderId: folder.id, folderName: folder.name,
        id: list.id, name: list.name, keys: (list.keys || []).join('\n'),
        remaining: (list.keys || []).length, sent: list.sent || 0,
      };
    },
    'POST /api/key': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      d.keyFolders ??= [];
      d.keyCmd ??= {};
      const action = b.action || 'save';
      const folder = b.folderId ? d.keyFolders.find((f) => f.id === b.folderId) : null;
      if (folder) folder.lists ??= [];
      const list = folder && b.id ? folder.lists.find((x) => x.id === b.id) : null;

      if (action === 'cmd') {
        if ('message' in b) {
          const msg = String(b.message ?? '').replace(/\r/g, '').trim();
          d.keyCmd.message = msg ? msg.slice(0, keysLib.MAX_MESSAGE) : keysLib.DEFAULT_MESSAGE;
        }
        save();
        return { ok: true };
      }

      /* ---------- Dossiers ---------- */
      if (action === 'folder-create' || action === 'folder-update') {
        const name = keysLib.normalizeName(b.name);
        if (!name) throw new Error('Nom de dossier invalide (lettres, chiffres, - et _).');
        const editing = action === 'folder-update' ? d.keyFolders.find((f) => f.id === b.id) : null;
        if (action === 'folder-update' && !editing) throw new Error('Dossier introuvable.');
        if (d.keyFolders.some((f) => f !== editing && keysLib.nameKey(f.name) === keysLib.nameKey(name))) {
          throw new Error('Un dossier porte déjà ce nom.');
        }
        if (!editing && d.keyFolders.length >= keysLib.MAX_FOLDERS) {
          throw new Error(`${keysLib.MAX_FOLDERS} dossiers maximum.`);
        }
        if (editing) {
          editing.name = name;
          save();
          return { ok: true, id: editing.id };
        }
        const created = { id: keysLib.makeId(), name, createdAt: Date.now(), lists: [] };
        d.keyFolders.push(created);
        save();
        return { ok: true, id: created.id };
      }
      if (action === 'folder-delete') {
        const f = d.keyFolders.find((x) => x.id === b.id);
        if (!f) throw new Error('Dossier introuvable.');
        d.keyFolders = d.keyFolders.filter((x) => x !== f);
        save();
        return { ok: true };
      }

      /* ---------- Listes ---------- */
      if (!folder) throw new Error('Dossier introuvable.');
      if (!list && ['update', 'delete', 'clear'].includes(action)) throw new Error('Liste introuvable.');
      if (action === 'clear') {
        list.keys = [];
        save();
        return { ok: true };
      }
      if (action === 'delete') {
        folder.lists = folder.lists.filter((x) => x !== list);
        save();
        return { ok: true };
      }
      if (action === 'create' || action === 'update') {
        const name = keysLib.normalizeName(b.name);
        if (!name) throw new Error('Nom de liste invalide (lettres, chiffres, - et _).');
        if (folder.lists.some((x) => x !== list && keysLib.nameKey(x.name) === keysLib.nameKey(name))) {
          throw new Error('Une liste porte déjà ce nom dans ce dossier.');
        }
        if (!list && folder.lists.length >= keysLib.MAX_LISTS) {
          throw new Error(`${keysLib.MAX_LISTS} listes maximum par dossier.`);
        }
        const keys = keysLib.parseLines(b.keys);
        // Une clé ne doit jamais pouvoir être distribuée deux fois : on refuse les doublons
        // présents dans une autre liste (le même dossier ou un autre).
        const used = new Set();
        for (const f of d.keyFolders) {
          for (const l of (f.lists || [])) {
            if (l === list) continue;
            for (const k of (l.keys || [])) used.add(k);
          }
        }
        const dup = keys.filter((k) => used.has(k));
        if (dup.length) {
          throw new Error(`Clé(s) déjà présente(s) dans une autre liste : ${dup.slice(0, 3).join(', ')}${dup.length > 3 ? '…' : ''}.`);
        }
        if (list) {
          list.name = name;
          list.keys = keys;
          save();
          return { ok: true, id: list.id };
        }
        const created = {
          id: keysLib.makeId(), name, keys, sent: 0, createdAt: Date.now(),
        };
        folder.lists.push(created);
        save();
        return { ok: true, id: created.id };
      }
      throw new Error('Action inconnue.');
    },
    // Paramètres complets d'un message produit / restock (images importées incluses).
    'GET /api/shop-get': async (_r, q) => {
      const { guild } = await ctxFor(q.get('guildId'));
      const d = getG(guild.id);
      const post = (d.shopPosts || []).find((x) => x.id === q.get('id'));
      if (!post) throw new Error('Message introuvable (il a peut-être été supprimé).');
      return post;
    },
    // ---------- Bibliothèque d'images ----------
    // Contenu complet d'une image (data URL ou lien), chargé seulement quand on l'utilise.
    'GET /api/image-get': async (_r, q) => {
      const { guild } = await ctxFor(q.get('guildId'));
      const d = getG(guild.id);
      const img = (d.images || []).find((x) => x.id === q.get('id'));
      if (!img) throw new Error('Image introuvable.');
      return { id: img.id, name: img.name, src: img.src };
    },
    'POST /api/images': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      d.images ??= [];
      const action = b.action || 'add';
      const find = () => d.images.find((x) => x.id === b.id);
      if (action === 'add') {
        const src = imgOk(b.src);
        if (!src) throw new Error('Image invalide : lien http(s) ou fichier importé (6 Mo max).');
        if (d.images.length >= 40) throw new Error('40 images maximum : supprime-en une avant d’en ajouter une autre.');
        const img = {
          id: crypto.randomUUID().slice(0, 8),
          name: txt(b.name, 60) || `Image ${d.images.length + 1}`,
          src, at: Date.now(),
        };
        d.images.push(img);
        save();
        return { ok: true, image: imgMeta(img) };
      }
      const img = find();
      if (!img) throw new Error('Image introuvable.');
      if (action === 'rename') {
        img.name = txt(b.name, 60) || img.name;
        save();
        return { ok: true, image: imgMeta(img) };
      }
      if (action === 'replace') {
        const src = imgOk(b.src);
        if (!src) throw new Error('Image invalide.');
        img.src = src;
        save();
        return { ok: true, image: imgMeta(img) };
      }
      if (action === 'delete') {
        d.images = d.images.filter((x) => x !== img);
        save();
        // La suppression fait légitimement baisser la taille des données : on autorise
        // Supabase à enregistrer cette version plus petite (garde-fou anti-écrasement).
        sb.forceNext(guild.id);
        return { ok: true };
      }
      throw new Error('Action inconnue');
    },
    // ---------- Accès aux commandes (onglet Admin) ----------
    // target: role | user ; scope: command | category | all ; action: add | remove | clear
    'POST /api/perms': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      const target = b.target === 'user' ? 'user' : 'role';
      const id = String(b.id || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('Identifiant invalide.');
      if (target === 'role') {
        if (id === guild.id || !guild.roles.cache.has(id)) throw new Error('Rôle invalide.');
      } else {
        const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
        if (!member) throw new Error('Membre introuvable.');
      }
      const scope = String(b.scope || 'command');
      const key = String(b.key || '');
      const action = String(b.action || 'add');
      if (scope === 'all') {
        const list = target === 'user' ? (d.fullUsers ??= []) : (d.fullRoles ??= []);
        if (action === 'remove' || action === 'clear') d[target === 'user' ? 'fullUsers' : 'fullRoles'] = list.filter((x) => x !== id);
        else if (!list.includes(id)) list.push(id);
      } else if (scope === 'mod') {
        if (target !== 'role') throw new Error('Les rôles de modération sont des rôles.');
        const list = (d.modRoles ??= []);
        if (action === 'remove' || action === 'clear') d.modRoles = list.filter((x) => x !== id);
        else if (!list.includes(id)) list.push(id);
      } else if (scope === 'command' || scope === 'category') {
        const store = target === 'user'
          ? (scope === 'command' ? (d.cmdUsers ??= {}) : (d.catUsers ??= {}))
          : (scope === 'command' ? (d.cmdPerms ??= {}) : (d.catPerms ??= {}));
        if (!key) throw new Error('Commande ou catégorie manquante.');
        if (scope === 'command' && !commands.some((c) => c.name === key)) throw new Error('Commande inconnue.');
        if (scope === 'category' && !CMD_CATEGORIES[key]) throw new Error('Catégorie inconnue.');
        if (action === 'clear') delete store[key];
        else {
          const list = (store[key] ??= []);
          if (action === 'remove') {
            store[key] = list.filter((x) => x !== id);
            if (!store[key].length) delete store[key];
          } else if (!list.includes(id)) list.push(id);
        }
      } else throw new Error('Portée invalide.');
      save();
      // Un retrait d'accès réduit volontairement la taille des données : on lève le garde-fou Supabase.
      sb.forceNext(guild.id);
      // Met à jour les permissions du salon privé des commandes (rôles + membres autorisés).
      if (typeof syncCommandChannel === 'function') await syncCommandChannel(guild).catch(console.error);
      return { ok: true };
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
        d.tickets[name] = {
          name, categoryId, staffRoles,
          staffMode: b.staffMode === 'all' ? 'all' : 'any',
          logChannelId: b.logChannelId && guild.channels.cache.has(b.logChannelId) ? b.logChannelId : null,
          reasons: [], counter: 0, panels: [], placeholder: null, openMsg: null,
          nameTemplate: txt(b.nameTemplate, 100) || null,
          vouchButton: !!b.vouchButton,
          dm: false, dmMigrated: true, dmChoices: [], dmTexts: null, dmImage: null,
          subPanels: [], subLinks: {}, defaultSubPanelId: null, openPresets: [],
          color: colorOk(b.color) || null,
          logo: imgOk(b.logo) || null,
          // live translation is on by default (can be disabled per configuration)
          translate: ('translate' in b) ? (b.translate === true || b.translate === 'true') : true,
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
          cfg.staffRoles = ids;
        }
        if ('staffMode' in b) cfg.staffMode = b.staffMode === 'all' ? 'all' : 'any';
        if ('logChannelId' in b) cfg.logChannelId = b.logChannelId && guild.channels.cache.has(b.logChannelId) ? b.logChannelId : null;
        if ('placeholder' in b) cfg.placeholder = txt(b.placeholder, 150) || null;
        if ('nameTemplate' in b) cfg.nameTemplate = txt(b.nameTemplate, 100) || null;
        if ('vouchButton' in b) cfg.vouchButton = !!b.vouchButton;
        if ('color' in b) cfg.color = colorOk(b.color) || null;
        if ('logo' in b) cfg.logo = imgOk(b.logo) || null;
        if ('translate' in b) cfg.translate = b.translate === true || b.translate === 'true';
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
      if ('panelLogo' in b) {
        d.panelLogo = imgOk(b.panelLogo) || null;
        recolor = true; // le logo est appliqué aux panels existants
      }
      if ('vouchLogo' in b) d.vouch.logo = imgOk(b.vouchLogo) || null;
      if ('vouchTitle' in b) d.vouch.title = txt(b.vouchTitle, 256) || null;
      if ('vouchFooter' in b) d.vouch.footer = txt(b.vouchFooter, 2048) || null;
      if ('vouchDetails' in b) d.vouch.details = String(b.vouchDetails ?? '').replace(/\r/g, '').trim().slice(0, 2000);
      if ('vouchChannelId' in b) d.vouch.channelId = b.vouchChannelId && guild.channels.cache.has(b.vouchChannelId) ? b.vouchChannelId : null;
      if ('vouchEnabled' in b) d.vouch.enabled = b.vouchEnabled === true || b.vouchEnabled === 'true' || b.vouchEnabled === 1;
      if ('salesCurrency' in b) d.sales.currency = txt(b.salesCurrency, 8) || '€';
      if ('salesLogo' in b) { d.sales.logo = imgOk(b.salesLogo) || null; d.sales.sig = null; }
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
      } else if ('salesCurrency' in b || 'salesLogo' in b) {
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
      cfg.subLinks ??= {};
      // Panel suivant d'une catégorie : sous-panel choisi dans l'onglet Catégories.
      const setLink = (reasonId) => {
        if (!('subPanelId' in b)) return;
        const v = b.subPanelId;
        if (v === 'none') { cfg.subLinks[reasonId] = 'none'; return; }
        if (!v) { delete cfg.subLinks[reasonId]; return; }
        if (!cfg.subPanels?.some((s) => s.id === v)) throw new Error('Sous-panel introuvable');
        cfg.subLinks[reasonId] = v;
      };
      if (b.action === 'add') {
        if (cfg.reasons.length >= 125) throw new Error('125 catégories maximum.');
        const label = txt(b.label, 100);
        if (!label) throw new Error('Le nom est obligatoire.');
        if (cfg.reasons.some((r) => r.label.toLowerCase() === label.toLowerCase())) throw new Error('Cette catégorie existe déjà.');
        const staffRoles = (Array.isArray(b.staffRoles) ? b.staffRoles : (b.staffRoleId ? [b.staffRoleId] : []))
          .filter((id) => id !== guild.id && guild.roles.cache.has(id));
        const id = crypto.randomUUID().slice(0, 8);
        cfg.reasons.push({
          id, label,
          description: txt(b.description, 100) || '',
          panelText: txt(b.panelText, 1000) || '',
          btnLabel: txt(b.btnLabel, 80) || null,
          price: txt(b.price, 100) || '',
          nameTemplate: txt(b.nameTemplate, 100) || null,
          emoji: txt(b.emoji, 64) || null,
          staffRoleId: staffRoles[0] || null,
          staffRoles,
          staffMode: ['any', 'all'].includes(b.staffMode) ? b.staffMode : null,
          categoryId: b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null,
        });
        setLink(id);
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
          if ('panelText' in b) r.panelText = txt(b.panelText, 1000) || '';
          if ('btnLabel' in b) r.btnLabel = txt(b.btnLabel, 80) || null;
          if ('price' in b) r.price = txt(b.price, 100) || '';
          if ('nameTemplate' in b) r.nameTemplate = txt(b.nameTemplate, 100) || null;
          if ('emoji' in b) r.emoji = txt(b.emoji, 64) || null;
          if ('categoryId' in b) r.categoryId = b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null;
          if ('staffRoles' in b || 'staffRoleId' in b) {
            const ids = (Array.isArray(b.staffRoles) ? b.staffRoles : (b.staffRoleId ? [b.staffRoleId] : []))
              .filter((id) => id !== guild.id && guild.roles.cache.has(id));
            r.staffRoles = ids;
            r.staffRoleId = ids[0] || null;
          }
          if ('staffMode' in b) r.staffMode = ['any', 'all'].includes(b.staffMode) ? b.staffMode : null;
          setLink(r.id);
        } else throw new Error('Action inconnue');
      }
      save();
      await refreshPanels(guild, cfg.name).catch(console.error);
      return { ok: true };
    },

    // ---------- Panel « Stats » (bouton des panels de ticket) ----------
    'POST /api/ticket-stats': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      cfg.stats ??= {};
      cfg.stats.labels ??= {};
      const s = cfg.stats;
      const f = b.fields || {};
      const str = (v, max) => txt(v, max) || '';
      if ('btnLabel' in f) s.btnLabel = str(f.btnLabel, 80);
      if ('btnEmoji' in f) s.btnEmoji = String(f.btnEmoji ?? '').trim().slice(0, 64);
      if ('btnStyle' in f) s.btnStyle = ['Primary', 'Secondary', 'Success', 'Danger'].includes(f.btnStyle) ? f.btnStyle : 'Secondary';
      if ('title' in f) s.title = str(f.title, 256);
      if ('description' in f) s.description = str(f.description, 4000);
      if ('color' in f) s.color = colorOk(f.color) || null;
      if ('image' in f) s.image = imgOk(f.image) || null;
      if ('thumb' in f) s.thumb = imgOk(f.thumb) || null;
      if ('footer' in f) s.footer = str(f.footer, 2048);
      if ('sectionText' in f) s.sectionText = str(f.sectionText, 2000);
      if ('ratingSub' in f) s.ratingSub = str(f.ratingSub, 500);
      if ('extra' in f) s.extra = str(f.extra, 4000);
      for (const k of ['showOpened', 'showOpen', 'showVouches', 'showRating', 'showStars', 'timestamp']) {
        if (k in f) s[k] = !!f[k];
      }
      if (f.labels && typeof f.labels === 'object') {
        for (const k of ['opened', 'open', 'vouches', 'rating']) {
          if (k in f.labels) s.labels[k] = str(f.labels[k], 256);
        }
      }
      save();
      if (guild) await refreshPanels(guild, cfg.name).catch(console.error);
      return { ok: true };
    },

    // ---------- Ordre des choix (catégories du menu / choix d'un sous-panel) ----------
    'POST /api/reorder': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      let list;
      if (b.target === 'reasons') list = (cfg.reasons ??= []);
      else if (b.target === 'choices') {
        const sp = (cfg.subPanels || []).find((s) => s.id === b.subId);
        if (!sp) throw new Error('Sous-panel introuvable');
        list = (sp.choices ??= []);
      } else throw new Error('Cible inconnue');
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) throw new Error('Élément introuvable');
      const j = b.dir === 'up' ? i - 1 : b.dir === 'down' ? i + 1 : Number(b.to);
      if (!Number.isInteger(j) || j === i || j < 0 || j >= list.length) return { ok: true, moved: false };
      const [item] = list.splice(i, 1);
      list.splice(j, 0, item);
      save();
      // L'ordre des catégories est visible dans les panels déjà envoyés : on les met à jour.
      if (b.target === 'reasons') await refreshPanels(guild, cfg.name).catch(console.error);
      return { ok: true, moved: true, index: j };
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
          image: imgOk(b.image) || null, thumbnail: imgOk(b.thumbnail) || null,
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
        if ('image' in b) sp.image = imgOk(b.image) || null;
        if ('thumbnail' in b) sp.thumbnail = imgOk(b.thumbnail) || null;
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
        if (sp.choices.length >= 125) throw new Error('125 choix maximum par menu.');
        const label = txt(b.label, 100);
        if (!label) throw new Error('Le nom du choix est obligatoire.');
        const staffRoles = (Array.isArray(b.staffRoles) ? b.staffRoles : (b.staffRoleId ? [b.staffRoleId] : []))
          .filter((id) => id !== guild.id && guild.roles.cache.has(id));
        sp.choices.push({
          id: crypto.randomUUID().slice(0, 8), label,
          description: txt(b.description, 100) || '',
          emoji: txt(b.emoji, 64) || null,
          categoryId: b.categoryId && guild.channels.cache.get(b.categoryId)?.type === 4 ? b.categoryId : null,
          staffRoleId: staffRoles[0] || null,
          staffRoles,
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
        if ('staffRoles' in b || 'staffRoleId' in b) {
          const ids = (Array.isArray(b.staffRoles) ? b.staffRoles : (b.staffRoleId ? [b.staffRoleId] : []))
            .filter((id) => id !== guild.id && guild.roles.cache.has(id));
          ch.staffRoles = ids;
          ch.staffRoleId = ids[0] || null;
        }
        const n = nextId();
        if (n !== undefined) ch.nextSubId = n;
      } else throw new Error('Action inconnue');
      save();
      return { ok: true };
    },
    // Stock d'un choix : « plus en stock » / « remettre en stock » (+ annonce automatique)
    'POST /api/subpanel-stock': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      const sp = (cfg.subPanels || []).find((s) => s.id === b.subId);
      if (!sp) throw new Error('Sous-panel introuvable');
      const ch = (sp.choices || []).find((c) => c.id === b.id);
      if (!ch) throw new Error('Choix introuvable');
      const was = !!ch.outOfStock;
      ch.outOfStock = !!b.outOfStock;
      save();
      if (was && !ch.outOfStock) {
        try {
          await sendRestockAnnouncement(guild, { cfg, sub: sp, choice: ch });
          return { ok: true, sent: true };
        } catch (e) {
          return { ok: true, sent: false, warning: e.message };
        }
      }
      return { ok: true, sent: false };
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
      sb.forceNext(b.guildId);
      return { ok: true };
    },

    // Paramètres complets d'un panel déjà envoyé (images importées incluses).
    'GET /api/panel-get': async (_r, q) => {
      const cfg = guildCfg(q.get('guildId'), q.get('config'));
      const guild = client.guilds.cache.get(q.get('guildId'));
      const p = (cfg.panels || []).find((x) => x.messageId === q.get('messageId'));
      if (!p) throw new Error('Panel introuvable (il a peut-être été supprimé).');
      const ch = guild && (guild.channels.cache.get(p.channelId) || await guild.channels.fetch(p.channelId).catch(() => null));
      const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
      // Les anciens panels stockaient attachment://... : on retrouve l'URL réelle de la pièce jointe.
      const resolve = (v) => {
        const m = /^attachment:\/\/(.+)$/.exec(String(v || ''));
        if (!m) return v || '';
        const att = msg && [...msg.attachments.values()].find((a) => a.name === m[1]);
        return att ? att.url : '';
      };
      return { ...p, image: resolve(p.image), thumb: resolve(p.thumb) };
    },
    // ---------- Mise à jour directe d'un panel déjà envoyé ----------
    'POST /api/panel-update': async (_r, _q, b) => {
      const cfg = guildCfg(b.guildId, b.config);
      const guild = client.guilds.cache.get(b.guildId);
      if (!guild) throw new Error('Serveur introuvable');
      const p = (cfg.panels || []).find((x) => x.messageId === b.messageId);
      if (!p) throw new Error('Panel introuvable');
      const f = b.fields || {};
      if ('title' in f) p.title = txt(f.title, 256) || null;
      if ('footer' in f) p.footer = txt(f.footer, 2048) || null;
      if ('btnStyle' in f) p.btnStyle = f.btnStyle || 'Primary';
      if ('btnLabel' in f) p.btnLabel = txt(f.btnLabel, 80) || null;
      if ('color' in f) p.color = colorOk(f.color) || null;
      if ('translate' in f) p.translate = !!f.translate;
      if ('showLogo' in f) p.showLogo = !!f.showLogo;
      if ('statsButton' in f) p.statsButton = !!f.statsButton;
      if ('noText' in f) p.noText = !!f.noText;
      if ('image' in f) p.image = imgOk(f.image) || null;
      if ('thumb' in f) p.thumb = imgOk(f.thumb) || null;
      if ('desc' in f) {
        const raw = txt(f.desc, 4000);
        p.desc = raw ? (await rich(guild, raw)).text : null;
        p.customDesc = !!raw || !!p.noText;
      }
      if (p.noText && !p.image) throw new Error('Pour un panel sans texte, ajoute une image.');
      const ch = guild.channels.cache.get(p.channelId) || await guild.channels.fetch(p.channelId).catch(() => null);
      const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
      if (!msg) throw new Error('Message Discord introuvable (il a peut-être été supprimé).');
      const payload = p.multi ? await buildMultiPanel(guild, cfg, p) : await buildSinglePanel(guild, cfg, p);
      await msg.edit(payload);
      p.sig = p.multi ? multiPanelSig(guild, cfg, p) : null;
      save();
      sb.forceNext(guild.id);
      return { ok: true };
    },

    // ---------- Vouch : suppression depuis le dashboard ----------
    'POST /api/vouch-delete': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      const v = (d.vouches || []).find((x) => x.id === b.id);
      if (!v) throw new Error('Vouch introuvable');
      if (v.channelId && v.messageId) {
        const ch = await guild.channels.fetch(v.channelId).catch(() => null);
        const msg = ch && await ch.messages.fetch(v.messageId).catch(() => null);
        if (msg) await msg.delete().catch(console.error);
      }
      d.vouches = d.vouches.filter((x) => x !== v);
      save();
      sb.forceNext(guild.id);
      return { ok: true };
    },

    // ---------- Sauvegarde des membres (changement de serveur) ----------
    'POST /api/members-backup': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      if (b.action === 'save') {
        const r = await backupMembers(guild);
        sb.forceNext(guild.id);
        return r;
      }
      if (b.action === 'restore') {
        const src = b.fromGuildId && db[b.fromGuildId] ? db[b.fromGuildId] : null;
        const backup = src?.memberBackup || null;
        return await restoreMembers(guild, { dm: b.dm !== false, backup });
      }
      if (b.action === 'list') {
        return {
          backups: Object.entries(db)
            .filter(([, v]) => v?.memberBackup?.members?.length)
            .map(([id, v]) => ({
              guildId: id, guildName: v.memberBackup.guildName || id,
              count: v.memberBackup.members.length, at: v.memberBackup.at,
            }))
            .sort((a, b2) => (b2.at || 0) - (a.at || 0)),
        };
      }
      const d = getG(guild.id);
      return { backup: d.memberBackup ? { at: d.memberBackup.at, count: (d.memberBackup.members || []).length, guildName: d.memberBackup.guildName || null } : null };
    },

    // ---------- Boutique : envoyer / modifier / renvoyer / supprimer un produit ou un restock ----------
    'POST /api/shop': async (_r, _q, b) => {
      const { guild } = await ctxFor(b.guildId);
      const d = getG(guild.id);
      const kind = b.kind === 'restock' ? 'restock' : 'product';
      const action = b.action || 'new';
      const post = b.id ? (d.shopPosts || []).find((x) => x.id === b.id) : null;
      if (b.id && !post) throw new Error('Message introuvable (il a peut-être été supprimé).');

      if (action === 'delete') {
        const ch = guild.channels.cache.get(post.channelId) || await guild.channels.fetch(post.channelId).catch(() => null);
        const msg = ch && await ch.messages.fetch(post.messageId).catch(() => null);
        if (msg) await msg.delete().catch(console.error);
        d.shopPosts = (d.shopPosts || []).filter((x) => x !== post);
        save();
        sb.forceNext(guild.id);
        return { ok: true };
      }

      const raw = b.params || (post ? post.params : {});
      const params = {
        title: txt(raw.title, 256) || '',
        footer: txt(raw.footer, 2048) || '',
        links: txt(raw.links, 4000) || '',
        color: colorOk(raw.color) || '',
        logo: raw.logo !== false,
        image: imgOk(raw.image) || '',
        thumb: imgOk(raw.thumb) || '',
      };
      if (kind === 'product') {
        params.text = txt(raw.text, 4000) || '';
        if (!params.text) throw new Error('Ajoute une description.');
      } else {
        params.lines = txt(raw.lines, 4000) || '';
        params.rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 8).map((r) => ({
          variant: String(r.variant || '').slice(0, 200),
          price: String(r.price || '').slice(0, 40),
          stock: String(r.stock || '').slice(0, 40),
        }));
        if (!params.rows.length && !params.lines) throw new Error('Ajoute au moins une variante.');
      }

      const channelId = action === 'edit' ? post.channelId : (b.channelId || (post ? post.channelId : null));
      const ch = channelId ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)) : null;
      if (!ch) throw new Error('Choisis un salon valide.');
      const payload = await buildCatalogPayload(kind, params, d, guild);

      if (action === 'edit') {
        const msg = await ch.messages.fetch(post.messageId).catch(() => null);
        if (!msg) throw new Error('Message Discord introuvable (il a peut-être été supprimé).');
        await msg.edit({ content: '', embeds: payload.embeds, components: payload.components, files: payload.files });
        post.params = params;
        save();
        sb.forceNext(guild.id);
        return { ok: true, messageId: post.messageId };
      }

      const sent = await ch.send({ embeds: payload.embeds, components: payload.components, files: payload.files });
      d.shopPosts.push({
        id: crypto.randomUUID().slice(0, 8), kind, channelId: ch.id, messageId: sent.id, at: Date.now(), params,
      });
      d.shopPosts = d.shopPosts.slice(-8);
      save();
      return { ok: true, messageId: sent.id };
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
    // ---------- Textes des annonces giveaway / sanctions ----------
    'POST /api/announce': async (_r, _q, b) => {
      const d = getG(b.guildId);
      d.announce ??= {};
      if (b.target === 'giveaway') {
        d.announce.giveaway = {
          host: txt(b.host, 100) || '',   // @pseudo, <@id> ou id (vide = auteur de la commande)
          line: txt(b.line, 500) || '',   // ligne « Organized by » ({host}, {prize}…)
        };
      } else if (b.target === 'sanction') {
        d.announce.sanction = {
          by: txt(b.by, 100) || '',       // @pseudo, <@id> ou id (vide = auteur de la commande)
          ban: txt(b.ban, 500) || '',     // texte de l'annonce de ban
          mute: txt(b.mute, 500) || '',   // texte de l'annonce de mute
        };
      } else throw new Error('Cible inconnue');
      save();
      return { ok: true };
    },
    // ---------- Annonce automatique de remise en stock ----------
    'POST /api/restock-config': async (_r, _q, b) => {
      const d = getG(b.guildId);
      const guild = client.guilds.cache.get(b.guildId);
      d.restock ??= {};
      if ('channelId' in b) {
        d.restock.channelId = b.channelId && guild?.channels.cache.get(b.channelId) ? b.channelId : null;
      }
      if (b.auto && typeof b.auto === 'object') {
        const a = b.auto;
        d.restock.auto = {
          content: txt(a.content, 1000) || '',
          title: txt(a.title, 256) || '',
          description: txt(a.description, 4000) || '',
          image: imgOk(a.image) || null,
          thumbnail: imgOk(a.thumbnail) || null,
          footer: txt(a.footer, 2048) || '',
          color: colorOk(a.color) || null,
        };
      }
      save();
      return { ok: true };
    },
    'POST /api/restock-test': async (_r, _q, b) => {
      const guild = client.guilds.cache.get(b.guildId);
      if (!guild) throw new Error('Serveur introuvable.');
      const d = getG(b.guildId);
      const config = {
        channelId: b.channelId || d.restock?.channelId || null,
        auto: b.auto && typeof b.auto === 'object' ? b.auto : (d.restock?.auto || {}),
      };
      await sendRestockAnnouncement(guild, {
        choice: { label: 'Test article', description: '4,99 €' },
        sub: { name: 'Test' },
        config,
      });
      return { ok: true };
    },
    // ---------- Panel « claim rôle » ----------
    'POST /api/claim': async (_r, _q, b) => {
      const d = getG(b.guildId);
      const guild = client.guilds.cache.get(b.guildId);
      if (!guild) throw new Error('Serveur introuvable.');
      d.claim ??= {};
      d.claim.roles ??= [];
      const c = d.claim;
      const channelOk = (id) => {
        const ch = id && guild.channels.cache.get(id);
        return ch && [0, 5].includes(ch.type) ? id : null;
      };
      const saveFields = (f) => {
        if ('channelId' in f) c.channelId = channelOk(f.channelId);
        if ('title' in f) c.title = txt(f.title, 256) || '';
        if ('description' in f) c.description = txt(f.description, 4000) || '';
        if ('footer' in f) c.footer = txt(f.footer, 2048) || '';
        if ('color' in f) c.color = colorOk(f.color) || null;
        if ('image' in f) c.image = imgOk(f.image) || null;
        if ('thumb' in f) c.thumb = imgOk(f.thumb) || null;
        if ('showLogo' in f) c.showLogo = !!f.showLogo;
        if ('btnStyle' in f) c.btnStyle = ['Primary', 'Secondary', 'Success', 'Danger'].includes(f.btnStyle) ? f.btnStyle : 'Primary';
        if ('mode' in f) c.mode = f.mode === 'add' ? 'add' : 'toggle';
      };
      const refresh = async () => {
        if (!c.messageId) return null;
        try {
          await publishRoleClaimPanel(guild, { create: false });
          return null;
        } catch (e) {
          return e.message;
        }
      };

      if (b.action === 'panel') {
        saveFields(b.fields || {});
        save();
        const warning = await refresh();
        return { ok: true, warning };
      }
      if (b.action === 'publish') {
        saveFields(b.fields || {});
        if (!c.channelId) throw new Error('Choisis un salon pour le panel de rôles.');
        if (!c.roles.length) throw new Error('Ajoute au moins un rôle avant d’envoyer le panel.');
        save();
        const r = await publishRoleClaimPanel(guild, { create: true });
        save();
        return r;
      }
      if (b.action === 'delete') {
        const where = c.messageChannelId || c.channelId;
        if (where && c.messageId) {
          try {
            const ch = guild.channels.cache.get(where) || await guild.channels.fetch(where);
            const msg = ch?.messages && await ch.messages.fetch(c.messageId).catch(() => null);
            if (msg) await msg.delete().catch(console.error);
          } catch { /* message déjà introuvable */ }
        }
        c.messageId = null;
        c.messageChannelId = null;
        save();
        return { ok: true };
      }

      if (b.action === 'role-add' || b.action === 'role-update') {
        const role = b.roleId && guild.roles.cache.get(b.roleId);
        if (!role || role.id === guild.id) throw new Error('Rôle introuvable.');
        if (role.managed) throw new Error('Ce rôle est géré par une intégration.');
        const label = txt(b.label, 80) || role.name;
        const data = {
          roleId: role.id,
          label,
          emoji: txt(b.emoji, 64) || null,
          style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(b.style) ? b.style : 'Primary',
          text: txt(b.text, 1000) || '',
        };
        if (b.action === 'role-add') {
          if (c.roles.length >= 25) throw new Error('25 rôles maximum par panel.');
          if (c.roles.some((r) => r.roleId === role.id)) throw new Error('Ce rôle est déjà dans le panel.');
          c.roles.push({ id: crypto.randomUUID().slice(0, 8), ...data });
        } else {
          const entry = c.roles.find((r) => r.id === b.id);
          if (!entry) throw new Error('Entrée de rôle introuvable.');
          if (c.roles.some((r) => r !== entry && r.roleId === role.id)) throw new Error('Ce rôle est déjà dans le panel.');
          Object.assign(entry, data);
        }
      } else if (b.action === 'role-remove') {
        c.roles = c.roles.filter((r) => r.id !== b.id);
      } else if (b.action === 'role-move') {
        const n = c.roles.findIndex((r) => r.id === b.id);
        if (n < 0) throw new Error('Entrée de rôle introuvable.');
        const to = n + (b.dir === 'up' ? -1 : 1);
        if (to < 0 || to >= c.roles.length) return { ok: true };
        [c.roles[n], c.roles[to]] = [c.roles[to], c.roles[n]];
      } else throw new Error('Action inconnue');

      save();
      const warning = await refresh();
      return { ok: true, warning };
    },
    // ---------- Rôle auto inter-serveurs ----------
    // Le serveur source est celui du dashboard ; la cible et le rôle sont choisis dans l'onglet.
    'POST /api/cross-role': async (_r, _q, b) => {
      const source = client.guilds.cache.get(b.guildId);
      if (!source) throw new Error('Serveur introuvable.');
      const d = getG(source.id);
      d.crossRole ??= {};
      d.crossRole.pending ??= {};
      const c = d.crossRole;
      const pendingCount = () => {
        const target = c.targetGuildId && client.guilds.cache.get(c.targetGuildId);
        if (!target || target.id === source.id) return 0;
        return Object.values(getG(target.id).crossRole?.pending || {})
          .filter((p) => p?.sourceGuildId === source.id).length;
      };

      if (b.action === 'clear-pending') {
        const target = c.targetGuildId && client.guilds.cache.get(c.targetGuildId);
        if (target && target.id !== source.id) {
          const td = getG(target.id);
          td.crossRole ??= {};
          td.crossRole.pending ??= {};
          for (const [uid, p] of Object.entries(td.crossRole.pending)) {
            if (p?.sourceGuildId === source.id) delete td.crossRole.pending[uid];
          }
        }
        save();
        return {
          ok: true,
          crossRole: {
            enabled: !!c.enabled, targetGuildId: c.targetGuildId || null,
            roleId: c.roleId || null, pending: pendingCount(),
          },
        };
      }

      let targetGuildId = c.targetGuildId || null;
      if ('targetGuildId' in b) {
        const target = b.targetGuildId && client.guilds.cache.get(b.targetGuildId);
        targetGuildId = target && target.id !== source.id ? target.id : null;
      }
      let roleId = c.roleId || null;
      if (!targetGuildId) {
        roleId = null;
      } else if ('roleId' in b || 'targetGuildId' in b) {
        const target = client.guilds.cache.get(targetGuildId);
        const role = b.roleId && target?.roles.cache.get(b.roleId);
        roleId = role && !role.managed && role.id !== target.id ? role.id : null;
      }
      const enabled = 'enabled' in b ? !!b.enabled : !!c.enabled;
      if (enabled && (!targetGuildId || !roleId)) {
        throw new Error('Choisis le serveur cible et le rôle avant d’activer.');
      }

      c.targetGuildId = targetGuildId;
      c.roleId = roleId;
      c.enabled = enabled;
      save();
      return {
        ok: true,
        crossRole: {
          enabled: !!c.enabled, targetGuildId: c.targetGuildId || null,
          roleId: c.roleId || null, pending: pendingCount(),
        },
      };
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
      if (sp) sp.choices ??= [];
      cfg.reasons ??= [];
      const list = isReasons ? cfg.reasons : sp.choices;
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200)
        .map((i) => ({ label: txt(i?.label, 100), description: txt(i?.description, 100) || '' })).filter((i) => i.label);
      if (!items.length) throw new Error('Aucun article reconnu dans ta liste.');
      const emoji = txt(b.emoji, 64) || null;
      const categoryId = b.categoryId && guild.channels.cache.has(b.categoryId) ? b.categoryId : null;
      const staffRoles = (Array.isArray(b.staffRoles) ? b.staffRoles : (b.staffRoleId ? [b.staffRoleId] : []))
        .filter((id) => id !== guild.id && guild.roles.cache.has(id));
      const staffRoleId = staffRoles[0] || null;
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
        if (list.length >= 125) { skipped++; continue; } // au-delà, plusieurs menus sont utilisés (125 max)
        list.push({ id: crypto.randomUUID().slice(0, 8), label: it.label, description: it.description, emoji, staffRoleId, staffRoles, categoryId, ...(isReasons ? {} : { nextSubId }) });
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
      if ('image' in f) sp.image = imgOk(f.image) || null;
      if ('thumbnail' in f) sp.thumbnail = imgOk(f.thumbnail) || null;
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
      // Miniature d'une image de la bibliothèque (le data URL n'est jamais envoyé dans /api/guild).
      if (req.method === 'GET' && url.pathname === '/api/image-file') {
        if (!authed(req)) return send(res, 401, { error: 'Connexion requise' });
        const guild = client.guilds.cache.get(url.searchParams.get('guildId'));
        if (!guild) return send(res, 404, { error: 'Serveur introuvable' });
        const d = getG(guild.id);
        const img = (d.images || []).find((x) => x.id === url.searchParams.get('id'));
        if (!img) return send(res, 404, { error: 'Image introuvable' });
        const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(img.src);
        if (!m) { res.writeHead(302, { Location: img.src }); return res.end(); }
        const buf = Buffer.from(m[2], 'base64');
        res.writeHead(200, {
          'Content-Type': m[1], 'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=86400',
        });
        return res.end(buf);
      }
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
