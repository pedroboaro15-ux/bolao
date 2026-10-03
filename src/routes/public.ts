import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { COOKIE, forgetUser, sessionCookie, type AppEnv } from "../http";
import { HttpError, badRequest, conflict } from "../lib/errors";
import { nicknameTaken, parseNickname, parsePhone, uniqueNickname } from "../lib/profile";
import { emailKey, limitsOf, takeSlot, waitText } from "../lib/ratelimit";
import type { UserDoc } from "../types";
import type { AuthProvider } from "../auth/provider";

export { parsePhone };

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

/** O usuário como o navegador vê (o telefone só vai para a própria pessoa e para o admin). */
export const userView = (id: string, u: UserDoc) => ({ id, name: u.name, nickname: u.nickname, email: u.email, phone: u.phone ?? null, role: u.role, edits: u.edits ?? {} });

/** Apelido sugerido a partir do e-mail (a pessoa pode digitar o seu no cadastro). */
function nicknameFromEmail(email: string): string {
  const base = email.split("@")[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 20).trim();
  return base.length >= 2 ? base : "Jogador";
}

export function parseSignup(body: any) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  const phone = parsePhone(body?.phone);
  const password = String(body?.password ?? "");
  const confirm = String(body?.confirm ?? "");
  const typed = String(body?.nickname ?? "").trim();
  if (!EMAIL_RE.test(email)) throw badRequest("E-mail inválido");
  if (password.length < 8 || password.length > 100) throw badRequest("A senha deve ter pelo menos 8 caracteres");
  if (password !== confirm) throw badRequest("As senhas não são iguais");
  const nickname = typed ? parseNickname(typed) : nicknameFromEmail(email);
  return { name: nickname, nickname, typedNickname: !!typed, email, phone, password };
}

/**
 * Cadastro aberto: cria a conta no Auth e grava users/{uid}. O Auth garante que o e-mail é único;
 * se a gravação do perfil falhar, a conta recém-criada é apagada. Apelido repetido: se a pessoa digitou, recusa;
 * se foi sugerido pelo e-mail, acrescenta um número.
 */
export async function signUp(
  ctx: { repo: import("../db/repo").Repo; auth: AuthProvider },
  input: ReturnType<typeof parseSignup>,
  now = new Date(),
) {
  const { repo, auth } = ctx;
  const users = await repo.users();
  let nickname = input.nickname;
  if (input.typedNickname) {
    if (nicknameTaken(users, nickname)) throw conflict("Esse apelido já está em uso. Escolha outro.");
  } else nickname = uniqueNickname(users, nickname);

  const uid = await auth.createUser(input.email, input.password, nickname);
  const user: UserDoc = { name: nickname, nickname, email: input.email, phone: input.phone, role: "player", created_at: now };
  try {
    await repo.db.commit([{ op: "set", path: `users/${uid}`, data: user as any, mustNotExist: true }]);
  } catch (e) {
    await auth.deleteUser(uid).catch(() => undefined);
    throw e;
  }
  return uid;
}

export function publicRoutes() {
  const r = new Hono<AppEnv>();

  // Login: 5 tentativas erradas por conta a cada 15 minutos. Acertar a senha zera a contagem; errar a 6ª vez já cai no bloqueio.
  r.post("/entrar", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email) || !password) throw badRequest("Informe e-mail e senha");
    const { repo, auth } = c.get("ctx");
    const lim = limitsOf(c.env);
    const slot = await takeSlot(repo.db, `login:${await emailKey(email)}`, lim.loginFails, lim.loginWindowMs);
    if (!slot.ok) throw new HttpError(429, `Muitas tentativas erradas. Por segurança, o login desta conta fica bloqueado por ${waitText(slot.resetAt)}.`);
    const s = await auth.signIn(email, password);
    await slot.clear(); // acertou: os erros anteriores desta conta deixam de contar
    const user = await repo.user(s.uid);
    if (!user) throw new HttpError(403, "Conta sem acesso. Crie sua conta na tela de cadastro.");
    setSession(c, s.cookie, s.maxAgeSec);
    return c.json({ usuario: userView(user.id, user) });
  });

  r.post("/sair", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Resposta igual exista o e-mail ou não (e no máximo 3 pedidos por hora para o mesmo e-mail).
  r.post("/senha/esqueci", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(email)) {
      const { auth, repo } = c.get("ctx");
      const slot = await takeSlot(repo.db, `forgot:${await emailKey(email)}`, 3, 3600_000);
      if (slot.ok) await auth.sendPasswordReset(email);
    }
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

  // Cadastro: no máximo 2 por minuto no site todo (padrão). Cadastro com dados inválidos não gasta vaga.
  r.post("/cadastro", async (c) => {
    const input = parseSignup(await c.req.json().catch(() => ({})));
    const ctx = c.get("ctx");
    const lim = limitsOf(c.env);
    const slot = await takeSlot(ctx.repo.db, "signup", lim.signupPerMinute, 60_000);
    if (!slot.ok) throw new HttpError(429, `Muitos cadastros neste minuto. Tente de novo em ${waitText(slot.resetAt)}.`);
    const uid = await signUp(ctx, input);
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
