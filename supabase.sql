-- À exécuter UNE SEULE FOIS : Supabase > SQL Editor > New query > coller > Run
-- Le bot enregistre 1 ligne par serveur Discord (id = ID du serveur) : tickets, panels, sous-panels, rôles, etc.

create table if not exists public.bot_data (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Protection : seule la clé « service_role » (celle du bot) peut lire/écrire. La clé « anon » n'a aucun accès.
alter table public.bot_data enable row level security;
revoke all on public.bot_data from anon, authenticated;

-- Historique automatique : une copie par heure et par serveur (48 dernières gardées) pour pouvoir revenir en arrière
create table if not exists public.bot_data_history (
  n        bigserial primary key,
  id       text not null,
  data     jsonb not null,
  saved_at timestamptz not null default now()
);
create index if not exists bot_data_history_id_idx on public.bot_data_history (id, n desc);
alter table public.bot_data_history enable row level security;
revoke all on public.bot_data_history from anon, authenticated;

create or replace function public.bot_data_keep_history() returns trigger
language plpgsql as $$
begin
  if left(old.id, 1) = '_' or old.data is not distinct from new.data then
    return new;
  end if;
  if not exists (select 1 from public.bot_data_history h where h.id = old.id and h.saved_at > now() - interval '1 hour') then
    insert into public.bot_data_history (id, data) values (old.id, old.data);
    delete from public.bot_data_history h
      where h.id = old.id
        and h.n not in (select n from public.bot_data_history where id = old.id order by n desc limit 48);
  end if;
  return new;
end $$;

drop trigger if exists bot_data_history_trg on public.bot_data;
create trigger bot_data_history_trg before update on public.bot_data
  for each row execute function public.bot_data_keep_history();
