import { describe, expect, it } from "vitest";
import { kickWith as kick, rng, shootout } from "../src/lib/penalties";
import { buildTournament, type Matchday, type TournamentConfig } from "../src/lib/tournament";

describe("pênaltis sorteados", () => {
  it("mesma semente = mesma disputa; sempre tem vencedor e placar coerente", () => {
    expect(shootout("x")).toEqual(shootout("x"));
    for (let i = 0; i < 2000; i++) {
      const s = shootout("s" + i);
      expect(s.a).not.toBe(s.b);
      expect(s.winner).toBe(s.a > s.b ? "a" : "b");
      expect(s.a).toBe(s.kicks.filter((k) => k.by === "a" && k.result === "gol").length);
      expect(s.b).toBe(s.kicks.filter((k) => k.by === "b" && k.result === "gol").length);
      expect(s.kicks.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("probabilidades: 8% fora, 90% defesa no canto+altura, 25% só no canto", () => {
    const r = rng("estatistica");
    const n = 200_000;
    let fora = 0, gol = 0, exato = 0, exatoDef = 0, lado = 0, ladoDef = 0, outro = 0, outroDef = 0;
    for (let i = 0; i < n; i++) {
      const k = kick("a", r);
      if (k.result === "fora") { fora++; continue; }
      if (k.result === "gol") gol++;
      const c = k.dive.col === k.aim.col, h = k.dive.row === k.aim.row;
      if (c && h) (exato++, k.result === "defesa" && exatoDef++);
      else if (c) (lado++, k.result === "defesa" && ladoDef++);
      else (outro++, k.result === "defesa" && outroDef++);
    }
    console.log(`cobranças: ${n} | gol ${(100 * gol / n).toFixed(1)}% | fora ${(100 * fora / n).toFixed(1)}% | defesa ${(100 * (n - gol - fora) / n).toFixed(1)}% | defesa canto+altura ${(100 * exatoDef / exato).toFixed(1)}% | defesa só canto ${(100 * ladoDef / lado).toFixed(1)}%`);
    expect(Math.abs(fora / n - 0.08)).toBeLessThan(0.005);
    expect(Math.abs(exatoDef / exato - 0.9)).toBeLessThan(0.01);
    expect(Math.abs(ladoDef / lado - 0.25)).toBeLessThan(0.01);
    expect(outroDef).toBe(0);
  });

  it("disputas: placares mais comuns e alternadas", () => {
    const placares = new Map<string, number>();
    let alternadas = 0, venceA = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const s = shootout("d" + i);
      const k = `${Math.max(s.a, s.b)}x${Math.min(s.a, s.b)}`;
      placares.set(k, (placares.get(k) ?? 0) + 1);
      if (s.kicks.length > 10) alternadas++;
      if (s.winner === "a") venceA++;
    }
    const top = [...placares].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}%`);
    console.log(`disputas: ${n} | foram para as alternadas ${(100 * alternadas / n).toFixed(1)}% | quem bate primeiro vence ${(100 * venceA / n).toFixed(1)}% | placares: ${top.join(", ")}`);
    expect(Math.abs(venceA / n - 0.5)).toBeLessThan(0.03);
  });
});

describe("mata-mata: desempate", () => {
  const cfg: TournamentConfig = { format: "mata", legs: 2, participants: ["a", "b"], groups: 1, advance: 1, goalStep: 1 };
  const day = (date: string, pa: number, pb: number): Matchday => ({ date, final: true, started: true, scores: new Map([["a", { points: pa, hits: 1 }], ["b", { points: pb, hits: 1 }]]) as any });

  it("gols iguais: passa quem teve mais lucro na ida e volta", () => {
    const t = buildTournament(cfg, [day("2026-10-01", 2.1, 2.5), day("2026-10-02", 1.9, 1.2)]).knockout[0].ties[0];
    expect([t.ga, t.gb]).toEqual([3, 3]);
    expect([t.la, t.lb]).toEqual([4, 3.7]);
    expect(t.winner).toBe("a");
    expect(t.pens).toEqual({ by: "lucro" });
  });

  it("lucro igual: pênaltis pendentes até o resultado; com o resultado, passa quem venceu", () => {
    const days = [day("2026-10-01", 1.5, 1.5), day("2026-10-02", 0.7, 0.7)];
    const t = buildTournament(cfg, days).knockout[0].ties[0];
    expect(t.pens).toEqual({ by: "cobranças", key: "Final|a|b", pending: true });
    expect(t.winner).toBeNull();
    const so = shootout("x");
    const t2 = buildTournament(cfg, days, new Map([["Final|a|b", so]])).knockout[0].ties[0];
    expect(t2.winner).toBe(so.winner);
    const p = t2.pens as any;
    console.log(`exemplo: a ${p.a} x ${p.b} b | ` + p.kicks.map((k: any) => `${k.by}:${k.aim.col}/${k.aim.row}→${k.result}`).join(" "));
  });

});
