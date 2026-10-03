import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MemoryDb } from "../src/db/memory";
import { emailKey, limitsOf, purgeRateLimits, takeSlot, waitText } from "../src/lib/ratelimit";
import type { Env } from "../src/types";

// ---------- a vaga ----------

describe("vagas dos limites (takeSlot)", () => {
  const t0 = new Date("2026-10-01T12:00:00Z");

  it("dá só as vagas da janela e depois bloqueia, sem importar quantos pedem ao mesmo tempo", async () => {
    const db = new MemoryDb();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => takeSlot(db, "signup", 2, 60_000, t0)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });

  it("a janela seguinte tem vagas novas, e devolver a vaga libera de novo", async () => {
    const db = new MemoryDb();
    const a = await takeSlot(db, "k", 1, 60_000, t0);
    expect((await takeSlot(db, "k", 1, 60_000, t0)).ok).toBe(false);
    await a.release();
    expect((await takeSlot(db, "k", 1, 60_000, t0)).ok).toBe(true);
    expect((await takeSlot(db, "k", 1, 60_000, new Date(t0.getTime() + 60_000))).ok).toBe(true);
  });

  it("clear() devolve todas as vagas da chave naquela janela", async () => {
    const db = new MemoryDb();
    const a = await takeSlot(db, "k", 3, 60_000, t0);
    await takeSlot(db, "k", 3, 60_000, t0);
    const c = await takeSlot(db, "k", 3, 60_000, t0);
    expect((await takeSlot(db, "k", 3, 60_000, t0)).ok).toBe(false);
    await c.clear();
    expect((await takeSlot(db, "k", 3, 60_000, t0)).ok).toBe(true);
    expect(a.ok).toBe(true);
  });

  it("chaves diferentes não se misturam", async () => {
    const db = new MemoryDb();
    expect((await takeSlot(db, "login:a", 1, 60_000, t0)).ok).toBe(true);
    expect((await takeSlot(db, "login:b", 1, 60_000, t0)).ok).toBe(true);
  });

  it("apaga só as vagas antigas", async () => {
    const db = new MemoryDb();
    await takeSlot(db, "x", 1, 60_000, new Date(t0.getTime() - 5 * 3600_000));
    await takeSlot(db, "y", 1, 60_000, t0);
    expect(await purgeRateLimits(db, t0)).toBe(1);
    expect(await db.query("rate_limits")).toHaveLength(1);
  });

  it("textos e padrões", async () => {
    expect(waitText(new Date(t0.getTime() + 20_000), t0)).toBe("20 segundos");
    expect(waitText(new Date(t0.getTime() + 10 * 60_000), t0)).toBe("10 minutos");
    expect(await emailKey("Ana@X.com ")).toBe(await emailKey("ana@x.com"));
    expect(await emailKey("ana@x.com")).not.toContain("@");
    expect(limitsOf({})).toEqual({ signupPerMinute: 2, loginFails: 5, loginWindowMs: 900_000 });
    expect(limitsOf({ LIMIT_SIGNUP_PER_MIN: "7", LIMIT_LOGIN_FAILS: "x" })).toMatchObject({ signupPerMinute: 7, loginFails: 5 });
  });
});

// ---------- na API (limites padrão: 2 cadastros por minuto, 5 tentativas de login por conta) ----------

const app = createApp();
const env = { DEV_MEMORY: "1" } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env, ctx);
const msg = async (r: Response) => ((await r.json()) as any).erro as string;

describe("limites na API", () => {
  beforeEach(() => {
    // meio de uma janela de 15 min (e de 1 min), para a virada de janela não atrapalhar o teste
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:07:30Z"));
  });
  afterEach(() => vi.useRealTimers());

  const signup = (n: number, extra: object = {}) => call("/api/cadastro", { email: `lim${n}@x.com`, phone: "(11) 91234-5678", password: "senha1234", confirm: "senha1234", ...extra });

  it("cadastro: no máximo 2 por minuto no site todo", async () => {
    expect((await signup(1)).status).toBe(201);
    expect((await signup(2)).status).toBe(201);
    const third = await signup(3);
    expect(third.status).toBe(429);
    expect(await msg(third)).toMatch(/Muitos cadastros neste minuto/);
    // no minuto seguinte volta a valer
    vi.setSystemTime(new Date("2026-10-01T12:08:05Z"));
    expect((await signup(3)).status).toBe(201);
  });

  it("cadastro com dados inválidos não gasta vaga", async () => {
    vi.setSystemTime(new Date("2026-10-01T13:07:30Z"));
    for (let i = 0; i < 5; i++) expect((await signup(10 + i, { confirm: "diferente1" })).status).toBe(400);
    expect((await signup(20)).status).toBe(201);
    expect((await signup(21)).status).toBe(201);
  });

  const login = (email: string, password: string) => call("/api/entrar", { email, password });

  it("login: bloqueia depois de 5 erros (até a senha certa fica bloqueada) e libera na janela seguinte", async () => {
    for (let i = 0; i < 5; i++) expect((await login("carlos@demo.local", `errada${i}xx`)).status).toBe(401);
    const sixth = await login("carlos@demo.local", "errada9xx");
    expect(sixth.status).toBe(429);
    expect(await msg(sixth)).toMatch(/bloqueado por 8 minutos/);
    expect((await login("carlos@demo.local", "demo1234")).status).toBe(429); // a senha certa também espera
    // outra conta não é afetada
    expect((await login("bia@demo.local", "demo1234")).status).toBe(200);
    // passou a janela de 15 min
    vi.setSystemTime(new Date("2026-10-01T12:15:01Z"));
    expect((await login("carlos@demo.local", "demo1234")).status).toBe(200);
  });

  it("acertar a senha zera a contagem de erros da conta", async () => {
    vi.setSystemTime(new Date("2026-10-01T14:07:30Z"));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) expect((await login("ana@demo.local", `errada${round}${i}xx`)).status).toBe(401);
      expect((await login("ana@demo.local", "demo1234")).status).toBe(200);
    }
    // e 5 erros seguidos continuam bloqueando
    for (let i = 0; i < 5; i++) expect((await login("ana@demo.local", `seguida${i}xx`)).status).toBe(401);
    expect((await login("ana@demo.local", "demo1234")).status).toBe(429);
  });

  it("o e-mail é comparado sem maiúsculas (não dá para fugir do limite trocando a caixa)", async () => {
    vi.setSystemTime(new Date("2026-10-01T15:07:30Z"));
    for (let i = 0; i < 5; i++) await login(i % 2 ? "LUCAS@demo.local" : "lucas@demo.local", `errada${i}xx`);
    expect((await login("Lucas@Demo.local", "demo1234")).status).toBe(429);
  });
});
