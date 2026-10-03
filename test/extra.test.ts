import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";
import { parseChampionship } from "../src/routes/extra";

const app = createApp();
const env = { DEV_MEMORY: "1" } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
  app.request(
    `http://localhost${path}`,
    {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.user ? { cookie: `bolao_sessao=dev.${init.user}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    env,
    ctx,
  );
const json = async (r: Response) => (await r.json()) as any;

describe("rodada de hoje", () => {
  it("a tela de início mostra a rodada de hoje; a de ontem aparece como encerrada", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "lucas" }));
    expect(d.rodada.date).toBe(d.hoje);
    const ontem = d.outras.find((r: any) => r.date < d.hoje);
    expect(ontem.status).toBe("finished");
  });
});

describe("comentários e reações", () => {
  it("comenta, lista e só o autor (ou o admin) apaga", async () => {
    expect((await call("/api/jogos/900203/comentarios", { method: "POST", user: "lucas", body: { texto: "Hoje é Timão!" } })).status).toBe(201);
    expect((await call("/api/jogos/900203/comentarios", { method: "POST", user: "lucas", body: { texto: "   " } })).status).toBe(400);
    const s = await json(await call("/api/jogos/900203/social", { user: "ana" }));
    const c = s.comentarios.find((x: any) => x.text === "Hoje é Timão!");
    expect(c.pode_apagar).toBe(false);
    expect((await call(`/api/comentarios/${c.id}`, { method: "DELETE", user: "ana" })).status).toBe(403);
    expect((await call(`/api/comentarios/${c.id}`, { method: "DELETE", user: "admin" })).status).toBe(200);
  });

  it("comentário tem limite de 280 letras e de ritmo (6 por minuto)", async () => {
    await call("/api/jogos/900204/comentarios", { method: "POST", user: "bia", body: { texto: "x".repeat(400) } });
    const s = await json(await call("/api/jogos/900204/social", { user: "bia" }));
    expect(s.comentarios[0].text.length).toBe(280);
    let blocked = false;
    for (let i = 0; i < 8; i++) if ((await call("/api/jogos/900204/comentarios", { method: "POST", user: "bia", body: { texto: `oi ${i}` } })).status === 429) blocked = true;
    expect(blocked).toBe(true);
  });

  it("reação só depois do apito, não no próprio palpite, e clicar de novo tira", async () => {
    // jogo 900202 já começou: palpites visíveis
    expect((await json(await call("/api/palpites/900202_ana/reacao", { method: "POST", user: "carlos", body: { emoji: "😂" } }))).reagiu).toBe(true);
    const s = await json(await call("/api/jogos/900202/social", { user: "carlos" }));
    expect(s.reacoes["900202_ana"]["😂"]).toEqual({ n: 1, meu: true });
    expect((await json(await call("/api/palpites/900202_ana/reacao", { method: "POST", user: "carlos", body: { emoji: "😂" } }))).reagiu).toBe(false);
    expect((await call("/api/palpites/900202_ana/reacao", { method: "POST", user: "ana", body: { emoji: "😂" } })).status).toBe(400); // próprio
    expect((await call("/api/palpites/900202_ana/reacao", { method: "POST", user: "carlos", body: { emoji: "💩" } })).status).toBe(400); // fora da lista
    expect((await call("/api/palpites/900203_lucas/reacao", { method: "POST", user: "carlos", body: { emoji: "🔥" } })).status).toBe(400); // antes do apito
  });

  it("o detalhe do jogo manda o id de cada palpite (para reagir)", async () => {
    const d = await json(await call("/api/jogos/900202", { user: "lucas" }));
    expect(d.palpites[0].id).toMatch(/^900202_/);
  });
});

describe("campeonatos", () => {
  it("valida nome e período", () => {
    expect(() => parseChampionship({ name: "A", start_date: "2026-10-01", end_date: "2026-10-31" })).toThrow();
    expect(() => parseChampionship({ name: "Copa", start_date: "2026-10-31", end_date: "2026-10-01" })).toThrow(/depois/);
  });

  it("o ranking do campeonato soma só as rodadas dentro do período", async () => {
    const hoje = (await json(await call("/api/rodada/atual", { user: "lucas" }))).hoje;
    const { id } = await json(await call("/api/admin/campeonatos", { method: "POST", user: "admin", body: { name: "Copa de Hoje", start_date: hoje, end_date: hoje, prize: "Pizza para o campeão" } }));
    const r = await json(await call(`/api/campeonatos/${id}/ranking`, { user: "lucas" }));
    const rodadaHoje = await json(await call("/api/ranking?escopo=rodada", { user: "lucas" }));
    expect(r.campeonato.prize).toBe("Pizza para o campeão");
    expect(r.rows.find((x: any) => x.user_id === "lucas").points).toBe(rodadaHoje.rows.find((x: any) => x.user_id === "lucas").points);
    const geral = await json(await call("/api/ranking?escopo=geral", { user: "lucas" }));
    expect(geral.rows.find((x: any) => x.user_id === "lucas").points).toBeGreaterThan(r.rows.find((x: any) => x.user_id === "lucas").points);
    const lista = await json(await call("/api/campeonatos", { user: "bia" }));
    expect(lista.campeonatos.find((x: any) => x.id === id).situacao).toBe("em andamento");
  });
});

describe("excluir rodada", () => {
  it("some do histórico, dos palpites e do ranking geral", async () => {
    const antes = await json(await call("/api/ranking?escopo=geral", { user: "lucas" }));
    const d = await json(await call("/api/rodada/atual", { user: "lucas" }));
    const ontem = d.outras.find((r: any) => r.date < d.hoje);
    expect((await call(`/api/admin/rodadas/${ontem.id}`, { method: "DELETE", user: "lucas" })).status).toBe(403);
    expect((await call(`/api/admin/rodadas/${ontem.id}`, { method: "DELETE", user: "admin" })).status).toBe(200);
    const depois = await json(await call("/api/rodada/atual", { user: "lucas" }));
    expect(depois.outras.some((r: any) => r.id === ontem.id)).toBe(false);
    const mine = await json(await call("/api/meus-palpites", { user: "lucas" }));
    expect(mine.itens.some((i: any) => i.rodada.id === ontem.id)).toBe(false);
    const geral = await json(await call("/api/ranking?escopo=geral", { user: "lucas" }));
    expect(geral.rows.find((r: any) => r.user_id === "lucas").points).toBeLessThan(antes.rows.find((r: any) => r.user_id === "lucas").points);
  });
});

describe("pedidos (só em dia sem rodada)", () => {
  it("com rodada hoje: lista fechada e o servidor recusa voto e sugestão", async () => {
    const d = await json(await call("/api/pedidos", { user: "ana" }));
    expect(d.fechado).toBe(true);
    expect((await call("/api/pedidos/sugestao", { method: "POST", user: "ana", body: { texto: "Quero o Fla-Flu" } })).status).toBe(400);
    expect((await call("/api/pedidos/voto", { method: "POST", user: "ana", body: { fixture_id: 910001 } })).status).toBe(400);
  });

  it("sem rodada hoje: abre", async () => {
    const hoje = (await json(await call("/api/rodada/atual", { user: "lucas" }))).hoje;
    for (const r of (await json(await call("/api/admin/rodadas", { user: "admin" }))).rodadas.filter((x: any) => x.date === hoje)) await call(`/api/admin/rodadas/${r.id}`, { method: "DELETE", user: "admin" });
    const d = await json(await call("/api/rodada/atual", { user: "lucas" }));
    expect(d.rodada).toBeNull();
    expect((await json(await call("/api/pedidos", { user: "ana" }))).fechado).toBeUndefined();
  });
});

describe("pedidos: votos e sugestões", () => {
  it("vota e tira o voto num jogo da lista; o admin vê a contagem", async () => {
    const d = await json(await call("/api/pedidos", { user: "ana" }));
    expect(d.jogos.length).toBeGreaterThan(0);
    const j = d.jogos[0];
    expect((await json(await call("/api/pedidos/voto", { method: "POST", user: "ana", body: { fixture_id: j.id } }))).votou).toBe(true);
    expect((await json(await call("/api/pedidos/voto", { method: "POST", user: "bia", body: { fixture_id: j.id } }))).votou).toBe(true);
    const adm = await json(await call("/api/admin/pedidos", { user: "admin" }));
    expect(adm.votos.find((v: any) => v.fixture_id === j.id).votos).toBe(2);
    expect((await json(await call("/api/pedidos/voto", { method: "POST", user: "ana", body: { fixture_id: j.id } }))).votou).toBe(false);
    expect((await call("/api/pedidos/voto", { method: "POST", user: "ana", body: { fixture_id: 123 } })).status).toBe(400); // fora da lista
  });

  it("sugestão escrita: no máximo 5 por pessoa por dia", async () => {
    for (let i = 0; i < 5; i++) expect((await call("/api/pedidos/sugestao", { method: "POST", user: "carlos", body: { texto: `Sugestão ${i}` } })).status).toBe(201);
    expect((await call("/api/pedidos/sugestao", { method: "POST", user: "carlos", body: { texto: "mais uma" } })).status).toBe(429);
    const adm = await json(await call("/api/admin/pedidos", { user: "admin" }));
    expect(adm.sugestoes.filter((s: any) => s.nickname === "Carlão")).toHaveLength(5);
    expect((await call("/api/admin/pedidos", { user: "carlos" })).status).toBe(403);
  });
});

