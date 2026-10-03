export interface Env {
  ASSETS: Fetcher;
  /** https://SEU-PROJETO.supabase.co */
  SUPABASE_URL: string;
  /** Chave secreta do Supabase (service_role / sb_secret_...). Só o servidor usa. */
  SUPABASE_SERVICE_KEY: string;
  /** Texto aleatório (32+ caracteres) que assina o cookie de login. */
  SESSION_SECRET: string;
  API_FOOTBALL_KEY: string;
  ODDS_API_KEY?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  /** "1" = modo demonstração (banco em memória + login falso). Só vale em localhost. */
  DEV_MEMORY?: string;
  /** Limites (opcionais; padrão 2 cadastros por minuto e 5 tentativas de login por conta a cada 15 min). */
  LIMIT_SIGNUP_PER_MIN?: string;
  LIMIT_LOGIN_FAILS?: string;
}

export type Pick1x2 = "1" | "X" | "2";
export type PickMode = "ou" | "cs";
export type PickOu = "over" | "under";

export interface MarketOdds {
  source: string;
  fetched_at: Date;
  /** Odds brutas do mercado (com margem). */
  raw: Record<string, number>;
  /** Odds justas (sem margem), 2 casas. */
  fair: Record<string, number>;
}

export interface OddsMap {
  "1X2"?: MarketOdds;
  OU25?: MarketOdds;
  CS?: MarketOdds;
  /** Médias de gols do modelo de Poisson ajustado ao 1X2 (+ O/U), usado para placares sem odd de mercado. */
  model?: { lh: number; la: number };
}

export interface TeamRef {
  id: number;
  name: string;
  logo?: string;
}

export interface LeagueRef {
  id: number;
  name: string;
  country?: string;
  logo?: string;
}

export interface Match {
  round_id: string;
  api_fixture_id: number;
  league: LeagueRef;
  home: TeamRef;
  away: TeamRef;
  kickoff_utc: Date;
  /** Status curto da API-Football (NS, 1H, FT, PST...). */
  status: string;
  home_goals: number | null;
  away_goals: number | null;
  manual_override: boolean;
  voided: boolean;
  relevance: number;
  odds: OddsMap | null;
  frozen_odds: OddsMap | null;
  /** Placar já foi convertido em pontos. */
  scored?: boolean;
  /** Extras (gols / placar exato) que valiam quando o jogo começou; antes disso vale a configuração atual. */
  extras_frozen?: { ou: boolean; cs: boolean } | null;
  live?: LiveInfo | null;
}

export type RoundStatus = "draft" | "open" | "closed" | "finished";

export type RoundRequired = "winner" | "winner_goals";

export interface Round {
  title: string;
  /** AAAA-MM-DD (dia em Brasília). */
  date: string;
  status: RoundStatus;
  created_at: Date;
  match_ids: string[];
  /** O que é obrigatório palpitar em cada jogo: só o vencedor, ou vencedor + gols (mais/menos de 2,5 ou placar exato). */
  required?: RoundRequired;
  reminder_sent?: boolean;
  finished_notified?: boolean;
}

export interface Prediction {
  user_id: string;
  match_id: string;
  round_id: string;
  pick_1x2: Pick1x2;
  /** null = só o vencedor (sem extra). */
  mode: PickMode | null;
  pick_ou: PickOu | null;
  home_goals: number | null;
  away_goals: number | null;
  joker: boolean;
  points: number | null;
  hits: number | null;
  /** Pontos por componente, sem o coringa (para estatísticas). */
  parts?: { winner: number; ou: number; cs: number } | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserDoc {
  name: string;
  nickname: string;
  email: string;
  phone?: string | null;
  role: "admin" | "player";
  created_at: Date;
  /** O que a pessoa já alterou no próprio perfil. Cada item só pode ser alterado uma vez (depois, só o admin). */
  edits?: ProfileEdits | null;
}

export interface ProfileEdits {
  nickname?: boolean;
  phone?: boolean;
  password?: boolean;
}

/** Placar ao vivo (atualizado por demanda; o resultado oficial continua vindo do cron). */
export interface LiveInfo {
  home: number | null;
  away: number | null;
  /** Status curto da API-Football: 1H, HT, 2H, ET, P, FT... */
  status: string;
  elapsed: number | null;
  at: Date;
}

export type QuestionKind = "pergunta" | "basquete" | "ufc";

/** Pergunta do dia (ou jogo de basquete / luta do UFC) com odds escolhidas pelo admin. */
export interface Question {
  /** Dia do bolão (AAAA-MM-DD). */
  date: string;
  kind: QuestionKind;
  title: string;
  options: { id: string; label: string; odd: number }[];
  /** Até quando dá para responder (depois disso trava e aparecem as escolhas de todos). */
  closes_at: Date;
  /** id da opção certa; null enquanto não tem resultado. */
  result: string | null;
  voided: boolean;
  created_at: Date;
}

export interface Answer {
  question_id: string;
  user_id: string;
  date: string;
  option_id: string;
  points: number | null;
  hits: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface StandingRow {
  user_id: string;
  nickname: string;
  points: number;
  hits: number;
}

/** Maior odd acertada (vencedor 1X2 ou placar exato; o mercado de gols não conta). */
export interface Zebra {
  odd: number;
  tipo: "1x2" | "placar";
  jogo: string;
  match_id: string;
  user_id: string;
  nickname: string;
}

/** Vencedores (1X2) acertados em sequência. */
export interface StreakRow {
  user_id: string;
  nickname: string;
  /** Sequência em andamento (acertos seguidos até o último jogo com resultado). */
  current: number;
  /** Maior sequência já feita. */
  best: number;
}

export interface Standings {
  scope: "round" | "month" | "all";
  /** Só nos documentos de rodada: mês (AAAA-MM) para somar o ranking mensal. */
  month?: string;
  rows: StandingRow[];
  zebra?: Zebra | null;
  streaks?: StreakRow[];
  /** Só nos documentos de rodada: acertos do vencedor por participante, em ordem de jogo ("1" acertou, "0" errou). */
  seq?: Record<string, string>;
  /** Só nos documentos de rodada: horário do primeiro jogo (ordena as rodadas para somar sequências). */
  start?: Date;
  updated_at: Date;
}
