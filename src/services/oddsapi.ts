import type { Env, LeagueRef, TeamRef } from "../types";
import type { Repo } from "../db/repo";
import type { RawMarkets } from "../lib/odds";
import { median } from "../lib/odds";
import { utcDate } from "../lib/dates";

/**
 * The Odds API (the-odds-api.com), opcional: odds 1X2 de Pinnacle/Betfair (fonte principal).
 * Plano grátis: 500 créditos/mês; cada pedido (1 região, 1 mercado) custa 1 crédito. Guardamos no máximo
 * `ODDS_API_DAILY` pedidos por dia (~16 × 30 = 480). É a fonte principal de 1X2; a API-Football fica de reserva.
 */
const BASE = "https://api.the-odds-api.com/v4";
export const ODDS_PROVIDER = "the-odds-api";
export const ODDS_API_DAILY = 16;

/** id da liga na API-Football → chave do esporte na The Odds API. */
export const SPORT_KEYS: Record<number, string> = {
  1: "soccer_fifa_world_cup",
  2: "soccer_uefa_champs_league",
  3: "soccer_uefa_europa_league",
  848: "soccer_uefa_europa_conference_league",
  13: "soccer_conmebol_copa_libertadores",
  11: "soccer_conmebol_copa_sudamericana",
  39: "soccer_epl",
  40: "soccer_efl_champ",
  140: "soccer_spain_la_liga",
  135: "soccer_italy_serie_a",
  78: "soccer_germany_bundesliga",
  61: "soccer_france_ligue_one",
  94: "soccer_portugal_primeira_liga",
  88: "soccer_netherlands_eredivisie",
  71: "soccer_brazil_campeonato",
  72: "soccer_brazil_serie_b",
  128: "soccer_argentina_primera_division",
  73: "soccer_brazil_copa_do_brasil",
  5: "soccer_uefa_nations_league",
  10: "soccer_international_friendlies",
  9: "soccer_conmebol_copa_america",
  4: "soccer_uefa_european_championship",
  32: "soccer_fifa_world_cup_qualifiers_europe",
  34: "soccer_fifa_world_cup_qualifiers_south_america",
};

/**
 * Chave do esporte para a liga: primeiro a lista fixa; senão procura pelo nome da liga na lista de esportes da
 * The Odds API (`/v4/sports`, não gasta crédito), guardada no banco por um dia. Também corrige chaves fixas que
 * a API não tenha (só usa a fixa se ela estiver na lista).
 */
export async function sportKeyFor(env: Env, repo: Repo, league: LeagueRef): Promise<string | null> {
  const sports = await sportsList(env, repo);
  const fixed = SPORT_KEYS[league.id];
  if (fixed && (!sports.length || sports.some((x) => x.key === fixed))) return fixed;
  return matchSport(sports, league.name);
}

export function matchSport(sports: { key: string; title: string }[], leagueName: string): string | null {
  const n = normTeam(leagueName);
  if (!n) return null;
  const soccer = sports.filter((x) => x.key.startsWith("soccer_"));
  const hit = soccer.find((x) => normTeam(x.title) === n) ?? soccer.find((x) => normTeam(x.title).includes(n) || n.includes(normTeam(x.title)));
  return hit?.key ?? null;
}

async function sportsList(env: Env, repo: Repo): Promise<{ key: string; title: string }[]> {
  if (!env.ODDS_API_KEY) return [];
  const path = `fixtures_cache/oddsapi-sports-${utcDate()}`;
  const cached = await repo.db.get<{ sports: { key: string; title: string }[] }>(path);
  if (cached) return cached.data.sports;
  try {
    const res = await fetch(`${BASE}/sports?${new URLSearchParams({ apiKey: env.ODDS_API_KEY })}`);
    if (!res.ok) return [];
    const sports = ((await res.json()) as any[]).map((x) => ({ key: String(x.key), title: String(x.title) }));
    await repo.db.commit([{ op: "set", path, data: { sports } }]);
    return sports;
  } catch {
    return [];
  }
}

/** Nome simplificado para comparar times entre as duas APIs ("São Paulo FC" ≈ "Sao Paulo"). */
export function normTeam(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|ac|afc|cd|ec|se|cr|ca|club|clube|de|futebol|football|sport)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(a: string, b: string): boolean {
  const x = normTeam(a), y = normTeam(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** Acha o jogo na resposta (mesmos times, horário a até 2 h) e tira a odd 1X2 (Pinnacle/Betfair; senão mediana). */
export function parseTheOddsApi(events: any[], home: TeamRef, away: TeamRef, kickoff: Date): RawMarkets {
  const ev = (events ?? []).find(
    (e) => sameTeam(e.home_team, home.name) && sameTeam(e.away_team, away.name) && Math.abs(new Date(e.commence_time).getTime() - kickoff.getTime()) <= 2 * 3600_000,
  );
  if (!ev) return {};
  const books = (ev.bookmakers ?? [])
    .map((b: any) => {
      const mk = (b.markets ?? []).find((m: any) => m.key === "h2h");
      const sel: Record<string, number> = {};
      for (const o of mk?.outcomes ?? []) {
        const k = o.name === ev.home_team ? "1" : o.name === ev.away_team ? "2" : o.name === "Draw" ? "X" : null;
        if (k && o.price > 1) sel[k] = o.price;
      }
      return { key: String(b.key), name: String(b.title ?? b.key), sel };
    })
    .filter((b: any) => b.sel["1"] && b.sel.X && b.sel["2"]);
  if (!books.length) return {};
  for (const re of [/pinnacle/i, /betfair/i]) {
    const b = books.find((x: any) => re.test(x.key));
    if (b) return { "1X2": { source: b.name, raw: b.sel } };
  }
  const raw: Record<string, number> = {};
  for (const k of ["1", "X", "2"]) raw[k] = Math.round(median(books.map((b: any) => b.sel[k])) * 100) / 100;
  return { "1X2": { source: books.length === 1 ? books[0].name : `mediana de ${books.length} casas`, raw } };
}

export async function theOddsApi(env: Env, repo: Repo, m: { league: LeagueRef; home: TeamRef; away: TeamRef; kickoff_utc: Date }): Promise<RawMarkets> {
  if (!env.ODDS_API_KEY) return {};
  const sport = await sportKeyFor(env, repo, m.league);
  if (!sport) return {};
  const today = utcDate();
  if ((await repo.usage(today, ODDS_PROVIDER)) >= ODDS_API_DAILY) return {};
  await repo.addUsage(today, ODDS_PROVIDER);
  const from = new Date(m.kickoff_utc.getTime() - 2 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const to = new Date(m.kickoff_utc.getTime() + 2 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const qs = new URLSearchParams({ apiKey: env.ODDS_API_KEY, regions: "eu", markets: "h2h", oddsFormat: "decimal", commenceTimeFrom: from, commenceTimeTo: to });
  const res = await fetch(`${BASE}/sports/${sport}/odds?${qs}`);
  if (!res.ok) {
    console.error("The Odds API respondeu", res.status);
    return {};
  }
  return parseTheOddsApi(await res.json(), m.home, m.away, m.kickoff_utc);
}
