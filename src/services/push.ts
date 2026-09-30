import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { Env } from "../types";
import type { Repo } from "../db/repo";

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
}

interface SubDoc {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function subId(endpoint: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const pushConfigured = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/** Envia para os usuários indicados (ou todos). Inscrições mortas (404/410) são apagadas. */
export async function sendPush(env: Env, repo: Repo, target: string[] | "all", msg: PushMessage | ((userId: string) => PushMessage | null)): Promise<number> {
  if (!pushConfigured(env)) return 0;
  const subs = await repo.db.query<SubDoc>("push_subs");
  const wanted = target === "all" ? subs : subs.filter((s) => target.includes(s.data.user_id));
  let sent = 0;
  // Plano grátis: no máximo 50 subrequests por execução.
  for (const s of wanted.slice(0, 35)) {
    const m = typeof msg === "function" ? msg(s.data.user_id) : msg;
    if (!m) continue;
    try {
      const payload = await buildPushPayload(
        { data: { title: m.title, body: m.body, url: m.url ?? "/" }, options: { ttl: 6 * 3600, urgency: "high" } },
        { endpoint: s.data.endpoint, expirationTime: null, keys: { auth: s.data.auth, p256dh: s.data.p256dh } },
        { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
      );
      const res = await fetch(s.data.endpoint, { method: payload.method, headers: payload.headers, body: payload.body });
      if (res.status === 404 || res.status === 410) await repo.db.commit([{ op: "delete", path: `push_subs/${s.id}` }]);
      else if (res.ok) sent++;
    } catch (e) {
      console.error("push falhou", e);
    }
  }
  return sent;
}
