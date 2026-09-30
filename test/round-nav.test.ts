import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";
import { parsePredictionInput } from "../src/lib/predictions";
import { scorePrediction, type PickLike } from "../src/lib/scoring";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { bolaoDay } from "../src/lib/dates";

const app = createApp();
const env = { DEV_MEMORY: "1" } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
  app.request(
    `http://localhost${path}`,
    { method: init.method ?? "GET", headers: { "content-type": "application/json", cookie: `bolao_sessao=dev.${init.user ?? "bia"}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    env,
    ctx,
  );
const json = async (r: Response) => (await r.json()) as any;
const yesterday = () => bolaoDay(new Date(Date.now() - 86400_000));

describe("voltar da rodada de ontem para a de hoje", () => {
  it("a rodada atual informa quais são as outras e qual é a atual", async () => {
    const d = await json(await call("/api/rodada/atual"));
    expect(d.atual).toBe(d.rodada.id);
    expect(d.outras.map((r: any) => r.id)).toEqual(expect.arrayContaining([d.rodada.id, yesterday()]));
  });

  it("a rodada de ontem também traz a lista e a atual, então dá para voltar", async () => {
    const hoje = await json(await call("/api/rodada/atual"));
    const ontem = await json(await call(`/api/rodadas/${yesterday()}`));
    expect(ontem.rodada.id).toBe(yesterday());
    expect(ontem.atual).toBe(hoje.rodada.id);
    const ids = ontem.outras.map((r: any) => r.id);
    expect(ids).toContain(hoje.rodada.id);
    expect(ids).toContain(yesterday());
    // ... e a rodada de hoje continua abrindo normalmente
    const volta = await json(await call(`/api/rodadas/${ontem.atual}`));
    expect(volta.rodada.status).toBe("open");
  });

  it("uma rodada antiga fora da lista das mais recentes continua aparecendo na lista", async () => {
    const ontem = await json(await call(`/api/rodadas/${yesterday()}`));
    expect(ontem.outras.filter((r: any) => r.id === yesterday())).toHaveLength(1);
  });
});

describe("placar exato: errou o placar, acertou o vencedor", () => {
  const odds = {
    "1X2": { source: "t", fetched_at: new Date(), raw: {}, fair: { "1": 2.5, X: 3.2, "2": 3.0 } },
    OU25: { source: "t", fetched_at: new Date(), raw: {}, fair: { over: 1.9, under: 1.95 } },
    CS: { source: "t", fetched_at: new Date(), raw: {}, fair: { "2-1": 9.5, "1-0": 6 } },
  };
  const pick: PickLike = { pick_1x2: "1", mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1, joker: false };

  it("vale o vencedor (sem o placar)", () => {
    const r = scorePrediction(pick, { home: 1, away: 0 }, odds, DEFAULT_SETTINGS);
    expect(r).toMatchObject({ points: 1.5, hits: 1 });
    expect(r.parts).toEqual({ winner: 1.5, ou: 0, cs: 0 });
  });

  it("acertou o placar: vale só o placar; errou tudo: zero", () => {
    expect(scorePrediction(pick, { home: 2, away: 1 }, odds, DEFAULT_SETTINGS).points).toBe(8.5);
    expect(scorePrediction(pick, { home: 0, away: 2 }, odds, DEFAULT_SETTINGS).points).toBe(0);
  });

  it("pela API: palpite de placar 2x1, resultado 1x0, pontua o vencedor", async () => {
    const d = await json(await call("/api/rodada/atual"));
    const put = await json(
      await call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", body: { palpites: [{ match_id: "900204", pick_1x2: "1", mode: "cs", pick_ou: null, home_goals: 2, away_goals: 1 }] } }),
    );
    expect(put.salvos).toEqual(["900204"]);
    expect((await call("/api/admin/jogos/900204/resultado", { method: "PUT", user: "admin", body: { home_goals: 1, away_goals: 0 } })).status).toBe(200);
    const j = await json(await call("/api/jogos/900204"));
    const winnerOdd = j.jogo.odds_1x2["1"];
    expect(j.jogo.mine.mode).toBe("cs");
    expect(j.jogo.mine.points).toBeCloseTo(Math.round((winnerOdd - 1) * 100) / 100, 2);
    expect(j.jogo.mine.points).toBeGreaterThan(0);
    expect(j.jogo.mine.hits).toBe(1);
    // corrigir o resultado para o placar exato: passa a valer só o placar
    await call("/api/admin/jogos/900204/resultado", { method: "PUT", user: "admin", body: { home_goals: 2, away_goals: 1 } });
    const exato = await json(await call("/api/jogos/900204"));
    expect(exato.jogo.mine.points).toBeGreaterThan(j.jogo.mine.points);
  });
});

describe("gols OU placar exato: nunca os dois", () => {
  it("o servidor recusa palpite com os dois", () => {
    const both = { match_id: "1", pick_1x2: "1", pick_ou: "over", home_goals: 2, away_goals: 1 };
    expect(() => parsePredictionInput({ ...both, mode: "ou" })).toThrow(/não os dois/);
    expect(() => parsePredictionInput({ ...both, mode: "cs" })).toThrow(/não os dois/);
    expect(() => parsePredictionInput({ ...both, mode: null })).toThrow(/não os dois/);
    expect(() => parsePredictionInput({ ...both, mode: "ou", home_goals: 0, away_goals: null })).toThrow(/não os dois/);
  });

  it("um de cada vez continua valendo", () => {
    expect(parsePredictionInput({ match_id: "1", pick_1x2: "1", mode: "ou", pick_ou: "over", home_goals: null, away_goals: null })).toMatchObject({ mode: "ou" });
    expect(parsePredictionInput({ match_id: "1", pick_1x2: "1", mode: "cs", pick_ou: null, home_goals: 1, away_goals: 0 })).toMatchObject({ mode: "cs" });
  });

  it("pela API o palpite com os dois é recusado e nada é gravado", async () => {
    const d = await json(await call("/api/rodada/atual"));
    const r = await json(
      await call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", body: { palpites: [{ match_id: "900205", pick_1x2: "1", mode: "cs", pick_ou: "over", home_goals: 1, away_goals: 0 }] } }),
    );
    expect(r.salvos).toEqual([]);
    expect(r.erros["900205"]).toMatch(/não os dois/);
    const after = await json(await call("/api/rodada/atual"));
    expect(after.jogos.find((j: any) => j.id === "900205").mine).toBeNull();
  });
});
