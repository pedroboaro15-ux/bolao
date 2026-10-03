import type { Repo, WithId } from "../db/repo";
import type { Match } from "../types";
import { takeSlot } from "../lib/ratelimit";
import { ApiFootball, QuotaError } from "./apifootball";
import { isSettled } from "./results";

/** No máximo uma atualização do placar ao vivo a cada 5 minutos por rodada, não importa quantas pessoas estejam olhando. */
export const LIVE_EVERY_MS = 5 * 60_000;
/** Depois disso o jogo já deveria ter acabado; quem fecha é o cron de resultados. */
export const LIVE_WINDOW_MIN = 170;
/** Cada jogo custa 1 chamada (o plano grátis não aceita `ids`): no máximo 4 por atualização. */
export const LIVE_MAX_MATCHES = 4;

/** Jogos que começaram, ainda não têm resultado oficial e estão dentro da janela de um jogo normal. */
export function liveCandidates(matches: Pick<Match, "kickoff_utc" | "voided" | "home_goals" | "away_goals">[], now: Date): number[] {
  const out: number[] = [];
  matches.forEach((m, i) => {
    const since = now.getTime() - m.kickoff_utc.getTime();
    if (!m.voided && !isSettled(m) && since >= 0 && since <= LIVE_WINDOW_MIN * 60_000) out.push(i);
  });
  return out;
}

/**
 * Atualiza o placar ao vivo de uma rodada: uma chamada à API-Football por jogo em andamento (até LIVE_MAX_MATCHES).
 * A "vaga" de 5 minutos é reservada no banco antes de chamar a API: se várias pessoas abrirem a tela ao mesmo tempo,
 * só uma chama. Se a chamada falhar, a vaga continua gasta (protege a cota da API). A reserva de chamadas para
 * os placares finais é respeitada. Devolve quantos jogos foram atualizados.
 */
export async function refreshLive(repo: Repo, api: ApiFootball, roundId: string, matches: WithId<Match>[], now = new Date()): Promise<number> {
  const idx = liveCandidates(matches, now);
  if (!idx.length) return 0;
  const slot = await takeSlot(repo.db, `live-${roundId}`, 1, LIVE_EVERY_MS, now);
  if (!slot.ok) return 0;
  const targets = idx.slice(0, LIVE_MAX_MATCHES).map((i) => matches[i]);
  try {
    const fixtures = await api.fixturesByIds(targets.map((m) => m.api_fixture_id), { keepReserve: true });
    const byFixture = new Map(fixtures.map((f) => [f.id, f]));
    const writes = [];
    for (const m of targets) {
      const f = byFixture.get(m.api_fixture_id);
      if (!f) continue;
      writes.push({ op: "merge" as const, path: `matches/${m.id}`, data: { status: f.status, live: { home: f.home_goals, away: f.away_goals, status: f.status, elapsed: f.elapsed, at: now } } });
    }
    if (writes.length) await repo.db.commit(writes);
    return writes.length;
  } catch (e: any) {
    if (!(e instanceof QuotaError)) console.error("placar ao vivo falhou:", e?.message);
    return 0;
  }
}
