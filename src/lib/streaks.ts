import type { Pick1x2, StreakRow } from "../types";
import { outcomeOf } from "./scoring";

export interface StreakMatch {
  id: string;
  kickoff_utc: Date;
  home_goals: number | null;
  away_goals: number | null;
  voided: boolean;
}

/**
 * Acertos do vencedor (1X2) de cada participante na rodada, em ordem de jogo: "1" acertou, "0" errou.
 * - só entram jogos com resultado; jogo anulado não conta (nem quebra a sequência);
 * - não palpitar conta como erro;
 * - jogos anteriores à entrada da pessoa no bolão não contam.
 */
export function roundSequences(
  matches: StreakMatch[],
  preds: { user_id: string; match_id: string; pick_1x2: Pick1x2 }[],
  users: { id: string; created_at: Date }[],
): Record<string, string> {
  const settled = matches
    .filter((m) => !m.voided && m.home_goals !== null && m.away_goals !== null)
    .sort((a, b) => a.kickoff_utc.getTime() - b.kickoff_utc.getTime());
  const picks = new Map(preds.map((p) => [`${p.user_id}|${p.match_id}`, p.pick_1x2]));
  const out: Record<string, string> = {};
  for (const u of users) {
    let s = "";
    for (const m of settled) {
      if (m.kickoff_utc.getTime() < u.created_at.getTime()) continue;
      s += picks.get(`${u.id}|${m.id}`) === outcomeOf(m.home_goals!, m.away_goals!) ? "1" : "0";
    }
    if (s) out[u.id] = s;
  }
  return out;
}

/** Junta as rodadas em ordem de horário e calcula sequência atual e recorde de cada participante. */
export function streakRows(rounds: { start?: Date | null; seq?: Record<string, string> | null }[], nicknames: Map<string, string>): StreakRow[] {
  const ordered = [...rounds].sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const all = new Map<string, string>();
  for (const r of ordered) for (const [uid, s] of Object.entries(r.seq ?? {})) all.set(uid, (all.get(uid) ?? "") + s);
  const rows: StreakRow[] = [];
  for (const [user_id, s] of all) {
    const best = Math.max(0, ...s.split("0").map((x) => x.length));
    const current = s.length - s.replace(/1+$/, "").length;
    rows.push({ user_id, nickname: nicknames.get(user_id) ?? "?", current, best });
  }
  return rows.sort((a, b) => b.current - a.current || b.best - a.best || a.nickname.localeCompare(b.nickname, "pt-BR"));
}
