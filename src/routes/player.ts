import { Hono } from "hono";
import type { Prediction } from "../types";
import { extrasOf, matchView, predictionView, type AppEnv } from "../http";
import type { Repo } from "../db/repo";
import type { Write } from "../db/types";
import type { Settings } from "../lib/settings";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { isLocked, parsePredictionInput, predictionBlockedReason, type PredictionInput } from "../lib/predictions";
import { computeStats } from "../lib/stats";
import { subId } from "../services/push";
import { ApiFootball } from "../services/apifootball";

const roundSummary = (r: { id: string; title: string; date: string; status: string }) => ({ id: r.id, title: r.title, date: r.date, status: r.status });

async function roundView(repo: Repo, roundId: string, userId: string, settings: Settings, now: Date, isAdmin: boolean) {
  const round = await repo.round(roundId);
  if (!round || (round.status === "draft" && !isAdmin)) throw notFound("Rodada não encontrada");
  const [matches, mine] = await Promise.all([repo.matchesOfRound(roundId), repo.predictionsOfUserRound(userId, roundId)]);
  const mineByMatch = new Map(mine.map((p) => [p.match_id, p]));
  return {
    rodada: roundSummary(round),
    jogos: matches.map((m) => matchView(m, mineByMatch.get(m.id) ?? null, settings, now)),
    coringa: { ativo: settings.jokerEnabled, multiplicador: settings.jokerMultiplier },
    agora: now,
  };
}

/** Rodada atual: a aberta mais recente; senão a última fechada/encerrada. `outras` = as mais recentes, para navegar. */
async function roundsNav(repo: Repo) {
  const rounds = (await repo.rounds(30)).filter((x) => x.status !== "draft");
  const current = rounds.find((x) => x.status === "open") ?? rounds.find((x) => x.status === "closed") ?? rounds[0];
  return { outras: rounds.slice(0, 10).map(roundSummary), atual: current?.id ?? null };
}

export function playerRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/rodadas", async (c) => {
    const { repo } = c.get("ctx");
    const rounds = (await repo.rounds(60)).filter((x) => x.status !== "draft");
    return c.json({ rodadas: rounds.map(roundSummary) });
  });

  // Rodada atual: a aberta mais recente; senão a última fechada/encerrada.
  r.get("/rodada/atual", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const nav = await roundsNav(repo);
    if (!nav.atual) return c.json({ rodada: null, jogos: [], ...nav, agora: new Date() });
    const settings = await repo.settings();
    const view = await roundView(repo, nav.atual, user.id, settings, new Date(), user.role === "admin");
    return c.json({ ...view, ...nav });
  });

  // Qualquer rodada (ex.: a de ontem). Devolve também a lista de rodadas e qual é a atual,
  // para a tela sempre ter como voltar para a rodada de hoje.
  r.get("/rodadas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const settings = await repo.settings();
    const view = await roundView(repo, c.req.param("id"), user.id, settings, new Date(), user.role === "admin");
    const nav = await roundsNav(repo);
    const outras = nav.outras.some((o) => o.id === view.rodada.id) ? nav.outras : [...nav.outras, view.rodada];
    return c.json({ ...view, ...nav, outras });
  });

  /**
   * Salva vários palpites de uma vez. A trava no kickoff é conferida AQUI, com a hora do servidor:
   * o que o navegador mostra não vale nada. Cada jogo recebe seu próprio erro, sem derrubar os outros.
   */
  r.put("/rodadas/:id/palpites", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const roundId = c.req.param("id");
    const body: any = await c.req.json().catch(() => ({}));
    const inputs: unknown[] = Array.isArray(body.palpites) ? body.palpites : [];
    if (inputs.length === 0 || inputs.length > 12) throw badRequest("Nenhum palpite para salvar");

    const now = new Date();
    const [round, matches, existing, settings] = await Promise.all([
      repo.round(roundId),
      repo.matchesOfRound(roundId),
      repo.predictionsOfUserRound(user.id, roundId),
      repo.settings(),
    ]);
    if (!round || round.status === "draft") throw notFound("Rodada não encontrada");
    const matchById = new Map(matches.map((m) => [m.id, m]));

    const erros: Record<string, string> = {};
    let accepted: PredictionInput[] = [];
    for (const raw of inputs) {
      let inp: PredictionInput;
      try {
        inp = parsePredictionInput(raw, { ou: settings.goalsEnabled, cs: settings.scoreEnabled });
      } catch (e: any) {
        erros[String((raw as any)?.match_id ?? "?")] = e.message;
        continue;
      }
      const m = matchById.get(inp.match_id);
      if (!m) {
        erros[inp.match_id] = "Jogo não pertence a esta rodada";
        continue;
      }
      const blocked = predictionBlockedReason(m, round, now);
      if (blocked) {
        erros[inp.match_id] = blocked;
        continue;
      }
      if (!settings.jokerEnabled) inp.joker = false;
      accepted.push(inp);
    }

    // Coringa: um por rodada. Se o atual está em jogo já iniciado, não dá para trocar.
    const writes: Write[] = [];
    const jokers = accepted.filter((a) => a.joker);
    if (jokers.length > 1) throw badRequest("Só é permitido um coringa por rodada");
    if (jokers.length === 1) {
      const target = jokers[0].match_id;
      const acceptedIds = new Set(accepted.map((a) => a.match_id));
      for (const p of existing) {
        if (!p.joker || p.match_id === target) continue;
        const m = matchById.get(p.match_id)!;
        if (isLocked(m.kickoff_utc, now)) {
          erros[target] = "Seu coringa desta rodada já está em um jogo que começou";
          accepted = accepted.filter((a) => a.match_id !== target);
          break;
        }
        if (!acceptedIds.has(p.match_id)) writes.push({ op: "merge", path: `predictions/${p.id}`, data: { joker: false, updated_at: now } });
      }
    }

    const existingByMatch = new Map(existing.map((p) => [p.match_id, p]));
    for (const a of accepted) {
      const prev = existingByMatch.get(a.match_id);
      const doc: Prediction = {
        user_id: user.id,
        match_id: a.match_id,
        round_id: roundId,
        pick_1x2: a.pick_1x2,
        mode: a.mode,
        pick_ou: a.pick_ou,
        home_goals: a.home_goals,
        away_goals: a.away_goals,
        joker: a.joker,
        points: null,
        hits: null,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      writes.push({ op: "set", path: `predictions/${repo.predictionId(a.match_id, user.id)}`, data: doc as any });
    }
    if (writes.length) await repo.db.commit(writes);
    return c.json({ salvos: accepted.map((a) => a.match_id), erros });
  });

  // Detalhe do jogo: os palpites dos outros só aparecem depois do kickoff.
  r.get("/jogos/:id", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const match = await repo.match(c.req.param("id"));
    if (!match) throw notFound("Jogo não encontrado");
    const round = await repo.round(match.round_id);
    if (!round || (round.status === "draft" && user.role !== "admin")) throw notFound("Jogo não encontrado");
    const now = new Date();
    const settings = await repo.settings();
    const mine = (await repo.db.get<Prediction>(`predictions/${repo.predictionId(match.id, user.id)}`))?.data ?? null;
    const view = matchView(match, mine, settings, now);
    let palpites: unknown[] | null = null;
    if (view.locked) {
      const [preds, users] = await Promise.all([repo.predictionsOfMatch(match.id), repo.users()]);
      const nick = new Map(users.map((u) => [u.id, u.nickname]));
      palpites = preds
        .map((p) => ({ user_id: p.user_id, nickname: nick.get(p.user_id) ?? "?", ...predictionView(p, view.extras)! }))
        .sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || a.nickname.localeCompare(b.nickname, "pt-BR"));
    }
    return c.json({ jogo: view, rodada: roundSummary(round), palpites });
  });

  // Ranking: rodada, mês ou geral (documentos já materializados: 1 leitura).
  r.get("/ranking", async (c) => {
    const { repo } = c.get("ctx");
    const rounds = (await repo.rounds(60)).filter((x) => x.status !== "draft");
    const meses = [...new Set(rounds.map((x) => x.date.slice(0, 7)))];
    const escopo = c.req.query("escopo") ?? "geral";
    let id = c.req.query("id") ?? "";
    let docId: string;
    let titulo: string;
    if (escopo === "rodada") {
      const cur = rounds.find((x) => x.id === id) ?? rounds.find((x) => x.status === "open") ?? rounds[0];
      if (!cur) return c.json({ escopo, id: "", titulo: "Sem rodadas", rows: [], updated_at: null, opcoes: { rodadas: [], meses } });
      id = cur.id;
      docId = `round_${cur.id}`;
      titulo = cur.title;
    } else if (escopo === "mes") {
      if (!/^\d{4}-\d{2}$/.test(id)) id = meses[0] ?? "";
      docId = `month_${id}`;
      titulo = id;
    } else {
      docId = "all";
      titulo = "Geral";
    }
    const st = escopo === "mes" && !id ? null : await repo.standings(docId);
    return c.json({
      escopo,
      id,
      titulo,
      rows: st?.rows ?? [],
      zebra: st?.zebra ?? null,
      streaks: st?.streaks ?? [],
      updated_at: st?.updated_at ?? null,
      opcoes: { rodadas: rounds.slice(0, 30).map(roundSummary), meses },
    });
  });

  // Meus palpites + estatísticas (blocos do perfil).
  r.get("/meus-palpites", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const settings = await repo.settings();
    const preds = (await repo.predictionsOfUser(user.id, 300)).slice(0, 200);
    const [matches, rounds] = await Promise.all([repo.matchesByIds([...new Set(preds.map((p) => p.match_id))]), repo.rounds(60)]);
    const matchById = new Map(matches.map((m) => [m.id, m]));
    const roundById = new Map(rounds.map((x) => [x.id, x]));
    const stats = computeStats(preds, matchById);
    const itens = preds
      .filter((p) => matchById.has(p.match_id))
      .map((p) => {
        const m = matchById.get(p.match_id)!;
        return {
          jogo: { id: m.id, league: m.league, home: m.home, away: m.away, kickoff_utc: m.kickoff_utc, home_goals: m.home_goals, away_goals: m.away_goals, voided: m.voided },
          rodada: roundById.get(p.round_id) ? roundSummary(roundById.get(p.round_id)!) : { id: p.round_id, title: p.round_id, date: "", status: "" },
          palpite: predictionView(p, extrasOf(m, settings, true)),
        };
      })
      .sort((a, b) => b.jogo.kickoff_utc.getTime() - a.jogo.kickoff_utc.getTime());
    const best = stats.melhor_rodada;
    return c.json({
      itens,
      stats: { ...stats, melhor_rodada: best ? { ...best, titulo: roundById.get(best.round_id)?.title ?? best.round_id } : null },
    });
  });

  // Ficha do time: últimos 5 e próximos 3. Pode não estar disponível no plano grátis; nunca derruba a tela.
  r.get("/times/:id", async (c) => {
    const { repo } = c.get("ctx");
    const teamId = Number(c.req.param("id"));
    if (!Number.isInteger(teamId) || teamId <= 0) throw badRequest("Time inválido");
    const cached = await repo.db.get<any>(`team_cache/${teamId}`);
    const ttl = cached?.data.erro ? 3600_000 : 12 * 3600_000;
    if (cached && Date.now() - cached.data.fetched_at.getTime() < ttl) return c.json(cached.data);

    const settings = await repo.settings();
    const api = new ApiFootball(c.env, repo, settings);
    const doc: any = { ultimos: [], proximos: [], fetched_at: new Date(), erro: null };
    const slim = (f: any) => ({ id: f.id, kickoff: f.kickoff, status: f.status, league: f.league.name, home: f.home, away: f.away, home_goals: f.home_goals, away_goals: f.away_goals });
    try {
      doc.ultimos = (await api.teamFixtures(teamId, "last", 5)).map(slim);
      doc.proximos = (await api.teamFixtures(teamId, "next", 3)).map(slim);
    } catch (e: any) {
      doc.erro = e.message;
    }
    await repo.db.commit([{ op: "set", path: `team_cache/${teamId}`, data: doc }]);
    return c.json(doc);
  });

  // Push: guarda a inscrição do aparelho.
  r.post("/push/inscrever", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const b: any = await c.req.json().catch(() => ({}));
    const endpoint = String(b.endpoint ?? "");
    const p256dh = String(b.keys?.p256dh ?? "");
    const auth = String(b.keys?.auth ?? "");
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) throw badRequest("Inscrição inválida");
    await repo.db.commit([{ op: "set", path: `push_subs/${await subId(endpoint)}`, data: { user_id: user.id, endpoint, p256dh, auth, created_at: new Date() } }]);
    return c.json({ ok: true });
  });

  r.delete("/push/inscrever", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const b: any = await c.req.json().catch(() => ({}));
    const id = await subId(String(b.endpoint ?? ""));
    const sub = await repo.db.get<{ user_id: string }>(`push_subs/${id}`);
    if (sub && sub.data.user_id !== user.id) throw forbidden();
    if (sub) await repo.db.commit([{ op: "delete", path: `push_subs/${id}` }]);
    return c.json({ ok: true });
  });

  return r;
}
