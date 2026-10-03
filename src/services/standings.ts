import type { Pick1x2, Prediction, StandingRow, Standings } from "../types";
import { roundSequences, streakRows, type StreakMatch } from "../lib/streaks";
import { bestZebra, maxZebra, type ZebraMatch, type ZebraPrediction } from "../lib/zebra";
import type { Repo } from "../db/repo";
import { round2 } from "../lib/odds";

export function sortRows(rows: StandingRow[]): StandingRow[] {
  // Desempate: mais acertos; depois ordem alfabética para ficar estável.
  return [...rows].sort((a, b) => b.points - a.points || b.hits - a.hits || a.nickname.localeCompare(b.nickname, "pt-BR"));
}

/** Soma pontos e acertos por participante (uma linha por usuário). */
export function sumRows(lists: StandingRow[][]): StandingRow[] {
  const acc = new Map<string, StandingRow>();
  for (const rows of lists) {
    for (const r of rows) {
      const cur = acc.get(r.user_id);
      if (cur) {
        cur.points = round2(cur.points + r.points);
        cur.hits += r.hits;
        cur.nickname = r.nickname;
      } else acc.set(r.user_id, { ...r });
    }
  }
  return sortRows([...acc.values()]);
}

/** Ranking de uma rodada a partir dos palpites já pontuados. */
export function roundRows(predictions: Pick<Prediction, "user_id" | "points" | "hits">[], nicknames: Map<string, string>): StandingRow[] {
  const acc = new Map<string, StandingRow>();
  for (const p of predictions) {
    if (p.points === null) continue; // jogo ainda sem resultado
    const cur = acc.get(p.user_id) ?? { user_id: p.user_id, nickname: nicknames.get(p.user_id) ?? "?", points: 0, hits: 0 };
    cur.points = round2(cur.points + p.points);
    cur.hits += p.hits ?? 0;
    acc.set(p.user_id, cur);
  }
  return sortRows([...acc.values()]);
}

/** Jogo com o que os rankings precisam (zebra e sequência). */
export type StandMatch = ZebraMatch & StreakMatch;

/** Reescreve os rankings da rodada, do mês e o geral (o mês e o geral somam os documentos de rodada). */
export async function rebuildStandings(
  repo: Repo,
  roundId: string,
  roundDate: string,
  predictions: (Pick<Prediction, "user_id" | "points" | "hits"> & Partial<ZebraPrediction> & { pick_1x2?: Pick1x2 })[],
  matches: Map<string, StandMatch> = new Map(),
): Promise<void> {
  const users = await repo.users();
  const nick = new Map(users.map((u) => [u.id, u.nickname]));
  const month = roundDate.slice(0, 7);
  const now = new Date();
  const rows = roundRows(predictions, nick);
  const withMatch = predictions.filter((p) => !!p.match_id) as ZebraPrediction[];
  const zebra = bestZebra(withMatch, matches, nick);
  const roundMatches = [...matches.values()];
  const seq = roundSequences(
    roundMatches,
    predictions.filter((p) => p.match_id && p.pick_1x2).map((p) => ({ user_id: p.user_id, match_id: p.match_id!, pick_1x2: p.pick_1x2! })),
    users,
  );
  const start = roundMatches.length ? new Date(Math.min(...roundMatches.map((m) => m.kickoff_utc.getTime()))) : now;
  await repo.db.commit([
    { op: "set", path: `standings/round_${roundId}`, data: { scope: "round", month, rows, zebra, seq, start, streaks: streakRows([{ start, seq }], nick), updated_at: now } satisfies Standings },
  ]);

  await rebuildTotals(repo, month, nick, now);
}

/** Ranking do mês e geral: somam todos os documentos de scope "round" (rodadas de jogos e perguntas do dia). */
export async function rebuildTotals(repo: Repo, month: string, nick: Map<string, string>, now = new Date()): Promise<void> {
  const monthRounds = await repo.roundStandings(month);
  const allRounds = await repo.roundStandings();
  await repo.db.commit([
    {
      op: "set",
      path: `standings/month_${month}`,
      data: { scope: "month", rows: sumRows(monthRounds.map((r) => r.rows)), zebra: maxZebra(monthRounds.map((r) => r.zebra)), streaks: streakRows(monthRounds, nick), updated_at: now } satisfies Standings,
    },
    {
      op: "set",
      path: "standings/all",
      data: { scope: "all", rows: sumRows(allRounds.map((r) => r.rows)), zebra: maxZebra(allRounds.map((r) => r.zebra)), streaks: streakRows(allRounds, nick), updated_at: now } satisfies Standings,
    },
  ]);
}
