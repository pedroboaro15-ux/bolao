import type { OddsMap, Pick1x2, PickMode, PickOu } from "../types";
import { csFairOdd, round2 } from "./odds";
import type { Settings } from "./settings";

export interface PickLike {
  pick_1x2: Pick1x2;
  mode: PickMode | null;
  pick_ou: PickOu | null;
  home_goals: number | null;
  away_goals: number | null;
  joker: boolean;
}

export interface ScoreResult {
  points: number;
  /** Acertos que desempatam o ranking: vencedor e extra contam 1 cada; placar exato conta 1 (substitui o vencedor). */
  hits: number;
  parts: { winner: number; ou: number; cs: number };
}

/** Quais extras estão valendo. */
export interface Extras {
  ou: boolean;
  cs: boolean;
}
export const ALL_EXTRAS: Extras = { ou: true, cs: true };

/** O modo do palpite só vale se o extra correspondente estiver ligado; senão vale só o vencedor. */
export const activeMode = (mode: PickMode | null, extras: Extras): PickMode | null => (mode === "ou" && extras.ou ? "ou" : mode === "cs" && extras.cs ? "cs" : null);

export const outcomeOf = (home: number, away: number): Pick1x2 => (home > away ? "1" : home === away ? "X" : "2");
export const ouOf = (home: number, away: number): PickOu => (home + away > 2.5 ? "over" : "under");

/** Cada acerto vale o lucro da odd justa (odd − 1) vezes o multiplicador configurado. */
const profit = (odd: number | undefined | null, mult: number) => (odd && odd > 1 ? round2((odd - 1) * mult) : 0);

/**
 * Pontos de um palpite, com as odds congeladas no kickoff.
 * - sem extra (ou extra desligado): só o vencedor.
 * - modo "ou": acertou o vencedor → pts do vencedor; acertou o O/U → soma os pts do O/U.
 * - modo "cs": acertou o placar → SÓ os pts do placar; errou o placar mas acertou o vencedor → pts do vencedor.
 * - coringa: multiplica o total do jogo.
 */
export function scorePrediction(
  pick: PickLike,
  result: { home: number; away: number },
  odds: OddsMap | null | undefined,
  cfg: Pick<Settings, "winnerMultiplier" | "ouMultiplier" | "csMultiplier" | "jokerEnabled" | "jokerMultiplier" | "oddCap">,
  extras: Extras = ALL_EXTRAS,
): ScoreResult {
  const mode = activeMode(pick.mode, extras);
  const parts = { winner: 0, ou: 0, cs: 0 };
  let hits = 0;
  const winnerHit = pick.pick_1x2 === outcomeOf(result.home, result.away);

  if (mode === "cs") {
    const exact = pick.home_goals === result.home && pick.away_goals === result.away;
    if (exact) {
      parts.cs = profit(csFairOdd(odds, result.home, result.away, cfg.oddCap), cfg.csMultiplier);
      hits = 1;
    } else if (winnerHit) {
      parts.winner = profit(odds?.["1X2"]?.fair[pick.pick_1x2], cfg.winnerMultiplier);
      hits = 1;
    }
  } else {
    if (winnerHit) {
      parts.winner = profit(odds?.["1X2"]?.fair[pick.pick_1x2], cfg.winnerMultiplier);
      hits += 1;
    }
    if (mode === "ou" && pick.pick_ou && pick.pick_ou === ouOf(result.home, result.away)) {
      parts.ou = profit(odds?.OU25?.fair[pick.pick_ou], cfg.ouMultiplier);
      hits += 1;
    }
  }

  let points = round2(parts.winner + parts.ou + parts.cs);
  if (pick.joker && cfg.jokerEnabled) points = round2(points * cfg.jokerMultiplier);
  return { points, hits, parts };
}
