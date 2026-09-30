import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MemoryDb } from "../src/db/memory";
import { Repo } from "../src/db/repo";
import type { Write } from "../src/db/types";
import type { Env } from "../src/types";

// O Postgres ignora em silêncio campo que não tem coluna (jsonb_populate_record). Este teste lê o schema.sql e
// confere, em cada gravação que o app faz, se todos os campos têm coluna. Assim ninguém perde dado sem perceber.

const sql = readFileSync("schema.sql", "utf8");
const tables = new Map<string, Set<string>>();
for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
  const cols = new Set<string>();
  for (const line of m[2].split("\n")) {
    const c = /^\s{2}([a-z_0-9]+)\s+(text|integer|bigint|boolean|double|jsonb|timestamptz)/.exec(line);
    if (c) cols.add(c[1]);
  }
  tables.set(m[1], cols);
}
const JSON_TABLES = new Set(["settings", "fixtures_cache", "team_cache"]);

const problems: string[] = [];
const seenColls = new Set<string>();
const check = (w: Write) => {
  const [coll] = w.path.split("/");
  seenColls.add(coll);
  const cols = tables.get(coll);
  if (!cols) return problems.push(`coleção sem tabela: ${coll}`);
  if (w.op === "increment") return cols.has(w.field) || problems.push(`${coll}.${w.field} (incremento) sem coluna`);
  if (w.op === "delete" || JSON_TABLES.has(coll)) return;
  for (const [k, v] of Object.entries(w.data)) if (v !== undefined && !cols.has(k)) problems.push(`${coll}.${k} sem coluna`);
};

describe("schema.sql cobre tudo que o app grava", () => {
  it("o arquivo tem as 11 tabelas esperadas", () => {
    expect([...tables.keys()].sort()).toEqual(["api_usage", "fixtures_cache", "invites", "matches", "predictions", "push_subs", "rounds", "settings", "standings", "team_cache", "users"]);
    expect(tables.get("predictions")).toContain("pick_1x2");
  });

  beforeAll(async () => {
    const original = MemoryDb.prototype.commit;
    MemoryDb.prototype.commit = async function (this: MemoryDb, writes: Write[]) {
      writes.forEach(check);
      return original.call(this, writes);
    };
    const app = createApp();
    const env = { DEV_MEMORY: "1" } as unknown as Env;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const call = (path: string, user: string, method = "GET", body?: unknown) =>
      app.request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `bolao_sessao=dev.${user}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env, ctx);
    const json = async (r: Response) => (await r.json()) as any;

    // rodada, palpites (só vencedor, gols, placar, coringa), resultado, anular, recalcular
    const d = await json(await call("/api/rodada/atual", "bia"));
    const rid = d.rodada.id;
    await call(`/api/rodadas/${rid}/palpites`, "bia", "PUT", { palpites: [{ match_id: "900204", pick_1x2: "1", mode: null }, { match_id: "900205", pick_1x2: "2", mode: "ou", pick_ou: "under", joker: true }, { match_id: "900206", pick_1x2: "1", mode: "cs", home_goals: 2, away_goals: 0 }] });
    await call("/api/admin/jogos/900204/resultado", "admin", "PUT", { home_goals: 1, away_goals: 0 });
    await call("/api/admin/jogos/900205/anular", "admin", "POST", { anular: true });
    await call(`/api/admin/rodadas/${rid}/recalcular`, "admin", "POST");
    await call("/api/admin/jogos/900206/odds", "admin", "PUT", { "1": 1.8, X: 3.5, "2": 4.5, over: 1.9, under: 1.9 });
    await call("/api/admin/rodadas/" + rid, "admin", "PATCH", { status: "closed" });
    // convite + cadastro + papel + remoção
    const inv = await json(await call("/api/admin/convites", "admin", "POST", { max_uses: 1, dias: 3 }));
    await app.request(`http://localhost/api/convite/${inv.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Novo Amigo", nickname: "Novato", email: "novo@x.com", password: "senha1234" }) }, env, ctx);
    await call(`/api/admin/convites/${inv.token}`, "admin", "DELETE");
    // configuração (congela os extras dos jogos iniciados) e push
    await call("/api/admin/config", "admin", "PUT", { goalsEnabled: false, oddCap: 120 });
    await call("/api/push/inscrever", "lucas", "POST", { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } });
    await call("/api/admin/usuarios/bia", "admin", "DELETE");
    // criação de rodada pelo admin (jogos do dia em cache no demo)
    const dia = await json(await call("/api/admin/jogos-do-dia", "admin"));
    await call("/api/admin/config", "admin", "PUT", { maxMatchesPerDay: 30 });
    await call("/api/admin/rodadas", "admin", "POST", { date: dia.date, title: "Extra", fixtureIds: dia.jogos.slice(0, 2).map((j: any) => j.id), open: true });
    await call("/api/times/1", "lucas");
    await new Repo(new MemoryDb()).addUsage("2026-09-30", "api-football"); // contador de uso da API
  });

  it("nenhuma gravação usa campo ou tabela que o schema não tem", () => {
    expect(problems).toEqual([]);
  });

  it("o teste realmente exercitou as tabelas principais", () => {
    for (const t of ["users", "invites", "rounds", "matches", "predictions", "standings", "settings", "push_subs", "api_usage"]) {
      expect(seenColls.has(t), t).toBe(true);
    }
  });
});
