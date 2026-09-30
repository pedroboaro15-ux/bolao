import type { Match, Pick1x2, PickMode, PickOu, Round } from "../types";
import { badRequest } from "./errors";
import { ALL_EXTRAS, outcomeOf, type Extras } from "./scoring";

/** O palpite trava no início do jogo. A hora é sempre a do servidor. */
export function isLocked(kickoff: Date, now: Date): boolean {
  return now.getTime() >= kickoff.getTime();
}

export interface PredictionInput {
  match_id: string;
  pick_1x2: Pick1x2;
  mode: PickMode | null;
  pick_ou: PickOu | null;
  home_goals: number | null;
  away_goals: number | null;
  joker: boolean;
}

/** Placar precisa ser coerente com o vencedor escolhido. */
export function scoreMatchesWinner(pick: Pick1x2, home: number, away: number): boolean {
  return outcomeOf(home, away) === pick;
}

/** Diz se ainda dá para palpitar neste jogo. */
export function predictionBlockedReason(match: Pick<Match, "kickoff_utc" | "voided" | "status">, round: Pick<Round, "status">, now: Date): string | null {
  if (round.status !== "open") return "A rodada não está aberta para palpites";
  if (match.voided) return "Jogo anulado";
  if (isLocked(match.kickoff_utc, now)) return "O jogo já começou: palpite travado";
  return null;
}

const isGoal = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9;

/** Valida e normaliza o que veio do cliente (nunca confiar no front). `extras` diz o que o admin deixou ligado. */
export function parsePredictionInput(raw: any, extras: Extras = ALL_EXTRAS): PredictionInput {
  if (!raw || typeof raw !== "object") throw badRequest("Palpite inválido");
  const match_id = String(raw.match_id ?? "");
  if (!match_id) throw badRequest("Jogo não informado");
  const pick_1x2 = raw.pick_1x2 as Pick1x2;
  if (!["1", "X", "2"].includes(pick_1x2)) throw badRequest("Escolha quem ganha (casa, empate ou fora)");
  const joker = Boolean(raw.joker);
  // Gols OU placar exato: nunca os dois no mesmo palpite.
  const has = (v: unknown) => v !== undefined && v !== null;
  if (has(raw.pick_ou) && (has(raw.home_goals) || has(raw.away_goals))) throw badRequest("Escolha gols OU placar exato, não os dois");

  const mode: PickMode | null = raw.mode === "ou" || raw.mode === "cs" ? raw.mode : raw.mode == null || raw.mode === "none" ? null : (() => { throw badRequest("Extra inválido"); })();
  if (mode === null) return { match_id, pick_1x2, mode: null, pick_ou: null, home_goals: null, away_goals: null, joker };

  if (mode === "ou") {
    if (!extras.ou) throw badRequest("O extra de gols está desativado");
    if (raw.pick_ou !== "over" && raw.pick_ou !== "under") throw badRequest("Escolha mais ou menos de 2,5 gols");
    return { match_id, pick_1x2, mode, pick_ou: raw.pick_ou, home_goals: null, away_goals: null, joker };
  }
  if (!extras.cs) throw badRequest("O extra de placar exato está desativado");
  if (!isGoal(raw.home_goals) || !isGoal(raw.away_goals)) throw badRequest("Informe o placar (0 a 9 gols de cada lado)");
  if (!scoreMatchesWinner(pick_1x2, raw.home_goals, raw.away_goals)) {
    throw badRequest("O placar não combina com o vencedor escolhido");
  }
  return { match_id, pick_1x2, mode, pick_ou: null, home_goals: raw.home_goals, away_goals: raw.away_goals, joker };
}
