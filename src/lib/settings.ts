import { badRequest } from "./errors";

export interface Settings {
  /** Multiplicadores por tipo de acerto. */
  winnerMultiplier: number;
  ouMultiplier: number;
  csMultiplier: number;
  jokerEnabled: boolean;
  /** Extra "mais/menos de 2,5 gols" disponível para palpite. O admin liga/desliga a qualquer momento. */
  goalsEnabled: boolean;
  /** Extra "placar exato" disponível para palpite. */
  scoreEnabled: boolean;
  jokerMultiplier: number;
  /** Teto para qualquer odd justa (placar exato costuma ser enorme). */
  oddCap: number;
  /** Peso de relevância por id de liga da API-Football. */
  leagueWeights: Record<string, number>;
  defaultLeagueWeight: number;
  /** Nomes (como na API, sem acento/maiúscula) que dão bônus de relevância. */
  bigTeams: string[];
  bigTeamBonus: number;
  derbyBonus: number;
  /** Bônus para todo jogo de campeonato brasileiro (Séries A a D, Copa do Brasil, estaduais...). */
  brazilBonus: number;
  /** Máximo de jogos escolhidos por dia do bolão (06:00 → 06:00 em São Paulo), somando todas as rodadas do dia. */
  maxMatchesPerDay: number;
  apiFootballDailyLimit: number;
  /** Chamadas guardadas para placares: as odds automáticas param quando sobra só isso. */
  apiReserve: number;
  /** Só atualiza odds de jogos que começam dentro desta janela. */
  oddsWindowHours: number;
  oddsRefreshHours: number;
}

export const DEFAULT_SETTINGS: Settings = {
  winnerMultiplier: 1,
  ouMultiplier: 1,
  csMultiplier: 1,
  jokerEnabled: true,
  goalsEnabled: true,
  scoreEnabled: true,
  jokerMultiplier: 2,
  oddCap: 150,
  leagueWeights: {
    // 100: Copa do Mundo, Euro, Copa América, Champions, Libertadores
    "1": 100,
    "4": 100,
    "9": 100,
    "2": 100,
    "13": 100,
    // 90: Premier League, La Liga, Série A (BR), Serie A (IT), Bundesliga
    "39": 90,
    "140": 90,
    "71": 90,
    // Brasil: Série B, Série C e Série D (somam o bônus do Brasil)
    "72": 60,
    "75": 45,
    "76": 30,
    "135": 90,
    "78": 90,
    // 80: Ligue 1, Copa do Brasil, Sul-Americana, Europa League
    "61": 80,
    "73": 80,
    "11": 80,
    "3": 80,
  },
  defaultLeagueWeight: 40,
  brazilBonus: 40,
  bigTeams: [
    "flamengo", "palmeiras", "corinthians", "sao paulo", "santos", "fluminense", "vasco da gama", "botafogo",
    "gremio", "internacional", "atletico-mg", "cruzeiro", "real madrid", "barcelona", "atletico madrid",
    "manchester city", "manchester united", "liverpool", "chelsea", "arsenal", "tottenham", "bayern munich",
    "borussia dortmund", "juventus", "inter", "ac milan", "napoli", "as roma", "paris saint germain",
    "boca juniors", "river plate", "benfica", "fc porto", "ajax", "brazil", "argentina", "france", "germany",
    "spain", "england", "portugal", "italy", "uruguay", "netherlands",
  ],
  bigTeamBonus: 5,
  derbyBonus: 10,
  maxMatchesPerDay: 10,
  apiFootballDailyLimit: 100,
  apiReserve: 25,
  oddsWindowHours: 12,
  oddsRefreshHours: 3,
};

const NUMERIC: (keyof Settings)[] = [
  "winnerMultiplier", "ouMultiplier", "csMultiplier", "jokerMultiplier", "oddCap", "defaultLeagueWeight",
  "bigTeamBonus", "derbyBonus", "brazilBonus", "maxMatchesPerDay", "apiFootballDailyLimit", "apiReserve", "oddsWindowHours", "oddsRefreshHours",
];

/** Configuração salva + padrões (campos ausentes voltam ao padrão). */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

/** Valida um pedaço de configuração vindo do admin. */
export function parseSettingsPatch(input: any): Partial<Settings> {
  if (!input || typeof input !== "object") throw badRequest("Configuração inválida");
  const out: Partial<Settings> = {};
  for (const key of NUMERIC) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw badRequest(`Valor inválido em ${key}`);
    (out as any)[key] = n;
  }
  if (input.oddCap !== undefined && (out.oddCap ?? 0) < 2) throw badRequest("O limite de odd deve ser pelo menos 2");
  if (out.maxMatchesPerDay !== undefined && (!Number.isInteger(out.maxMatchesPerDay) || out.maxMatchesPerDay < 1 || out.maxMatchesPerDay > 30)) {
    throw badRequest("O limite de jogos por dia deve ser um número inteiro de 1 a 30");
  }
  if (input.jokerEnabled !== undefined) out.jokerEnabled = Boolean(input.jokerEnabled);
  if (input.goalsEnabled !== undefined) out.goalsEnabled = Boolean(input.goalsEnabled);
  if (input.scoreEnabled !== undefined) out.scoreEnabled = Boolean(input.scoreEnabled);
  if (input.leagueWeights !== undefined) {
    if (typeof input.leagueWeights !== "object" || Array.isArray(input.leagueWeights)) throw badRequest("Pesos das ligas inválidos");
    const lw: Record<string, number> = {};
    for (const [id, w] of Object.entries(input.leagueWeights)) {
      const n = Number(w);
      if (!/^\d+$/.test(id) || !Number.isFinite(n) || n < 0 || n > 1000) throw badRequest(`Peso inválido para a liga ${id}`);
      lw[id] = n;
    }
    out.leagueWeights = lw;
  }
  if (input.bigTeams !== undefined) {
    if (!Array.isArray(input.bigTeams)) throw badRequest("Lista de times inválida");
    out.bigTeams = input.bigTeams.map((t: unknown) => normalizeName(String(t))).filter(Boolean).slice(0, 300);
  }
  return out;
}

export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
