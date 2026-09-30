import { describe, expect, it } from "vitest";
import { buildOdds, csFairOdd, csTable, fitPoisson, outcomeProbs, overround, removeMargin } from "../src/lib/odds";

describe("remoção da margem", () => {
  it("normaliza o 1X2 e a soma das probabilidades justas dá 100%", () => {
    const fair = removeMargin({ "1": 2.0, X: 3.5, "2": 4.0 }, ["1", "X", "2"])!;
    const sum = Object.values(fair).reduce((s, o) => s + 1 / o, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
    // odd justa = odd bruta × Σp; Σp = 0.5 + 0.2857 + 0.25 = 1.0357
    expect(fair["1"]).toBe(2.07);
    expect(fair["X"]).toBe(3.63);
    expect(fair["2"]).toBe(4.14);
  });

  it("over/under: a odd justa é maior que a bruta quando há margem", () => {
    const fair = removeMargin({ over: 1.72, under: 2.1 }, ["over", "under"])!;
    expect(fair.over).toBeGreaterThan(1.72);
    expect(fair.under).toBeGreaterThan(2.1);
    expect(1 / fair.over + 1 / fair.under).toBeCloseTo(1, 1);
  });

  it("mercado sem margem fica igual", () => {
    expect(removeMargin({ over: 2, under: 2 }, ["over", "under"])).toEqual({ over: 2, under: 2 });
  });

  it("recusa mercado incompleto ou odd inválida", () => {
    expect(removeMargin({ "1": 2, X: 3 }, ["1", "X", "2"])).toBeNull();
    expect(removeMargin({ "1": 1, X: 3, "2": 4 }, ["1", "X", "2"])).toBeNull();
  });

  it("aplica o teto de odd", () => {
    const fair = removeMargin({ "1": 1.01, X: 40, "2": 200 }, ["1", "X", "2"], 50)!;
    expect(Math.max(...Object.values(fair))).toBeLessThanOrEqual(50);
  });

  it("calcula a margem do mercado", () => {
    expect(overround({ "1": 2, X: 4, "2": 4 })).toBe(0);
    expect(overround({ "1": 1.9, X: 3.5, "2": 4 })).toBeGreaterThan(0);
  });
});

describe("Poisson ajustado ao mercado", () => {
  it("reproduz o 1X2 e o Over 2,5 justos", () => {
    const built = buildOdds(
      {
        "1X2": { source: "t", raw: { "1": 2.1, X: 3.4, "2": 3.6 } },
        OU25: { source: "t", raw: { over: 1.9, under: 1.95 } },
      },
      new Date(),
    )!;
    const { lh, la } = built.model!;
    const p = outcomeProbs(lh, la);
    const fair = built["1X2"]!.fair;
    expect(p.home).toBeCloseTo(1 / fair["1"], 1);
    expect(p.draw).toBeCloseTo(1 / fair["X"], 1);
    expect(p.away).toBeCloseTo(1 / fair["2"], 1);
    expect(p.over25).toBeGreaterThan(0.45);
    expect(p.over25).toBeLessThan(0.58);
  });

  it("favorito forte tem mais gols esperados", () => {
    const { lh, la } = fitPoisson({ "1": 1.3, X: 5.5, "2": 10 });
    expect(lh).toBeGreaterThan(la);
  });

  it("placar exato: usa o mercado quando existe e o modelo quando não", () => {
    const odds = buildOdds(
      {
        "1X2": { source: "t", raw: { "1": 2, X: 3.5, "2": 4 } },
        CS: { source: "t", raw: { "1-0": 7, "1-1": 6.5, "2-1": 9 } },
      },
      new Date(),
    )!;
    expect(csFairOdd(odds, 2, 1)).toBe(odds.CS!.fair["2-1"]);
    const modelo = csFairOdd(odds, 3, 0)!; // fora do mercado listado
    expect(modelo).toBeGreaterThan(1);
    expect(csFairOdd(odds, 3, 0)).toBe(modelo);
  });

  it("placar improvável respeita o limite de 150", () => {
    const odds = buildOdds({ "1X2": { source: "t", raw: { "1": 1.2, X: 7, "2": 15 } } }, new Date())!;
    expect(csFairOdd(odds, 0, 9, 150)).toBeLessThanOrEqual(150);
    const table = csTable(odds, 150);
    expect(Object.keys(table)).toHaveLength(100);
  });

  it("sem 1X2 não há modelo nem placar", () => {
    const odds = buildOdds({ OU25: { source: "t", raw: { over: 1.9, under: 1.9 } } }, new Date())!;
    expect(odds.model).toBeUndefined();
    expect(csFairOdd(odds, 1, 0)).toBeNull();
  });
});
