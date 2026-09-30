import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { buildCtx } from "./context";
import { COOKIE, sessionCookie, userCache, type AppEnv } from "./http";
import { ConflictError } from "./db/types";
import { HttpError, forbidden, unauthorized } from "./lib/errors";
import { playerRoutes } from "./routes/player";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";


export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    c.set("ctx", await buildCtx(c.env, new URL(c.req.url).hostname));
    c.header("cache-control", "no-store");
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ erro: err.message }, err.status as any);
    if (err instanceof ConflictError) return c.json({ erro: "Conflito ao gravar. Tente de novo." }, 409);
    console.error("erro não tratado:", err);
    return c.json({ erro: "Erro interno do servidor" }, 500);
  });

  app.get("/api/saude", (c) => c.json({ ok: true, agora: new Date().toISOString() }));

  app.route("/api", publicRoutes());

  // ---- daqui em diante, só logado ----
  app.use("/api/*", async (c, next) => {
    const cookie = sessionCookie(c);
    if (!cookie) throw unauthorized();
    const { auth, repo } = c.get("ctx");
    const uid = await auth.verifySession(cookie);
    if (!uid) {
      deleteCookie(c, COOKIE, { path: "/" });
      throw unauthorized("Sessão expirada. Entre de novo.");
    }
    let hit = userCache.get(uid);
    if (!hit || hit.exp < Date.now()) {
      hit = { user: await repo.user(uid), exp: Date.now() + 30_000 };
      userCache.set(uid, hit);
    }
    // Conta no Supabase Auth sem linha em users (ex.: cadastro fora do convite): não entra.
    if (!hit.user) {
      deleteCookie(c, COOKIE, { path: "/" });
      throw unauthorized("Conta sem acesso. Peça um convite ao administrador.");
    }
    c.set("user", hit.user);
    await next();
  });

  app.route("/api", playerRoutes());

  app.use("/api/admin/*", async (c, next) => {
    if (c.get("user").role !== "admin") throw forbidden("Área do administrador");
    await next();
  });
  app.route("/api/admin", adminRoutes());

  app.all("/api/*", (c) => c.json({ erro: "Rota não encontrada" }, 404));
  return app;
}
