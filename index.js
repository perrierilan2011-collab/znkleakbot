require('dotenv').config();
const fs = require('fs');
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
  ],
  // Nécessaire pour recevoir les réactions sur des messages envoyés avant un redémarrage du bot
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ------------------------------------------------------------------ */
/*  Stockage (simple fichier JSON)                                     */
/* ------------------------------------------------------------------ */
const DB_FILE = './data.json';
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

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
    tickets: {}, // nom -> { name, categoryId, staffRoles[], logChannelId, reasons[], counter }
    open: {},    // channelId -> { userId, config, reason, claimedBy, staffRoles[] }
  };
  const g = db[id];
  // Ajout des nouveaux champs pour les serveurs déjà enregistrés
  g.modRoles ??= [];        // rôles autorisés à utiliser ban / unban / mute / unmute
  g.protectedRoles ??= [];  // rôles que seul le propriétaire peut mute / ban
  g.muteRoleId ??= null;    // rôle "Muté" créé par le bot
  g.muted ??= {};           // userId -> { roles[], until, reason, by }
  g.reactionRoles ??= {};   // messageId -> { channelId, roleId, emoji, label }
  // Migration : un seul rôle staff -> plusieurs rôles staff
  for (const c of Object.values(g.tickets)) {
    c.staffRoles ??= c.staffRoleId ? [c.staffRoleId] : [];
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

// Le propriétaire OU un membre ayant un rôle choisi avec /roles-mod
const canModerate = (i) =>
  isOwner(i) || i.member.roles.cache.some((r) => getG(i.guildId).modRoles.includes(r.id));

const NO_ACCESS = { content: "❌ Tu n'as pas accès à cette commande.", flags: EPH };

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
/*  Définition des commandes                                           */
/* ------------------------------------------------------------------ */
const commands = [
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

  // ---------- Rôles autorisés à modérer (👑 uniquement) ----------
  new SlashCommandBuilder()
    .setName('roles-mod')
    .setDescription('👑 Choisir quels rôles peuvent utiliser ban / unban / mute / unmute')
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
      s.setName('panel').setDescription('Envoyer le panel de tickets dans un salon')
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

/* ------------------------------------------------------------------ */
/*  Gestion des listes de rôles (/roles-mod et /roles-proteges)        */
/* ------------------------------------------------------------------ */
function roleListHandler(key, title) {
  return async (i) => {
    if (!isOwner(i)) {
      return i.reply({ content: '❌ Seul le propriétaire du serveur (👑) peut utiliser cette commande.', flags: EPH });
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
      return i.reply({ content: `✅ <@&${role.id}> ajouté à : **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
    }

    d[key] = d[key].filter((id) => id !== role.id);
    save();
    return i.reply({ content: `🗑️ <@&${role.id}> retiré de : **${title}**.`, flags: EPH, allowedMentions: { parse: [] } });
  };
}

/* ------------------------------------------------------------------ */
/*  Gestionnaires de commandes                                         */
/* ------------------------------------------------------------------ */
const handlers = {
  /* ---------- /roles-mod & /roles-proteges (👑) ---------- */
  'roles-mod': roleListHandler('modRoles', 'Rôles autorisés à modérer (ban / unban / mute / unmute)'),
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

    await i.deferReply();
    await user.send(`🔨 Tu as été banni de **${i.guild.name}**.\nRaison : ${reason}`).catch(() => {});
    await i.guild.members.ban(user.id, { reason: `${i.user.tag} : ${reason}`, deleteMessageSeconds: days * 86400 });
    banCache.delete(i.guildId);

    // Si le membre était muté, on nettoie son enregistrement
    delete getG(i.guildId).muted[user.id];
    save();

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

    await i.deferReply();

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

    await i.deferReply();
    const until = Date.now() + duration;
    try {
      await applyMute(i.guild, member, until, reason, i.user.id);
    } catch (e) {
      console.error(e);
      return i.editReply(
        "❌ Impossible de mute ce membre. Mon rôle doit être **au-dessus** du sien (idéalement tout en haut de la liste) " +
        "et j'ai besoin des permissions **Gérer les rôles** et **Gérer les salons**.");
    }

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

    await i.deferReply();
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
    if (!i.member.permissions.has(PermissionFlagsBits.ManageRoles)) return i.reply(NO_ACCESS);
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
      return i.reply({
        content: `✅ Raison ajoutée à **${cfgName}** (${cfg.reasons.length} au total)${staff ? ` — staff : <@&${staff.id}>` : ''}. Renvoie le panel pour qu'elle apparaisse.`,
        flags: EPH, allowedMentions: { parse: [] },
      });
    }

    if (sub === 'raison-retirer') {
      const label = i.options.getString('label', true);
      const before = cfg.reasons.length;
      cfg.reasons = cfg.reasons.filter((r) => r.label.toLowerCase() !== label.toLowerCase());
      save();
      return i.reply({ content: cfg.reasons.length < before ? '🗑️ Raison retirée.' : '❌ Raison introuvable.', flags: EPH });
    }

    if (sub === 'panel') {
      const salon = i.options.getChannel('salon', true);
      const img = i.options.getAttachment('image');
      await i.deferReply({ flags: EPH });

      const embed = new EmbedBuilder()
        .setColor(parseColor(i.options.getString('couleur')))
        .setTitle(i.options.getString('titre') || `🎫 Support — ${cfg.name}`)
        .setDescription(
          i.options.getString('description') ||
          (cfg.reasons.length
            ? 'Sélectionne la raison de ta demande dans le menu ci-dessous pour ouvrir un ticket.'
            : 'Clique sur le bouton ci-dessous pour ouvrir un ticket.'));

      const files = [];
      if (img) {
        const f = await toFile(img, 'panel');
        files.push(f);
        embed.setImage(`attachment://${f.name}`);
      }

      let row;
      if (cfg.reasons.length) {
        row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`tk_open:${cfg.name}`)
            .setPlaceholder('Choisis une raison...')
            .addOptions(cfg.reasons.map((r) => {
              const o = { label: r.label, value: r.id };
              if (r.description) o.description = r.description;
              if (r.emoji) o.emoji = r.emoji;
              return o;
            })));
      } else {
        row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tk_open:${cfg.name}`).setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary));
      }

      try {
        await salon.send({ embeds: [embed], files, components: [row] });
        await i.editReply(`✅ Panel envoyé dans <#${salon.id}>.`);
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
    if (!i.member.permissions.has(PermissionFlagsBits.ManageRoles)) return i.respond([]);
    return i.respond(
      Object.entries(d.reactionRoles)
        .map(([id, r]) => ({
          name: `${r.label} → @${i.guild.roles.cache.get(r.roleId)?.name || 'rôle supprimé'} (#${i.guild.channels.cache.get(r.channelId)?.name || '?'})`.slice(0, 100),
          value: id,
        }))
        .filter((o) => o.name.toLowerCase().includes(q))
        .slice(0, 25));
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
  const body = commands.map((c) => c.toJSON());
  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.commands.set(body);
  } else {
    await client.application.commands.set(body);
  }
  console.log('✅ Commandes enregistrées');

  client.guilds.cache.forEach(updateCount);
  setInterval(() => client.guilds.cache.forEach(updateCount), 10 * 60_000);

  // Fin automatique des mutes
  checkMutes();
  setInterval(checkMutes, 15_000);
});

// Un nouveau salon doit aussi être invisible pour les membres mute
client.on(Events.ChannelCreate, (ch) => {
  if (!ch.guild || !ch.permissionOverwrites) return;
  const id = getG(ch.guild.id).muteRoleId;
  const role = id && ch.guild.roles.cache.get(id);
  if (role) ch.permissionOverwrites.edit(role, { ViewChannel: false }).catch(() => {});
});

client.on(Events.GuildMemberAdd, async (member) => {
  scheduleCount(member.guild);

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

client.on(Events.GuildMemberRemove, (member) => scheduleCount(member.guild));

// Autorole : réaction ajoutée / retirée
client.on(Events.MessageReactionAdd, (reaction, user) => handleReaction(reaction, user, true));
client.on(Events.MessageReactionRemove, (reaction, user) => handleReaction(reaction, user, false));

// Autorole : si le message est supprimé à la main, on nettoie l'enregistrement
client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  const d = getG(message.guildId);
  if (d.reactionRoles[message.id]) {
    delete d.reactionRoles[message.id];
    save();
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) return await autocomplete(i);
    if (i.isChatInputCommand()) return await handlers[i.commandName]?.(i);
    if (i.isStringSelectMenu() && i.customId.startsWith('tk_open:')) {
      return await openTicket(i, i.customId.split(':')[1], i.values[0]);
    }
    if (i.isButton()) {
      if (i.customId.startsWith('tk_open:')) return await openTicket(i, i.customId.split(':')[1], null);
      if (i.customId === 'tk_close') return await closeTicket(i);
      if (i.customId === 'tk_claim') return await claimTicket(i);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '❌ Une erreur est survenue.', flags: EPH };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else if (!i.isAutocomplete()) i.reply(msg).catch(() => {});
  }
});

client.login(process.env.TOKEN);
