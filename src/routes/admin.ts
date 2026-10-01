import { Hono } from "hono";
import type { AppEnv } from "../http";
import { forgetUser } from "../http";
import { badRequest, conflict, notFound } from "../lib/errors";
import { bolaoDay, isDateString, utcDate } from "../lib/dates";
import { parseSettingsPatch } from "../lib/settings";
import { ApiFootball, PROVIDER } from "../services/apifootball";
import { chosenToday, createRound, freezeStarted, loadFixtures, refreshMatchOdds, refreshOddsBatch, setManualOdds } from "../services/rounds";
import { recalcRound } from "../services/results";
import { notifyFinished } from "../services/cron";
import { pushConfigured, sendPush } from "../services/push";
import { userView } from "./public";

const goal = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) throw badRequest("Placar inválido");
  return n;
};

export function adminRoutes() {
  const r = new Hono<AppEnv>();

  // ---------- jogos do dia → escolher → criar rodada ----------

  r.get("/jogos-do-dia", async (c) => {
    const { repo } = c.get("ctx");
    const date = c.req.query("date") ?? bolaoDay();
    if (!isDateString(date)) throw badRequest("Data inválida");
    const settings = await repo.settings();
    const api = new ApiFootball(c.env, repo, settings);
    const cache = await loadFixtures(repo, api, settings, date, c.req.query("atualizar") === "1");
    const liga = Number(c.req.query("liga") ?? 0);

    const ligas = new Map<number, { id: number; name: string; country?: string; count: number }>();
    for (const f of cache.fixtures) {
      const cur = ligas.get(f.league.id) ?? { id: f.league.id, name: f.league.name, country: f.league.country, count: 0 };
      cur.count++;
      ligas.set(f.league.id, cur);
    }
    const shown = cache.fixtures.filter((f) => !liga || f.league.id === liga).slice(0, 30);
    const taken = new Set((await repo.matchesByIds(shown.map((f) => String(f.id)))).map((m) => m.id));
    const ja = await chosenToday(repo, date);
    return c.json({
      date,
      janela: cache.janela,
      limite: settings.maxMatchesPerDay,
      ja_escolhidos: ja,
      fetched_at: cache.fetched_at,
      total: cache.total,
      ligas: [...ligas.values()].sort((a, b) => b.count - a.count),
      jogos: shown.map((f) => ({ ...f, ja_em_rodada: taken.has(String(f.id)) })),
    });
  });

  r.post("/rodadas", async (c) => {
    const { repo } = c.get("ctx");
    const body: any = await c.req.json().catch(() => ({}));
    const date = String(body.date ?? "");
    if (!isDateString(date)) throw badRequest("Data inválida");
    const open = body.open !== false;
    const settings = await repo.settings();
    const cache = await loadFixtures(repo, new ApiFootball(c.env, repo, settings), settings, date);
    const { roundId, matchIds } = await createRound(
      repo,
      {
        title: String(body.title ?? `Rodada de ${date.split("-").reverse().join("/")}`),
        date,
        fixtureIds: Array.isArray(body.fixtureIds) ? body.fixtureIds : [],
        open,
      },
      cache.fixtures,
      settings,
    );

    // Depois de responder: odds dos primeiros jogos (a API grátis aceita ~10 chamadas/min; o cron completa o resto) e aviso push.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const matches = await repo.matchesByIds(matchIds);
          await refreshOddsBatch(repo, new ApiFootball(c.env, repo, settings), settings, matches, 4);
          if (open && pushConfigured(c.env)) {
            await sendPush(c.env, repo, "all", { title: "Rodada aberta!", body: `${body.title ?? "Nova rodada"}: ${matchIds.length} jogos esperando seus palpites.`, url: "/" });
          }
        } catch (e) {
          console.error("pós-criação da rodada falhou", e);
        }
      })(),
    );
    return c.json({ id: roundId }, 201);
  });

  r.get("/rodadas", async (c) => {
    const { repo } = c.get("ctx");
    const rounds = await repo.rounds(60);
    return c.json({ rodadas: rounds.map((x) => ({ id: x.id, title: x.title, date: x.date, status: x.status, jogos: x.match_ids.length })) });
  });

  r.patch("/rodadas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const round = await repo.round(c.req.param("id"));
    if (!round) throw notFound("Rodada não encontrada");
    const body: any = await c.req.json().catch(() => ({}));
    const data: Record<string, any> = {};
    if (body.status !== undefined) {
      if (!["draft", "open", "closed"].includes(body.status)) throw badRequest("Status inválido");
      if (round.status === "finished") throw conflict("Rodada encerrada não pode ser reaberta. Corrija os resultados e recalcule.");
      data.status = body.status;
    }
    if (body.title !== undefined) data.title = String(body.title).trim().slice(0, 80);
    if (Object.keys(data).length) await repo.db.commit([{ op: "merge", path: `rounds/${round.id}`, data }]);
    return c.json({ ok: true });
  });

  // ---------- resultados ----------

  r.get("/rodadas/:id/jogos", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const round = await repo.round(id);
    if (!round) throw notFound("Rodada não encontrada");
    const [matches, preds] = await Promise.all([repo.matchesOfRound(id), repo.predictionsOfRound(id)]);
    const count = new Map<string, number>();
    for (const p of preds) count.set(p.match_id, (count.get(p.match_id) ?? 0) + 1);
    return c.json({
      rodada: { id: round.id, title: round.title, date: round.date, status: round.status },
      jogos: matches.map((m) => ({
        id: m.id,
        league: m.league,
        home: m.home,
        away: m.away,
        kickoff_utc: m.kickoff_utc,
        status: m.status,
        home_goals: m.home_goals,
        away_goals: m.away_goals,
        manual_override: m.manual_override,
        voided: m.voided,
        palpites: count.get(m.id) ?? 0,
        odds: m.odds?.["1X2"]
          ? { fonte: m.odds["1X2"].source, atualizado: m.odds["1X2"].fetched_at, bruta: m.odds["1X2"].raw, justa: m.odds["1X2"].fair, ou: m.odds.OU25?.fair ?? null }
          : null,
        congeladas: Boolean(m.frozen_odds),
        odds_error: (m as any).odds_error ?? null,
      })),
    });
  });

  const afterChange = async (c: any, matchId: string) => {
    const { repo } = c.get("ctx");
    const match = await repo.match(matchId);
    const settings = await repo.settings();
    const res = await recalcRound(repo, match.round_id, settings);
    if (res?.finished) c.executionCtx.waitUntil(notifyFinished(c.env, repo, match.round_id));
    return res;
  };

  r.put("/jogos/:id/resultado", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const match = await repo.match(id);
    if (!match) throw notFound("Jogo não encontrado");
    const body: any = await c.req.json().catch(() => ({}));
    if (body.limpar) {
      // Volta para o resultado automático da API.
      await repo.db.commit([{ op: "merge", path: `matches/${id}`, data: { home_goals: null, away_goals: null, manual_override: false } }]);
    } else {
      await repo.db.commit([{ op: "merge", path: `matches/${id}`, data: { home_goals: goal(body.home_goals), away_goals: goal(body.away_goals), manual_override: true, status: "FT" } }]);
    }
    await afterChange(c, id);
    return c.json({ ok: true });
  });

  r.post("/jogos/:id/anular", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    if (!(await repo.match(id))) throw notFound("Jogo não encontrado");
    const body: any = await c.req.json().catch(() => ({}));
    await repo.db.commit([{ op: "merge", path: `matches/${id}`, data: { voided: body.anular !== false } }]);
    await afterChange(c, id);
    return c.json({ ok: true });
  });

  r.post("/rodadas/:id/recalcular", async (c) => {
    const { repo } = c.get("ctx");
    const res = await recalcRound(repo, c.req.param("id"), await repo.settings());
    if (!res) throw notFound("Rodada não encontrada");
    return c.json({ ok: true, palpites_alterados: res.changed, encerrada: res.finished });
  });

  r.put("/jogos/:id/odds", async (c) => {
    const { repo } = c.get("ctx");
    const match = await repo.match(c.req.param("id"));
    if (!match) throw notFound("Jogo não encontrado");
    await setManualOdds(repo, await repo.settings(), match, await c.req.json().catch(() => ({})));
    return c.json({ ok: true });
  });

  r.post("/jogos/:id/atualizar-odds", async (c) => {
    const { repo } = c.get("ctx");
    const match = await repo.match(c.req.param("id"));
    if (!match) throw notFound("Jogo não encontrado");
    const settings = await repo.settings();
    const res = await refreshMatchOdds(repo, new ApiFootball(c.env, repo, settings), settings, match);
    return c.json(res, res.ok ? 200 : 422);
  });

  // ---------- usuários ----------

  r.get("/usuarios", async (c) => {
    const { repo } = c.get("ctx");
    return c.json({ usuarios: (await repo.users()).map((u) => ({ ...userView(u.id, u), phone: u.phone ?? null })) });
  });

  r.post("/usuarios/:id/papel", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const body: any = await c.req.json().catch(() => ({}));
    if (body.role !== "admin" && body.role !== "player") throw badRequest("Papel inválido");
    const users = await repo.users();
    const target = users.find((u) => u.id === id);
    if (!target) throw notFound("Usuário não encontrado");
    if (target.role === "admin" && body.role === "player" && users.filter((u) => u.role === "admin").length <= 1) {
      throw conflict("Precisa existir pelo menos um administrador");
    }
    await repo.db.commit([{ op: "merge", path: `users/${id}`, data: { role: body.role } }]);
    forgetUser(id);
    return c.json({ ok: true });
  });

  r.delete("/usuarios/:id", async (c) => {
    const { repo, auth } = c.get("ctx");
    const id = c.req.param("id");
    if (id === c.get("user").id) throw conflict("Você não pode remover a si mesmo");
    const users = await repo.users();
    const target = users.find((u) => u.id === id);
    if (!target) throw notFound("Usuário não encontrado");
    if (target.role === "admin" && users.filter((u) => u.role === "admin").length <= 1) throw conflict("Precisa existir pelo menos um administrador");

    // Apaga a conta, o perfil e os palpites; depois refaz o ranking das rodadas mais recentes em que ele jogou.
    const preds = await repo.predictionsOfUser(id, 500);
    await auth.deleteUser(id).catch((e) => console.error("Auth deleteUser:", e?.message));
    await repo.db.commit([{ op: "delete", path: `users/${id}` }, ...preds.slice(0, 450).map((p) => ({ op: "delete" as const, path: `predictions/${p.id}` }))]);
    forgetUser(id);
    const roundIds = [...new Set(preds.map((p) => p.round_id))].slice(0, 5);
    const settings = await repo.settings();
    c.executionCtx.waitUntil(
      (async () => {
        for (const rid of roundIds) {
          await recalcRound(repo, rid, settings);
        }
      })().catch((e) => console.error("ranking após remoção falhou", e)),
    );
    return c.json({ ok: true });
  });

  // ---------- configurações e uso das APIs ----------

  r.get("/config", async (c) => c.json({ config: await c.get("ctx").repo.settings() }));

  r.put("/config", async (c) => {
    const { repo } = c.get("ctx");
    const patch = parseSettingsPatch(await c.req.json().catch(() => null));
    const before = await repo.settings();
    const extrasChanged = (patch.goalsEnabled !== undefined && patch.goalsEnabled !== before.goalsEnabled) || (patch.scoreEnabled !== undefined && patch.scoreEnabled !== before.scoreEnabled);
    if (extrasChanged) {
      // Antes de mudar, guarda o que valia para os jogos que já começaram (eles não são afetados).
      const rounds = [...(await repo.roundsByStatus("open")), ...(await repo.roundsByStatus("closed"))];
      const started = (await Promise.all(rounds.map((r) => repo.matchesOfRound(r.id)))).flat();
      await freezeStarted(repo, started, before);
    }
    return c.json({ config: await repo.saveSettings(patch) });
  });

  r.get("/uso", async (c) => {
    const { repo } = c.get("ctx");
    const settings = await repo.settings();
    const hoje = utcDate();
    return c.json({
      data: hoje,
      api_football: { chamadas_hoje: await repo.usage(hoje, PROVIDER), limite: settings.apiFootballDailyLimit, reserva: settings.apiReserve },
      push_configurado: pushConfigured(c.env),
      reinicia_em_utc: "00:00",
    });
  });

  r.get("/api-teste", async (c) => {
    const { repo } = c.get("ctx");
    const api = new ApiFootball(c.env, repo, await repo.settings());
    return c.json(await api.diagnose(bolaoDay()));
  });

  return r;
}
