import type { Env } from "./types";
import { SupabaseDb } from "./db/supabase";
import { Repo } from "./db/repo";
import { SupabaseAuth, type AuthProvider } from "./auth/provider";
import { getDemo } from "./dev";
import { HttpError } from "./lib/errors";

export interface Ctx {
  repo: Repo;
  auth: AuthProvider;
}

let prod: { key: string; ctx: Ctx } | null = null;

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Monta banco + login. Em DEV_MEMORY=1 usa memória (recusa fora de localhost). */
export async function buildCtx(env: Env, hostname?: string): Promise<Ctx> {
  if (env.DEV_MEMORY === "1") {
    if (hostname && !LOCAL.has(hostname)) throw new HttpError(500, "DEV_MEMORY só pode ser usado em localhost. Remova essa variável em produção.");
    const demo = await getDemo();
    return { repo: demo.repo, auth: demo.auth };
  }
  if (!env.SUPABASE_URL || env.SUPABASE_URL.startsWith("COLOQUE")) throw new HttpError(503, "SUPABASE_URL não configurada (wrangler.toml)");
  if (!env.SUPABASE_SERVICE_KEY) throw new HttpError(503, "Secret SUPABASE_SERVICE_KEY não configurado");
  if (!env.SESSION_SECRET) throw new HttpError(503, "Secret SESSION_SECRET não configurado");
  const key = `${env.SUPABASE_URL}:${env.SUPABASE_SERVICE_KEY.length}:${env.SESSION_SECRET.length}`;
  if (prod?.key === key) return prod.ctx;
  const ctx: Ctx = {
    repo: new Repo(new SupabaseDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)),
    auth: new SupabaseAuth(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, env.SESSION_SECRET),
  };
  prod = { key, ctx };
  return ctx;
}
