import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { parseOdds } from "../src/services/apifootball";
import { buildOdds } from "../src/lib/odds";
import { SupabaseAuth, signSession, verifySessionToken } from "../src/auth/provider";
import { roundRows, sortRows, sumRows } from "../src/services/standings";
import { computeStats } from "../src/lib/stats";
import { needsOdds } from "../src/services/rounds";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { parseSignup } from "../src/routes/public";

const bet = (name: string, values: [string, string][]) => ({ name, values: values.map(([value, odd]) => ({ value, odd })) });
const book = (name: string, h: string, x: string, a: string, over?: string, under?: string) => ({
  name,
  bets: [
    bet("Match Winner", [["Home", h], ["Draw", x], ["Away", a]]),
    ...(over ? [bet("Goals Over/Under", [["Over 2.5", over], ["Under 2.5", under!], ["Over 1.5", "1.3"]])] : []),
  ],
});

describe("leitura das odds da API-Football", () => {
  it("prefere Pinnacle", () => {
    const m = parseOdds([{ bookmakers: [book("Bet365", "2.0", "3.4", "3.8"), book("Pinnacle", "2.1", "3.5", "3.9", "1.9", "2.0")] }]);
    expect(m["1X2"]).toEqual({ source: "Pinnacle", raw: { "1": 2.1, X: 3.5, "2": 3.9 } });
    expect(m.OU25!.raw).toEqual({ over: 1.9, under: 2 });
  });

  it("sem Pinnacle/Betfair usa a mediana das casas", () => {
    const m = parseOdds([{ bookmakers: [book("A", "2.0", "3.0", "4.0"), book("B", "2.2", "3.2", "3.8"), book("C", "2.4", "3.4", "3.6")] }]);
    expect(m["1X2"]!.source).toMatch(/mediana de 3/);
    expect(m["1X2"]!.raw).toEqual({ "1": 2.2, X: 3.2, "2": 3.8 });
  });

  it("lê o placar exato (1:0 → 1-0) e ignora mercado incompleto", () => {
    const m = parseOdds([
      { bookmakers: [{ name: "X", bets: [bet("Exact Score", [["1:0", "7.5"], ["2:1", "9"], ["0:0", "11"]]), bet("Match Winner", [["Home", "2"], ["Draw", "3"]])] }] },
    ]);
    expect(m.CS!.raw).toEqual({ "1-0": 7.5, "2-1": 9, "0-0": 11 });
    expect(m["1X2"]).toBeUndefined();
  });

  it("resposta vazia não quebra", () => {
    expect(parseOdds([])).toEqual({});
  });
});

describe("cookie de sessão (HS256)", () => {
  const secret = "um-segredo-bem-longo-com-mais-de-trinta-e-dois-caracteres";
  const key = (s: string) => new TextEncoder().encode(s);

  it("aceita cookie válido e recusa vencido, adulterado, segredo errado e lixo", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const ok = await signSession("uid-1", secret, now);
    expect(await verifySessionToken(ok, secret, now)).toBe("uid-1");
    expect(await verifySessionToken(ok, secret, new Date("2026-10-13T12:00:00Z"))).toBe("uid-1"); // 13 dias depois ainda vale
    expect(await verifySessionToken(ok, secret, new Date("2026-10-15T12:00:00Z"))).toBeNull(); // 15 dias: venceu
    expect(await verifySessionToken(ok, "outro-segredo-tambem-bem-longo-0123456789abcdef", now)).toBeNull();
    expect(await verifySessionToken(ok.slice(0, -3) + "abc", secret, now)).toBeNull();
    expect(await verifySessionToken("lixo", secret, now)).toBeNull();
  });

  it("recusa token sem assinatura (alg none) e assinado com outro algoritmo", async () => {
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: "x", exp: 9999999999 })).toString("base64url") + ".";
    expect(await verifySessionToken(none, secret)).toBeNull();
    const hs512 = await new SignJWT({}).setProtectedHeader({ alg: "HS512" }).setSubject("x").setExpirationTime("1h").sign(key(secret));
    expect(await verifySessionToken(hs512, secret)).toBeNull();
  });

  it("segredo curto é erro de configuração, não sessão inválida", async () => {
    await expect(signSession("u", "curto")).rejects.toThrow(/SESSION_SECRET/);
    await expect(verifySessionToken("qualquer", "curto")).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("Supabase Auth", () => {
  const secret = "um-segredo-bem-longo-com-mais-de-trinta-e-dois-caracteres";
  const make = (respond: (url: string, init: RequestInit) => { status?: number; body?: unknown }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = respond(url, init);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    return { calls, auth: new SupabaseAuth("https://x.supabase.co", "sb_secret_abc", secret, f) };
  };

  it("login confere no Supabase e devolve um cookie que o site reconhece", async () => {
    const { calls, auth } = make(() => ({ body: { access_token: "t", user: { id: "u-123" } } }));
    const s = await auth.signIn("ana@x.com", "senha1234");
    expect(s.uid).toBe("u-123");
    expect(await auth.verifySession(s.cookie)).toBe("u-123");
    expect(calls[0].url).toBe("https://x.supabase.co/auth/v1/token?grant_type=password");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "ana@x.com", password: "senha1234" });
  });

  it("senha errada vira 401 em português", async () => {
    const { auth } = make(() => ({ status: 400, body: { error_code: "invalid_credentials", msg: "Invalid login credentials" } }));
    await expect(auth.signIn("a@x.com", "errada123")).rejects.toMatchObject({ status: 401, message: "E-mail ou senha incorretos" });
  });

  it("cria usuário já confirmado; e-mail repetido vira 409", async () => {
    const ok = make(() => ({ body: { id: "novo-id" } }));
    expect(await ok.auth.createUser("n@x.com", "senha1234", "Novato")).toBe("novo-id");
    const sent = JSON.parse(String(ok.calls[0].init.body));
    expect(sent).toMatchObject({ email: "n@x.com", email_confirm: true });
    expect(ok.calls[0].url).toBe("https://x.supabase.co/auth/v1/admin/users");
    const dup = make(() => ({ status: 422, body: { error_code: "email_exists" } }));
    await expect(dup.auth.createUser("n@x.com", "senha1234", "N")).rejects.toMatchObject({ status: 409 });
  });

  it("apagar usuário e recuperar senha usam as rotas certas; recuperar nunca falha para quem chama", async () => {
    const del = make(() => ({}));
    await del.auth.deleteUser("u/1");
    expect(del.calls[0]).toMatchObject({ url: "https://x.supabase.co/auth/v1/admin/users/u%2F1" });
    expect(del.calls[0].init.method).toBe("DELETE");
    const rec = make(() => ({ status: 500, body: {} }));
    await expect(rec.auth.sendPasswordReset("a@x.com")).resolves.toBeUndefined();
  });

  it("senha nova usa o token do link (não a chave do servidor) e valida o tamanho", async () => {
    const { calls, auth } = make(() => ({ body: {} }));
    await auth.setPassword("token-do-link", "novasenha123");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer token-do-link");
    expect(calls[0].init.method).toBe("PUT");
    await expect(auth.setPassword("t", "curta")).rejects.toMatchObject({ status: 400 });
    const expired = make(() => ({ status: 401, body: { error_code: "bad_jwt" } }));
    await expect(expired.auth.setPassword("velho", "novasenha123")).rejects.toMatchObject({ status: 401 });
  });
});

describe("ranking", () => {
  it("ordena por pontos, depois por acertos", () => {
    const rows = sortRows([
      { user_id: "a", nickname: "A", points: 3, hits: 1 },
      { user_id: "b", nickname: "B", points: 3, hits: 4 },
      { user_id: "c", nickname: "C", points: 5.5, hits: 0 },
    ]);
    expect(rows.map((r) => r.user_id)).toEqual(["c", "b", "a"]);
  });

  it("soma rodadas e ignora jogos sem resultado", () => {
    const nick = new Map([["a", "A"], ["b", "B"]]);
    const r1 = roundRows(
      [
        { user_id: "a", points: 1.25, hits: 1 },
        { user_id: "a", points: null, hits: null },
        { user_id: "b", points: 0, hits: 0 },
      ],
      nick,
    );
    expect(r1.find((r) => r.user_id === "a")!.points).toBe(1.25);
    const total = sumRows([r1, [{ user_id: "a", nickname: "A", points: 0.1, hits: 1 }]]);
    expect(total[0]).toMatchObject({ user_id: "a", points: 1.35, hits: 2 });
  });
});

describe("estatísticas do participante", () => {
  it("calcula % de acerto, melhor rodada e maior zebra", () => {
    const matches = new Map([
      ["m1", { id: "m1", home: { name: "A" }, away: { name: "B" }, voided: false }],
      ["m2", { id: "m2", home: { name: "C" }, away: { name: "D" }, voided: false }],
      ["m3", { id: "m3", home: { name: "E" }, away: { name: "F" }, voided: true }],
    ]);
    const s = computeStats(
      [
        { match_id: "m1", round_id: "r1", points: 0.8, hits: 1, parts: { winner: 0.8, ou: 0, cs: 0 } },
        { match_id: "m2", round_id: "r2", points: 9.5, hits: 1, parts: { winner: 0, ou: 0, cs: 9.5 } },
        { match_id: "m3", round_id: "r2", points: 0, hits: 0, parts: null },
        { match_id: "m4", round_id: "r2", points: null, hits: null },
      ],
      matches,
    );
    expect(s.palpites_pontuados).toBe(2);
    expect(s.acerto_pct).toBe(100);
    expect(s.melhor_rodada).toEqual({ round_id: "r2", pontos: 9.5 });
    expect(s.maior_zebra).toEqual({ odd: 10.5, tipo: "placar", jogo: "C x D" });
    expect(computeStats([], new Map()).acerto_pct).toBeNull();
  });
});

describe("agenda de atualização das odds", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const odds = (ageMin: number) => buildOdds({ "1X2": { source: "t", raw: { "1": 2, X: 3, "2": 4 } } }, new Date(now.getTime() - ageMin * 60_000))!;
  const at = (hours: number, o: ReturnType<typeof odds> | null) => ({ kickoff_utc: new Date(now.getTime() + hours * 3600_000), odds: o, voided: false });

  it("busca odds de jogo que ainda não tem, mesmo longe", () => {
    expect(needsOdds(at(30, null), DEFAULT_SETTINGS, now)).toBe(true);
  });
  it("respeita a janela e o intervalo", () => {
    expect(needsOdds(at(30, odds(10)), DEFAULT_SETTINGS, now)).toBe(false); // fora da janela de 12 h
    expect(needsOdds(at(8, odds(60)), DEFAULT_SETTINGS, now)).toBe(false); // atualizado há 1 h (< 3 h)
    expect(needsOdds(at(8, odds(200)), DEFAULT_SETTINGS, now)).toBe(true);
  });
  it("tira uma foto final perto do jogo e nunca depois do kickoff", () => {
    expect(needsOdds(at(1, odds(45)), DEFAULT_SETTINGS, now)).toBe(true);
    expect(needsOdds(at(1, odds(10)), DEFAULT_SETTINGS, now)).toBe(false);
    expect(needsOdds(at(-0.1, odds(999)), DEFAULT_SETTINGS, now)).toBe(false);
  });
});

describe("cadastro", () => {
  const ok = { email: " ANA@x.com ", phone: "(11) 91234-5678", password: "12345678", confirm: "12345678" };
  it("valida os campos", () => {
    const r = parseSignup({ ...ok, nickname: "Aninha" });
    expect(r).toMatchObject({ email: "ana@x.com", phone: "11912345678", nickname: "Aninha" });
    expect(parseSignup(ok).nickname).toBe("ana"); // sem apelido: vem do e-mail
    expect(parseSignup({ ...ok, phone: "+55 (21) 3333-4444" }).phone).toBe("2133334444");
    expect(() => parseSignup({ ...ok, nickname: "A" })).toThrow();
    expect(() => parseSignup({ ...ok, email: "sem-arroba" })).toThrow();
    expect(() => parseSignup({ ...ok, phone: "12345" })).toThrow();
    expect(() => parseSignup({ ...ok, password: "1234567", confirm: "1234567" })).toThrow();
    expect(() => parseSignup({ ...ok, confirm: "87654321" })).toThrow(/não são iguais/);
  });
});
