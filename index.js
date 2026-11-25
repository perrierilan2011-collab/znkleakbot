require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supabase = require('./supabase'); // sauvegarde distante (variables SUPABASE_URL / SUPABASE_KEY)
const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, ThumbnailBuilder,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,         // privilégié : à activer dans le portail développeur
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,       // privilégié : nécessaire pour les transcripts de tickets
    GatewayIntentBits.GuildMessageReactions, // autorole par réaction (non privilégié)
    GatewayIntentBits.GuildModeration,      // garde la liste des bannis à jour (non privilégié)
    GatewayIntentBits.GuildInvites,         // suivi des invitations (non privilégié)
  ],
  // Nécessaire pour recevoir les réactions sur des messages envoyés avant un redémarrage du bot
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ------------------------------------------------------------------ */
/*  Stockage (simple fichier JSON)                                     */
/* ------------------------------------------------------------------ */
// IMPORTANT : pour ne rien perdre à chaque mise à jour du bot, mets DB_FILE dans ton .env
// avec un chemin HORS du dossier du code (ou sur un volume persistant chez ton hébergeur).
// Exemple : DB_FILE=/data/data.json
// Et ne remplace jamais data.json quand tu envoies la nouvelle version du code.
// Le dossier "images/" (image du MP des tickets) est créé à côté de ce fichier.
const DB_FILE = process.env.DB_FILE ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.json') : path.join(__dirname, 'data.json'));
const BACKUP_FILE = DB_FILE + '.bak';
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// Première utilisation du volume : on copie l'ancien data.json livré avec le code (une seule fois).
// Ensuite le fichier du volume est la seule référence et n'est plus jamais écrasé par un déploiement.
const SEED_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DB_FILE) && path.resolve(SEED_FILE) !== path.resolve(DB_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, DB_FILE);
  console.log(`[db] old data.json copied to ${DB_FILE}`);
}

function loadDb() {
  for (const f of [DB_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      console.log(`[db] data loaded from ${f} (${Object.keys(data).length} server(s))`);
      return data;
    } catch (e) {
      console.error(`[db] ${f} illisible :`, e.message);
    }
  }
  // Fichier présent mais illisible et pas de sauvegarde valide : on le garde de côté avant de repartir à vide
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.corrompu-${Date.now()}`);
  console.warn(`[db] NO data found (${DB_FILE}) : starting empty.`);
  return {};
}

let db = loadDb();
let lastBackup = 0;
const save = () => {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    if (fs.existsSync(DB_FILE) && Date.now() - lastBackup > 60_000) {
      fs.copyFileSync(DB_FILE, BACKUP_FILE);
      lastBackup = Date.now();
    }
    fs.renameSync(tmp, DB_FILE); // écriture atomique : plus de fichier à moitié écrit
    supabase.queue(db);          // copie distante (survit aux redéploiements)
  } catch (e) {
    console.error('[db] backup failed:', e);
  }
};

function getG(id) {
  db[id] ??= {
    memberCountChannel: null,
    memberCountFormat: '👥 Members: {count}',
    welcome: {
      enabled: false,
      channelId: null,
      content: '{user}',
      title: 'Welcome {username}!',
      description: 'Welcome to **{server}**! You are member #{count}.',
      image: '',
      color: '#5865F2',
    },
    tickets: {}, // nom -> { name, categoryId, staffRoles[], logChannelId, reasons[], counter, panels[], placeholder, openMsg, dm, dmChoices[], dmTexts, dmImage, subPanels[], subLinks{}, defaultSubPanelId }
    open: {},    // channelId -> { userId, config, reason, claimedBy, staffRoles[] }
  };
  const g = db[id];
  // Ajout des nouveaux champs pour les serveurs déjà enregistrés
  g.modRoles ??= [];        // rôles autorisés à utiliser ban / unban / mute / unmute
  g.protectedRoles ??= [];  // rôles que seul le propriétaire peut mute / ban
  g.muteRoleId ??= null;    // rôle "Muté" créé par le bot
  g.muted ??= {};           // userId -> { roles[], until, reason, by }
  g.reactionRoles ??= {};   // messageId -> { channelId, roleId, emoji, label }
  g.joinRoles ??= [];       // rôles donnés automatiquement à l'arrivée d'un membre (/role-arrivee)
  g.sanctionChannel ??= null; // salon par défaut où annoncer les ban / mute
  // Textes des annonces giveaway / sanctions modifiables depuis le dashboard.
  // giveaway : { host: '@pseudo / <@id> / id', line: 'ligne « Organized by » ({host}…)' }
  // sanction : { by: '@pseudo / <@id> / id', ban: 'texte ({member} {moderator} {reason})', mute: '…' }
  g.announce ??= {};
  g.announce.giveaway ??= {};
  g.announce.sanction ??= {};
  // Annonce automatique de remise en stock (déclenchée depuis les choix d'un sous-panel).
  // restock : { channelId, auto: { content, title, description, image, thumbnail, footer, color } }
  g.restock ??= {};
  g.restock.channelId ??= null;
  g.restock.auto ??= {};
  g.fullRoles ??= [];       // rôles qui ont accès à TOUTES les commandes
  g.history ??= {};         // userId -> [{ type, by, reason, duration, at }]
  g.commandChannelId ??= null; // salon privé où utiliser les commandes
  g.commandChannelRoles ??= []; // rôles ajoutés à la main au salon des commandes (sans plus de commandes)
  g.giveaways ??= {};       // messageId -> { channelId, prize, winners, endAt, entrants[], ended, ... }
  g.invites ??= {
    stats: {},     // inviterId -> { joins, left }
    joinedBy: {},  // membre -> inviterId (pour compter les départs)
    rewards: [],   // [{ count, roleId }]
    board: null,   // { channelId, messageId, top, sig }
  };
  g.invites.links ??= {};      // code -> { userId, createdBy, createdAt, joins }  (liens dédiés)
  g.invites.joinedVia ??= {};  // membre -> { code, inviterId, at }  (par quel lien il est arrivé)
  g.cmdPerms ??= {};           // commande -> [roleIds]  (rôles autorisés par commande)
  g.cmdUsers ??= {};           // commande -> [userIds]  (membres autorisés par commande)
  g.disabledCommands ??= [];   // commandes retirées de Discord
  g.catPerms ??= {};            // clé de catégorie de commandes -> [roleIds]
  g.catUsers ??= {};            // clé de catégorie de commandes -> [userIds]
  g.fullUsers ??= [];           // membres qui ont accès à TOUTES les commandes
  g.catAccess ??= {};           // id catégorie Discord -> { content: [roleIds], preview: [roleIds] }
  g.pendingDm ??= {};          // "userId:config" -> { messageId, channelId, panelId }  (menu de MP en attente)
  g.panelColor ??= '#5865F2';  // couleur appliquée à TOUS les panels (tickets, vouch, ventes…)
  g.panelLogo ??= null;        // logo (miniature en haut à droite) appliqué à tous les panels de tickets
  g.vouch ??= {};              // système de vouch (avis vérifiés)
  g.vouch.channelId ??= null;  // salon dédié où sont envoyés les vouchs
  g.vouch.enabled ??= true;    // activer / désactiver /vouch
  g.vouch.logo ??= null;       // logo (miniature en haut à droite) des messages de vouch
  g.vouch.title ??= null;      // titre du vouch (null = "Customer review")
  g.vouch.footer ??= null;     // pied de page du vouch (null = serveur • Customer feedback • date)
  // Bloc libre affiché sous l'avis : l'admin y met ce qu'il veut (une ligne par information).
  g.vouch.details ??= '**Service** — {category}\n**Support** — {claimed}\n**Ticket** — {ticket}';
  g.vouches ??= [];            // [{ id, ticketId, ticketName, config, from, claimedBy, stars, message, image, at }]
  g.sales ??= {};              // suivi des ventes
  g.sales.channelId ??= null;  // salon du panel de suivi
  g.sales.messageId ??= null;  // message du panel de suivi
  g.sales.sig ??= null;        // empreinte du dernier panel affiché
  g.sales.count ??= 0;         // nombre total de ventes
  g.sales.total ??= 0;         // argent généré (total)
  g.sales.currency ??= '€';    // devise affichée
  g.sales.logo ??= null;       // logo (miniature en haut à droite) du panel de suivi
  g.sales.entries ??= [];      // 100 dernières ventes [{ at, amount, buyerId, buyerName, product, by, config, ticket }]
  // Annonces boutique déjà envoyées (produits / restock) : permet de les modifier ou de les renvoyer.
  // [{ id, kind, channelId, messageId, at, params: { title, text, lines, links, image, thumb, footer, color, logo } }]
  g.shopPosts ??= [];
  // Bibliothèque d'images du dashboard : [{ id, name, src (data URL ou lien), at }]
  g.images ??= [];
  // Sauvegarde des membres (pour retrouver tout le monde après un changement de serveur)
  g.memberBackup ??= null; // { at, guildName, members: [{ id, username, displayName, joinedAt, roles }] }
  // Migration : un seul rôle staff -> plusieurs rôles staff
  for (const c of Object.values(g.tickets)) {
    c.staffRoles ??= c.staffRoleId ? [c.staffRoleId] : [];
    c.panels ??= []; // panels envoyés : [{ channelId, messageId, customDesc, sig, button, btnLabel, btnStyle, openMsg }]
    c.placeholder ??= null; // texte du menu déroulant du panel (ex : "Choisir une catégorie...")
    c.openMsg ??= null;     // message d'ouverture par défaut de cette configuration (modifiable avec /ticket message)
    c.dm ??= false;         // ouverture des tickets par message privé (menu dans le MP)
    c.dmChoices ??= [];     // choix du menu du MP : [{ id, label, emoji, description, categoryId, staffRoleId }]
    c.dmTexts ??= null;     // { title, description, placeholder, color, sentReply, doneTitle, doneText, invalid }
    c.dmImage ??= null;     // nom du fichier image du MP (dans le dossier images/)
    c.subPanels ??= [];     // sous-panels : [{ id, name, title, description, placeholder, color, choices: [{ id, label, emoji, description, categoryId, staffRoleId }] }]
    c.subLinks ??= {};      // id d'une catégorie du menu (panel ou MP) -> id d'un sous-panel, ou 'none' (aucun sous-panel)
    c.openPresets ??= [];   // modèles de message d'ouverture : [{ id, name, openMsg }] (un élément s'y réfère avec openMsgId)
    c.defaultSubPanelId ??= null; // sous-panel de toutes les catégories qui n'ont pas de lien propre
    c.color ??= null;       // couleur propre à cette configuration (sinon la couleur globale du serveur)
    c.logo ??= null;        // logo propre à cette configuration (sinon le logo global du serveur)
    c.nameTemplate ??= null; // modèle du nom du salon du ticket ({user}, {category}, [prix]…)
    c.vouchButton ??= false; // bouton « Vouch » dans le message d'ouverture du ticket
    for (const r of c.reasons || []) {
      r.price ??= '';          // prix de la catégorie (variable [prix] / {prix})
      r.nameTemplate ??= null; // modèle de nom propre à cette catégorie
    }
    c.translate ??= true;   // live translation (any language → French + English) inside this configuration's tickets
    if (!c.dmMigrated) {    // une seule fois : reprise de l'ancien système de MP
      c.dmMigrated = true;
      if (c.dm && !c.dmChoices.length) c.dmChoices = c.reasons.map((r) => ({ ...r }));
      if (c.dmMsg && !c.dmTexts) {
        c.dmTexts = { title: c.dmMsg.title || null, description: c.dmMsg.description || null, color: c.dmMsg.color || null };
      }
    }
  }
  return g;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const EPH = MessageFlags.Ephemeral;
const isUrl = (u) => /^https?:\/\/\S+$/i.test((u || '').trim());
// Image d'un panel : lien http(s) ou fichier déjà joint au message (attachment://...).
const isMedia = (u) => isUrl(u) || /^attachment:\/\/\S+$/i.test(String(u || '').trim());
// Image importée depuis le dashboard (base64) : renvoyée en pièce jointe à l'envoi.
const isDataImage = (u) => /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(String(u || '').trim());
const mediaOk = (u) => isUrl(u) || isDataImage(u);
const srcHash = (u) => (u ? crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 12) : '');
function dataUrlExt(u) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,/i.exec(String(u || ''));
  if (!m) return '.png';
  const k = m[1].toLowerCase();
  return k === 'jpeg' ? '.jpg' : '.' + k;
}
// Transforme une source d'image (lien, attachment:// ou data:) en référence utilisable par Discord.
// Les images importées (data:) sont ajoutées aux fichiers du message.
async function imageRef(src, baseName, files = []) {
  const v = String(src || '').trim();
  if (!v) return null;
  if (isMedia(v)) return v;
  if (isDataImage(v)) {
    const f = await toFile({ url: v, name: baseName + dataUrlExt(v) }, baseName);
    files.push(f);
    return `attachment://${f.name}`;
  }
  return null;
}
// Logo affiché (panel / message) : logo du panel, sinon celui de la config, sinon le logo global.
const logoSource = (cfg, d, p) => (p?.showLogo === false ? null : (p?.thumb || cfg?.logo || d?.panelLogo || null));

// Convertit un emoji écrit par l'utilisateur en objet accepté par Discord.
// Accepte : 🎮  |  <:nitro:123456789012345678>  |  <a:anim:123456789012345678>  |  un ID seul
function parseEmoji(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/^<(a?):(\w{2,32}):(\d{17,20})>$/);
  if (m) return { animated: !!m[1], name: m[2], id: m[3] };
  if (/^\d{17,20}$/.test(s)) return { id: s };
  if (/\p{Extended_Pictographic}/u.test(s)) return { name: s };
  return null;
}

const parseColor = (c, d = '#5865F2') =>
  /^#?[0-9a-f]{6}$/i.test((c || '').trim()) ? '#' + c.trim().replace('#', '') : d;

// Empreinte d'un contenu : sert à savoir si un message doit être modifié (évite les modifications inutiles)
const sig = (o) => crypto.createHash('sha1').update(JSON.stringify(o ?? null)).digest('hex');

// Récupère un message. gone = true si le message ou le salon a vraiment été supprimé
async function fetchMsg(guild, channelId, messageId) {
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch || !ch.messages) return { msg: null, gone: true };
    return { msg: await ch.messages.fetch(messageId), gone: false };
  } catch (e) {
    return { msg: null, gone: e.code === 10003 || e.code === 10008 };
  }
}

const fmt = (txt, member) =>
  (txt || '')
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', String(member.guild.memberCount));

// Couleurs possibles pour un bouton Discord
const BTN_COLORS = [
  { name: 'Blue', value: 'Primary' },
  { name: 'Grey', value: 'Secondary' },
  { name: 'Green', value: 'Success' },
  { name: 'Red', value: 'Danger' },
];
const btnStyle = (s) => ButtonStyle[s] ?? ButtonStyle.Primary;
const BTN_NAMES = { Primary: 'blue', Secondary: 'grey', Success: 'green', Danger: 'red' };

/* ---------- Mentions et salons cliquables ---------- */
// Transforme ce qui est tapé à la main en vraies mentions cliquables, comme dans un message normal :
//   @Pseudo  ->  <@id>      @NomDuRôle  ->  <@&id>      #nom-du-salon  ->  <#id>
// Les mentions déjà écrites (<@id>, <@&id>, <#id>) sont gardées telles quelles.
// Un "\n" écrit à la main (dans les options de commande sur une seule ligne) devient un retour à la ligne.
// Renvoie { text, users[], roles[] } : users et roles servent à mentionner réellement (notification).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function rich(guild, input) {
  let text = String(input ?? '').replace(/\\n/g, '\n');
  const users = new Set();
  const roles = new Set();
  for (const m of text.matchAll(/<@!?(\d{15,25})>/g)) users.add(m[1]);
  for (const m of text.matchAll(/<@&(\d{15,25})>/g)) roles.add(m[1]);
  const out = () => ({ text, users: [...users], roles: [...roles] });
  if (!guild || !/[@#]/.test(text)) return out();

  const hasAt = text.includes('@');
  const hasHash = text.includes('#');
  if (hasAt && guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch().catch(() => {});
  }

  const cands = [];
  if (hasAt) {
    for (const r of guild.roles.cache.values()) {
      if (r.id !== guild.id) cands.push({ key: '@' + r.name, mention: `<@&${r.id}>`, kind: 'role', id: r.id });
    }
    for (const m of guild.members.cache.values()) {
      for (const n of new Set([m.displayName, m.user.username])) {
        if (['everyone', 'here'].includes(String(n).toLowerCase())) continue;
        cands.push({ key: '@' + n, mention: `<@${m.id}>`, kind: 'user', id: m.id });
      }
    }
  }
  if (hasHash) {
    for (const c of guild.channels.cache.values()) {
      if (c.type === ChannelType.GuildCategory) continue;
      cands.push({ key: '#' + c.name, mention: `<#${c.id}>`, kind: 'channel', id: c.id });
    }
  }

  // Les noms les plus longs d'abord (pour que "@Admin Chef" passe avant "@Admin")
  const lower = text.toLowerCase();
  const found = cands
    .filter((c) => c.key.length > 1 && lower.includes(c.key.toLowerCase()))
    .sort((a, b) => b.key.length - a.key.length);

  for (const c of found) {
    const re = new RegExp(`(?<![<\\p{L}\\p{N}_])${escRe(c.key)}(?![\\p{L}\\p{N}_-])`, 'giu');
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    text = text.replace(re, c.mention);
    if (c.kind === 'user') users.add(c.id);
    if (c.kind === 'role') roles.add(c.id);
  }
  return out();
}

// Résout « @pseudo », « <@123> » ou « 123 » en ID de membre (null si introuvable).
async function resolveMemberId(guild, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const m = /^<@!?(\d{15,25})>$/.exec(v) || /^(\d{15,25})$/.exec(v);
  if (m) return m[1];
  const name = v.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  const find = () => [...guild.members.cache.values()].find((x) =>
    x.user.username.toLowerCase() === name ||
    String(x.displayName || '').toLowerCase() === name ||
    x.user.tag.toLowerCase() === name);
  let member = find();
  if (!member) {
    await guild.members.fetch().catch(() => {});
    member = find();
  }
  return member?.id || null;
}

// Applique des variables à un texte d'annonce puis résout les @pseudo / #salon.
async function announceText(guild, template, vars = {}) {
  let text = String(template ?? '');
  for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v ?? ''));
  return (await rich(guild, text)).text;
}

function field(id, label, style, { required = false, value, max, placeholder } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) t.setValue(String(value).slice(0, max || 4000));
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
}

// Re-télécharge une pièce jointe (les liens CDN de Discord expirent).
// Accepte aussi les data URLs (images importées depuis le dashboard) sans passer par fetch.
async function toFile(att, baseName) {
  const url = String(att.url || '');
  const data = /^data:(image\/(png|jpe?g|gif|webp));base64,([\s\S]*)$/i.exec(url);
  if (data) {
    // Le nom du fichier doit garder la vraie extension (un JPEG importé ne doit pas s'appeler .png).
    const k = data[2].toLowerCase();
    const ext = k === 'jpeg' || k === 'jpg' ? '.jpg' : '.' + k;
    const buf = Buffer.from(data[3], 'base64');
    return new AttachmentBuilder(buf, { name: baseName + ext });
  }
  const ext = (att.name || '').match(/\.\w+$/)?.[0] || '.png';
  const res = await fetch(url);
  return new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: baseName + ext });
}

// Convertit une pièce jointe Discord en data URL (pour pouvoir la réutiliser plus tard).
async function attToData(att) {
  try {
    const url = String(att.url || '');
    if (url.startsWith('data:')) return url;
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) return att.url;
    const type = String(att.contentType || 'image/png').split(';')[0];
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return att.url;
  }
}

/* ---------- Formulaire + embed partagés par /annonce et /autorole ---------- */
function announceModal(modalId, title, textLabel = "Announcement text (Markdown accepted)") {
  return new ModalBuilder().setCustomId(modalId).setTitle(title).addComponents(
    field('titre', 'Titre', TextInputStyle.Short, { max: 256 }),
    field('texte', textLabel, TextInputStyle.Paragraph, {
      required: true, max: 4000, placeholder: '@Pseudo @Role #channel → become clickable',
    }),
    field('image_url', "Image URL (if no file)", TextInputStyle.Short, { max: 500 }),
    field('footer', 'Footer', TextInputStyle.Short, { max: 2048 }),
    field('couleur', 'Hex color (ex: #FF0000)', TextInputStyle.Short, { max: 7 }),
  );
}

async function buildAnnounce(m, img, thumb) {
  const titre = m.fields.getTextInputValue('titre');
  const texte = m.fields.getTextInputValue('texte');
  const imageUrl = m.fields.getTextInputValue('image_url').trim();
  const footer = m.fields.getTextInputValue('footer');
  const couleur = m.fields.getTextInputValue('couleur');

  // @Pseudo / @Rôle / #salon -> vraies mentions cliquables
  const r = await rich(m.guild, texte);

  const embed = new EmbedBuilder().setColor(parseColor(couleur)).setDescription(r.text.slice(0, 4096));
  if (titre) embed.setTitle(titre);
  if (footer) embed.setFooter({ text: footer });
  embed.setTimestamp();

  const files = [];
  if (img) {
    const f = await toFile(img, 'image');
    files.push(f);
    embed.setImage(`attachment://${f.name}`);
  } else if (isUrl(imageUrl)) {
    embed.setImage(imageUrl);
  }
  if (thumb) {
    const f = await toFile(thumb, 'miniature');
    files.push(f);
    embed.setThumbnail(`attachment://${f.name}`);
  }
  return { embed, files, mentions: { users: r.users, roles: r.roles } };
}

// Boutons-liens : "Label | https://url | emoji" (un par ligne, 25 maximum).
// Le lien peut aussi être un salon : "#nom-du-salon", "<#123...>" ou son ID.
// Il devient alors https://discord.com/channels/<serveur>/<salon> et ouvre le salon en un clic.
function channelFromRef(ref, guild) {
  const v = String(ref || '').trim();
  if (!v || !guild) return null;
  let id = null;
  const mention = /^<#(\d{15,25})>$/.exec(v);
  const rawId = /^(\d{15,25})$/.exec(v);
  if (mention) id = mention[1];
  else if (rawId) id = rawId[1];
  else if (v.startsWith('#')) {
    const name = v.slice(1).trim().toLowerCase();
    const list = guild.channels?.cache;
    const ch = list?.find?.((c) => Number(c.type) !== 4 && String(c.name || '').toLowerCase() === name);
    if (ch) id = ch.id;
  }
  if (!id) return null;
  const ch = guild.channels?.cache?.get?.(id) || null;
  return ch || { id, name: null };
}
const channelUrl = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;
function parseLinks(raw, guild) {
  const out = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split('|').map((x) => x.trim());
    let label, url, emoji;
    if (parts.length === 1) url = parts[0];
    else { label = parts[0]; url = parts[1]; emoji = parts[2]; }
    const ch = channelFromRef(url, guild);
    if (ch) {
      url = channelUrl(guild.id, ch.id);
      if (!label) label = ch.name ? '#' + ch.name : 'Open';
    }
    if (!isUrl(url)) continue;
    out.push({ label: (label || url).slice(0, 80), url: url.slice(0, 512), emoji: emoji || null });
    if (out.length >= 25) break;
  }
  return out;
}
function linkRows(links) {
  const rows = [];
  for (const part of chunkList(links.slice(0, 25), 5)) {
    const row = new ActionRowBuilder();
    for (const l of part) {
      const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(l.url);
      const e = parseEmoji(l.emoji);
      const label = String(l.label || 'Open').slice(0, 80);
      // Un emoji Unicode est mis DANS le libellé : Discord l'aligne alors parfaitement avec le texte.
      // Les emojis personnalisés du serveur passent par le slot emoji natif du bouton.
      if (e && !e.id) {
        b.setLabel((label.startsWith(e.name) ? label : `${e.name} ${label}`).slice(0, 80));
      } else {
        b.setLabel(label);
        if (e) b.setEmoji(e);
      }
      row.addComponents(b);
    }
    rows.push(row);
  }
  return rows;
}
// Lignes de restock : "Variante | Prix | Stock" (8 lignes maximum = 24 champs embed).
function parseStockRows(raw) {
  const out = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split('|').map((x) => x.trim());
    if (!p[0]) continue;
    out.push({ variant: p[0], price: p[1] || '—', stock: p[2] || '—' });
    if (out.length >= 8) break;
  }
  return out;
}
function productModal(modalId) {
  return new ModalBuilder().setCustomId(modalId).setTitle('New product').addComponents(
    field('titre', 'Title', TextInputStyle.Short, { max: 256, placeholder: '🎯 NEW PRODUCT: ...' }),
    field('texte', 'Description (Markdown, @role #chan)', TextInputStyle.Paragraph, {
      required: true, max: 4000, placeholder: '### What’s included?\n- ...\n- ...',
    }),
    field('liens', 'Buttons: Label | URL or #channel | emoji', TextInputStyle.Paragraph, {
      max: 4000, placeholder: 'Check / Purchase | https://... | 🛒\nBuy in this channel | #buy-here | 🛒',
    }),
    field('image_url', 'Image URL (if no file)', TextInputStyle.Short, { max: 500 }),
    field('footer', 'Footer', TextInputStyle.Short, { max: 2048 }),
  );
}
function restockModal(modalId) {
  return new ModalBuilder().setCustomId(modalId).setTitle('New restock').addComponents(
    field('titre', 'Title', TextInputStyle.Short, { max: 256, placeholder: 'Buy Now' }),
    field('lignes', 'Rows: Variant | Price | Stock (one per line)', TextInputStyle.Paragraph, {
      required: true, max: 4000, placeholder: 'Rockstar Activation Codes [Automatic Delivery] | $0.11 | 439',
    }),
    field('liens', 'Buttons: Label | URL or #channel | emoji', TextInputStyle.Paragraph, {
      max: 4000, placeholder: 'Buy Now | #buy-here | 🛒',
    }),
    field('image_url', 'Image URL (if no file)', TextInputStyle.Short, { max: 500 }),
    field('footer', 'Footer', TextInputStyle.Short, { max: 2048 }),
  );
}

// Construit le message produit / restock à partir de paramètres réutilisables.
// params : { title, text, lines, rows, links, image, thumb, footer, color, logo }
async function buildCatalogPayload(kind, params, d, guild) {
  const files = [];
  const embed = new EmbedBuilder()
    .setColor(parseColor(params.color, d.panelColor || '#5865F2'))
    .setTimestamp();
  if (params.title) embed.setTitle(String(params.title).slice(0, 256));
  if (params.footer) embed.setFooter({ text: String(params.footer).slice(0, 2048) });

  let mentions = { users: [], roles: [] };
  if (kind === 'product') {
    const texte = String(params.text || '');
    if (texte) {
      const r = await rich(guild, texte);
      mentions = r;
      embed.setDescription(r.text.slice(0, 4096));
    }
  } else {
    const rows = Array.isArray(params.rows) && params.rows.length ? params.rows : parseStockRows(params.lines);
    if (!rows.length) throw new Error('Add at least one row: Variant | Price | Stock');
    for (const row of rows) {
      embed.addFields(
        { name: 'Variant', value: String(row.variant || '—').slice(0, 1024), inline: true },
        { name: 'Price', value: String(row.price || '—').slice(0, 1024), inline: true },
        { name: 'Stock', value: String(row.stock || '—').slice(0, 1024), inline: true },
      );
    }
  }

  const image = await imageRef(params.image, 'image', files);
  if (image) embed.setImage(image);
  let logo = null;
  if (params.thumb) logo = await imageRef(params.thumb, 'logo', files);
  else if (params.logo !== false) logo = await imageRef(d.panelLogo, 'logo', files);
  if (logo) embed.setThumbnail(logo);

  const links = Array.isArray(params.links) ? params.links : parseLinks(params.links, guild);
  return { embeds: [embed], components: linkRows(links), files, mentions };
}

// Annonce automatique quand un choix de sous-panel est remis en stock depuis le dashboard.
// config = { channelId, auto: { content, title, description, image, thumbnail, footer, color } }
async function sendRestockAnnouncement(guild, { cfg = null, sub = null, choice, config = null } = {}) {
  const d = getG(guild.id);
  const rc = config || d.restock || {};
  const channelId = rc.channelId;
  if (!channelId) throw new Error('Aucun salon de restock configuré (onglet Restock).');
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error('Salon de restock introuvable.');
  const m = rc.auto || {};
  const vars = (s) => String(s ?? '')
    .replaceAll('{choice}', choice?.label || '')
    .replaceAll('{article}', choice?.label || '')
    .replaceAll('{product}', choice?.label || '')
    .replaceAll('{price}', choice?.description || '')
    .replaceAll('{prix}', choice?.description || '')
    .replaceAll('{sub}', sub?.name || '')
    .replaceAll('{config}', cfg?.name || '')
    .replaceAll('{server}', guild.name || '');
  const files = [];
  const embed = new EmbedBuilder()
    .setColor(parseColor(m.color, cfg?.color || d.panelColor || '#5865F2'))
    .setTimestamp()
    .setTitle(vars(m.title || '📦 Restock').slice(0, 256))
    .setDescription(vars(m.description || '**{choice}** est de nouveau en stock !').slice(0, 4096));
  if (m.footer) embed.setFooter({ text: vars(m.footer).slice(0, 2048) });
  const img = m.image ? await imageRef(m.image, 'restock', files) : null;
  if (img) embed.setImage(img);
  const thumb = m.thumbnail ? await imageRef(m.thumbnail, 'thumbnail', files) : null;
  if (thumb) embed.setThumbnail(thumb);
  const content = m.content ? (await rich(guild, vars(m.content))).text.slice(0, 2000) : undefined;
  await channel.send({ content, embeds: [embed], files, allowedMentions: { parse: [] } });
  return true;
}

// /product et /restock : même logique (embed + image + logo + boutons-liens).
async function catalogPost(i, kind) {
  const salon = i.options.getChannel('salon', true);
  const mentionOpt = i.options.get('mention');
  const ping = i.options.getString('ping');
  const couleur = i.options.getString('couleur');
  const logoOn = i.options.getBoolean('logo') ?? true;
  const img = i.options.getAttachment('image');
  const thumb = i.options.getAttachment('miniature');

  if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return i.reply({ content: '❌ You need permission to mention @everyone.', flags: EPH });
  }

  const modalId = `${kind}_${i.id}`;
  await i.showModal(kind === 'product' ? productModal(modalId) : restockModal(modalId));
  const m = await i.awaitModalSubmit({
    time: 15 * 60_000,
    filter: (x) => x.customId === modalId && x.user.id === i.user.id,
  }).catch(() => null);
  if (!m) return;

  await m.deferReply({ flags: EPH });
  try {
    const d = getG(i.guildId);
    const params = {
      title: m.fields.getTextInputValue('titre').trim(),
      footer: m.fields.getTextInputValue('footer').trim(),
      links: m.fields.getTextInputValue('liens').trim(),
      color: couleur || '',
      logo: logoOn,
      // Les pièces jointes sont converties en data URL : elles restent utilisables pour modifier / renvoyer.
      image: img ? await attToData(img) : m.fields.getTextInputValue('image_url').trim(),
      thumb: thumb ? await attToData(thumb) : '',
    };
    if (kind === 'product') params.text = m.fields.getTextInputValue('texte').trim();
    else params.lines = m.fields.getTextInputValue('lignes').trim();

    const payload = await buildCatalogPayload(kind, params, d, m.guild);
    const { content, allowed } = buildMentions(ping, mentionOpt, payload.mentions);
    const sent = await salon.send({
      content, embeds: payload.embeds, components: payload.components, files: payload.files, allowedMentions: allowed,
    });

    d.shopPosts.push({
      id: crypto.randomUUID().slice(0, 8), kind, channelId: salon.id, messageId: sent.id,
      at: Date.now(), params,
    });
    d.shopPosts = d.shopPosts.slice(-8);
    save();
    await m.editReply(`✅ ${kind === 'product' ? 'Product' : 'Restock'} sent in <#${salon.id}>.`);
  } catch (e) {
    console.error(e);
    await m.editReply('❌ Unable to send (check my permissions in this channel and the image links).');
  }
}


// extra = { users[], roles[] } : personnes / rôles mentionnés dans le texte, ils sont aussi notifiés
function buildMentions(ping, mentionOpt, extra = {}) {
  const parts = [];
  const allowed = { parse: [], roles: [], users: [] };
  if (ping) { parts.push(`@${ping}`); allowed.parse.push('everyone'); }
  if (mentionOpt?.role) { parts.push(`<@&${mentionOpt.role.id}>`); allowed.roles.push(mentionOpt.role.id); }
  else if (mentionOpt?.user) { parts.push(`<@${mentionOpt.user.id}>`); allowed.users.push(mentionOpt.user.id); }
  for (const id of extra.roles || []) {
    if (allowed.roles.includes(id) || allowed.roles.length >= 20) continue;
    parts.push(`<@&${id}>`); allowed.roles.push(id);
  }
  for (const id of extra.users || []) {
    if (allowed.users.includes(id) || allowed.users.length >= 20) continue;
    parts.push(`<@${id}>`); allowed.users.push(id);
  }
  return { content: parts.join(' ').slice(0, 2000) || undefined, allowed };
}

/* ------------------------------------------------------------------ */
/*  Permissions de modération                                          */
/* ------------------------------------------------------------------ */
// 👑 = propriétaire du serveur (la couronne)
const isOwner = (i) => i.guild.ownerId === i.user.id;

// Le propriétaire OU un membre / rôle choisi avec /role-total : accès à TOUTES les commandes
const hasFullAccess = (i) => {
  const d = getG(i.guildId);
  return isOwner(i) || (d.fullUsers || []).includes(i.user.id) ||
    i.member.roles.cache.some((r) => d.fullRoles.includes(r.id));
};

// Catégories de commandes : un rôle donné à une catégorie a accès à toutes ses commandes
const CMD_CATEGORIES = {
  moderation:  { label: '🛡️ Moderation', commands: ['ban', 'unban', 'mute', 'unmute', 'sanctions-actives', 'historique-sanctions'] },
  giveaways:   { label: '🎉 Giveaways', commands: ['giveaway'] },
  annonces:    { label: '📢 Announcements & roles', commands: ['annonce', 'autorole', 'role-arrivee', 'bienvenue'] },
  boutique:    { label: '🛍️ Shop (product & restock)', commands: ['product', 'restock'] },
  invitations: { label: '📈 Invitations (admin)', commands: ['invites-config', 'lien-invite', 'qui-a-invite', 'classement-invites', 'classement-invites-maj'] },
  tickets:     { label: '🎫 Tickets', commands: ['ticket', 'setup-paiement', 'add', 'remove'] },
  souspanel:   { label: '🗂️ Sub-panels', commands: ['sous-panel'] },
  serveur:     { label: '⚙️ Server', commands: ['salon-commandes', 'salon-sanctions', 'membercount', 'acces-categorie'] },
};
const CMD_CATEGORY = {};
for (const [key, c] of Object.entries(CMD_CATEGORIES)) {
  for (const name of c.commands) CMD_CATEGORY[name] = key;
}

// Rôles / membres autorisés pour la commande utilisée (/permissions) ou sa catégorie (/permissions-categorie)
const cmdAllowed = (i) => {
  const d = getG(i.guildId);
  const ids = [...(d.cmdPerms[i.commandName] || [])];
  const users = [...(d.cmdUsers?.[i.commandName] || [])];
  const cat = CMD_CATEGORY[i.commandName];
  if (cat) {
    ids.push(...(d.catPerms[cat] || []));
    users.push(...(d.catUsers?.[cat] || []));
  }
  if (users.includes(i.user.id)) return true;
  return !!ids.length && i.member.roles.cache.some((r) => ids.includes(r.id));
};

// Accès total OU un rôle /roles-mod OU un rôle autorisé pour cette commande avec /permissions
const canModerate = (i) =>
  hasFullAccess(i) || i.member.roles.cache.some((r) => getG(i.guildId).modRoles.includes(r.id)) || cmdAllowed(i);

// Les rôles /roles-mod n'ont accès qu'à ces commandes.
const MOD_COMMANDS = new Set(['ban', 'unban', 'mute', 'unmute', 'sanctions-actives', 'historique-sanctions']);
// Commandes ouvertes à tout le monde (un membre sans aucune permission n'a que celles-ci)
const PUBLIC_COMMANDS = new Set(['help', 'invites']);
// Commandes utilisables directement dans un salon de ticket (créateur + staff)
const TICKET_MEMBER_COMMANDS = new Set(['add', 'remove']);
// Commandes qu'on ne peut jamais désactiver (sinon on se bloque soi-même)
const ALWAYS_ON = new Set(['help', 'commandes', 'permissions', 'permissions-categorie', 'salon-commandes']);
// Commandes réservées au propriétaire (on ne peut pas les donner à un rôle)
const OWNER_ONLY = new Set(['permissions', 'permissions-categorie', 'commandes', 'role-total']);
const commandAllowed = (i) =>
  PUBLIC_COMMANDS.has(i.commandName) || hasFullAccess(i) ||
  (MOD_COMMANDS.has(i.commandName) && canModerate(i)) || cmdAllowed(i) ||
  (TICKET_MEMBER_COMMANDS.has(i.commandName) && !!i.guildId && !!getG(i.guildId).open[i.channelId]);

const NO_ACCESS = { content: "❌ You do not have access to this command.", flags: EPH };

/* ---------- Salon des commandes (privé) ---------- */
// Ces commandes restent utilisables partout : les publiques (le salon est privé, les membres ne le voient pas)
// et /salon-commandes (pour pouvoir le reconfigurer depuis n'importe où)
const GATE_EXEMPT = new Set([...PUBLIC_COMMANDS, 'salon-commandes']);

// Renvoie l'ID du salon des commandes si la commande est utilisée au mauvais endroit, sinon null
function wrongChannel(i) {
  const id = getG(i.guildId).commandChannelId;
  if (!id || GATE_EXEMPT.has(i.commandName) || i.channelId === id) return null;
  // /ticket ajouter|retirer, /add et /remove se font directement dans le salon du ticket,
  // même avec un salon des commandes
  if (i.commandName === 'ticket') {
    let sub = null;
    try { sub = i.options.getSubcommand(false); } catch { /* aucune sous-commande */ }
    if ((sub === 'ajouter' || sub === 'retirer') && getG(i.guildId).open[i.channelId]) return null;
  }
  if (TICKET_MEMBER_COMMANDS.has(i.commandName) && getG(i.guildId).open[i.channelId]) return null;
  if (!i.guild.channels.cache.has(id)) return null; // salon supprimé : plus de restriction
  return id;
}

// Visible uniquement par : rôles accès total, rôles modération, rôles ajoutés avec /salon-commandes, bot
// (+ propriétaire / admins qui voient tout). Les membres autorisés nommément sont ajoutés en overwrite de membre.
function commandChannelOverwrites(guild) {
  const d = getG(guild.id);
  const P = PermissionFlagsBits;
  const ids = [...new Set([
    ...d.fullRoles, ...d.modRoles, ...d.commandChannelRoles,
    ...Object.values(d.cmdPerms).flat(), ...Object.values(d.catPerms).flat(),
  ])]
    .filter((id) => id !== guild.id && guild.roles.cache.has(id));
  const userIds = [...new Set([
    ...(d.fullUsers || []), ...Object.values(d.cmdUsers || {}).flat(), ...Object.values(d.catUsers || {}).flat(),
  ])].filter((id) => /^\d{5,25}$/.test(id) && id !== client.user.id);
  return [
    { id: guild.id, deny: [P.ViewChannel] },
    ...ids.map((id) => ({
      id,
      allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.UseApplicationCommands],
    })),
    ...userIds.map((id) => ({
      id,
      allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.UseApplicationCommands],
    })),
    { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels, P.ManageMessages] },
  ];
}

// Remet les permissions du salon à jour (appelé au démarrage et quand /role-total ou /roles-mod changent)
async function syncCommandChannel(guild) {
  const d = getG(guild.id);
  if (!d.commandChannelId) return;
  const ch = await guild.channels.fetch(d.commandChannelId).catch(() => null);
  if (!ch) { d.commandChannelId = null; save(); return; }
  await ch.permissionOverwrites.set(commandChannelOverwrites(guild), 'Synchronization of the orders channel')
    .catch(console.error);
}

// Vérifie qu'on a le droit de sanctionner (ban / mute) cette personne. Renvoie un message d'erreur ou null.
function targetError(i, user, member) {
  if (user.id === i.user.id) return '❌ You can\'t do this to yourself.';
  if (user.id === client.user.id) return '❌ I can\'t punish myself.';
  if (user.id === i.guild.ownerId) return '❌ The server owner is untouchable.';
  if (member && !isOwner(i)) {
    const d = getG(i.guildId);
    if (member.roles.cache.some((r) => d.protectedRoles.includes(r.id))) {
      return '❌ This member has a protected role: only the server owner can sanction them.';
    }
    if (i.member.roles.highest.position <= member.roles.highest.position) {
      return '❌ This member has a role greater than or equal to yours.';
    }
  }
  return null;
}

/* ---------- Annonces + historique des sanctions ---------- */
function logSanction(d, userId, entry) {
  (d.history[userId] ??= []).push({ ...entry, at: Date.now() });
  save();
}

// Message simple : @membre + durée + par qui. Salon choisi dans la commande, sinon salon par défaut.
async function announceSanction(i, optionChannel, text) {
  const id = optionChannel?.id || getG(i.guildId).sanctionChannel;
  if (!id) return;
  const ch = await i.guild.channels.fetch(id).catch(() => null);
  if (ch) await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(console.error);
}

// Coupe une liste de lignes pour rester sous la limite d'un champ d'embed
function fitLines(lines, max = 1000) {
  if (!lines.length) return 'None.';
  let out = '', n = 0;
  for (const l of lines) {
    if ((out + l + '\n').length > max) break;
    out += l + '\n'; n++;
  }
  return out + (n < lines.length ? `… and ${lines.length - n} more` : '');
}

/* ------------------------------------------------------------------ */
/*  Liste des bannis (cache court : l'autocomplétion a 3 s maximum)    */
/* ------------------------------------------------------------------ */
const banCache = new Map(); // guildId -> { at, list }

async function getBans(guild) {
  const c = banCache.get(guild.id);
  if (c && Date.now() - c.at < 30_000) return c.list;
  const bans = await guild.bans.fetch();
  const list = [...bans.values()].map((b) => ({ id: b.user.id, username: b.user.username, tag: b.user.tag }));
  banCache.set(guild.id, { at: Date.now(), list });
  return list;
}

/* ------------------------------------------------------------------ */
/*  Invitations : suivi, récompenses (rôles), classement               */
/* ------------------------------------------------------------------ */
const inviteCache = new Map(); // guildId -> Map(code -> { uses, maxUses, inviterId })
const invNet = (s) => (s?.joins || 0) - (s?.left || 0);
const MEDALS = ['🥇', '🥈', '🥉'];

async function snapshotInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  const links = getG(guild.id).invites.links;
  const map = new Map();
  for (const inv of invites.values()) {
    map.set(inv.code, {
      uses: inv.uses ?? 0,
      maxUses: inv.maxUses || 0,
      // un lien dédié compte pour le membre choisi, pas pour celui qui l'a créé (le bot)
      inviterId: links[inv.code]?.userId || inv.inviter?.id || null,
    });
  }
  inviteCache.set(guild.id, map);
  return map;
}

// Renvoie { inviterId, code } ou null
async function findInviter(guild) {
  const old = inviteCache.get(guild.id) || new Map();
  const now = await snapshotInvites(guild);
  if (!now) return null;
  for (const [code, inv] of now) {
    if (inv.uses > (old.get(code)?.uses ?? 0)) return { inviterId: inv.inviterId, code };
  }
  // Invitation à usage limité supprimée juste après l'arrivée
  for (const [code, inv] of old) {
    if (!now.has(code) && inv.maxUses && inv.uses + 1 >= inv.maxUses) return { inviterId: inv.inviterId, code };
  }
  return null;
}

// Donne les rôles de récompense auxquels le membre a droit
async function checkInviteRewards(guild, userId) {
  const d = getG(guild.id).invites;
  const count = invNet(d.stats[userId]);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  for (const r of d.rewards) {
    if (count < r.count || member.roles.cache.has(r.roleId)) continue;
    const role = guild.roles.cache.get(r.roleId);
    if (role && role.editable) {
      await member.roles.add(role, `Reward: ${r.count} invitations`).catch(console.error);
    }
  }
}

function buildInviteBoard(guild, top) {
  const d = getG(guild.id).invites;
  const list = Object.entries(d.stats)
    .map(([id, s]) => ({ id, s, n: invNet(s) }))
    .filter((e) => e.s.joins > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, top);
  const lines = list.map((e, idx) =>
    `${MEDALS[idx] || `**${idx + 1}.**`} <@${e.id}> — **${e.n}** invitation${e.n > 1 ? 's' : ''}` +
    `(${e.s.joins} arrivals · ${e.s.left || 0} departures)`);
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🏆 Invitation ranking')
    .setDescription((lines.join('\n') || "No one has invited any members yet.").slice(0, 4096))
    .setFooter({ text: 'Updated' })
    .setTimestamp();
}

// Met à jour le message du classement s'il a changé. force = true : modifie même si rien n'a changé.
// Renvoie 'none' (pas de classement), 'missing' (message supprimé), 'error' ou 'ok'.
async function refreshBoard(guild, force = false) {
  const b = getG(guild.id).invites.board;
  if (!b) return 'none';
  const { msg, gone } = await fetchMsg(guild, b.channelId, b.messageId);
  if (!msg) return gone ? 'missing' : 'error';
  const embed = buildInviteBoard(guild, b.top);
  const s = sig(embed.data.description);
  if (!force && b.sig === s) return 'ok';
  try {
    await msg.edit({ embeds: [embed], allowedMentions: { parse: [] } });
    b.sig = s;
    save();
    return 'ok';
  } catch (e) {
    console.error(e);
    return 'error';
  }
}

async function onInviteJoin(member) {
  if (member.user.bot) return;
  const found = await findInviter(member.guild).catch(() => null);
  const d = getG(member.guild.id).invites;

  // On mémorise toujours par quel lien le membre est arrivé (même si inconnu)
  d.joinedVia[member.id] = { code: found?.code || null, inviterId: found?.inviterId || null, at: Date.now() };
  if (found?.code && d.links[found.code]) d.links[found.code].joins = (d.links[found.code].joins || 0) + 1;
  save();

  if (!found?.inviterId || found.inviterId === member.id) return;
  d.joinedBy[member.id] = found.inviterId;
  const s = (d.stats[found.inviterId] ??= { joins: 0, left: 0 });
  s.joins++;
  save();
  await checkInviteRewards(member.guild, found.inviterId);
}

function onInviteLeave(member) {
  const d = getG(member.guild.id).invites;
  const inviterId = d.joinedBy[member.id];
  if (!inviterId) return;
  delete d.joinedBy[member.id];
  const s = (d.stats[inviterId] ??= { joins: 0, left: 0 });
  s.left = (s.left || 0) + 1;
  save();
}

/* ------------------------------------------------------------------ */
/*  Définition des commandes                                           */
/* ------------------------------------------------------------------ */
const catAndRole = (s) => s
  .addChannelOption((o) => o.setName('categorie').setDescription('The channel category')
    .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
  .addRoleOption((o) => o.setName('role').setDescription('The role (@everyone possible)').setRequired(true));

// Options communes de /sous-panel
const spCfg = (o) => o.setName('config').setDescription('Ticket configuration').setAutocomplete(true).setRequired(true);
const spSub = (o) => o.setName('sous-panel').setDescription('Sub-panel').setAutocomplete(true).setRequired(true);
const spChoice = (o) => o.setName('sous-choix').setDescription('Choice of subpanel').setAutocomplete(true).setRequired(true);
const spPour = (o) => o.setName('pour').setDescription('All categories, or a specific category from the panel').setAutocomplete(true).setRequired(true);

const commands = [
  // ---------- Salon privé des commandes ----------
  new SlashCommandBuilder()
    .setName('salon-commandes')
    .setDescription('Create/edit private channel where to use bot commands')
    .addChannelOption((o) =>
      o.setName('categorie').setDescription('Show category (required for first creation)')
        .addChannelTypes(ChannelType.GuildCategory))
    .addStringOption((o) =>
      o.setName('nom').setDescription('Channel name (default commands)').setMaxLength(90))
    .addRoleOption((o) => o.setName('role').setDescription('Role who will have access to the channel'))
    .addRoleOption((o) => o.setName('role2').setDescription('Other role who will have access to the channel'))
    .addRoleOption((o) => o.setName('role3').setDescription('Other role who will have access to the channel'))
    .addBooleanOption((o) =>
      o.setName('vider-roles').setDescription("First remove all manually added roles"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Giveaways ----------
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaways: competition with draw')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Launch a giveaway')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel where to launch the giveaway')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName('lot').setDescription('What there is to win').setMaxLength(200).setRequired(true))
        .addIntegerOption((o) =>
          o.setName('duree').setDescription('Duration (number)').setMinValue(1).setMaxValue(525600).setRequired(true))
        .addStringOption((o) =>
          o.setName('unite').setDescription('Unit of time').setRequired(true)
            .addChoices(
              { name: 'Minutes', value: 'minutes' },
              { name: 'Hours', value: 'heures' },
              { name: 'Days', value: 'jours' },
            ))
        .addIntegerOption((o) =>
          o.setName('gagnants').setDescription('Number of winners (1 by default)').setMinValue(1).setMaxValue(20))
        .addStringOption((o) => o.setName('description').setDescription('Text under the title (@Username, @Role, #channel and \\n accepted)').setMaxLength(1000))
        .addRoleOption((o) => o.setName('role-requis').setDescription('Role needed to participate'))
        .addIntegerOption((o) =>
          o.setName('invites-min').setDescription("Minimum number of invitations to participate")
            .setMinValue(1).setMaxValue(100000))
        .addMentionableOption((o) => o.setName('mention').setDescription('Role or member to mention'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Mention globale')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
        .addAttachmentOption((o) => o.setName('image').setDescription('Giveaway image')))
    .addSubcommand((s) =>
      s.setName('terminer').setDescription('Complete a giveaway now and draw the winners')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Ongoing giveaway').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('reroll').setDescription('Draw a new winner from a finished giveaway')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Finished giveaway').setAutocomplete(true).setRequired(true))
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription('Number of new winners (1 by default)').setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) =>
      s.setName('annuler').setDescription('Cancel a giveaway and delete its message')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Giveaway').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View current giveaways'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  // ---------- Compteur de membres ----------
  new SlashCommandBuilder()
    .setName('membercount')
    .setDescription('Creates a voice channel that displays the number of members')
    .addStringOption((o) =>
      o.setName('format').setDescription('Channel text, uses {count}. Ex: 👥 Members: {count}'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  // ---------- Ban ----------
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member')
    .addUserOption((o) => o.setName('membre').setDescription('The member to ban').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Reason for ban'))
    .addIntegerOption((o) =>
      o.setName('supprimer_messages').setDescription('Delete recent messages')
        .addChoices(
          { name: 'Do not delete', value: 0 },
          { name: 'Last 24 hours', value: 1 },
          { name: 'Last 7 days', value: 7 },
        ))
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Channel where to announce the ban')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .setDefaultMemberPermissions(null) // l'accès est géré par /roles-mod
    .setDMPermission(false),

  // ---------- Unban ----------
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user')
    .addStringOption((o) =>
      o.setName('utilisateur').setDescription('Banned user (choose from the list or paste their ID)')
        .setAutocomplete(true).setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Reason for unbanning'))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Mute ----------
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Mute a member: they can no longer see any channels')
    .addUserOption((o) => o.setName('membre').setDescription('Member to mute').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('duree').setDescription('Mute duration (number)').setMinValue(1).setMaxValue(525600).setRequired(true))
    .addStringOption((o) =>
      o.setName('unite').setDescription('Unit of time').setRequired(true)
        .addChoices(
          { name: 'Minutes', value: 'minutes' },
          { name: 'Hours', value: 'heures' },
          { name: 'Days', value: 'jours' },
        ))
    .addStringOption((o) => o.setName('raison').setDescription('Reason for mute'))
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Channel where to announce the mute')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Unmute ----------
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Unmute a member')
    .addUserOption((o) => o.setName('membre').setDescription('Member to unmute').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription("Reason for unmute"))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Salon par défaut des annonces de sanctions ----------
  new SlashCommandBuilder()
    .setName('salon-sanctions')
    .setDescription('Default channel where to announce bans and mute')
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Channel for sanctions announcements')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Bannis et mutés actuels ----------
  new SlashCommandBuilder()
    .setName('sanctions-actives')
    .setDescription('View all currently banned or muted members')
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Historique d'un membre ----------
  new SlashCommandBuilder()
    .setName('historique-sanctions')
    .setDescription('See if a member has already been banned or mutated')
    .addUserOption((o) => o.setName('membre').setDescription('The member to check').setRequired(true))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Aide ----------
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('See all the commands you have access to')
    .setDMPermission(false),

  // ---------- Invitations (ouvert à tout le monde) ----------
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription("See your number of invitations (or that of a member)")
    .addUserOption((o) => o.setName('membre').setDescription('The member to watch (reserved for staff)'))
    .setDMPermission(false),

  // ---------- Configuration des récompenses d'invitations ----------
  new SlashCommandBuilder()
    .setName('invites-config')
    .setDescription("Configure automatic roles based on the number of invitations")
    .addSubcommand((s) =>
      s.setName('recompense-ajouter').setDescription('Give a role automatically from X invitations')
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription("Number of invitations required").setMinValue(1).setMaxValue(100000).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('recompense-retirer').setDescription('Remove a reward')
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription("Number of reward invitations").setMinValue(1).setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View configured rewards'))
    .addSubcommand((s) =>
      s.setName('reset').setDescription("Reset a member's invitations")
        .addUserOption((o) => o.setName('membre').setDescription('The member').setRequired(true)))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Liens d'invitation dédiés ----------
  new SlashCommandBuilder()
    .setName('lien-invite')
    .setDescription("Invitation links dedicated to a member")
    .addSubcommand((s) =>
      s.setName('creer').setDescription("Create an invitation link dedicated to a member")
        .addUserOption((o) => o.setName('membre').setDescription('The member to whom the link is dedicated').setRequired(true))
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel to which the link leads')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice).setRequired(true))
        .addIntegerOption((o) =>
          o.setName('max-utilisations').setDescription('Max number of uses (unlimited by default)').setMinValue(1).setMaxValue(100))
        .addIntegerOption((o) =>
          o.setName('expire-jours').setDescription('Expiration in days (never by default, 7 max)').setMinValue(1).setMaxValue(7)))
    .addSubcommand((s) => s.setName('liste').setDescription('See dedicated links'))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Delete a dedicated link')
        .addStringOption((o) => o.setName('lien').setDescription('The link').setAutocomplete(true).setRequired(true)))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Avec le lien de qui un membre est arrivé ----------
  new SlashCommandBuilder()
    .setName('qui-a-invite')
    .setDescription('See with whose link a member joined the server')
    .addUserOption((o) => o.setName('membre').setDescription('The member to check').setRequired(true))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Accès aux catégories de salons ----------
  new SlashCommandBuilder()
    .setName('acces-categorie')
    .setDescription('Choose who sees the content or only the channels in a category')
    .addSubcommand((s) => catAndRole(s.setName('contenu').setDescription('This role sees channels AND their content')))
    .addSubcommand((s) => catAndRole(s.setName('apercu').setDescription('This role sees the channels but NOT their history')))
    .addSubcommand((s) => catAndRole(s.setName('retirer').setDescription('Remove rules from this role on category')))
    .addSubcommand((s) => s.setName('liste').setDescription('View configured categories'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles autorisés par commande (👑) ----------
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('👑 Choose which roles can use which command')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Authorize a role to use a command')
        .addStringOption((o) => o.setName('commande').setDescription('The command').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('The role to authorize').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Remove a role's access to a command")
        .addStringOption((o) => o.setName('commande').setDescription('The command').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('See who has access to what'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles autorisés par catégorie de commandes (👑) ----------
  new SlashCommandBuilder()
    .setName('permissions-categorie')
    .setDescription('👑 Give a role access to an entire category of commands')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Allow a role to use an entire category')
        .addStringOption((o) => o.setName('categorie').setDescription('Command category').setRequired(true)
          .addChoices(...Object.entries(CMD_CATEGORIES).map(([value, c]) => ({ name: c.label, value }))))
        .addRoleOption((o) => o.setName('role').setDescription('The role to authorize').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription('Remove access from a role to a category')
        .addStringOption((o) => o.setName('categorie').setDescription('Command category').setRequired(true)
          .addChoices(...Object.entries(CMD_CATEGORIES).map(([value, c]) => ({ name: c.label, value }))))
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('See who has access to which category'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Activer / désactiver des commandes (👑) ----------
  new SlashCommandBuilder()
    .setName('commandes')
    .setDescription('👑 Remove or resubmit bot commands')
    .addSubcommand((s) =>
      s.setName('desactiver').setDescription('Remove an order (it disappears from Discord)')
        .addStringOption((o) => o.setName('commande').setDescription('The command').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('activer').setDescription('Resubmit a withdrawn order')
        .addStringOption((o) => o.setName('commande').setDescription('The command').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View all orders and their status'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Classement des invitations ----------
  new SlashCommandBuilder()
    .setName('classement-invites')
    .setDescription('Send the invitation leaderboard in a channel (automatically updated)')
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Channel where to send the ranking')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addIntegerOption((o) =>
      o.setName('top').setDescription('Number of places displayed (10 by default)').setMinValue(3).setMaxValue(25))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('classement-invites-maj')
    .setDescription('Force updating the ranking of invitations already sent')
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles avec accès à toutes les commandes (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('role-total')
    .setDescription('👑 Choose which roles have access to ALL bot commands')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription("Give access to all commands to a role")
        .addRoleOption((o) => o.setName('role').setDescription('The role to authorize').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Remove full access to a role")
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View roles with full access'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles autorisés à modérer (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('roles-mod')
    .setDescription('👑 Choose which roles can use ban - unban - mute - unmute')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Allow a role to use moderation controls')
        .addRoleOption((o) => o.setName('role').setDescription('The role to authorize').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Remove access to a role")
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View allowed roles'))
    .setDefaultMemberPermissions('0') // masquée pour tout le monde sauf admins ; vérifiée aussi dans le code
    .setDMPermission(false),

  // ---------- Rôles protégés (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('roles-proteges')
    .setDescription('👑 Choose which roles cannot be muted or banned by moderators')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Protect a role')
        .addRoleOption((o) => o.setName('role').setDescription('The role to protect').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Remove protection from a role")
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('View protected roles'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Annonces ----------
  new SlashCommandBuilder()
    .setName('annonce')
    .setDescription('Send a complete ad (title, text, images, mentions)')
    .addChannelOption((o) =>
      o.setName('salon').setDescription("Channel where to send the ad")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addMentionableOption((o) => o.setName('mention').setDescription('Role or member to mention'))
    .addStringOption((o) =>
      o.setName('ping').setDescription('Mention globale')
        .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
    .addAttachmentOption((o) => o.setName('image').setDescription('Large image at the bottom of the ad'))
    .addAttachmentOption((o) => o.setName('miniature').setDescription('Small image at top right'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  // ---------- Boutique : produit + restock ----------
  new SlashCommandBuilder()
    .setName('product')
    .setDescription('Publish a product announcement (custom text, image, unlimited link buttons)')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Send a product announcement')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel where to post the product')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addAttachmentOption((o) => o.setName('image').setDescription('Large image (file)'))
        .addAttachmentOption((o) => o.setName('miniature').setDescription('Logo at top right (file)'))
        .addStringOption((o) => o.setName('couleur').setDescription('Hex color, e.g. #00D4FF').setMaxLength(7))
        .addBooleanOption((o) => o.setName('logo').setDescription('Show the server logo (default: yes)'))
        .addMentionableOption((o) => o.setName('mention').setDescription('Role or member to mention'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Global mention')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' })))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('restock')
    .setDescription('Publish a restock / Buy Now panel (variant, price, stock, image, links)')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Send a restock panel')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel where to post the restock')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addAttachmentOption((o) => o.setName('image').setDescription('Large image (file)'))
        .addAttachmentOption((o) => o.setName('miniature').setDescription('Logo at top right (file)'))
        .addStringOption((o) => o.setName('couleur').setDescription('Hex color, e.g. #00D4FF').setMaxLength(7))
        .addBooleanOption((o) => o.setName('logo').setDescription('Show the server logo (default: yes)'))
        .addMentionableOption((o) => o.setName('mention').setDescription('Role or member to mention'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Global mention')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' })))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  // ---------- Message privé de masse ----------
  new SlashCommandBuilder()
    .setName('message-mp')
    .setDescription('Send a private message to all server members (except bots)')
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Autorole par réaction ----------
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('A message with a reaction that gives a role')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Send a message: reacting with the emoji gives the role')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel where to send the message')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('The role given by the reaction').setRequired(true))
        .addStringOption((o) =>
          o.setName('emoji').setDescription('Reaction emoji (e.g. 🎮 or a server emoji)').setRequired(true))
        .addMentionableOption((o) => o.setName('mention').setDescription('Role or member to mention'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Mention globale')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
        .addAttachmentOption((o) => o.setName('image').setDescription('Large image at bottom of post'))
        .addAttachmentOption((o) => o.setName('miniature').setDescription('Small image at top right')))
    .addSubcommand((s) => s.setName('liste').setDescription('View existing autoroles'))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Delete an autorole (and its message)')
        .addStringOption((o) =>
          o.setName('message').setDescription('Authority to delete').setAutocomplete(true).setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),

  // ---------- Rôle automatique à l'arrivée ----------
  new SlashCommandBuilder()
    .setName('role-arrivee')
    .setDescription("Roles automatically given to each new member (without reaction)")
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription("Give this role to all new members")
        .addRoleOption((o) => o.setName('role').setDescription('The role to be given').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("No longer give this role on arrival")
        .addRoleOption((o) => o.setName('role').setDescription('The role to be removed').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription("See the roles given on arrival"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),

  // ---------- Bienvenue ----------
  new SlashCommandBuilder()
    .setName('bienvenue')
    .setDescription("New member onboarding system")
    .addSubcommand((s) =>
      s.setName('configurer').setDescription('Choose the channel and edit the whole message')
        .addChannelOption((o) =>
          o.setName('salon').setDescription("Welcome channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('activer').setDescription('Enable welcome message'))
    .addSubcommand((s) => s.setName('desactiver').setDescription('Disable welcome message'))
    .addSubcommand((s) => s.setName('test').setDescription("Preview the message with your profile"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Installation automatique du ticket paiement ----------
  new SlashCommandBuilder()
    .setName('setup-paiement')
    .setDescription('Install everything: DM menu (PayPal / Wero...), server categories and panel')
    .addRoleOption((o) => o.setName('role-staff').setDescription('Staff role that manages tickets').setRequired(true))
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Channel to send the panel to')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addStringOption((o) =>
      o.setName('moyens').setDescription('Payment methods separated by a comma (default: PayPal, Wero)').setMaxLength(300))
    .addStringOption((o) =>
      o.setName('nom').setDescription('Configuration name (default: payment)').setMaxLength(30))
    .addChannelOption((o) =>
      o.setName('salon-logs').setDescription('Channel where to send transcripts at closing')
        .addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName('titre').setDescription('Panel title'))
    .addStringOption((o) => o.setName('description').setDescription('Panel text'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Sous-panels ----------
  new SlashCommandBuilder()
    .setName('sous-panel')
    .setDescription("Sub-panels: a 2nd menu offered after choosing a panel category")
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Create a subpanel')
        .addStringOption(spCfg)
        .addStringOption((o) => o.setName('nom').setDescription('Name of the subpanel (ex: Nitro)').setMaxLength(60).setRequired(true))
        .addStringOption((o) => o.setName('titre').setDescription('Subpanel post title').setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Subpanel message text').setMaxLength(1000))
        .addStringOption((o) => o.setName('placeholder').setDescription('Menu text (e.g.: Choose an option...)').setMaxLength(100))
        .addStringOption((o) => o.setName('couleur').setDescription('Hex color, e.g. #5865F2').setMaxLength(7)))
    .addSubcommand((s) =>
      s.setName('modifier').setDescription("Change the name, title, text, menu or color of a subpanel (\"none\" = clear)")
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption((o) => o.setName('nouveau-nom').setDescription('New name').setMaxLength(60))
        .addStringOption((o) => o.setName('titre').setDescription('Nouveau titre').setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Nouveau texte').setMaxLength(1000))
        .addStringOption((o) => o.setName('placeholder').setDescription('New menu text').setMaxLength(100))
        .addStringOption((o) => o.setName('couleur').setDescription('New hex color').setMaxLength(7)))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Delete a subpanel (it is removed from all categories)')
        .addStringOption(spCfg)
        .addStringOption(spSub))
    .addSubcommand((s) =>
      s.setName('choix-ajouter').setDescription('Add a choice to the subpanel menu')
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption((o) => o.setName('label').setDescription('Name of choice').setMaxLength(100).setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji: 🎮 or server emoji (type :nitro: and choose it)'))
        .addStringOption((o) => o.setName('description').setDescription('Description courte').setMaxLength(100))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('Server category where tickets of this choice will be created')
            .addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName('suivant').setDescription('Sub-panel proposed next ("none" = direct ticket)').setAutocomplete(true))
        .addRoleOption((o) => o.setName('role-staff').setDescription('Staff role specific to this choice')))
    .addSubcommand((s) =>
      s.setName('choix-modifier').setDescription("Edit a choice of a subpanel")
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption(spChoice)
        .addStringOption((o) => o.setName('nouveau-nom').setDescription('New name').setMaxLength(100))
        .addStringOption((o) => o.setName('emoji').setDescription('New emoji (“none” to remove it)'))
        .addStringOption((o) => o.setName('description').setDescription('New description ("none" for deleting it)').setMaxLength(100))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('New server category for tickets of this choice')
            .addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName('suivant').setDescription('Sub-panel proposed next ("none" = direct ticket)').setAutocomplete(true))
        .addRoleOption((o) => o.setName('role-staff').setDescription('New staff role for this choice')))
    .addSubcommand((s) =>
      s.setName('choix-retirer').setDescription("Remove a choice from a subpanel")
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption(spChoice))
    .addSubcommand((s) =>
      s.setName('choix-suivant').setDescription('Put the SAME next subpanel on ALL choices of one subpanel')
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption((o) => o.setName('suivant').setDescription('Sub-panel proposed after each choice (\"none\" = direct ticket)').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('lier').setDescription('Use a subpanel for all categories, or just one')
        .addStringOption(spCfg)
        .addStringOption(spSub)
        .addStringOption(spPour))
    .addSubcommand((s) =>
      s.setName('delier').setDescription("Remove the link from a category (it takes the default setting) or the default subpanel")
        .addStringOption(spCfg)
        .addStringOption(spPour))
    .addSubcommand((s) =>
      s.setName('liste').setDescription('See the subpanels and which categories they are linked to')
        .addStringOption(spCfg)),

  // ---------- Tickets ----------
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system management')
    .addSubcommand((s) =>
      s.setName('config-creer').setDescription('Create a ticket configuration')
        .addStringOption((o) =>
          o.setName('nom').setDescription('Name (letters, numbers, hyphens - 30 max)').setRequired(true))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('Category where tickets will be created (default)')
            .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addRoleOption((o) =>
          o.setName('role-staff').setDescription('First staff role (optional, add more with /ticket staff-ajouter)'))
        .addChannelOption((o) =>
          o.setName('salon-logs').setDescription('Channel where to send transcripts at closing')
            .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('config-liste').setDescription('List configurations'))
    .addSubcommand((s) =>
      s.setName('config-supprimer').setDescription('Delete a configuration')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('staff-ajouter').setDescription('Authorize a staff role to view and respond to tickets')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Staff role to add').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('staff-retirer').setDescription("Remove a staff role's access to tickets")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Staff role to be removed').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Add a member to the current ticket (to use in the ticket)')
        .addUserOption((o) => o.setName('membre').setDescription('Member to add to ticket').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription('Remove a member from the current ticket (to use in the ticket)')
        .addUserOption((o) => o.setName('membre').setDescription('Member to be removed from the ticket').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('raison-ajouter').setDescription("Add a category to the panel menu")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Category name (ex: Nitro)').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji: 🎮 or server emoji (type :nitro: and choose it)'))
        .addStringOption((o) => o.setName('description').setDescription('Description courte'))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('Server category where tickets of this choice will be created')
            .addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) =>
          o.setName('role-staff').setDescription('Staff role specific to this category (replaces those in the config)')))
    .addSubcommand((s) =>
      s.setName('raison-modifier').setDescription("Change the emoji, name, description, or server category of a choice")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Category to edit').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('New emoji (write “none” to remove it)'))
        .addStringOption((o) => o.setName('nouveau-nom').setDescription('New name').setMaxLength(100))
        .addStringOption((o) => o.setName('description').setDescription('Nouvelle description').setMaxLength(100))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('New server category where tickets of this choice will be created')
            .addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) =>
      s.setName('raison-retirer').setDescription('Remove a reason')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Reason to remove').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('message').setDescription("Edit the message sent when a ticket opens (per panel or for the entire config)")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) =>
          o.setName('panel').setDescription('Panel concerned (empty = all panels in the configuration)').setAutocomplete(true))
        .addBooleanOption((o) =>
          o.setName('reinitialiser').setDescription('Reset the message to default instead of modifying it')))
    .addSubcommand((s) =>
      s.setName('message-boutons').setDescription("Change the text of the ticket opening message buttons")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('panel').setDescription('Panel concerned (empty = all)').setAutocomplete(true))
        .addStringOption((o) => o.setName('prendre-en-charge').setDescription('Claim button text 🙋 (empty = default)').setMaxLength(80))
        .addStringOption((o) => o.setName('fermer').setDescription('Close button text 🔒 (empty = default)').setMaxLength(80)))
    .addSubcommand((s) =>
      s.setName('bouton').setDescription("Change the color or text of the button of a panel already sent")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) =>
          o.setName('panel').setDescription('Panel to edit').setAutocomplete(true).setRequired(true))
        .addStringOption((o) =>
          o.setName('couleur').setDescription('New button color').addChoices(...BTN_COLORS))
        .addStringOption((o) =>
          o.setName('texte').setDescription('New button text').setMaxLength(80)))
    .addSubcommand((s) =>
      s.setName('panel').setDescription('Send the ticket panel to a channel (then updated automatically)')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Channel where to post the panel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName('titre').setDescription('Panel title'))
        .addStringOption((o) => o.setName('description').setDescription('Panel text (@Pseudo, @Role, #channel and \\n accepted)'))
        .addStringOption((o) => o.setName('couleur').setDescription('Hex color, e.g. #ED4245'))
        .addAttachmentOption((o) => o.setName('image').setDescription('Large panel banner (file)'))
        .addStringOption((o) => o.setName('image-url').setDescription('Banner via link (if no file)'))
        .addAttachmentOption((o) => o.setName('miniature').setDescription('Small image at top right'))
        .addStringOption((o) => o.setName('miniature-url').setDescription('Logo at top right (link, if no file)'))
        .addStringOption((o) => o.setName('placeholder').setDescription('Menu text (eg: Choose a category...)').setMaxLength(100))
        .addStringOption((o) => o.setName('footer').setDescription('Pied de page (ex : YouGate)').setMaxLength(200))
        .addBooleanOption((o) => o.setName('sans-texte').setDescription("Panel with only the image and the button (obligatory image)"))
        .addBooleanOption((o) => o.setName('logo').setDescription('Show the server logo (default: yes)'))
        .addBooleanOption((o) => o.setName('stats').setDescription('Add a "Stats" button (tickets, vouches, average rating)'))
        .addBooleanOption((o) =>
          o.setName('traduction').setDescription('Automatic translation (any language → French + English) in tickets opened from this panel'))
        .addStringOption((o) =>
          o.setName('type').setDescription("Button, multiple buttons or drop-down menu (menu only if there are categories, ignored in DM mode)")
            .addChoices(
              { name: 'Button', value: 'bouton' },
              { name: 'Multiple buttons (one per category)', value: 'boutons' },
              { name: 'Drop-down menu', value: 'menu' },
            ))
        .addStringOption((o) => o.setName('bouton-texte').setDescription('Button text (default: Open ticket)').setMaxLength(80))
        .addStringOption((o) =>
          o.setName('couleur-bouton').setDescription('Button color (default: blue)').addChoices(...BTN_COLORS)))
    // ----- Couleur globale des panels -----
    .addSubcommand((s) =>
      s.setName('couleur').setDescription('Color applied to all server panels')
        .addStringOption((o) => o.setName('couleur').setDescription('Hex color, e.g. #5865F2').setRequired(true).setMaxLength(7))
        .addStringOption((o) => o.setName('config').setDescription('Only this configuration (empty = whole server)').setAutocomplete(true)))
    // ----- Vouch -----
    .addSubcommand((s) =>
      s.setName('vouch-salon').setDescription('Channel where to send reviews/vouch')
        .addChannelOption((o) => o.setName('salon').setDescription('Vouch channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((s) => s.setName('vouch-activer').setDescription('Enable the Vouch button in ticket opening messages'))
    .addSubcommand((s) => s.setName('vouch-desactiver').setDescription('Disable the Vouch button in ticket opening messages'))
    // ----- Traduction automatique (FR ⇄ EN) -----
    .addSubcommand((s) =>
      s.setName('traduction-activer').setDescription('Enable automatic translation FR ⇄ EN for configuration')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('traduction-desactiver').setDescription('Disable automatic translation FR ⇄ EN for configuration')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true)))
    // ----- Suivi des ventes -----
    .addSubcommand((s) =>
      s.setName('ventes-salon').setDescription('Channel where the sales tracking panel is sent')
        .addChannelOption((o) => o.setName('salon').setDescription('Sales tracking channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((s) => s.setName('ventes-panel').setDescription('Create/refresh the sales monitoring panel'))
    .addSubcommand((s) =>
      s.setName('ventes-devise').setDescription('Currency displayed in sales tracking')
        .addStringOption((o) => o.setName('devise').setDescription('Ex : €, $, CHF…').setRequired(true).setMaxLength(8)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Ajouter / retirer un membre d'un ticket ----------
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a member to the current ticket')
    .addUserOption((o) => o.setName('membre').setDescription('Member to add to the ticket').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a member from the current ticket')
    .addUserOption((o) => o.setName('membre').setDescription('Member to remove from the ticket').setRequired(true))
    .setDMPermission(false),
];

/* ------------------------------------------------------------------ */
/*  Compteur de membres                                                */
/* ------------------------------------------------------------------ */
async function updateCount(guild) {
  const d = getG(guild.id);
  if (!d.memberCountChannel) return;
  const ch = guild.channels.cache.get(d.memberCountChannel);
  if (!ch) { d.memberCountChannel = null; save(); return; }
  const name = d.memberCountFormat.replace('{count}', guild.memberCount).slice(0, 100);
  if (ch.name !== name) await ch.setName(name).catch(console.error);
}

const timers = new Map(); // anti-spam : Discord limite le renommage de salons
function scheduleCount(guild) {
  if (timers.has(guild.id)) return;
  timers.set(guild.id, setTimeout(() => { timers.delete(guild.id); updateCount(guild); }, 30_000));
}

/* ------------------------------------------------------------------ */
/*  Bienvenue                                                          */
/* ------------------------------------------------------------------ */
async function buildWelcome(member) {
  const w = getG(member.guild.id).welcome;
  const embed = new EmbedBuilder()
    .setColor(parseColor(w.color))
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();
  // @Pseudo / @Rôle / #salon écrits à la main deviennent de vraies mentions cliquables
  const title = fmt(w.title, member);
  const desc = (await rich(member.guild, fmt(w.description, member))).text;
  if (title) embed.setTitle(title.slice(0, 256));
  if (desc) embed.setDescription(desc.slice(0, 4096));
  if (isUrl(w.image)) embed.setImage(w.image.trim());

  const hasEmbed = title || desc || isUrl(w.image);
  let content = (await rich(member.guild, fmt(w.content, member))).text;
  if (!content && !hasEmbed) content = `<@${member.id}>`;
  return {
    content: content || undefined,
    embeds: hasEmbed ? [embed] : [],
    allowedMentions: { parse: ['users', 'roles'] },
  };
}

/* ------------------------------------------------------------------ */
/*  Mute (rôle "Muté" : le membre voit le serveur mais aucun salon)    */
/* ------------------------------------------------------------------ */
const UNITS = { minutes: 60_000, heures: 3_600_000, jours: 86_400_000 };
const MAX_MUTE = 365 * 86_400_000;

// Interdit "Voir le salon" au rôle Muté dans tous les salons qui n'ont pas encore la règle
async function syncMuteOverwrites(guild, role) {
  for (const ch of guild.channels.cache.values()) {
    if (!ch.permissionOverwrites) continue;
    if (ch.permissionOverwrites.cache.get(role.id)?.deny.has(PermissionFlagsBits.ViewChannel)) continue;
    await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Configuring the Transferred role' }).catch(() => {});
  }
}

async function ensureMutedRole(guild) {
  const d = getG(guild.id);
  let role = d.muteRoleId ? guild.roles.cache.get(d.muteRoleId) : null;
  if (!role) {
    role = await guild.roles.create({
      name: 'Mutated',
      color: 0x808080,
      permissions: [],
      reason: 'Role used by the mute system',
    });
    d.muteRoleId = role.id;
    save();
  }
  await syncMuteOverwrites(guild, role);
  return role;
}

async function applyMute(guild, member, until, reason, by) {
  const d = getG(guild.id);
  const role = await ensureMutedRole(guild);
  const rec = d.muted[member.id];

  // Les rôles que je ne peux pas retirer (rôles de bot, boost, rôles trop hauts) sont conservés
  const keep = [];
  const removed = [];
  for (const r of member.roles.cache.values()) {
    if (r.id === guild.id || r.id === role.id) continue;
    (r.managed || !r.editable ? keep : removed).push(r.id);
  }

  // On retire tous les autres rôles : sinon un rôle avec "Administrateur" ou une règle de salon
  // autorisant la vue permettrait de continuer à voir les salons.
  await member.roles.set([...keep, role.id], `Mute : ${reason}`);

  d.muted[member.id] = {
    roles: [...new Set([...(rec?.roles || []), ...removed])],
    until,
    reason,
    by,
  };
  save();

  if (member.voice.channel) await member.voice.disconnect('Mute').catch(() => {});
}

async function removeMute(guild, userId, reason) {
  const d = getG(guild.id);
  const rec = d.muted[userId];
  if (!rec) return false;
  delete d.muted[userId];
  save();

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return true; // parti du serveur : rien à restaurer

  const restorable = rec.roles.filter((id) => {
    const r = guild.roles.cache.get(id);
    return r && !r.managed && r.editable;
  });
  const final = new Set([...member.roles.cache.keys()].filter((id) => id !== d.muteRoleId && id !== guild.id));
  restorable.forEach((id) => final.add(id));
  await member.roles.set([...final], reason).catch(console.error);
  return true;
}

// Vérifie régulièrement les mutes terminés (fonctionne même après un redémarrage du bot)
async function checkMutes() {
  for (const guild of client.guilds.cache.values()) {
    const d = getG(guild.id);
    for (const [userId, rec] of Object.entries(d.muted)) {
      if (rec.until <= Date.now()) await removeMute(guild, userId, 'Mute Completed').catch(console.error);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Tickets                                                            */
/* ------------------------------------------------------------------ */
// En mode MP (cfg.dm), le panel est toujours un bouton : le menu déroulant est envoyé en message privé.
const panelDesc = (cfg, button = false) => cfg.reasons.length && !button && !cfg.dm
  ? 'Select the category of your request in the menu below to open a ticket.'
  : 'Click the button below to open a ticket.';

// Discord limits: 25 options per select menu and 5 rows per message (125 categories max).
// We use one select menu per row so a panel can hold up to 125 categories.
const MENU_CHUNK = 25;
const chunkList = (list, n = MENU_CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

// Bouton « Stats » ajouté aux panels de ticket (nombre de tickets, vouchs, note moyenne).
function statsRow(cfg) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tk_stats:${cfg.name}`)
      .setLabel('Stats')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Returns the component rows of a panel: a button, or one/more select menus with the categories.
function panelRows(cfg, { button = false, label = null, style = 'Primary', stats = false } = {}) {
  if (!cfg.reasons.length || button || cfg.dm) {
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tk_open:${cfg.name}`).setLabel(label || 'Open a ticket').setEmoji('🎫').setStyle(btnStyle(style)))];
    if (stats) rows.push(statsRow(cfg));
    return rows;
  }
  const rows = chunkList(cfg.reasons).slice(0, 5).map((part, n) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`tk_open:${cfg.name}:${n}`)
      .setPlaceholder((cfg.placeholder || 'Choose a category...').slice(0, 150))
      .addOptions(part.map((r) => {
        const o = { label: String(r.label).slice(0, 100), value: r.id };
        const d = reasonDesc(r);
        if (d) o.description = String(d).slice(0, 100);
        const e = parseEmoji(r.emoji);
        if (e) o.emoji = e;
        return o;
      }))));
  if (stats && rows.length < 5) rows.push(statsRow(cfg));
  return rows;
}

// Panels « plusieurs boutons » : un bouton par catégorie, chacun ouvrant son propre sous-panel.
const HAS_V2 = !!(ContainerBuilder && SectionBuilder && TextDisplayBuilder && SeparatorBuilder &&
  MediaGalleryBuilder && MediaGalleryItemBuilder && ThumbnailBuilder && MessageFlags?.IsComponentsV2);

// Nombre de sections affichables sans dépasser 40 composants (limite Discord en V2).
function multiLimit(p, imageUrl, thumb, desc) {
  if (!HAS_V2 || p.v2 === false) return 25;
  let used = 2; // container + séparateur final
  if (imageUrl) used += 2; // galerie + image
  if (!p.noText) {
    used += 1; // section du titre
    used += thumb ? 2 : 1; // texte du titre + miniature
    if (desc) used += 1;
  }
  if (p.footer) used += 1;
  return Math.max(1, Math.min(25, Math.floor((40 - used) / 4)));
}

// Description affichée pour une catégorie : le prix remplace [prix] / {prix}.
// Permet d'écrire « [prix] » (ou de cliquer sur le bouton du dashboard) pour afficher le prix.
function reasonDesc(r) {
  const price = String(r?.price ?? '').trim();
  return String(r?.description ?? '')
    .replaceAll('[prix]', price).replaceAll('[price]', price)
    .replaceAll('{prix}', price).replaceAll('{price}', price);
}

function reasonSectionText(r) {
  if (r.panelText && String(r.panelText).trim()) return String(r.panelText).trim().slice(0, 250);
  const desc = reasonDesc(r);
  return `**${String(r.label || '').slice(0, 100)}**${desc ? `\n${desc.slice(0, 150)}` : ''}`;
}

function reasonButton(cfg, r, style) {
  const b = new ButtonBuilder()
    .setCustomId(`tk_open:${cfg.name}:${r.id}`)
    .setLabel(String(r.label || 'Open').slice(0, 80))
    .setStyle(btnStyle(style));
  const e = parseEmoji(r.emoji);
  if (e) b.setEmoji(e);
  return b;
}

// Construit le panel multi-boutons. Avec discord.js récent : container V2 (bouton à droite de chaque texte).
// Sinon : embed classique + boutons sous le texte.
async function buildMultiPanel(guild, cfg, p, { image = null, files = null } = {}) {
  const d = getG(guild.id);
  const color = parseColor(p.color || cfg.color || d.panelColor, '#ED4245');
  const title = (p.title || `🎫 Support — ${cfg.name}`).slice(0, 256);
  const desc = (p.customDesc ? (p.desc || '') : '').slice(0, 1500);
  const outFiles = [...(files || [])];
  const imageUrl = await imageRef(image || p.image, 'banner', outFiles);
  const thumb = await imageRef(logoSource(cfg, d, p), 'logo', outFiles);
  const reasons = (cfg.reasons || []).slice(0, multiLimit(p, imageUrl, thumb, desc));

  if (HAS_V2 && p.v2 !== false) {
    const container = new ContainerBuilder().setAccentColor(parseInt(color.slice(1), 16) || 0x5865F2);
    if (imageUrl) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl)),
      );
    }
    if (!p.noText) {
      const titleText = new TextDisplayBuilder().setContent(`## ${title}`);
      if (thumb) {
        container.addSectionComponents(
          new SectionBuilder().addTextDisplayComponents(titleText).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
        );
      } else {
        container.addTextDisplayComponents(titleText);
      }
      if (desc) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(desc));
    }
    for (const r of reasons) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(reasonSectionText(r)))
          .setButtonAccessory(reasonButton(cfg, r, p.btnStyle)),
      );
    }
    if (p.footer) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${String(p.footer).slice(0, 2000)}`));
    if (p.statsButton) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('**Server stats** — tickets, vouches and average rating'))
          .setButtonAccessory(statsRow(cfg).components[0]),
      );
    }
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    const payload = { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
    if (outFiles.length) payload.files = outFiles;
    return payload;
  }

  // Repli (ancienne version de discord.js) : embed classique + boutons sous le texte.
  const embed = new EmbedBuilder().setColor(color).setTimestamp();
  if (!p.noText) embed.setTitle(title).setDescription(desc || null);
  if (imageUrl) embed.setImage(imageUrl);
  if (thumb) embed.setThumbnail(thumb);
  if (p.footer) embed.setFooter({ text: String(p.footer).slice(0, 2048) });
  for (const r of reasons) {
    embed.addFields({
      name: String(r.label).slice(0, 256),
      value: String(r.panelText || r.description || 'Click the button below.').slice(0, 1024),
      inline: false,
    });
  }
  const rows = chunkList(reasons, 5).slice(0, 5).map((part) =>
    new ActionRowBuilder().addComponents(part.map((r) => reasonButton(cfg, r, p.btnStyle))));
  if (p.statsButton && rows.length < 5) rows.push(statsRow(cfg));
  const payload = { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
  if (outFiles.length) payload.files = outFiles;
  return payload;
}

// Construit un panel à bouton / menu déroulant (utilisé pour l'envoi et la mise à jour directe).
async function buildSinglePanel(guild, cfg, p) {
  const d = getG(guild.id);
  const files = [];
  const color = parseColor(p.color, cfg.color || d.panelColor || '#ED4245');
  const embed = new EmbedBuilder().setColor(color);
  if (!p.noText) {
    embed
      .setTitle((p.title || `🎫 Support — ${cfg.name}`).slice(0, 256))
      .setDescription((p.desc || panelDesc(cfg, p.button)).slice(0, 4096))
      .setTimestamp();
    if (p.footer) embed.setFooter({ text: String(p.footer).slice(0, 2048) });
  }
  const image = await imageRef(p.image, 'panel', files);
  if (image) embed.setImage(image);
  const logo = p.showLogo === false ? null : await imageRef(logoSource(cfg, d, p), 'logo', files);
  if (logo) embed.setThumbnail(logo);
  const rows = panelRows(cfg, { button: p.button, label: p.btnLabel, style: p.btnStyle, stats: !!p.statsButton });
  const payload = { embeds: [embed], components: rows };
  if (files.length) payload.files = files;
  return payload;
}

function multiPanelSig(guild, cfg, p) {
  const d = getG(guild.id);
  const desc = (p.customDesc ? (p.desc || '') : '').slice(0, 1500);
  const imageUrl = (isMedia(p.image) || isDataImage(p.image)) ? 'x' : null;
  const logo = logoSource(cfg, d, p);
  return sig({
    v2: p.v2 !== false && HAS_V2,
    color: parseColor(p.color || cfg.color || d.panelColor, '#ED4245'),
    title: p.title || '', desc,
    image: srcHash(p.image), logo: srcHash(logo), showLogo: p.showLogo !== false, style: p.btnStyle || 'Primary',
    noText: !!p.noText, footer: p.footer || null, stats: !!p.statsButton,
    reasons: (cfg.reasons || []).slice(0, multiLimit(p, imageUrl, logo ? 'x' : null, desc)).map((r) => [r.id, r.label, r.description || '', r.panelText || '', r.emoji || '']),
  });
}

// Met à jour tous les panels déjà envoyés (catégories ajoutées / modifiées / retirées, nouveau code du bot...)
async function refreshPanels(guild, cfgName) {
  const d = getG(guild.id);
  const names = cfgName ? [cfgName] : Object.keys(d.tickets);
  for (const n of names) {
    const cfg = d.tickets[n];
    if (!cfg) continue;
    for (const p of [...cfg.panels]) {
      const { msg, gone } = await fetchMsg(guild, p.channelId, p.messageId);
      if (gone) { cfg.panels = cfg.panels.filter((x) => x !== p); save(); continue; }
      if (!msg) continue;

      // Panel multi-boutons : on reconstruit tout le message (texte + un bouton par catégorie).
      if (p.multi) {
        const s = multiPanelSig(guild, cfg, p);
        if (p.sig === s) continue;
        try {
          const payload = await buildMultiPanel(guild, cfg, p);
          // Bannière / logo envoyés en fichier : on réutilise les pièces jointes du message
          // pour que les références attachment://... restent valides après la modification.
          const have = new Set((payload.files || []).map((f) => f.name));
          const keep = [...msg.attachments.values()].filter((a) => !have.has(a.name));
          if (keep.length) payload.files = [...(payload.files || []), ...keep];
          await msg.edit(payload);
          p.sig = s;
          save();
        } catch (e) {
          console.error('[panel]', e.message);
        }
        continue;
      }

      const rows = panelRows(cfg, { button: p.button, label: p.btnLabel, style: p.btnStyle, stats: !!p.statsButton });
      const desc = p.customDesc ? null : panelDesc(cfg, p.button);
      // Couleur globale (ou couleur propre à la configuration) appliquée à tous les panels
      const color = parseColor(cfg.color || d.panelColor, '#ED4245');
      // Logo : celui du panel, sinon celui de la configuration, sinon le logo global du serveur
      const logo = logoSource(cfg, d, p);
      const s = sig({ rows: rows.map((r) => r.toJSON()), desc, color, logo: srcHash(logo) });
      if (p.sig === s) continue;

      const payload = { components: rows };
      const files = [];
      const logoRef = await imageRef(logo, 'logo', files);
      if (msg.embeds[0]) {
        const e = EmbedBuilder.from(msg.embeds[0]).setColor(color);
        if (desc && msg.embeds[0].description !== desc) e.setDescription(desc);
        if (logoRef) {
          if (msg.embeds[0].thumbnail?.url !== logoRef) e.setThumbnail(logoRef);
        } else if (msg.embeds[0].thumbnail) {
          e.setThumbnail(null);
        }
        payload.embeds = [e];
      }
      if (files.length || logoRef?.startsWith('attachment://')) {
        const have = new Set(files.map((f) => f.name));
        const keep = [...msg.attachments.values()].filter((a) => !have.has(a.name));
        if (files.length || keep.length) payload.files = [...files, ...keep];
      }
      try {
        await msg.edit(payload);
        p.sig = s;
        save();
      } catch (e) {
        console.error('[panel]', e.message);
      }
    }
  }
}

// Message envoyé dans le salon du ticket à son ouverture.
// Priorité (le plus précis gagne) : dernier choix de sous-panel > catégorie du menu > panel > configuration > message par défaut.
// Tout se règle depuis le panel web (« Message d'ouverture du ticket ») ou avec /ticket message.
// Variables: {user} {username} {server} {category} {sub} {sub1} {sub2} {sub3} {config} {staff} {number} {paiement} {prix} {order}
function pickOpenMsg(cfg, panel, reason, subs = []) {
  // Message propre de l'élément, sinon le modèle auquel il est relié (openMsgId)
  const own = (x) => (x?.openMsg && Object.keys(x.openMsg).length ? x.openMsg : x?.openMsgId ? cfg.openPresets?.find((p) => p.id === x.openMsgId)?.openMsg : null);
  const chain = [...[...subs].reverse().map(own), own(reason), own(panel), own(cfg)];
  return chain.find((m) => m && Object.keys(m).length) || {};
}
async function buildOpenMessage(guild, user, cfg, panel, reason, staffRoles, subs = []) {
  const m = pickOpenMsg(cfg, panel, reason, subs);
  const staffMention = staffRoles.map((r) => `<@&${r}>`).join(' ');
  // Mode de paiement = le choix fait dans un sous-panel marqué « paiement » (variable {paiement})
  const payChoice = subs.find((c) => cfg.subPanels?.some((sp) => sp.payment && sp.choices.some((x) => x === c || x.id === c.id)));
  const pay = payChoice?.label || 'Not specified';
  // Prix = description du dernier choix d'article (hors choix du sous-panel de paiement),
  // sinon le prix de la catégorie (dashboard), sinon sa description (variable {prix} / [prix])
  const prix = [...subs].reverse().find((c) => c !== payChoice && c?.description?.trim())?.description.trim()
    || String(reason?.price ?? '').trim() || reason?.description?.trim() || 'Not specified';
  // Commande = ce qui a été choisi AVANT le moyen de paiement (variable {order} / {commande} / {article})
  const order = subs.filter((c) => c !== payChoice).map((c) => c.label).join(' › ') || reason?.label || 'Not specified';
  const vars = (txt) => {
    let t = String(txt ?? '')
      .replaceAll('{user}', `<@${user.id}>`)
      .replaceAll('{username}', user.username)
      .replaceAll('{server}', guild.name)
      .replaceAll('{category}', reason ? reason.label : 'Not specified')
      .replaceAll('{sub}', subs.map((c) => c.label).join(' › '))
      .replaceAll('{config}', cfg.name)
      .replaceAll('{number}', String(cfg.counter || 0).padStart(4, '0'))
      .replaceAll('{paiement}', pay).replaceAll('{payement}', pay).replaceAll('{payment}', pay)
      .replaceAll('{prix}', prix).replaceAll('{price}', prix)
      .replaceAll('[prix]', prix).replaceAll('[price]', prix)
      .replaceAll('{order}', order).replaceAll('{commande}', order).replaceAll('{article}', order)
      .replaceAll('{staff}', staffMention);
    for (let n = 0; n < 3; n++) t = t.replaceAll(`{sub${n + 1}}`, subs[n]?.label || '');
    return t;
  };

  const rc = m.content ? await rich(guild, vars(m.content)) : null;
  const rd = m.description ? await rich(guild, vars(m.description)) : null;
  const hasFields = Array.isArray(m.fields) && m.fields.some((f) => f && (f.name || f.value));
  // Les champs personnalisés remplacent le texte d'intro par défaut (les 2 lignes « Hello… / Explain… »).
  const defaultDesc = `Hello <@${user.id}>, a member of the staff will respond to you soon.\n` +
    `Explain your request to us in as much detail as possible.`;
  const descText = rd ? rd.text : (m.noDefaultDesc || hasFields ? '' : defaultDesc);
  const showInfo = typeof m.showInfo === 'boolean' ? m.showInfo : (!rd && !hasFields); // champs Configuration / Catégorie / Sous-panel

  const embed = new EmbedBuilder()
    .setColor(parseColor(m.color, cfg.color || getG(guild.id).panelColor || '#5865F2'))
    .setTitle((m.title ? vars(m.title) : `🎫 Ticket — ${[reason?.label, ...subs.map((c) => c.label)].filter(Boolean).join(' › ') || cfg.name}`).slice(0, 256))
    .setDescription(descText ? descText.slice(0, 4096) : null);
  if (m.timestamp !== false) embed.setTimestamp();
  if (m.footer) embed.setFooter({ text: vars(m.footer).slice(0, 2048) });
  if (showInfo) {
    // Noms des lignes modifiables depuis le dashboard (les valeurs restent automatiques).
    const infoName = (key, def) => {
      const v = m.infoLabels && typeof m.infoLabels[key] === 'string' ? m.infoLabels[key].trim() : '';
      return (v || def).slice(0, 256);
    };
    embed.addFields(
      { name: infoName('config', 'Configuration'), value: cfg.name, inline: true },
      { name: infoName('category', 'Category'), value: reason ? reason.label : 'Not specified', inline: true },
      ...(subs.length ? [{ name: infoName('sub', 'Sub-panel'), value: subs.map((c) => c.label).join(' › ').slice(0, 1024), inline: true }] : []),
      ...(payChoice ? [{ name: infoName('payment', 'Payment'), value: pay.slice(0, 1024), inline: true }] : []),
    );
  }
  for (const f of (Array.isArray(m.fields) ? m.fields : []).slice(0, 10)) { // champs personnalisés
    const name = vars(f?.name).slice(0, 256), value = vars(f?.value).slice(0, 1024);
    // inline: true = à côté des autres (3 par ligne) ; false = nom au-dessus, valeur en dessous.
    if (name && value) embed.addFields({ name, value, inline: !!f.inline });
  }
  const files = [];
  const imgRef = await imageRef(m.image, 'image', files);
  if (imgRef) embed.setImage(imgRef);
  const thumbRef = await imageRef(m.thumbnail, 'thumbnail', files);
  if (thumbRef) embed.setThumbnail(thumbRef);

  return {
    content: (rc ? rc.text : `<@${user.id}> ${staffMention}`).slice(0, 2000) || undefined,
    embeds: [embed],
    files,
    allowedMentions: {
      users: [...new Set([user.id, ...(rc?.users || [])])].slice(0, 100),
      roles: [...new Set([...staffRoles, ...(rc?.roles || [])])].slice(0, 100),
    },
  };
}

// Nom du salon d'un ticket. Modèle configurable depuis le dashboard :
// {user} {username} {displayname} {category} {sub} {config} {number} {prix}/[prix] {staff}
// Sans modèle : « ❌-catégorie » (comportement historique).
function ticketChannelName(cfg, reason, subs, user) {
  const price = String(reason?.price ?? '').trim()
    || String([...subs].reverse().find((c) => c?.description?.trim())?.description || '').trim();
  const fill = (tpl) => String(tpl ?? '')
    .replaceAll('{user}', user.username)
    .replaceAll('{username}', user.username)
    .replaceAll('{displayname}', user.displayName || user.username)
    .replaceAll('{category}', reason?.label || cfg.name)
    .replaceAll('{sub}', subs.length ? subs[subs.length - 1].label : '')
    .replaceAll('{config}', cfg.name)
    .replaceAll('{number}', String(cfg.counter || 0).padStart(4, '0'))
    .replaceAll('{prix}', price).replaceAll('{price}', price)
    .replaceAll('[prix]', price).replaceAll('[price]', price)
    .replaceAll('{staff}', '');
  const tpl = String(reason?.nameTemplate || cfg.nameTemplate || '').trim();
  let name;
  if (tpl) {
    name = fill(tpl).toLowerCase().replace(/\s+/g, '-')
      .replace(/[#@:/\\<>|?*"`]/g, '').replace(/-+/g, '-');
  } else {
    name = `❌-${String(subs.length ? subs[subs.length - 1].label : (reason?.label || cfg.name))
      .toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-')}`;
  }
  return (name.replace(/^-+|-+$/g, '') || 'ticket').slice(0, 100);
}

// Création du salon du ticket (utilisée par le mode normal ET par le mode MP).
// Un membre peut ouvrir autant de tickets qu'il veut (chaque salon a son numéro).
// Le choix (reasonId) est cherché dans le menu du panel ET dans le menu du MP.
// Renvoie { channel } ou { error }.
async function createTicket(guild, user, cfgName, reasonId, panel, subPath = null) {
  const subs = Array.isArray(subPath) ? subPath : subPath ? [subPath] : []; // choix successifs dans les sous-panels
  const data = getG(guild.id);
  const cfg = data.tickets[cfgName];
  if (!cfg) return { error: "❌ This configuration no longer exists." };

  const reason = [...cfg.reasons, ...(cfg.dmChoices || [])].find((r) => r.id === reasonId);

  // Rôles staff : ceux du choix (s'il y en a un) sinon ceux de la configuration.
  // Un choix peut stocker plusieurs rôles (staffRoles) ou un seul (staffRoleId, anciennes données).
  // Priorité : rôle du choix du sous-panel > rôle de la catégorie du menu > rôles de la configuration.
  const staffOf = (o) => {
    const list = Array.isArray(o?.staffRoles) ? o.staffRoles : [];
    return list.length ? list : (o?.staffRoleId ? [o.staffRoleId] : []);
  };
  const ownStaff = [...subs].reverse().map(staffOf).find((a) => a.length) || staffOf(reason);
  const staffRoles = (ownStaff.length ? ownStaff : (cfg.staffRoles || []))
    .filter((id) => guild.roles.cache.has(id));
  // « all » : le membre doit posséder TOUS les rôles staff de la catégorie pour voir le ticket.
  // « any » (défaut) : un seul de ces rôles suffit (comportement historique).
  const staffMode = [...subs].reverse().map((c) => c.staffMode).find(Boolean) || reason?.staffMode || cfg.staffMode || 'any';
  const requireAll = staffMode === 'all' && staffRoles.length > 1;

  // Catégorie du serveur liée au choix du menu (sinon celle de la configuration)
  // Priorité : catégorie du choix du sous-panel > catégorie du menu > catégorie de la configuration
  const parentId = [...[...subs].reverse().map((c) => c.categoryId), reason?.categoryId].find((id) => id && guild.channels.cache.has(id)) || cfg.categoryId;

  cfg.counter = (cfg.counter || 0) + 1;
  save();

  const P = PermissionFlagsBits;
  const staffAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageMessages];
  // En mode « tous les rôles », on n'ouvre pas le salon aux rôles (sinon un rôle suffirait) :
  // seuls les membres qui possèdent tous les rôles reçoivent une autorisation nominative.
  const staffOverwrites = requireAll
    ? guild.members.cache
      .filter((m) => m.id !== user.id && m.id !== client.user.id && staffRoles.every((id) => m.roles.cache.has(id)))
      .map((m) => ({ id: m.id, allow: staffAllow }))
    : staffRoles.map((id) => ({ id, allow: staffAllow }));
  let channel;
  try {
    channel = await guild.channels.create({
      // Nom : ❌ (pas encore pris en charge, devient ✅ à la prise en charge) + dernier choix fait
      // (dernier sous-panel, sinon catégorie du panel, sinon config) — ou modèle personnalisé du dashboard.
      name: ticketChannelName(cfg, reason, subs, user),
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `Ticket de ${user.tag} | ${cfg.name}${reason ? ' | ' + reason.label : ''}${subs.length ? ' | ' + subs.map((c) => c.label).join(' › ') : ''}`,
      permissionOverwrites: [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
        ...staffOverwrites,
        { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels] },
      ],
    });
  } catch (e) {
    console.error('[ticket]', e);
    return { error: '❌ Unable to create ticket (category full or missing permissions). Notify an administrator.' };
  }

  data.open[channel.id] = {
    userId: user.id, config: cfgName, reason: [reason?.label, ...subs.map((c) => c.label)].filter(Boolean).join(' › ') || null, claimedBy: null, staffRoles,
    staffMode: requireAll ? 'all' : 'any',
    extraUsers: [],
    translate: panel ? !!panel.translate : !!cfg.translate,
  };
  save();

  const payload = await buildOpenMessage(guild, user, cfg, panel, reason, staffRoles, subs);
  const om = pickOpenMsg(cfg, panel, reason, subs);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk_claim').setLabel((om.claimLabel || 'Claim').slice(0, 80)).setEmoji(parseEmoji(om.claimEmoji) || '🙋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tk_close').setLabel((om.closeLabel || 'Fermer').slice(0, 80)).setEmoji(parseEmoji(om.closeEmoji) || '🔒').setStyle(ButtonStyle.Danger),
  );
  const rows = [row];
  // Bouton « Vouch » dans le message d'ouverture (activé dans le dashboard).
  if (cfg.vouchButton && data.vouch?.enabled !== false && data.vouch?.channelId) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tk_vouch').setLabel((om.vouchLabel || 'Vouch').slice(0, 80)).setEmoji('⭐').setStyle(ButtonStyle.Success),
    ));
  }
  await channel.send({ ...payload, components: rows }).catch(console.error);
  return { channel };
}

/* ---------- Ouverture de ticket par message privé ---------- */
// Clic sur le panel -> MP avec image + menu déroulant -> choix -> le MP est supprimé
// -> nouveau MP qui dit d'aller dans le salon du ticket (mentionné).
// Chaque MP ne sert qu'UNE fois. Un nouveau clic sur le panel remplace l'ancien MP.
// Tout se règle avec : /ticket mp-choix-ajouter · mp-menu · mp-textes · mp-activer
const IMG_DIR = path.join(path.dirname(DB_FILE), 'images');

// Textes par défaut (tous modifiables avec /ticket mp-menu et /ticket mp-textes)
// Variables: {user} {username} {server} {config} — et dans le message final : {channel} {link} {choice}
const DM_DEFAULT = {
  title: '🎫 Open a ticket — {server}',
  description: 'Choose the category of your request from the menu below.',
  sentReply: "📩 I sent you a private message: choose your category there to open your ticket.",
  doneTitle: '✅ Your ticket is open',
  doneText: 'Go to {channel} to continue your request.',
  invalid: "❌ This menu is no longer valid. Click again on the server panel to get a new one.",
};
const dmText = (cfg, k) => cfg.dmTexts?.[k] || DM_DEFAULT[k];
const dmVars = (txt, { guild, user, cfg, channel, choice }) =>
  String(txt ?? '')
    .replaceAll('\\n', '\n')
    .replaceAll('{user}', user.username)
    .replaceAll('{username}', user.username)
    .replaceAll('{server}', guild.name)
    .replaceAll('{config}', cfg.name)
    .replaceAll('{choice}', choice?.label || '')
    .replaceAll('{category}', choice?.label || '')
    .replaceAll('{channel}', channel ? `<#${channel.id}>` : '')
    .replaceAll('{link}', channel ? channel.url : '');

// ----- Image du MP (enregistrée sur le disque : les liens Discord expirent) -----
const dmImagePath = (cfg) => {
  if (!cfg.dmImage) return null;
  const p = path.join(IMG_DIR, cfg.dmImage);
  // Fichier disparu (redéploiement) : on le recrée depuis la copie gardée dans les données
  if (!fs.existsSync(p) && cfg.dmImageData) {
    try { fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(p, Buffer.from(cfg.dmImageData, 'base64')); } catch { /* rien */ }
  }
  return p;
};

function removeDmImage(cfg) {
  const p = dmImagePath(cfg);
  if (p) { try { fs.rmSync(p, { force: true }); } catch { /* rien */ } }
  cfg.dmImage = null;
  cfg.dmImageData = null;
}

async function saveDmImage(guildId, cfg, att) {
  if (!att.contentType?.startsWith('image/')) throw new Error("this file is not an image");
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Unable to download (${res.status})`);
  const ext = (att.name || '').match(/\.(png|jpe?g|gif|webp)$/i)?.[0]?.toLowerCase() || '.png';
  const file = `${guildId}-${cfg.name}-mp${ext}`;
  removeDmImage(cfg);
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(IMG_DIR, file), buf);
  cfg.dmImage = file;
  cfg.dmImageData = buf.length <= 3 * 1024 * 1024 ? buf.toString('base64') : null; // copie dans les données (≤ 3 Mo)
}

// Message + menu envoyés en MP
function buildDmMessage(guild, user, cfg) {
  const ctx = { guild, user, cfg };
  const embed = new EmbedBuilder()
    .setColor(parseColor(cfg.dmTexts?.color, '#5865F2'))
    .setTitle(dmVars(dmText(cfg, 'title'), ctx).slice(0, 256))
    .setDescription(dmVars(dmText(cfg, 'description'), ctx).slice(0, 4096))
    .setTimestamp();

  const files = [];
  const p = dmImagePath(cfg);
  if (p && fs.existsSync(p)) {
    const name = 'image' + path.extname(p);
    files.push(new AttachmentBuilder(p, { name }));
    embed.setImage(`attachment://${name}`);
  }

  const components = [];
  if (cfg.dmChoices.length) {
    for (const [n, part] of chunkList(cfg.dmChoices).slice(0, 5).entries()) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`tk_dm:${cfg.name}:${guild.id}:${n}`)
          .setPlaceholder((cfg.dmTexts?.placeholder || 'Choose a category...').slice(0, 150))
          .addOptions(part.map((r) => {
            const o = { label: String(r.label).slice(0, 100), value: r.id };
            if (r.description) o.description = String(r.description).slice(0, 100);
            const e = parseEmoji(r.emoji);
            if (e) o.emoji = e;
            return o;
          }))));
    }
  }
  return { embeds: [embed], files, components };
}

// Supprime un ancien MP de menu
async function deleteDm(user, p) {
  try {
    const ch = await user.createDM();
    const msg = await ch.messages.fetch(p.messageId);
    await msg.delete();
  } catch { /* déjà supprimé */ }
}

async function startDmFlow(i, cfg, panel) {
  const data = getG(i.guildId);
  if (!cfg.dmChoices.length) {
    return i.editReply("❌ No choices are configured for this ticket. Notify an administrator.");
  }
  const ctx = { guild: i.guild, user: i.user, cfg };

  // Un seul menu actif par membre et par configuration : le nouveau remplace l'ancien
  const key = `${i.user.id}:${cfg.name}`;
  const old = data.pendingDm[key];
  if (old) { delete data.pendingDm[key]; await deleteDm(i.user, old); }

  let dm;
  try {
    dm = await i.user.send(buildDmMessage(i.guild, i.user, cfg));
  } catch {
    return i.editReply("❌ I can't send you a PM. Enable private messages from members of this server, then try again.");
  }
  data.pendingDm[key] = { messageId: dm.id, channelId: dm.channelId, panelId: panel?.messageId || null };
  save();
  await i.editReply(dmVars(dmText(cfg, 'sentReply'), ctx).slice(0, 2000));
}

/* ---------- Sous-panels ---------- */
// Un sous-panel = un 2e menu proposé après le choix d'une catégorie du panel (ou du MP).
// Réglage par catégorie (cfg.subLinks) > sous-panel par défaut de la configuration (cfg.defaultSubPanelId) > aucun.
function resolveSub(cfg, entryId) {
  const link = entryId ? cfg.subLinks?.[entryId] : null;
  if (link === 'none') return null;
  const byId = (id) => cfg.subPanels?.find((x) => x.id === id);
  const sub = (link && byId(link)) || byId(cfg.defaultSubPanelId);
  return sub && sub.choices.length ? sub : null; // un sous-panel vide est ignoré : le ticket s'ouvre directement
}
const findSub = (cfg, v) => {
  const t = String(v ?? '').trim().toLowerCase();
  return (cfg.subPanels || []).find((x) => x.id === v || x.name.toLowerCase() === t) || null;
};
const findChoice = (sub, v) => {
  const t = String(v ?? '').trim().toLowerCase();
  return sub.choices.find((c) => c.id === v || c.label.toLowerCase() === t) || null;
};
// Catégories auxquelles on peut relier un sous-panel : menu du panel + choix du menu MP qui n'y figurent pas
function subTargets(cfg) {
  const ids = new Set(cfg.reasons.map((r) => r.id));
  return [
    ...cfg.reasons.map((r) => ({ id: r.id, label: r.label, mp: false })),
    ...(cfg.dmChoices || []).filter((r) => !ids.has(r.id)).map((r) => ({ id: r.id, label: r.label, mp: true })),
  ];
}
const findTarget = (cfg, v) => {
  const t = String(v ?? '').trim().toLowerCase();
  return subTargets(cfg).find((x) => x.id === v || x.label.toLowerCase() === t) || null;
};
// Le sous-panel proposé APRÈS un choix (sous-panels en chaîne, sans limite de profondeur)
function nextSub(cfg, choice) {
  const n = choice?.nextSubId && cfg.subPanels.find((x) => x.id === choice.nextSubId);
  return n && n.choices.length ? n : null;
}
// Vrai si, en suivant les choix de `fromId`, on peut arriver au sous-panel `targetId` (sert à interdire les boucles)
function subReaches(cfg, fromId, targetId, seen = new Set()) {
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const sp = cfg.subPanels.find((x) => x.id === fromId);
  return !!sp && sp.choices.some((c) => c.nextSubId && (c.nextSubId === targetId || subReaches(cfg, c.nextSubId, targetId, seen)));
}
// Choix déjà faits dans un parcours en cours (clé = id du message du menu : éphémère ou MP)
const subFlows = new Map();
const flowPath = (msgId) => subFlows.get(msgId)?.path || [];
function rememberFlow(msgId, path) {
  const now = Date.now();
  for (const [k, v] of subFlows) if (now - v.t > 3_600_000) subFlows.delete(k);
  subFlows.set(msgId, { path, t: now });
}
function subSummary(cfg) {
  const name = (id) => cfg.subPanels.find((x) => x.id === id)?.name;
  const def = name(cfg.defaultSubPanelId);
  const lines = [`**🗂️ Sub-panels of ${cfg.name}**`, `🌐 Default (all categories): ${def ? `**${def}**` : 'none'}`];
  const targets = subTargets(cfg);
  if (targets.length) {
    lines.push('', '**Categories**', ...targets.map((t) => {
      const l = cfg.subLinks[t.id];
      const v = l === 'none' ? '❌ none' : l && name(l) ? `**${name(l)}**` : def ? `${def} *(default)*` : 'none';
      return `• ${t.mp ? '📩 ' : ''}${t.label} → ${v}`;
    }));
  }
  if (cfg.subPanels.length) {
    lines.push('', '**Sub-panels**', ...cfg.subPanels.map((x) =>
      `• **${x.name}** — ${x.choices.length ? x.choices.map((c) => (c.emoji ? c.emoji + ' ' : '') + c.label + (c.nextSubId && name(c.nextSubId) ? ` ➜ ${name(c.nextSubId)}` : '')).join(', ') : '*aucun choix*'}`));
  } else lines.push('', 'No subpanels. Create one with `/sous-panel creer`.');
  return lines.join('\n').slice(0, 1990);
}

// Message + menu du sous-panel (envoyé en réponse éphémère sur le serveur, ou dans le MP)
async function buildSubMessage(guild, user, cfg, sub, customId, reason) {
  const ctx = { guild, user, cfg, choice: reason };
  const files = [];
  const embed = new EmbedBuilder()
    .setColor(parseColor(sub.color, cfg.color || getG(guild.id).panelColor || '#5865F2'))
    .setTitle(dmVars(sub.title || reason?.label || sub.name, ctx).slice(0, 256))
    .setDescription(dmVars(sub.description || 'Specify your request in the menu below.', ctx).slice(0, 4096))
    .setTimestamp();
  const subImg = await imageRef(sub.image, 'image', files);
  if (subImg) embed.setImage(subImg);
  const subThumb = await imageRef(sub.thumbnail, 'thumbnail', files);
  if (subThumb) embed.setThumbnail(subThumb);
  if (sub.footer) embed.setFooter({ text: dmVars(sub.footer, ctx).slice(0, 2048) });
  const menuRows = chunkList(sub.choices).slice(0, 5).map((part, n) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${customId}:${n}`)
      .setPlaceholder((sub.placeholder || 'Choose an option...').slice(0, 150))
      .addOptions(part.map((c) => {
        const o = { label: String(c.label).slice(0, 100), value: c.id };
        const desc = [c.description, c.outOfStock ? '⛔ Plus en stock' : ''].filter(Boolean).join(' · ');
        if (desc) o.description = desc.slice(0, 100);
        const e = parseEmoji(c.emoji);
        if (e) o.emoji = e;
        return o;
      }))));
  return { embeds: [embed], components: menuRows, files };
}

// Mode normal : le membre a choisi une catégorie -> on lui montre le sous-panel (réponse éphémère)
async function showSub(i, cfg, sub, reasonId, panel) {
  const reason = reasonId ? cfg.reasons.find((r) => r.id === reasonId) : null;
  const cid = `tk_sub:${cfg.name}:${reasonId || '-'}:${sub.id}:${panel?.messageId || '-'}`;
  const m = await i.editReply(await buildSubMessage(i.guild, i.user, cfg, sub, cid, reason));
  rememberFlow(m.id, []);
}

// Mode normal : le membre choisit dans le sous-panel -> soit un autre sous-panel, soit le ticket est créé
async function subChoose(i) {
  const [, cfgName, rid, subId, pid] = i.customId.split(':');
  const cfg = getG(i.guildId).tickets[cfgName];
  const choice = cfg?.subPanels.find((x) => x.id === subId)?.choices.find((c) => c.id === i.values[0]);
  if (!cfg || !choice) {
    return i.update({ content: "❌ This menu is no longer valid. Click again on the server panel to get a new one.", embeds: [], components: [] });
  }
  if (choice.outOfStock) {
    return i.reply({ content: "❌ This option is out of stock. Please choose another one.", flags: EPH });
  }
  const path = [...flowPath(i.message.id), choice];
  const next = nextSub(cfg, choice);
  if (next && path.length < 50) {
    rememberFlow(i.message.id, path);
    return i.update(await buildSubMessage(i.guild, i.user, cfg, next, `tk_sub:${cfgName}:${rid}:${next.id}:${pid}`, choice));
  }
  subFlows.delete(i.message.id);
  // Le menu disparaît tout de suite : un seul ticket par menu
  await i.update({ content: '⏳ Creating your ticket...', embeds: [], components: [] });
  const panel = cfg.panels.find((p) => p.messageId === pid);
  const r = await createTicket(i.guild, i.user, cfgName, rid === '-' ? null : rid, panel, path);
  return i.editReply(r.error || `✅ Your ticket has been created: <#${r.channel.id}>`);
}

/* ---------- Menu MP ---------- */
// Le membre choisit dans le menu du MP
async function dmChoose(i) {
  const [, cfgName, guildId] = i.customId.split(':');
  const guild = client.guilds.cache.get(guildId);
  const data = guild ? getG(guildId) : null;
  const cfg = data?.tickets[cfgName];
  const key = `${i.user.id}:${cfgName}`;
  const p = data?.pendingDm[key];

  if (!cfg || !p || p.messageId !== i.message.id) {
    const txt = cfg ? dmText(cfg, 'invalid') : DM_DEFAULT.invalid;
    return i.update({ content: txt, embeds: [], components: [], attachments: [] });
  }

  // Un sous-panel est relié à ce choix : le MP devient le sous-panel (et reste valable pour UN seul choix)
  const choice = cfg.dmChoices.find((r) => r.id === i.values[0]);
  const sub = choice && resolveSub(cfg, choice.id);
  if (sub) {
    const m = await buildSubMessage(guild, i.user, cfg, sub, `tk_dmsub:${cfgName}:${guildId}:${choice.id}:${sub.id}`, choice);
    return i.update({ ...m, attachments: [] });
  }
  return dmFinish(i, guild, data, cfg, key, choice, null);
}

// Le membre choisit dans le sous-panel reçu en MP
async function dmSubChoose(i) {
  const [, cfgName, guildId, choiceId, subId] = i.customId.split(':');
  const guild = client.guilds.cache.get(guildId);
  const data = guild ? getG(guildId) : null;
  const cfg = data?.tickets[cfgName];
  const key = `${i.user.id}:${cfgName}`;
  const p = data?.pendingDm[key];

  if (!cfg || !p || p.messageId !== i.message.id) {
    const txt = cfg ? dmText(cfg, 'invalid') : DM_DEFAULT.invalid;
    return i.update({ content: txt, embeds: [], components: [], attachments: [] });
  }
  const choice = cfg.dmChoices.find((r) => r.id === choiceId);
  const subChoice = cfg.subPanels.find((x) => x.id === subId)?.choices.find((c) => c.id === i.values[0]) || null;
  if (!choice || !subChoice) return dmFinish(i, guild, data, cfg, key, null, null);
  const path = [...flowPath(i.message.id), subChoice];
  const next = nextSub(cfg, subChoice);
  if (next && path.length < 50) { // un autre sous-panel suit : le MP reste valable
    rememberFlow(i.message.id, path);
    const m = await buildSubMessage(guild, i.user, cfg, next, `tk_dmsub:${cfgName}:${guildId}:${choiceId}:${next.id}`, subChoice);
    return i.update({ ...m, attachments: [] });
  }
  subFlows.delete(i.message.id);
  return dmFinish(i, guild, data, cfg, key, choice, path);
}

// Fin du parcours MP : création du ticket puis message de confirmation
async function dmFinish(i, guild, data, cfg, key, choice, subPath) {
  const p = data.pendingDm[key];
  // Usage unique : l'enregistrement est supprimé AVANT toute opération asynchrone
  // (double clic ou ancien menu = aucun ticket créé).
  delete data.pendingDm[key];
  save();
  await i.deferUpdate();

  // Dans tous les cas le menu disparaît (message supprimé), puis on envoie un nouveau MP
  const reply = async (payload) => {
    await i.message.delete().catch(() => {});
    await i.user.send(payload).catch(() => {});
  };

  const member = await guild.members.fetch(i.user.id).catch(() => null);
  if (!member) return reply("❌ Unable to open the ticket: you have left the server.");
  if (data.muted[i.user.id]) return reply('❌ You cannot open a ticket during your mute.');
  if (!choice) return reply("❌ This choice no longer exists. Click again on the server panel.");

  const panel = cfg.panels.find((x) => x.messageId === p.panelId);
  const r = await createTicket(guild, i.user, cfg.name, choice.id, panel, subPath);
  if (r.error) return reply(r.error);

  const shown = subPath?.length ? { ...choice, label: [choice.label, ...subPath.map((c) => c.label)].join(' › ') } : choice;
  const ctx = { guild, user: i.user, cfg, channel: r.channel, choice: shown };
  return reply({
    embeds: [new EmbedBuilder()
      .setColor(parseColor(cfg.dmTexts?.color, '#57F287'))
      .setTitle(dmVars(dmText(cfg, 'doneTitle'), ctx).slice(0, 256))
      .setDescription(dmVars(dmText(cfg, 'doneText'), ctx).slice(0, 4096))
      .setTimestamp()],
  });
}

async function openTicket(i, cfgName, reasonId) {
  const data = getG(i.guildId);
  const cfg = data.tickets[cfgName];
  if (!cfg) return i.reply({ content: "❌ This configuration no longer exists.", flags: EPH });

  await i.deferReply({ flags: EPH });
  // Réinitialise le menu déroulant pour pouvoir rechoisir la même raison
  if (i.isStringSelectMenu()) i.message.edit({ components: i.message.components }).catch(() => {});

  // Le panel d'où vient le clic (pour utiliser son message personnalisé)
  const panel = cfg.panels.find((p) => p.messageId === i.message?.id);

  // Mode MP : on envoie le menu en message privé
  if (cfg.dm) return startDmFlow(i, cfg, panel);

  // Sous-panel relié à cette catégorie (ou par défaut) : 2e menu avant de créer le ticket
  const sub = resolveSub(cfg, reasonId);
  if (sub) return showSub(i, cfg, sub, reasonId, panel);

  // Sinon le ticket s'ouvre directement
  const r = await createTicket(i.guild, i.user, cfgName, reasonId, panel);
  if (r.error) return i.editReply(r.error);
  await i.editReply(`✅ Your ticket has been created: <#${r.channel.id}>`);
}

// Le staff d'un ticket = les rôles enregistrés à son ouverture (ou ceux de la config pour les anciens tickets).
// En mode « all », le membre doit posséder tous les rôles ; en mode « any », un seul suffit.
function isStaff(i, t, cfg) {
  const roles = t.staffRoles || cfg?.staffRoles || [];
  const has = t.staffMode === 'all'
    ? roles.length > 0 && roles.every((id) => i.member.roles.cache.has(id))
    : roles.some((id) => i.member.roles.cache.has(id));
  return has || i.member.permissions.has(PermissionFlagsBits.ManageChannels);
}

// Tickets en mode « tous les rôles » : accorde / retire l'accès nominatif quand les rôles d'un membre changent.
async function syncMemberTicketAccess(member) {
  const d = getG(member.guild.id);
  for (const [channelId, t] of Object.entries(d.open || {})) {
    if (t.staffMode !== 'all' || !t.staffRoles?.length || t.userId === member.id) continue;
    if (t.extraUsers?.includes(member.id)) continue; // ajouté manuellement avec /ticket ajouter : on ne touche pas à son accès
    const ch = member.guild.channels.cache.get(channelId);
    if (!ch) continue;
    const hasAll = t.staffRoles.every((id) => member.roles.cache.has(id));
    const ow = ch.permissionOverwrites.cache.get(member.id);
    try {
      if (hasAll && !ow) {
        await ch.permissionOverwrites.edit(member.id, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
          AttachFiles: true, EmbedLinks: true, ManageMessages: true,
        });
      } else if (!hasAll && ow) {
        await ch.permissionOverwrites.delete(member.id);
      }
    } catch (e) { console.error('[ticket] sync access:', e.message); }
  }
}

async function claimTicket(i) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) return i.reply({ content: "❌ This channel is not a managed ticket.", flags: EPH });
  if (!isStaff(i, t, data.tickets[t.config])) {
    return i.reply({ content: '❌ Reserved for staff.', flags: EPH });
  }
  if (t.claimedBy) return i.reply({ content: `❌ Already supported by <@${t.claimedBy}>.`, flags: EPH });
  t.claimedBy = i.user.id;
  save();
  await i.reply({ content: `🙋 <@${i.user.id}> supports this ticket.`, allowedMentions: { parse: [] } });
  // ❌ (en attente) devient ✅ (pris en charge) ; sans await : Discord limite les renommages de salons
  if (i.channel.name.startsWith('❌')) i.channel.setName(i.channel.name.replace(/^❌/, '✅')).catch(console.error);
}

// Ajout / retrait d'un membre dans le ticket courant.
// Utilisé par /ticket ajouter|retirer ET par les commandes rapides /add et /remove.
async function ticketMemberAction(i, mode) {
  const d = getG(i.guildId);
  const t = d.open[i.channelId];
  if (!t) return i.reply({ content: '❌ Use this command **in a ticket channel**.', flags: EPH });
  const cfg = d.tickets[t.config];
  const allowed = i.user.id === t.userId || isStaff(i, t, cfg) || hasFullAccess(i) || cmdAllowed(i);
  if (!allowed) return i.reply({ content: '❌ Reserved for the ticket creator and staff.', flags: EPH });
  const user = i.options.getUser('membre', true);
  if (user.bot) return i.reply({ content: '❌ You cannot add a bot to the ticket.', flags: EPH });
  if (mode === 'add') {
    if (user.id === t.userId) return i.reply({ content: '❌ This person has already opened the ticket.', flags: EPH });
    await i.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true,
    }, { reason: `Added to ticket by ${i.user.tag}` }).catch((e) => {
      console.error('[ticket add]', e);
      throw new Error('Unable to add this member (bot permissions).');
    });
    t.extraUsers ??= [];
    if (!t.extraUsers.includes(user.id)) t.extraUsers.push(user.id);
    save();
    await i.reply({ content: `✅ <@${user.id}> has been added to the ticket.`, flags: EPH, allowedMentions: { parse: [] } });
    await i.channel.send({ content: `➕ <@${user.id}> was added to the ticket by <@${i.user.id}>.`, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }
  if (user.id === client.user.id) return i.reply({ content: '❌ I cannot withdraw from the ticket.', flags: EPH });
  await i.channel.permissionOverwrites.delete(user.id, `Removed from ticket by ${i.user.tag}`).catch(console.error);
  if (t.extraUsers?.length) {
    t.extraUsers = t.extraUsers.filter((id) => id !== user.id);
    save();
  }
  await i.reply({ content: `✅ <@${user.id}> has been removed from the ticket.`, flags: EPH, allowedMentions: { parse: [] } });
  await i.channel.send({ content: `➖ <@${user.id}> was removed from the ticket by <@${i.user.id}>.`, allowedMentions: { parse: [] } }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Ventes : panel de suivi                                            */
/* ------------------------------------------------------------------ */
const fmtMoney = (n, cur = '€') =>
  `${Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;
const saleBuyer = (e) => (e.buyerId ? `<@${e.buyerId}>` : (e.buyerName || 'Inconnu'));
const starsText = (n) => '⭐'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - n));

async function buildSalesEmbed(guild) {
  const d = getG(guild.id);
  const s = d.sales;
  const entries = [...(s.entries || [])].slice(-8).reverse();
  const avg = s.count ? s.total / s.count : 0;
  const description = [
    `**Sales completed:** ${s.count}`,
    `**Money generated:** ${fmtMoney(s.total, s.currency)}`,
    `**Panier moyen :** ${fmtMoney(avg, s.currency)}`,
    '',
    '**🧾 Latest sales**',
    entries.length
      ? entries.map((e) =>
        `• <t:${Math.floor(e.at / 1000)}:d> — **${fmtMoney(e.amount, s.currency)}** — ${saleBuyer(e)}` +
        `${e.product ? ` — ${e.product}` : ''}`).join('\n')
      : "No sales recorded yet.",
  ].join('\n').slice(0, 4096);
  const embed = new EmbedBuilder()
    .setColor(parseColor(d.panelColor, '#57F287'))
    .setTitle('📈 Sales Tracking')
    .setDescription(description)
    .setFooter({ text: guild.name })
    .setTimestamp();
  const files = [];
  const logo = await imageRef(s.logo, 'logo', files);
  if (logo) embed.setThumbnail(logo);
  return { embeds: [embed], files };
}

// Crée le panel s'il n'existe pas, sinon le met à jour. Créé automatiquement au démarrage et après chaque vente.
async function refreshSalesPanel(guild, create = true) {
  const d = getG(guild.id);
  const s = d.sales;
  if (!s.channelId) return null;
  const ch = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!ch) return null;
  const payload = await buildSalesEmbed(guild);
  const fingerprint = sig({ count: s.count, total: s.total, last: s.entries?.at(-1)?.at || 0, currency: s.currency, color: d.panelColor, logo: srcHash(s.logo) });
  if (s.messageId) {
    const { msg, gone } = await fetchMsg(guild, s.channelId, s.messageId);
    if (msg) {
      if (s.sig === fingerprint) return msg;
      try {
        await msg.edit(payload);
        s.sig = fingerprint;
        save();
      } catch (e) {
        console.error('[ventes]', e.message);
      }
      return msg;
    }
    if (gone) { s.messageId = null; save(); }
    else return null;
  }
  if (!create) return null;
  const sent = await ch.send(payload).catch((e) => { console.error('[ventes]', e.message); return null; });
  if (!sent) return null;
  s.messageId = sent.id;
  s.sig = fingerprint;
  save();
  return sent;
}

function recordSale(guild, sale) {
  const d = getG(guild.id);
  const s = d.sales;
  const amount = Math.round(Number(sale.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return;
  s.count = (s.count || 0) + 1;
  s.total = Math.round(((s.total || 0) + amount) * 100) / 100;
  s.entries = [...(s.entries || []), {
    at: Date.now(), amount,
    buyerId: sale.buyerId || null, buyerName: sale.buyerName || null,
    product: sale.product || null, by: sale.by || null,
    config: sale.config || null, ticket: sale.ticket || null,
  }].slice(-100);
  save();
  refreshSalesPanel(guild).catch(console.error);
}

/* ------------------------------------------------------------------ */
/*  Vouch : avis vérifiés                                              */
/* ------------------------------------------------------------------ */
function vouchAllowed(i, t) {
  return i.user.id === t.userId || i.user.id === t.claimedBy;
}

async function vouchPanel(i) {
  const d = getG(i.guildId);
  const t = d.open[i.channelId];
  if (!t) return i.reply({ content: '❌ The Vouch button is only used in an open ticket.', flags: EPH });
  if (!d.vouch.enabled) return i.reply({ content: '❌ Vouchs are disabled on this server.', flags: EPH });
  if (!d.vouch.channelId) return i.reply({ content: "❌ No vouch channel is configured. Notify an administrator.", flags: EPH });
  if (!vouchAllowed(i, t)) return i.reply({ content: '❌ Only the person who opened the ticket or who took charge of it can vouch for it.', flags: EPH });
  if ((d.vouches || []).some((v) => v.ticketId === i.channelId && v.from === i.user.id)) {
    return i.reply({ content: '❌ You have already left a voucher for this ticket.', flags: EPH });
  }
  const embed = new EmbedBuilder()
    .setColor(parseColor(d.panelColor, '#F1C40F'))
    .setTitle('⭐ Leave a vouch for this ticket')
    .setDescription(
      '**How it works**\n' +
      '1️⃣ Choose a rating from **1 to 5 stars** with the buttons below.\n' +
      '2️⃣ Write your message.\n' +
      '3️⃣ Your review is posted in the vouch channel with your profile picture.\n\n' +
      '> Your vouch proves the deal went smoothly.'
    )
    .setFooter({ text: 'One review per ticket and per member.' });
  const files = [];
  const logo = await imageRef(d.vouch.logo, 'logo', files);
  if (logo) embed.setThumbnail(logo);
  const row = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map((n) => new ButtonBuilder()
      .setCustomId(`vouch:star:${n}`)
      .setLabel(`${n} star${n > 1 ? 's' : ''}`)
      .setEmoji('⭐')
      .setStyle(n >= 4 ? ButtonStyle.Success : n === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary)),
  );
  return i.reply({ embeds: [embed], components: [row], files, flags: EPH });
}

async function vouchModal(i, stars) {
  const n = Number(stars);
  if (!(n >= 1 && n <= 5)) return i.reply({ content: '❌ Invalid rating.', flags: EPH });
  const d = getG(i.guildId);
  const t = d.open[i.channelId];
  if (!t) return i.reply({ content: '❌ This ticket no longer exists.', flags: EPH });
  if (!vouchAllowed(i, t)) return i.reply({ content: '❌ You cannot vouch for this ticket.', flags: EPH });
  return i.showModal(new ModalBuilder()
    .setCustomId(`vouch_modal:${n}:${i.channelId}`)
    .setTitle(`Your review — ${starsText(n)}`)
    .addComponents(
      field('message', 'Your message', TextInputStyle.Paragraph, { required: true, max: 1000, placeholder: 'Tell us how the deal went…' }),
    ));
}

async function vouchSubmit(m) {
  const [, starsRaw, channelId] = m.customId.split(':');
  const stars = Number(starsRaw);
  const d = getG(m.guildId);
  const t = d.open[channelId];
  if (!t) return m.reply({ content: '❌ This ticket no longer exists.', flags: EPH });
  if (!d.vouch.enabled || !d.vouch.channelId) return m.reply({ content: '❌ Vouchs are no longer configured.', flags: EPH });
  if (!vouchAllowed(m, t)) return m.reply({ content: '❌ You cannot vouch for this ticket.', flags: EPH });
  if ((d.vouches || []).some((v) => v.ticketId === channelId && v.from === m.user.id)) {
    return m.reply({ content: '❌ You have already left a voucher for this ticket.', flags: EPH });
  }
  const message = m.fields.getTextInputValue('message').trim().slice(0, 1000);
  if (!message) return m.reply({ content: '❌ Your message is empty.', flags: EPH });
  const ch = await m.guild.channels.fetch(d.vouch.channelId).catch(() => null);
  if (!ch) return m.reply({ content: '❌ The vouch channel could not be found.', flags: EPH });

  // On capture le transcript du ticket maintenant : le staff pourra le consulter
  // depuis le salon des vouchs, même après la fermeture du ticket.
  let transcript = '';
  const tch = m.guild.channels.cache.get(channelId) || await m.guild.channels.fetch(channelId).catch(() => null);
  if (tch) {
    const msgs = [];
    let before;
    for (let n = 0; n < 3; n++) {
      const batch = await tch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || !batch.size) break;
      msgs.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    msgs.reverse();
    transcript = msgs.map((x) => {
      const att = x.attachments.size ? ' ' + [...x.attachments.values()].map((a) => a.url).join(' ') : '';
      return `[${x.createdAt.toISOString()}] ${x.author.tag}: ${x.content}${att}`;
    }).join('\n').slice(0, 20000);
  }

  const member = await m.guild.members.fetch(m.user.id).catch(() => m.member);
  const vouch = {
    id: crypto.randomUUID().slice(0, 8),
    ticketId: channelId,
    ticketName: m.channel?.name || null,
    config: t.config,
    from: m.user.id,
    claimedBy: t.claimedBy || null,
    stars: Math.max(1, Math.min(5, stars)),
    message,
    image: null,
    transcript,
    at: Date.now(),
  };
  // Variables utilisables dans le titre, les détails et le pied de page du vouch.
  const vars = (txt) => String(txt ?? '')
    .replaceAll('{user}', `<@${m.user.id}>`)
    .replaceAll('{username}', m.user.username)
    .replaceAll('{displayname}', member?.displayName || m.user.username)
    .replaceAll('{server}', m.guild.name)
    .replaceAll('{category}', t.reason || t.config || 'Not specified')
    .replaceAll('{config}', t.config)
    .replaceAll('{ticket}', `#${vouch.ticketName || 'ticket'}`)
    .replaceAll('{claimed}', t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody')
    .replaceAll('{staff}', t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody')
    .replaceAll('{stars}', `${vouch.stars}/5`)
    .replaceAll('{date}', `<t:${Math.floor(vouch.at / 1000)}:D>`);
  const starLine = '★'.repeat(vouch.stars) + '☆'.repeat(5 - vouch.stars);
  const quote = message.split('\n').map((l) => `> ${l}`).join('\n');
  const details = d.vouch.details ? vars(d.vouch.details).trim() : '';
  const embed = new EmbedBuilder()
    .setColor(parseColor(d.panelColor, '#F1C40F'))
    .setAuthor({ name: member?.displayName || m.user.username, iconURL: m.user.displayAvatarURL({ size: 256 }) })
    .setTitle((d.vouch.title ? vars(d.vouch.title) : 'Customer review').slice(0, 256))
    .setDescription((`${starLine} · ${vouch.stars} / 5\n\n${quote}` + (details ? `\n\n${details}` : '')).slice(0, 4096))
    .setFooter({
      text: (d.vouch.footer
        ? vars(d.vouch.footer)
        : `${m.guild.name} • Customer feedback • <t:${Math.floor(vouch.at / 1000)}:D>`).slice(0, 2048),
    });
  const vFiles = [];
  const vLogo = await imageRef(d.vouch.logo, 'logo', vFiles);
  if (vLogo) embed.setThumbnail(vLogo);

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vouch_logs:${channelId}`).setLabel('View ticket logs').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vouch_del:${vouch.id}`).setLabel('Delete vouch').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
  let sent = null;
  try {
    sent = await ch.send({ embeds: [embed], files: vFiles, components: [controls], allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('[vouch]', e.message);
  }
  if (!sent) return m.reply({ content: '❌ Unable to publish your vouch (channel permissions). Notify an administrator.', flags: EPH });
  vouch.channelId = ch.id;
  vouch.messageId = sent.id;
  d.vouches.push(vouch);
  t.vouched = true;      // le membre a laissé un vouch : il peut fermer son ticket
  t.vouchId = vouch.id;
  save();
  const okMsg = { content: `✅ Thanks! Your vouch was published in <#${d.vouch.channelId}>.`, embeds: [], components: [] };
  if (m.isFromMessage?.()) {
    try { return await m.update(okMsg); } catch { /* le panneau a peut-être expiré */ }
  }
  return m.reply({ ...okMsg, flags: EPH });
}

// Le staff (rôles du ticket, modération ou accès total) peut consulter les logs et supprimer un vouch.
function vouchStaffAllowed(i, config) {
  const d = getG(i.guildId);
  if (hasFullAccess(i)) return true;
  if ((d.modRoles || []).some((id) => i.member?.roles?.cache?.has(id))) return true;
  const cfg = d.tickets?.[config];
  const roles = [...(cfg?.staffRoles || [])];
  return !!roles.length && !!i.member?.roles?.cache?.some((r) => roles.includes(r.id));
}

async function vouchLogs(i) {
  const ticketId = i.customId.split(':')[1];
  const d = getG(i.guildId);
  const v = [...(d.vouches || [])].reverse().find((x) => x.ticketId === ticketId);
  if (!v) return i.reply({ content: '❌ Vouch not found.', flags: EPH });
  if (v.from !== i.user.id && !vouchStaffAllowed(i, v.config)) {
    return i.reply({ content: '❌ Reserved for staff.', flags: EPH });
  }
  const text = v.transcript || '(No transcript saved for this ticket.)';
  const safe = String(v.ticketName || 'ticket').replace(/[^\w.-]+/g, '-');
  const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `transcript-${safe}.txt` });
  return i.reply({ content: `📜 Ticket logs for **#${v.ticketName || v.ticketId}** (visible only to you):`, files: [file], flags: EPH });
}

async function vouchDelete(i) {
  const id = i.customId.split(':')[1];
  const d = getG(i.guildId);
  const v = (d.vouches || []).find((x) => x.id === id);
  if (!v) return i.reply({ content: '❌ Vouch not found.', flags: EPH });
  if (!vouchStaffAllowed(i, v.config)) return i.reply({ content: '❌ Reserved for staff.', flags: EPH });
  if (v.channelId && v.messageId) {
    const ch = i.guild.channels.cache.get(v.channelId) || await i.guild.channels.fetch(v.channelId).catch(() => null);
    const msg = ch && await ch.messages.fetch(v.messageId).catch(() => null);
    if (msg) await msg.delete().catch(console.error);
  }
  d.vouches = d.vouches.filter((x) => x !== v);
  save();
  return i.reply({ content: '🗑️ Vouch deleted.', flags: EPH });
}

/* ------------------------------------------------------------------ */
/*  Fermeture d'un ticket (avec demande de vente)                      */
/* ------------------------------------------------------------------ */
// Bouton « Stats » d'un panel : tickets ouverts, vouchs et note moyenne.
async function ticketStats(i) {
  const cfgName = i.customId.split(':')[1];
  const d = getG(i.guildId);
  const cfg = d.tickets[cfgName];
  if (!cfg) return i.reply({ content: '❌ Configuration not found.', flags: EPH });
  const vouches = (d.vouches || []).filter((v) => v.config === cfgName);
  const avg = vouches.length ? vouches.reduce((n, v) => n + (v.stars || 0), 0) / vouches.length : 0;
  const open = Object.values(d.open || {}).filter((t) => t.config === cfgName).length;
  const embed = new EmbedBuilder()
    .setColor(parseColor(d.panelColor, '#5865F2'))
    .setTitle(`📊 Stats — ${cfg.name}`)
    .addFields(
      { name: 'Tickets opened', value: String(cfg.counter || 0), inline: true },
      { name: 'Tickets currently open', value: String(open), inline: true },
      { name: 'Vouches', value: String(vouches.length), inline: true },
      { name: 'Average rating', value: vouches.length ? `${avg.toFixed(2)} / 5` : '—', inline: true },
    )
    .setTimestamp();
  return i.reply({ embeds: [embed], flags: EPH });
}

// Le membre demande à un staff de fermer son ticket sans vouch.
async function askStaff(i) {
  const d = getG(i.guildId);
  const t = d.open[i.channelId];
  if (!t) return i.reply({ content: '❌ This channel is not an open ticket.', flags: EPH });
  if (i.user.id !== t.userId) return i.reply({ content: '❌ Only the ticket opener can ask a staff member.', flags: EPH });
  const cfg = d.tickets[t.config];
  const roles = [...new Set([...(t.staffRoles || []), ...(cfg?.staffRoles || [])])]
    .filter((id) => i.guild.roles.cache.has(id));
  const mention = roles.map((id) => `<@&${id}>`).join(' ');
  await i.reply({ content: '✅ A staff member has been notified.', flags: EPH });
  await i.channel.send({
    content: `🔔 ${mention ? mention + ' — ' : ''}the customer would like a staff member to close this ticket.`.slice(0, 2000),
    allowedMentions: { roles },
  }).catch(() => {});
}

async function closeTicket(i) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) return i.reply({ content: "❌ This channel is not a managed ticket.", flags: EPH });
  const cfg = data.tickets[t.config];
  const staff = isStaff(i, t, cfg);
  const creator = i.user.id === t.userId;
  if (!staff && !creator) {
    return i.reply({ content: '❌ Only staff or the ticket opener can close a ticket.', flags: EPH });
  }
  // Le membre doit laisser un vouch avant de fermer (si le bouton Vouch est activé).
  const vouchRequired = !!cfg?.vouchButton && data.vouch?.enabled !== false && !!data.vouch?.channelId;
  if (creator && !staff) {
    if (vouchRequired && !t.vouched) {
      const embed = new EmbedBuilder()
        .setColor(parseColor(data.panelColor, '#F1C40F'))
        .setTitle('⭐ A vouch is required before closing')
        .setDescription(
          'To close this ticket, please **leave a vouch** first.\n\n' +
          'If you no longer wish to buy, click **Ask a staff member**: they will close the ticket for you.'
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk_vouch').setLabel('Vouch now').setEmoji('⭐').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tk_ask_staff').setLabel('Ask a staff member').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
      );
      return i.reply({ embeds: [embed], components: [row], flags: EPH });
    }
    // Le membre a voué (ou le vouch est désactivé) : fermeture sans vente.
    return finishClose(i, null);
  }
  const embed = new EmbedBuilder()
    .setColor(parseColor(data.panelColor, '#ED4245'))
    .setTitle('🔒 Close this ticket')
    .setDescription(
      '**Was the sale completed?**\n\n' +
      '• **Yes** → indicates the amount: the sales monitoring panel will be updated.\n' +
      '• **No** → the ticket is closed without sale.\n\n' +
      'Only a staff member can choose. The ticket will be closed after your response.'
    )
    .setFooter({ text: 'Choose an option below.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tk_sale:yes:${i.channelId}`).setLabel('Yes, sale completed').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tk_sale:no:${i.channelId}`).setLabel('No, no sale').setEmoji('❌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tk_close_cancel').setLabel('Annuler').setStyle(ButtonStyle.Danger),
  );
  return i.reply({ embeds: [embed], components: [row], flags: EPH });
}

async function saleModal(i, channelId) {
  const d = getG(i.guildId);
  const t = d.open[channelId];
  if (!t) return i.reply({ content: '❌ This ticket no longer exists.', flags: EPH });
  const cfg = d.tickets[t.config];
  if (!isStaff(i, t, cfg)) return i.reply({ content: '❌ Only staff can register a sale.', flags: EPH });
  const opener = await client.users.fetch(t.userId).catch(() => null);
  return i.showModal(new ModalBuilder()
    .setCustomId(`tk_sale_modal:${channelId}`)
    .setTitle('Sale completed')
    .addComponents(
      field('montant', 'Amount collected (required)', TextInputStyle.Short, { required: true, max: 20, placeholder: 'Ex : 25' }),
      field('acheteur', 'Buyer (mention, ID or nickname)', TextInputStyle.Short, { max: 100, value: opener ? opener.username : '', placeholder: 'Leave blank = ticket member' }),
      field('produit', 'Product/service (optional)', TextInputStyle.Short, { max: 100, value: (t.reason || '').slice(0, 100), placeholder: 'Ex : Netflix 1 mois' }),
    ));
}

// Ferme réellement le ticket. sale = { amount, buyerId, buyerName, product } ou null.
async function finishClose(i, sale) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) {
    try { await i.reply({ content: '❌ This ticket is already closed.', flags: EPH }); } catch { /* rien */ }
    return;
  }
  const cfg = data.tickets[t.config];
  const staff = isStaff(i, t, cfg);
  const vouchRequired = !!cfg?.vouchButton && data.vouch?.enabled !== false && !!data.vouch?.channelId;
  const creatorClose = i.user.id === t.userId && (!vouchRequired || t.vouched);
  if (!staff && !creatorClose) {
    try { await i.reply({ content: '❌ Only staff can close this ticket.', flags: EPH }); } catch { /* rien */ }
    return;
  }
  if (!staff) sale = null; // un membre ne peut pas enregistrer une vente
  delete data.open[i.channelId]; // évite un double clic / double vente
  save();
  if (sale) {
    recordSale(i.guild, { ...sale, by: i.user.id, config: t.config, ticket: i.channel.name });
  }
  const ack = { content: '🔒 Ticket closing in a few seconds...', embeds: [], components: [] };
  try {
    if (i.isFromMessage?.()) await i.update(ack);
    else if (i.deferred || i.replied) await i.followUp({ ...ack, flags: EPH });
    else await i.reply({ ...ack, flags: EPH });
  } catch { /* le message a peut-être déjà été modifié */ }

  // Transcript (jusqu'à 500 messages)
  const msgs = [];
  let before;
  for (let n = 0; n < 5; n++) {
    const batch = await i.channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    msgs.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  msgs.reverse();
  const text = msgs.map((m) => {
    const att = m.attachments.size ? ' ' + [...m.attachments.values()].map((a) => a.url).join(' ') : '';
    const emb = !m.content && m.embeds.length ? ' [embed]' : '';
    return `[${m.createdAt.toLocaleString('fr-FR')}] ${m.author.tag}: ${m.content}${att}${emb}`;
  }).join('\n') || '(vide)';
  // Le vouch de ce ticket garde le transcript final (bouton « Voir les logs »).
  const vouchRec = (data.vouches || []).find((v) => v.ticketId === i.channelId);
  if (vouchRec) { vouchRec.transcript = text.slice(0, 20000); save(); }
  const mkFile = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `transcript-${i.channel.name}.txt` });

  const logEmbed = new EmbedBuilder()
    .setColor(parseColor(data.panelColor, '#ED4245'))
    .setTitle('🔒 Ticket closed')
    .addFields(
      { name: 'Ticket', value: i.channel.name, inline: true },
      { name: 'Configuration', value: t.config, inline: true },
      { name: 'Category', value: t.reason || 'Not specified', inline: true },
      { name: 'Opened by', value: `<@${t.userId}>`, inline: true },
      { name: 'Closed by', value: `<@${i.user.id}>`, inline: true },
      { name: 'Claimed by', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody', inline: true },
      ...(sale ? [{ name: 'Registered sale', value: `${fmtMoney(sale.amount, data.sales.currency)}${sale.product ? ` — ${sale.product}` : ''}`, inline: true }] : []),
    )
    .setTimestamp();

  const logCh = cfg?.logChannelId ? await i.guild.channels.fetch(cfg.logChannelId).catch(() => null) : null;
  if (logCh) await logCh.send({ embeds: [logEmbed], files: [mkFile()], allowedMentions: { parse: [] } }).catch(console.error);

  const opener = await client.users.fetch(t.userId).catch(() => null);
  if (opener) {
    opener.send({ content: `Your ticket **${i.channel.name}** on **${i.guild.name}** has been closed. Here is the transcript:`, files: [mkFile()] }).catch(() => {});
  }

  setTimeout(() => i.channel.delete().catch(console.error), 5000);
}

async function saleSubmit(m) {
  const channelId = m.customId.split(':')[1];
  const d = getG(m.guildId);
  const t = d.open[channelId];
  if (!t) return m.reply({ content: '❌ This ticket no longer exists.', flags: EPH });
  const cfg = d.tickets[t.config];
  if (!isStaff(m, t, cfg)) return m.reply({ content: '❌ Only staff can register a sale.', flags: EPH });
  const raw = m.fields.getTextInputValue('montant').replace(',', '.').replace(/[^\d.]/g, '');
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return m.reply({ content: '❌ Invalid amount: write a number (ex: 25 or 12.50).', flags: EPH });
  }
  const buyerRaw = (m.fields.getTextInputValue('acheteur') || '').trim();
  const idMatch = /^(?:<@!?)?(\d{15,25})>?$/.exec(buyerRaw);
  let buyerId = idMatch ? idMatch[1] : (buyerRaw ? null : t.userId);
  let buyerName = buyerRaw && !buyerId ? buyerRaw.slice(0, 100) : null;
  if (!buyerId && buyerRaw) { // pseudo du membre qui a ouvert le ticket
    const opener = await client.users.fetch(t.userId).catch(() => null);
    if (opener && buyerRaw.toLowerCase() === opener.username.toLowerCase()) {
      buyerId = opener.id;
      buyerName = null;
    }
  }
  const product = (m.fields.getTextInputValue('produit') || '').trim().slice(0, 100) || t.reason || null;
  return finishClose(m, { amount, buyerId, buyerName, product });
}

/* ------------------------------------------------------------------ */
/*  Autorole par réaction                                              */
/* ------------------------------------------------------------------ */
async function handleReaction(reaction, user, add) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    const guildId = msg.guildId || msg.channel?.guildId;
    if (!guildId) return;

    const d = getG(guildId);
    const rr = d.reactionRoles[msg.id];
    if (!rr) return;
    if ((reaction.emoji.id ?? reaction.emoji.name) !== rr.emoji) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    if (d.muted[user.id]) return; // un membre mute ne peut pas se redonner des rôles

    const role = guild.roles.cache.get(rr.roleId);
    if (!role) { delete d.reactionRoles[msg.id]; save(); return; }
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (add) {
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Autorole (reaction)');
    } else if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Autorole (reaction withdrawn)');
    }
  } catch (e) {
    console.error('[autorole]', e);
  }
}

// Au démarrage : vérifie chaque message d'autorole (plus besoin de le renvoyer à chaque mise à jour du bot)
//  - nettoie les autoroles dont le message ou le rôle n'existe plus
//  - remet la réaction du bot si elle a disparu
//  - donne le rôle aux membres qui ont réagi pendant que le bot était éteint
async function syncAutoroles(guild) {
  const d = getG(guild.id);
  for (const [id, rr] of Object.entries(d.reactionRoles)) {
    const { msg, gone } = await fetchMsg(guild, rr.channelId, id);
    if (gone) { delete d.reactionRoles[id]; save(); continue; }
    if (!msg) continue;

    const role = guild.roles.cache.get(rr.roleId);
    if (!role) { delete d.reactionRoles[id]; save(); continue; }

    let reaction = msg.reactions.resolve(rr.emoji);
    if (!reaction?.me) {
      await msg.react(rr.label).catch(console.error);
      reaction = msg.reactions.resolve(rr.emoji);
    }
    if (!reaction || !role.editable) continue;

    const users = await reaction.users.fetch().catch(() => null);
    if (!users) continue;
    for (const u of users.values()) {
      if (u.bot || d.muted[u.id]) continue;
      const member = await guild.members.fetch(u.id).catch(() => null);
      if (member && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, 'Autorole (synchronisation)').catch(console.error);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Giveaways                                                          */
/* ------------------------------------------------------------------ */
const MAX_GW = 365 * 86_400_000;
const endingNow = new Set(); // giveaways en cours de tirage (évite un double tirage)
const gwTimers = new Map();  // mise à jour groupée du compteur du bouton

const shuffle = (arr) => {
  const a = [...arr];
  for (let n = a.length - 1; n > 0; n--) {
    const j = crypto.randomInt(n + 1);
    [a[n], a[j]] = [a[j], a[n]];
  }
  return a;
};

function gwRow(gw) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('gw_join')
      .setLabel(`${gw.ended ? 'Ended' : 'Enter'} (${gw.entrants.length})`)
      .setEmoji('🎉')
      .setStyle(gw.ended ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(!!gw.ended));
}

function gwDescription(gw) {
  const ts = Math.floor(gw.endAt / 1000);
  const lines = [];
  if (gw.description) lines.push(gw.description, '');
  lines.push(
    `⏰ **Fin :** <t:${ts}:R> (<t:${ts}:f>)`,
    `🏆 **Gagnant${gw.winners > 1 ? 's' : ''} :** ${gw.winners}`,
    gw.hostLine || `👤 **Organized by:** <@${gw.hostId}>`);
  if (gw.requiredRole) lines.push(`🔒 **Required role:** <@&${gw.requiredRole}>`);
  if (gw.minInvites) lines.push(`📨 **Invitations minimum :** ${gw.minInvites}`);
  lines.push('', 'Click on the button below to participate!');
  return lines.join('\n');
}

// Participants encore sur le serveur, qui ne sont pas des bots, qui ont le rôle requis
// et le minimum d'invitations demandé
async function validEntrants(guild, gw) {
  const stats = getG(guild.id).invites.stats;
  const valid = [];
  for (let n = 0; n < gw.entrants.length; n += 100) {
    const chunk = gw.entrants.slice(n, n + 100);
    const members = await guild.members.fetch({ user: chunk }).catch(() => null);
    if (!members) { valid.push(...chunk); continue; } // impossible de vérifier : on garde
    for (const m of members.values()) {
      if (m.user.bot) continue;
      if (gw.requiredRole && !m.roles.cache.has(gw.requiredRole)) continue;
      if (gw.minInvites && invNet(stats[m.id]) < gw.minInvites) continue;
      valid.push(m.id);
    }
  }
  return valid;
}

const pickWinners = (valid, n, exclude = []) =>
  shuffle(valid.filter((id) => !exclude.includes(id))).slice(0, n);

async function editEndedMessage(msg, gw) {
  const winnersTxt = gw.winnerIds.length
    ? gw.winnerIds.map((w) => `<@${w}>`).join(', ')
    : 'No valid participants';
  const desc =
    `${gw.description ? gw.description + '\n\n' : ''}` +
    `🏆 **Gagnant${gw.winnerIds.length > 1 ? 's' : ''} :** ${winnersTxt}\n` +
    `${gw.hostLine || `👤 **Organized by:** <@${gw.hostId}>`}\n` +
    `👥 **Participants valides :** ${gw.validCount ?? gw.entrants.length}`;
  const make = (withImage) => {
    const e = msg.embeds[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
    e.setTitle(`🎉 ${gw.prize} — Done`.slice(0, 256))
      .setColor('#95A5A6')
      .setDescription(desc.slice(0, 4096))
      .setFooter({ text: 'Finished giveaway' })
      .setTimestamp(new Date(gw.endedAt));
    if (!withImage) e.setImage(null);
    return e;
  };
  const row = gwRow(gw);
  try {
    await msg.edit({ embeds: [make(true)], components: [row], allowedMentions: { parse: [] } });
  } catch {
    // Si l'image pose problème, on réessaie sans elle
    await msg.edit({ embeds: [make(false)], components: [row], allowedMentions: { parse: [] } }).catch(console.error);
  }
}

async function announceWinners(msg, gw, winners, isReroll) {
  let text;
  if (!winners.length) {
    text = isReroll
      ? `❌ No other valid participant for **${gw.prize}**.`
      : `😕 The giveaway **${gw.prize}** is over: no valid participants, no winner.`;
  } else {
    const list = winners.map((w) => `<@${w}>`).join(', ');
    text = `${isReroll ? '🔄 Reroll' : '🎉 Congratulations'} ${list} !` +
      `${winners.length > 1 ? 'You all won' : 'You won'} **${gw.prize}**!`;
  }
  const payload = { content: text, allowedMentions: { users: winners, repliedUser: false } };
  await msg.reply(payload).catch(() => msg.channel.send(payload).catch(console.error));

  for (const w of winners) {
    client.users.fetch(w)
      .then((u) => u.send(`🎉 You won **${gw.prize}** on **${msg.guild.name}**!\n${msg.url}`))
      .catch(() => {});
  }
}

// Termine un giveaway : tirage au sort, message mis à jour, annonce des gagnants
async function endGiveaway(guild, id) {
  const d = getG(guild.id);
  const gw = d.giveaways[id];
  if (!gw || gw.ended) return { ok: false, reason: 'not found or already completed' };
  if (endingNow.has(id)) return { ok: false, reason: 'draw already in progress' };
  endingNow.add(id);
  try {
    const { msg, gone } = await fetchMsg(guild, gw.channelId, id);
    if (gone) { delete d.giveaways[id]; save(); return { ok: false, reason: 'the message was deleted' }; }
    if (!msg) return { ok: false, reason: 'message inaccessible (automatic retry)' };

    const valid = await validEntrants(guild, gw);
    const winners = pickWinners(valid, gw.winners);
    gw.ended = true;
    gw.endedAt = Date.now();
    gw.winnerIds = winners;
    gw.validCount = valid.length;
    save();

    await editEndedMessage(msg, gw);
    await announceWinners(msg, gw, winners, false);
    return { ok: true, winners };
  } finally {
    endingNow.delete(id);
  }
}

// Vérifie régulièrement les giveaways à terminer (fonctionne aussi après un redémarrage du bot)
async function checkGiveaways() {
  for (const guild of client.guilds.cache.values()) {
    const d = getG(guild.id);
    for (const [id, gw] of Object.entries(d.giveaways)) {
      if (!gw.ended && gw.endAt <= Date.now()) {
        await endGiveaway(guild, id).catch(console.error);
      } else if (gw.ended && Date.now() - (gw.endedAt || 0) > 30 * 86_400_000) {
        delete d.giveaways[id]; // on garde 30 jours pour permettre le reroll
        save();
      }
    }
  }
}

// Met à jour le compteur du bouton si besoin
async function refreshGiveaway(guild, id) {
  const gw = getG(guild.id).giveaways[id];
  if (!gw || gw.ended) return;
  const { msg, gone } = await fetchMsg(guild, gw.channelId, id);
  if (gone) { delete getG(guild.id).giveaways[id]; save(); return; }
  if (!msg) return;
  const row = gwRow(gw);
  const s = sig(row.toJSON());
  if (gw.sig === s) return;
  try {
    await msg.edit({ components: [row] });
    gw.sig = s;
    save();
  } catch (e) {
    console.error('[giveaway]', e.message);
  }
}

async function refreshGiveaways(guild) {
  for (const id of Object.keys(getG(guild.id).giveaways)) {
    await refreshGiveaway(guild, id).catch(console.error);
  }
}

// Plusieurs clics rapprochés = une seule modification du message (limite de Discord)
function scheduleGwUpdate(guild, id) {
  const key = `${guild.id}:${id}`;
  if (gwTimers.has(key)) return;
  gwTimers.set(key, setTimeout(() => {
    gwTimers.delete(key);
    refreshGiveaway(guild, id).catch(console.error);
  }, 3000));
}

async function gwJoin(i) {
  const gw = getG(i.guildId).giveaways[i.message.id];
  if (!gw) return i.reply({ content: "❌ This giveaway no longer exists.", flags: EPH });
  if (gw.ended || Date.now() >= gw.endAt) return i.reply({ content: '⏰ This giveaway is over.', flags: EPH });
  if (gw.requiredRole && !i.member.roles.cache.has(gw.requiredRole)) {
    return i.reply({
      content: `❌ You need the role <@&${gw.requiredRole}> to participate.`,
      flags: EPH, allowedMentions: { parse: [] },
    });
  }
  if (gw.minInvites) {
    const have = invNet(getG(i.guildId).invites.stats[i.user.id]);
    if (have < gw.minInvites) {
      return i.reply({
        content: `❌ You need at least **${gw.minInvites}** invitation(s) to participate (you have **${have}**).` +
          'Check with `/invites`.',
        flags: EPH,
      });
    }
  }
  if (gw.entrants.includes(i.user.id)) {
    return i.reply({
      content: '✅ You are already participating in this giveaway.',
      flags: EPH,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw_leave:${i.message.id}`).setLabel('Leave the giveaway').setStyle(ButtonStyle.Danger))],
    });
  }
  gw.entrants.push(i.user.id);
  save();
  await i.reply({ content: '🎉 Registered entry, good luck!', flags: EPH });
  scheduleGwUpdate(i.guild, i.message.id);
}

async function gwLeave(i) {
  const id = i.customId.split(':')[1];
  const gw = getG(i.guildId).giveaways[id];
  if (!gw || gw.ended) return i.update({ content: '⏰ This giveaway is over.', components: [] });
  gw.entrants = gw.entrants.filter((u) => u !== i.user.id);
  save();
  await i.update({ content: '👋 You are no longer participating in this giveaway.', components: [] });
  scheduleGwUpdate(i.guild, id);
}

/* ------------------------------------------------------------------ */
/*  Accès aux catégories : contenu visible / salons visibles sans historique */
/* ------------------------------------------------------------------ */
async function applyAccessTo(ch, cfg) {
  if (!ch.permissionOverwrites) return;
  const has = (id) => ch.guild.roles.cache.has(id) || id === ch.guild.id;
  for (const id of (cfg.content || []).filter(has)) {
    await ch.permissionOverwrites.edit(id, {
      ViewChannel: true,
      ReadMessageHistory: true,
    }, { reason: 'Category access (content)' }).catch(console.error);
  }
  for (const id of (cfg.preview || []).filter(has)) {
    await ch.permissionOverwrites.edit(id, {
      ViewChannel: true,
      ReadMessageHistory: false,
    }, { reason: 'Category access (trade channels only)' }).catch(console.error);
  }
}

async function applyCategoryAccess(guild, categoryId) {
  const cfg = getG(guild.id).catAccess[categoryId];
  if (!cfg) return false;
  const cat = await guild.channels.fetch(categoryId).catch(() => null);
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    delete getG(guild.id).catAccess[categoryId];
    save();
    return false;
  }
  await applyAccessTo(cat, cfg);
  for (const ch of guild.channels.cache.filter((c) => c.parentId === categoryId).values()) {
    await applyAccessTo(ch, cfg);
  }
  return true;
}

async function syncCategoryAccess(guild) {
  for (const id of Object.keys(getG(guild.id).catAccess)) {
    await applyCategoryAccess(guild, id).catch(console.error);
  }
}

/* ------------------------------------------------------------------ */
/*  Mise à jour automatique de TOUS les systèmes                       */
/* ------------------------------------------------------------------ */
// Lancée à chaque démarrage du bot : plus rien à renvoyer à la main après une mise à jour du code
async function refreshGuild(guild) {
  const steps = [
    ['commands channel', () => syncCommandChannel(guild)],
    ['category access', () => syncCategoryAccess(guild)],
    ['ticket panels', () => refreshPanels(guild)],
    ['sales panel', () => refreshSalesPanel(guild)],
    ['autoroles', () => syncAutoroles(guild)],
    ['giveaways', () => refreshGiveaways(guild)],
    ['invitation leaderboard', () => refreshBoard(guild)],
  ];
  for (const [name, fn] of steps) {
    await fn().catch((e) => console.error(`[maj auto] ${name} :`, e));
  }
}

/* ------------------------------------------------------------------ */
/*  Gestion des listes de rôles (/roles-mod et /roles-proteges)        */
/* ------------------------------------------------------------------ */
function roleListHandler(key, title, ownerOnly = false) {
  return async (i) => {
    if (ownerOnly ? !isOwner(i) : !hasFullAccess(i)) {
      return i.reply({
        content: ownerOnly
          ? '❌ Only the server owner (👑) can use this command.'
          : '❌ Reserved for the owner (👑) and roles with full access.',
        flags: EPH,
      });
    }
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const txt = d[key].length
        ? d[key].map((id) => `• <@&${id}>`).join('\n')
        : 'No roles at the moment.';
      return i.reply({ content: `**${title}**\n${txt}`, flags: EPH, allowedMentions: { parse: [] } });
    }

    const role = i.options.getRole('role', true);
    if (role.id === i.guild.id) {
      return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
    }

    if (sub === 'ajouter') {
      if (!d[key].includes(role.id)) d[key].push(role.id);
      save();
      if (key !== 'protectedRoles') syncCommandChannel(i.guild).catch(console.error);
      return i.reply({ content: `✅ <@&${role.id}> added to: **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
    }

    d[key] = d[key].filter((id) => id !== role.id);
    save();
    if (key !== 'protectedRoles') syncCommandChannel(i.guild).catch(console.error);
    return i.reply({ content: `🗑️ <@&${role.id}> removed from: **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
  };
}

/* ------------------------------------------------------------------ */
/*  Aide (/help) : chaque section n'est visible que par ceux qui y ont droit */
/* ------------------------------------------------------------------ */
// level : public = tout le monde · mod = modérateurs · full = accès total · owner = propriétaire (👑)
const HELP = [
  { title: '⭐ Reviews (vouch)', level: 'public', lines: [
    'In a ticket, click the **Vouch** button (⭐) to rate the deal out of 5 stars and leave a message. Your review is posted in the vouch channel.',
    '`/help` — see the commands you have access to',
  ] },
  { title: '📨 Invitations', level: 'public', lines: [
    "`/invites` — see your number of invitations",
  ] },
  { title: '🛡️ Moderation', level: 'mod', lines: [
    '`/ban` — ban a member',
    '`/unban` — unban a user',
    '`/mute` — mute a member for a duration',
    '`/unmute` — unmute',
    '`/sanctions-actives` — current bans and transfers',
    "`/historique-sanctions` — member history",
  ] },
  { title: '🎉 Giveaways', level: 'full', lines: [
    '`/giveaway creer` — launch a giveaway (required role, minimum invitations…)',
    '`/giveaway terminer` — finish now and draw the winners',
    '`/giveaway reroll` — draw a new winner',
    '`/giveaway annuler` — cancel and delete the message',
    '`/giveaway liste` — ongoing giveaways',
  ] },
  { title: '📢 Announcements & roles', level: 'full', lines: [
    '`/annonce` — send an announcement (title, text, images, mentions). Type @User, @Role or #channel: they become clickable',
    '`/product creer` — product announcement: custom text, image, logo and unlimited link buttons',
    '`/restock creer` — restock panel: variant / price / stock, image, logo and link buttons',
    '`/autorole creer` · `liste` · `supprimer` — reaction that gives a role',
    '`/role-arrivee ajouter` · `retirer` · `liste` — role automatically given to new members',
    '`/bienvenue configurer` · `activer` · `desactiver` · `test`',
  ] },
  { title: '📈 Invitations (admin)', level: 'full', lines: [
    '`/invites-config recompense-ajouter` · `recompense-retirer` · `liste` · `reset`',
    '`/lien-invite creer` · `liste` · `supprimer` — links dedicated to a member',
    '`/qui-a-invite` — whose link a member arrived with',
    '`/classement-invites` — send the leaderboard',
    '`/classement-invites-maj` — force update',
  ] },
  { title: '🎫 Tickets', level: 'full', lines: [
    '`/setup-paiement` — sets up the whole payment ticket in one command (DM menu, categories, panel)',
    '`/ticket config-creer` · `config-liste` · `config-supprimer`',
    '`/ticket staff-ajouter` · `staff-retirer`',
    '`/ticket ajouter` · `retirer` — add or remove a member from the ticket where you type the command',
    '`/add` · `/remove` — quick versions of the same thing (ticket creator and staff)',
    '`/ticket raison-ajouter` · `raison-modifier` · `raison-retirer` — panel menu categories (personal emoji + linked server category)',
    '`/ticket panel` — send the panel (banner, menu or colored button, without text possible) to a channel',
    "`/ticket message` — edit the ticket opening message (per panel or for the entire config)",
    '`/ticket bouton` — change button color/text of an already sent panel',
    '`/ticket couleur` — a single color for **all panels** (or one configuration)',
    '`/ticket vouch-salon` · `vouch-activer` · `vouch-desactiver` — channel and activation for `/vouch` reviews',
    '`/ticket ventes-salon` · `ventes-panel` · `ventes-devise` — sales tracking panel, updated after each sale',
  ] },
  { title: '🗂️ Sub-panels', level: 'full', lines: [
    '`/sous-panel creer` · `modifier` · `supprimer` — a 2nd menu offered after choosing a panel category',
    '`/sous-panel choix-ajouter` · `choix-modifier` · `choix-retirer` — sub-panel choices (emoji, server category, staff, next sub-panel: as many levels as you want)',
    '`/sous-panel choix-suivant` — the same next subpanel for all choices of one subpanel at once',
    '`/sous-panel lier` — the same subpanel for all categories, or a different one per category',
    '`/sous-panel delier` · `liste` — remove a link · see who is using what',
  ] },
  { title: '⚙️ Server & access', level: 'full', lines: [
    '`/salon-commandes` — private channel for commands (and its roles)',
    '`/salon-sanctions` — default channel for ban/mute announcements',
    '`/membercount` — voice channel with number of members',
    '`/acces-categorie` — who sees the content / only the channels in a category',
    '`/roles-mod` — roles allowed to moderate',
    '`/roles-proteges` — roles that moderators cannot sanction',
  ] },
  { title: '👑 Owner', level: 'owner', lines: [
    '`/role-total` — roles with access to ALL commands',
    '`/permissions` — choose which role has access to which command',
    '`/permissions-categorie` — give a role a whole category of commands',
    '`/commandes` — enable / disable commands',
  ] },
];
const HELP_LEVEL = { public: () => true, mod: canModerate, full: hasFullAccess, owner: isOwner };

/* ------------------------------------------------------------------ */
/*  Enregistrement des commandes (par serveur, pour pouvoir en retirer) */
/* ------------------------------------------------------------------ */
// Retire les commandes désactivées avec /commandes.
// Une commande à laquelle des rôles ont été donnés (/permissions) devient visible dans la liste Discord
// (l'accès réel reste vérifié par le bot) ; les autres restent masquées pour les membres.
async function registerCommands(guild) {
  const d = getG(guild.id);
  const body = commands
    .filter((c) => ALWAYS_ON.has(c.name) || !d.disabledCommands.includes(c.name))
    .map((c) => {
      const cat = CMD_CATEGORY[c.name];
      const visible = PUBLIC_COMMANDS.has(c.name) || TICKET_MEMBER_COMMANDS.has(c.name) ||
        d.cmdPerms[c.name]?.length ||
        (cat && d.catPerms[cat]?.length) ||
        (MOD_COMMANDS.has(c.name) && d.modRoles.length);
      return c.setDefaultMemberPermissions(visible ? null : '0').toJSON();
    });
  await guild.commands.set(body).catch((e) => console.error('[commandes]', guild.name, e.message));
}

/* ------------------------------------------------------------------ */
/*  Gestionnaires de commandes                                         */
/* ------------------------------------------------------------------ */
const handlers = {
  /* ---------- /add et /remove (ticket) ---------- */
  async add(i) {
    return ticketMemberAction(i, 'add');
  },
  async remove(i) {
    return ticketMemberAction(i, 'remove');
  },

  /* ---------- /vouch ---------- */
  async vouch(i) {
    return vouchPanel(i);
  },

  /* ---------- /help ---------- */
  async help(i) {
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('📖 Your orders').setTimestamp();
    for (const s of HELP) {
      if (HELP_LEVEL[s.level](i)) embed.addFields({ name: s.title, value: s.lines.join('\n').slice(0, 1024) });
    }
    // Le salon des commandes n'est indiqué qu'à ceux qui peuvent le voir
    const cc = getG(i.guildId).commandChannelId;
    const ccCh = cc && i.guild.channels.cache.get(cc);
    if (ccCh && ccCh.permissionsFor(i.member)?.has(PermissionFlagsBits.ViewChannel)) {
      embed.setDescription(`Commands are used in <#${cc}>.`);
    }
    return i.reply({ embeds: [embed], flags: EPH });
  },

  /* ---------- /salon-commandes ---------- */
  async 'salon-commandes'(i) {
    const cat = i.options.getChannel('categorie');
    const raw = i.options.getString('nom');
    const name = raw
      ? raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').slice(0, 90) || 'commandes'
      : null;
    const picked = ['role', 'role2', 'role3'].map((n) => i.options.getRole(n)).filter(Boolean);
    if (picked.some((r) => r.id === i.guild.id)) {
      return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    const d = getG(i.guildId);

    try {
      let ch = d.commandChannelId ? await i.guild.channels.fetch(d.commandChannelId).catch(() => null) : null;
      if (!ch && !cat) return i.editReply('❌ Specify a **category** to create the channel.');

      // Rôles ajoutés à la main (en plus des rôles /role-total et /roles-mod)
      if (i.options.getBoolean('vider-roles')) d.commandChannelRoles = [];
      for (const r of picked) if (!d.commandChannelRoles.includes(r.id)) d.commandChannelRoles.push(r.id);
      save();

      if (ch) {
        // Le salon existe déjà : on le renomme / déplace si demandé et on remet les permissions
        await ch.edit({
          ...(name && { name }),
          ...(cat && { parent: cat.id }),
          permissionOverwrites: commandChannelOverwrites(i.guild),
        });
      } else {
        ch = await i.guild.channels.create({
          name: name || 'commandes',
          type: ChannelType.GuildText,
          parent: cat.id,
          topic: 'Private channel: all bot commands are made here.',
          permissionOverwrites: commandChannelOverwrites(i.guild),
        });
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('⌨️ Commands channel')
            .setDescription(
              "All bot commands are used **here**.\n" +
              "If a command is typed in another channel, the bot does not execute it.\n" +
              'The answers are **private**: you only see yours. Handwritten messages here are deleted.\n\n' +
              'This channel is invisible to members. Everyone can only use the commands to which they are entitled (`/help`).')],
        }).catch(console.error);
      }
      d.commandChannelId = ch.id;
      save();

      const extra = d.commandChannelRoles.length
        ? d.commandChannelRoles.map((id) => `<@&${id}>`).join(' ')
        : 'none';
      await i.editReply({
        content:
          `✅ Commands channel ready: <#${ch.id}>\n` +
          `• Roles added by hand: ${extra}\n` +
          '• The roles `/role-total` and `/roles-mod` always have access.\n' +
          "• A role added here sees the channel but has **no** more commands: it only keeps `/help` and `/invites`.\n" +
          '• `/help` and `/invites` remain usable everywhere.\n' +
          '• Commands typed elsewhere are refused (message visible only to the person who typed the command).',
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(e);
      await i.editReply('❌ Unable to create channel. I need the **Manage Channels** and **Manage roles** permissions (and I have access to this category).');
    }
  },

  /* ---------- /giveaway ---------- */
  async giveaway(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'liste') {
      const active = Object.entries(d.giveaways).filter(([, g]) => !g.ended).sort((a, b) => a[1].endAt - b[1].endAt);
      if (!active.length) return i.reply({ content: 'No giveaway in progress. Start one with `/giveaway creer`.', flags: EPH });
      const lines = active.map(([id, g]) =>
        `🎉 **${g.prize}** · <#${g.channelId}> · fin <t:${Math.floor(g.endAt / 1000)}:R> · ${g.entrants.length} participant(s)` +
        `${g.minInvites ? ` · 📨 min. ${g.minInvites}` : ''} · ` +
        `[message](https://discord.com/channels/${i.guildId}/${g.channelId}/${id})`);
      const embed = new EmbedBuilder().setColor('#F1C40F').setTitle('🎉 Giveaways en cours')
        .setDescription(fitLines(lines, 4000));
      return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
    }

    if (sub === 'creer') {
      const salon = i.options.getChannel('salon', true);
      const prize = i.options.getString('lot', true).trim();
      const amount = i.options.getInteger('duree', true);
      const unit = i.options.getString('unite', true);
      const winners = i.options.getInteger('gagnants') ?? 1;
      const description = (i.options.getString('description') || '').trim();
      const role = i.options.getRole('role-requis');
      const minInvites = i.options.getInteger('invites-min') ?? 0;
      const mentionOpt = i.options.get('mention');
      const ping = i.options.getString('ping');
      const img = i.options.getAttachment('image');

      const duration = amount * UNITS[unit];
      if (duration > MAX_GW) return i.reply({ content: '❌ Maximum duration: 365 days.', flags: EPH });
      if (role && role.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
      if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
        return i.reply({ content: '❌ You need permission to mention @everyone.', flags: EPH });
      }

      await i.deferReply({ flags: EPH });
      const gwa = getG(i.guildId).announce?.giveaway || {};
      const hostId = await resolveMemberId(i.guild, gwa.host) || i.user.id;
      const gw = {
        channelId: salon.id, prize, description, winners,
        endAt: Date.now() + duration, hostId,
        requiredRole: role?.id || null,
        minInvites,
        entrants: [], ended: false, winnerIds: [],
      };
      try {
        // @Pseudo / @Rôle / #salon dans la description -> mentions cliquables
        const rd = await rich(i.guild, description);
        gw.description = rd.text.slice(0, 1500);
        // Ligne « Organized by » personnalisée depuis le dashboard (le @ peut être n'importe qui).
        if (gwa.line) gw.hostLine = (await announceText(i.guild, gwa.line, { host: `<@${hostId}>`, prize, winners })).slice(0, 1024);

        const embed = new EmbedBuilder()
          .setColor('#F1C40F')
          .setTitle(`🎉 ${prize}`.slice(0, 256))
          .setDescription(gwDescription(gw).slice(0, 4096))
          .setFooter({ text: 'Se termine' })
          .setTimestamp(new Date(gw.endAt));
        const files = [];
        if (img) {
          const f = await toFile(img, 'giveaway');
          files.push(f);
          embed.setImage(`attachment://${f.name}`);
        }
        const row = gwRow(gw);
        const { content, allowed } = buildMentions(ping, mentionOpt, rd);
        const msg = await salon.send({ content, embeds: [embed], files, components: [row], allowedMentions: allowed });
        gw.sig = sig(row.toJSON());
        d.giveaways[msg.id] = gw;
        save();
        await i.editReply(
          `✅ Giveaway launched in <#${salon.id}> (end <t:${Math.floor(gw.endAt / 1000)}:R>).` +
          'The draw is done by itself at the end.');
      } catch (e) {
        console.error('[giveaway]', e);
        await i.editReply("❌ Unable to launch the giveaway (check my permissions in this channel and the image).");
      }
      return;
    }

    const id = i.options.getString('giveaway', true);
    const gw = d.giveaways[id];
    if (!gw) return i.reply({ content: '❌ Giveaway not found.', flags: EPH });

    if (sub === 'terminer') {
      if (gw.ended) return i.reply({ content: '❌ This giveaway has already ended.', flags: EPH });
      await i.deferReply({ flags: EPH });
      const r = await endGiveaway(i.guild, id);
      if (!r.ok) return i.editReply(`❌ Unable to complete this giveaway: ${r.reason}.`);
      return i.editReply(r.winners.length
        ? `✅ Giveaway ended. Winner${r.winners.length > 1 ? 's' : ''}: ${r.winners.map((w) => `<@${w}>`).join(', ')}`
        : '✅ Giveaway ended: no valid participants.');
    }

    if (sub === 'annuler') {
      await i.deferReply({ flags: EPH });
      const { msg } = await fetchMsg(i.guild, gw.channelId, id);
      delete d.giveaways[id];
      save();
      if (msg) await msg.delete().catch(() => {});
      return i.editReply('🗑️ Giveaway canceled and message deleted.');
    }

    // reroll
    if (!gw.ended) return i.reply({ content: "❌ This giveaway is not over yet. Uses `/giveaway terminer`.", flags: EPH });
    await i.deferReply({ flags: EPH });
    const { msg } = await fetchMsg(i.guild, gw.channelId, id);
    if (!msg) return i.editReply('❌ The giveaway message could not be found.');
    const n = i.options.getInteger('nombre') ?? 1;
    const valid = await validEntrants(i.guild, gw);
    const winners = pickWinners(valid, n, gw.winnerIds);
    gw.winnerIds.push(...winners);
    save();
    await announceWinners(msg, gw, winners, true);
    return i.editReply(winners.length
      ? `✅ Nouveau tirage : ${winners.map((w) => `<@${w}>`).join(', ')}`
      : '❌ No other valid participants.');
  },

  /* ---------- /invites (tout le monde) ---------- */
  async invites(i) {
    const asked = i.options.getUser('membre');
    if (asked && asked.id !== i.user.id && !hasFullAccess(i)) {
      return i.reply({ content: '❌ You can only see your own invitations.', flags: EPH });
    }
    const user = asked || i.user;
    const d = getG(i.guildId).invites;
    const s = d.stats[user.id] || { joins: 0, left: 0 };
    const n = invNet(s);
    const next = d.rewards.filter((r) => r.count > n).sort((a, b) => a.count - b.count)[0];

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
      .setTitle('📨 Invitations')
      .addFields(
        { name: 'Invitations', value: `**${n}**`, inline: true },
        { name: 'Arrivals', value: String(s.joins), inline: true },
        { name: 'Departures', value: String(s.left || 0), inline: true },
      );
    if (next) {
      embed.addFields({
        name: 'Next reward',
        value: `<@&${next.roleId}> to **${next.count}** invitations (again ${next.count - n})`,
      });
    }
    return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
  },

  /* ---------- /invites-config ---------- */
  async 'invites-config'(i) {
    const d = getG(i.guildId).invites;
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const txt = [...d.rewards].sort((a, b) => a.count - b.count)
        .map((r) => `• **${r.count}** invitations → <@&${r.roleId}>`).join('\n') || 'No reward.';
      return i.reply({ content: `**Invitation Rewards**\n${txt}`, flags: EPH, allowedMentions: { parse: [] } });
    }

    if (sub === 'recompense-retirer') {
      const nb = i.options.getInteger('nombre', true);
      const before = d.rewards.length;
      d.rewards = d.rewards.filter((r) => r.count !== nb);
      save();
      return i.reply({
        content: d.rewards.length < before
          ? '🗑️ Reward deleted (roles already given are kept).'
          : '❌ No reward for this number.',
        flags: EPH,
      });
    }

    if (sub === 'reset') {
      const user = i.options.getUser('membre', true);
      delete d.stats[user.id];
      for (const [uid, inviter] of Object.entries(d.joinedBy)) if (inviter === user.id) delete d.joinedBy[uid];
      save();
      return i.reply({ content: `✅ <@${user.id}> invitations reset.`, flags: EPH, allowedMentions: { parse: [] } });
    }

    // recompense-ajouter
    const nb = i.options.getInteger('nombre', true);
    const roleOpt = i.options.getRole('role', true);
    const role = i.guild.roles.cache.get(roleOpt.id);
    if (!role || role.id === i.guild.id || role.managed) {
      return i.reply({ content: '❌ Choose a normal role (not @everyone or a bot role).', flags: EPH });
    }
    if (!role.editable) {
      return i.reply({ content: '❌ My role must be **above** this role in the role list.', flags: EPH });
    }
    await i.deferReply({ flags: EPH });
    d.rewards = d.rewards.filter((r) => r.count !== nb);
    d.rewards.push({ count: nb, roleId: role.id });
    save();

    // Les membres qui ont déjà assez d'invitations reçoivent le rôle tout de suite
    for (const [uid, s] of Object.entries(d.stats)) {
      if (invNet(s) >= nb) await checkInviteRewards(i.guild, uid);
    }
    return i.editReply({
      content: `✅ From **${nb}** invitations, the role <@&${role.id}> will be given automatically.`,
      allowedMentions: { parse: [] },
    });
  },

  /* ---------- /lien-invite ---------- */
  async 'lien-invite'(i) {
    const d = getG(i.guildId).invites;
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const lines = Object.entries(d.links).map(([code, l]) =>
        `• https://discord.gg/${code} → <@${l.userId}> · ${l.joins || 0} arrival(s) · created by <@${l.createdBy}>`);
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle("🔗 Dedicated invite links")
        .setDescription(lines.length ? fitLines(lines, 4000) : 'No dedicated link. Create one with `/lien-invite creer`.');
      return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
    }

    if (sub === 'supprimer') {
      const code = i.options.getString('lien', true).trim().replace(/^.*\//, '');
      if (!d.links[code]) return i.reply({ content: '❌ This link n\' is not a dedicated link.', flags: EPH });
      await i.deferReply({ flags: EPH });
      await i.guild.invites.delete(code, `Deleted by ${i.user.tag}`).catch(() => {});
      delete d.links[code];
      save();
      await snapshotInvites(i.guild);
      return i.editReply('🗑️ Link removed (arrivals already counted are retained).');
    }

    // creer
    const user = i.options.getUser('membre', true);
    if (user.bot) return i.reply({ content: '❌ Choose a real member (not a bot).', flags: EPH });
    const salon = i.options.getChannel('salon', true);
    const maxUses = i.options.getInteger('max-utilisations') ?? 0;
    const days = i.options.getInteger('expire-jours') ?? 0;
    await i.deferReply({ flags: EPH });
    try {
      const inv = await salon.createInvite({
        maxAge: days * 86400, maxUses, unique: true,
        reason: `Link dedicated to ${user.tag} (created by ${i.user.tag})`,
      });
      d.links[inv.code] = { userId: user.id, createdBy: i.user.id, createdAt: Date.now(), joins: 0 };
      save();
      const m = inviteCache.get(i.guildId) || new Map();
      m.set(inv.code, { uses: 0, maxUses, inviterId: user.id });
      inviteCache.set(i.guildId, m);
      return i.editReply({
        content: `✅ Link dedicated to <@${user.id}>: https://discord.gg/${inv.code}\n` +
          `Each person who joins with this link counts as an invite from <@${user.id}>.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(e);
      return i.editReply("❌ Unable to create the link: I need permission **Create an invitation** in this channel.");
    }
  },

  /* ---------- /qui-a-invite ---------- */
  async 'qui-a-invite'(i) {
    const user = i.options.getUser('membre', true);
    const d = getG(i.guildId).invites;
    let v = d.joinedVia[user.id];
    if (!v && d.joinedBy[user.id]) v = { code: null, inviterId: d.joinedBy[user.id], at: null }; // anciennes données
    if (!v) {
      return i.reply({
        content: "❌ No info for this member: it arrived before tracking or the bot could not determine the link.",
        flags: EPH,
      });
    }
    const dedicated = v.code && d.links[v.code];
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
      .setTitle('🔎 Origin of arrival')
      .addFields(
        { name: 'Guest by', value: v.inviterId ? `<@${v.inviterId}>` : 'Unknown (custom link or not detected)', inline: true },
        { name: 'Type', value: dedicated ? '🔗 Dedicated link' : 'Classic invitation', inline: true },
        { name: 'Lien', value: v.code ? `https://discord.gg/${v.code}` : 'Inconnu' },
      );
    if (v.at) embed.addFields({ name: 'Arrived', value: `<t:${Math.floor(v.at / 1000)}:F>` });
    return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
  },

  /* ---------- /permissions (👑) ---------- */
  async permissions(i) {
    if (!isOwner(i)) return i.reply({ content: '❌ Only the server owner (👑) can use this command.', flags: EPH });
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const lines = Object.entries(d.cmdPerms).filter(([, ids]) => ids.length)
        .map(([c, ids]) => `• \`/${c}\` → ${ids.map((id) => `<@&${id}>`).join(' ')}`);
      return i.reply({
        content: `**Roles allowed per command**\n${fitLines(lines, 1800)}\n\n` +
          '_Full access roles (/role-total) and the owner always have access to everything._',
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    const name = i.options.getString('commande', true);
    const role = i.options.getRole('role', true);
    if (!commands.some((c) => c.name === name)) return i.reply({ content: '❌ Unknown command.', flags: EPH });
    if (OWNER_ONLY.has(name)) return i.reply({ content: '❌ This command is reserved for the owner.', flags: EPH });
    if (role.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });

    await i.deferReply({ flags: EPH });
    const list = (d.cmdPerms[name] ??= []);
    if (sub === 'ajouter') {
      if (!list.includes(role.id)) list.push(role.id);
    } else {
      d.cmdPerms[name] = list.filter((id) => id !== role.id);
      if (!d.cmdPerms[name].length) delete d.cmdPerms[name];
    }
    save();
    await registerCommands(i.guild);
    await syncCommandChannel(i.guild);
    return i.editReply({
      content: sub === 'ajouter'
        ? `✅ <@&${role.id}> peut maintenant utiliser \`/${name}\`.`
        : `🗑️ <@&${role.id}> no longer has access to \`/${name}\`.`,
      allowedMentions: { parse: [] },
    });
  },

  /* ---------- /permissions-categorie (👑) ---------- */
  async 'permissions-categorie'(i) {
    if (!isOwner(i)) return i.reply({ content: '❌ Only the server owner (👑) can use this command.', flags: EPH });
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const txt = Object.entries(CMD_CATEGORIES).map(([key, c]) =>
        `**${c.label}** — ${c.commands.map((name) => `\`/${name}\``).join(' ')}\n→ ` +
        (d.catPerms[key]?.length ? d.catPerms[key].map((id) => `<@&${id}>`).join(' ') : 'no role')
      ).join('\n\n');
      return i.reply({ content: txt.slice(0, 1990), flags: EPH, allowedMentions: { parse: [] } });
    }

    const key = i.options.getString('categorie', true);
    const role = i.options.getRole('role', true);
    if (!CMD_CATEGORIES[key]) return i.reply({ content: '❌ Unknown category.', flags: EPH });
    if (role.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });

    await i.deferReply({ flags: EPH });
    const list = (d.catPerms[key] ??= []);
    if (sub === 'ajouter') {
      if (!list.includes(role.id)) list.push(role.id);
    } else {
      d.catPerms[key] = list.filter((id) => id !== role.id);
      if (!d.catPerms[key].length) delete d.catPerms[key];
    }
    save();
    await registerCommands(i.guild);
    await syncCommandChannel(i.guild);
    return i.editReply({
      content: sub === 'ajouter'
        ? `✅ <@&${role.id}> can now use every command in **${CMD_CATEGORIES[key].label}**.`
        : `🗑️ <@&${role.id}> no longer has access to **${CMD_CATEGORIES[key].label}**.`,
      allowedMentions: { parse: [] },
    });
  },

  /* ---------- /acces-categorie ---------- */
  async 'acces-categorie'(i) {
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const lines = Object.entries(d.catAccess).map(([id, cfg]) =>
        `📁 <#${id}>\n• 👁️ Contenu visible : ${(cfg.content || []).length ? cfg.content.map((r) => r === i.guildId ? '@everyone' : `<@&${r}>`).join(' ') : 'none'}` +
        `\n• 🚪 Visible channels without content: ${(cfg.preview || []).length ? cfg.preview.map((r) => r === i.guildId ? '@everyone' : `<@&${r}>`).join(' ') : 'none'}`
      );
      return i.reply({
        content: lines.length ? lines.join('\n\n').slice(0, 1990) : 'No categories configured. Uses `/acces-categorie contenu` or `apercu`.',
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    const cat = i.options.getChannel('categorie', true);
    const role = i.options.getRole('role', true);
    await i.deferReply({ flags: EPH });
    const cfg = (d.catAccess[cat.id] ??= { content: [], preview: [] });
    cfg.content ??= [];
    cfg.preview ??= [];
    const without = (arr) => arr.filter((id) => id !== role.id);
    const label = role.id === i.guildId ? '@everyone' : `<@&${role.id}>`;

    try {
      const targets = [cat, ...i.guild.channels.cache.filter((ch) => ch.parentId === cat.id).values()];
      if (sub === 'retirer') {
        cfg.content = without(cfg.content);
        cfg.preview = without(cfg.preview);
        if (!cfg.content.length && !cfg.preview.length) delete d.catAccess[cat.id];
        save();
        for (const ch of targets) {
          await ch.permissionOverwrites.edit(role.id, { ViewChannel: null, ReadMessageHistory: null }).catch(() => {});
        }
        return i.editReply({ content: `🗑️ ${label} rules removed on **${cat.name}**.`, allowedMentions: { parse: [] } });
      }

      cfg.content = without(cfg.content);
      cfg.preview = without(cfg.preview);
      (sub === 'contenu' ? cfg.content : cfg.preview).push(role.id);
      save();
      await applyCategoryAccess(i.guild, cat.id);
      return i.editReply({
        content: sub === 'contenu'
          ? `✅ ${label} sees the channels in **${cat.name}** and their content.`
          : `✅ ${label} sees **${cat.name}**'s channels but not their history.\nℹ️ New messages sent while the channel is open remain visible live: this is a Discord limit.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(e);
      return i.editReply('❌ Unable to change permissions. I need to **Manage Channels** and **Manage roles**, with my role above the others.');
    }
  },

  /* ---------- /commandes (👑) ---------- */
  async commandes(i) {
    if (!isOwner(i)) return i.reply({ content: '❌ Only the server owner (👑) can use this command.', flags: EPH });
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const lines = commands.map((c) =>
        `${d.disabledCommands.includes(c.name) ? '⛔' : '✅'} \`/${c.name}\`${ALWAYS_ON.has(c.name) ? ' (toujours active)' : ''}`);
      return i.reply({ content: lines.join('\n').slice(0, 1990), flags: EPH });
    }

    const name = i.options.getString('commande', true);
    if (!commands.some((c) => c.name === name)) return i.reply({ content: '❌ Unknown command.', flags: EPH });

    if (sub === 'desactiver') {
      if (ALWAYS_ON.has(name)) return i.reply({ content: '❌ This command cannot be disabled.', flags: EPH });
      if (d.disabledCommands.includes(name)) return i.reply({ content: '❌ Already disabled.', flags: EPH });
      await i.deferReply({ flags: EPH });
      d.disabledCommands.push(name);
      save();
      await registerCommands(i.guild);
      return i.editReply(`⛔ \`/${name}\` removed from Discord. Put it back with \`/activate\` commands.`);
    }

    // activer
    if (!d.disabledCommands.includes(name)) return i.reply({ content: "❌ This command is not disabled.", flags: EPH });
    await i.deferReply({ flags: EPH });
    d.disabledCommands = d.disabledCommands.filter((n) => n !== name);
    save();
    await registerCommands(i.guild);
    return i.editReply(`✅ \`/${name}\` is back (Discord may take a few seconds to display it).`);
  },

  /* ---------- /classement-invites ---------- */
  async 'classement-invites'(i) {
    const salon = i.options.getChannel('salon', true);
    const top = i.options.getInteger('top') ?? 10;
    await i.deferReply({ flags: EPH });
    try {
      const embed = buildInviteBoard(i.guild, top);
      const msg = await salon.send({ embeds: [embed], allowedMentions: { parse: [] } });
      getG(i.guildId).invites.board = {
        channelId: salon.id, messageId: msg.id, top, sig: sig(embed.data.description),
      };
      save();
      await i.editReply(`✅ Leaderboard sent to <#${salon.id}>. It updates automatically (every 5 minutes).`);
    } catch (e) {
      console.error(e);
      await i.editReply('❌ Unable to send: check my permissions in this channel.');
    }
  },

  /* ---------- /classement-invites-maj ---------- */
  async 'classement-invites-maj'(i) {
    const b = getG(i.guildId).invites.board;
    if (!b) return i.reply({ content: "❌ No rankings sent. Use `/classement-invites` first.", flags: EPH });
    await i.deferReply({ flags: EPH });
    const r = await refreshBoard(i.guild, true);
    if (r === 'missing') return i.editReply('❌ The leaderboard message has been deleted. Return it with `/classement-invites`.');
    if (r !== 'ok') return i.editReply('❌ Failed to change leaderboard message.');
    return i.editReply(`✅ Updated ranking: https://discord.com/channels/${i.guildId}/${b.channelId}/${b.messageId}`);
  },

  /* ---------- /roles-mod & /roles-proteges (👑) ---------- */
  'role-total': roleListHandler('fullRoles', 'Roles with access to all commands', true),
  'roles-mod': roleListHandler('modRoles', 'Roles allowed to moderate (ban - unban - mute - unmute)'),
  'roles-proteges': roleListHandler('protectedRoles', 'Protected roles (neither muted nor banned by moderators)'),

  /* ---------- /membercount ---------- */
  async membercount(i) {
    await i.deferReply({ flags: EPH });
    const d = getG(i.guildId);
    d.memberCountFormat = i.options.getString('format') || d.memberCountFormat;
    if (!d.memberCountFormat.includes('{count}')) d.memberCountFormat += ' {count}';

    if (d.memberCountChannel) {
      await i.guild.channels.cache.get(d.memberCountChannel)?.delete().catch(() => {});
    }
    const ch = await i.guild.channels.create({
      name: d.memberCountFormat.replace('{count}', i.guild.memberCount).slice(0, 100),
      type: ChannelType.GuildVoice,
      position: 0,
      permissionOverwrites: [
        { id: i.guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
      ],
    });
    d.memberCountChannel = ch.id;
    save();
    await i.editReply(`✅ Channel created: <#${ch.id}>. It updates automatically.`);
  },

  /* ---------- /ban ---------- */
  async ban(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const user = i.options.getUser('membre', true);
    const reason = i.options.getString('raison') || 'No reason provided';
    const days = i.options.getInteger('supprimer_messages') ?? 0;

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const err = targetError(i, user, member);
    if (err) return i.reply({ content: err, flags: EPH });
    if (member && !member.bannable) {
      return i.reply({ content: '❌ I cannot ban this member (his role is above mine).', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    await user.send(`🔨 You have been banned from **${i.guild.name}**.\nReason: ${reason}`).catch(() => {});
    await i.guild.members.ban(user.id, { reason: `${i.user.tag} : ${reason}`, deleteMessageSeconds: days * 86400 });
    banCache.delete(i.guildId);

    // Si le membre était muté, on nettoie son enregistrement
    const d = getG(i.guildId);
    delete d.muted[user.id];
    save();

    // Historique + annonce dans le salon choisi (option "salon") ou le salon par défaut (/salon-sanctions)
    logSanction(d, user.id, { type: 'ban', by: i.user.id, reason, duration: 'final' });
    const sa = d.announce?.sanction || {};
    const byId = await resolveMemberId(i.guild, sa.by) || i.user.id;
    const byMention = `<@${byId}>`;
    await announceSanction(i, i.options.getChannel('salon'),
      await announceText(i.guild, sa.ban || '{member} has been banned (permanently) by {moderator}',
        { member: `<@${user.id}>`, moderator: byMention, reason, duration: 'permanent' }));

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🔨 Member banned')
      .addFields(
        { name: 'Membre', value: `${user.tag} (${user.id})` },
        { name: 'Moderator', value: byMention },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed] });
  },

  /* ---------- /unban ---------- */
  async unban(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const input = i.options.getString('utilisateur', true).trim();
    const reason = i.options.getString('raison') || 'No reason provided';

    await i.deferReply({ flags: EPH });

    // 1) On retrouve l'ID : soit collé / choisi dans la liste, soit un pseudo tapé à la main
    let id = input.replace(/[<@!>]/g, '');
    if (!/^\d{15,25}$/.test(id)) {
      banCache.delete(i.guildId); // liste fraîche
      const list = await getBans(i.guild).catch((e) => { console.error('[unban] reading bans:', e); return null; });
      if (!list) {
        return i.editReply('❌ Unable to read banned list. Verify that I have the **Ban members** permission.');
      }
      const q = input.toLowerCase().replace(/^@/, '');
      const found = list.filter((b) => b.username.toLowerCase() === q || b.tag.toLowerCase() === q);
      if (found.length > 1) return i.editReply('❌ Plusieurs bannis correspondent : utilise l\'ID exact.');
      if (!found.length) {
        return i.editReply("❌ No banned matches. Choose it from the list or paste its ID.");
      }
      id = found[0].id;
    }

    // 2) On débannit directement (pas de pré-vérification fragile) et on interprète l'erreur éventuelle
    try {
      await i.guild.bans.remove(id, `${i.user.tag} : ${reason}`);
    } catch (e) {
      console.error('[unban]', e);
      if (e.code === 10026) return i.editReply("❌ This user is not banned.");
      if (e.code === 50013 || e.code === 50001) {
        return i.editReply('❌ I am missing the **Ban members** permission (or access to this server).');
      }
      return i.editReply(`❌ Unable to unban: ${e.message}`);
    }
    banCache.delete(i.guildId);

    const user = await client.users.fetch(id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Member banned')
      .addFields(
        { name: 'Utilisateur', value: user ? `${user.tag} (${id})` : id },
        { name: 'Moderator', value: `<@${i.user.id}>` },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /mute ---------- */
  async mute(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const user = i.options.getUser('membre', true);
    const amount = i.options.getInteger('duree', true);
    const unit = i.options.getString('unite', true);
    const reason = i.options.getString('raison') || 'No reason provided';
    const duration = amount * UNITS[unit];
    if (duration > MAX_MUTE) return i.reply({ content: '❌ Maximum duration: 365 days.', flags: EPH });

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.reply({ content: "❌ This member is not on the server.", flags: EPH });
    const err = targetError(i, user, member);
    if (err) return i.reply({ content: err, flags: EPH });

    await i.deferReply({ flags: EPH });
    const until = Date.now() + duration;
    try {
      await applyMute(i.guild, member, until, reason, i.user.id);
    } catch (e) {
      console.error(e);
      return i.editReply(
        "❌ Unable to mute this member. My role must be **above** his (ideally at the top of the list)" +
        "and I need **Manage Roles** and **Manage Channels** permissions.");
    }

    // Historique + annonce dans le salon choisi (option "salon") ou le salon par défaut (/salon-sanctions)
    const d = getG(i.guildId);
    logSanction(d, user.id, { type: 'mute', by: i.user.id, reason, duration: `${amount} ${unit}` });
    const sa = d.announce?.sanction || {};
    const byId = await resolveMemberId(i.guild, sa.by) || i.user.id;
    const byMention = `<@${byId}>`;
    await announceSanction(i, i.options.getChannel('salon'),
      await announceText(i.guild, sa.mute || '{member} was muted for {duration} by {moderator}',
        { member: `<@${user.id}>`, moderator: byMention, reason, duration: `${amount} ${unit}` }));

    const ts = Math.floor(until / 1000);
    await user.send(
      `🔇 You have been muted on **${i.guild.name}** until <t:${ts}:F> (<t:${ts}:R>).\nReason: ${reason}`).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🔇 Mute Member')
      .addFields(
        { name: 'Membre', value: `<@${user.id}> (${user.id})` },
        { name: 'Moderator', value: byMention, inline: true },
        { name: 'Duration', value: `${amount} ${unit}`, inline: true },
        { name: 'Nice you mute', value: `<t:${ts}:F> (<t:${ts}:R>)` },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /unmute ---------- */
  async unmute(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const user = i.options.getUser('membre', true);
    const reason = i.options.getString('raison') || 'No reason provided';
    const rec = getG(i.guildId).muted[user.id];

    if (!rec) return i.reply({ content: "❌ This member is not muted.", flags: EPH });
    if (rec.by === i.guild.ownerId && !isOwner(i)) {
      return i.reply({ content: '❌ This mute was set by the owner: only he can remove it.', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    await removeMute(i.guild, user.id, `Unmute par ${i.user.tag} : ${reason}`);
    await user.send(`🔊 You have been unmuted on **${i.guild.name}**.`).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🔊 Member unmute')
      .addFields(
        { name: 'Membre', value: `<@${user.id}> (${user.id})` },
        { name: 'Moderator', value: `<@${i.user.id}>` },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /salon-sanctions ---------- */
  async 'salon-sanctions'(i) {
    const salon = i.options.getChannel('salon', true);
    getG(i.guildId).sanctionChannel = salon.id;
    save();
    return i.reply({
      content: `✅ Bans and mutes will be announced in <#${salon.id}> (unless another channel is chosen in the command).`,
      flags: EPH,
    });
  },

  /* ---------- /sanctions-actives ---------- */
  async 'sanctions-actives'(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);
    await i.deferReply({ flags: EPH });
    const d = getG(i.guildId);

    const bans = await i.guild.bans.fetch().catch(() => null);
    const banLines = bans
      ? [...bans.values()].map((b) => `• <@${b.user.id}> (${b.user.username}) — ${b.reason || 'aucune raison'}`)
      : ['Unable to read the ban list (permission **Ban members**?).'];
    const muteLines = Object.entries(d.muted).map(([id, r]) =>
      `• <@${id}> — fin <t:${Math.floor(r.until / 1000)}:R> — par <@${r.by}> — ${r.reason}`);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📋 Active sanctions')
      .addFields(
        { name: `🔨 Bannis (${bans ? bans.size : '?'})`, value: fitLines(banLines) },
        { name: `🔇 Mutated (${muteLines.length})`, value: fitLines(muteLines) },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /historique-sanctions ---------- */
  async 'historique-sanctions'(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);
    const user = i.options.getUser('membre', true);
    await i.deferReply({ flags: EPH });
    const d = getG(i.guildId);

    const hist = d.history[user.id] || [];
    const banNow = await i.guild.bans.fetch(user.id).catch(() => null);
    const muteNow = d.muted[user.id];

    const nbBan = hist.filter((h) => h.type === 'ban').length;
    const nbMute = hist.filter((h) => h.type === 'mute').length;

    const status = [
      banNow ? '🔨 **Actuellement banni**' : null,
      muteNow ? `🔇 **Currently muted** until <t:${Math.floor(muteNow.until / 1000)}:F>` : null,
    ].filter(Boolean).join('\n') || '✅ No sanctions in progress.';

    const lines = hist.slice().reverse().slice(0, 15).map((h) =>
      `${h.type === 'ban' ? '🔨 Ban' : '🔇 Mute'} — <t:${Math.floor(h.at / 1000)}:d> — ${h.duration} — par <@${h.by}> — ${h.reason}`);

    const embed = new EmbedBuilder()
      .setColor(hist.length || banNow || muteNow ? '#ED4245' : '#57F287')
      .setTitle(`📜 History of ${user.username}`)
      .setDescription((
        `${status}\n\n**Total :** ${nbBan} ban(s) - ${nbMute} mute(s)\n\n` +
        (lines.length
          ? lines.join('\n')
          : "No sanctions recorded.\n*(History starts from this bot update.)*")
      ).slice(0, 4096))
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /annonce ---------- */
  async annonce(i) {
    const salon = i.options.getChannel('salon', true);
    const mentionOpt = i.options.get('mention');
    const ping = i.options.getString('ping');
    const img = i.options.getAttachment('image');
    const thumb = i.options.getAttachment('miniature');

    if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return i.reply({ content: "❌ You need permission to mention @everyone.", flags: EPH });
    }

    const modalId = `annonce_${i.id}`;
    await i.showModal(announceModal(modalId, 'Nouvelle annonce'));

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    await m.deferReply({ flags: EPH });
    try {
      const { embed, files, mentions } = await buildAnnounce(m, img, thumb);
      const { content, allowed } = buildMentions(ping, mentionOpt, mentions);
      await salon.send({ content, embeds: [embed], files, allowedMentions: allowed });
      await m.editReply(`✅ Announcement sent in <#${salon.id}>.`);
    } catch (e) {
      console.error(e);
      await m.editReply("❌ Unable to send ad (check my permissions in this channel and image links).");
    }
  },

  /* ---------- /product ---------- */
  async product(i) {
    return catalogPost(i, 'product');
  },

  /* ---------- /restock ---------- */
  async restock(i) {
    return catalogPost(i, 'restock');
  },

  /* ---------- /message-mp ---------- */
  async 'message-mp'(i) {
    const modalId = `mpmass_${i.id}`;
    await i.showModal(
      new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Mass private message')
        .addComponents(
          field('titre', 'Titre (optionnel)', TextInputStyle.Short, { max: 256 }),
          field('texte', 'Message (Markdown accepted)', TextInputStyle.Paragraph, {
            required: true,
            max: 2000,
            placeholder: 'You can use @Username, @Role, #channel → they become clickable',
          }),
          field('couleur', 'Hex color of the embed (e.g. #5865F2)', TextInputStyle.Short, { max: 7 }),
        ),
    );

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    await m.deferReply({ flags: EPH });

    const titre = m.fields.getTextInputValue('titre')?.trim() || null;
    const texte = m.fields.getTextInputValue('texte');
    const couleur = m.fields.getTextInputValue('couleur');

    // Convertit @Pseudo / @Rôle / #salon en vraies mentions
    const r = await rich(m.guild, texte);

    const embed = new EmbedBuilder()
      .setColor(parseColor(couleur, '#5865F2'))
      .setDescription(r.text.slice(0, 4096))
      .setTimestamp()
      .setFooter({ text: `Sent from ${m.guild.name}` });

    if (titre) embed.setTitle(titre.slice(0, 256));

    // Récupère tous les membres (sauf bots)
    await m.guild.members.fetch().catch(() => {});
    const members = m.guild.members.cache.filter((mem) => !mem.user.bot);

    let sent = 0;
    let failed = 0;
    const total = members.size;

    await m.editReply(`📤 Sending… 0/${total} (does not close the bot)`);

    // Envoi avec délai pour éviter le rate-limit
    for (const member of members.values()) {
      try {
        await member.send({ embeds: [embed] });
        sent++;
      } catch {
        failed++; // MP fermés ou bloqué
      }

      // Mise à jour toutes les 25 personnes
      if ((sent + failed) % 25 === 0) {
        await m.editReply(`📤 Sending… ${sent + failed}/${total} (${sent} sent · ${failed} failures)`).catch(() => {});
      }

      // Délai important (1,2 seconde)
      await new Promise((r) => setTimeout(r, 1200));
    }

    await m.editReply(
      `✅ **Sending completed**\n` +
      `• Targeted members: **${total}**\n` +
      `• Sent: **${sent}**\n` +
      `• Failures (PM closed/blocked): **${failed}**`
    );
  },

  /* ---------- /autorole ---------- */
  async autorole(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'liste') {
      const entries = Object.entries(d.reactionRoles);
      if (!entries.length) {
        return i.reply({ content: 'No autorole. Create one with `/autorole creer`.', flags: EPH });
      }
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎭 Autoroles').setDescription(
        entries.map(([id, r]) =>
          `${r.label} → <@&${r.roleId}> · <#${r.channelId}> · [message](https://discord.com/channels/${i.guildId}/${r.channelId}/${id})`
        ).join('\n').slice(0, 4096));
      return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
    }

    if (sub === 'supprimer') {
      const id = i.options.getString('message', true).trim();
      const rr = d.reactionRoles[id];
      if (!rr) return i.reply({ content: '❌ Autorole not found.', flags: EPH });
      delete d.reactionRoles[id];
      save();
      await i.deferReply({ flags: EPH });
      const ch = await i.guild.channels.fetch(rr.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(id).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
      return i.editReply('🗑️ Autorole deleted (the message was also deleted).');
    }

    // ----- creer -----
    const salon = i.options.getChannel('salon', true);
    const roleOpt = i.options.getRole('role', true);
    const emojiInput = i.options.getString('emoji', true).trim();
    const mentionOpt = i.options.get('mention');
    const ping = i.options.getString('ping');
    const img = i.options.getAttachment('image');
    const thumb = i.options.getAttachment('miniature');

    const role = i.guild.roles.cache.get(roleOpt.id);
    if (!role || role.id === i.guild.id || role.managed) {
      return i.reply({ content: '❌ Choose a normal role (not @everyone or a bot role).', flags: EPH });
    }
    if (!role.editable) {
      return i.reply({ content: '❌ My role must be **above** this role in the server role list.', flags: EPH });
    }
    if (!isOwner(i) && i.member.roles.highest.position <= role.position) {
      return i.reply({ content: '❌ You cannot assign a role greater than or equal to yours.', flags: EPH });
    }
    if (!emojiInput || emojiInput.length > 64) {
      return i.reply({ content: '❌ Emoji invalide.', flags: EPH });
    }
    if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return i.reply({ content: "❌ You need permission to mention @everyone.", flags: EPH });
    }

    const modalId = `autorole_${i.id}`;
    await i.showModal(announceModal(modalId, 'Autorole message', 'Message text (Markdown accepted)'));

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    await m.deferReply({ flags: EPH });
    let msg;
    try {
      const { embed, files, mentions } = await buildAnnounce(m, img, thumb);
      const { content, allowed } = buildMentions(ping, mentionOpt, mentions);
      msg = await salon.send({ content, embeds: [embed], files, allowedMentions: allowed });
      const reaction = await msg.react(emojiInput);

      d.reactionRoles[msg.id] = {
        channelId: salon.id,
        roleId: role.id,
        emoji: reaction.emoji.id ?? reaction.emoji.name,
        label: emojiInput,
      };
      save();
      await m.editReply({
        content: `✅ Message sent in <#${salon.id}>. Reacting with ${emojiInput} gives the role <@&${role.id}>.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error('[autorole]', e);
      if (msg) msg.delete().catch(() => {});
      await m.editReply(
        "❌ Failed to create autorole. Check the emoji (an emoji from a server I'm not on doesn't work)" +
        "and my permissions in this channel: **View channel, Send messages, Embed links, Add reactions**.");
    }
  },

  /* ---------- /role-arrivee ---------- */
  async 'role-arrivee'(i) {
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const txt = d.joinRoles.length
        ? d.joinRoles.map((id) => `• <@&${id}>`).join('\n')
        : "No automatic roles. Add one with `/role-arrivee ajouter`.";
      return i.reply({ content: `**Roles given on arrival**\n${txt}`, flags: EPH, allowedMentions: { parse: [] } });
    }

    const roleOpt = i.options.getRole('role', true);
    if (roleOpt.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });

    if (sub === 'retirer') {
      if (!d.joinRoles.includes(roleOpt.id)) {
        return i.reply({ content: "❌ This role is not in the list.", flags: EPH });
      }
      d.joinRoles = d.joinRoles.filter((id) => id !== roleOpt.id);
      save();
      return i.reply({
        content: `🗑️ <@&${roleOpt.id}> will no longer be given upon arrival (members who already have it keep it).`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    // ajouter
    const role = i.guild.roles.cache.get(roleOpt.id);
    if (!role || role.managed) {
      return i.reply({ content: '❌ Choose a normal role (not a bot or boost role).', flags: EPH });
    }
    if (!role.editable) {
      return i.reply({ content: '❌ My role must be **above** this role in the server role list.', flags: EPH });
    }
    if (!isOwner(i) && i.member.roles.highest.position <= role.position) {
      return i.reply({ content: '❌ You cannot assign a role greater than or equal to yours.', flags: EPH });
    }
    if (d.joinRoles.includes(role.id)) {
      return i.reply({ content: '❌ This role is already given to arrival.', flags: EPH });
    }
    if (d.joinRoles.length >= 10) {
      return i.reply({ content: '❌ 10 automatic roles maximum.', flags: EPH });
    }
    d.joinRoles.push(role.id);
    save();
    return i.reply({
      content: `✅ Each new member will automatically receive <@&${role.id}>.`,
      flags: EPH, allowedMentions: { parse: [] },
    });
  },

  /* ---------- /bienvenue ---------- */
  async bienvenue(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'activer' || sub === 'desactiver') {
      if (sub === 'activer' && !d.welcome.channelId) {
        return i.reply({ content: "❌ First configure the channel with `/bienvenue configurer`.", flags: EPH });
      }
      d.welcome.enabled = sub === 'activer';
      save();
      return i.reply({ content: d.welcome.enabled ? '✅ Welcome message enabled.' : '⏸️ Welcome message disabled.', flags: EPH });
    }

    if (sub === 'test') {
      await i.deferReply({ flags: EPH });
      return i.editReply(await buildWelcome(i.member));
    }

    // configurer
    const salon = i.options.getChannel('salon');
    const w = d.welcome;
    if (!salon && !w.channelId) {
      return i.reply({ content: '❌ Specify a channel for the first configuration.', flags: EPH });
    }

    const modalId = `welcome_${i.id}`;
    await i.showModal(
      new ModalBuilder().setCustomId(modalId).setTitle("Welcome message").addComponents(
        field('content', 'Text above ({user}, @Role, #channel)', TextInputStyle.Short, { value: w.content, max: 500 }),
        field('title', "Embed title", TextInputStyle.Short, { value: w.title, max: 256 }),
        field('description', 'Description (voir variables ci-dessous)', TextInputStyle.Paragraph, { value: w.description, max: 4000, placeholder: '{user} {username} {server} {count} @Role #channel' }),
        field('image', "Image URL (optional)", TextInputStyle.Short, { value: w.image, max: 500 }),
        field('color', 'Hex color (e.g. #5865F2)', TextInputStyle.Short, { value: w.color, max: 7 }),
      ));

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    if (salon) w.channelId = salon.id;
    w.content = m.fields.getTextInputValue('content');
    w.title = m.fields.getTextInputValue('title');
    w.description = m.fields.getTextInputValue('description');
    w.image = m.fields.getTextInputValue('image').trim();
    w.color = parseColor(m.fields.getTextInputValue('color'));
    w.enabled = true;
    save();

    await m.reply({ content: `✅ Welcome configured in <#${w.channelId}> and activated. Preview :`, flags: EPH });
    await m.followUp({ ...(await buildWelcome(i.member)), flags: EPH });
  },

  /* ---------- /setup-paiement ---------- */
  async 'setup-paiement'(i) {
    const staff = i.options.getRole('role-staff', true);
    const salon = i.options.getChannel('salon', true);
    const logCh = i.options.getChannel('salon-logs');
    const nom = (i.options.getString('nom') || 'paiement').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    const d = getG(i.guildId);

    if (staff.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
    if (d.tickets[nom]) {
      return i.reply({ content: `❌ Configuration **${nom}** already exists. Delete it with \`/ticket config-delete\` or choose another name.`, flags: EPH });
    }

    const EMOJIS = { paypal: '💳', wero: '🏦', virement: '🏛️', crypto: '🪙', carte: '💳', cb: '💳' };
    const moyens = (i.options.getString('moyens') || 'PayPal, Wero')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 125);
    if (!moyens.length) return i.reply({ content: '❌ Indicates at least one payment method.', flags: EPH });

    await i.deferReply({ flags: EPH });
    const P = PermissionFlagsBits;
    try {
      // Une catégorie du serveur par moyen de paiement = un choix du menu en MP
      const choices = [];
      for (const label of moyens) {
        const cat = await i.guild.channels.create({
          name: `Tickets ${label}`.slice(0, 100),
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: i.guild.id, deny: [P.ViewChannel] },
            { id: staff.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages] },
            { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ReadMessageHistory, P.EmbedLinks] },
          ],
          reason: `/setup-payment by ${i.user.tag}`,
        });
        choices.push({
          id: crypto.randomUUID().slice(0, 8),
          label: label.slice(0, 100),
          description: `Payment by ${label}`.slice(0, 100),
          emoji: EMOJIS[label.toLowerCase()] || '💶',
          staffRoleId: null,
          categoryId: cat.id,
        });
      }

      const cfg = {
        name: nom,
        categoryId: choices[0].categoryId,
        staffRoles: [staff.id],
        logChannelId: logCh?.id || null,
        reasons: [],
        counter: 0,
        panels: [],
        placeholder: null,
        openMsg: null,
        dm: true,
        dmMigrated: true,
        dmChoices: choices,
        dmImage: null,
        dmTexts: {
          title: '💳 Choose your payment method',
          description: 'Select your payment method from the menu below.',
          placeholder: 'Choose your payment method...',
        },
      };
      d.tickets[nom] = cfg;
      save();

      // Panel (bouton, le menu est envoyé en MP)
      const customDesc = i.options.getString('description');
      const richDesc = customDesc ? (await rich(i.guild, customDesc)).text : null;
      const embed = new EmbedBuilder()
        .setColor(parseColor(d.panelColor, '#57F287'))
        .setTitle(i.options.getString('titre') || '🎫 Place order')
        .setDescription((richDesc || 'Click on the button below to place an order.\n' +
          'You will receive a **private message** to choose your payment method.').slice(0, 4096))
        .setTimestamp();
      const rows = panelRows(cfg, { button: true, label: 'Place an order', style: 'Success' });
      const sent = await salon.send({ embeds: [embed], components: rows });
      cfg.panels.push({
        channelId: salon.id, messageId: sent.id, customDesc: true, button: true,
        btnLabel: 'Place an order', btnStyle: 'Success',
        sig: sig({ rows: rows.map((r) => r.toJSON()), desc: null }),
      });
      save();

      await i.editReply({
        content:
          `✅ Everything is installed (config **${nom}**): \n` +
          choices.map((r) => `• ${r.emoji} **${r.label}** → <#${r.categoryId}>`).join('\n') +
          `\n• Staff: <@&${staff.id}>\n• Panel sent to <#${salon.id}>` +
          `${logCh ? `\n• Transcripts : <#${logCh.id}>` : ''}\n` +
          "The member clicks on **Order**, receives a PM with the menu, chooses, and the ticket opens in the correct category.\n" +
          '',
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error('[setup-paiement]', e);
      await i.editReply('❌ Unable to install. I need to **Manage Channels** and **Manage roles**, and my role must be above the staff role.');
    }
  },

  /* ---------- /sous-panel ---------- */
  async 'sous-panel'(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);
    const cfgName = i.options.getString('config', true);
    const cfg = d.tickets[cfgName];
    const say = (content) => i.reply({ content, flags: EPH, allowedMentions: { parse: [] } });
    if (!cfg) return say('❌ Configuration not found.');
    // texte facultatif : vide -> null, "aucun" -> null (effacer), sinon texte coupé à `max`
    const clean = (v, max) => { const t = (v ?? '').trim(); return t.toLowerCase() === 'aucun' ? null : t.slice(0, max) || null; };

    if (sub === 'liste') return say(subSummary(cfg));

    if (sub === 'creer') {
      if (cfg.subPanels.length >= 100) return say('❌ 100 subpanels maximum per configuration.');
      const nom = i.options.getString('nom', true).trim().slice(0, 60);
      if (findSub(cfg, nom)) return say('❌ A subpanel already has this name.');
      const couleur = (i.options.getString('couleur') || '').trim();
      cfg.subPanels.push({
        id: crypto.randomUUID().slice(0, 8),
        name: nom,
        title: clean(i.options.getString('titre'), 256),
        description: clean(i.options.getString('description'), 1000),
        placeholder: clean(i.options.getString('placeholder'), 100),
        color: couleur ? parseColor(couleur) : null,
        choices: [],
      });
      save();
      return say(
        `✅ Subpanel **${nom}** created in **${cfgName}**.\n` +
        '• Add choices to it: `/sous-panel choix-ajouter`\n' +
        '• Then link it: `/sous-panel lier` (to all categories in the panel, or to just one)');
    }

    if (sub === 'delier') {
      const pour = i.options.getString('pour', true);
      if (pour === 'all') {
        cfg.defaultSubPanelId = null;
        save();
        return say('✅ No more subpanel by default: categories without their own subpanel open the ticket directly.');
      }
      const t = findTarget(cfg, pour);
      if (!t) return say('❌ Category not found. Choose it from the list provided.');
      delete cfg.subLinks[t.id];
      save();
      const def = cfg.subPanels.find((x) => x.id === cfg.defaultSubPanelId);
      return say(`✅ **${t.label}** returns to the default setting (${def ? `subpanel **${def.name}**` : 'no subpanel'}).`);
    }

    // Toutes les autres sous-commandes travaillent sur un sous-panel existant ('none' accepté seulement pour /lier)
    const rawSp = i.options.getString('sous-panel', true);
    const none = sub === 'lier' && rawSp === 'none';
    const sp = none ? null : findSub(cfg, rawSp);
    if (!none && !sp) return say('❌ Subpanel not found. Choose it from the list provided.');

    if (sub === 'supprimer') {
      cfg.subPanels = cfg.subPanels.filter((x) => x !== sp);
      for (const x of cfg.subPanels) for (const c of x.choices) if (c.nextSubId === sp.id) c.nextSubId = null;
      for (const [k, v] of Object.entries(cfg.subLinks)) if (v === sp.id) delete cfg.subLinks[k];
      if (cfg.defaultSubPanelId === sp.id) cfg.defaultSubPanelId = null;
      save();
      return say(`🗑️ Subpanel **${sp.name}** removed (and removed from all categories).`);
    }

    if (sub === 'modifier') {
      const nom = i.options.getString('nouveau-nom');
      if (nom) {
        const n = nom.trim().slice(0, 60);
        const other = findSub(cfg, n);
        if (other && other !== sp) return say('❌ A subpanel already has this name.');
        sp.name = n;
      }
      for (const [opt, key, max] of [['titre', 'title', 256], ['description', 'description', 1000], ['placeholder', 'placeholder', 100]]) {
        const v = i.options.getString(opt);
        if (v !== null) sp[key] = clean(v, max);
      }
      const c = i.options.getString('couleur');
      if (c !== null) sp.color = !c.trim() || c.trim().toLowerCase() === 'aucun' ? null : parseColor(c);
      save();
      return say(`✅ Subpanel **${sp.name}** modified.`);
    }

    if (sub === 'lier') {
      const pour = i.options.getString('pour', true);
      const warn = !none && !sp.choices.length ? '\n⚠️ This subpanel has no choices yet: it will not be displayed (`/sous-panel choix-ajouter`).' : '';
      if (pour === 'all') {
        cfg.defaultSubPanelId = none ? null : sp.id;
        save();
        return say(none
          ? '✅ No more default subpanel.'
          : `✅ **${sp.name}** now applies to **all** categories in **${cfgName}** (except those that have their own subpanel).${warn}`);
      }
      const t = findTarget(cfg, pour);
      if (!t) return say('❌ Category not found. Choose it from the list provided.');
      cfg.subLinks[t.id] = none ? 'none' : sp.id;
      save();
      return say(none
        ? `✅ **${t.label}** opens the ticket directly (no subpanel).`
        : `✅ **${t.label}** now uses subpanel **${sp.name}**.${warn}`);
    }

    // Sous-panel proposé après un choix (option "suivant") : undefined = inchangé, null = aucun
    let nextId;
    if (sub === 'choix-ajouter' || sub === 'choix-modifier' || sub === 'choix-suivant') {
      const raw = i.options.getString('suivant');
      if (raw !== null) {
        if (raw.trim().toLowerCase() === 'aucun') nextId = null;
        else {
          const n = findSub(cfg, raw);
          if (!n) return say('❌ Next subpanel not found. Choose it from the list provided.');
          if (n === sp || subReaches(cfg, n.id, sp.id)) return say('❌ Loop impossible: this subpanel already leads (directly or not) to this one.');
          nextId = n.id;
        }
      }
    }
    const nextTxt = nextId ? ` — then opens the subpanel **${cfg.subPanels.find((x) => x.id === nextId).name}**` : '';

    // Même sous-panel suivant pour TOUS les choix du sous-panel (nextId a déjà été vérifié : pas de boucle)
    if (sub === 'choix-suivant') {
      if (!sp.choices.length) return say(`❌ **${sp.name}** has no choices yet.`);
      for (const c of sp.choices) c.nextSubId = nextId || null;
      save();
      return say(nextId
        ? `✅ All **${sp.choices.length}** choices of **${sp.name}** now lead to the subpanel **${cfg.subPanels.find((x) => x.id === nextId).name}**.`
        : `✅ **${sp.choices.length}** choices of **${sp.name}** now open the ticket directly.`);
    }

    if (sub === 'choix-ajouter') {
      if (sp.choices.length >= 125) return say('❌ Maximum 125 choices per sub-panel: beyond that, use a following sub-panel to offer more.');
      const staff = i.options.getRole('role-staff');
      if (staff && staff.id === i.guild.id) return say('❌ You can\'t choose @everyone.');
      const emojiRaw = (i.options.getString('emoji') || '').trim();
      if (emojiRaw && !parseEmoji(emojiRaw)) {
        return say("❌ Invalid emoji. Use a normal emoji or a server emoji (type `:nom:` then choose it from the list).");
      }
      const label = i.options.getString('label', true).trim().slice(0, 100);
      if (findChoice(sp, label)) return say('❌ This subpanel already has a choice of this name.');
      const cat = i.options.getChannel('categorie');
      sp.choices.push({
        id: crypto.randomUUID().slice(0, 8),
        label,
        description: (i.options.getString('description') || '').trim().slice(0, 100),
        emoji: emojiRaw || null,
        staffRoleId: staff?.id || null,
        categoryId: cat?.id || null,
        nextSubId: nextId || null,
      });
      save();
      return say(
        `✅ Choice **${label}** added to **${sp.name}** (${sp.choices.length}/125)` +
        `${cat ? ` — tickets created in <#${cat.id}>` : ' — tickets created in the menu category (or the configuration category)'}` +
        `${staff ? ` — staff : <@&${staff.id}>` : ''}${nextTxt}.`);
    }

    if (sub === 'choix-modifier' || sub === 'choix-retirer') {
      const ch = findChoice(sp, i.options.getString('sous-choix', true));
      if (!ch) return say('❌ Choice not found. Choose it from the list provided.');
      if (sub === 'choix-retirer') {
        sp.choices = sp.choices.filter((c) => c !== ch);
        save();
        return say(`🗑️ Choice **${ch.label}** removed from **${sp.name}**.`);
      }
      const emojiRaw = (i.options.getString('emoji') || '').trim();
      if (emojiRaw) {
        if (emojiRaw.toLowerCase() === 'aucun') ch.emoji = null;
        else if (!parseEmoji(emojiRaw)) return say('❌ Emoji invalide.');
        else ch.emoji = emojiRaw;
      }
      const nom = (i.options.getString('nouveau-nom') || '').trim();
      if (nom) {
        const other = findChoice(sp, nom);
        if (other && other !== ch) return say('❌ This subpanel already has a choice of this name.');
        ch.label = nom.slice(0, 100);
      }
      const desc = i.options.getString('description');
      if (desc !== null) ch.description = desc.trim().toLowerCase() === 'aucun' ? '' : desc.trim().slice(0, 100);
      const cat = i.options.getChannel('categorie');
      if (cat) ch.categoryId = cat.id;
      const staff = i.options.getRole('role-staff');
      if (staff) {
        if (staff.id === i.guild.id) return say('❌ You can\'t choose @everyone.');
        ch.staffRoleId = staff.id;
      }
      if (nextId !== undefined) ch.nextSubId = nextId;
      save();
      return say(`✅ Choice **${ch.label}** modified${nextId === null ? ' (no more next subpanel)' : nextTxt}.`);
    }
  },

  /* ---------- /ticket ---------- */
  async ticket(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    /* ----- Ajouter / retirer un membre du ticket actuel ----- */
    if (sub === 'ajouter' || sub === 'retirer') {
      return ticketMemberAction(i, sub === 'ajouter' ? 'add' : 'remove');
    }

    /* ----- Couleur globale des panels ----- */
    if (sub === 'couleur') {
      const raw = i.options.getString('couleur', true).trim();
      if (!/^#?[0-9a-f]{6}$/i.test(raw)) {
        return i.reply({ content: '❌ Invalid color. Example: `#5865F2`.', flags: EPH });
      }
      const color = '#' + raw.replace('#', '').toUpperCase();
      const only = i.options.getString('config');
      if (only) {
        const cfg = d.tickets[only];
        if (!cfg) return i.reply({ content: '❌ Configuration not found.', flags: EPH });
        cfg.color = color;
        save();
        await i.deferReply({ flags: EPH });
        await refreshPanels(i.guild, only).catch(console.error);
        await refreshSalesPanel(i.guild, false).catch(console.error);
        return i.editReply(`🎨 Color **${color}** applied to all panels of **${only}**.`);
      }
      d.panelColor = color;
      save();
      await i.deferReply({ flags: EPH });
      await refreshPanels(i.guild).catch(console.error);
      await refreshSalesPanel(i.guild, false).catch(console.error);
      return i.editReply(`🎨 Color **${color}** applied to **all panels** of the server (tickets, vouch, sales).`);
    }

    /* ----- Vouch ----- */
    if (sub === 'vouch-salon') {
      const salon = i.options.getChannel('salon', true);
      d.vouch.channelId = salon.id;
      save();
      return i.reply({ content: `⭐ Vouchs will be sent to <#${salon.id}>.`, flags: EPH });
    }
    if (sub === 'vouch-activer') {
      d.vouch.enabled = true;
      save();
      return i.reply({ content: '✅ The Vouch button is enabled.', flags: EPH });
    }
    if (sub === 'vouch-desactiver') {
      d.vouch.enabled = false;
      save();
      return i.reply({ content: '⛔ The Vouch button is disabled.', flags: EPH });
    }

    /* ----- Traduction automatique FR ⇄ EN ----- */
    if (sub === 'traduction-activer' || sub === 'traduction-desactiver') {
      const name = i.options.getString('config', true);
      const cfg = d.tickets[name];
      if (!cfg) return i.reply({ content: '❌ Configuration not found.', flags: EPH });
      cfg.translate = sub === 'traduction-activer';
      save();
      return i.reply({
        content: cfg.translate
          ? `✅ Automatic translation **enabled** for **${name}**. New tickets translate messages into French and English.`
          : `⛔ Automatic translation **disabled** for **${name}**.`,
        flags: EPH,
      });
    }

    /* ----- Suivi des ventes ----- */
    if (sub === 'ventes-salon') {
      const salon = i.options.getChannel('salon', true);
      d.sales.channelId = salon.id;
      d.sales.messageId = null;
      d.sales.sig = null;
      save();
      await i.deferReply({ flags: EPH });
      await refreshSalesPanel(i.guild, true).catch(console.error);
      return i.editReply(`📈 Sales tracking panel sent in <#${salon.id}> (it updates with each sale).`);
    }
    if (sub === 'ventes-panel') {
      if (!d.sales.channelId) {
        return i.reply({ content: '❌ First choose a channel with `/ticket ventes-salon`.', flags: EPH });
      }
      await i.deferReply({ flags: EPH });
      const msg = await refreshSalesPanel(i.guild, true).catch(console.error);
      return i.editReply(msg ? `📈 Sales panel updated in <#${d.sales.channelId}>.` : '❌ Unable to create the panel (check my permissions in the channel).');
    }
    if (sub === 'ventes-devise') {
      d.sales.currency = i.options.getString('devise', true).trim().slice(0, 8) || '€';
      save();
      await refreshSalesPanel(i.guild, false).catch(console.error);
      return i.reply({ content: `💱 Sales tracking currency: **${d.sales.currency}**.`, flags: EPH });
    }

    if (sub === 'config-creer') {
      const nom = i.options.getString('nom', true).toLowerCase();
      if (!/^[a-z0-9-]{1,30}$/.test(nom)) {
        return i.reply({ content: '❌ Invalid name: lowercase letters, numbers and hyphens only (30 max).', flags: EPH });
      }
      if (d.tickets[nom]) return i.reply({ content: '❌ A configuration already has this name.', flags: EPH });
      const staff = i.options.getRole('role-staff');
      if (staff && staff.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
      d.tickets[nom] = {
        name: nom,
        categoryId: i.options.getChannel('categorie', true).id,
        staffRoles: staff ? [staff.id] : [],
        staffMode: 'any',
        logChannelId: i.options.getChannel('salon-logs')?.id || null,
        reasons: [],
        counter: 0,
        panels: [],
        placeholder: null,
        openMsg: null,
        dm: false,
        dmMigrated: true,
        dmChoices: [],
        dmTexts: null,
        dmImage: null,
      };
      save();
      return i.reply({
        content:
          `✅ Configuration **${nom}** created.\n` +
          `• Other staff role: \`/ticket staff-add\`\n` +
          `• Panel menu categories (with emojis and linked server category): \`/ticket reason-add\`\n` +
          `• Sending the panel with banner: \`/ticket panel\`\n` +
          `• Ticket opening message: \`/ticket message\``,
        flags: EPH,
      });
    }

    if (sub === 'config-liste') {
      const list = Object.values(d.tickets);
      if (!list.length) return i.reply({ content: "No configuration. Create one with `/ticket config-creer`.", flags: EPH });
      const reasonStaff = (r) => (Array.isArray(r.staffRoles) && r.staffRoles.length ? r.staffRoles : (r.staffRoleId ? [r.staffRoleId] : []))
        .map((id) => `<@&${id}>`).join(' ');
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎫 Ticket configurations').setDescription(
        list.map((c) =>
          `**${c.name}**${c.dm ? ' · 📩 DM mode' : ''}\n• Default category: <#${c.categoryId}>\n• Staff: ${c.staffRoles.length ? c.staffRoles.map((r) => `<@&${r}>`).join(' ') : 'none'}${c.staffMode === 'all' ? ' · all roles required' : ''}\n• Logs: ${c.logChannelId ? `<#${c.logChannelId}>` : 'none'}\n• Panel menu: ${c.reasons.length ? c.reasons.map((r) => (r.emoji ? r.emoji + ' ' : '') + r.label + (r.categoryId ? ` → <#${r.categoryId}>` : '') + (reasonStaff(r) ? ` (staff : ${reasonStaff(r)})` : '')).join(', ') : 'no category'}` +
          (c.dm
            ? `\n• DM menu: ${c.dmChoices.length ? c.dmChoices.map((r) => (r.emoji ? r.emoji + ' ' : '') + r.label + (r.categoryId ? ` → <#${r.categoryId}>` : '') + (r.staffRoleId ? ` (staff : <@&${r.staffRoleId}>)` : '')).join(', ') : 'no choice'}` +
              `\n• DM image: ${c.dmImage ? 'yes' : 'no'}`
            : '')
        ).join('\n\n').slice(0, 4096));
      return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
    }

    const cfgName = i.options.getString('config', true);
    const cfg = d.tickets[cfgName];
    if (!cfg) return i.reply({ content: '❌ Configuration not found.', flags: EPH });

    if (sub === 'config-supprimer') {
      removeDmImage(cfg);
      delete d.tickets[cfgName];
      save();
      return i.reply({ content: `🗑️ Configuration **${cfgName}** removed. Old panels will no longer work.`, flags: EPH });
    }

    if (sub === 'staff-ajouter') {
      const role = i.options.getRole('role', true);
      if (role.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
      if (cfg.staffRoles.includes(role.id)) {
        return i.reply({ content: '❌ This role already has access to tickets in this configuration.', flags: EPH });
      }
      cfg.staffRoles.push(role.id);
      save();
      return i.reply({
        content: `✅ <@&${role.id}> can now see and respond to **new** tickets from **${cfgName}** (except those whose category has its own staff role).`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    if (sub === 'staff-retirer') {
      const role = i.options.getRole('role', true);
      if (!cfg.staffRoles.includes(role.id)) {
        return i.reply({ content: "❌ This role is not in the staff of this configuration.", flags: EPH });
      }
      cfg.staffRoles = cfg.staffRoles.filter((id) => id !== role.id);
      save();
      return i.reply({
        content: `🗑️ <@&${role.id}> removed from the **${cfgName}** staff (tickets already opened retain their access).`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    if (sub === 'raison-ajouter') {
      if (cfg.reasons.length >= 125) return i.reply({ content: '❌ Maximum 125 categories per configuration.', flags: EPH });
      const staff = i.options.getRole('role-staff');
      if (staff && staff.id === i.guild.id) return i.reply({ content: '❌ You can\'t choose @everyone.', flags: EPH });
      const emojiRaw = (i.options.getString('emoji') || '').trim();
      if (emojiRaw && !parseEmoji(emojiRaw)) {
        return i.reply({ content: "❌ Invalid emoji. Use a normal emoji or a server emoji (type `:nom:` then choose it from the list).", flags: EPH });
      }
      const cat = i.options.getChannel('categorie');
      cfg.reasons.push({
        id: crypto.randomUUID().slice(0, 8),
        label: i.options.getString('label', true).slice(0, 100),
        description: (i.options.getString('description') || '').slice(0, 100),
        emoji: emojiRaw || null,
        staffRoleId: staff?.id || null,
        staffRoles: staff ? [staff.id] : [],
        categoryId: cat?.id || null, // catégorie du serveur où les tickets de ce choix sont créés
      });
      save();
      await i.reply({
        content: `✅ Category added to **${cfgName}** (total ${cfg.reasons.length})` +
          `${cat ? ` — tickets created in <#${cat.id}>` : ' — tickets created in the configuration default category'}` +
          `${staff ? ` — staff : <@&${staff.id}>` : ''}. Panels already sent update automatically.`,
        flags: EPH, allowedMentions: { parse: [] },
      });
      return refreshPanels(i.guild, cfgName).catch(console.error);
    }

    if (sub === 'raison-modifier') {
      const label = i.options.getString('label', true);
      const r = cfg.reasons.find((x) => x.label.toLowerCase() === label.toLowerCase());
      if (!r) return i.reply({ content: '❌ Category not found.', flags: EPH });

      const emojiRaw = (i.options.getString('emoji') || '').trim();
      if (emojiRaw) {
        if (emojiRaw.toLowerCase() === 'aucun') r.emoji = null;
        else if (!parseEmoji(emojiRaw)) {
          return i.reply({ content: '❌ Emoji invalide.', flags: EPH });
        } else r.emoji = emojiRaw;
      }
      const nom = i.options.getString('nouveau-nom');
      if (nom) r.label = nom.slice(0, 100);
      const desc = i.options.getString('description');
      if (desc !== null) r.description = desc.slice(0, 100);
      const cat = i.options.getChannel('categorie');
      if (cat) r.categoryId = cat.id;
      save();
      await i.reply({ content: '✅ Modified category. The panels update automatically.', flags: EPH });
      return refreshPanels(i.guild, cfgName).catch(console.error);
    }

    if (sub === 'raison-retirer') {
      const label = i.options.getString('label', true);
      const before = cfg.reasons.length;
      cfg.reasons = cfg.reasons.filter((r) => r.label.toLowerCase() !== label.toLowerCase());
      save();
      const removed = cfg.reasons.length < before;
      await i.reply({
        content: removed ? '🗑️ Category removed. Panels already sent update automatically.' : '❌ Category not found.',
        flags: EPH,
      });
      if (removed) await refreshPanels(i.guild, cfgName).catch(console.error);
      return;
    }

    /* ----- Message envoyé à l'ouverture d'un ticket (par panel ou pour toute la config) ----- */
    if (sub === 'message') {
      const panelId = i.options.getString('panel');
      const panel = panelId ? cfg.panels.find((p) => p.messageId === panelId) : null;
      if (panelId && !panel) {
        return i.reply({ content: '❌ Panel not found. Choose it from the list provided.', flags: EPH });
      }
      const scope = panel ? 'this panel' : `all panels of **${cfgName}**`;

      if (i.options.getBoolean('reinitialiser')) {
        if (panel) delete panel.openMsg; else cfg.openMsg = null;
        save();
        return i.reply({ content: `✅ Default message restored for ${scope}.`, flags: EPH });
      }

      const cur = panel?.openMsg || cfg.openMsg || {};
      const modalId = `tkmsg_${i.id}`;
      await i.showModal(
        new ModalBuilder().setCustomId(modalId).setTitle("Ticket opening message").addComponents(
          field('content', 'Text above (empty = ping by default)', TextInputStyle.Paragraph,
            { value: cur.content, max: 1000, placeholder: '{user} {staff} @Role #channel' }),
          field('title', 'Titre', TextInputStyle.Short,
            { value: cur.title, max: 256, placeholder: '🎫 Ticket — {category}' }),
          field('description', 'Description (empty = default text)', TextInputStyle.Paragraph,
            { value: cur.description, max: 4000, placeholder: '{user} {username} {server} {category} {sub} {staff} @Role #channel' }),
          field('image', "Image URL (optional)", TextInputStyle.Short, { value: cur.image, max: 500 }),
          field('color', 'Hex color (e.g. #5865F2)', TextInputStyle.Short, { value: cur.color, max: 7 }),
        ));

      const m = await i.awaitModalSubmit({
        time: 15 * 60_000,
        filter: (x) => x.customId === modalId && x.user.id === i.user.id,
      }).catch(() => null);
      if (!m) return;

      const val = (k) => m.fields.getTextInputValue(k).trim() || null;
      const image = val('image');
      const color = val('color');
      const data = {
        content: val('content'),
        title: val('title'),
        description: val('description'),
        image: image && isUrl(image) ? image : null,
        color: color ? parseColor(color) : null,
      };
      const EXTRA = ['claimLabel', 'closeLabel', 'claimEmoji', 'closeEmoji', 'footer', 'thumbnail', 'fields', 'showInfo', 'timestamp', 'infoLabels', 'noDefaultDesc'];
      const empty = Object.values(data).every((v) => !v) && !EXTRA.some((k) => cur[k] !== undefined && cur[k] !== null && cur[k] !== '');
      for (const k of EXTRA) if (cur[k] !== undefined && cur[k] !== null) data[k] = cur[k]; // on garde boutons, pied de page, champs... réglés depuis le panel web
      if (panel) panel.openMsg = empty ? undefined : data;
      else cfg.openMsg = empty ? null : data;
      if (panel && empty) delete panel.openMsg;
      save();

      return m.reply({
        content: empty
          ? `✅ Default message restored for ${scope}.`
          : `✅ Opening message recorded for ${scope}. It applies to **new** tickets.\n` +
            'Variables: `{user}` `{username}` `{server}` `{category}` `{sub}` `{config}` `{staff}` —' +
            '`@Pseudo`, `@Role` and `#channel` become clickable.',
        flags: EPH,
      });
    }

    /* ----- Texte des boutons du message d'ouverture (Prendre en charge / Fermer) ----- */
    if (sub === 'message-boutons') {
      const panelId = i.options.getString('panel');
      const panel = panelId ? cfg.panels.find((p) => p.messageId === panelId) : null;
      if (panelId && !panel) return i.reply({ content: '❌ Panel not found. Choose it from the list provided.', flags: EPH });
      const claim = (i.options.getString('prendre-en-charge') || '').trim();
      const close = (i.options.getString('fermer') || '').trim();
      if (!claim && !close) return i.reply({ content: '❌ Indicates at least one text ("default" to reset the default).', flags: EPH });
      const m = panel ? (panel.openMsg ??= {}) : (cfg.openMsg ??= {});
      if (claim) m.claimLabel = claim.toLowerCase() === 'defaut' ? null : claim.slice(0, 80);
      if (close) m.closeLabel = close.toLowerCase() === 'defaut' ? null : close.slice(0, 80);
      save();
      return i.reply({ content: `✅ Saved button text for ${panel ? 'this panel' : `all panels of **${cfgName}**`} (new tickets).`, flags: EPH });
    }

    /* ----- Couleur / texte du bouton d'un panel déjà envoyé ----- */
    if (sub === 'bouton') {
      const panel = cfg.panels.find((p) => p.messageId === i.options.getString('panel', true));
      if (!panel) return i.reply({ content: '❌ Panel not found. Choose it from the list provided.', flags: EPH });
      const style = i.options.getString('couleur');
      const label = (i.options.getString('texte') || '').trim();
      if (!style && !label) return i.reply({ content: '❌ Choose a color and/or text.', flags: EPH });
      if (cfg.reasons.length && !panel.button && !cfg.dm) {
        return i.reply({
          content: '❌ This panel uses a **drop-down menu** (no color possible).' +
            'Return it with `/ticket panel` by choosing `type : Bouton`.',
          flags: EPH,
        });
      }
      if (style) panel.btnStyle = style;
      if (label) panel.btnLabel = label.slice(0, 80);
      panel.button = true;
      save();
      await i.deferReply({ flags: EPH });
      await refreshPanels(i.guild, cfgName);
      return i.editReply(`✅ Updated button${style ? ` (color: ${BTN_NAMES[style]})` : ''}.`);
    }

    if (sub === 'panel') {
      const salon = i.options.getChannel('salon', true);
      const img = i.options.getAttachment('image');
      const imgUrl = (i.options.getString('image-url') || '').trim();
      const thumb = i.options.getAttachment('miniature');
      const thumbUrl = (i.options.getString('miniature-url') || '').trim();
      const footer = i.options.getString('footer');
      const placeholder = i.options.getString('placeholder');
      const customDesc = i.options.getString('description');
      const noText = i.options.getBoolean('sans-texte') ?? false;
      const panelTranslate = i.options.getBoolean('traduction') ?? !!cfg.translate;
      const type = i.options.getString('type') || 'bouton';
      const asButton = type === 'bouton';
      const multi = type === 'boutons';
      const btnLabel = (i.options.getString('bouton-texte') || '').trim().slice(0, 80) || null;
      const style = i.options.getString('couleur-bouton') || 'Primary';
      const showLogo = i.options.getBoolean('logo') ?? true;
      const statsButton = i.options.getBoolean('stats') ?? false;

      if (noText && !img && !isUrl(imgUrl)) {
        return i.reply({ content: '❌ For a panel without text, add an image (file or link).', flags: EPH });
      }
      if (multi && !cfg.reasons.length) {
        return i.reply({ content: '❌ Add at least one category before sending a multi-button panel.', flags: EPH });
      }
      if (multi) {
        // Limite réelle du message V2 (40 composants) : dépend de la bannière, du logo, du texte et du pied de page.
        const limit = multiLimit(
          { v2: HAS_V2, noText, footer },
          img || isUrl(imgUrl) ? 'x' : null,
          showLogo && (thumb || thumbUrl || mediaOk(cfg.logo) || mediaOk(d.panelLogo)) ? 'x' : null,
          customDesc && String(customDesc).trim() ? 'x' : '',
        );
        if (cfg.reasons.length > limit) {
          return i.reply({ content: `❌ This multi-button panel can show ${limit} categories maximum (Discord component limit with this banner/logo/text). Remove some categories or use the drop-down menu.`, flags: EPH });
        }
      }
      await i.deferReply({ flags: EPH });

      if (placeholder) { cfg.placeholder = placeholder.slice(0, 150); save(); }

      // @Pseudo / @Rôle / #salon dans la description -> mentions cliquables
      const richDesc = customDesc ? (await rich(i.guild, customDesc)).text : null;

      if (multi) {
        try {
          // Image / logo conservés en data URL pour pouvoir recharger et renvoyer le panel plus tard.
          const panelImage = img ? await attToData(img) : (isUrl(imgUrl) ? imgUrl : null);
          const panelThumb = thumb ? await attToData(thumb) : (isUrl(thumbUrl) ? thumbUrl : null);
          const panel = {
            channelId: salon.id,
            multi: true,
            v2: HAS_V2,
            customDesc: !!customDesc || noText,
            desc: customDesc ? richDesc : null,
            title: (i.options.getString('titre') || `🎫 Support — ${cfg.name}`).slice(0, 256),
            noText,
            image: panelImage,
            footer: footer || null,
            btnStyle: style,
            translate: !!panelTranslate,
            thumb: panelThumb,
            showLogo,
            statsButton,
            color: i.options.getString('couleur') || null,
          };
          const sent = await salon.send(await buildMultiPanel(i.guild, cfg, panel));
          panel.messageId = sent.id;
          panel.sig = multiPanelSig(i.guild, cfg, panel);
          cfg.panels.push(panel);
          save();
          return i.editReply(
            `✅ Multi-button panel sent to <#${salon.id}>. Each button opens its category (and its sub-panel if one is linked).`);
        } catch (e) {
          console.error(e);
          return i.editReply("❌ Unable to send: check my permissions in this channel, the image link and the category emojis.");
        }
      }

      const embed = new EmbedBuilder().setColor(parseColor(i.options.getString('couleur'), cfg.color || d.panelColor || '#ED4245'));
      if (!noText) {
        embed
          .setTitle(i.options.getString('titre') || `🎫 Support — ${cfg.name}`)
          .setDescription((richDesc || panelDesc(cfg, asButton)).slice(0, 4096))
          .setTimestamp();
        if (footer) embed.setFooter({ text: footer });
      }

      try {
        const files = [];
        // Image / logo conservés en data URL pour pouvoir recharger et renvoyer le panel plus tard.
        let panelImage = isUrl(imgUrl) ? imgUrl : null;
        if (img) {
          panelImage = await attToData(img);
          const ref = await imageRef(panelImage, 'panel', files);
          if (ref) embed.setImage(ref);
        } else if (isUrl(imgUrl)) {
          embed.setImage(imgUrl);
        }
        let explicitThumb = isUrl(thumbUrl) ? thumbUrl : null;
        if (thumb) explicitThumb = await attToData(thumb);
        if (showLogo) {
          const logo = await imageRef(explicitThumb || cfg.logo || d.panelLogo, 'logo', files);
          if (logo) embed.setThumbnail(logo);
        }

        const rows = panelRows(cfg, { button: asButton, label: btnLabel, style, stats: statsButton });
        const sent = await salon.send({ embeds: [embed], files, components: rows });
        // texte figé : le bot ne modifiera jamais le texte (ni l'absence de texte) de ce panel
        const fixed = !!customDesc || noText;
        cfg.panels.push({
          channelId: salon.id,
          messageId: sent.id,
          customDesc: fixed,
          button: asButton,
          btnLabel,
          btnStyle: style,
          translate: !!panelTranslate,
          thumb: explicitThumb,
          showLogo,
          statsButton,
          // Paramètres réutilisables (pré-remplissage du formulaire + mise à jour directe)
          title: (i.options.getString('titre') || `🎫 Support — ${cfg.name}`).slice(0, 256),
          desc: customDesc ? richDesc : null,
          image: panelImage,
          footer: footer || null,
          noText,
          color: i.options.getString('couleur') || null,
          sig: sig({
            rows: rows.map((r) => r.toJSON()),
            desc: fixed ? null : panelDesc(cfg, asButton),
            logo: srcHash(showLogo ? (explicitThumb || cfg.logo || d.panelLogo) : null),
          }),
        });
        save();
        await i.editReply(
          `✅ Panel sent to <#${salon.id}>. It will update on its own.\n` +
          "Ticket opening message: `/ticket message`.");
        if (placeholder) refreshPanels(i.guild, cfgName).catch(console.error);
      } catch (e) {
        console.error(e);
        await i.editReply("❌ Unable to send: check my permissions in this channel, the image link and the category emojis.");
      }
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Autocomplétion                                                     */
/* ------------------------------------------------------------------ */
async function autocomplete(i) {
  const d = getG(i.guildId);
  const f = i.options.getFocused(true);
  const q = String(f.value).toLowerCase();

  if (f.name === 'config') {
    return i.respond(
      Object.keys(d.tickets).filter((n) => n.includes(q)).slice(0, 25).map((n) => ({ name: n, value: n })));
  }
  if (f.name === 'panel') {
    // Panels déjà envoyés d'une configuration (pour /ticket message et /ticket bouton)
    const cfg = d.tickets[i.options.getString('config')];
    return i.respond(
      (cfg?.panels || [])
        .map((p, n) => {
          const kind = cfg.reasons.length && !p.button && !cfg.dm ? 'menu' : `bouton ${BTN_NAMES[p.btnStyle || 'Primary']}`;
          return {
            name: `Panel ${n + 1} · #${i.guild.channels.cache.get(p.channelId)?.name || '?'} · ${kind}`.slice(0, 100),
            value: p.messageId,
          };
        })
        .filter((o) => o.name.toLowerCase().includes(q))
        .slice(0, 25));
  }
  if (f.name === 'label') {
    const cfg = d.tickets[i.options.getString('config')];
    return i.respond(
      (cfg?.reasons || []).filter((r) => r.label.toLowerCase().includes(q)).slice(0, 25)
        .map((r) => ({ name: r.label, value: r.label })));
  }
  if (f.name === 'choix') {
    // Choix du menu envoyé en MP (pour /ticket mp-choix-modifier et mp-choix-retirer)
    const cfg = d.tickets[i.options.getString('config')];
    return i.respond(
      (cfg?.dmChoices || []).filter((r) => r.label.toLowerCase().includes(q)).slice(0, 25)
        .map((r) => ({ name: r.label, value: r.label })));
  }
  if (f.name === 'sous-panel') {
    const cfg = d.tickets[i.options.getString('config')];
    const list = (cfg?.subPanels || []).map((x) => ({ name: `${x.name} (${x.choices.length} choix)`.slice(0, 100), value: x.id }));
    if (i.options.getSubcommand(false) === 'lier') list.unshift({ name: '❌ No subpanel (direct ticket)', value: 'none' });
    return i.respond(list.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 25));
  }
  if (f.name === 'suivant') {
    const cfg = d.tickets[i.options.getString('config')];
    const cur = cfg && findSub(cfg, i.options.getString('sous-panel'));
    const list = (cfg?.subPanels || []).filter((x) => cur && x !== cur && !subReaches(cfg, x.id, cur.id))
      .map((x) => ({ name: `${x.name} (${x.choices.length} choix)`.slice(0, 100), value: x.id }));
    list.unshift({ name: '❌ None (direct ticket)', value: 'aucun' });
    return i.respond(list.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 25));
  }
  if (f.name === 'sous-choix') {
    const cfg = d.tickets[i.options.getString('config')];
    const sp = cfg && findSub(cfg, i.options.getString('sous-panel'));
    return i.respond((sp?.choices || []).filter((c) => c.label.toLowerCase().includes(q)).slice(0, 25)
      .map((c) => ({ name: c.label.slice(0, 100), value: c.id })));
  }
  if (f.name === 'pour') {
    const cfg = d.tickets[i.options.getString('config')];
    const list = cfg
      ? [{ name: '🌐 All categories (default)', value: 'all' },
        ...subTargets(cfg).map((t) => ({ name: `${t.mp ? '📩 DM · ' : ''}${t.label}`.slice(0, 100), value: t.id }))]
      : [];
    return i.respond(list.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 25));
  }
  if (f.name === 'message') {
    // Liste des autoroles (pour /autorole supprimer)
    return i.respond(
      Object.entries(d.reactionRoles)
        .map(([id, r]) => ({
          name: `${r.label} → @${i.guild.roles.cache.get(r.roleId)?.name || 'deleted role'} (#${i.guild.channels.cache.get(r.channelId)?.name || '?'})`.slice(0, 100),
          value: id,
        }))
        .filter((o) => o.name.toLowerCase().includes(q))
        .slice(0, 25));
  }
  if (f.name === 'giveaway') {
    const sub = i.options.getSubcommand(false);
    return i.respond(
      Object.entries(d.giveaways)
        .filter(([, g]) => sub === 'annuler' || (sub === 'reroll' ? g.ended : !g.ended))
        .filter(([, g]) => g.prize.toLowerCase().includes(q))
        .sort((a, b) => b[1].endAt - a[1].endAt)
        .slice(0, 25)
        .map(([id, g]) => ({
          name: `${g.prize} (#${i.guild.channels.cache.get(g.channelId)?.name || '?'})${g.ended ? ' — ended' : ''}`.slice(0, 100),
          value: id,
        })));
  }
  if (f.name === 'lien') {
    return i.respond(
      Object.entries(d.invites.links)
        .map(([code, l]) => ({
          name: `discord.gg/${code} → ${i.guild.members.cache.get(l.userId)?.user.username || l.userId}`.slice(0, 100),
          value: code,
        }))
        .filter((o) => o.name.toLowerCase().includes(q))
        .slice(0, 25));
  }
  if (f.name === 'commande') {
    if (!isOwner(i)) return i.respond([]);
    const sub = i.options.getSubcommand(false);
    let names = commands.map((c) => c.name);
    if (i.commandName === 'commandes') {
      names = sub === 'activer'
        ? d.disabledCommands.slice()
        : names.filter((n) => !ALWAYS_ON.has(n) && !d.disabledCommands.includes(n));
    } else if (sub === 'retirer') {
      names = [...new Set([...Object.keys(d.cmdPerms), ...Object.keys(d.cmdUsers || {})])]
        .filter((n) => (d.cmdPerms[n]?.length || d.cmdUsers?.[n]?.length));
    } else {
      names = names.filter((n) => !OWNER_ONLY.has(n));
    }
    return i.respond(names.filter((n) => n.includes(q)).slice(0, 25).map((n) => ({ name: `/${n}`, value: n })));
  }
  if (f.name === 'utilisateur') {
    // Liste des bannis (pour /unban) — réservée à ceux qui peuvent modérer
    if (!canModerate(i)) return i.respond([]);
    // L'autocomplétion doit répondre en moins de 3 s : on s'appuie sur un cache et on abandonne au bout de 2 s
    const list = await Promise.race([
      getBans(i.guild).catch((e) => { console.error('[unban autocomplete]', e.message); return null; }),
      new Promise((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (!list) return i.respond([]);
    return i.respond(
      list
        .filter((b) => b.username.toLowerCase().includes(q) || b.id.includes(q))
        .slice(0, 25)
        .map((b) => ({ name: `${b.username} (${b.id})`.slice(0, 100), value: b.id })));
  }
  return i.respond([]);
}

/* ------------------------------------------------------------------ */
/*  Événements                                                         */
/* ------------------------------------------------------------------ */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Les commandes sont enregistrées serveur par serveur (pour pouvoir en retirer)
  await client.application.commands.set([]).catch(console.error); // supprime les anciennes commandes globales
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
  console.log('✅ Commands registered');

  client.guilds.cache.forEach(updateCount);
  setInterval(() => client.guilds.cache.forEach(updateCount), 10 * 60_000);

  // Cache des invitations (pour savoir qui invite qui)
  for (const guild of client.guilds.cache.values()) await snapshotInvites(guild);

  // Fin automatique des mutes
  checkMutes();
  setInterval(checkMutes, 15_000);

  // Fin automatique des giveaways
  checkGiveaways();
  setInterval(checkGiveaways, 10_000);

  // Mise à jour automatique de tous les systèmes (panels de tickets, autoroles, giveaways, classement, salon commandes)
  for (const guild of client.guilds.cache.values()) await refreshGuild(guild);
  console.log('✅ Systems updated automatically');

  // Le classement des invitations se met à jour tout seul toutes les 5 minutes
  setInterval(() => {
    client.guilds.cache.forEach((g) => refreshBoard(g).catch(console.error));
  }, 5 * 60_000);
});

// Invitations : nouvelle invitation créée / bot ajouté à un serveur
// (on ne vide pas le cache à la suppression : une invitation à usage limité disparaît juste après l'arrivée)
client.on(Events.InviteCreate, (inv) => {
  if (!inv.guild) return;
  const m = inviteCache.get(inv.guild.id) || new Map();
  m.set(inv.code, {
    uses: inv.uses ?? 0, maxUses: inv.maxUses || 0,
    inviterId: getG(inv.guild.id).invites.links[inv.code]?.userId || inv.inviter?.id || null,
  });
  inviteCache.set(inv.guild.id, m);
});
client.on(Events.GuildCreate, (guild) => { snapshotInvites(guild); registerCommands(guild); });

// Un nouveau salon reprend aussi les règles de sa catégorie et reste invisible pour les membres mute
client.on(Events.ChannelCreate, (ch) => {
  if (!ch.guild || !ch.permissionOverwrites) return;
  const d = getG(ch.guild.id);
  const id = d.muteRoleId;
  const role = id && ch.guild.roles.cache.get(id);
  if (role) ch.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => {});
  const access = ch.parentId && d.catAccess[ch.parentId];
  if (access) applyAccessTo(ch, access).catch(console.error);
});

// Salon des commandes : personne ne lit les messages des autres.
// Les réponses du bot sont privées et les messages écrits à la main dans ce salon sont supprimés.
/* ------------------------------------------------------------------ */
/*  Live translation inside tickets (any language → French + English)  */
/* ------------------------------------------------------------------ */
const TR_CACHE = new Map();

function protectTranslation(text) {
  const store = [];
  const hold = (s) => { const k = `ZXQTOKEN${store.length}QXZ`; store.push(s); return k; };
  const out = String(text)
    .replace(/<a?:[A-Za-z0-9_~]+:\d+>/g, hold)
    .replace(/<@[!&]?\d+>/g, hold)
    .replace(/<#\d+>/g, hold)
    .replace(/\{[A-Za-z0-9_]+\}/g, hold)
    .replace(/https?:\/\/\S+/g, hold);
  const restore = (s) => {
    let x = String(s);
    for (let i = 0; i < 4 && /Z\s*X\s*Q\s*T\s*O\s*K\s*E\s*N/i.test(x); i++) {
      x = x.replace(/Z\s*X\s*Q\s*T\s*O\s*K\s*E\s*N\s*(\d+)\s*Q\s*X\s*Z/gi, (_, n) => store[Number(n)] ?? '');
    }
    return x;
  };
  return { out, restore };
}

// Reads the two payload shapes returned by the free Google endpoints.
function parseGoogle(payload) {
  if (!Array.isArray(payload) || !payload.length) return null;
  if (Array.isArray(payload[0]) && Array.isArray(payload[0][0])) {
    // [[["text", ...], ...], null, "fr", ...]
    const translated = payload[0].map((p) => (Array.isArray(p) ? p[0] || '' : '')).join('');
    if (!translated) return null;
    return { translated, detected: String(payload[2] || '').toLowerCase() };
  }
  if (Array.isArray(payload[0])) {
    // [["text", "fr"]]
    const first = payload[0];
    const translated = typeof first[0] === 'string' ? first[0] : '';
    if (!translated) return null;
    const detected = typeof first[1] === 'string' ? first[1] : (typeof payload[1] === 'string' ? payload[1] : '');
    return { translated, detected: String(detected).toLowerCase() };
  }
  if (typeof payload[0] === 'string') {
    return { translated: payload[0], detected: String(payload[1] || '').toLowerCase() };
  }
  return null;
}

async function fetchJson(url) {
  if (typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZNKBot/1.0)' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function googleTranslate(text, to) {
  const q = String(text).slice(0, 1800);
  const key = `${to}\u0000${q}`;
  if (TR_CACHE.has(key)) return TR_CACHE.get(key);
  const encoded = encodeURIComponent(q);
  const lang = encodeURIComponent(to);
  let result = parseGoogle(await fetchJson(
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${lang}&q=${encoded}`,
  ));
  if (!result) {
    result = parseGoogle(await fetchJson(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encoded}`,
    ));
  }
  if (!result) return null;
  if (TR_CACHE.size > 3000) TR_CACHE.clear();
  TR_CACHE.set(key, result);
  return result;
}

function isTranslatable(raw) {
  if (!raw || raw.length < 2) return false;
  const s = raw.replace(/<[@#:][^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();
  if (!s) return false;
  if (/^[/!?.,;:]/.test(s)) return false; // commands and punctuation-only messages
  const letters = (s.match(/\p{L}/gu) || []).length;
  return letters >= 2;
}

// Detects the source language, then returns the missing translation(s):
//   French  -> { en }         English -> { fr }
//   other   -> { fr, en }     (both, so everyone understands the ticket)
async function translatePair(raw) {
  const { out, restore } = protectTranslation(raw);
  const toEnglish = await googleTranslate(out, 'en');
  if (!toEnglish) return null;
  const detected = String(toEnglish.detected || '').split(/[-_]/)[0].toLowerCase();
  const en = restore(toEnglish.translated).trim();
  if (detected === 'fr') return en ? { en } : null;
  const toFrench = await googleTranslate(out, 'fr');
  const fr = toFrench ? restore(toFrench.translated).trim() : '';
  if (detected === 'en') return fr ? { fr } : null;
  return (fr || en) ? { fr, en } : null;
}

async function liveTranslate(message) {
  if (!message.guildId || message.author.bot || message.system) return;
  const d = getG(message.guildId);
  const t = d.open[message.channelId];
  if (!t) return;
  if (!t.translate && !d.tickets[t.config]?.translate) return;
  const raw = (message.content || '').trim();
  if (!isTranslatable(raw)) return;

  const res = await translatePair(raw);
  if (!res) return;
  const lines = [];
  if (res.fr && res.fr.toLowerCase() !== raw.toLowerCase()) lines.push(`🇫🇷 ${res.fr}`);
  if (res.en && res.en.toLowerCase() !== raw.toLowerCase()) lines.push(`🇬🇧 ${res.en}`);
  if (!lines.length) return;
  await message.reply({
    content: lines.join('\n').slice(0, 2000),
    allowedMentions: { repliedUser: false, parse: [] },
  }).catch(() => {});
}

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || message.author.bot || message.system) return;
  if (getG(message.guildId).commandChannelId === message.channelId) {
    message.delete().catch(() => {});
    return;
  }
  liveTranslate(message).catch(() => {});
});

// Si le salon des commandes est supprimé, la restriction est levée automatiquement
client.on(Events.ChannelDelete, (ch) => {
  if (!ch.guild) return;
  const d = getG(ch.guild.id);
  if (d.commandChannelId === ch.id) {
    d.commandChannelId = null;
    save();
  }
});

// Rôles modifiés : met à jour l'accès aux tickets « tous les rôles requis »
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  const a = oldM.roles.cache, b = newM.roles.cache;
  if (a.size === b.size && [...a.keys()].every((id) => b.has(id))) return;
  syncMemberTicketAccess(newM).catch(console.error);
});

client.on(Events.GuildMemberAdd, async (member) => {
  scheduleCount(member.guild);

  // Invitations : on cherche qui a invité ce membre
  await onInviteJoin(member).catch(console.error);

  // Anti-contournement : si le membre était mute et revient, il reste mute
  const d = getG(member.guild.id);
  const rec = d.muted[member.id];
  if (rec) {
    if (rec.until > Date.now()) {
      const role = member.guild.roles.cache.get(d.muteRoleId);
      if (role) member.roles.add(role, 'Mute in progress').catch(console.error);
    } else {
      delete d.muted[member.id];
      save();
    }
  }

  // Rôles automatiques à l'arrivée (pas pour les bots, ni pour un membre encore mute)
  if (!member.user.bot && !(rec && rec.until > Date.now())) {
    const ids = d.joinRoles.filter((id) => {
      const r = member.guild.roles.cache.get(id);
      return r && !r.managed && r.editable;
    });
    if (ids.length) {
      await member.roles.add(ids, "Automatic role on arrival").catch(console.error);
    }
    // Restauration de la sauvegarde des membres : on remet les rôles par nom.
    const saved = (d.memberBackup?.members || []).find((m) => m.id === member.id);
    if (saved?.roles?.length) {
      const byName = new Map(member.guild.roles.cache.map((r) => [r.name.toLowerCase(), r]));
      const restoreIds = saved.roles
        .map((name) => byName.get(String(name).toLowerCase()))
        .filter((r) => r && !r.managed && r.editable && r.id !== member.guild.id)
        .map((r) => r.id);
      if (restoreIds.length) {
        await member.roles.add(restoreIds, 'Restored from member backup').catch(console.error);
      }
    }
  }

  const w = d.welcome;
  if (!w.enabled || !w.channelId) return;
  const ch = await member.guild.channels.fetch(w.channelId).catch(() => null);
  if (ch) ch.send(await buildWelcome(member)).catch(console.error);
});

client.on(Events.GuildMemberRemove, (member) => {
  scheduleCount(member.guild);
  onInviteLeave(member);
});

// Autorole : réaction ajoutée / retirée
client.on(Events.MessageReactionAdd, (reaction, user) => handleReaction(reaction, user, true));
client.on(Events.MessageReactionRemove, (reaction, user) => handleReaction(reaction, user, false));

// Si un message géré est supprimé à la main (autorole, giveaway), on nettoie l'enregistrement
client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  const d = getG(message.guildId);
  let changed = false;
  if (d.reactionRoles[message.id]) { delete d.reactionRoles[message.id]; changed = true; }
  if (d.giveaways[message.id]) { delete d.giveaways[message.id]; changed = true; }
  if (changed) save();
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // Menu déroulant reçu en MP (pas de serveur dans l'interaction : l'ID du serveur est dans le customId)
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_dm:')) return await dmChoose(i);
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_dmsub:')) return await dmSubChoose(i);

    if (i.isAutocomplete()) {
      if (!commandAllowed(i)) return await i.respond([]);
      return await autocomplete(i);
    }
    if (i.isChatInputCommand()) {
      if (!commandAllowed(i)) return await i.reply(NO_ACCESS);
      if (getG(i.guildId).disabledCommands.includes(i.commandName) && !ALWAYS_ON.has(i.commandName)) {
        return await i.reply({ content: '❌ This command is disabled.', flags: EPH });
      }

      // Commande tapée dans le mauvais salon : message visible uniquement par celui qui l'a envoyée
      const wc = wrongChannel(i);
      if (wc) {
        return await i.reply({
          content: `❌ Commands are not used here. Go to <#${wc}> to type \`/${i.commandName}\`.`,
          flags: EPH,
        });
      }
      return await handlers[i.commandName]?.(i);
    }
    if (i.isModalSubmit()) {
      if (i.customId.startsWith('vouch_modal:')) return await vouchSubmit(i);
      if (i.customId.startsWith('tk_sale_modal:')) return await saleSubmit(i);
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_sub:')) return await subChoose(i);
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_open:')) {
      return await openTicket(i, i.customId.split(':')[1], i.values[0]);
    }
    if (i.isButton()) {
      if (i.customId.startsWith('tk_open:')) {
        const [, cfgName, reasonId] = i.customId.split(':');
        return await openTicket(i, cfgName, reasonId || null);
      }
      if (i.customId === 'tk_close') return await closeTicket(i);
      if (i.customId === 'tk_claim') return await claimTicket(i);
      if (i.customId === 'tk_vouch') return await vouchPanel(i);
      if (i.customId === 'tk_ask_staff') return await askStaff(i);
      if (i.customId.startsWith('tk_stats:')) return await ticketStats(i);
      if (i.customId.startsWith('vouch:star:')) return await vouchModal(i, i.customId.split(':')[2]);
      if (i.customId.startsWith('vouch_logs:')) return await vouchLogs(i);
      if (i.customId.startsWith('vouch_del:')) return await vouchDelete(i);
      if (i.customId.startsWith('tk_sale:yes:')) return await saleModal(i, i.customId.split(':')[2]);
      if (i.customId.startsWith('tk_sale:no:')) return await finishClose(i, null);
      if (i.customId === 'tk_close_cancel') {
        return await i.update({ content: '✅ Closure canceled.', embeds: [], components: [] });
      }
      if (i.customId === 'gw_join') return await gwJoin(i);
      if (i.customId.startsWith('gw_leave:')) return await gwLeave(i);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '❌ An error has occurred.', flags: EPH };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else if (!i.isAutocomplete()) i.reply(msg).catch(() => {});
  }
});

// Supabase fait foi au démarrage : on recharge les données (panels, configs...) AVANT de connecter le bot
supabase.init(db).catch((e) => console.error('[supabase]', e.message)).finally(() => client.login(process.env.TOKEN));

// Filet de sécurité : toutes les 2 minutes, tout est réécrit (fichier + Supabase) même si une modification a oublié d'appeler save()
setInterval(save, 2 * 60_000).unref?.();

// ---------------------------------------------------------------------------
// Sauvegarde / restauration des membres (changement de serveur, ban…)
// ---------------------------------------------------------------------------
async function backupMembers(guild) {
  const d = getG(guild.id);
  const fetched = await guild.members.fetch().catch(() => guild.members.cache);
  const members = [...fetched.values()]
    .filter((m) => !m.user.bot)
    .map((m) => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName || m.user.username,
      joinedAt: m.joinedTimestamp || null,
      roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name),
    }));
  d.memberBackup = { at: Date.now(), guildName: guild.name, guildId: guild.id, members };
  save();
  return { count: members.length, at: d.memberBackup.at, guildName: guild.name };
}

// Discord ne permet pas à un bot d'ajouter un membre de force : on crée une invitation
// permanente et on l'envoie en MP à chaque membre sauvegardé. Les rôles sont restaurés
// automatiquement à l'arrivée (voir GuildMemberAdd).
async function restoreMembers(guild, { dm = true, backup = null } = {}) {
  const d = getG(guild.id);
  const bk = backup || d.memberBackup;
  if (!bk?.members?.length) throw new Error('No member backup saved for this server.');
  // La sauvegarde choisie (ancien serveur) devient celle du serveur actuel :
  // les rôles pourront être restaurés à l'arrivée des membres.
  if (backup && backup !== d.memberBackup) {
    d.memberBackup = backup;
    save();
  }
  const me = guild.members.me || guild.members.cache.get(client.user.id);
  let inviteUrl = null;
  const candidates = guild.channels.cache.filter((c) =>
    c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite));
  const ch = guild.systemChannel && candidates.has(guild.systemChannel.id)
    ? guild.systemChannel
    : candidates.first();
  if (ch) {
    const inv = await ch.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: 'Member backup restore' }).catch(() => null);
    inviteUrl = inv?.url || null;
  }
  let present = 0, dmed = 0, failed = 0;
  for (const m of bk.members) {
    if (guild.members.cache.has(m.id)) { present++; continue; }
    if (!dm || !inviteUrl) { failed++; continue; }
    const user = await client.users.fetch(m.id).catch(() => null);
    if (!user) { failed++; continue; }
    const ok = await user.send({
      content: `👋 **${guild.name}** has a new server!\nJoin here: ${inviteUrl}\n\nIf you already joined, you can ignore this message.`,
    }).then(() => true).catch(() => false);
    if (ok) dmed++; else failed++;
  }
  return { total: bk.members.length, present, dmed, failed, inviteUrl };
}

// Panel web (dashboard.js + panel.html) — nécessite la variable PANEL_PASSWORD
require("./dashboard")({ client, commands, handlers, autocomplete, getG, refreshPanels, refreshSalesPanel,
  buildCatalogPayload, buildSinglePanel, buildMultiPanel, multiPanelSig, rich, syncCommandChannel,
  sendRestockAnnouncement,
  backupMembers, restoreMembers,
  CMD_CATEGORIES, ALWAYS_ON, PUBLIC_COMMANDS, OWNER_ONLY, db, save, DB_FILE });