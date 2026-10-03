import { describe, expect, it } from "vitest";
import { scorePrediction, type PickLike } from "../src/lib/scoring";
import type { OddsMap } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

const now = new Date();
const odds: OddsMap = {
  "1X2": { source: "t", fetched_at: now, raw: {}, fair: { "1": 1.82, X: 3.6, "2": 4.5 } },
  OU25: { source: "t", fetched_at: now, raw: {}, fair: { over: 1.95, under: 2.05 } },
  CS: { source: "t", fetched_at: now, raw: {}, fair: { "2-1": 9.5, "1-0": 6 } },
};
const base: PickLike = { pick_1x2: "1", mode: "ou", pick_ou: "over", home_goals: null, away_goals: null, joker: false };
const cfg = DEFAULT_SETTINGS;

describe("pontuação", () => {
  it("modo gols: acertou vencedor e O/U soma os dois lucros", () => {
    const r = scorePrediction(base, { home: 2, away: 1 }, odds, cfg);
    expect(r.points).toBe(1.77); // 0.82 + 0.95
    expect(r.hits).toBe(2);
  });

  it("o exemplo do spec: @1.82 vale +0.82", () => {
    const r = scorePrediction({ ...base, pick_ou: "under" }, { home: 2, away: 1 }, odds, cfg);
    expect(r.points).toBe(0.82);
    expect(r.hits).toBe(1);
  });

  it("modo gols: errou tudo", () => {
    const r = scorePrediction(base, { home: 0, away: 1 }, odds, cfg);
    expect(r).toMatchObject({ points: 0, hits: 0 });
  });

  it("modo placar: exato vale só o placar (não soma o vencedor)", () => {
    const pick: PickLike = { ...base, mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1 };
    const r = scorePrediction(pick, { home: 2, away: 1 }, odds, cfg);
    expect(r.points).toBe(8.5);
    expect(r.parts.winner).toBe(0);
    expect(r.hits).toBe(1);
  });

  it("modo placar: errou o placar mas acertou o vencedor → pts do vencedor", () => {
    const pick: PickLike = { ...base, mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1 };
    const r = scorePrediction(pick, { home: 1, away: 0 }, odds, cfg);
    expect(r.points).toBe(0.82);
  });

  it("modo placar: errou tudo", () => {
    const pick: PickLike = { ...base, mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1 };
    expect(scorePrediction(pick, { home: 0, away: 0 }, odds, cfg).points).toBe(0);
  });

  it("coringa foi excluído: um palpite antigo marcado como coringa vale o normal", () => {
    const r = scorePrediction({ ...base, joker: true }, { home: 2, away: 1 }, odds, cfg);
    expect(r.points).toBe(1.77);
  });

  it("multiplicadores configuráveis", () => {
    const r = scorePrediction(base, { home: 2, away: 1 }, odds, { ...cfg, winnerMultiplier: 2 });
    expect(r.points).toBe(2.59); // 0.82×2 + 0.95
  });

  it("empate com menos de 2,5 gols acerta vencedor e under", () => {
    const r = scorePrediction({ ...base, pick_1x2: "X", pick_ou: "under" }, { home: 1, away: 1 }, odds, cfg);
    expect(r.points).toBe(3.65); // 2.6 + 1.05
    expect(r.hits).toBe(2);
  });

  it("exatamente 3 gols é over", () => {
    const r = scorePrediction({ ...base, pick_1x2: "2", pick_ou: "over" }, { home: 1, away: 2 }, odds, cfg);
    expect(r.parts.ou).toBe(0.95);
  });

  it("sem odd congelada não inventa pontos", () => {
    expect(scorePrediction(base, { home: 2, away: 1 }, null, cfg).points).toBe(0);
  });

  it("placar fora do mercado usa o modelo", () => {
    const withModel: OddsMap = { ...odds, CS: undefined, model: { lh: 1.5, la: 1.1 } };
    const pick: PickLike = { ...base, mode: "cs", pick_ou: null, home_goals: 3, away_goals: 1 };
    expect(scorePrediction(pick, { home: 3, away: 1 }, withModel, cfg).points).toBeGreaterThan(5);
  });
});
