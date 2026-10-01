import type { Env, LeagueRef, TeamRef } from "../types";
import type { Repo } from "../db/repo";
import type { Settings } from "../lib/settings";
import { HttpError } from "../lib/errors";
import { median, type RawMarkets } from "../lib/odds";
import { utcDate } from "../lib/dates";

const BASE = "https://v3.football.api-sports.io";
export const PROVIDER = "api-football";

export interface FixtureView {
  id: number;
  kickoff: Date;
  status: string;
  league: LeagueRef;
  home: TeamRef;
  away: TeamRef;
  /** Placar em 90 minutos (é o que vale para 1X2, O/U e placar exato). */
  home_goals: number | null;
  away_goals: number | null;
}

export const FINISHED = new Set(["FT", "AET", "PEN"]);
export const CALLED_OFF = new Set(["PST", "CANC", "ABD", "AWD", "WO", "SUSP"]);

export function parseFixture(f: any): FixtureView {
  const ft = f.score?.fulltime;
  const useFt = ft && ft.home !== null && ft.away !== null;
  return {
    id: f.fixture.id,
    kickoff: new Date(f.fixture.date),
    status: f.fixture.status?.short ?? "NS",
    league: { id: f.league.id, name: f.league.name, country: f.league.country, logo: f.league.logo },
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
    home_goals: useFt ? ft.home : (f.goals?.home ?? null),
    away_goals: useFt ? ft.away : (f.goals?.away ?? null),
  };
}

// ---------- odds ----------

const PREFERRED = [/pinnacle/i, /betfair/i];
/** ids das casas na API-Football, em ordem de preferência: Pinnacle, Bet365. */
const ODDS_BOOKMAKERS = [4, 8];

interface Bet {
  name: string;
  values: { value: string; odd: string }[];
}

/** Mapeia os valores de um bet da API para as chaves do nosso mercado. */
function selectionsOf(marketKey: keyof RawMarkets, bet: Bet): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of bet.values) {
    const odd = Number(v.odd);
    if (!(odd > 1)) continue;
    if (marketKey === "1X2") {
      const k = { Home: "1", Draw: "X", Away: "2" }[v.value];
      if (k) out[k] = odd;
    } else if (marketKey === "OU25") {
      if (v.value === "Over 2.5") out.over = odd;
      else if (v.value === "Under 2.5") out.under = odd;
    } else {
      const m = /^(\d+)\s*[:\-]\s*(\d+)$/.exec(v.value.trim());
      if (m) out[`${m[1]}-${m[2]}`] = odd;
    }
  }
  return out;
}

const BET_NAMES: Record<keyof RawMarkets, string> = { "1X2": "Match Winner", OU25: "Goals Over/Under", CS: "Exact Score" };
const REQUIRED: Record<keyof RawMarkets, string[]> = { "1X2": ["1", "X", "2"], OU25: ["over", "under"], CS: [] };

/**
 * Lê a resposta de /odds. Prefere Pinnacle/Betfair; sem elas, usa a mediana das casas
 * (selecão por seleção). Só aceita mercados completos.
 */
export function parseOdds(response: any[]): RawMarkets {
  const bookmakers: { name: string; bets: Bet[] }[] = response?.[0]?.bookmakers ?? [];
  const out: RawMarkets = {};
  for (const key of Object.keys(BET_NAMES) as (keyof RawMarkets)[]) {
    const perBook = bookmakers
      .map((b) => {
        const bet = b.bets.find((x) => x.name === BET_NAMES[key]);
        return { name: b.name, sel: bet ? selectionsOf(key, bet) : {} };
      })
      .filter((b) => REQUIRED[key].every((k) => b.sel[k] > 1) && Object.keys(b.sel).length >= 2);
    if (perBook.length === 0) continue;

    let chosen: { source: string; raw: Record<string, number> } | undefined;
    for (const re of PREFERRED) {
      const b = perBook.find((x) => re.test(x.name));
      if (b) {
        chosen = { source: b.name, raw: b.sel };
        break;
      }
    }
    if (!chosen) {
      const keys = new Set(perBook.flatMap((b) => Object.keys(b.sel)));
      const raw: Record<string, number> = {};
      for (const k of keys) {
        const vals = perBook.map((b) => b.sel[k]).filter((v) => v > 1);
        if (vals.length) raw[k] = Math.round(median(vals) * 100) / 100;
      }
      chosen = { source: perBook.length === 1 ? perBook[0].name : `mediana de ${perBook.length} casas`, raw };
    }
    out[key] = chosen;
  }
  return out;
}

// ---------- cliente com controle de cota ----------

export class QuotaError extends HttpError {
  constructor(message: string) {
    super(429, message);
  }
}

export class ApiFootball {
  private lastCall = 0;

  constructor(
    private env: Env,
    private repo: Repo,
    private settings: Settings,
  ) {}

  async usedToday(): Promise<number> {
    return this.repo.usage(utcDate(), PROVIDER);
  }

  /** Espaça as chamadas: o plano grátis aceita ~10 por minuto. */
  private async throttle() {
    const wait = 6500 - (Date.now() - this.lastCall);
    if (this.lastCall && wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  /**
   * `keepReserve`: chamadas automáticas de odds param quando sobra só a reserva (guardada para placares).
   * A cota diária nunca é ultrapassada.
   */
  private async call(path: string, params: Record<string, string | number>, opts: { keepReserve?: boolean; spaced?: boolean } = {}): Promise<any[]> {
    if (!this.env.API_FOOTBALL_KEY) throw new HttpError(503, "API_FOOTBALL_KEY não configurada");
    const used = await this.usedToday();
    const limit = this.settings.apiFootballDailyLimit;
    if (used >= limit) throw new QuotaError(`Cota diária da API-Football esgotada (${used}/${limit})`);
    if (opts.keepReserve && used >= limit - this.settings.apiReserve) {
      throw new QuotaError(`Reserva de chamadas atingida (${used}/${limit}); sobra só para placares`);
    }
    if (opts.spaced) await this.throttle();
    await this.repo.addUsage(utcDate(), PROVIDER);

    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "x-apisports-key": this.env.API_FOOTBALL_KEY } });
    if (res.status === 429) throw new QuotaError("A API-Football pediu para ir mais devagar (limite por minuto)");
    if (!res.ok) throw new HttpError(502, `API-Football respondeu ${res.status}`);
    const json: any = await res.json();
    const errs = json.errors;
    const errText = Array.isArray(errs) ? errs.join("; ") : errs && typeof errs === "object" ? Object.values(errs).join("; ") : "";
    if (errText) throw new HttpError(502, `API-Football: ${errText}`);
    return json.response ?? [];
  }

  async fixturesByDate(date: string): Promise<FixtureView[]> {
    const rows = await this.call("/fixtures", { date, timezone: "America/Sao_Paulo" });
    return rows.map(parseFixture);
  }

  /** Até 20 ids por chamada. */
  async fixturesByIds(ids: number[]): Promise<FixtureView[]> {
    if (ids.length === 0) return [];
    const rows = await this.call("/fixtures", { ids: ids.slice(0, 20).join("-") });
    return rows.map(parseFixture);
  }

  /**
   * Odds de um jogo, uma casa por chamada (Pinnacle; se ela não tiver o jogo, Bet365). A resposta com todas as casas
   * passa de 190 KB, e só ler e processar isso estoura os 10 ms de CPU do plano grátis do Workers. A Pinnacle traz 1X2 e
   * Mais/Menos 2,5 (o placar exato vem do modelo de Poisson); a Bet365 traz também o placar exato.
   */
  async odds(fixtureId: number, opts: { keepReserve?: boolean; spaced?: boolean } = {}): Promise<RawMarkets> {
    for (const bookmaker of ODDS_BOOKMAKERS) {
      const parsed = parseOdds(await this.call("/odds", { fixture: fixtureId, bookmaker }, opts));
      if (parsed["1X2"]) return parsed;
    }
    return {};
  }

  async teamFixtures(teamId: number, kind: "last" | "next", n: number): Promise<FixtureView[]> {
    const rows = await this.call("/fixtures", { team: teamId, [kind]: n, timezone: "America/Sao_Paulo" });
    return rows.map(parseFixture);
  }

  /** Diagnóstico do plano: /status não gasta cota; depois testa uma busca por data. */
  async diagnose(date: string) {
    const status = await fetch(`${BASE}/status`, { headers: { "x-apisports-key": this.env.API_FOOTBALL_KEY ?? "" } })
      .then((r) => r.json() as Promise<any>)
      .catch((e) => ({ errors: [String(e)] }));
    let fixtures: { ok: boolean; total?: number; erro?: string } = { ok: false };
    try {
      const rows = await this.fixturesByDate(date);
      fixtures = { ok: true, total: rows.length };
    } catch (e: any) {
      fixtures = { ok: false, erro: e.message };
    }
    return {
      plano: status.response?.subscription?.plan ?? null,
      ativo: status.response?.subscription?.active ?? null,
      requisicoes_hoje: status.response?.requests?.current ?? null,
      limite_dia: status.response?.requests?.limit_day ?? null,
      erros_status: status.errors && !Array.isArray(status.errors) ? Object.values(status.errors) : status.errors,
      busca_por_data: fixtures,
    };
  }
}
