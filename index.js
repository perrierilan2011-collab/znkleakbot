/* ------------------------------------------------------------------ */
/*  Système d'invitations : suivi, récompenses (rôles), classement     */
/*  À brancher dans le bot principal (voir les 5 petites modifs).      */
/* ------------------------------------------------------------------ */
const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, MessageFlags, Events,
} = require('discord.js');

module.exports = function setupInvites({ client, getG, save }) {
  const EPH = MessageFlags.Ephemeral;
  const cache = new Map(); // guildId -> Map(code -> { uses, maxUses, inviterId })

  const data = (guildId) => {
    const g = getG(guildId);
    g.invites ??= {
      stats: {},     // inviterId -> { joins, left }
      joinedBy: {},  // membre -> inviterId (pour compter les départs)
      rewards: [],   // [{ count, roleId }]
      board: null,   // { channelId, messageId, top }
    };
    return g.invites;
  };
  const net = (s) => (s?.joins || 0) - (s?.left || 0);
  const MEDALS = ['🥇', '🥈', '🥉'];

  /* ---------------- Cache des invitations ---------------- */
  async function snapshot(guild) {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;
    const map = new Map();
    for (const inv of invites.values()) {
      map.set(inv.code, { uses: inv.uses ?? 0, maxUses: inv.maxUses || 0, inviterId: inv.inviter?.id || null });
    }
    cache.set(guild.id, map);
    return map;
  }

  // Compare avec le cache : l'invitation dont le compteur a augmenté est celle utilisée
  async function findInviter(guild) {
    const old = cache.get(guild.id) || new Map();
    const now = await snapshot(guild);
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

  /* ---------------- Récompenses ---------------- */
  async function checkRewards(guild, userId) {
    const d = data(guild.id);
    const count = net(d.stats[userId]);
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

  /* ---------------- Classement ---------------- */
  function buildBoard(guild, top) {
    const d = data(guild.id);
    const list = Object.entries(d.stats)
      .map(([id, s]) => ({ id, s, n: net(s) }))
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

  /* ---------------- Commandes ---------------- */
  const commands = [
    new SlashCommandBuilder()
      .setName('invites')
      .setDescription("Voir ton nombre d'invitations (ou celui d'un membre)")
      .addUserOption((o) => o.setName('membre').setDescription('Le membre à regarder (toi par défaut)'))
      .setDMPermission(false),

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

    new SlashCommandBuilder()
      .setName('classement-invites')
      .setDescription("Envoyer le classement des invitations dans un salon")
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon où envoyer le classement')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addIntegerOption((o) =>
        o.setName('top').setDescription('Nombre de places affichées (10 par défaut)').setMinValue(3).setMaxValue(25))
      .setDefaultMemberPermissions('0')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('classement-invites-maj')
      .setDescription('Mettre à jour le classement des invitations déjà envoyé')
      .setDefaultMemberPermissions('0')
      .setDMPermission(false),
  ];

  const handlers = {
    /* ---------- /invites (tout le monde) ---------- */
    async invites(i) {
      const user = i.options.getUser('membre') || i.user;
      const d = data(i.guildId);
      const s = d.stats[user.id] || { joins: 0, left: 0 };
      const n = net(s);
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
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    },

    /* ---------- /invites-config ---------- */
    async 'invites-config'(i) {
      const d = data(i.guildId);
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
          content: d.rewards.length < before ? '🗑️ Récompense supprimée (les rôles déjà donnés sont conservés).' : '❌ Aucune récompense pour ce nombre.',
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
        if (net(s) >= nb) await checkRewards(i.guild, uid);
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
        const msg = await salon.send({ embeds: [buildBoard(i.guild, top)], allowedMentions: { parse: [] } });
        data(i.guildId).board = { channelId: salon.id, messageId: msg.id, top };
        save();
        await i.editReply(`✅ Classement envoyé dans <#${salon.id}>. Mets-le à jour avec \`/classement-invites-maj\`.`);
      } catch (e) {
        console.error(e);
        await i.editReply("❌ Envoi impossible : vérifie mes permissions dans ce salon.");
      }
    },

    /* ---------- /classement-invites-maj ---------- */
    async 'classement-invites-maj'(i) {
      const b = data(i.guildId).board;
      if (!b) return i.reply({ content: "❌ Aucun classement envoyé. Utilise d'abord `/classement-invites`.", flags: EPH });
      await i.deferReply({ flags: EPH });
      const ch = await i.guild.channels.fetch(b.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(b.messageId).catch(() => null) : null;
      if (!msg) return i.editReply('❌ Le message du classement a été supprimé. Renvoie-le avec `/classement-invites`.');
      await msg.edit({ embeds: [buildBoard(i.guild, b.top)], allowedMentions: { parse: [] } })
        .catch((e) => { console.error(e); });
      return i.editReply(`✅ Classement mis à jour : https://discord.com/channels/${i.guildId}/${b.channelId}/${b.messageId}`);
    },
  };

  /* ---------------- Événements ---------------- */
  client.on(Events.InviteCreate, (inv) => {
    if (!inv.guild) return;
    const m = cache.get(inv.guild.id) || new Map();
    m.set(inv.code, { uses: inv.uses ?? 0, maxUses: inv.maxUses || 0, inviterId: inv.inviter?.id || null });
    cache.set(inv.guild.id, m);
  });
  // Pas de suppression ici : une invitation à usage limité disparaît juste après l'arrivée,
  // on a besoin de la garder en cache pour savoir qui a invité. Le cache est rafraîchi à chaque arrivée.
  client.on(Events.GuildCreate, (guild) => snapshot(guild));

  async function onMemberAdd(member) {
    if (member.user.bot) return;
    const inviterId = await findInviter(member.guild).catch(() => null);
    if (!inviterId || inviterId === member.id) return;
    const d = data(member.guild.id);
    d.joinedBy[member.id] = inviterId;
    const s = (d.stats[inviterId] ??= { joins: 0, left: 0 });
    s.joins++;
    save();
    await checkRewards(member.guild, inviterId);
  }

  function onMemberRemove(member) {
    const d = data(member.guild.id);
    const inviterId = d.joinedBy[member.id];
    if (!inviterId) return;
    delete d.joinedBy[member.id];
    const s = (d.stats[inviterId] ??= { joins: 0, left: 0 });
    s.left = (s.left || 0) + 1;
    save();
  }

  async function init() {
    for (const guild of client.guilds.cache.values()) await snapshot(guild);
  }

  return { commands, handlers, onMemberAdd, onMemberRemove, init };
};
