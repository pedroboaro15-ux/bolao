import { describe, expect, it } from "vitest";
import { MemoryDb } from "../src/db/memory";
import { ConflictError } from "../src/db/types";
import { SupabaseDb, filterParam, revive, serialize, splitPath, toDoc, toWrite } from "../src/db/supabase";

describe("conversões do Supabase", () => {
  it("datas: Date vai como texto ISO e volta como Date (inclusive dentro de jsonb)", () => {
    const data = { at: new Date("2026-01-02T03:04:05.000Z"), odds: { "1X2": { fetched_at: new Date("2026-01-02T03:00:00.000Z"), fair: { "1": 2.1 } } }, lista: [new Date(0)] };
    const json = JSON.parse(JSON.stringify(serialize(data)));
    expect(json.at).toBe("2026-01-02T03:04:05.000Z");
    expect(revive(json)).toEqual(data);
  });

  it("revive aceita o formato do Postgres (+00:00) e não confunde texto comum com data", () => {
    expect(revive("2026-09-29T12:00:00+00:00")).toEqual(new Date("2026-09-29T12:00:00Z"));
    expect(revive("2026-09-29")).toBe("2026-09-29"); // dia do bolão fica texto
    expect(revive("Luquinha")).toBe("Luquinha");
    expect(revive(3)).toBe(3);
    expect(revive(null)).toBeNull();
  });

  it("serialize ignora undefined, mantém null e recusa NaN", () => {
    expect(serialize({ a: undefined, b: null, c: 1 })).toEqual({ b: null, c: 1 });
    expect(() => serialize({ a: NaN })).toThrow();
  });

  it("caminho vira coleção e id (o id pode ter barra depois da primeira)", () => {
    expect(splitPath("matches/900201")).toEqual(["matches", "900201"]);
    expect(splitPath("predictions/900201_lucas")).toEqual(["predictions", "900201_lucas"]);
    expect(() => splitPath("semid")).toThrow();
  });

  it("filtros no formato do PostgREST", () => {
    expect(filterParam("==", "a b")).toBe("eq.a b");
    expect(filterParam("==", null)).toBe("is.null");
    expect(filterParam(">=", 3)).toBe("gte.3");
    expect(filterParam("in", ["a", 'b"c', "d,e"])).toBe('in.("a","b\\"c","d,e")');
  });

  it("linha da tabela vira documento: versão vira updateTime, tabelas de documento leem 'data'", () => {
    const d = toDoc("matches", { id: "9", version: 4, round_id: "r", kickoff_utc: "2026-09-29T20:00:00+00:00", odds: null, frozen_odds: { x: 1 } });
    expect(d).toEqual({ id: "9", updateTime: "4", data: { round_id: "r", kickoff_utc: new Date("2026-09-29T20:00:00Z"), odds: null, frozen_odds: { x: 1 } } });
    const s = toDoc("settings", { id: "app", version: 2, data: { oddCap: 100 } });
    expect(s).toEqual({ id: "app", updateTime: "2", data: { oddCap: 100 } });
    expect(toDoc("settings", { id: "app", version: 1, data: null }).data).toEqual({});
  });

  it("escritas viram os itens do lote (apply_writes)", () => {
    expect(toWrite({ op: "set", path: "users/u1", data: { name: "Ana", created_at: new Date(0) }, mustNotExist: true })).toEqual({
      op: "set", coll: "users", id: "u1", data: { name: "Ana", created_at: "1970-01-01T00:00:00.000Z" }, must_not_exist: true,
    });
    expect(toWrite({ op: "merge", path: "invites/t", data: { uses: 1 }, updateTime: "3" })).toMatchObject({ op: "merge", coll: "invites", id: "t", update_time: "3", must_exist: false });
    expect(toWrite({ op: "delete", path: "users/u1" })).toEqual({ op: "delete", coll: "users", id: "u1" });
    expect(toWrite({ op: "increment", path: "api_usage/d", field: "calls", by: 2 })).toEqual({ op: "increment", coll: "api_usage", id: "d", field: "calls", by: 2 });
  });
});

describe("SupabaseDb (requisições)", () => {
  const stub = (respond: (url: string, init: RequestInit) => { status?: number; body?: unknown }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = respond(url, init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    return { calls, db: new SupabaseDb("https://x.supabase.co/", "sb_secret_abc", fetchImpl) };
  };

  it("get busca pelo id e manda a chave em apikey (sem Bearer para o formato novo)", async () => {
    const { calls, db } = stub(() => ({ body: [{ id: "u1", version: 2, name: "Ana", created_at: "2026-01-01T00:00:00+00:00" }] }));
    const d = await db.get("users/u1");
    expect(d).toMatchObject({ id: "u1", updateTime: "2", data: { name: "Ana", created_at: new Date("2026-01-01T00:00:00Z") } });
    expect(calls[0].url).toBe("https://x.supabase.co/rest/v1/users?select=*&id=eq.u1&limit=1");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.apikey).toBe("sb_secret_abc");
    expect(h.authorization).toBeUndefined();
  });

  it("chave no formato JWT (legado) também vai como Bearer", async () => {
    const calls: any[] = [];
    const db = new SupabaseDb("https://x.supabase.co", "eyJabc", (async (u: string, i: RequestInit) => (calls.push(i), new Response("[]"))) as unknown as typeof fetch);
    await db.get("users/u1");
    expect((calls[0].headers as any).authorization).toBe("Bearer eyJabc");
  });

  it("get devolve null quando não existe", async () => {
    const { db } = stub(() => ({ body: [] }));
    expect(await db.get("users/nada")).toBeNull();
  });

  it("getMany respeita a ordem pedida e devolve null para os que faltam", async () => {
    const { db } = stub(() => ({ body: [{ id: "b", version: 1, k: 2 }, { id: "a", version: 1, k: 1 }] }));
    const r = await db.getMany(["matches/a", "matches/x", "matches/b"]);
    expect(r.map((d) => d?.id ?? null)).toEqual(["a", null, "b"]);
  });

  it("query monta filtros, ordem e limite", async () => {
    const { calls, db } = stub(() => ({ body: [] }));
    await db.query("predictions", { where: [["user_id", "==", "u1"], ["round_id", "==", "2026-09-29"]], orderBy: [{ field: "updated_at", dir: "desc" }], limit: 50 });
    const qs = new URL(calls[0].url).searchParams;
    expect(qs.get("user_id")).toBe("eq.u1");
    expect(qs.get("round_id")).toBe("eq.2026-09-29");
    expect(qs.get("order")).toBe("updated_at.desc");
    expect(qs.get("limit")).toBe("50");
  });

  it("commit manda o lote inteiro em uma chamada; sem escritas, não chama", async () => {
    const { calls, db } = stub(() => ({}));
    await db.commit([]);
    expect(calls).toHaveLength(0);
    await db.commit([{ op: "delete", path: "users/u1" }, { op: "increment", path: "api_usage/d", field: "calls", by: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://x.supabase.co/rest/v1/rpc/apply_writes");
    expect(JSON.parse(String(calls[0].init.body)).w).toHaveLength(2);
  });

  it("conflito (PT409 / HTTP 409) vira ConflictError; outros erros mostram o motivo", async () => {
    const conflict = stub(() => ({ status: 409, body: { code: "PT409", message: "conflito" } }));
    await expect(conflict.db.commit([{ op: "delete", path: "users/u1" }])).rejects.toBeInstanceOf(ConflictError);
    const broken = stub(() => ({ status: 500, body: { message: "falhou" } }));
    await expect(broken.db.get("users/u1")).rejects.toThrow(/Supabase 500/);
  });
});

describe("MemoryDb (mesma semântica de precondições do banco real)", () => {
  it("set com mustNotExist garante unicidade", async () => {
    const db = new MemoryDb();
    await db.commit([{ op: "set", path: "users/a", data: { n: 1 }, mustNotExist: true }]);
    await expect(db.commit([{ op: "set", path: "users/a", data: { n: 2 }, mustNotExist: true }])).rejects.toBeInstanceOf(ConflictError);
    expect((await db.get("users/a"))!.data.n).toBe(1);
  });

  it("merge com updateTime detecta alteração concorrente", async () => {
    const db = new MemoryDb();
    await db.commit([{ op: "set", path: "invites/t", data: { uses: 0 } }]);
    const a = (await db.get("invites/t"))!;
    await db.commit([{ op: "merge", path: "invites/t", data: { uses: 1 }, updateTime: a.updateTime }]);
    await expect(db.commit([{ op: "merge", path: "invites/t", data: { uses: 1 }, updateTime: a.updateTime }])).rejects.toBeInstanceOf(ConflictError);
  });

  it("commit é atômico: se uma escrita falha, nenhuma é aplicada", async () => {
    const db = new MemoryDb();
    await db.commit([{ op: "set", path: "x/1", data: { a: 1 } }]);
    await expect(
      db.commit([
        { op: "set", path: "x/2", data: { a: 2 } },
        { op: "set", path: "x/1", data: { a: 9 }, mustNotExist: true },
      ]),
    ).rejects.toThrow();
    expect(await db.get("x/2")).toBeNull();
  });

  it("increment, filtros, ordenação e limite", async () => {
    const db = new MemoryDb();
    await db.commit([
      { op: "increment", path: "api_usage/d", field: "calls", by: 1 },
      { op: "increment", path: "api_usage/d", field: "calls", by: 2 },
      { op: "set", path: "m/1", data: { r: "a", k: 3 } },
      { op: "set", path: "m/2", data: { r: "a", k: 1 } },
      { op: "set", path: "m/3", data: { r: "b", k: 2 } },
    ]);
    expect((await db.get("api_usage/d"))!.data.calls).toBe(3);
    const rows = await db.query("m", { where: [["r", "==", "a"]], orderBy: [{ field: "k" }], limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(["2", "1"]);
    expect((await db.query("m", { orderBy: [{ field: "k", dir: "desc" }], limit: 1 }))[0].id).toBe("1");
  });
});
