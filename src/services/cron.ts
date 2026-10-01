import type { Env, Match } from "../types";
import type { Repo, WithId } from "../db/repo";
import { bolaoDay } from "../lib/dates";
import { ApiFootball, CALLED_OFF, FINISHED, QuotaError } from "./apifootball";
import { closeStartedRounds, freezeStarted, loadFixtures, refreshOddsBatch } from "./rounds";
import { isSettled, recalcRound } from "./results";
import { pushConfigured, sendPush } from "./push";

const MATCH_DURATION_MIN = 105; // 90' + acréscimos + intervalo: só depois disso vale perguntar o placar
const GIVE_UP_HOURS = 36;
// Workers grátis: 10 ms de CPU por execução. Cada jogo de odds custa alguns ms, então só um por vez (o cron de 15 min ajuda).
const ODDS_PER_RUN = 1;

async function activeRounds(repo: Repo) {
  const [open, closed] = await Promise.all([repo.roundsByStatus("open"), repo.roundsByStatus("closed")]);
  return [...open, ...closed];
}

/** 0 9 * * *  (06:00 em São Paulo, quando um novo dia do bolão começa) — busca os jogos do dia, das 06:00 às 06:00. */
export async function runDaily(env: Env, repo: Repo) {
  const settings = await repo.settings();
  const api = new ApiFootball(env, repo, settings);
  const day = bolaoDay();
  try {
    const r = await loadFixtures(repo, api, settings, day, true);
    console.log(`jogos do dia ${day}: ${r.total}`);
  } catch (e: any) {
    console.error(`falha ao buscar jogos de ${day}:`, e?.message);
  }
}

/** 0 * * * *  — atualiza odds dos jogos selecionados, congela as de quem começou, fecha rodadas. */
export async function runHourly(env: Env, repo: Repo) {
  const settings = await repo.settings();
  const api = new ApiFootball(env, repo, settings);
  const now = new Date();
  const rounds = await activeRounds(repo);
  const all: WithId<Match>[] = [];
  for (const r of rounds) all.push(...(await repo.matchesOfRound(r.id)));

  const frozen = await freezeStarted(repo, all, settings, now);
  await closeStartedRounds(repo, rounds, now);

  const openIds = new Set(rounds.filter((r) => r.status === "open").map((r) => r.id));
  const upcoming = all.filter((m) => openIds.has(m.round_id));
  const odds = await refreshOddsBatch(repo, api, settings, upcoming, ODDS_PER_RUN, now);
  console.log(`hourly: congelados=${frozen} odds=${JSON.stringify(odds)}`);
}

/** *\/15 * * * *  — placares, pontos, ranking, fechamento e lembretes. */
export async function runFrequent(env: Env, repo: Repo) {
  const settings = await repo.settings();
  const api = new ApiFootball(env, repo, settings);
  const now = new Date();
  const rounds = await activeRounds(repo);

  const byRound = new Map<string, WithId<Match>[]>();
  for (const r of rounds) byRound.set(r.id, await repo.matchesOfRound(r.id));
  await freezeStarted(repo, [...byRound.values()].flat(), settings, now);
  await closeStartedRounds(repo, rounds, now);

  // 1) placares
  const due = [...byRound.values()].flat().filter(
    (m) =>
      !isSettled(m) &&
      !m.manual_override &&
      m.kickoff_utc.getTime() + MATCH_DURATION_MIN * 60_000 <= now.getTime() &&
      m.kickoff_utc.getTime() >= now.getTime() - GIVE_UP_HOURS * 3600_000,
  );
  const touched = new Set<string>();
  for (let i = 0; i < due.length; i += 20) {
    const chunk = due.slice(i, i + 20);
    try {
      const fixtures = await api.fixturesByIds(chunk.map((m) => m.api_fixture_id));
      const byFixture = new Map(fixtures.map((f) => [f.id, f]));
      for (const m of chunk) {
        const f = byFixture.get(m.api_fixture_id);
        if (!f) continue;
        const data: Record<string, any> = { status: f.status };
        if (FINISHED.has(f.status) && f.home_goals !== null && f.away_goals !== null) {
          data.home_goals = f.home_goals;
          data.away_goals = f.away_goals;
          touched.add(m.round_id);
        }
        if (data.status !== m.status || data.home_goals !== undefined) {
          await repo.db.commit([{ op: "merge", path: `matches/${m.id}`, data }]);
        }
        if (CALLED_OFF.has(f.status)) console.log(`jogo ${m.id} ${f.status}: o admin precisa anular`);
      }
    } catch (e: any) {
      console.error("placares falhou:", e?.message);
      if (e instanceof QuotaError) break;
    }
  }

  // 2) pontos e ranking
  for (const roundId of touched) {
    const res = await recalcRound(repo, roundId, settings);
    if (res?.finished) await notifyFinished(env, repo, roundId);
  }

  // 3) lembrete: 30 min antes do 1º jogo, para quem ainda não palpitou
  await sendReminders(env, repo, rounds, byRound, now);

  // 4) odds de um jogo por execução (primeira busca ou foto perto do jogo)
  const openIds = new Set(rounds.filter((r) => r.status === "open").map((r) => r.id));
  const upcoming = [...byRound.entries()].filter(([id]) => openIds.has(id)).flatMap(([, ms]) => ms);
  await refreshOddsBatch(repo, api, settings, upcoming, ODDS_PER_RUN, now).catch((e) => console.error("odds falhou:", e?.message));
}

export async function notifyFinished(env: Env, repo: Repo, roundId: string) {
  const round = await repo.round(roundId);
  if (!round || round.finished_notified) return;
  await repo.db.commit([{ op: "merge", path: `rounds/${roundId}`, data: { finished_notified: true } }]);
  if (!pushConfigured(env)) return;
  const st = await repo.standings(`round_${roundId}`);
  const rows = st?.rows ?? [];
  await sendPush(env, repo, rows.map((r) => r.user_id), (uid) => {
    const pos = rows.findIndex((r) => r.user_id === uid) + 1;
    const me = rows[pos - 1];
    if (!me) return null;
    return { title: `Rodada encerrada: ${round.title}`, body: `Você ficou em ${pos}º lugar com ${me.points.toFixed(2)} pts.`, url: "/ranking" };
  });
}

async function sendReminders(env: Env, repo: Repo, rounds: WithId<{ status: string; title: string; reminder_sent?: boolean }>[], byRound: Map<string, WithId<Match>[]>, now: Date) {
  for (const r of rounds) {
    if (r.status !== "open" || r.reminder_sent) continue;
    const upcoming = (byRound.get(r.id) ?? []).filter((m) => !m.voided);
    if (!upcoming.length) continue;
    const first = Math.min(...upcoming.map((m) => m.kickoff_utc.getTime()));
    const minutes = Math.round((first - now.getTime()) / 60_000);
    if (minutes > 30) continue;
    await repo.db.commit([{ op: "merge", path: `rounds/${r.id}`, data: { reminder_sent: true } }]);
    if (minutes <= 0 || !pushConfigured(env)) continue;
    const [users, preds] = await Promise.all([repo.users(), repo.predictionsOfRound(r.id)]);
    const done = new Set(preds.map((p) => p.user_id));
    const missing = users.filter((u) => !done.has(u.id)).map((u) => u.id);
    if (missing.length) {
      await sendPush(env, repo, missing, { title: "Falta pouco!", body: `O primeiro jogo de "${r.title}" começa em ${minutes} min e você ainda não palpitou.`, url: "/" });
    }
  }
}
