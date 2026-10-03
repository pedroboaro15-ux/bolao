import { MemoryDb } from "./db/memory";
import { Repo } from "./db/repo";
import { DevAuth } from "./auth/provider";
import { buildOdds } from "./lib/odds";
import { relevanceScore } from "./lib/relevance";
import { mergeSettings } from "./lib/settings";
import { recalcRound } from "./services/results";
import { addDays, bolaoDay, bolaoWindow } from "./lib/dates";
import type { Match, OddsMap, Prediction, Round, UserDoc } from "./types";

/** Modo demonstração: dados de mentira em memória para testar o site sem Supabase. */
let demo: Promise<{ repo: Repo; auth: DevAuth }> | null = null;

export function getDemo() {
  demo ??= seed();
  return demo;
}

const H = 3600_000;

async function seed() {
  const db = new MemoryDb();
  const repo = new Repo(db);
  const auth = new DevAuth();
  const now = Date.now();
  const created = new Date(now - 40 * 24 * H);

  const people: [string, string, string, "admin" | "player"][] = [
    ["admin", "Chefe", "admin@demo.local", "admin"],
    ["lucas", "Luquinha", "lucas@demo.local", "player"],
    ["ana", "Aninha", "ana@demo.local", "player"],
    ["carlos", "Carlão", "carlos@demo.local", "player"],
    ["bia", "Bia", "bia@demo.local", "player"],
  ];
  for (const [uid, nickname, email, role] of people) {
    auth.seed(email, "demo1234", nickname, uid);
    const u: UserDoc = { name: nickname, nickname, email, role, created_at: created };
    await db.commit([{ op: "set", path: `users/${uid}`, data: u as any }]);
  }

  const settings = mergeSettings(null);
  const T = (id: number, name: string) => ({ id, name });
  const odds = (h: number, x: number, a: number, over: number, under: number): OddsMap =>
    buildOdds({ "1X2": { source: "Pinnacle", raw: { "1": h, X: x, "2": a } }, OU25: { source: "Pinnacle", raw: { over, under } } }, new Date(now - 2 * H), settings.oddCap)!;

  const mk = (fixture: number, roundId: string, league: [number, string, string], home: string, away: string, kickoffH: number, o: OddsMap | null, result?: [number, number]): [string, Match] => {
    const kickoff = new Date(now + kickoffH * H);
    return [
      String(fixture),
      {
        round_id: roundId,
        api_fixture_id: fixture,
        league: { id: league[0], name: league[1], country: league[2] },
        home: T(fixture * 10 + 1, home),
        away: T(fixture * 10 + 2, away),
        kickoff_utc: kickoff,
        status: result ? "FT" : kickoffH < 0 ? "2H" : "NS",
        home_goals: result?.[0] ?? null,
        away_goals: result?.[1] ?? null,
        manual_override: false,
        voided: false,
        relevance: 90,
        odds: o,
        frozen_odds: kickoffH < 0 ? o : null,
      },
    ];
  };

  const today = bolaoDay();
  const yesterday = addDays(today, -1);

  // Rodada de ontem, encerrada (para o ranking ter história)
  const oldMatches = [
    mk(900101, yesterday, [71, "Série A", "Brazil"], "Palmeiras", "Fluminense", -30, odds(1.9, 3.3, 4.2, 2.05, 1.8), [2, 0]),
    mk(900102, yesterday, [71, "Série A", "Brazil"], "Flamengo", "Grêmio", -29, odds(1.75, 3.6, 4.8, 1.95, 1.9), [1, 1]),
    mk(900103, yesterday, [39, "Premier League", "England"], "Arsenal", "Tottenham", -28, odds(1.8, 3.9, 4.4, 1.7, 2.15), [3, 1]),
    mk(900104, yesterday, [140, "La Liga", "Spain"], "Real Madrid", "Sevilla", -27, odds(1.4, 5, 8, 1.65, 2.2), [2, 1]),
    mk(900105, yesterday, [135, "Serie A", "Italy"], "Napoli", "Roma", -26, odds(2.2, 3.2, 3.4, 2.1, 1.75), [0, 1]),
  ];
  const oldRound: Round = { title: "Rodada de ontem", date: yesterday, status: "closed", created_at: new Date(now - 34 * H), match_ids: oldMatches.map(([id]) => id) };
  await db.commit([
    { op: "set", path: `rounds/${yesterday}`, data: oldRound as any },
    ...oldMatches.map(([id, m]) => ({ op: "set" as const, path: `matches/${id}`, data: m as any })),
  ]);

  // Rodada de hoje: 1 encerrado, 1 rolando, 4 por vir
  const todayMatches = [
    mk(900201, today, [2, "UEFA Champions League", "World"], "Manchester City", "Inter", -3.2, odds(1.6, 4.2, 5.5, 1.75, 2.1), [2, 1]),
    mk(900202, today, [13, "CONMEBOL Libertadores", "World"], "Boca Juniors", "River Plate", -0.5, odds(2.6, 3, 2.9, 2.3, 1.62)),
    mk(900203, today, [71, "Série A", "Brazil"], "Corinthians", "São Paulo", 1.2, odds(2.5, 3.05, 3.0, 2.2, 1.68)),
    mk(900204, today, [71, "Série A", "Brazil"], "Botafogo", "Bahia", 2.4, odds(1.95, 3.3, 4.0, 2.05, 1.8)),
    mk(900205, today, [2, "UEFA Champions League", "World"], "Barcelona", "Bayern Munich", 4, odds(2.35, 3.6, 2.8, 1.55, 2.4)),
    mk(900206, today, [61, "Ligue 1", "France"], "Paris Saint Germain", "Lyon", 6, odds(1.55, 4.3, 5.6, 1.6, 2.3)),
  ];
  const todayRound: Round = { title: "Rodada de hoje", date: today, status: "open", created_at: new Date(now - 5 * H), match_ids: todayMatches.map(([id]) => id) };
  await db.commit([
    { op: "set", path: `rounds/${today}`, data: todayRound as any },
    ...todayMatches.map(([id, m]) => ({ op: "set" as const, path: `matches/${id}`, data: m as any })),
  ]);

  // Placar ao vivo do jogo que está rolando (no modo demo não há API para atualizar)
  await db.commit([{ op: "merge", path: "matches/900202", data: { live: { home: 1, away: 0, status: "2H", elapsed: 63, at: new Date(now) } } }]);

  // Palpites
  const pred = (user: string, matchId: string, roundId: string, p: Partial<Prediction>): Prediction => ({
    user_id: user,
    match_id: matchId,
    round_id: roundId,
    pick_1x2: "1",
    mode: "ou",
    pick_ou: "over",
    home_goals: null,
    away_goals: null,
    joker: false,
    points: null,
    hits: null,
    created_at: new Date(now - 30 * H),
    updated_at: new Date(now - 30 * H),
    ...p,
  });
  const cs = (h: number, a: number): Partial<Prediction> => ({ mode: "cs", pick_ou: null, home_goals: h, away_goals: a });
  const list: Prediction[] = [
    pred("lucas", "900101", yesterday, { pick_1x2: "1" }),
    pred("lucas", "900102", yesterday, { pick_1x2: "X", pick_ou: "under" }),
    pred("lucas", "900103", yesterday, { pick_1x2: "1", ...cs(3, 1) }),
    pred("lucas", "900104", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("lucas", "900105", yesterday, { pick_1x2: "2", pick_ou: "under" }),
    pred("ana", "900101", yesterday, { pick_1x2: "1", ...cs(2, 0) }),
    pred("ana", "900102", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("ana", "900103", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("ana", "900104", yesterday, { pick_1x2: "1", pick_ou: "under" }),
    pred("ana", "900105", yesterday, { pick_1x2: "1", pick_ou: "under" }),
    pred("carlos", "900101", yesterday, { pick_1x2: "2", pick_ou: "under" }),
    pred("carlos", "900102", yesterday, { pick_1x2: "X", ...cs(1, 1) }),
    pred("carlos", "900103", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("carlos", "900104", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("carlos", "900105", yesterday, { pick_1x2: "2", pick_ou: "under" }),
    pred("bia", "900101", yesterday, { pick_1x2: "1", pick_ou: "under" }),
    pred("bia", "900103", yesterday, { pick_1x2: "1", pick_ou: "over" }),
    pred("bia", "900105", yesterday, { pick_1x2: "2", pick_ou: "over" }),
    // hoje
    pred("lucas", "900201", today, { pick_1x2: "1", pick_ou: "over" }),
    pred("ana", "900201", today, { pick_1x2: "1", ...cs(2, 1) }),
    pred("carlos", "900201", today, { pick_1x2: "X", pick_ou: "under" }),
    pred("lucas", "900202", today, { pick_1x2: "X", pick_ou: "under" }),
    pred("ana", "900202", today, { pick_1x2: "2", pick_ou: "under" }),
    pred("carlos", "900202", today, { pick_1x2: "1", pick_ou: "under" }),
    pred("lucas", "900203", today, { pick_1x2: "1", pick_ou: "under" }),
  ];
  await db.commit(list.map((p) => ({ op: "set" as const, path: `predictions/${p.match_id}_${p.user_id}`, data: p as any })));

  // Jogos "buscados" para testar o fluxo do admin sem API-Football (dia do bolão: 06:00 → 06:00).
  const tomorrow = addDays(today, 1);
  const winToday = bolaoWindow(today);
  const winTomorrow = bolaoWindow(tomorrow);
  const teams: [[number, string, string], string, string][] = [
    [[2, "UEFA Champions League", "World"], "Real Madrid", "Juventus"],
    [[2, "UEFA Champions League", "World"], "Liverpool", "Benfica"],
    [[71, "Série A", "Brazil"], "Flamengo", "Palmeiras"],
    [[71, "Série A", "Brazil"], "Cruzeiro", "Vasco da Gama"],
    [[71, "Série A", "Brazil"], "Sport", "Fortaleza"],
    [[39, "Premier League", "England"], "Chelsea", "Manchester United"],
    [[39, "Premier League", "England"], "Brighton", "Fulham"],
    [[140, "La Liga", "Spain"], "Atletico Madrid", "Barcelona"],
    [[135, "Serie A", "Italy"], "AC Milan", "Napoli"],
    [[78, "Bundesliga", "Germany"], "Borussia Dortmund", "Bayern Munich"],
    [[253, "Major League Soccer", "USA"], "Inter Miami", "LA Galaxy"],
    [[13, "CONMEBOL Libertadores", "World"], "River Plate", "Gremio"],
  ];
  const fixtureSet = (baseId: number, kickoffAt: (k: number) => Date) =>
    teams
      .map(([league, home, away], k) => {
        const id = baseId + k;
        const f = { id, kickoff: kickoffAt(k), status: "NS", league: { id: league[0], name: league[1], country: league[2] }, home: T(id * 10 + 1, home), away: T(id * 10 + 2, away) };
        return { ...f, relevance: relevanceScore(f, settings) };
      })
      .sort((x, y) => y.relevance - x.relevance);
  const setToday = fixtureSet(910001, (k) => new Date(Math.min(now + (1 + k * 0.8) * H, winToday.end.getTime() - H)));
  const setTomorrow = fixtureSet(920001, (k) => new Date(winTomorrow.start.getTime() + (3 + k) * H));
  const cacheDoc = (date: string, fixtures: typeof setToday) => ({ op: "set" as const, path: `fixtures_cache/${date}`, data: { date, fetched_at: new Date(now - H), total: fixtures.length, fixtures } });
  await db.commit([cacheDoc(today, setToday), cacheDoc(tomorrow, setTomorrow), cacheDoc(addDays(tomorrow, 1), [])]);

  await recalcRound(repo, yesterday, settings);
  await recalcRound(repo, today, settings);
  await db.commit([{ op: "merge", path: `rounds/${yesterday}`, data: { status: "finished" } }]);
  return { repo, auth };
}
