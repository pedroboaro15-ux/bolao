import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";

// Modo demo: banco em memória com dados de mentira (rodada de ontem encerrada + rodada de hoje aberta).
const app = createApp();
// Os testes de cadastro criam várias contas no mesmo minuto: o limite padrão (2 por minuto) é testado em test/limits.test.ts.
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
const json = async (res: Response) => (await res.json()) as any;

describe("login e acesso", () => {
  it("recusa senha errada e aceita a certa (cookie httpOnly)", async () => {
    const bad = await call("/api/entrar", { method: "POST", body: { email: "lucas@demo.local", password: "errada123" } });
    expect(bad.status).toBe(401);
    const ok = await call("/api/entrar", { method: "POST", body: { email: "lucas@demo.local", password: "demo1234" } });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/bolao_sessao=dev\.lucas/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it("rotas protegidas exigem login", async () => {
    expect((await call("/api/rodada/atual")).status).toBe(401);
    expect((await call("/api/rodada/atual", { user: "fantasma" })).status).toBe(401);
  });

  it("participante comum não acessa o admin", async () => {
    expect((await call("/api/admin/usuarios", { user: "lucas" })).status).toBe(403);
    expect((await call("/api/admin/usuarios", { user: "admin" })).status).toBe(200);
  });
});

describe("palpites e trava no kickoff", () => {
  it("rodada atual traz jogos com odds e marca os que já começaram", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "bia" }));
    expect(d.rodada.status).toBe("open");
    expect(d.jogos).toHaveLength(6);
    const started = d.jogos.find((j: any) => j.id === "900202");
    const future = d.jogos.find((j: any) => j.id === "900204");
    expect(started.locked).toBe(true);
    expect(future.locked).toBe(false);
    expect(future.odds_1x2["1"]).toBeGreaterThan(1);
    expect(Object.keys(future.cs).length).toBe(100);
  });

  it("servidor recusa palpite em jogo que já começou, mesmo se o front mandar", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "bia" }));
    const res = await call(`/api/rodadas/${d.rodada.id}/palpites`, {
      method: "PUT",
      user: "bia",
      body: { palpites: [{ match_id: "900202", pick_1x2: "1", mode: "ou", pick_ou: "over" }, { match_id: "900204", pick_1x2: "1", mode: "ou", pick_ou: "under" }] },
    });
    const r = await json(res);
    expect(r.erros["900202"]).toMatch(/travado/i);
    expect(r.salvos).toEqual(["900204"]);
    const again = await json(await call("/api/rodada/atual", { user: "bia" }));
    expect(again.jogos.find((j: any) => j.id === "900204").mine.pick_ou).toBe("under");
    expect(again.jogos.find((j: any) => j.id === "900202").mine).toBeNull();
  });

  it("recusa placar incoerente com o vencedor", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "bia" }));
    const r = await json(
      await call(`/api/rodadas/${d.rodada.id}/palpites`, {
        method: "PUT",
        user: "bia",
        body: { palpites: [{ match_id: "900205", pick_1x2: "1", mode: "cs", home_goals: 0, away_goals: 2 }] },
      }),
    );
    expect(r.salvos).toEqual([]);
    expect(r.erros["900205"]).toMatch(/combina/);
  });

  it("coringa foi excluído: o servidor ignora e grava sem coringa", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "carlos" }));
    const r = await json(await call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", user: "carlos", body: { palpites: [{ match_id: "900204", pick_1x2: "1", mode: null, joker: true }, { match_id: "900206", pick_1x2: "1", mode: null, joker: true }] } }));
    expect(r.salvos.sort()).toEqual(["900204", "900206"]);
    const after = await json(await call("/api/rodada/atual", { user: "carlos" }));
    expect(after.coringa).toBeUndefined();
    expect(after.jogos.find((j: any) => j.id === "900204").mine).not.toHaveProperty("joker");
  });

  it("palpites dos outros só aparecem depois do kickoff", async () => {
    const before = await json(await call("/api/jogos/900203", { user: "bia" }));
    expect(before.jogo.locked).toBe(false);
    expect(before.palpites).toBeNull();
    const after = await json(await call("/api/jogos/900201", { user: "bia" }));
    expect(after.jogo.locked).toBe(true);
    expect(after.palpites.map((p: any) => p.nickname).sort()).toEqual(["Aninha", "Carlão", "Luquinha"]);
    expect(after.palpites.every((p: any) => typeof p.points === "number")).toBe(true);
  });
});

describe("resultados, pontos e ranking", () => {
  it("o demo já traz ranking geral com os quatro jogadores", async () => {
    const d = await json(await call("/api/ranking?escopo=geral", { user: "bia" }));
    expect(d.rows.length).toBe(4);
    const pts = d.rows.map((r: any) => r.points);
    expect([...pts].sort((a, b) => b - a)).toEqual(pts);
  });

  it("resultado manual do admin pontua os palpites e atualiza o ranking da rodada", async () => {
    const before = await json(await call("/api/ranking?escopo=rodada", { user: "bia" }));
    const lucasBefore = before.rows.find((r: any) => r.nickname === "Luquinha")?.points ?? 0;
    const res = await call("/api/admin/jogos/900203/resultado", { method: "PUT", user: "admin", body: { home_goals: 1, away_goals: 0 } });
    expect(res.status).toBe(200);
    const after = await json(await call("/api/ranking?escopo=rodada", { user: "bia" }));
    const lucas = after.rows.find((r: any) => r.nickname === "Luquinha");
    // Lucas palpitou 1 + menos de 2,5 no 900203: acertou vencedor e under
    expect(lucas.points).toBeGreaterThan(lucasBefore);
    const mine = await json(await call("/api/jogos/900203", { user: "lucas" }));
    expect(mine.jogo.mine.points).toBeGreaterThan(0);
    expect(mine.jogo.settled).toBe(true);
  });

  it("anular um jogo zera os pontos dele para todos", async () => {
    await call("/api/admin/jogos/900203/anular", { method: "POST", user: "admin", body: { anular: true } });
    const j = await json(await call("/api/jogos/900203", { user: "lucas" }));
    expect(j.jogo.voided).toBe(true);
    expect(j.jogo.mine.points).toBe(0);
  });

  it("meus palpites traz estatísticas", async () => {
    const d = await json(await call("/api/meus-palpites", { user: "lucas" }));
    expect(d.itens.length).toBeGreaterThan(5);
    expect(d.stats.palpites_pontuados).toBeGreaterThan(0);
    expect(d.stats.acerto_pct).toBeGreaterThanOrEqual(0);
    expect(d.stats.melhor_rodada.titulo).toBeTruthy();
  });
});

describe("cadastro aberto", () => {
  const signup = { email: "novo@demo.local", phone: "(11) 91234-5678", password: "senha1234", confirm: "senha1234" };

  it("cria a conta sem convite, guarda só os dígitos do telefone e já entra", async () => {
    const ok = await call("/api/cadastro", { method: "POST", body: signup });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("set-cookie")).toMatch(/bolao_sessao=/);
    const u = (await json(ok)).usuario;
    expect(u.role).toBe("player");
    expect(u.nickname).toBe("novo"); // apelido sugerido pelo e-mail
    const lista = await json(await call("/api/admin/usuarios", { user: "admin" }));
    expect(lista.usuarios.find((x: any) => x.email === "novo@demo.local").phone).toBe("11912345678");
  });

  it("usa o apelido digitado e aceita +55 no telefone", async () => {
    const ok = await call("/api/cadastro", { method: "POST", body: { ...signup, email: "ana2@demo.local", phone: "+55 21 98888-7777", nickname: "Fulaninha" } });
    expect(ok.status).toBe(201);
    expect((await json(ok)).usuario.nickname).toBe("Fulaninha");
  });

  it("recusa senhas diferentes, senha curta, telefone ou e-mail inválidos", async () => {
    const post = (b: object) => call("/api/cadastro", { method: "POST", body: { ...signup, email: "x@demo.local", ...b } });
    const diff = await post({ confirm: "outra-senha1" });
    expect(diff.status).toBe(400);
    expect((await json(diff)).erro).toMatch(/não são iguais/);
    expect((await post({ password: "curta", confirm: "curta" })).status).toBe(400);
    expect((await post({ phone: "123" })).status).toBe(400);
    expect((await post({ phone: "" })).status).toBe(400);
    expect((await post({ email: "isso-nao-e-email" })).status).toBe(400);
  });

  it("e-mail repetido é recusado", async () => {
    const dup = await call("/api/cadastro", { method: "POST", body: { ...signup, email: "lucas@demo.local" } });
    expect(dup.status).toBe(409);
  });

  it("a rota de convite não existe mais", async () => {
    expect((await call("/api/convite/qualquer", { method: "POST", body: signup })).status).toBe(401);
  });

  it("não deixa remover o último admin nem a si mesmo", async () => {
    expect((await call("/api/admin/usuarios/admin", { method: "DELETE", user: "admin" })).status).toBe(409);
    expect((await call("/api/admin/usuarios/admin/papel", { method: "POST", user: "admin", body: { role: "player" } })).status).toBe(409);
  });
});

describe("configurações do admin", () => {
  it("salva multiplicadores e valida", async () => {
    const ok = await json(await call("/api/admin/config", { method: "PUT", user: "admin", body: { winnerMultiplier: 3, oddCap: 120 } }));
    expect(ok.config.winnerMultiplier).toBe(3);
    expect(ok.config).not.toHaveProperty("jokerMultiplier");
    expect((await call("/api/admin/config", { method: "PUT", user: "admin", body: { oddCap: -5 } })).status).toBe(400);
    await call("/api/admin/config", { method: "PUT", user: "admin", body: { winnerMultiplier: 1, oddCap: 150 } });
  });
});

describe("jogos do dia no admin", () => {
  it("só lista jogos que ainda não começaram", async () => {
    const d = await json(await call("/api/admin/jogos-do-dia", { user: "admin" }));
    expect(d.jogos.every((j: any) => Date.parse(j.kickoff) > Date.now())).toBe(true);
  });
});

describe("o que é obrigatório em cada rodada", () => {
  it("rodada com vencedor + gols recusa 'só vencedor' e aceita gols ou placar exato", async () => {
    const d = await json(await call("/api/rodada/atual", { user: "bia" }));
    expect(d.rodada.required).toBe("winner");
    expect((await call(`/api/admin/rodadas/${d.rodada.id}`, { method: "PATCH", user: "admin", body: { required: "qualquer" } })).status).toBe(400);
    expect((await call(`/api/admin/rodadas/${d.rodada.id}`, { method: "PATCH", user: "admin", body: { required: "winner_goals" } })).status).toBe(200);
    const put = (p: object) => call(`/api/rodadas/${d.rodada.id}/palpites`, { method: "PUT", user: "bia", body: { palpites: [{ match_id: "900205", pick_1x2: "1", ...p }] } }).then(json);
    const so = await put({ mode: null });
    expect(so.salvos).toEqual([]);
    expect(so.erros["900205"]).toMatch(/obrigat/);
    expect((await put({ mode: "ou", pick_ou: "under" })).salvos).toEqual(["900205"]);
    expect((await put({ mode: "cs", home_goals: 2, away_goals: 0 })).salvos).toEqual(["900205"]);
    expect((await json(await call("/api/rodada/atual", { user: "bia" }))).rodada.required).toBe("winner_goals");
    await call(`/api/admin/rodadas/${d.rodada.id}`, { method: "PATCH", user: "admin", body: { required: "winner" } });
    expect((await put({ mode: null })).salvos).toEqual(["900205"]);
  });
});
