-- Bolão: tabelas do Supabase. Cole este arquivo inteiro em SQL Editor → New query → Run (pode rodar de novo sem medo).
--
-- Uma tabela por assunto. Só o servidor do site (Cloudflare Worker) fala com o banco, usando a chave secreta
-- (service_role). O navegador nunca acessa o banco: todas as tabelas têm RLS ligado e nenhuma regra de acesso.

create table if not exists users (
  id          text primary key,            -- o mesmo id do Supabase Auth (auth.users.id)
  name        text not null,
  nickname    text not null,
  email       text not null unique,
  phone       text,                        -- só dígitos, com DDD
  edits       jsonb,                       -- o que a pessoa já mudou no perfil (apelido, telefone, senha: só 1 vez cada)
  role        text not null default 'player' check (role in ('admin', 'player')),
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);

-- Bancos criados antes do cadastro aberto não tinham o telefone:
alter table users add column if not exists phone text;
alter table users add column if not exists edits jsonb;

create table if not exists rounds (
  id                 text primary key,     -- AAAA-MM-DD (dia do bolão: 06:00 às 06:00 em São Paulo), ou AAAA-MM-DD-2...
  title              text not null,
  date               text not null,
  status             text not null default 'draft' check (status in ('draft', 'open', 'closed', 'finished')),
  created_at         timestamptz not null default now(),
  match_ids          jsonb not null default '[]'::jsonb,
  required           text not null default 'winner' check (required in ('winner', 'winner_goals')),
  reminder_sent      boolean,
  finished_notified  boolean,
  version            bigint not null default 1
);
-- Bancos criados antes do "obrigatório por rodada":
alter table rounds add column if not exists required text not null default 'winner';
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
  live             jsonb,                  -- placar ao vivo: {home, away, status, elapsed, at}
  version          bigint not null default 1
);

-- Bancos criados antes do placar ao vivo:
alter table matches add column if not exists live jsonb;
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

    if coll not in ('users', 'rounds', 'matches', 'predictions', 'standings', 'api_usage', 'push_subs',
                    'settings', 'fixtures_cache', 'team_cache', 'rate_limits', 'questions', 'answers', 'suggestions', 'comments', 'reactions', 'championships', 'shootouts') then
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

-- Perguntas do dia (também jogos de basquete e lutas do UFC), com odds escolhidas pelo admin.
create table if not exists questions (
  id          text primary key,
  date        text not null,                -- dia do bolão (AAAA-MM-DD)
  kind        text not null default 'pergunta' check (kind in ('pergunta', 'basquete', 'ufc')),
  title       text not null,
  options     jsonb not null,               -- [{id, label, odd}]
  closes_at   timestamptz not null,
  result      text,                          -- id da opção certa
  voided      boolean not null default false,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists questions_date_idx on questions (date);

create table if not exists answers (
  id           text primary key,             -- {questionId}_{userId}
  question_id  text not null,
  user_id      text not null,
  date         text not null,
  option_id    text not null,
  points       double precision,
  hits         integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      bigint not null default 1
);
create index if not exists answers_question_idx on answers (question_id);
create index if not exists answers_date_idx on answers (date);
create index if not exists answers_user_idx on answers (user_id);

-- Pedidos dos participantes: voto em jogo que querem na rodada, ou sugestão escrita.
create table if not exists suggestions (
  id          text primary key,
  kind        text not null check (kind in ('voto', 'texto')),
  user_id     text not null,
  date        text not null,
  fixture_id  bigint,
  label       text,
  text        text,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists suggestions_kind_idx on suggestions (kind);

-- Comentários em cada jogo e reações aos palpites da galera.
create table if not exists comments (
  id          text primary key,
  match_id    text not null,
  round_id    text not null,
  user_id     text not null,
  text        text not null,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists comments_match_idx on comments (match_id);
create index if not exists comments_round_idx on comments (round_id);

create table if not exists reactions (
  id             text primary key,              -- {palpite}_{usuário}_{emoji}
  prediction_id  text not null,
  match_id       text not null,
  round_id       text not null,
  user_id        text not null,
  emoji          text not null,
  created_at     timestamptz not null default now(),
  version        bigint not null default 1
);
create index if not exists reactions_match_idx on reactions (match_id);
create index if not exists reactions_round_idx on reactions (round_id);

-- Campeonatos: um período com nome e premiação; o ranking soma as rodadas dentro dele.
create table if not exists championships (
  id          text primary key,
  name        text not null,
  start_date  text not null,
  end_date    text not null,
  prize       text,
  fee         text,                          -- competição paga (opcional): valor combinado entre os participantes; o app só mostra
  format      text,                          -- confrontos: pontos | grupos | mata | copa (vazio = ranking de pontos)
  legs        integer,                       -- 1 = só ida, 2 = ida e volta
  groups      integer,
  advance     integer,
  goal_step   double precision,              -- quantos pontos de lucro valem 1 gol
  participants jsonb,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
alter table championships add column if not exists fee text;
-- Campeonato de confrontos 1×1 (vazio = ranking de pontos, como antes)
alter table championships add column if not exists format text;            -- pontos | grupos | mata | copa
alter table championships add column if not exists legs integer;           -- 1 = só ida, 2 = ida e volta
alter table championships add column if not exists groups integer;        -- quantos grupos (grupos e copa)
alter table championships add column if not exists advance integer;       -- quantos de cada grupo passam (copa)
alter table championships add column if not exists goal_step double precision; -- quantos pontos de lucro valem 1 gol
alter table championships add column if not exists participants jsonb;    -- ids na ordem de entrada (cabeça de chave)

-- Pênaltis do mata-mata (empate em gols e em lucro): palpites de cada um até o prazo do admin e o resultado, gravado uma vez.
create table if not exists shootouts (
  id               text primary key,             -- {campeonato}~{fase}~{a}~{b}
  championship_id  text not null,
  key              text not null,                -- fase|a|b
  a                text not null,
  b                text not null,
  deadline         timestamptz,                  -- prazo para palpitar (vazio = o admin ainda não definiu)
  picks            jsonb,                        -- { userId: { aims: [...], dives: [...] } }
  result           jsonb,                        -- disputa pronta (cobranças, placar, vencedor)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,
  version          bigint not null default 1
);
create index if not exists shootouts_champ_idx on shootouts (championship_id);

-- Vagas dos limites (cadastro: 2 por minuto; login: 5 tentativas por conta). O cron apaga as antigas.
create table if not exists rate_limits (
  id          text primary key,
  created_at  timestamptz not null default now(),
  version     bigint not null default 1
);
create index if not exists rate_limits_created_idx on rate_limits (created_at);

-- ---------------------------------------------------------------------------
-- Segurança: só a chave secreta do servidor (service_role) mexe nos dados.
-- ---------------------------------------------------------------------------
alter table users          enable row level security;
alter table rounds         enable row level security;
alter table matches        enable row level security;
alter table predictions    enable row level security;
alter table standings      enable row level security;
alter table api_usage      enable row level security;
alter table push_subs      enable row level security;
alter table settings       enable row level security;
alter table fixtures_cache enable row level security;
alter table team_cache     enable row level security;
alter table rate_limits    enable row level security;
alter table questions      enable row level security;
alter table answers        enable row level security;
alter table suggestions    enable row level security;
alter table comments       enable row level security;
alter table reactions      enable row level security;
alter table championships  enable row level security;
alter table shootouts      enable row level security;

revoke all on users, rounds, matches, predictions, standings, api_usage, push_subs, settings, fixtures_cache, team_cache, rate_limits, questions, answers, suggestions, comments, reactions, championships
  from anon, authenticated;
revoke all on function apply_writes(jsonb) from public, anon, authenticated;
grant execute on function apply_writes(jsonb) to service_role;
