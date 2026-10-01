import { ConflictError, type Db, type Doc, type FilterOp, type QueryOptions, type Write } from "./types";

/**
 * Banco no Supabase (Postgres) pela API REST (PostgREST), usando a chave secreta do servidor.
 * Cada coleção é uma tabela (ver schema.sql). Os campos de primeiro nível do documento são as colunas;
 * objetos e listas ficam em colunas jsonb. As tabelas de documento solto (settings e caches) guardam tudo em `data`.
 * As gravações vão em lote pela função `apply_writes` (tudo ou nada, com as precondições de conflito).
 */

const JSON_TABLES = new Set(["settings", "fixtures_cache", "team_cache"]);
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** Texto de data e hora vira Date (o Postgres devolve timestamptz e o jsonb guarda as datas como texto ISO). */
export function revive(v: unknown): any {
  if (typeof v === "string") return ISO_DATETIME.test(v) ? new Date(v) : v;
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = revive(x);
    return out;
  }
  return v;
}

/** Date vira texto ISO; campos undefined somem; null continua null. */
export function serialize(v: unknown): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = serialize(x);
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("Número inválido para o banco");
  return v;
}

export function splitPath(path: string): [string, string] {
  const i = path.indexOf("/");
  if (i <= 0 || i === path.length - 1) throw new Error(`Caminho inválido: ${path}`);
  return [path.slice(0, i), path.slice(i + 1)];
}

const OPS: Record<Exclude<FilterOp, "in">, string> = { "==": "eq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
const scalar = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const quote = (v: unknown) => `"${scalar(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Valor do filtro no formato do PostgREST (coluna=op.valor). */
export function filterParam(op: FilterOp, value: unknown): string {
  if (op === "in") return `in.(${(value as unknown[]).map(quote).join(",")})`;
  if (value === null && op === "==") return "is.null";
  return `${OPS[op]}.${scalar(value)}`;
}

/** Linha da tabela → documento (a versão da linha vira o `updateTime` das precondições). */
export function toDoc<T = any>(coll: string, row: Record<string, any>): Doc<T> {
  const { id, version, data, ...rest } = row;
  return { id: String(id), data: revive(JSON_TABLES.has(coll) ? (data ?? {}) : rest) as T, updateTime: String(version ?? 0) };
}

/** Escrita → item do lote enviado a `apply_writes`. */
export function toWrite(w: Write): Record<string, unknown> {
  const [coll, id] = splitPath(w.path);
  switch (w.op) {
    case "set":
      return { op: "set", coll, id, data: serialize(w.data), must_not_exist: !!w.mustNotExist };
    case "merge":
      return { op: "merge", coll, id, data: serialize(w.data), must_exist: !!w.mustExist, update_time: w.updateTime ?? null };
    case "delete":
      return { op: "delete", coll, id };
    case "increment":
      return { op: "increment", coll, id, field: w.field, by: w.by };
  }
}

export class SupabaseDb implements Db {
  private base: string;

  constructor(
    url: string,
    private key: string,
    private fetchImpl: typeof fetch == (input, init) => fetch(input, init),
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1`;
  }

  private headers(): Record<string, string> {
    // Chaves no formato antigo (JWT) também vão como Bearer; as novas (sb_secret_...) só em apikey.
    const h: Record<string, string> = { apikey: this.key, "content-type": "application/json", accept: "application/json" };
    if (this.key.startsWith("eyJ")) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetchImpl(`${this.base}/${path}`, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 409 || /"code"\s*:\s*"PT409"/.test(text)) throw new ConflictError();
      throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async get<T = any>(path: string): Promise<Doc<T> | null> {
    const [coll, id] = splitPath(path);
    const rows = await this.request(`${coll}?${new URLSearchParams({ select: "*", id: filterParam("==", id), limit: "1" })}`);
    return rows?.[0] ? toDoc<T>(coll, rows[0]) : null;
  }

  async getMany<T = any>(paths: string[]): Promise<(Doc<T> | null)[]> {
    const byColl = new Map<string, string[]>();
    for (const p of paths) {
      const [coll, id] = splitPath(p);
      byColl.set(coll, [...(byColl.get(coll) ?? []), id]);
    }
    const found = new Map<string, Doc<T>>();
    for (const [coll, ids] of byColl) {
      // Em blocos, para a lista de ids não estourar o tamanho da URL.
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const rows = await this.request(`${coll}?${new URLSearchParams({ select: "*", id: filterParam("in", chunk) })}`);
        for (const row of rows ?? []) found.set(`${coll}/${row.id}`, toDoc<T>(coll, row));
      }
    }
    return paths.map((p) => found.get(p) ?? null);
  }

  async query<T = any>(collection: string, options: QueryOptions = {}): Promise<Doc<T>[]> {
    const qs = new URLSearchParams({ select: "*" });
    for (const [field, op, value] of options.where ?? []) qs.append(field, filterParam(op, value));
    if (options.orderBy?.length) qs.set("order", options.orderBy.map((o) => `${o.field}.${o.dir === "desc" ? "desc" : "asc"}`).join(","));
    if (options.limit) qs.set("limit", String(options.limit));
    const rows = await this.request(`${collection}?${qs}`);
    return (rows ?? []).map((r: Record<string, any>) => toDoc<T>(collection, r));
  }

  async commit(writes: Write[]): Promise<void> {
    if (writes.length === 0) return;
    await this.request("rpc/apply_writes", { method: "POST", body: JSON.stringify({ w: writes.map(toWrite) }) });
  }
}
