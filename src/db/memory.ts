import { ConflictError, type Db, type Doc, type QueryOptions, type Write } from "./types";

interface Stored {
  data: Record<string, any>;
  version: number;
}

/** Banco em memória com a mesma semântica de precondições do banco real (testes e modo demo). */
export class MemoryDb implements Db {
  private docs = new Map<string, Stored>();
  private counter = 0;

  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  private toDoc<T>(path: string, s: Stored): Doc<T> {
    return { id: path.split("/").pop()!, data: this.clone(s.data) as T, updateTime: String(s.version) };
  }

  async get<T = any>(path: string): Promise<Doc<T> | null> {
    const s = this.docs.get(path);
    return s ? this.toDoc<T>(path, s) : null;
  }

  async getMany<T = any>(paths: string[]): Promise<(Doc<T> | null)[]> {
    return Promise.all(paths.map((p) => this.get<T>(p)));
  }

  async query<T = any>(collection: string, options: QueryOptions = {}): Promise<Doc<T>[]> {
    let rows: { path: string; s: Stored }[] = [];
    for (const [path, s] of this.docs) {
      const parts = path.split("/");
      if (parts.length === 2 && parts[0] === collection) rows.push({ path, s });
    }
    for (const [field, op, value] of options.where ?? []) {
      rows = rows.filter(({ s }) => {
        const v = s.data[field];
        switch (op) {
          case "==":
            return v instanceof Date && value instanceof Date ? v.getTime() === value.getTime() : v === value;
          case "in":
            return Array.isArray(value) && value.includes(v);
          case "<":
            return v !== undefined && v < value;
          case "<=":
            return v !== undefined && v <= value;
          case ">":
            return v !== undefined && v > value;
          case ">=":
            return v !== undefined && v >= value;
        }
      });
    }
    const order = options.orderBy ?? [];
    if (order.length) {
      rows.sort((a, b) => {
        for (const o of order) {
          const av = a.s.data[o.field];
          const bv = b.s.data[o.field];
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return o.dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (options.limit) rows = rows.slice(0, options.limit);
    return rows.map(({ path, s }) => this.toDoc<T>(path, s));
  }

  async commit(writes: Write[]): Promise<void> {
    // Valida tudo antes de aplicar, para o commit ser atômico.
    for (const w of writes) {
      const cur = this.docs.get(w.path);
      if (w.op === "set" && w.mustNotExist && cur) throw new ConflictError();
      if (w.op === "merge") {
        if (w.mustExist && !cur) throw new ConflictError();
        if (w.updateTime !== undefined && (!cur || String(cur.version) !== w.updateTime)) throw new ConflictError();
      }
    }
    for (const w of writes) {
      const cur = this.docs.get(w.path);
      const version = ++this.counter;
      switch (w.op) {
        case "set":
          this.docs.set(w.path, { data: this.clone(w.data), version });
          break;
        case "merge": {
          const data = { ...(cur?.data ?? {}), ...this.clone(w.data) };
          for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
          this.docs.set(w.path, { data, version });
          break;
        }
        case "delete":
          this.docs.delete(w.path);
          break;
        case "increment": {
          const data = { ...(cur?.data ?? {}) };
          data[w.field] = (Number(data[w.field]) || 0) + w.by;
          this.docs.set(w.path, { data, version });
          break;
        }
      }
    }
  }
}
