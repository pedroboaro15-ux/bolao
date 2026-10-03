import { ConflictError, type Db } from "../db/types";

/**
 * Limites rígidos guardados no banco (o Worker não guarda nada entre execuções, então contar na memória não segura ninguém).
 * Cada vaga é um documento `rate_limits/{chave}:{janela}:{n}` criado com "só se não existir": o banco garante que
 * duas pessoas ao mesmo tempo nunca pegam a mesma vaga. Acabaram as vagas da janela → bloqueado até a janela virar.
 */

export interface Slot {
  ok: boolean;
  /** Quando a janela atual acaba (e novas vagas aparecem). */
  resetAt: Date;
  /** Devolve só esta vaga. */
  release: () => Promise<void>;
  /** Devolve todas as vagas desta chave na janela atual (ex.: acertou a senha: os erros anteriores deixam de contar). */
  clear: () => Promise<void>;
}

export async function takeSlot(db: Db, key: string, limit: number, windowMs: number, now = new Date()): Promise<Slot> {
  const bucket = Math.floor(now.getTime() / windowMs);
  const resetAt = new Date((bucket + 1) * windowMs);
  for (let n = 1; n <= limit; n++) {
    const path = `rate_limits/${key}:${bucket}:${n}`;
    try {
      await db.commit([{ op: "set", path, data: { created_at: now }, mustNotExist: true }]);
      return {
        ok: true,
        resetAt,
        release: () => db.commit([{ op: "delete", path }]),
        clear: () => db.commit(Array.from({ length: limit }, (_, i) => ({ op: "delete" as const, path: `rate_limits/${key}:${bucket}:${i + 1}` }))),
      };
    } catch (e) {
      if (!(e instanceof ConflictError)) {
        // Banco fora ou tabela rate_limits ainda não criada (schema.sql não rodado): não trava o site; só registra.
        console.error("limite indisponível:", (e as Error)?.message);
        return { ok: true, resetAt, release: async () => {}, clear: async () => {} };
      }
    }
  }
  return { ok: false, resetAt, release: async () => {}, clear: async () => {} };
}

/** Texto curto de quanto falta, para a mensagem ao usuário. */
export function waitText(resetAt: Date, now = new Date()): string {
  const s = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
  return s < 90 ? `${s} segundos` : `${Math.ceil(s / 60)} minutos`;
}

/** Identificador curto e irreversível de um e-mail (o e-mail em si não vai para a tabela de limites). */
export async function emailKey(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Apaga vagas antigas (rodar de vez em quando, no cron). Devolve quantas apagou. */
export async function purgeRateLimits(db: Db, now = new Date(), olderThanMs = 3 * 3600_000, max = 100): Promise<number> {
  const old = await db.query("rate_limits", { where: [["created_at", "<", new Date(now.getTime() - olderThanMs)]], limit: max });
  if (old.length) await db.commit(old.map((d) => ({ op: "delete" as const, path: `rate_limits/${d.id}` })));
  return old.length;
}

export interface Limits {
  signupPerMinute: number;
  loginFails: number;
  loginWindowMs: number;
}

/** Valores padrão: 2 cadastros por minuto no site todo; 5 tentativas de login por conta a cada 15 minutos. */
export function limitsOf(env: { LIMIT_SIGNUP_PER_MIN?: string; LIMIT_LOGIN_FAILS?: string }): Limits {
  const n = (v: string | undefined, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { signupPerMinute: n(env.LIMIT_SIGNUP_PER_MIN, 2), loginFails: n(env.LIMIT_LOGIN_FAILS, 5), loginWindowMs: 15 * 60_000 };
}
