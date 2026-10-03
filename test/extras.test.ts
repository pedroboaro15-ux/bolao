import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env, OddsMap } from "../src/types";
import { scorePrediction, type PickLike } from "../src/lib/scoring";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { parsePredictionInput } from "../src/lib/predictions";

const now = new Date();
const odds: OddsMap = {
  "1X2": { source: "t", fetched_at: now, raw: {}, fair: { "1": 1.82, X: 3.6, "2": 4.5 } },
  OU25: { source: "t", fetched_at: now, raw: {}, fair: { over: 1.95, under: 2.05 } },
  CS: { source: "t", fetched_at: now, raw: {}, fair: { "2-1": 9.5 } },
};
const cfg = DEFAULT_SETTINGS;
const ou: PickLike = { pick_1x2: "1", mode: "ou", pick_ou: "over", home_goals: null, away_goals: null, joker: false };
const cs: PickLike = { pick_1x2: "1", mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1, joker: false };
const result = { home: 2, away: 1 };

describe("extras ligados/desligados pelo admin", () => {
  it("sem extra: vale só o vencedor", () => {
    const r = scorePrediction({ ...ou, mode: null, pick_ou: null }, result, odds, cfg);
    expect(r).toMatchObject({ points: 0.82, hits: 1 });
  });

  it("gols desligado: o palpite de gols perde o extra, o vencedor continua valendo", () => {
    const on = scorePrediction(ou, result, odds, cfg, { ou: true, cs: true });
    const off = scorePrediction(ou, result, odds, cfg, { ou: false, cs: true });
    expect(on.points).toBe(1.77);
    expect(off.points).toBe(0.82);
    expect(off.hits).toBe(1);
  });

  it("placar desligado: acertar o placar vale só o vencedor", () => {
    expect(scorePrediction(cs, result, odds, cfg, { ou: true, cs: true }).points).toBe(8.5);
    expect(scorePrediction(cs, result, odds, cfg, { ou: true, cs: false }).points).toBe(0.82);
  });

  it("coringa foi excluído: não multiplica mais nada", () => {
    expect(scorePrediction({ ...ou, joker: true }, result, odds, cfg, { ou: false, cs: false }).points).toBe(0.82);
  });

  it("o servidor recusa extra que está desligado, mas aceita só o vencedor", () => {
    const raw = { match_id: "1", pick_1x2: "1", mode: "ou", pick_ou: "over" };
    expect(() => parsePredictionInput(raw, { ou: false, cs: true })).toThrow(/gols está desativado/);
    expect(() => parsePredictionInput({ ...raw, pick_ou: undefined, mode: "cs", home_goals: 1, away_goals: 0 }, { ou: true, cs: false })).toThrow(/placar exato está desativado/);
    expect(parsePredictionInput({ match_id: "1", pick_1x2: "X" }, { ou: false, cs: false })).toMatchObject({ mode: null, pick_ou: null, home_goals: null });
    expect(parsePredictionInput({ match_id: "1", pick_1x2: "2", mode: "none" })).toMatchObject({ mode: null });
    expect(() => parsePredictionInput({ match_id: "1", pick_1x2: "2", mode: "abc" })).toThrow();
  });
});

describe("pela API (modo demo)", () => {
  const app = createApp();
  const env = { DEV_MEMORY: "1" } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
    app.request(
      `http://localhost${path}`,
      { method: init.method ?? "GET", headers: { "content-type": "application/json", cookie: `bolao_sessao=dev.${init.user ?? "admin"}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      env,
      ctx,
    );
  const json = async (r: Response) => (await r.json()) as any;
  const round = async (user = "bia") => json(await call("/api/rodada/atual", { user }));

  it("o ranking não traz mais sequências e pontos iguais dividem a posição", async () => {
    const d = await json(await call("/api/ranking?escopo=geral"));
    expect(d).not.toHaveProperty("streaks");
    const pts = d.rows.map((r: any) => r.points);
    expect([...pts].sort((x: number, y: number) => y - x)).toEqual(pts);
  });

  it("desligar gols: some do palpite, o servidor recusa, o vencedor sozinho salva", async () => {
    const before = await round("lucas");
    expect(before.jogos.find((j: any) => j.id === "900203").extras).toEqual({ ou: true, cs: true });
    expect(before.jogos.find((j: any) => j.id === "900203").mine.mode).toBe("ou"); // palpite de gols do Lucas

    expect((await call("/api/admin/config", { method: "PUT", body: { goalsEnabled: false } })).status).toBe(200);
    const after = await round("lucas");
    const open = after.jogos.find((j: any) => j.id === "900203");
    expect(open.extras).toEqual({ ou: false, cs: true });
    expect(open.mine).toMatchObject({ mode: null, pick_ou: null, pick_1x2: "1" }); // extra some, vencedor fica
    // jogo que já começou guarda o que valia no início
    expect(after.jogos.find((j: any) => j.id === "900202").extras).toEqual({ ou: true, cs: true });

    const bad = await json(await call(`/api/rodadas/${after.rodada.id}/palpites`, { method: "PUT", user: "bia", body: { palpites: [{ match_id: "900204", pick_1x2: "1", mode: "ou", pick_ou: "over" }] } }));
    expect(bad.salvos).toEqual([]);
    expect(bad.erros["900204"]).toMatch(/desativado/);
    const ok = await json(await call(`/api/rodadas/${after.rodada.id}/palpites`, { method: "PUT", user: "bia", body: { palpites: [{ match_id: "900204", pick_1x2: "1", mode: null }] } }));
    expect(ok.salvos).toEqual(["900204"]);
    const mine = (await round("bia")).jogos.find((j: any) => j.id === "900204").mine;
    expect(mine).toMatchObject({ mode: null, pick_1x2: "1" });
  });

  it("desligar placar exato também vale, e é reversível a qualquer momento", async () => {
    await call("/api/admin/config", { method: "PUT", body: { goalsEnabled: true, scoreEnabled: false } });
    const d = await round("bia");
    expect(d.jogos.find((j: any) => j.id === "900205").extras).toEqual({ ou: true, cs: false });
    const bad = await json(await call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", user: "bia", body: { palpites: [{ match_id: "900205", pick_1x2: "1", mode: "cs", home_goals: 1, away_goals: 0 }] } }));
    expect(bad.erros["900205"]).toMatch(/placar exato está desativado/);
    await call("/api/admin/config", { method: "PUT", body: { scoreEnabled: true } });
    const back = await json(await call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", user: "bia", body: { palpites: [{ match_id: "900205", pick_1x2: "1", mode: "cs", home_goals: 1, away_goals: 0 }] } }));
    expect(back.salvos).toEqual(["900205"]);
  });

  it("os dois desligados: só o vencedor, e o resultado usa os extras congelados no jogo", async () => {
    await call("/api/admin/config", { method: "PUT", body: { goalsEnabled: false, scoreEnabled: false } });
    const d = await round("carlos");
    expect(d.jogos.every((j: any) => (j.locked ? true : j.extras.ou === false && j.extras.cs === false))).toBe(true);
    // 900201 já começou e terminou com extras ligados: Carlos (empate + under) não pontua, mas o palpite de gols segue visível
    const done = d.jogos.find((j: any) => j.id === "900201");
    expect(done.extras).toEqual({ ou: true, cs: true });
    expect(done.mine.mode).toBe("ou");
  });
});
