-- supabase.sql — à exécuter UNE SEULE FOIS : Supabase > SQL Editor > New query > coller tout > Run.
-- Peut être relancé sans danger (il répare aussi une ancienne table « bot_data » incomplète).
--
-- Principe : 1 ligne par serveur Discord dans « bot_data », et TOUTES ses données dans une colonne JSON (data) :
-- tickets, panels, sous-panels, modèles de message d'ouverture, giveaways, permissions…
-- Tout ce que tu ajouteras plus tard est enregistré tel quel : plus jamais de nouveau SQL à faire.

-- 1) Table principale ---------------------------------------------------------------------------
create table if not exists public.bot_data (
  id         text primary key,                 -- ID du serveur Discord (ou « _ping » : test de connexion du bot)
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Réparation d'une ancienne table (colonnes manquantes, mauvais type, clé primaire absente)
alter table public.bot_data add column if not exists data jsonb;
alter table public.bot_data add column if not exists updated_at timestamptz not null default now();
alter table public.bot_data alter column data type jsonb using data::jsonb;
update public.bot_data set data = '{}'::jsonb where data is null;
alter table public.bot_data alter column data set default '{}'::jsonb;
alter table public.bot_data alter column data set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.bot_data'::regclass and contype in ('p', 'u')) then
    alter table public.bot_data add primary key (id);
  end if;
end $$;

-- updated_at se met à jour tout seul à chaque écriture
create or replace function public.bot_data_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists bot_data_touch on public.bot_data;
create trigger bot_data_touch before insert or update on public.bot_data
  for each row execute function public.bot_data_touch();

-- 2) Historique : filet de sécurité -----------------------------------------------------------
-- Garde automatiquement d'anciennes versions de chaque serveur (au plus une toutes les 10 min, 100 conservées).
create table if not exists public.bot_data_history (
  n        bigint generated always as identity primary key,
  guild_id text        not null,
  data     jsonb       not null,
  saved_at timestamptz not null default now()
);
create index if not exists bot_data_history_guild on public.bot_data_history (guild_id, n desc);

create or replace function public.bot_data_archive() returns trigger
language plpgsql as $$
begin
  if old.id ~ '^[0-9]+$'
     and old.data is distinct from new.data
     and not exists (select 1 from public.bot_data_history h where h.guild_id = old.id and h.saved_at > now() - interval '10 minutes') then
    insert into public.bot_data_history (guild_id, data) values (old.id, old.data);
    delete from public.bot_data_history h
     where h.guild_id = old.id
       and h.n <= (select n from public.bot_data_history where guild_id = old.id order by n desc offset 100 limit 1);
  end if;
  return new;
end $$;

drop trigger if exists bot_data_archive on public.bot_data;
create trigger bot_data_archive before update on public.bot_data
  for each row execute function public.bot_data_archive();

-- Pour revenir en arrière sur un serveur (remplace 123… par l'ID du serveur, puis redémarre le bot) :
--   update public.bot_data set data = (select data from public.bot_data_history where guild_id = '123…' order by n desc limit 1) where id = '123…';

-- 3) Vue lisible : les modèles de message d'ouverture ----------------------------------------
-- Pour les consulter dans Supabase > Table Editor (lecture seule ; le bot reste la source de vérité).
create or replace view public.open_message_presets as
select b.id                    as guild_id,
       c.key                   as config,
       p.value ->> 'id'        as preset_id,
       p.value ->> 'name'      as name,
       p.value -> 'openMsg'    as message,
       b.updated_at
from public.bot_data b
cross join lateral jsonb_each(coalesce(b.data -> 'tickets', '{}'::jsonb)) as c(key, value)
cross join lateral jsonb_array_elements(coalesce(c.value -> 'openPresets', '[]'::jsonb)) as p(value)
where b.id ~ '^[0-9]+$';

-- 4) Sécurité : seule la clé « service_role » (celle du bot) a accès. La clé « anon » n'a aucun droit.
alter table public.bot_data         enable row level security;
alter table public.bot_data_history enable row level security;
revoke all on public.bot_data, public.bot_data_history, public.open_message_presets from anon, authenticated;
grant  all on public.bot_data, public.bot_data_history, public.open_message_presets to service_role;

-- Demande à Supabase de recharger sa structure (évite « table introuvable » juste après la création)
notify pgrst, 'reload schema';
