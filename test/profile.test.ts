import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";
import { nicknameTaken, parseNickname, uniqueNickname } from "../src/lib/profile";

const app = createApp();
const env = { DEV_MEMORY: "1", LIMIT_SIGNUP_PER_MIN: "100" } as unknown as Env;
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

describe("apelidos", () => {
  const users = [{ id: "1", nickname: "Luquinha" }, { id: "2", nickname: "Ana" }];
  it("compara sem maiúsculas, acentos e espaços repetidos", () => {
    expect(nicknameTaken(users, "  luquínha ")).toBe(true);
    expect(nicknameTaken(users, "Luquinha", "1")).toBe(false); // o próprio dono não conta
    expect(nicknameTaken(users, "Novo")).toBe(false);
  });
  it("acrescenta número quando o sugerido já existe, sem passar de 20 letras", () => {
    expect(uniqueNickname(users, "Ana")).toBe("Ana 2");
    expect(uniqueNickname([...users, { id: "3", nickname: "Ana 2" }], "Ana")).toBe("Ana 3");
    const longo = "a".repeat(20);
    const r = uniqueNickname([{ id: "9", nickname: longo }], longo);
    expect(r.length).toBeLessThanOrEqual(20);
    expect(r).toMatch(/ 2$/);
  });
  it("valida o tamanho", () => {
    expect(() => parseNickname("a")).toThrow();
    expect(() => parseNickname("a".repeat(21))).toThrow();
    expect(parseNickname("  Bom   Nome ")).toBe("Bom Nome");
  });
});

describe("perfil: apelido e telefone, uma vez cada", () => {
  it("troca o apelido uma vez; a segunda é recusada", async () => {
    const ok = await call("/api/perfil", { method: "PUT", user: "carlos", body: { nickname: "Carlinhos" } });
    expect(ok.status).toBe(200);
    const u = (await json(ok)).usuario;
    expect(u.nickname).toBe("Carlinhos");
    expect(u.edits).toEqual({ nickname: true });
    const again = await call("/api/perfil", { method: "PUT", user: "carlos", body: { nickname: "Carlão Mesmo" } });
    expect(again.status).toBe(403);
    expect((await json(again)).erro).toMatch(/apelido só pode ser alterado uma vez/);
    // o telefone ainda não foi usado: pode mudar uma vez
    expect((await call("/api/perfil", { method: "PUT", user: "carlos", body: { phone: "(21) 98888-7777" } })).status).toBe(200);
    expect((await call("/api/perfil", { method: "PUT", user: "carlos", body: { phone: "(21) 97777-6666" } })).status).toBe(403);
  });

  it("recusa apelido de outra pessoa, telefone inválido e pedido vazio (sem gastar a vez)", async () => {
    const dup = await call("/api/perfil", { method: "PUT", user: "bia", body: { nickname: "aninha" } });
    expect(dup.status).toBe(409);
    expect((await call("/api/perfil", { method: "PUT", user: "bia", body: { phone: "123" } })).status).toBe(400);
    expect((await call("/api/perfil", { method: "PUT", user: "bia", body: {} })).status).toBe(400);
    expect((await call("/api/perfil", { method: "PUT", user: "bia", body: { nickname: "Bia Nova" } })).status).toBe(200); // a vez continuava intacta
  });

  it("repetir o mesmo valor não gasta a vez", async () => {
    expect((await call("/api/perfil", { method: "PUT", user: "lucas", body: { nickname: "Luquinha" } })).status).toBe(400);
    expect((await json(await call("/api/eu", { user: "lucas" }))).usuario.edits).toEqual({});
  });

  it("o ranking mostra o apelido de agora", async () => {
    const d = await json(await call("/api/ranking?escopo=geral", { user: "ana" }));
    const nicks = d.rows.map((r: any) => r.nickname);
    expect(nicks).toContain("Carlinhos");
    expect(nicks).not.toContain("Carlão");
  });

  it("o admin muda dados de qualquer pessoa e libera uma nova alteração", async () => {
    expect((await call("/api/admin/usuarios/carlos", { method: "PATCH", user: "ana", body: { liberar: true } })).status).toBe(403); // jogador não pode
    expect((await call("/api/admin/usuarios/carlos", { method: "PATCH", user: "admin", body: { liberar: true, phone: "11 95555-4444" } })).status).toBe(200);
    const lista = await json(await call("/api/admin/usuarios", { user: "admin" }));
    const c = lista.usuarios.find((x: any) => x.id === "carlos");
    expect(c.phone).toBe("11955554444");
    expect(c.edits).toEqual({});
    expect((await call("/api/perfil", { method: "PUT", user: "carlos", body: { nickname: "Carlão" } })).status).toBe(200);
  });

  it("telefone e e-mail não aparecem para outros jogadores", async () => {
    const r = await json(await call("/api/ranking?escopo=geral", { user: "ana" }));
    expect(JSON.stringify(r)).not.toMatch(/@|11955554444/);
  });
});

describe("perfil: senha, uma vez", () => {
  const troca = (user: string, body: object) => call("/api/perfil/senha", { method: "POST", user, body });
  const login = (email: string, password: string) => call("/api/entrar", { method: "POST", body: { email, password } });

  it("confere a senha atual, tem as mesmas regras do cadastro e só vale uma vez", async () => {
    expect((await troca("bia", { atual: "errada123", nova: "novasenha1", confirmar: "novasenha1" })).status).toBe(400); // senha atual incorreta (400, não 401: 401 desloga)
    expect((await troca("bia", { atual: "demo1234", nova: "curta", confirmar: "curta" })).status).toBe(400);
    expect((await troca("bia", { atual: "demo1234", nova: "novasenha1", confirmar: "outra-coisa1" })).status).toBe(400);
    expect((await troca("bia", { atual: "demo1234", nova: "demo1234", confirmar: "demo1234" })).status).toBe(400);

    expect((await troca("bia", { atual: "demo1234", nova: "novasenha1", confirmar: "novasenha1" })).status).toBe(200);
    expect((await login("bia@demo.local", "demo1234")).status).toBe(401);
    expect((await login("bia@demo.local", "novasenha1")).status).toBe(200);

    const again = await troca("bia", { atual: "novasenha1", nova: "outrasenha1", confirmar: "outrasenha1" });
    expect(again.status).toBe(403);
    expect((await json(again)).erro).toMatch(/senha só pode ser alterada uma vez/);
  });

  it("errar a senha atual também conta para o bloqueio de 5 tentativas", async () => {
    for (let i = 0; i < 5; i++) expect((await troca("ana", { atual: `errada${i}xx`, nova: "novasenha1", confirmar: "novasenha1" })).status).toBe(400);
    expect((await troca("ana", { atual: "demo1234", nova: "novasenha1", confirmar: "novasenha1" })).status).toBe(429);
  });
});

describe("ganho por rodada", () => {
  it("lista as últimas rodadas e quanto cada pessoa fez em cada uma", async () => {
    const d = await json(await call("/api/ranking/rodadas", { user: "lucas" }));
    expect(d.rodadas.length).toBeGreaterThanOrEqual(2);
    expect(d.rodadas.map((r: any) => r.date)).toEqual([...d.rodadas.map((r: any) => r.date)].sort()); // da mais antiga para a mais nova
    const lucas = d.participantes.find((p: any) => p.user_id === "lucas");
    expect(lucas.porRodada[d.rodadas[0].id]).toBeGreaterThan(0);
    const soma = Object.values(lucas.porRodada).reduce((a: number, b: any) => a + b, 0) as number;
    expect(lucas.total).toBeCloseTo(soma, 2);
    const totais = d.participantes.map((p: any) => p.total);
    expect(totais).toEqual([...totais].sort((a: number, b: number) => b - a));
    expect(JSON.stringify(d)).not.toContain("@");
  });
});
