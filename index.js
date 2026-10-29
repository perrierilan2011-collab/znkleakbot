require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
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
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const BACKUP_FILE = DB_FILE + '.bak';
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// Première utilisation du volume : on copie l'ancien data.json livré avec le code (une seule fois).
// Ensuite le fichier du volume est la seule référence et n'est plus jamais écrasé par un déploiement.
const SEED_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DB_FILE) && path.resolve(SEED_FILE) !== path.resolve(DB_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, DB_FILE);
  console.log(`[db] ancien data.json copié vers ${DB_FILE}`);
}

function loadDb() {
  for (const f of [DB_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      console.log(`[db] données chargées depuis ${f} (${Object.keys(data).length} serveur(s))`);
      return data;
    } catch (e) {
      console.error(`[db] ${f} illisible :`, e.message);
    }
  }
  // Fichier présent mais illisible et pas de sauvegarde valide : on le garde de côté avant de repartir à vide
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.corrompu-${Date.now()}`);
  console.warn(`[db] AUCUNE donnée trouvée (${DB_FILE}) : démarrage à vide.`);
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
  } catch (e) {
    console.error('[db] sauvegarde impossible :', e);
  }
};

function getG(id) {
  db[id] ??= {
    memberCountChannel: null,
    memberCountFormat: '👥 Membres : {count}',
    welcome: {
      enabled: false,
      channelId: null,
      content: '{user}',
      title: 'Bienvenue {username} !',
      description: 'Bienvenue sur **{server}** ! Tu es le membre n°{count}.',
      image: '',
      color: '#5865F2',
    },
    tickets: {}, // nom -> { name, categoryId, staffRoles[], logChannelId, reasons[], counter, panels[] }
    open: {},    // channelId -> { userId, config, reason, claimedBy, staffRoles[] }
  };
  const g = db[id];
  // Ajout des nouveaux champs pour les serveurs déjà enregistrés
  g.modRoles ??= [];        // rôles autorisés à utiliser ban / unban / mute / unmute
  g.protectedRoles ??= [];  // rôles que seul le propriétaire peut mute / ban
  g.muteRoleId ??= null;    // rôle "Muté" créé par le bot
  g.muted ??= {};           // userId -> { roles[], until, reason, by }
  g.reactionRoles ??= {};   // messageId -> { channelId, roleId, emoji, label }
  g.sanctionChannel ??= null; // salon par défaut où annoncer les ban / mute
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
  // Migration : un seul rôle staff -> plusieurs rôles staff
  for (const c of Object.values(g.tickets)) {
    c.staffRoles ??= c.staffRoleId ? [c.staffRoleId] : [];
    c.panels ??= []; // panels envoyés : [{ channelId, messageId, customDesc, sig }]
  }
  return g;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const EPH = MessageFlags.Ephemeral;
const isUrl = (u) => /^https?:\/\/\S+$/i.test((u || '').trim());
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

function field(id, label, style, { required = false, value, max, placeholder } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) t.setValue(value.slice(0, max || 4000));
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
}

// Re-télécharge une pièce jointe (les liens CDN de Discord expirent)
async function toFile(att, baseName) {
  const res = await fetch(att.url);
  const ext = (att.name || '').match(/\.\w+$/)?.[0] || '.png';
  return new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: baseName + ext });
}

/* ---------- Formulaire + embed partagés par /annonce et /autorole ---------- */
function announceModal(modalId, title, textLabel = "Texte de l'annonce (Markdown accepté)") {
  return new ModalBuilder().setCustomId(modalId).setTitle(title).addComponents(
    field('titre', 'Titre', TextInputStyle.Short, { max: 256 }),
    field('texte', textLabel, TextInputStyle.Paragraph, { required: true, max: 4000 }),
    field('image_url', "URL d'image (si pas de fichier)", TextInputStyle.Short, { max: 500 }),
    field('footer', 'Pied de page', TextInputStyle.Short, { max: 2048 }),
    field('couleur', 'Couleur hex (ex : #FF0000)', TextInputStyle.Short, { max: 7 }),
  );
}

async function buildAnnounce(m, img, thumb) {
  const titre = m.fields.getTextInputValue('titre');
  const texte = m.fields.getTextInputValue('texte');
  const imageUrl = m.fields.getTextInputValue('image_url').trim();
  const footer = m.fields.getTextInputValue('footer');
  const couleur = m.fields.getTextInputValue('couleur');

  const embed = new EmbedBuilder().setColor(parseColor(couleur)).setDescription(texte);
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
  return { embed, files };
}

function buildMentions(ping, mentionOpt) {
  const parts = [];
  const allowed = { parse: [], roles: [], users: [] };
  if (ping) { parts.push(`@${ping}`); allowed.parse.push('everyone'); }
  if (mentionOpt?.role) { parts.push(`<@&${mentionOpt.role.id}>`); allowed.roles.push(mentionOpt.role.id); }
  else if (mentionOpt?.user) { parts.push(`<@${mentionOpt.user.id}>`); allowed.users.push(mentionOpt.user.id); }
  return { content: parts.join(' ') || undefined, allowed };
}

/* ------------------------------------------------------------------ */
/*  Permissions de modération                                          */
/* ------------------------------------------------------------------ */
// 👑 = propriétaire du serveur (la couronne)
const isOwner = (i) => i.guild.ownerId === i.user.id;

// Le propriétaire OU un membre ayant un rôle choisi avec /role-total : accès à TOUTES les commandes
const hasFullAccess = (i) =>
  isOwner(i) || i.member.roles.cache.some((r) => getG(i.guildId).fullRoles.includes(r.id));

// Accès total OU un membre ayant un rôle choisi avec /roles-mod
const canModerate = (i) =>
  hasFullAccess(i) || i.member.roles.cache.some((r) => getG(i.guildId).modRoles.includes(r.id));

// Les rôles /roles-mod n'ont accès qu'à ces commandes. Toutes les autres : accès total uniquement.
const MOD_COMMANDS = new Set(['ban', 'unban', 'mute', 'unmute', 'sanctions-actives', 'historique-sanctions']);
// Commandes ouvertes à tout le monde
const PUBLIC_COMMANDS = new Set(['help', 'invites']);
const commandAllowed = (i) =>
  PUBLIC_COMMANDS.has(i.commandName) || hasFullAccess(i) || (MOD_COMMANDS.has(i.commandName) && canModerate(i));

const NO_ACCESS = { content: "❌ Tu n'as pas accès à cette commande.", flags: EPH };

/* ---------- Salon des commandes (privé) ---------- */
// Ces commandes restent utilisables partout : les publiques (le salon est privé, les membres ne le voient pas)
// et /salon-commandes (pour pouvoir le reconfigurer depuis n'importe où)
const GATE_EXEMPT = new Set([...PUBLIC_COMMANDS, 'salon-commandes']);

// Renvoie l'ID du salon des commandes si la commande est utilisée au mauvais endroit, sinon null
function wrongChannel(i) {
  const id = getG(i.guildId).commandChannelId;
  if (!id || GATE_EXEMPT.has(i.commandName) || i.channelId === id) return null;
  if (!i.guild.channels.cache.has(id)) return null; // salon supprimé : plus de restriction
  return id;
}

// Visible uniquement par : rôles accès total, rôles modération, rôles ajoutés avec /salon-commandes, bot
// (+ propriétaire / admins qui voient tout)
function commandChannelOverwrites(guild) {
  const d = getG(guild.id);
  const P = PermissionFlagsBits;
  const ids = [...new Set([...d.fullRoles, ...d.modRoles, ...d.commandChannelRoles])]
    .filter((id) => id !== guild.id && guild.roles.cache.has(id));
  return [
    { id: guild.id, deny: [P.ViewChannel] },
    ...ids.map((id) => ({
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
  await ch.permissionOverwrites.set(commandChannelOverwrites(guild), 'Synchronisation du salon des commandes')
    .catch(console.error);
}

// Vérifie qu'on a le droit de sanctionner (ban / mute) cette personne. Renvoie un message d'erreur ou null.
function targetError(i, user, member) {
  if (user.id === i.user.id) return '❌ Tu ne peux pas faire ça sur toi-même.';
  if (user.id === client.user.id) return '❌ Je ne peux pas me sanctionner moi-même.';
  if (user.id === i.guild.ownerId) return '❌ Le propriétaire du serveur est intouchable.';
  if (member && !isOwner(i)) {
    const d = getG(i.guildId);
    if (member.roles.cache.some((r) => d.protectedRoles.includes(r.id))) {
      return '❌ Ce membre a un rôle protégé : seul le propriétaire du serveur peut le sanctionner.';
    }
    if (i.member.roles.highest.position <= member.roles.highest.position) {
      return '❌ Ce membre a un rôle supérieur ou égal au tien.';
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
  if (!lines.length) return 'Aucun.';
  let out = '', n = 0;
  for (const l of lines) {
    if ((out + l + '\n').length > max) break;
    out += l + '\n'; n++;
  }
  return out + (n < lines.length ? `… et ${lines.length - n} de plus` : '');
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
  const map = new Map();
  for (const inv of invites.values()) {
    map.set(inv.code, { uses: inv.uses ?? 0, maxUses: inv.maxUses || 0, inviterId: inv.inviter?.id || null });
  }
  inviteCache.set(guild.id, map);
  return map;
}

// Compare avec le cache : l'invitation dont le compteur a augmenté est celle utilisée
async function findInviter(guild) {
  const old = inviteCache.get(guild.id) || new Map();
  const now = await snapshotInvites(guild);
  if (!now) return null;
  for (const [code, inv] of now) {
    if (inv.uses > (old.get(code)?.uses ?? 0)) return inv.inviterId;
  }
  // Invitation à usage limité supprimée juste après l'arrivée
  for (const [code, inv] of old) {
    if (!now.has(code) && inv.maxUses && inv.uses + 1 >= inv.maxUses) return inv.inviterId;
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
      await member.roles.add(role, `Récompense : ${r.count} invitations`).catch(console.error);
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
    `${MEDALS[idx] || `**${idx + 1}.**`} <@${e.id}> — **${e.n}** invitation${e.n > 1 ? 's' : ''} ` +
    `(${e.s.joins} arrivées · ${e.s.left || 0} départs)`);
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🏆 Classement des invitations')
    .setDescription((lines.join('\n') || "Personne n'a encore invité de membre.").slice(0, 4096))
    .setFooter({ text: 'Mis à jour' })
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
  const inviterId = await findInviter(member.guild).catch(() => null);
  if (!inviterId || inviterId === member.id) return;
  const d = getG(member.guild.id).invites;
  d.joinedBy[member.id] = inviterId;
  const s = (d.stats[inviterId] ??= { joins: 0, left: 0 });
  s.joins++;
  save();
  await checkInviteRewards(member.guild, inviterId);
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
const commands = [
  // ---------- Salon privé des commandes ----------
  new SlashCommandBuilder()
    .setName('salon-commandes')
    .setDescription('Créer / modifier le salon privé où utiliser les commandes du bot')
    .addChannelOption((o) =>
      o.setName('categorie').setDescription('Catégorie du salon (obligatoire à la première création)')
        .addChannelTypes(ChannelType.GuildCategory))
    .addStringOption((o) =>
      o.setName('nom').setDescription('Nom du salon (commandes par défaut)').setMaxLength(90))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle qui aura accès au salon'))
    .addRoleOption((o) => o.setName('role2').setDescription('Autre rôle qui aura accès au salon'))
    .addRoleOption((o) => o.setName('role3').setDescription('Autre rôle qui aura accès au salon'))
    .addBooleanOption((o) =>
      o.setName('vider-roles').setDescription("Retirer d'abord tous les rôles ajoutés à la main"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Giveaways ----------
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaways : concours avec tirage au sort')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Lancer un giveaway')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon où lancer le giveaway')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName('lot').setDescription('Ce qu\'il y a à gagner').setMaxLength(200).setRequired(true))
        .addIntegerOption((o) =>
          o.setName('duree').setDescription('Durée (nombre)').setMinValue(1).setMaxValue(525600).setRequired(true))
        .addStringOption((o) =>
          o.setName('unite').setDescription('Unité de temps').setRequired(true)
            .addChoices(
              { name: 'Minutes', value: 'minutes' },
              { name: 'Heures', value: 'heures' },
              { name: 'Jours', value: 'jours' },
            ))
        .addIntegerOption((o) =>
          o.setName('gagnants').setDescription('Nombre de gagnants (1 par défaut)').setMinValue(1).setMaxValue(20))
        .addStringOption((o) => o.setName('description').setDescription('Texte sous le titre').setMaxLength(1000))
        .addRoleOption((o) => o.setName('role-requis').setDescription('Rôle nécessaire pour participer'))
        .addIntegerOption((o) =>
          o.setName('invites-min').setDescription("Nombre d'invitations minimum pour participer")
            .setMinValue(1).setMaxValue(100000))
        .addMentionableOption((o) => o.setName('mention').setDescription('Rôle ou membre à mentionner'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Mention globale')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
        .addAttachmentOption((o) => o.setName('image').setDescription('Image du giveaway')))
    .addSubcommand((s) =>
      s.setName('terminer').setDescription('Terminer un giveaway maintenant et tirer les gagnants')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Giveaway en cours').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('reroll').setDescription('Tirer un nouveau gagnant sur un giveaway terminé')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Giveaway terminé').setAutocomplete(true).setRequired(true))
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription('Nombre de nouveaux gagnants (1 par défaut)').setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) =>
      s.setName('annuler').setDescription('Annuler un giveaway et supprimer son message')
        .addStringOption((o) =>
          o.setName('giveaway').setDescription('Giveaway').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les giveaways en cours'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  // ---------- Compteur de membres ----------
  new SlashCommandBuilder()
    .setName('membercount')
    .setDescription('Crée un salon vocal qui affiche le nombre de membres')
    .addStringOption((o) =>
      o.setName('format').setDescription('Texte du salon, utilise {count}. Ex : 👥 Membres : {count}'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  // ---------- Ban ----------
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à bannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du ban'))
    .addIntegerOption((o) =>
      o.setName('supprimer_messages').setDescription('Supprimer ses messages récents')
        .addChoices(
          { name: 'Ne pas supprimer', value: 0 },
          { name: '24 dernières heures', value: 1 },
          { name: '7 derniers jours', value: 7 },
        ))
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon où annoncer le ban')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .setDefaultMemberPermissions(null) // l'accès est géré par /roles-mod
    .setDMPermission(false),

  // ---------- Unban ----------
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un utilisateur')
    .addStringOption((o) =>
      o.setName('utilisateur').setDescription('Utilisateur banni (choisis dans la liste ou colle son ID)')
        .setAutocomplete(true).setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du débannissement'))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Mute ----------
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Rendre un membre muet : il ne voit plus aucun salon')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à mute').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('duree').setDescription('Durée du mute (nombre)').setMinValue(1).setMaxValue(525600).setRequired(true))
    .addStringOption((o) =>
      o.setName('unite').setDescription('Unité de temps').setRequired(true)
        .addChoices(
          { name: 'Minutes', value: 'minutes' },
          { name: 'Heures', value: 'heures' },
          { name: 'Jours', value: 'jours' },
        ))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du mute'))
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon où annoncer le mute')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Unmute ----------
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Enlever le mute d\'un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à unmute').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription("Raison de l'unmute"))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Salon par défaut des annonces de sanctions ----------
  new SlashCommandBuilder()
    .setName('salon-sanctions')
    .setDescription('Salon par défaut où annoncer les ban et mute')
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Le salon des sanctions')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Bannis et mutés actuels ----------
  new SlashCommandBuilder()
    .setName('sanctions-actives')
    .setDescription('Voir tous les membres actuellement bannis ou mute')
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Historique d'un membre ----------
  new SlashCommandBuilder()
    .setName('historique-sanctions')
    .setDescription('Voir si un membre a déjà été banni ou mute')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à vérifier').setRequired(true))
    .setDefaultMemberPermissions(null)
    .setDMPermission(false),

  // ---------- Aide ----------
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Voir toutes les commandes auxquelles tu as accès')
    .setDMPermission(false),

  // ---------- Invitations (ouvert à tout le monde) ----------
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription("Voir ton nombre d'invitations (ou celui d'un membre)")
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à regarder (réservé au staff)'))
    .setDMPermission(false),

  // ---------- Configuration des récompenses d'invitations ----------
  new SlashCommandBuilder()
    .setName('invites-config')
    .setDescription("Configurer les rôles automatiques selon le nombre d'invitations")
    .addSubcommand((s) =>
      s.setName('recompense-ajouter').setDescription('Donner un rôle automatiquement à partir de X invitations')
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription("Nombre d'invitations nécessaires").setMinValue(1).setMaxValue(100000).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à donner').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('recompense-retirer').setDescription('Supprimer une récompense')
        .addIntegerOption((o) =>
          o.setName('nombre').setDescription("Nombre d'invitations de la récompense").setMinValue(1).setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les récompenses configurées'))
    .addSubcommand((s) =>
      s.setName('reset').setDescription("Remettre à zéro les invitations d'un membre")
        .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Classement des invitations ----------
  new SlashCommandBuilder()
    .setName('classement-invites')
    .setDescription('Envoyer le classement des invitations dans un salon (mis à jour automatiquement)')
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon où envoyer le classement')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addIntegerOption((o) =>
      o.setName('top').setDescription('Nombre de places affichées (10 par défaut)').setMinValue(3).setMaxValue(25))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('classement-invites-maj')
    .setDescription('Forcer la mise à jour du classement des invitations déjà envoyé')
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles avec accès à toutes les commandes (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('role-total')
    .setDescription('👑 Choisir quels rôles ont accès à TOUTES les commandes du bot')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription("Donner l'accès à toutes les commandes à un rôle")
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à autoriser').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Retirer l'accès total à un rôle")
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à retirer').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les rôles avec accès total'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Rôles autorisés à modérer (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('roles-mod')
    .setDescription('👑 Choisir quels rôles peuvent utiliser ban - unban - mute - unmute')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Autoriser un rôle à utiliser les commandes de modération')
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à autoriser').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Retirer l'accès à un rôle")
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à retirer').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les rôles autorisés'))
    .setDefaultMemberPermissions('0') // masquée pour tout le monde sauf admins ; vérifiée aussi dans le code
    .setDMPermission(false),

  // ---------- Rôles protégés (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('roles-proteges')
    .setDescription('👑 Choisir quels rôles ne peuvent être ni mute ni ban par les modérateurs')
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Protéger un rôle')
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à protéger').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription("Retirer la protection d'un rôle")
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle à retirer').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les rôles protégés'))
    .setDefaultMemberPermissions('0')
    .setDMPermission(false),

  // ---------- Annonces ----------
  new SlashCommandBuilder()
    .setName('annonce')
    .setDescription('Envoyer une annonce complète (titre, texte, images, mentions)')
    .addChannelOption((o) =>
      o.setName('salon').setDescription("Salon où envoyer l'annonce")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addMentionableOption((o) => o.setName('mention').setDescription('Rôle ou membre à mentionner'))
    .addStringOption((o) =>
      o.setName('ping').setDescription('Mention globale')
        .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
    .addAttachmentOption((o) => o.setName('image').setDescription('Grande image en bas de l\'annonce'))
    .addAttachmentOption((o) => o.setName('miniature').setDescription('Petite image en haut à droite'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  // ---------- Autorole par réaction ----------
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Un message avec une réaction qui donne un rôle')
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Envoyer un message : réagir avec l\'emoji donne le rôle')
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon où envoyer le message')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle donné par la réaction').setRequired(true))
        .addStringOption((o) =>
          o.setName('emoji').setDescription('Emoji de la réaction (ex : 🎮 ou un emoji du serveur)').setRequired(true))
        .addMentionableOption((o) => o.setName('mention').setDescription('Rôle ou membre à mentionner'))
        .addStringOption((o) =>
          o.setName('ping').setDescription('Mention globale')
            .addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }))
        .addAttachmentOption((o) => o.setName('image').setDescription('Grande image en bas du message'))
        .addAttachmentOption((o) => o.setName('miniature').setDescription('Petite image en haut à droite')))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les autoroles existants'))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Supprimer un autorole (et son message)')
        .addStringOption((o) =>
          o.setName('message').setDescription('Autorole à supprimer').setAutocomplete(true).setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),

  // ---------- Bienvenue ----------
  new SlashCommandBuilder()
    .setName('bienvenue')
    .setDescription("Système d'accueil des nouveaux membres")
    .addSubcommand((s) =>
      s.setName('configurer').setDescription('Choisir le salon et modifier tout le message')
        .addChannelOption((o) =>
          o.setName('salon').setDescription("Salon d'accueil")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('activer').setDescription('Activer le message de bienvenue'))
    .addSubcommand((s) => s.setName('desactiver').setDescription('Désactiver le message de bienvenue'))
    .addSubcommand((s) => s.setName('test').setDescription("Prévisualiser le message avec ton profil"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  // ---------- Tickets ----------
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Gestion du système de tickets')
    .addSubcommand((s) =>
      s.setName('config-creer').setDescription('Créer une configuration de ticket')
        .addStringOption((o) =>
          o.setName('nom').setDescription('Nom (lettres, chiffres, tirets - 30 max)').setRequired(true))
        .addChannelOption((o) =>
          o.setName('categorie').setDescription('Catégorie où les tickets seront créés')
            .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addRoleOption((o) =>
          o.setName('role-staff').setDescription('Premier rôle staff (ajoute-en d\'autres avec /ticket staff-ajouter)').setRequired(true))
        .addChannelOption((o) =>
          o.setName('salon-logs').setDescription('Salon où envoyer les transcripts à la fermeture')
            .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('config-liste').setDescription('Lister les configurations'))
    .addSubcommand((s) =>
      s.setName('config-supprimer').setDescription('Supprimer une configuration')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('staff-ajouter').setDescription('Autoriser un rôle staff à voir et répondre aux tickets')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle staff à ajouter').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('staff-retirer').setDescription("Retirer l'accès d'un rôle staff aux tickets")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle staff à retirer').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('raison-ajouter').setDescription("Ajouter une raison d'ouverture à une configuration")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Nom de la raison').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Description courte'))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (optionnel)'))
        .addRoleOption((o) =>
          o.setName('role-staff').setDescription('Rôle staff propre à cette raison (remplace ceux de la config)')))
    .addSubcommand((s) =>
      s.setName('raison-retirer').setDescription('Retirer une raison')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Raison à retirer').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('panel').setDescription('Envoyer le panel de tickets dans un salon (ensuite mis à jour automatiquement)')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon où poster le panel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName('titre').setDescription('Titre du panel'))
        .addStringOption((o) => o.setName('description').setDescription('Texte du panel'))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex, ex : #5865F2'))
        .addAttachmentOption((o) => o.setName('image').setDescription('Image du panel')))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
function buildWelcome(member) {
  const w = getG(member.guild.id).welcome;
  const embed = new EmbedBuilder()
    .setColor(parseColor(w.color))
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();
  const title = fmt(w.title, member);
  const desc = fmt(w.description, member);
  if (title) embed.setTitle(title.slice(0, 256));
  if (desc) embed.setDescription(desc.slice(0, 4096));
  if (isUrl(w.image)) embed.setImage(w.image.trim());

  const hasEmbed = title || desc || isUrl(w.image);
  let content = fmt(w.content, member);
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
    await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Configuration du rôle Muté' }).catch(() => {});
  }
}

async function ensureMutedRole(guild) {
  const d = getG(guild.id);
  let role = d.muteRoleId ? guild.roles.cache.get(d.muteRoleId) : null;
  if (!role) {
    role = await guild.roles.create({
      name: 'Muté',
      color: 0x808080,
      permissions: [],
      reason: 'Rôle utilisé par le système de mute',
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
      if (rec.until <= Date.now()) await removeMute(guild, userId, 'Mute terminé').catch(console.error);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Tickets                                                            */
/* ------------------------------------------------------------------ */
const panelDesc = (cfg) => cfg.reasons.length
  ? 'Sélectionne la raison de ta demande dans le menu ci-dessous pour ouvrir un ticket.'
  : 'Clique sur le bouton ci-dessous pour ouvrir un ticket.';

// Menu déroulant (s'il y a des raisons) ou simple bouton
function panelRow(cfg) {
  if (cfg.reasons.length) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`tk_open:${cfg.name}`)
        .setPlaceholder('Choisis une raison...')
        .addOptions(cfg.reasons.map((r) => {
          const o = { label: r.label, value: r.id };
          if (r.description) o.description = r.description;
          if (r.emoji) o.emoji = r.emoji;
          return o;
        })));
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tk_open:${cfg.name}`).setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary));
}

// Met à jour tous les panels déjà envoyés (raisons ajoutées / retirées, nouveau code du bot...)
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

      const row = panelRow(cfg);
      const desc = p.customDesc ? null : panelDesc(cfg);
      const s = sig({ row: row.toJSON(), desc });
      if (p.sig === s) continue;

      const payload = { components: [row] };
      if (desc && msg.embeds[0] && msg.embeds[0].description !== desc) {
        payload.embeds = [EmbedBuilder.from(msg.embeds[0]).setDescription(desc)];
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

async function openTicket(i, cfgName, reasonId) {
  const data = getG(i.guildId);
  const cfg = data.tickets[cfgName];
  if (!cfg) return i.reply({ content: "❌ Cette configuration n'existe plus.", flags: EPH });

  await i.deferReply({ flags: EPH });
  // Réinitialise le menu déroulant pour pouvoir rechoisir la même raison
  if (i.isStringSelectMenu()) i.message.edit({ components: i.message.components }).catch(() => {});

  const existing = Object.entries(data.open).find(([, t]) => t.userId === i.user.id && t.config === cfgName);
  if (existing) {
    if (i.guild.channels.cache.has(existing[0])) {
      return i.editReply(`❌ Tu as déjà un ticket ouvert : <#${existing[0]}>`);
    }
    delete data.open[existing[0]];
  }

  const reason = cfg.reasons.find((r) => r.id === reasonId);

  // Rôles staff : ceux de la raison (s'il y en a un) sinon ceux de la configuration
  const staffRoles = (reason?.staffRoleId ? [reason.staffRoleId] : cfg.staffRoles)
    .filter((id) => i.guild.roles.cache.has(id));
  if (!staffRoles.length) {
    return i.editReply("❌ Aucun rôle staff valide n'est configuré pour ce ticket. Préviens un administrateur.");
  }

  cfg.counter = (cfg.counter || 0) + 1;

  const P = PermissionFlagsBits;
  const channel = await i.guild.channels.create({
    name: `${cfg.name}-${String(cfg.counter).padStart(4, '0')}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: cfg.categoryId,
    topic: `Ticket de ${i.user.tag} | ${cfg.name}${reason ? ' | ' + reason.label : ''}`,
    permissionOverwrites: [
      { id: i.guild.id, deny: [P.ViewChannel] },
      { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
      ...staffRoles.map((id) => ({
        id,
        allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageMessages],
      })),
      { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels] },
    ],
  });

  data.open[channel.id] = {
    userId: i.user.id, config: cfgName, reason: reason?.label || null, claimedBy: null, staffRoles,
  };
  save();

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`🎫 Ticket — ${reason ? reason.label : cfg.name}`)
    .setDescription(
      `Bonjour <@${i.user.id}>, un membre du staff va te répondre bientôt.\n` +
      `Explique-nous ta demande avec un maximum de détails.`)
    .addFields(
      { name: 'Configuration', value: cfg.name, inline: true },
      { name: 'Raison', value: reason ? reason.label : 'Non précisée', inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk_claim').setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tk_close').setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${i.user.id}> ${staffRoles.map((r) => `<@&${r}>`).join(' ')}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [i.user.id], roles: staffRoles },
  });
  await i.editReply(`✅ Ton ticket a été créé : <#${channel.id}>`);
}

// Le staff d'un ticket = les rôles enregistrés à son ouverture (ou ceux de la config pour les anciens tickets)
function isStaff(i, t, cfg) {
  const roles = t.staffRoles || cfg?.staffRoles || [];
  return roles.some((id) => i.member.roles.cache.has(id)) ||
    i.member.permissions.has(PermissionFlagsBits.ManageChannels);
}

async function claimTicket(i) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) return i.reply({ content: "❌ Ce salon n'est pas un ticket géré.", flags: EPH });
  if (!isStaff(i, t, data.tickets[t.config])) {
    return i.reply({ content: '❌ Réservé au staff.', flags: EPH });
  }
  if (t.claimedBy) return i.reply({ content: `❌ Déjà pris en charge par <@${t.claimedBy}>.`, flags: EPH });
  t.claimedBy = i.user.id;
  save();
  await i.reply({ content: `🙋 <@${i.user.id}> prend en charge ce ticket.`, allowedMentions: { parse: [] } });
}

async function closeTicket(i) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) return i.reply({ content: "❌ Ce salon n'est pas un ticket géré.", flags: EPH });
  const cfg = data.tickets[t.config];
  if (!isStaff(i, t, cfg) && i.user.id !== t.userId) {
    return i.reply({ content: "❌ Tu ne peux pas fermer ce ticket.", flags: EPH });
  }
  await i.reply('🔒 Fermeture du ticket dans quelques secondes...');

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
  const mkFile = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `transcript-${i.channel.name}.txt` });

  const logEmbed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('🔒 Ticket fermé')
    .addFields(
      { name: 'Ticket', value: i.channel.name, inline: true },
      { name: 'Configuration', value: t.config, inline: true },
      { name: 'Raison', value: t.reason || 'Non précisée', inline: true },
      { name: 'Ouvert par', value: `<@${t.userId}>`, inline: true },
      { name: 'Fermé par', value: `<@${i.user.id}>`, inline: true },
      { name: 'Pris en charge par', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Personne', inline: true },
    )
    .setTimestamp();

  const logCh = cfg?.logChannelId ? await i.guild.channels.fetch(cfg.logChannelId).catch(() => null) : null;
  if (logCh) await logCh.send({ embeds: [logEmbed], files: [mkFile()], allowedMentions: { parse: [] } }).catch(console.error);

  const opener = await client.users.fetch(t.userId).catch(() => null);
  if (opener) {
    opener.send({ content: `Ton ticket **${i.channel.name}** sur **${i.guild.name}** a été fermé. Voici le transcript :`, files: [mkFile()] }).catch(() => {});
  }

  delete data.open[i.channelId];
  save();
  setTimeout(() => i.channel.delete().catch(console.error), 5000);
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
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Autorole (réaction)');
    } else if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Autorole (réaction retirée)');
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
      .setLabel(`${gw.ended ? 'Terminé' : 'Participer'} (${gw.entrants.length})`)
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
    `👤 **Organisé par :** <@${gw.hostId}>`);
  if (gw.requiredRole) lines.push(`🔒 **Rôle requis :** <@&${gw.requiredRole}>`);
  if (gw.minInvites) lines.push(`📨 **Invitations minimum :** ${gw.minInvites}`);
  lines.push('', 'Clique sur le bouton ci-dessous pour participer !');
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
    : 'Aucun participant valide';
  const desc =
    `${gw.description ? gw.description + '\n\n' : ''}` +
    `🏆 **Gagnant${gw.winnerIds.length > 1 ? 's' : ''} :** ${winnersTxt}\n` +
    `👤 **Organisé par :** <@${gw.hostId}>\n` +
    `👥 **Participants valides :** ${gw.validCount ?? gw.entrants.length}`;
  const make = (withImage) => {
    const e = msg.embeds[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
    e.setTitle(`🎉 ${gw.prize} — Terminé`.slice(0, 256))
      .setColor('#95A5A6')
      .setDescription(desc.slice(0, 4096))
      .setFooter({ text: 'Giveaway terminé' })
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
      ? `❌ Aucun autre participant valide pour **${gw.prize}**.`
      : `😕 Le giveaway **${gw.prize}** est terminé : aucun participant valide, pas de gagnant.`;
  } else {
    const list = winners.map((w) => `<@${w}>`).join(', ');
    text = `${isReroll ? '🔄 Nouveau tirage' : '🎉 Félicitations'} ${list} ! ` +
      `${winners.length > 1 ? 'Vous avez gagné' : 'Tu as gagné'} **${gw.prize}** !`;
  }
  const payload = { content: text, allowedMentions: { users: winners, repliedUser: false } };
  await msg.reply(payload).catch(() => msg.channel.send(payload).catch(console.error));

  for (const w of winners) {
    client.users.fetch(w)
      .then((u) => u.send(`🎉 Tu as gagné **${gw.prize}** sur **${msg.guild.name}** !\n${msg.url}`))
      .catch(() => {});
  }
}

// Termine un giveaway : tirage au sort, message mis à jour, annonce des gagnants
async function endGiveaway(guild, id) {
  const d = getG(guild.id);
  const gw = d.giveaways[id];
  if (!gw || gw.ended) return { ok: false, reason: 'introuvable ou déjà terminé' };
  if (endingNow.has(id)) return { ok: false, reason: 'tirage déjà en cours' };
  endingNow.add(id);
  try {
    const { msg, gone } = await fetchMsg(guild, gw.channelId, id);
    if (gone) { delete d.giveaways[id]; save(); return { ok: false, reason: 'le message a été supprimé' }; }
    if (!msg) return { ok: false, reason: 'message inaccessible (nouvel essai automatique)' };

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
  if (!gw) return i.reply({ content: "❌ Ce giveaway n'existe plus.", flags: EPH });
  if (gw.ended || Date.now() >= gw.endAt) return i.reply({ content: '⏰ Ce giveaway est terminé.', flags: EPH });
  if (gw.requiredRole && !i.member.roles.cache.has(gw.requiredRole)) {
    return i.reply({
      content: `❌ Il te faut le rôle <@&${gw.requiredRole}> pour participer.`,
      flags: EPH, allowedMentions: { parse: [] },
    });
  }
  if (gw.minInvites) {
    const have = invNet(getG(i.guildId).invites.stats[i.user.id]);
    if (have < gw.minInvites) {
      return i.reply({
        content: `❌ Il te faut au moins **${gw.minInvites}** invitation(s) pour participer (tu en as **${have}**). ` +
          'Vérifie avec `/invites`.',
        flags: EPH,
      });
    }
  }
  if (gw.entrants.includes(i.user.id)) {
    return i.reply({
      content: '✅ Tu participes déjà à ce giveaway.',
      flags: EPH,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw_leave:${i.message.id}`).setLabel('Quitter le giveaway').setStyle(ButtonStyle.Danger))],
    });
  }
  gw.entrants.push(i.user.id);
  save();
  await i.reply({ content: '🎉 Participation enregistrée, bonne chance !', flags: EPH });
  scheduleGwUpdate(i.guild, i.message.id);
}

async function gwLeave(i) {
  const id = i.customId.split(':')[1];
  const gw = getG(i.guildId).giveaways[id];
  if (!gw || gw.ended) return i.update({ content: '⏰ Ce giveaway est terminé.', components: [] });
  gw.entrants = gw.entrants.filter((u) => u !== i.user.id);
  save();
  await i.update({ content: '👋 Tu ne participes plus à ce giveaway.', components: [] });
  scheduleGwUpdate(i.guild, id);
}

/* ------------------------------------------------------------------ */
/*  Mise à jour automatique de TOUS les systèmes                       */
/* ------------------------------------------------------------------ */
// Lancée à chaque démarrage du bot : plus rien à renvoyer à la main après une mise à jour du code
async function refreshGuild(guild) {
  const steps = [
    ['salon commandes', () => syncCommandChannel(guild)],
    ['panels tickets', () => refreshPanels(guild)],
    ['autoroles', () => syncAutoroles(guild)],
    ['giveaways', () => refreshGiveaways(guild)],
    ['classement invitations', () => refreshBoard(guild)],
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
          ? '❌ Seul le propriétaire du serveur (👑) peut utiliser cette commande.'
          : '❌ Réservé au propriétaire (👑) et aux rôles avec accès total.',
        flags: EPH,
      });
    }
    const d = getG(i.guildId);
    const sub = i.options.getSubcommand();

    if (sub === 'liste') {
      const txt = d[key].length
        ? d[key].map((id) => `• <@&${id}>`).join('\n')
        : 'Aucun rôle pour le moment.';
      return i.reply({ content: `**${title}**\n${txt}`, flags: EPH, allowedMentions: { parse: [] } });
    }

    const role = i.options.getRole('role', true);
    if (role.id === i.guild.id) {
      return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
    }

    if (sub === 'ajouter') {
      if (!d[key].includes(role.id)) d[key].push(role.id);
      save();
      if (key !== 'protectedRoles') syncCommandChannel(i.guild).catch(console.error);
      return i.reply({ content: `✅ <@&${role.id}> ajouté à : **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
    }

    d[key] = d[key].filter((id) => id !== role.id);
    save();
    if (key !== 'protectedRoles') syncCommandChannel(i.guild).catch(console.error);
    return i.reply({ content: `🗑️ <@&${role.id}> retiré de : **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
  };
}

/* ------------------------------------------------------------------ */
/*  Aide (/help) : chaque section n'est visible que par ceux qui y ont droit */
/* ------------------------------------------------------------------ */
// level : public = tout le monde · mod = modérateurs · full = accès total · owner = propriétaire (👑)
const HELP = [
  { title: '📨 Invitations', level: 'public', lines: [
    "`/invites` — voir ton nombre d'invitations",
    '`/help` — voir les commandes auxquelles tu as accès',
  ] },
  { title: '🛡️ Modération', level: 'mod', lines: [
    '`/ban` — bannir un membre',
    '`/unban` — débannir un utilisateur',
    '`/mute` — rendre un membre muet pour une durée',
    '`/unmute` — enlever le mute',
    '`/sanctions-actives` — bannis et mutés actuels',
    "`/historique-sanctions` — historique d'un membre",
  ] },
  { title: '🎉 Giveaways', level: 'full', lines: [
    '`/giveaway creer` — lancer un giveaway (rôle requis, invitations minimum…)',
    '`/giveaway terminer` — terminer maintenant et tirer',
    '`/giveaway reroll` — nouveau tirage',
    '`/giveaway annuler` — annuler et supprimer le message',
    '`/giveaway liste` — giveaways en cours',
  ] },
  { title: '📢 Annonces & rôles', level: 'full', lines: [
    '`/annonce` — envoyer une annonce (titre, texte, images, mentions)',
    '`/autorole creer` · `liste` · `supprimer` — réaction qui donne un rôle',
    '`/bienvenue configurer` · `activer` · `desactiver` · `test`',
  ] },
  { title: '📈 Invitations (admin)', level: 'full', lines: [
    '`/invites-config recompense-ajouter` · `recompense-retirer` · `liste` · `reset`',
    '`/classement-invites` — envoyer le classement',
    '`/classement-invites-maj` — forcer sa mise à jour',
  ] },
  { title: '🎫 Tickets', level: 'full', lines: [
    '`/ticket config-creer` · `config-liste` · `config-supprimer`',
    '`/ticket staff-ajouter` · `staff-retirer`',
    '`/ticket raison-ajouter` · `raison-retirer`',
    '`/ticket panel` — envoyer le panel dans un salon',
  ] },
  { title: '⚙️ Serveur & accès', level: 'full', lines: [
    '`/salon-commandes` — salon privé des commandes (et ses rôles)',
    '`/salon-sanctions` — salon par défaut des annonces ban / mute',
    '`/membercount` — salon vocal avec le nombre de membres',
    '`/roles-mod` — rôles autorisés à modérer',
    '`/roles-proteges` — rôles que les modérateurs ne peuvent pas sanctionner',
  ] },
  { title: '👑 Propriétaire', level: 'owner', lines: [
    '`/role-total` — rôles avec accès à TOUTES les commandes',
  ] },
];
const HELP_LEVEL = { public: () => true, mod: canModerate, full: hasFullAccess, owner: isOwner };

/* ------------------------------------------------------------------ */
/*  Gestionnaires de commandes                                         */
/* ------------------------------------------------------------------ */
const handlers = {
  /* ---------- /help ---------- */
  async help(i) {
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('📖 Tes commandes').setTimestamp();
    for (const s of HELP) {
      if (HELP_LEVEL[s.level](i)) embed.addFields({ name: s.title, value: s.lines.join('\n').slice(0, 1024) });
    }
    // Le salon des commandes n'est indiqué qu'à ceux qui peuvent le voir
    const cc = getG(i.guildId).commandChannelId;
    const ccCh = cc && i.guild.channels.cache.get(cc);
    if (ccCh && ccCh.permissionsFor(i.member)?.has(PermissionFlagsBits.ViewChannel)) {
      embed.setDescription(`Les commandes s'utilisent dans <#${cc}>.`);
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
      return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    const d = getG(i.guildId);

    try {
      let ch = d.commandChannelId ? await i.guild.channels.fetch(d.commandChannelId).catch(() => null) : null;
      if (!ch && !cat) return i.editReply('❌ Indique une **catégorie** pour créer le salon.');

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
          topic: 'Salon privé : toutes les commandes du bot se font ici.',
          permissionOverwrites: commandChannelOverwrites(i.guild),
        });
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('⌨️ Salon des commandes')
            .setDescription(
              "Toutes les commandes du bot s'utilisent **ici**.\n" +
              "Si une commande est tapée dans un autre salon, le bot ne l'exécute pas.\n" +
              'Les réponses sont **privées** : tu ne vois que les tiennes. Les messages écrits à la main ici sont supprimés.\n\n' +
              'Ce salon est invisible pour les membres. Chacun ne peut utiliser que les commandes auxquelles il a droit (`/help`).')],
        }).catch(console.error);
      }
      d.commandChannelId = ch.id;
      save();

      const extra = d.commandChannelRoles.length
        ? d.commandChannelRoles.map((id) => `<@&${id}>`).join(' ')
        : 'aucun';
      await i.editReply({
        content:
          `✅ Salon des commandes prêt : <#${ch.id}>\n` +
          `• Rôles ajoutés à la main : ${extra}\n` +
          '• Les rôles `/role-total` et `/roles-mod` y ont toujours accès.\n' +
          "• Un rôle ajouté ici voit le salon mais n'a **pas** plus de commandes : il garde seulement `/help` et `/invites`.\n" +
          '• `/help` et `/invites` restent utilisables partout.\n' +
          '• Les commandes tapées ailleurs sont refusées (message visible uniquement par celui qui a tapé la commande).',
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(e);
      await i.editReply('❌ Impossible de créer le salon. Il me faut les permissions **Gérer les salons** et **Gérer les rôles** (et d\'avoir accès à cette catégorie).');
    }
  },

  /* ---------- /giveaway ---------- */
  async giveaway(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'liste') {
      const active = Object.entries(d.giveaways).filter(([, g]) => !g.ended).sort((a, b) => a[1].endAt - b[1].endAt);
      if (!active.length) return i.reply({ content: 'Aucun giveaway en cours. Lance-en un avec `/giveaway creer`.', flags: EPH });
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
      if (duration > MAX_GW) return i.reply({ content: '❌ Durée maximale : 365 jours.', flags: EPH });
      if (role && role.id === i.guild.id) return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
      if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
        return i.reply({ content: '❌ Il te faut la permission de mentionner @everyone.', flags: EPH });
      }

      await i.deferReply({ flags: EPH });
      const gw = {
        channelId: salon.id, prize, description, winners,
        endAt: Date.now() + duration, hostId: i.user.id,
        requiredRole: role?.id || null,
        minInvites,
        entrants: [], ended: false, winnerIds: [],
      };
      try {
        const embed = new EmbedBuilder()
          .setColor('#F1C40F')
          .setTitle(`🎉 ${prize}`.slice(0, 256))
          .setDescription(gwDescription(gw))
          .setFooter({ text: 'Se termine' })
          .setTimestamp(new Date(gw.endAt));
        const files = [];
        if (img) {
          const f = await toFile(img, 'giveaway');
          files.push(f);
          embed.setImage(`attachment://${f.name}`);
        }
        const row = gwRow(gw);
        const { content, allowed } = buildMentions(ping, mentionOpt);
        const msg = await salon.send({ content, embeds: [embed], files, components: [row], allowedMentions: allowed });
        gw.sig = sig(row.toJSON());
        d.giveaways[msg.id] = gw;
        save();
        await i.editReply(
          `✅ Giveaway lancé dans <#${salon.id}> (fin <t:${Math.floor(gw.endAt / 1000)}:R>). ` +
          'Le tirage se fait tout seul à la fin.');
      } catch (e) {
        console.error('[giveaway]', e);
        await i.editReply("❌ Impossible de lancer le giveaway (vérifie mes permissions dans ce salon et l'image).");
      }
      return;
    }

    const id = i.options.getString('giveaway', true);
    const gw = d.giveaways[id];
    if (!gw) return i.reply({ content: '❌ Giveaway introuvable.', flags: EPH });

    if (sub === 'terminer') {
      if (gw.ended) return i.reply({ content: '❌ Ce giveaway est déjà terminé.', flags: EPH });
      await i.deferReply({ flags: EPH });
      const r = await endGiveaway(i.guild, id);
      if (!r.ok) return i.editReply(`❌ Impossible de terminer ce giveaway : ${r.reason}.`);
      return i.editReply(r.winners.length
        ? `✅ Giveaway terminé. Gagnant${r.winners.length > 1 ? 's' : ''} : ${r.winners.map((w) => `<@${w}>`).join(', ')}`
        : '✅ Giveaway terminé : aucun participant valide.');
    }

    if (sub === 'annuler') {
      await i.deferReply({ flags: EPH });
      const { msg } = await fetchMsg(i.guild, gw.channelId, id);
      delete d.giveaways[id];
      save();
      if (msg) await msg.delete().catch(() => {});
      return i.editReply('🗑️ Giveaway annulé et message supprimé.');
    }

    // reroll
    if (!gw.ended) return i.reply({ content: "❌ Ce giveaway n'est pas encore terminé. Utilise `/giveaway terminer`.", flags: EPH });
    await i.deferReply({ flags: EPH });
    const { msg } = await fetchMsg(i.guild, gw.channelId, id);
    if (!msg) return i.editReply('❌ Le message du giveaway est introuvable.');
    const n = i.options.getInteger('nombre') ?? 1;
    const valid = await validEntrants(i.guild, gw);
    const winners = pickWinners(valid, n, gw.winnerIds);
    gw.winnerIds.push(...winners);
    save();
    await announceWinners(msg, gw, winners, true);
    return i.editReply(winners.length
      ? `✅ Nouveau tirage : ${winners.map((w) => `<@${w}>`).join(', ')}`
      : '❌ Aucun autre participant valide.');
  },

  /* ---------- /invites (tout le monde) ---------- */
  async invites(i) {
    const asked = i.options.getUser('membre');
    if (asked && asked.id !== i.user.id && !hasFullAccess(i)) {
      return i.reply({ content: '❌ Tu peux seulement voir tes propres invitations.', flags: EPH });
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
        { name: 'Arrivées', value: String(s.joins), inline: true },
        { name: 'Départs', value: String(s.left || 0), inline: true },
      );
    if (next) {
      embed.addFields({
        name: 'Prochaine récompense',
        value: `<@&${next.roleId}> à **${next.count}** invitations (encore ${next.count - n})`,
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
        .map((r) => `• **${r.count}** invitations → <@&${r.roleId}>`).join('\n') || 'Aucune récompense.';
      return i.reply({ content: `**Récompenses d'invitations**\n${txt}`, flags: EPH, allowedMentions: { parse: [] } });
    }

    if (sub === 'recompense-retirer') {
      const nb = i.options.getInteger('nombre', true);
      const before = d.rewards.length;
      d.rewards = d.rewards.filter((r) => r.count !== nb);
      save();
      return i.reply({
        content: d.rewards.length < before
          ? '🗑️ Récompense supprimée (les rôles déjà donnés sont conservés).'
          : '❌ Aucune récompense pour ce nombre.',
        flags: EPH,
      });
    }

    if (sub === 'reset') {
      const user = i.options.getUser('membre', true);
      delete d.stats[user.id];
      for (const [uid, inviter] of Object.entries(d.joinedBy)) if (inviter === user.id) delete d.joinedBy[uid];
      save();
      return i.reply({ content: `✅ Invitations de <@${user.id}> remises à zéro.`, flags: EPH, allowedMentions: { parse: [] } });
    }

    // recompense-ajouter
    const nb = i.options.getInteger('nombre', true);
    const roleOpt = i.options.getRole('role', true);
    const role = i.guild.roles.cache.get(roleOpt.id);
    if (!role || role.id === i.guild.id || role.managed) {
      return i.reply({ content: '❌ Choisis un rôle normal (pas @everyone ni un rôle de bot).', flags: EPH });
    }
    if (!role.editable) {
      return i.reply({ content: '❌ Mon rôle doit être **au-dessus** de ce rôle dans la liste des rôles.', flags: EPH });
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
      content: `✅ À partir de **${nb}** invitations, le rôle <@&${role.id}> sera donné automatiquement.`,
      allowedMentions: { parse: [] },
    });
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
      await i.editReply(`✅ Classement envoyé dans <#${salon.id}>. Il se met à jour automatiquement (toutes les 5 minutes).`);
    } catch (e) {
      console.error(e);
      await i.editReply('❌ Envoi impossible : vérifie mes permissions dans ce salon.');
    }
  },

  /* ---------- /classement-invites-maj ---------- */
  async 'classement-invites-maj'(i) {
    const b = getG(i.guildId).invites.board;
    if (!b) return i.reply({ content: "❌ Aucun classement envoyé. Utilise d'abord `/classement-invites`.", flags: EPH });
    await i.deferReply({ flags: EPH });
    const r = await refreshBoard(i.guild, true);
    if (r === 'missing') return i.editReply('❌ Le message du classement a été supprimé. Renvoie-le avec `/classement-invites`.');
    if (r !== 'ok') return i.editReply('❌ Impossible de modifier le message du classement.');
    return i.editReply(`✅ Classement mis à jour : https://discord.com/channels/${i.guildId}/${b.channelId}/${b.messageId}`);
  },

  /* ---------- /roles-mod & /roles-proteges (👑) ---------- */
  'role-total': roleListHandler('fullRoles', 'Rôles avec accès à toutes les commandes', true),
  'roles-mod': roleListHandler('modRoles', 'Rôles autorisés à modérer (ban - unban - mute - unmute)'),
  'roles-proteges': roleListHandler('protectedRoles', 'Rôles protégés (ni mute ni ban par les modérateurs)'),

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
    await i.editReply(`✅ Salon créé : <#${ch.id}>. Il se met à jour automatiquement.`);
  },

  /* ---------- /ban ---------- */
  async ban(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const user = i.options.getUser('membre', true);
    const reason = i.options.getString('raison') || 'Aucune raison fournie';
    const days = i.options.getInteger('supprimer_messages') ?? 0;

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const err = targetError(i, user, member);
    if (err) return i.reply({ content: err, flags: EPH });
    if (member && !member.bannable) {
      return i.reply({ content: '❌ Je ne peux pas bannir ce membre (son rôle est au-dessus du mien).', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    await user.send(`🔨 Tu as été banni de **${i.guild.name}**.\nRaison : ${reason}`).catch(() => {});
    await i.guild.members.ban(user.id, { reason: `${i.user.tag} : ${reason}`, deleteMessageSeconds: days * 86400 });
    banCache.delete(i.guildId);

    // Si le membre était muté, on nettoie son enregistrement
    const d = getG(i.guildId);
    delete d.muted[user.id];
    save();

    // Historique + annonce dans le salon choisi (option "salon") ou le salon par défaut (/salon-sanctions)
    logSanction(d, user.id, { type: 'ban', by: i.user.id, reason, duration: 'définitif' });
    await announceSanction(i, i.options.getChannel('salon'),
      `<@${user.id}> a été banni (définitif) par <@${i.user.id}>`);

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🔨 Membre banni')
      .addFields(
        { name: 'Membre', value: `${user.tag} (${user.id})` },
        { name: 'Modérateur', value: `<@${i.user.id}>` },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed] });
  },

  /* ---------- /unban ---------- */
  async unban(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const input = i.options.getString('utilisateur', true).trim();
    const reason = i.options.getString('raison') || 'Aucune raison fournie';

    await i.deferReply({ flags: EPH });

    // 1) On retrouve l'ID : soit collé / choisi dans la liste, soit un pseudo tapé à la main
    let id = input.replace(/[<@!>]/g, '');
    if (!/^\d{15,25}$/.test(id)) {
      banCache.delete(i.guildId); // liste fraîche
      const list = await getBans(i.guild).catch((e) => { console.error('[unban] lecture des bans :', e); return null; });
      if (!list) {
        return i.editReply('❌ Impossible de lire la liste des bannis. Vérifie que j\'ai la permission **Bannir des membres**.');
      }
      const q = input.toLowerCase().replace(/^@/, '');
      const found = list.filter((b) => b.username.toLowerCase() === q || b.tag.toLowerCase() === q);
      if (found.length > 1) return i.editReply('❌ Plusieurs bannis correspondent : utilise l\'ID exact.');
      if (!found.length) {
        return i.editReply("❌ Aucun banni ne correspond. Choisis-le dans la liste ou colle son ID.");
      }
      id = found[0].id;
    }

    // 2) On débannit directement (pas de pré-vérification fragile) et on interprète l'erreur éventuelle
    try {
      await i.guild.bans.remove(id, `${i.user.tag} : ${reason}`);
    } catch (e) {
      console.error('[unban]', e);
      if (e.code === 10026) return i.editReply("❌ Cet utilisateur n'est pas banni.");
      if (e.code === 50013 || e.code === 50001) {
        return i.editReply('❌ Il me manque la permission **Bannir des membres** (ou l\'accès à ce serveur).');
      }
      return i.editReply(`❌ Impossible de débannir : ${e.message}`);
    }
    banCache.delete(i.guildId);

    const user = await client.users.fetch(id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Membre débanni')
      .addFields(
        { name: 'Utilisateur', value: user ? `${user.tag} (${id})` : id },
        { name: 'Modérateur', value: `<@${i.user.id}>` },
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
    const reason = i.options.getString('raison') || 'Aucune raison fournie';
    const duration = amount * UNITS[unit];
    if (duration > MAX_MUTE) return i.reply({ content: '❌ Durée maximale : 365 jours.', flags: EPH });

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.reply({ content: "❌ Ce membre n'est pas sur le serveur.", flags: EPH });
    const err = targetError(i, user, member);
    if (err) return i.reply({ content: err, flags: EPH });

    await i.deferReply({ flags: EPH });
    const until = Date.now() + duration;
    try {
      await applyMute(i.guild, member, until, reason, i.user.id);
    } catch (e) {
      console.error(e);
      return i.editReply(
        "❌ Impossible de mute ce membre. Mon rôle doit être **au-dessus** du sien (idéalement tout en haut de la liste) " +
        "et j'ai besoin des permissions **Gérer les rôles** et **Gérer les salons**.");
    }

    // Historique + annonce dans le salon choisi (option "salon") ou le salon par défaut (/salon-sanctions)
    logSanction(getG(i.guildId), user.id, { type: 'mute', by: i.user.id, reason, duration: `${amount} ${unit}` });
    await announceSanction(i, i.options.getChannel('salon'),
      `<@${user.id}> a été mute pendant ${amount} ${unit} par <@${i.user.id}>`);

    const ts = Math.floor(until / 1000);
    await user.send(
      `🔇 Tu as été mute sur **${i.guild.name}** jusqu'à <t:${ts}:F> (<t:${ts}:R>).\nRaison : ${reason}`).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🔇 Membre mute')
      .addFields(
        { name: 'Membre', value: `<@${user.id}> (${user.id})` },
        { name: 'Modérateur', value: `<@${i.user.id}>`, inline: true },
        { name: 'Durée', value: `${amount} ${unit}`, inline: true },
        { name: 'Fin du mute', value: `<t:${ts}:F> (<t:${ts}:R>)` },
        { name: 'Raison', value: reason },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  /* ---------- /unmute ---------- */
  async unmute(i) {
    if (!canModerate(i)) return i.reply(NO_ACCESS);

    const user = i.options.getUser('membre', true);
    const reason = i.options.getString('raison') || 'Aucune raison fournie';
    const rec = getG(i.guildId).muted[user.id];

    if (!rec) return i.reply({ content: "❌ Ce membre n'est pas mute.", flags: EPH });
    if (rec.by === i.guild.ownerId && !isOwner(i)) {
      return i.reply({ content: '❌ Ce mute a été posé par le propriétaire : lui seul peut le lever.', flags: EPH });
    }

    await i.deferReply({ flags: EPH });
    await removeMute(i.guild, user.id, `Unmute par ${i.user.tag} : ${reason}`);
    await user.send(`🔊 Tu as été unmute sur **${i.guild.name}**.`).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🔊 Membre unmute')
      .addFields(
        { name: 'Membre', value: `<@${user.id}> (${user.id})` },
        { name: 'Modérateur', value: `<@${i.user.id}>` },
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
      content: `✅ Les ban et mute seront annoncés dans <#${salon.id}> (sauf si un autre salon est choisi dans la commande).`,
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
      : ['Impossible de lire la liste des bannis (permission **Bannir des membres** ?).'];
    const muteLines = Object.entries(d.muted).map(([id, r]) =>
      `• <@${id}> — fin <t:${Math.floor(r.until / 1000)}:R> — par <@${r.by}> — ${r.reason}`);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📋 Sanctions en cours')
      .addFields(
        { name: `🔨 Bannis (${bans ? bans.size : '?'})`, value: fitLines(banLines) },
        { name: `🔇 Mutés (${muteLines.length})`, value: fitLines(muteLines) },
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
      muteNow ? `🔇 **Actuellement mute** jusqu'à <t:${Math.floor(muteNow.until / 1000)}:F>` : null,
    ].filter(Boolean).join('\n') || '✅ Aucune sanction en cours.';

    const lines = hist.slice().reverse().slice(0, 15).map((h) =>
      `${h.type === 'ban' ? '🔨 Ban' : '🔇 Mute'} — <t:${Math.floor(h.at / 1000)}:d> — ${h.duration} — par <@${h.by}> — ${h.reason}`);

    const embed = new EmbedBuilder()
      .setColor(hist.length || banNow || muteNow ? '#ED4245' : '#57F287')
      .setTitle(`📜 Historique de ${user.username}`)
      .setDescription((
        `${status}\n\n**Total :** ${nbBan} ban(s) - ${nbMute} mute(s)\n\n` +
        (lines.length
          ? lines.join('\n')
          : "Aucune sanction enregistrée.\n*(L'historique commence à partir de cette mise à jour du bot.)*")
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
      return i.reply({ content: "❌ Il te faut la permission de mentionner @everyone.", flags: EPH });
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
      const { embed, files } = await buildAnnounce(m, img, thumb);
      const { content, allowed } = buildMentions(ping, mentionOpt);
      await salon.send({ content, embeds: [embed], files, allowedMentions: allowed });
      await m.editReply(`✅ Annonce envoyée dans <#${salon.id}>.`);
    } catch (e) {
      console.error(e);
      await m.editReply("❌ Impossible d'envoyer l'annonce (vérifie mes permissions dans ce salon et les liens d'images).");
    }
  },

  /* ---------- /autorole ---------- */
  async autorole(i) {
    if (!hasFullAccess(i) && !i.member.permissions.has(PermissionFlagsBits.ManageRoles)) return i.reply(NO_ACCESS);
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'liste') {
      const entries = Object.entries(d.reactionRoles);
      if (!entries.length) {
        return i.reply({ content: 'Aucun autorole. Crée-en un avec `/autorole creer`.', flags: EPH });
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
      if (!rr) return i.reply({ content: '❌ Autorole introuvable.', flags: EPH });
      delete d.reactionRoles[id];
      save();
      await i.deferReply({ flags: EPH });
      const ch = await i.guild.channels.fetch(rr.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(id).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
      return i.editReply('🗑️ Autorole supprimé (le message a aussi été effacé).');
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
      return i.reply({ content: '❌ Choisis un rôle normal (pas @everyone ni un rôle de bot).', flags: EPH });
    }
    if (!role.editable) {
      return i.reply({ content: '❌ Mon rôle doit être **au-dessus** de ce rôle dans la liste des rôles du serveur.', flags: EPH });
    }
    if (!isOwner(i) && i.member.roles.highest.position <= role.position) {
      return i.reply({ content: '❌ Tu ne peux pas distribuer un rôle supérieur ou égal au tien.', flags: EPH });
    }
    if (!emojiInput || emojiInput.length > 64) {
      return i.reply({ content: '❌ Emoji invalide.', flags: EPH });
    }
    if (ping && !i.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return i.reply({ content: "❌ Il te faut la permission de mentionner @everyone.", flags: EPH });
    }

    const modalId = `autorole_${i.id}`;
    await i.showModal(announceModal(modalId, 'Message autorole', 'Texte du message (Markdown accepté)'));

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    await m.deferReply({ flags: EPH });
    let msg;
    try {
      const { embed, files } = await buildAnnounce(m, img, thumb);
      const { content, allowed } = buildMentions(ping, mentionOpt);
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
        content: `✅ Message envoyé dans <#${salon.id}>. Réagir avec ${emojiInput} donne le rôle <@&${role.id}>.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error('[autorole]', e);
      if (msg) msg.delete().catch(() => {});
      await m.editReply(
        "❌ Impossible de créer l'autorole. Vérifie l'emoji (un emoji d'un serveur où je ne suis pas ne fonctionne pas) " +
        "et mes permissions dans ce salon : **Voir le salon, Envoyer des messages, Intégrer des liens, Ajouter des réactions**.");
    }
  },

  /* ---------- /bienvenue ---------- */
  async bienvenue(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'activer' || sub === 'desactiver') {
      if (sub === 'activer' && !d.welcome.channelId) {
        return i.reply({ content: "❌ Configure d'abord le salon avec `/bienvenue configurer`.", flags: EPH });
      }
      d.welcome.enabled = sub === 'activer';
      save();
      return i.reply({ content: d.welcome.enabled ? '✅ Message de bienvenue activé.' : '⏸️ Message de bienvenue désactivé.', flags: EPH });
    }

    if (sub === 'test') {
      return i.reply({ ...buildWelcome(i.member), flags: EPH });
    }

    // configurer
    const salon = i.options.getChannel('salon');
    const w = d.welcome;
    if (!salon && !w.channelId) {
      return i.reply({ content: '❌ Indique un salon pour la première configuration.', flags: EPH });
    }

    const modalId = `welcome_${i.id}`;
    await i.showModal(
      new ModalBuilder().setCustomId(modalId).setTitle("Message de bienvenue").addComponents(
        field('content', 'Texte au-dessus ({user}, <@&IDrole>)', TextInputStyle.Short, { value: w.content, max: 500 }),
        field('title', "Titre de l'embed", TextInputStyle.Short, { value: w.title, max: 256 }),
        field('description', 'Description (voir variables ci-dessous)', TextInputStyle.Paragraph, { value: w.description, max: 4000, placeholder: '{user} {username} {server} {count}' }),
        field('image', "URL de l'image (optionnel)", TextInputStyle.Short, { value: w.image, max: 500 }),
        field('color', 'Couleur hex (ex : #5865F2)', TextInputStyle.Short, { value: w.color, max: 7 }),
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

    await m.reply({ content: `✅ Bienvenue configuré dans <#${w.channelId}> et activé. Aperçu :`, flags: EPH });
    await m.followUp({ ...buildWelcome(i.member), flags: EPH });
  },

  /* ---------- /ticket ---------- */
  async ticket(i) {
    const sub = i.options.getSubcommand();
    const d = getG(i.guildId);

    if (sub === 'config-creer') {
      const nom = i.options.getString('nom', true).toLowerCase();
      if (!/^[a-z0-9-]{1,30}$/.test(nom)) {
        return i.reply({ content: '❌ Nom invalide : lettres minuscules, chiffres et tirets uniquement (30 max).', flags: EPH });
      }
      if (d.tickets[nom]) return i.reply({ content: '❌ Une configuration porte déjà ce nom.', flags: EPH });
      const staff = i.options.getRole('role-staff', true);
      if (staff.id === i.guild.id) return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
      d.tickets[nom] = {
        name: nom,
        categoryId: i.options.getChannel('categorie', true).id,
        staffRoles: [staff.id],
        logChannelId: i.options.getChannel('salon-logs')?.id || null,
        reasons: [],
        counter: 0,
        panels: [],
      };
      save();
      return i.reply({
        content:
          `✅ Configuration **${nom}** créée.\n` +
          `• Autre rôle staff : \`/ticket staff-ajouter\`\n` +
          `• Raisons d'ouverture : \`/ticket raison-ajouter\`\n` +
          `• Envoi du panel : \`/ticket panel\``,
        flags: EPH,
      });
    }

    if (sub === 'config-liste') {
      const list = Object.values(d.tickets);
      if (!list.length) return i.reply({ content: "Aucune configuration. Crée-en une avec `/ticket config-creer`.", flags: EPH });
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎫 Configurations de tickets').setDescription(
        list.map((c) =>
          `**${c.name}**\n• Catégorie : <#${c.categoryId}>\n• Staff : ${c.staffRoles.length ? c.staffRoles.map((r) => `<@&${r}>`).join(' ') : 'aucun'}\n• Logs : ${c.logChannelId ? `<#${c.logChannelId}>` : 'aucun'}\n• Raisons : ${c.reasons.length ? c.reasons.map((r) => r.label + (r.staffRoleId ? ` (staff : <@&${r.staffRoleId}>)` : '')).join(', ') : 'aucune'}`
        ).join('\n\n').slice(0, 4096));
      return i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });
    }

    const cfgName = i.options.getString('config', true);
    const cfg = d.tickets[cfgName];
    if (!cfg) return i.reply({ content: '❌ Configuration introuvable.', flags: EPH });

    if (sub === 'config-supprimer') {
      delete d.tickets[cfgName];
      save();
      return i.reply({ content: `🗑️ Configuration **${cfgName}** supprimée. Les anciens panels ne fonctionneront plus.`, flags: EPH });
    }

    if (sub === 'staff-ajouter') {
      const role = i.options.getRole('role', true);
      if (role.id === i.guild.id) return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
      if (cfg.staffRoles.includes(role.id)) {
        return i.reply({ content: '❌ Ce rôle a déjà accès aux tickets de cette configuration.', flags: EPH });
      }
      cfg.staffRoles.push(role.id);
      save();
      return i.reply({
        content: `✅ <@&${role.id}> peut maintenant voir et répondre aux **nouveaux** tickets de **${cfgName}** (sauf ceux dont la raison a son propre rôle staff).`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    if (sub === 'staff-retirer') {
      const role = i.options.getRole('role', true);
      if (!cfg.staffRoles.includes(role.id)) {
        return i.reply({ content: "❌ Ce rôle n'est pas dans le staff de cette configuration.", flags: EPH });
      }
      if (cfg.staffRoles.length === 1) {
        return i.reply({ content: '❌ Il faut garder au moins un rôle staff. Ajoute-en un autre avant de retirer celui-ci.', flags: EPH });
      }
      cfg.staffRoles = cfg.staffRoles.filter((id) => id !== role.id);
      save();
      return i.reply({
        content: `🗑️ <@&${role.id}> retiré du staff de **${cfgName}** (les tickets déjà ouverts gardent leurs accès).`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    if (sub === 'raison-ajouter') {
      if (cfg.reasons.length >= 25) return i.reply({ content: '❌ 25 raisons maximum par configuration.', flags: EPH });
      const staff = i.options.getRole('role-staff');
      if (staff && staff.id === i.guild.id) return i.reply({ content: '❌ Tu ne peux pas choisir @everyone.', flags: EPH });
      cfg.reasons.push({
        id: crypto.randomUUID().slice(0, 8),
        label: i.options.getString('label', true).slice(0, 100),
        description: (i.options.getString('description') || '').slice(0, 100),
        emoji: i.options.getString('emoji') || null,
        staffRoleId: staff?.id || null,
      });
      save();
      await i.reply({
        content: `✅ Raison ajoutée à **${cfgName}** (${cfg.reasons.length} au total)${staff ? ` — staff : <@&${staff.id}>` : ''}. Les panels déjà envoyés se mettent à jour automatiquement.`,
        flags: EPH, allowedMentions: { parse: [] },
      });
      return refreshPanels(i.guild, cfgName).catch(console.error);
    }

    if (sub === 'raison-retirer') {
      const label = i.options.getString('label', true);
      const before = cfg.reasons.length;
      cfg.reasons = cfg.reasons.filter((r) => r.label.toLowerCase() !== label.toLowerCase());
      save();
      const removed = cfg.reasons.length < before;
      await i.reply({
        content: removed ? '🗑️ Raison retirée. Les panels déjà envoyés se mettent à jour automatiquement.' : '❌ Raison introuvable.',
        flags: EPH,
      });
      if (removed) await refreshPanels(i.guild, cfgName).catch(console.error);
      return;
    }

    if (sub === 'panel') {
      const salon = i.options.getChannel('salon', true);
      const img = i.options.getAttachment('image');
      const customDesc = i.options.getString('description');
      await i.deferReply({ flags: EPH });

      const embed = new EmbedBuilder()
        .setColor(parseColor(i.options.getString('couleur')))
        .setTitle(i.options.getString('titre') || `🎫 Support — ${cfg.name}`)
        .setDescription(customDesc || panelDesc(cfg));

      const files = [];
      if (img) {
        const f = await toFile(img, 'panel');
        files.push(f);
        embed.setImage(`attachment://${f.name}`);
      }

      const row = panelRow(cfg);

      try {
        const sent = await salon.send({ embeds: [embed], files, components: [row] });
        // On mémorise le panel : il sera mis à jour tout seul (nouvelles raisons, nouveau code du bot...)
        cfg.panels.push({
          channelId: salon.id,
          messageId: sent.id,
          customDesc: !!customDesc,
          sig: sig({ row: row.toJSON(), desc: customDesc ? null : panelDesc(cfg) }),
        });
        save();
        await i.editReply(`✅ Panel envoyé dans <#${salon.id}>. Il se mettra à jour tout seul.`);
      } catch (e) {
        console.error(e);
        await i.editReply("❌ Envoi impossible : vérifie mes permissions dans ce salon et que les emojis des raisons sont valides.");
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
  if (f.name === 'label') {
    const cfg = d.tickets[i.options.getString('config')];
    return i.respond(
      (cfg?.reasons || []).filter((r) => r.label.toLowerCase().includes(q)).slice(0, 25)
        .map((r) => ({ name: r.label, value: r.label })));
  }
  if (f.name === 'message') {
    // Liste des autoroles (pour /autorole supprimer)
    if (!hasFullAccess(i) && !i.member.permissions.has(PermissionFlagsBits.ManageRoles)) return i.respond([]);
    return i.respond(
      Object.entries(d.reactionRoles)
        .map(([id, r]) => ({
          name: `${r.label} → @${i.guild.roles.cache.get(r.roleId)?.name || 'rôle supprimé'} (#${i.guild.channels.cache.get(r.channelId)?.name || '?'})`.slice(0, 100),
          value: id,
        }))
        .filter((o) => o.name.toLowerCase().includes(q))
        .slice(0, 25));
  }
  if (f.name === 'giveaway') {
    if (!hasFullAccess(i)) return i.respond([]);
    const sub = i.options.getSubcommand(false);
    return i.respond(
      Object.entries(d.giveaways)
        .filter(([, g]) => sub === 'annuler' || (sub === 'reroll' ? g.ended : !g.ended))
        .filter(([, g]) => g.prize.toLowerCase().includes(q))
        .sort((a, b) => b[1].endAt - a[1].endAt)
        .slice(0, 25)
        .map(([id, g]) => ({
          name: `${g.prize} (#${i.guild.channels.cache.get(g.channelId)?.name || '?'})${g.ended ? ' — terminé' : ''}`.slice(0, 100),
          value: id,
        })));
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
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  // Toutes les commandes sont masquées par défaut (visibles seulement via Paramètres du serveur > Intégrations)
  // Sauf celles ouvertes à tout le monde (help, invites)
  const body = commands.map((c) => (PUBLIC_COMMANDS.has(c.name) ? c : c.setDefaultMemberPermissions('0')).toJSON());
  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.commands.set(body);
  } else {
    await client.application.commands.set(body);
  }
  console.log('✅ Commandes enregistrées');

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
  console.log('✅ Systèmes mis à jour automatiquement');

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
  m.set(inv.code, { uses: inv.uses ?? 0, maxUses: inv.maxUses || 0, inviterId: inv.inviter?.id || null });
  inviteCache.set(inv.guild.id, m);
});
client.on(Events.GuildCreate, (guild) => snapshotInvites(guild));

// Un nouveau salon doit aussi être invisible pour les membres mute
client.on(Events.ChannelCreate, (ch) => {
  if (!ch.guild || !ch.permissionOverwrites) return;
  const id = getG(ch.guild.id).muteRoleId;
  const role = id && ch.guild.roles.cache.get(id);
  if (role) ch.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => {});
});

// Salon des commandes : personne ne lit les messages des autres.
// Les réponses du bot sont privées et les messages écrits à la main dans ce salon sont supprimés.
client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || message.author.bot || message.system) return;
  if (getG(message.guildId).commandChannelId !== message.channelId) return;
  message.delete().catch(() => {});
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
      if (role) member.roles.add(role, 'Mute en cours').catch(console.error);
    } else {
      delete d.muted[member.id];
      save();
    }
  }

  const w = d.welcome;
  if (!w.enabled || !w.channelId) return;
  const ch = await member.guild.channels.fetch(w.channelId).catch(() => null);
  if (ch) ch.send(buildWelcome(member)).catch(console.error);
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
    if (i.isAutocomplete()) {
      if (!commandAllowed(i)) return await i.respond([]);
      return await autocomplete(i);
    }
    if (i.isChatInputCommand()) {
      if (!commandAllowed(i)) return await i.reply(NO_ACCESS);

      // Commande tapée dans le mauvais salon : message visible uniquement par celui qui l'a envoyée
      const wc = wrongChannel(i);
      if (wc) {
        return await i.reply({
          content: `❌ Les commandes ne s'utilisent pas ici. Va dans <#${wc}> pour taper \`/${i.commandName}\`.`,
          flags: EPH,
        });
      }
      return await handlers[i.commandName]?.(i);
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_open:')) {
      return await openTicket(i, i.customId.split(':')[1], i.values[0]);
    }
    if (i.isButton()) {
      if (i.customId.startsWith('tk_open:')) return await openTicket(i, i.customId.split(':')[1], null);
      if (i.customId === 'tk_close') return await closeTicket(i);
      if (i.customId === 'tk_claim') return await claimTicket(i);
      if (i.customId === 'gw_join') return await gwJoin(i);
      if (i.customId.startsWith('gw_leave:')) return await gwLeave(i);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '❌ Une erreur est survenue.', flags: EPH };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else if (!i.isAutocomplete()) i.reply(msg).catch(() => {});
  }
});

client.login(process.env.TOKEN);
