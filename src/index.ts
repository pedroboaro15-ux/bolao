import type { Env } from "./types";
import { createApp } from "./app";
import { buildCtx } from "./context";
import { runDaily, runFrequent, runHourly } from "./services/cron";

const app = createApp();

export default {
  fetch: app.fetch,

  // Um único scheduled() escolhe a tarefa pelo texto do cron (wrangler.toml).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { repo } = await buildCtx(env);
    const task =
      event.cron === "0 9 * * *" ? runDaily : event.cron === "0 * * * *" ? runHourly : event.cron === "*/15 * * * *" ? runFrequent : null;
    if (!task) {
      console.error("cron desconhecido:", event.cron);
      return;
    }
    ctx.waitUntil(task(env, repo).catch((e) => console.error(`cron ${event.cron} falhou:`, e)));
  },
} satisfies ExportedHandler<Env>;
