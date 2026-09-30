import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { COOKIE, forgetUser, sessionCookie, type AppEnv } from "../http";
import { ConflictError } from "../db/types";
import { HttpError, badRequest, notFound } from "../lib/errors";
import type { Invite, UserDoc } from "../types";
import type { AuthProvider } from "../auth/provider";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function setSession(c: any, cookie: string, maxAgeSec: number) {
  setCookie(c, COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: maxAgeSec,
  });
}

export const userView = (id: string, u: UserDoc) => ({ id, name: u.name, nickname: u.nickname, email: u.email, role: u.role });

/** Convite válido? Devolve o motivo em português se não for. */
export function inviteProblem(inv: Invite, now = new Date()): string | null {
  if (inv.revoked) return "Este convite foi cancelado";
  if (inv.expires_at.getTime() <= now.getTime()) return "Este convite expirou";
  if (inv.uses >= inv.max_uses) return "Este convite já foi usado";
  return null;
}

/**
 * Cadastro por convite: confere o convite, cria a conta no Auth, grava users/{uid} e consome o convite
 * numa única escrita com precondição (se dois usarem ao mesmo tempo, só um passa). Se a gravação falhar,
 * a conta recém-criada no Auth é apagada.
 */
export async function redeemInvite(
  ctx: { repo: import("../db/repo").Repo; auth: AuthProvider },
  token: string,
  input: { name: string; nickname: string; email: string; password: string },
  now = new Date(),
) {
  const { repo, auth } = ctx;
  const inv = await repo.invite(token);
  if (!inv) throw notFound("Convite não encontrado");
  const problem = inviteProblem(inv.data, now);
  if (problem) throw new HttpError(410, problem);

  const uid = await auth.createUser(input.email, input.password, input.nickname);
  // O primeiro usuário do sistema vira admin; os demais, jogadores.
  const role: UserDoc["role"] = "player";
  const user: UserDoc = { name: input.name, nickname: input.nickname, email: input.email, role, created_at: now };
  try {
    await repo.db.commit([
      { op: "set", path: `users/${uid}`, data: user as any, mustNotExist: true },
      { op: "merge", path: `invites/${token}`, data: { uses: inv.data.uses + 1 }, updateTime: inv.updateTime },
    ]);
  } catch (e) {
    await auth.deleteUser(uid).catch(() => undefined);
    if (e instanceof ConflictError) throw new HttpError(409, "O convite acabou de ser usado por outra pessoa. Peça um novo.");
    throw e;
  }
  return uid;
}

export function parseSignup(body: any) {
  const name = String(body?.name ?? "").trim();
  const nickname = String(body?.nickname ?? "").trim();
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (name.length < 2 || name.length > 60) throw badRequest("Informe seu nome");
  if (nickname.length < 2 || nickname.length > 20) throw badRequest("O apelido deve ter de 2 a 20 letras");
  if (!EMAIL_RE.test(email)) throw badRequest("E-mail inválido");
  if (password.length < 8 || password.length > 100) throw badRequest("A senha deve ter pelo menos 8 caracteres");
  return { name, nickname, email, password };
}

export function publicRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/entrar", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email) || !password) throw badRequest("Informe e-mail e senha");
    const { repo, auth } = c.get("ctx");
    const s = await auth.signIn(email, password);
    const user = await repo.user(s.uid);
    if (!user) throw new HttpError(403, "Conta sem acesso. Peça um convite ao administrador.");
    setSession(c, s.cookie, s.maxAgeSec);
    return c.json({ usuario: userView(user.id, user) });
  });

  r.post("/sair", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Resposta igual exista o e-mail ou não.
  r.post("/senha/esqueci", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(email)) await c.get("ctx").auth.sendPasswordReset(email);
    return c.json({ ok: true });
  });

  // Senha nova a partir do link do e-mail de recuperação: `token` é o access_token que vem no link.
  r.post("/senha/nova", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");
    if (!token) throw badRequest("Link inválido. Peça um novo em “Esqueci a senha”");
    if (password.length < 8 || password.length > 100) throw badRequest("A senha deve ter pelo menos 8 caracteres");
    await c.get("ctx").auth.setPassword(token, password);
    return c.json({ ok: true });
  });

  r.get("/convite/:token", async (c) => {
    const inv = await c.get("ctx").repo.invite(c.req.param("token"));
    if (!inv) return c.json({ valido: false, motivo: "Convite não encontrado" });
    const problem = inviteProblem(inv.data);
    return c.json({ valido: !problem, motivo: problem });
  });

  r.post("/convite/:token", async (c) => {
    const input = parseSignup(await c.req.json().catch(() => ({})));
    const ctx = c.get("ctx");
    const uid = await redeemInvite(ctx, c.req.param("token"), input);
    forgetUser(uid);
    const s = await ctx.auth.signIn(input.email, input.password);
    setSession(c, s.cookie, s.maxAgeSec);
    const user = await ctx.repo.user(uid);
    return c.json({ usuario: userView(uid, user!) }, 201);
  });

  r.get("/config", (c) => c.json({ vapidPublicKey: c.env.VAPID_PUBLIC_KEY || null, demo: c.env.DEV_MEMORY === "1" }));

  // rota de sessão atual: fica aqui para responder 200 {usuario:null} sem erro quando deslogado
  r.get("/eu", async (c) => {
    const cookie = sessionCookie(c);
    if (!cookie) return c.json({ usuario: null });
    const { auth, repo } = c.get("ctx");
    const uid = await auth.verifySession(cookie);
    const user = uid ? await repo.user(uid) : null;
    if (!user) return c.json({ usuario: null });
    return c.json({ usuario: userView(user.id, user) });
  });

  return r;
}
