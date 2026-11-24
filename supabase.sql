-- =====================================================================================
--  ZNK BOT — SUPABASE : BASE COMPLÈTE (à exécuter UNE FOIS)
--  Supabase > SQL Editor > New query > coller tout > Run.
--
--  Cette base est prévue pour être relancée sans danger : elle crée/répare les tables,
--  les triggers et recrée les vues de lecture.
--
--  ARCHITECTURE
--  ------------
--  Toutes les données du bot sont sauvegardées dans UNE seule table : public.bot_data.
--  Une ligne = un serveur Discord (id = ID du serveur), et toute sa configuration dans
--  la colonne JSONB « data » : tickets, panels, sous-panels, messages, invitations,
--  vouchs, ventes, rôles, permissions, giveaways…
--
--  Pourquoi ça survit aux redéploiements ?
--  - Railway peut redémarrer/reconstruire le bot : Supabase garde la ligne du serveur.
--  - Au démarrage, le bot recharge Supabase AVANT de se connecter à Discord.
--  - Les panels sont enregistrés dans data.tickets.<config>.panels (salon + message id) :
--    le bot les retrouve et les remet à jour automatiquement après un redéploiement.
--  - Les invitations sont dans data.invites, les vouchs dans data.vouches,
--    les ventes dans data.sales.
--
--  Les VUES en bas de fichier servent uniquement à lire ces données facilement dans
--  Supabase > Table Editor. Le bot reste la source de vérité et écrit dans bot_data.
-- =====================================================================================


-- =====================================================================================
--  1) TABLE PRINCIPALE
-- =====================================================================================
create table if not exists public.bot_data (
  id         text primary key,                       -- ID du serveur Discord (ou « _ping »)
  data       jsonb not null default '{}'::jsonb,      -- toutes les données du serveur
  updated_at timestamptz not null default now()
);

-- Réparation d'une ancienne table incomplète (colonnes manquantes, mauvais type…)
alter table public.bot_data add column if not exists data jsonb;
alter table public.bot_data add column if not exists updated_at timestamptz not null default now();
alter table public.bot_data alter column data type jsonb using data::jsonb;
update public.bot_data set data = '{}'::jsonb where data is null;
alter table public.bot_data alter column data set default '{}'::jsonb;
alter table public.bot_data alter column data set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bot_data'::regclass and contype in ('p', 'u')
  ) then
    alter table public.bot_data add primary key (id);
  end if;
end $$;

create index if not exists bot_data_updated_at on public.bot_data (updated_at desc);

-- updated_at se met à jour tout seul
create or replace function public.bot_data_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists bot_data_touch on public.bot_data;
create trigger bot_data_touch
  before insert or update on public.bot_data
  for each row execute function public.bot_data_touch();


-- =====================================================================================
--  2) HISTORIQUE (filet de sécurité)
--  Garde automatiquement d'anciennes versions de chaque serveur :
--  au plus une toutes les 10 minutes, 100 versions conservées.
--
--  Pour revenir en arrière sur un serveur (remplace 123… par l'ID du serveur) :
--    update public.bot_data
--       set data = (select data from public.bot_data_history
--                    where guild_id = '123…' order by n desc limit 1)
--     where id = '123…';
--  Puis redémarre le bot.
-- =====================================================================================
create table if not exists public.bot_data_history (
  n        bigint generated always as identity primary key,
  guild_id text        not null,
  data     jsonb       not null,
  saved_at timestamptz not null default now()
);
create index if not exists bot_data_history_guild on public.bot_data_history (guild_id, n desc);

create or replace function public.bot_data_archive()
returns trigger
language plpgsql
as $$
begin
  if old.id ~ '^[0-9]+$'
     and old.data is distinct from new.data
     and not exists (
       select 1 from public.bot_data_history h
       where h.guild_id = old.id and h.saved_at > now() - interval '10 minutes'
     ) then
    insert into public.bot_data_history (guild_id, data) values (old.id, old.data);
    delete from public.bot_data_history h
     where h.guild_id = old.id
       and h.n <= (
         select n from public.bot_data_history
         where guild_id = old.id order by n desc offset 100 limit 1
       );
  end if;
  return new;
end $$;

drop trigger if exists bot_data_archive on public.bot_data;
create trigger bot_data_archive
  before update on public.bot_data
  for each row execute function public.bot_data_archive();


-- =====================================================================================
--  3) VUES DE LECTURE
--  Lecture seule. Elles se mettent à jour toutes seules quand le bot écrit dans bot_data.
-- =====================================================================================

-- 3.1 — Résumé par serveur -----------------------------------------------------------
create or replace view public.bot_summary as
select
  b.id                                                              as guild_id,
  b.updated_at,
  (select count(*) from jsonb_object_keys(coalesce(b.data->'tickets', '{}'::jsonb)))      as ticket_configs,
  (select count(*) from jsonb_object_keys(coalesce(b.data->'open', '{}'::jsonb)))         as open_tickets,
  coalesce(jsonb_array_length(coalesce(b.data->'vouches', '[]'::jsonb)), 0)       as vouches,
  coalesce((b.data->'sales'->>'count')::int, 0)                                    as sales_count,
  coalesce((b.data->'sales'->>'total')::numeric, 0)                                as sales_total,
  coalesce(b.data->'sales'->>'currency', '€')                                      as sales_currency,
  (select count(*) from jsonb_object_keys(coalesce(b.data->'invites'->'stats', '{}'::jsonb))) as inviters,
  b.data->'invites'->'board'->>'channelId'                                         as invite_board_channel_id
from public.bot_data b
where b.id ~ '^[0-9]+$';

-- 3.2 — Configurations de tickets -----------------------------------------------------
create or replace view public.ticket_configs as
select
  b.id                                             as guild_id,
  c.key                                            as config,
  c.value->>'categoryId'                           as category_id,
  c.value->'staffRoles'                            as staff_roles,
  c.value->>'logChannelId'                         as log_channel_id,
  coalesce((c.value->>'counter')::int, 0)          as tickets_created,
  coalesce((c.value->>'dm')::boolean, false)       as dm_mode,
  c.value->>'placeholder'                          as placeholder,
  c.value->>'color'                                as color,
  coalesce(jsonb_array_length(coalesce(c.value->'reasons', '[]'::jsonb)), 0)     as reasons_count,
  coalesce(jsonb_array_length(coalesce(c.value->'panels', '[]'::jsonb)), 0)      as panels_count,
  coalesce(jsonb_array_length(coalesce(c.value->'subPanels', '[]'::jsonb)), 0)   as subpanels_count
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
where b.id ~ '^[0-9]+$';

-- 3.3 — Panels de tickets envoyés (ceux qui doivent continuer à fonctionner) ----------
create or replace view public.ticket_panels as
select
  b.id                                                   as guild_id,
  c.key                                                  as config,
  p.value->>'channelId'                                  as channel_id,
  p.value->>'messageId'                                  as message_id,
  case when coalesce((p.value->>'button')::boolean, false)
       then 'bouton' else 'menu' end                     as panel_type,
  p.value->>'btnLabel'                                   as button_label,
  p.value->>'btnStyle'                                   as button_style,
  coalesce((p.value->>'customDesc')::boolean, false)     as fixed_description
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value->'panels', '[]'::jsonb)) as p(value)
where b.id ~ '^[0-9]+$';

-- 3.4 — Catégories du menu des panels -------------------------------------------------
create or replace view public.ticket_reasons as
select
  b.id                                     as guild_id,
  c.key                                    as config,
  r.value->>'id'                           as reason_id,
  r.value->>'label'                        as label,
  r.value->>'emoji'                        as emoji,
  r.value->>'description'                  as description,
  r.value->>'categoryId'                   as category_id,
  r.value->>'staffRoleId'                  as staff_role_id
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value->'reasons', '[]'::jsonb)) as r(value)
where b.id ~ '^[0-9]+$';

-- 3.5 — Sous-panels et leurs choix ----------------------------------------------------
create or replace view public.ticket_subpanels as
select
  b.id                                     as guild_id,
  c.key                                    as config,
  s.value->>'id'                           as subpanel_id,
  s.value->>'name'                         as name,
  s.value->>'title'                        as title,
  coalesce((s.value->>'payment')::boolean, false) as is_payment,
  coalesce(jsonb_array_length(coalesce(s.value->'choices', '[]'::jsonb)), 0) as choices_count
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value->'subPanels', '[]'::jsonb)) as s(value)
where b.id ~ '^[0-9]+$';

create or replace view public.ticket_subpanel_choices as
select
  b.id                                     as guild_id,
  c.key                                    as config,
  s.value->>'id'                           as subpanel_id,
  s.value->>'name'                         as subpanel_name,
  ch.value->>'id'                          as choice_id,
  ch.value->>'label'                       as label,
  ch.value->>'description'                 as description,
  ch.value->>'categoryId'                  as category_id,
  ch.value->>'staffRoleId'                 as staff_role_id,
  ch.value->>'nextSubId'                   as next_subpanel_id
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value->'subPanels', '[]'::jsonb)) as s(value)
cross join lateral jsonb_array_elements(coalesce(s.value->'choices', '[]'::jsonb)) as ch(value)
where b.id ~ '^[0-9]+$';

-- 3.6 — Modèles de message d'ouverture ------------------------------------------------
create or replace view public.open_message_presets as
select
  b.id                    as guild_id,
  c.key                   as config,
  p.value->>'id'          as preset_id,
  p.value->>'name'        as name,
  p.value->'openMsg'      as message,
  b.updated_at
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value->'openPresets', '[]'::jsonb)) as p(value)
where b.id ~ '^[0-9]+$';

-- 3.7 — Invitations -------------------------------------------------------------------
create or replace view public.invite_stats as
select
  b.id                                        as guild_id,
  s.key                                       as user_id,
  coalesce((s.value->>'joins')::int, 0)       as joins,
  coalesce((s.value->>'left')::int, 0)        as left_count,
  coalesce((s.value->>'joins')::int, 0) - coalesce((s.value->>'left')::int, 0) as net
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'invites'->'stats', '{}'::jsonb)) as s(key, value)
where b.id ~ '^[0-9]+$';

create or replace view public.invite_links as
select
  b.id                                  as guild_id,
  l.key                                 as code,
  l.value->>'userId'                    as user_id,
  l.value->>'createdBy'                 as created_by,
  to_timestamp(((l.value->>'createdAt')::bigint) / 1000) as created_at,
  coalesce((l.value->>'joins')::int, 0) as joins
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data->'invites'->'links', '{}'::jsonb)) as l(key, value)
where b.id ~ '^[0-9]+$';

create or replace view public.invite_rewards as
select
  b.id                                   as guild_id,
  (r.value->>'count')::int               as required_invites,
  r.value->>'roleId'                     as role_id
from public.bot_data b
cross join lateral jsonb_array_elements(coalesce(b.data->'invites'->'rewards', '[]'::jsonb)) as r(value)
where b.id ~ '^[0-9]+$';

-- 3.8 — Vouchs ------------------------------------------------------------------------
create or replace view public.vouches as
select
  b.id                                  as guild_id,
  v.value->>'id'                        as vouch_id,
  v.value->>'ticketId'                  as ticket_channel_id,
  v.value->>'ticketName'                as ticket_name,
  v.value->>'config'                    as config,
  v.value->>'from'                      as from_user_id,
  v.value->>'claimedBy'                 as claimed_by,
  nullif(v.value->>'stars', '')::int    as stars,
  v.value->>'message'                   as message,
  v.value->>'image'                     as image_url,
  to_timestamp(((v.value->>'at')::bigint) / 1000) as created_at
from public.bot_data b
cross join lateral jsonb_array_elements(coalesce(b.data->'vouches', '[]'::jsonb)) as v(value)
where b.id ~ '^[0-9]+$';

-- 3.9 — Ventes ------------------------------------------------------------------------
create or replace view public.sales_stats as
select
  b.id                                                     as guild_id,
  coalesce((b.data->'sales'->>'count')::int, 0)            as sales_count,
  coalesce((b.data->'sales'->>'total')::numeric, 0)        as total_amount,
  coalesce(b.data->'sales'->>'currency', '€')              as currency,
  b.data->'sales'->>'channelId'                            as channel_id,
  b.data->'sales'->>'messageId'                            as message_id,
  case
    when coalesce((b.data->'sales'->>'count')::int, 0) > 0
      then round(coalesce((b.data->'sales'->>'total')::numeric, 0) / (b.data->'sales'->>'count')::numeric, 2)
    else 0
  end                                                      as average_basket
from public.bot_data b
where b.id ~ '^[0-9]+$';

create or replace view public.sales_entries as
select
  b.id                                     as guild_id,
  e.value->>'ticket'                       as ticket_name,
  e.value->>'config'                       as config,
  coalesce((e.value->>'amount')::numeric, 0) as amount,
  e.value->>'buyerId'                      as buyer_id,
  e.value->>'buyerName'                    as buyer_name,
  e.value->>'product'                      as product,
  e.value->>'by'                           as sold_by,
  to_timestamp(((e.value->>'at')::bigint) / 1000) as sold_at
from public.bot_data b
cross join lateral jsonb_array_elements(coalesce(b.data->'sales'->'entries', '[]'::jsonb)) as e(value)
where b.id ~ '^[0-9]+$';

-- 3.10 — Panels créés (tickets + ventes) ----------------------------------------------
create or replace view public.panels_overview as
select guild_id, config, channel_id, message_id, 'ticket' as kind, panel_type as detail from public.ticket_panels
union all
select guild_id, 'ventes' as config, channel_id, message_id, 'ventes' as kind, 'panel de suivi' as detail
from public.sales_stats
where channel_id is not null;


-- =====================================================================================
--  4) SÉCURITÉ
--  Seule la clé « service_role » (celle utilisée par le bot) peut lire/écrire.
--  La clé « anon » n'a AUCUN droit : ne la mets jamais dans le bot.
-- =====================================================================================
alter table public.bot_data         enable row level security;
alter table public.bot_data_history enable row level security;

revoke all on public.bot_data, public.bot_data_history from anon, authenticated;

grant all on public.bot_data, public.bot_data_history to service_role;

-- Vues : lecture seule pour service_role
do $$
declare v text;
begin
  foreach v in array array[
    'bot_summary','ticket_configs','ticket_panels','ticket_reasons','ticket_subpanels',
    'ticket_subpanel_choices','open_message_presets','invite_stats','invite_links',
    'invite_rewards','vouches','sales_stats','sales_entries','panels_overview'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant select on public.%I to service_role', v);
  end loop;
end $$;

-- Demande à Supabase de recharger sa structure (évite « table introuvable »)
notify pgrst, 'reload schema';
