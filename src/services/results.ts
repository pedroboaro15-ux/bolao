import type { Match, Prediction, Round } from "../types";
import type { Repo, WithId } from "../db/repo";
import type { Write } from "../db/types";
import type { Settings } from "../lib/settings";
import { scorePrediction } from "../lib/scoring";
import { rebuildStandings } from "./standings";

/** Jogo já tem desfecho: resultado lançado ou anulado. */
export const isSettled = (m: Pick<Match, "voided" | "home_goals" | "away_goals">) => m.voided || (m.home_goals !== null && m.away_goals !== null);

export function roundIsFinished(matches: Pick<Match, "voided" | "home_goals" | "away_goals">[]): boolean {
  return matches.length > 0 && matches.every(isSettled);
}

/** Pontos de um palpite dado o estado do jogo. Anulado → 0; sem resultado → null. */
export function pointsFor(pred: Prediction, match: Match, settings: Settings) {
  if (match.voided) return { points: 0, hits: 0, parts: { winner: 0, ou: 0, cs: 0 } };
  if (match.home_goals === null || match.away_goals === null) return null;
  // Odds congeladas no kickoff; se o cron ainda não congelou, vale o último valor conhecido.
  // Extras que valiam quando o jogo começou (o admin pode ligar/desligar a qualquer momento).
  const extras = match.extras_frozen ?? { ou: settings.goalsEnabled, cs: settings.scoreEnabled };
  return scorePrediction(pred, { home: match.home_goals, away: match.away_goals }, match.frozen_odds ?? match.odds, settings, extras);
}

/**
 * Recalcula os pontos de todos os palpites da rodada, regrava só o que mudou,
 * atualiza o ranking e fecha a rodada quando todos os jogos têm desfecho.
 */
export async function recalcRound(repo: Repo, roundId: string, settings: Settings): Promise<{ round: WithId<Round>; finished: boolean; changed: number } | null> {
  const round = await repo.round(roundId);
  if (!round) return null;
  const [matches, predictions] = await Promise.all([repo.matchesOfRound(roundId), repo.predictionsOfRound(roundId)]);
  const byId = new Map(matches.map((m) => [m.id, m]));

  const writes: Write[] = [];
  const final: Pick<Prediction, "user_id" | "points" | "hits" | "match_id" | "parts" | "pick_1x2">[] = [];
  for (const p of predictions) {
    const m = byId.get(p.match_id);
    const r = m ? pointsFor(p, m, settings) : null;
    const points = r ? r.points : null;
    const hits = r ? r.hits : null;
    final.push({ user_id: p.user_id, match_id: p.match_id, pick_1x2: p.pick_1x2, points, hits, parts: r?.parts ?? null });
    if (points !== p.points || hits !== p.hits) {
      writes.push({ op: "merge", path: `predictions/${p.id}`, data: { points, hits, parts: r?.parts ?? null } });
    }
  }
  for (let i = 0; i < writes.length; i += 400) await repo.db.commit(writes.slice(i, i + 400));

  await rebuildStandings(repo, roundId, round.date, final, byId);

  const finished = roundIsFinished(matches);
  let status = round.status;
  if (finished && status !== "finished") status = "finished";
  else if (!finished && status === "finished") status = "closed";
  if (status !== round.status) await repo.db.commit([{ op: "merge", path: `rounds/${roundId}`, data: { status } }]);
  return { round: { ...round, status }, finished, changed: writes.length };
}
