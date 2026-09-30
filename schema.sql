-- Bolão: tabelas do Supabase. Cole este arquivo inteiro em SQL Editor → New query → Run (pode rodar de novo sem medo).
--
-- Uma tabela por assunto. Só o servidor do site (Cloudflare Worker) fala com o banco, usando a chave secreta
-- (service_role). O navegador nunca acessa o banco: todas as tabelas têm RLS ligado e nenhuma regra de acesso.

create table if not exists users (
  id          text primary key,            -- o mesmo id do Supabase Auth (auth.users.id)
  name        text not null,
  nickname    text not null,
  email       text not null unique,
  role        text not null default 'player' check (role in ('admin', 'player')),
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);

create table if not exists invites (
  id          text primary key,            -- o token do link /convite/{token}
  max_uses    integer not null default 1,
  uses        integer not null default 0,
  expires_at  timestamptz not null,
  created_by  text,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);

create table if not exists rounds (
  id                 text primary key,     -- AAAA-MM-DD (dia do bolão: 06:00 às 06:00 em São Paulo), ou AAAA-MM-DD-2...
  title              text not null,
  date               text not null,
  status             text not null default 'draft' check (status in ('draft', 'open', 'closed', 'finished')),
  created_at         timestamptz not null default now(),
  match_ids          jsonb not null default '[]'::jsonb,
  reminder_sent      boolean,
  finished_notified  boolean,
  version            bigint not null default 1
);
create index if not exists rounds_date_idx on rounds (date);
create index if not exists rounds_status_idx on rounds (status);

create table if not exists matches (
  id               text primary key,       -- id do jogo na API-Football
  round_id         text not null,
  api_fixture_id   bigint not null,
  league           jsonb not null,
  home             jsonb not null,
  away             jsonb not null,
  kickoff_utc      timestamptz not null,
  status           text not null default 'NS',
  home_goals       integer,
  away_goals       integer,
  manual_override  boolean not null default false,
  voided           boolean not null default false,
  relevance        double precision,
  odds             jsonb,                  -- odds ao vivo
  frozen_odds      jsonb,                  -- congeladas no início do jogo
  extras_frozen    jsonb,                  -- extras (gols/placar) que valiam no início do jogo
  scored           boolean,
  odds_error       text,
  version          bigint not null default 1
);
create index if not exists matches_round_idx on matches (round_id);

create table if not exists predictions (
  id          text primary key,            -- {matchId}_{userId}
  user_id     text not null,
  match_id    text not null,
  round_id    text not null,
  pick_1x2    text not null check (pick_1x2 in ('1', 'X', '2')),
  mode        text check (mode in ('ou', 'cs')),   -- null = só o vencedor
  pick_ou     text check (pick_ou in ('over', 'under')),
  home_goals  integer,
  away_goals  integer,
  joker       boolean not null default false,
  points      double precision,
  hits        integer,
  parts       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1,
  -- gols OU placar exato, nunca os dois
  constraint um_extra_so check (not (pick_ou is not null and (home_goals is not null or away_goals is not null)))
);
create index if not exists predictions_user_idx on predictions (user_id);
create index if not exists predictions_round_idx on predictions (round_id);
create index if not exists predictions_match_idx on predictions (match_id);

create table if not exists standings (
  id          text primary key,            -- round_{id} | month_{AAAA-MM} | all
  scope       text not null check (scope in ('round', 'month', 'all')),
  month       text,
  rows        jsonb not null default '[]'::jsonb,
  zebra       jsonb,
  streaks     jsonb,
  seq         jsonb,
  start       timestamptz,
  updated_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists standings_scope_idx on standings (scope, month);

create table if not exists api_usage (
  id        text primary key,              -- {AAAA-MM-DD}_{provedor}
  date      text,
  provider  text,
  calls     integer default 0,
  version   bigint not null default 1
);

create table if not exists push_subs (
  id          text primary key,            -- sha256 do endpoint
  user_id     text not null,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists push_subs_user_idx on push_subs (user_id);

-- Documentos soltos (um bloco de JSON por linha): configurações e caches.
create table if not exists settings (
  id       text primary key,               -- 'app'
  data     jsonb not null default '{}'::jsonb,
  version  bigint not null default 1
);

create table if not exists fixtures_cache (
  id       text primary key,               -- AAAA-MM-DD (dia do calendário)
  data     jsonb not null default '{}'::jsonb,
  version  bigint not null default 1
);

create table if not exists team_cache (
  id       text primary key,               -- id do time
  data     jsonb not null default '{}'::jsonb,
  version  bigint not null default 1
);

-- ---------------------------------------------------------------------------
-- Gravação em lote, tudo ou nada (é o "commit" do servidor). Cada item de `w`:
--   { op: 'set' | 'merge' | 'delete' | 'increment', coll, id, data?, must_not_exist?, must_exist?, update_time?, field?, by? }
-- Conflito (já existe, ou mudou desde a leitura) vira HTTP 409 (PT409) e desfaz o lote inteiro.
-- ---------------------------------------------------------------------------
create or replace function apply_writes(w jsonb) returns void
language plpgsql
as $$
declare
  x       jsonb;
  coll    text;
  did     text;
  op      text;
  prev    jsonb;
  merged  jsonb;
  ver     bigint;
  is_json boolean;
begin
  for x in select * from jsonb_array_elements(w) loop
    coll := x->>'coll';
    did  := x->>'id';
    op   := x->>'op';

    if coll not in ('users', 'invites', 'rounds', 'matches', 'predictions', 'standings', 'api_usage', 'push_subs',
                    'settings', 'fixtures_cache', 'team_cache') then
      raise exception 'coleção inválida: %', coll;
    end if;
    if did is null or did = '' then
      raise exception 'id vazio';
    end if;
    is_json := coll in ('settings', 'fixtures_cache', 'team_cache');

    if op = 'delete' then
      execute format('delete from %I where id = $1', coll) using did;
      continue;
    end if;

    if op = 'increment' then
      execute format(
        'insert into %1$I (id, %2$I, version) values ($1, $2, 1) on conflict (id) do update set %2$I = coalesce(%1$I.%2$I, 0) + $2, version = %1$I.version + 1',
        coll, x->>'field') using did, (x->>'by')::bigint;
      continue;
    end if;

    execute format('select to_jsonb(t) from %I t where id = $1 for update', coll) into prev using did;

    if op = 'set' then
      if prev is not null and coalesce((x->>'must_not_exist')::boolean, false) then
        raise exception 'conflito' using errcode = 'PT409';
      end if;
      ver := coalesce((prev->>'version')::bigint, 0) + 1;
      if is_json then
        merged := jsonb_build_object('id', did, 'data', coalesce(x->'data', '{}'::jsonb), 'version', ver);
      else
        merged := coalesce(x->'data', '{}'::jsonb) || jsonb_build_object('id', did, 'version', ver);
      end if;

    elsif op = 'merge' then
      if prev is null then
        if coalesce((x->>'must_exist')::boolean, false) or x->>'update_time' is not null then
          raise exception 'conflito' using errcode = 'PT409';
        end if;
        if is_json then
          merged := jsonb_build_object('id', did, 'data', coalesce(x->'data', '{}'::jsonb), 'version', 1);
        else
          merged := coalesce(x->'data', '{}'::jsonb) || jsonb_build_object('id', did, 'version', 1);
        end if;
      else
        if x->>'update_time' is not null and (prev->>'version') <> (x->>'update_time') then
          raise exception 'conflito' using errcode = 'PT409';
        end if;
        ver := (prev->>'version')::bigint + 1;
        if is_json then
          merged := prev || jsonb_build_object('data', coalesce(prev->'data', '{}'::jsonb) || coalesce(x->'data', '{}'::jsonb), 'version', ver);
        else
          merged := prev || coalesce(x->'data', '{}'::jsonb) || jsonb_build_object('id', did, 'version', ver);
        end if;
      end if;

    else
      raise exception 'operação inválida: %', op;
    end if;

    execute format('delete from %I where id = $1', coll) using did;
    execute format('insert into %1$I select * from jsonb_populate_record(null::%1$I, $1)', coll) using merged;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Segurança: só a chave secreta do servidor (service_role) mexe nos dados.
-- ---------------------------------------------------------------------------
alter table users          enable row level security;
alter table invites        enable row level security;
alter table rounds         enable row level security;
alter table matches        enable row level security;
alter table predictions    enable row level security;
alter table standings      enable row level security;
alter table api_usage      enable row level security;
alter table push_subs      enable row level security;
alter table settings       enable row level security;
alter table fixtures_cache enable row level security;
alter table team_cache     enable row level security;

revoke all on users, invites, rounds, matches, predictions, standings, api_usage, push_subs, settings, fixtures_cache, team_cache
  from anon, authenticated;
revoke all on function apply_writes(jsonb) from public, anon, authenticated;
grant execute on function apply_writes(jsonb) to service_role;
