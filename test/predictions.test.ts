import { describe, expect, it } from "vitest";
import { isLocked, parsePredictionInput, predictionBlockedReason, scoreMatchesWinner } from "../src/lib/predictions";
import { HttpError } from "../src/lib/errors";

const kickoff = new Date("2026-09-29T20:00:00Z");
const match = { kickoff_utc: kickoff, voided: false, status: "NS" };

describe("trava no kickoff", () => {
  it("libera antes e trava exatamente no horário do jogo", () => {
    expect(isLocked(kickoff, new Date("2026-09-29T19:59:59.999Z"))).toBe(false);
    expect(isLocked(kickoff, new Date("2026-09-29T20:00:00.000Z"))).toBe(true);
    expect(isLocked(kickoff, new Date("2026-09-29T22:00:00Z"))).toBe(true);
  });

  it("bloqueia por rodada fechada, jogo anulado ou jogo começado", () => {
    const before = new Date("2026-09-29T19:00:00Z");
    expect(predictionBlockedReason(match, { status: "open" }, before)).toBeNull();
    expect(predictionBlockedReason(match, { status: "closed" }, before)).toMatch(/rodada/i);
    expect(predictionBlockedReason({ ...match, voided: true }, { status: "open" }, before)).toMatch(/anulado/i);
    expect(predictionBlockedReason(match, { status: "open" }, new Date("2026-09-29T20:00:01Z"))).toMatch(/travado/i);
  });
});

describe("validação do palpite", () => {
  const ok = { match_id: "1", pick_1x2: "1", mode: "ou", pick_ou: "over" };

  it("aceita modo gols", () => {
    expect(parsePredictionInput(ok)).toMatchObject({ mode: "ou", pick_ou: "over", home_goals: null });
  });

  it("aceita placar coerente com o vencedor", () => {
    expect(parsePredictionInput({ ...ok, pick_ou: undefined, mode: "cs", home_goals: 2, away_goals: 1 })).toMatchObject({ home_goals: 2, away_goals: 1, pick_ou: null });
    expect(parsePredictionInput({ ...ok, pick_ou: undefined, pick_1x2: "X", mode: "cs", home_goals: 1, away_goals: 1 })).toBeTruthy();
    expect(parsePredictionInput({ ...ok, pick_ou: undefined, pick_1x2: "2", mode: "cs", home_goals: 0, away_goals: 1 })).toBeTruthy();
  });

  it("recusa placar incoerente com o vencedor", () => {
    expect(() => parsePredictionInput({ ...ok, pick_ou: undefined, mode: "cs", home_goals: 0, away_goals: 2 })).toThrow(HttpError);
    expect(() => parsePredictionInput({ ...ok, pick_ou: undefined, pick_1x2: "X", mode: "cs", home_goals: 2, away_goals: 1 })).toThrow(/combina/);
  });

  it("recusa entradas inválidas", () => {
    expect(() => parsePredictionInput({ ...ok, pick_1x2: "3" })).toThrow();
    expect(() => parsePredictionInput({ ...ok, mode: "x" })).toThrow();
    expect(() => parsePredictionInput({ ...ok, pick_ou: undefined })).toThrow();
    expect(() => parsePredictionInput({ ...ok, pick_ou: undefined, mode: "cs", home_goals: -1, away_goals: 0 })).toThrow();
    expect(() => parsePredictionInput({ ...ok, pick_ou: undefined, mode: "cs", home_goals: 1.5, away_goals: 0 })).toThrow();
    expect(() => parsePredictionInput({ ...ok, match_id: "" })).toThrow();
    expect(() => parsePredictionInput(null)).toThrow();
  });

  it("scoreMatchesWinner", () => {
    expect(scoreMatchesWinner("1", 1, 0)).toBe(true);
    expect(scoreMatchesWinner("1", 0, 0)).toBe(false);
  });
});
