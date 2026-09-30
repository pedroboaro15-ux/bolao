// Contrato de acesso ao banco. Duas implementações: Supabase (Postgres, REST) e memória (testes e modo demo).

export interface Doc<T = any> {
  id: string;
  data: T;
  /** Versão do documento, usada como precondição (concorrência otimista). */
  updateTime: string;
}

export type Write =
  /** Substitui o documento inteiro. `mustNotExist` garante unicidade. */
  | { op: "set"; path: string; data: Record<string, any>; mustNotExist?: boolean }
  /** Mescla campos de primeiro nível. `updateTime` só grava se ninguém mexeu antes. */
  | { op: "merge"; path: string; data: Record<string, any>; updateTime?: string; mustExist?: boolean }
  | { op: "delete"; path: string }
  /** Incremento atômico de um campo numérico. */
  | { op: "increment"; path: string; field: string; by: number };

export type FilterOp = "==" | "<" | "<=" | ">" | ">=" | "in";

export interface QueryOptions {
  where?: [field: string, op: FilterOp, value: any][];
  orderBy?: { field: string; dir?: "asc" | "desc" }[];
  limit?: number;
}

export interface Db {
  get<T = any>(path: string): Promise<Doc<T> | null>;
  getMany<T = any>(paths: string[]): Promise<(Doc<T> | null)[]>;
  query<T = any>(collection: string, options?: QueryOptions): Promise<Doc<T>[]>;
  commit(writes: Write[]): Promise<void>;
}

/** Precondição falhou (documento já existe, ou foi alterado por outra requisição). */
export class ConflictError extends Error {
  constructor(message = "Conflito ao gravar no banco") {
    super(message);
    this.name = "ConflictError";
  }
}
