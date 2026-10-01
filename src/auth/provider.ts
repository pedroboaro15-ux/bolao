import { SignJWT, jwtVerify } from "jose";
import { HttpError, badRequest } from "../lib/errors";

/** Login e contas. Implementações: Supabase Auth e um modo demo em memória. */
export interface AuthProvider {
  /** Confere e-mail/senha e devolve um cookie de sessão (ou lança 401). */
  signIn(email: string, password: string): Promise<{ uid: string; cookie: string; maxAgeSec: number }>;
  createUser(email: string, password: string, displayName: string): Promise<string>;
  deleteUser(uid: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** Define a senha nova a partir do link do e-mail de recuperação (o `access_token` que vem no link). */
  setPassword(accessToken: string, password: string): Promise<void>;
  /** uid da sessão, ou null se inválida/expirada. */
  verifySession(cookie: string): Promise<string | null>;
}

export const SESSION_SECONDS = 14 * 24 * 3600;
const MIN_SECRET = 32;

// ---------- cookie de sessão (assinado pelo servidor, HS256) ----------
// A senha é conferida pelo Supabase; depois disso o site só precisa reconhecer quem voltou, então o cookie é
// um JWT curto assinado com SESSION_SECRET. Não depende de rede para validar.

const keyOf = (secret: string) => {
  if (secret.length < MIN_SECRET) throw new HttpError(503, `SESSION_SECRET precisa ter pelo menos ${MIN_SECRET} caracteres`);
  return new TextEncoder().encode(secret);
};

export async function signSession(uid: string, secret: string, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(uid)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_SECONDS)
    .sign(keyOf(secret));
}

export async function verifySessionToken(token: string, secret: string, now = new Date()): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ["HS256"], currentDate: now });
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch (e) {
    if (e instanceof HttpError) throw e; // segredo mal configurado não é "sessão inválida"
    return null;
  }
}

// ---------- Supabase Auth ----------

const FRIENDLY: Record<string, [number, string]> = {
  invalid_credentials: [401, "E-mail ou senha incorretos"],
  email_exists: [409, "Este e-mail já está cadastrado"],
  user_already_exists: [409, "Este e-mail já está cadastrado"],
  weak_password: [400, "Senha fraca: use pelo menos 8 caracteres"],
  validation_failed: [400, "Dados inválidos (confira o e-mail)"],
  email_address_invalid: [400, "E-mail inválido"],
  email_not_confirmed: [403, "E-mail ainda não confirmado"],
  user_banned: [403, "Conta desativada"],
  over_request_rate_limit: [429, "Muitas tentativas. Tente de novo em alguns minutos"],
  over_email_send_rate_limit: [429, "Muitos e-mails enviados. Tente de novo em alguns minutos"],
  same_password: [400, "Escolha uma senha diferente da atual"],
  bad_jwt: [401, "Link expirado. Peça um novo em “Esqueci a senha”"],
  session_not_found: [401, "Link expirado. Peça um novo em “Esqueci a senha”"],
};

function authError(status: number, body: any): HttpError {
  const code = String(body?.error_code ?? body?.code ?? "");
  const known = FRIENDLY[code];
  if (known) return new HttpError(known[0], known[1]);
  if (status === 401) return new HttpError(401, "Não autorizado");
  if (status === 429) return new HttpError(429, "Muitas tentativas. Tente de novo em alguns minutos");
  return new HttpError(status >= 500 ? 502 : 400, `Supabase Auth: ${body?.msg ?? body?.message ?? body?.error_description ?? "erro desconhecido"}`);
}

export class SupabaseAuth implements AuthProvider {
  private base: string;

  constructor(
    url: string,
    private key: string,
    private sessionSecret: string,
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = `${url.replace(/\/+$/, "")}/auth/v1`;
  }

  private headers(bearer?: string): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, "content-type": "application/json" };
    if (bearer) h.authorization = `Bearer ${bearer}`;
    else if (this.key.startsWith("eyJ")) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  private async call(path: string, init: RequestInit & { bearer?: string } = {}): Promise<any> {
    const { bearer, ...rest } = init;
    const res = await this.fetchImpl(`${this.base}${path}`, { ...rest, headers: this.headers(bearer) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw authError(res.status, body);
    return body;
  }

  async signIn(email: string, password: string) {
    const json = await this.call("/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
    const uid = String(json?.user?.id ?? "");
    if (!uid) throw new HttpError(502, "Supabase Auth não devolveu o usuário");
    return { uid, cookie: await signSession(uid, this.sessionSecret), maxAgeSec: SESSION_SECONDS };
  }

  async createUser(email: string, password: string, displayName: string) {
    const json = await this.call("/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name: displayName } }),
    });
    return String(json.id);
  }

  async deleteUser(uid: string) {
    await this.call(`/admin/users/${encodeURIComponent(uid)}`, { method: "DELETE" });
  }

  async sendPasswordReset(email: string) {
    // Não revela se o e-mail existe: erros são ignorados.
    await this.call("/recover", { method: "POST", body: JSON.stringify({ email }) }).catch(() => undefined);
  }

  async setPassword(accessToken: string, password: string) {
    if (password.length < 8) throw badRequest("A senha deve ter pelo menos 8 caracteres");
    await this.call("/user", { method: "PUT", bearer: accessToken, body: JSON.stringify({ password }) });
  }

  verifySession(cookie: string) {
    return verifySessionToken(cookie, this.sessionSecret);
  }
}

// ---------- modo demo (só localhost, banco em memória) ----------

export class DevAuth implements AuthProvider {
  private users = new Map<string, { uid: string; password: string; name: string }>();
  private seq = 0;

  seed(email: string, password: string, name: string, uid?: string): string {
    const id = uid ?? `dev${++this.seq}`;
    this.users.set(email.toLowerCase(), { uid: id, password, name });
    return id;
  }

  async signIn(email: string, password: string) {
    const u = this.users.get(email.toLowerCase());
    if (!u || u.password !== password) throw new HttpError(401, "E-mail ou senha incorretos");
    return { uid: u.uid, cookie: `dev.${u.uid}`, maxAgeSec: SESSION_SECONDS };
  }
  async createUser(email: string, password: string, displayName: string) {
    if (this.users.has(email.toLowerCase())) throw new HttpError(409, "Este e-mail já está cadastrado");
    if (password.length < 8) throw badRequest("Senha fraca: use pelo menos 8 caracteres");
    return this.seed(email, password, displayName);
  }
  async deleteUser(uid: string) {
    for (const [email, u] of this.users) if (u.uid === uid) this.users.delete(email);
  }
  async sendPasswordReset() {}
  async setPassword() {}
  async verifySession(cookie: string) {
    if (!cookie.startsWith("dev.")) return null;
    const uid = cookie.slice(4);
    return [...this.users.values()].some((u) => u.uid === uid) ? uid : null;
  }
}
