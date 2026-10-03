import { Hono } from "hono";
import type { AppEnv } from "../http";
import { forgetUser } from "../http";
import { badRequest, conflict, notFound } from "../lib/errors";
import { bolaoDay, isDateString, utcDate } from "../lib/dates";
import { parseSettingsPatch } from "../lib/settings";
import { ApiFootball, PROVIDER } from "../services/apifootball";
import { chosenToday, createRound, freezeStarted, loadFixtures, refreshMatchOdds, setManualOdds } from "../services/rounds";
import { recalcRound } from "../services/results";
import { notifyFinished } from "../services/cron";
import { pushConfigured, sendPush } from "../services/push";
import { userView } from "./public";
import { isBrazil } from "../lib/relevance";
import { KINDS, answersOf, parseQuestionInput, questionView, questionsOfDay, settleDay } from "../services/questions";
import { nicknameTaken, parseNickname, parsePhone } from "../lib/profile";

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
    const ligaQ = c.req.query("liga") ?? "0";
    const soBrasil = ligaQ === "br";
    const liga = soBrasil ? 0 : Number(ligaQ);

    const ligas = new Map<number, { id: number; name: string; country?: string; count: number }>();
    for (const f of cache.fixtures.filter((f) => f.kickoff.getTime() > Date.now())) {
      const cur = ligas.get(f.league.id) ?? { id: f.league.id, name: f.league.name, country: f.league.country, count: 0 };
      cur.count++;
      ligas.set(f.league.id, cur);
    }
    // Jogo que já começou não pode entrar numa rodada (ninguém conseguiria palpitar): some da lista e da contagem.
    const agora = Date.now();
    const futuros = cache.fixtures.filter((f) => f.kickoff.getTime() > agora);
    const shown = futuros.filter((f) => (soBrasil ? isBrazil(f) : !liga || f.league.id === liga)).slice(0, soBrasil || liga ? 80 : 30);
    const taken = new Set((await repo.matchesByIds(shown.map((f) => String(f.id)))).map((m) => m.id));
    const ja = await chosenToday(repo, date);
    return c.json({
      date,
      janela: cache.janela,
      limite: settings.maxMatchesPerDay,
      ja_escolhidos: ja,
      fetched_at: cache.fetched_at,
      total: futuros.length,
      comecados: cache.fixtures.length - futuros.length,
      brasil: futuros.filter(isBrazil).length,
      ligas: [...ligas.values()].sort((a, b) => Number(b.country === "Brazil") - Number(a.country === "Brazil") || b.count - a.count),
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

    // Depois de responder: aviso push. As odds não entram aqui: o plano grátis do Workers dá só 10 ms de CPU por execução,
    // então a tela do admin busca uma por vez (um pedido por jogo) e o cron completa o que faltar.
    c.executionCtx.waitUntil(
      (async () => {
        try {
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
    return c.json(res.ok ? res : { ...res, erro: res.motivo }, res.ok ? 200 : 422);
  });

  // ---------- perguntas do dia (também basquete e UFC) ----------

  r.get("/perguntas", async (c) => {
    const { repo } = c.get("ctx");
    const date = c.req.query("date") ?? bolaoDay();
    if (!isDateString(date)) throw badRequest("Data inválida");
    const [qs, all] = await Promise.all([questionsOfDay(repo, date), answersOf(repo, "date", date)]);
    const now = new Date();
    return c.json({
      date,
      tipos: KINDS,
      perguntas: qs.map((q) => {
        const mine = all.filter((x) => x.question_id === q.id);
        // o admin sempre vê quantos escolheram cada opção
        return { ...questionView(q, null, mine, new Date(8640000000000000)), closed: q.closes_at <= now, respostas: mine.length };
      }),
    });
  });

  r.post("/perguntas", async (c) => {
    const { repo } = c.get("ctx");
    const input = parseQuestionInput(await c.req.json().catch(() => ({})), isDateString);
    const id = `q${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    await repo.db.commit([{ op: "set", path: `questions/${id}`, data: { ...input, result: null, voided: false, created_at: new Date() }, mustNotExist: true }]);
    return c.json({ id }, 201);
  });

  // Editar (texto, odds, horário). Opções com respostas não podem sumir; o resultado se dá em /resultado.
  r.put("/perguntas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const doc = await repo.db.get<any>(`questions/${id}`);
    if (!doc) throw notFound("Pergunta não encontrada");
    const input = parseQuestionInput(await c.req.json().catch(() => ({})), isDateString);
    const answers = await answersOf(repo, "question_id", id);
    const kept = new Set(input.options.map((o) => o.id));
    if (answers.some((x) => !kept.has(x.option_id))) throw badRequest("Não dá para apagar uma opção que já foi escolhida por alguém");
    if (input.date !== doc.data.date && answers.length) throw badRequest("Não dá para mudar o dia de uma pergunta já respondida");
    await repo.db.commit([{ op: "merge", path: `questions/${id}`, data: input }]);
    if (doc.data.result || doc.data.voided) await settleDay(repo, input.date);
    return c.json({ ok: true });
  });

  // Resultado: { option_id } marca a certa; { anular: true } anula (ninguém pontua); { limpar: true } volta a "sem resultado".
  r.post("/perguntas/:id/resultado", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const doc = await repo.db.get<any>(`questions/${id}`);
    if (!doc) throw notFound("Pergunta não encontrada");
    const body: any = await c.req.json().catch(() => ({}));
    let data: Record<string, any>;
    if (body.anular === true) data = { voided: true, result: null };
    else if (body.limpar === true) data = { voided: false, result: null };
    else {
      const opt = String(body.option_id ?? "");
      if (!doc.data.options.some((o: any) => o.id === opt)) throw badRequest("Opção inválida");
      data = { voided: false, result: opt };
      // dar o resultado também fecha as respostas
      if (new Date(doc.data.closes_at) > new Date()) data.closes_at = new Date();
    }
    await repo.db.commit([{ op: "merge", path: `questions/${id}`, data }]);
    await settleDay(repo, doc.data.date);
    return c.json({ ok: true });
  });

  r.delete("/perguntas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const doc = await repo.db.get<any>(`questions/${id}`);
    if (!doc) throw notFound("Pergunta não encontrada");
    const answers = await answersOf(repo, "question_id", id);
    await repo.db.commit([{ op: "delete", path: `questions/${id}` }, ...answers.map((x) => ({ op: "delete" as const, path: `answers/${x.id}` }))]);
    await settleDay(repo, doc.data.date);
    return c.json({ ok: true });
  });

  // ---------- usuários ----------

  r.get("/usuarios", async (c) => {
    const { repo } = c.get("ctx");
    return c.json({ usuarios: (await repo.users()).map((u) => ({ ...userView(u.id, u), phone: u.phone ?? null })) });
  });

  // O admin muda apelido e telefone de qualquer pessoa e pode "liberar" uma nova alteração do próprio perfil.
  r.patch("/usuarios/:id", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const body: any = await c.req.json().catch(() => ({}));
    const users = await repo.users();
    const target = users.find((u) => u.id === id);
    if (!target) throw notFound("Usuário não encontrado");
    const data: Record<string, any> = {};
    if (body.nickname !== undefined && String(body.nickname).trim() !== target.nickname) {
      const nickname = parseNickname(body.nickname);
      if (nicknameTaken(users, nickname, id)) throw conflict("Esse apelido já está em uso");
      data.nickname = nickname;
      if (target.name === target.nickname) data.name = nickname;
    }
    if (body.phone !== undefined && String(body.phone).trim() !== "") {
      const phone = parsePhone(body.phone);
      if (phone !== (target.phone ?? null)) data.phone = phone;
    }
    if (body.liberar === true) data.edits = {};
    if (!Object.keys(data).length) throw badRequest("Nada para alterar");
    await repo.db.commit([{ op: "merge", path: `users/${id}`, data, mustExist: true }]);
    forgetUser(id);
    return c.json({ ok: true });
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
