import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";
import { answerPoints, parseQuestionInput } from "../src/services/questions";
import { isDateString } from "../src/lib/dates";
import { relevanceScore } from "../src/lib/relevance";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

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

const DAY = "2026-10-04";
const later = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const base = (extra: object = {}) => ({ date: DAY, kind: "pergunta", title: "Quem vence a eleição?", closes_at: later(), options: [{ label: "Candidato A", odd: "1.80" }, { label: "Candidato B", odd: "2,10" }], ...extra });

describe("perguntas do dia: validação e pontos", () => {
  it("valida tipo, texto, opções e odds", () => {
    const q = parseQuestionInput(base(), isDateString);
    expect(q.options).toEqual([{ id: "o1", label: "Candidato A", odd: 1.8 }, { id: "o2", label: "Candidato B", odd: 2.1 }]);
    expect(() => parseQuestionInput(base({ kind: "futebol americano" }), isDateString)).toThrow();
    expect(() => parseQuestionInput(base({ options: [{ label: "Só um", odd: 2 }] }), isDateString)).toThrow(/2 a 12/);
    expect(() => parseQuestionInput(base({ options: [{ label: "A", odd: 1 }, { label: "B", odd: 2 }] }), isDateString)).toThrow(/maior que 1/);
    expect(() => parseQuestionInput(base({ options: [{ label: "A", odd: 2 }, { label: "a", odd: 2 }] }), isDateString)).toThrow(/repetida/);
    expect(() => parseQuestionInput(base({ closes_at: "ontem" }), isDateString)).toThrow();
  });

  it("acerto vale odd − 1; erro 0; anulada 0; sem resultado null", () => {
    const q = { options: [{ id: "a", label: "A", odd: 1.8 }, { id: "b", label: "B", odd: 2.1 }], result: "b", voided: false };
    expect(answerPoints(q, "b")).toEqual({ points: 1.1, hits: 1 });
    expect(answerPoints(q, "a")).toEqual({ points: 0, hits: 0 });
    expect(answerPoints({ ...q, voided: true }, "b")).toEqual({ points: 0, hits: 0 });
    expect(answerPoints({ ...q, result: null }, "b")).toEqual({ points: null, hits: null });
  });
});

describe("perguntas do dia: fluxo completo", () => {
  it("admin cria pergunta (inclusive Sim/Não); basquete e UFC em espera; jogador não pode criar", async () => {
    expect((await call("/api/admin/perguntas", { method: "POST", user: "lucas", body: base() })).status).toBe(403);
    expect((await call("/api/admin/perguntas", { method: "POST", user: "admin", body: base({ title: "Vai ter segundo turno?", options: [{ label: "Sim", odd: 1.9 }, { label: "Não", odd: 1.9 }] }) })).status).toBe(201);
    for (const kind of ["basquete", "ufc"]) {
      const r = await call("/api/admin/perguntas", { method: "POST", user: "admin", body: base({ kind }) });
      expect(r.status).toBe(400);
      expect((await json(r)).erro).toMatch(/em espera/);
    }
    const d = await json(await call(`/api/perguntas?date=${DAY}`, { user: "lucas" }));
    expect(d.perguntas.find((q: any) => q.title === "Vai ter segundo turno?").options.map((o: any) => o.label)).toEqual(["Sim", "Não"]);
  });

  it("responde, troca de opção, não vê os outros antes de fechar; resultado pontua e entra no ranking geral", async () => {
    const { id } = await json(await call("/api/admin/perguntas", { method: "POST", user: "admin", body: base({ title: "Eleição: quem leva?" }) }));
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "bia", body: { option_id: "o1" } })).status).toBe(200);
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "bia", body: { option_id: "o2" } })).status).toBe(200);
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "carlos", body: { option_id: "o1" } })).status).toBe(200);
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "carlos", body: { option_id: "zz" } })).status).toBe(400);

    const antes = (await json(await call(`/api/perguntas?date=${DAY}`, { user: "bia" }))).perguntas.find((q: any) => q.id === id);
    expect(antes.mine.option_id).toBe("o2");
    expect(antes.counts).toBeNull(); // ainda aberta: não mostra as escolhas dos outros

    const geralAntes = await json(await call("/api/ranking?escopo=geral", { user: "bia" }));
    const biaAntes = geralAntes.rows.find((r: any) => r.user_id === "bia").points;

    expect((await call(`/api/admin/perguntas/${id}/resultado`, { method: "POST", user: "admin", body: { option_id: "o2" } })).status).toBe(200);

    const depois = (await json(await call(`/api/perguntas?date=${DAY}`, { user: "bia" }))).perguntas.find((q: any) => q.id === id);
    expect(depois.closed).toBe(true); // dar o resultado fecha
    expect(depois.mine.points).toBe(1.1);
    expect(depois.counts).toEqual({ o1: 1, o2: 1 });
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "bia", body: { option_id: "o1" } })).status).toBe(400); // travada

    const geral = await json(await call("/api/ranking?escopo=geral", { user: "bia" }));
    expect(geral.rows.find((r: any) => r.user_id === "bia").points).toBeCloseTo(biaAntes + 1.1, 2);

    // anular tira os pontos
    await call(`/api/admin/perguntas/${id}/resultado`, { method: "POST", user: "admin", body: { anular: true } });
    const geral2 = await json(await call("/api/ranking?escopo=geral", { user: "bia" }));
    expect(geral2.rows.find((r: any) => r.user_id === "bia").points).toBeCloseTo(biaAntes, 2);
  });

  it("pergunta fechada pela hora não aceita resposta (hora do servidor)", async () => {
    const { id } = await json(await call("/api/admin/perguntas", { method: "POST", user: "admin", body: base({ closes_at: new Date(Date.now() - 60_000).toISOString() }) }));
    expect((await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "ana", body: { option_id: "o1" } })).status).toBe(400);
  });

  it("editar não pode apagar opção já escolhida; excluir apaga as respostas", async () => {
    const { id } = await json(await call("/api/admin/perguntas", { method: "POST", user: "admin", body: base() }));
    await call(`/api/perguntas/${id}/resposta`, { method: "PUT", user: "ana", body: { option_id: "o1" } });
    const sem = await call(`/api/admin/perguntas/${id}`, { method: "PUT", user: "admin", body: base({ options: [{ id: "o2", label: "Candidato B", odd: 2.3 }, { label: "Candidato C", odd: 4 }] }) });
    expect(sem.status).toBe(400);
    const ok = await call(`/api/admin/perguntas/${id}`, { method: "PUT", user: "admin", body: base({ options: [{ id: "o1", label: "Candidato A", odd: 1.7 }, { id: "o2", label: "Candidato B", odd: 2.3 }] }) });
    expect(ok.status).toBe(200);
    expect((await call(`/api/admin/perguntas/${id}`, { method: "DELETE", user: "admin" })).status).toBe(200);
    const d = await json(await call(`/api/perguntas?date=${DAY}`, { user: "ana" }));
    expect(d.perguntas.some((q: any) => q.id === id)).toBe(false);
  });
});

describe("foco no Brasil", () => {
  const f = (id: number, country: string) => ({ league: { id, country }, home: { name: "Time A" }, away: { name: "Time B" } });
  it("Série B e C ficam acima de ligas comuns de fora", () => {
    const serieB = relevanceScore(f(72, "Brazil"), DEFAULT_SETTINGS);
    const serieC = relevanceScore(f(75, "Brazil"), DEFAULT_SETTINGS);
    const estadual = relevanceScore(f(999, "Brazil"), DEFAULT_SETTINGS);
    const fora = relevanceScore(f(998, "Norway"), DEFAULT_SETTINGS);
    expect(serieB).toBeGreaterThan(serieC);
    expect(serieC).toBeGreaterThan(fora);
    expect(estadual).toBeGreaterThan(fora);
  });
  it("vale mesmo com pesos de liga antigos salvos (o bônus do Brasil é separado)", () => {
    const s = { ...DEFAULT_SETTINGS, leagueWeights: { "71": 90 } };
    expect(relevanceScore(f(72, "Brazil"), s)).toBeGreaterThan(relevanceScore(f(500, "Norway"), s));
  });
});
