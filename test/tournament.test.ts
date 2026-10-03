import { describe, expect, it } from "vitest";
import { buildTournament, goalsOf, matchdaysNeeded, roundRobin, splitGroups, table, type Matchday, type TournamentConfig } from "../src/lib/tournament";

const day = (scores: Record<string, number | [number, number]>, final = true, date = "2026-10-01"): Matchday => ({
  date,
  final,
  started: true,
  scores: new Map(Object.entries(scores).map(([k, v]) => [k, Array.isArray(v) ? { points: v[0], hits: v[1] } : { points: v, hits: 0 }])),
});
const cfg = (over: Partial<TournamentConfig>): TournamentConfig => ({ format: "pontos", legs: 1, participants: ["a", "b", "c", "d"], groups: 1, advance: 2, goalStep: 1, ...over });

describe("lucro vira gol", () => {
  it("cada 1,00 de lucro = 1 gol (para baixo); passo configurável; nunca negativo", () => {
    expect(goalsOf(2.97, 1)).toBe(2);
    expect(goalsOf(0.99, 1)).toBe(0);
    expect(goalsOf(3, 1)).toBe(3);
    expect(goalsOf(5, 2)).toBe(2);
    expect(goalsOf(-1, 1)).toBe(0);
  });
});

describe("todos contra todos", () => {
  it("cada um enfrenta todos uma vez; número ímpar folga", () => {
    const rr = roundRobin(["a", "b", "c", "d"]);
    expect(rr).toHaveLength(3);
    const pairs = rr.flat().map(([h, a]) => [h, a].sort().join("-")).sort();
    expect(pairs).toEqual(["a-b", "a-c", "a-d", "b-c", "b-d", "c-d"]);
    const odd = roundRobin(["a", "b", "c"]);
    expect(odd).toHaveLength(3);
    expect(odd.every((r) => r.length === 1)).toBe(true);
  });

  it("grupos em serpentina pela cabeça de chave", () => {
    expect(splitGroups(["1", "2", "3", "4", "5", "6", "7", "8"], 2)).toEqual([["1", "4", "5", "8"], ["2", "3", "6", "7"]]);
  });
});

describe("classificação", () => {
  it("V=3, E=1; ordem por pontos, vitórias, saldo, gols pró; últimos 5", () => {
    const t = table(["a", "b", "c"], [
      { home: "a", away: "b", hg: 2, ag: 0 },
      { home: "b", away: "c", hg: 1, ag: 1 },
      { home: "c", away: "a", hg: 3, ag: 1 },
    ]);
    expect(t.map((r) => [r.user_id, r.P, r.SG])).toEqual([["c", 4, 2], ["a", 3, 0], ["b", 1, -2]]);
    expect(t.find((r) => r.user_id === "a")!.last5).toEqual(["V", "D"]);
    expect(t[0]).toMatchObject({ J: 2, V: 1, E: 1, D: 0, GP: 4, GC: 2 });
  });

  it("tudo igual = mesma posição", () => {
    const t = table(["a", "b"], [{ home: "a", away: "b", hg: 1, ag: 1 }]);
    expect(t.map((r) => r.pos)).toEqual([1, 1]);
  });
});

describe("pontos corridos", () => {
  it("cada dia vira uma rodada; o lucro do dia vira gols; campeão quando acaba", () => {
    const c = cfg({});
    expect(matchdaysNeeded(c)).toBe(3);
    const days = [day({ a: 3.2, b: 0.5, c: 1.1, d: 1.9 }), day({ a: 2, b: 2, c: 0, d: 0 }), day({ a: 1, b: 0, c: 0, d: 4 })];
    const v = buildTournament(c, days);
    expect(v.rounds).toHaveLength(3);
    expect(v.rounds[0].fixtures.every((f) => f.hg !== null)).toBe(true);
    expect(v.groups[0].table[0].J).toBe(3);
    expect(v.champion).toBe(v.groups[0].table[0].user_id);
  });

  it("ida e volta dobra as rodadas e inverte o mando; dia que não começou fica sem placar", () => {
    const c = cfg({ legs: 2 });
    expect(matchdaysNeeded(c)).toBe(6);
    const v = buildTournament(c, [day({ a: 1 })]);
    expect(v.rounds).toHaveLength(6);
    expect(v.rounds[1].fixtures[0].hg).toBeNull();
    expect(v.champion).toBeNull();
    const ida = v.rounds[0].fixtures[0];
    const volta = v.rounds[3].fixtures.find((f) => f.home === ida.away && f.away === ida.home);
    expect(volta).toBeTruthy();
  });
});

describe("mata-mata", () => {
  it("chave 1×4 e 2×3; vencedor avança; final define o campeão", () => {
    const c = cfg({ format: "mata" });
    expect(matchdaysNeeded(c)).toBe(2);
    const v = buildTournament(c, [day({ a: 3, d: 1, b: 0, c: 2 }), day({ a: 1, c: 2 })]);
    expect(v.knockout[0].stage).toBe("Semifinal");
    expect(v.knockout[0].ties.map((t) => [t.a, t.b, t.winner])).toEqual([["a", "d", "a"], ["b", "c", "c"]]);
    expect(v.knockout[1].stage).toBe("Final");
    expect(v.champion).toBe("c");
  });

  it("empate vai para os pênaltis: mais acertos; depois a melhor cabeça de chave", () => {
    const v = buildTournament(cfg({ format: "mata", participants: ["a", "b"] }), [day({ a: [1.5, 2], b: [1.2, 4] })]);
    expect(v.knockout[0].ties[0]).toMatchObject({ ga: 1, gb: 1, winner: "b", decidedBy: "pênaltis" });
    const v2 = buildTournament(cfg({ format: "mata", participants: ["a", "b"] }), [day({ a: [1, 2], b: [1, 2] })]);
    expect(v2.champion).toBe("a");
  });

  it("número que não fecha a chave dá folga para as melhores cabeças", () => {
    const v = buildTournament(cfg({ format: "mata", participants: ["a", "b", "c"] }), [day({ b: 2, c: 1 })]);
    const semi = v.knockout[0].ties;
    expect(semi.find((t) => t.decidedBy === "folga")?.winner).toBe("a");
    expect(semi.find((t) => t.decidedBy !== "folga")?.winner).toBe("b");
  });

  it("ida e volta soma o agregado", () => {
    const v = buildTournament(cfg({ format: "mata", participants: ["a", "b"], legs: 2 }), [day({ a: 2, b: 0 }), day({ a: 0, b: 3 })]);
    expect(v.knockout[0].ties[0]).toMatchObject({ ga: 2, gb: 3, winner: "b" });
  });
});

describe("copa (grupos + mata-mata)", () => {
  it("2 grupos de 2; passam 2 de cada: A1×B2 e B1×A2; o mata-mata só sai quando os grupos acabam", () => {
    const c = cfg({ format: "copa", groups: 2, advance: 1 });
    expect(matchdaysNeeded(c)).toBe(1 + 1);
    const antes = buildTournament(c, [day({ a: 1, b: 0, c: 0, d: 0 }, false)]);
    expect(antes.knockout[0].ties[0].a).toBeNull();
    const depois = buildTournament(c, [day({ a: 2, d: 0, b: 1, c: 3 }), day({ a: 1, c: 0 })]);
    expect(depois.groups.map((g) => g.name)).toEqual(["Grupo A", "Grupo B"]);
    expect(depois.knockout[0].stage).toBe("Final");
    expect(depois.champion).toBe("a");
  });
});
