require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, Events, PermissionFlagsBits, ChannelType, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // privilégié : à activer dans le portail développeur
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilégié : nécessaire pour les transcripts de tickets
  ],
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
    tickets: {}, // nom -> { name, categoryId, staffRoleId, logChannelId, reasons[], counter }
    open: {},    // channelId -> { userId, config, reason, claimedBy }
  };
  return db[id];
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
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
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
        .addRoleOption((o) => o.setName('role-staff').setDescription('Rôle qui gère ces tickets').setRequired(true))
        .addChannelOption((o) =>
          o.setName('salon-logs').setDescription('Salon où envoyer les transcripts à la fermeture')
            .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('config-liste').setDescription('Lister les configurations'))
    .addSubcommand((s) =>
      s.setName('config-supprimer').setDescription('Supprimer une configuration')
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('raison-ajouter').setDescription("Ajouter une raison d'ouverture à une configuration")
        .addStringOption((o) => o.setName('config').setDescription('Configuration').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Nom de la raison').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Description courte'))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (optionnel)')))
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
      { id: cfg.staffRoleId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageMessages] },
      { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels] },
    ],
  });

  data.open[channel.id] = { userId: i.user.id, config: cfgName, reason: reason?.label || null, claimedBy: null };
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
    content: `<@${i.user.id}> <@&${cfg.staffRoleId}>`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [i.user.id], roles: [cfg.staffRoleId] },
  });
  await i.editReply(`✅ Ton ticket a été créé : <#${channel.id}>`);
}

function isStaff(i, cfg) {
  return (cfg && i.member.roles.cache.has(cfg.staffRoleId)) ||
    i.member.permissions.has(PermissionFlagsBits.ManageChannels);
}

async function claimTicket(i) {
  const data = getG(i.guildId);
  const t = data.open[i.channelId];
  if (!t) return i.reply({ content: "❌ Ce salon n'est pas un ticket géré.", flags: EPH });
  if (!isStaff(i, data.tickets[t.config])) {
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
  if (!isStaff(i, cfg) && i.user.id !== t.userId) {
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
/*  Gestionnaires de commandes                                         */
/* ------------------------------------------------------------------ */
const handlers = {
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
    const user = i.options.getUser('membre', true);
    const reason = i.options.getString('raison') || 'Aucune raison fournie';
    const days = i.options.getInteger('supprimer_messages') ?? 0;

    if (user.id === i.user.id) return i.reply({ content: '❌ Tu ne peux pas te bannir toi-même.', flags: EPH });
    if (user.id === client.user.id) return i.reply({ content: '❌ Je ne peux pas me bannir.', flags: EPH });

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (member) {
      if (!member.bannable) return i.reply({ content: '❌ Je ne peux pas bannir ce membre (rôle trop haut ou propriétaire).', flags: EPH });
      if (i.guild.ownerId !== i.user.id && i.member.roles.highest.position <= member.roles.highest.position) {
        return i.reply({ content: '❌ Ce membre a un rôle supérieur ou égal au tien.', flags: EPH });
      }
    }

    await i.deferReply();
    await user.send(`🔨 Tu as été banni de **${i.guild.name}**.\nRaison : ${reason}`).catch(() => {});
    await i.guild.members.ban(user.id, { reason: `${i.user.tag} : ${reason}`, deleteMessageSeconds: days * 86400 });

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
    await i.showModal(
      new ModalBuilder().setCustomId(modalId).setTitle('Nouvelle annonce').addComponents(
        field('titre', 'Titre', TextInputStyle.Short, { max: 256 }),
        field('texte', "Texte de l'annonce (Markdown accepté)", TextInputStyle.Paragraph, { required: true, max: 4000 }),
        field('image_url', "URL d'image (si pas de fichier)", TextInputStyle.Short, { max: 500 }),
        field('footer', 'Pied de page', TextInputStyle.Short, { max: 2048 }),
        field('couleur', 'Couleur hex (ex : #FF0000)', TextInputStyle.Short, { max: 7 }),
      ));

    const m = await i.awaitModalSubmit({
      time: 15 * 60_000,
      filter: (x) => x.customId === modalId && x.user.id === i.user.id,
    }).catch(() => null);
    if (!m) return;

    await m.deferReply({ flags: EPH });
    try {
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

      const parts = [];
      const allowed = { parse: [], roles: [], users: [] };
      if (ping) { parts.push(`@${ping}`); allowed.parse.push('everyone'); }
      if (mentionOpt?.role) { parts.push(`<@&${mentionOpt.role.id}>`); allowed.roles.push(mentionOpt.role.id); }
      else if (mentionOpt?.user) { parts.push(`<@${mentionOpt.user.id}>`); allowed.users.push(mentionOpt.user.id); }

      await salon.send({
        content: parts.join(' ') || undefined,
        embeds: [embed],
        files,
        allowedMentions: allowed,
      });
      await m.editReply(`✅ Annonce envoyée dans <#${salon.id}>.`);
    } catch (e) {
      console.error(e);
      await m.editReply("❌ Impossible d'envoyer l'annonce (vérifie mes permissions dans ce salon et les liens d'images).");
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
      d.tickets[nom] = {
        name: nom,
        categoryId: i.options.getChannel('categorie', true).id,
        staffRoleId: i.options.getRole('role-staff', true).id,
        logChannelId: i.options.getChannel('salon-logs')?.id || null,
        reasons: [],
        counter: 0,
      };
      save();
      return i.reply({
        content: `✅ Configuration **${nom}** créée.\nAjoute des raisons avec \`/ticket raison-ajouter\`, puis envoie le panel avec \`/ticket panel\`.`,
        flags: EPH,
      });
    }

    if (sub === 'config-liste') {
      const list = Object.values(d.tickets);
      if (!list.length) return i.reply({ content: "Aucune configuration. Crée-en une avec `/ticket config-creer`.", flags: EPH });
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎫 Configurations de tickets').setDescription(
        list.map((c) =>
          `**${c.name}**\n• Catégorie : <#${c.categoryId}>\n• Staff : <@&${c.staffRoleId}>\n• Logs : ${c.logChannelId ? `<#${c.logChannelId}>` : 'aucun'}\n• Raisons : ${c.reasons.length ? c.reasons.map((r) => r.label).join(', ') : 'aucune'}`
        ).join('\n\n'));
      return i.reply({ embeds: [embed], flags: EPH });
    }

    const cfgName = i.options.getString('config', true);
    const cfg = d.tickets[cfgName];
    if (!cfg) return i.reply({ content: '❌ Configuration introuvable.', flags: EPH });

    if (sub === 'config-supprimer') {
      delete d.tickets[cfgName];
      save();
      return i.reply({ content: `🗑️ Configuration **${cfgName}** supprimée. Les anciens panels ne fonctionneront plus.`, flags: EPH });
    }

    if (sub === 'raison-ajouter') {
      if (cfg.reasons.length >= 25) return i.reply({ content: '❌ 25 raisons maximum par configuration.', flags: EPH });
      cfg.reasons.push({
        id: crypto.randomUUID().slice(0, 8),
        label: i.options.getString('label', true).slice(0, 100),
        description: (i.options.getString('description') || '').slice(0, 100),
        emoji: i.options.getString('emoji') || null,
      });
      save();
      return i.reply({ content: `✅ Raison ajoutée à **${cfgName}** (${cfg.reasons.length} au total). Renvoie le panel pour qu'elle apparaisse.`, flags: EPH });
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
function autocomplete(i) {
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
});

client.on(Events.GuildMemberAdd, async (member) => {
  scheduleCount(member.guild);
  const w = getG(member.guild.id).welcome;
  if (!w.enabled || !w.channelId) return;
  const ch = await member.guild.channels.fetch(w.channelId).catch(() => null);
  if (ch) ch.send(buildWelcome(member)).catch(console.error);
});

client.on(Events.GuildMemberRemove, (member) => scheduleCount(member.guild));

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
