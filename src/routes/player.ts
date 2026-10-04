import { Hono } from "hono";
import type { Prediction, ProfileEdits, Standings } from "../types";
import { extrasOf, forgetUser, matchView, predictionView, type AppEnv } from "../http";
import { userView } from "./public";
import type { Repo } from "../db/repo";
import type { Write } from "../db/types";
import type { Settings } from "../lib/settings";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { nicknameTaken, parseNickname, parsePhone } from "../lib/profile";
import { emailKey, limitsOf, takeSlot, waitText } from "../lib/ratelimit";
import { isLocked, parsePredictionInput, predictionBlockedReason, type PredictionInput } from "../lib/predictions";
import { computeStats } from "../lib/stats";
import { subId } from "../services/push";
import { ApiFootball } from "../services/apifootball";
import { refreshLive } from "../services/live";
import { answersOf, isClosed, isSettledQ, questionView, questionsOfDay } from "../services/questions";
import { bolaoDay, isDateString } from "../lib/dates";

/** Rodada de um dia que já passou aparece como encerrada, mesmo se algum resultado ainda não chegou. */
const roundSummary = (r: { id: string; title: string; date: string; status: string; required?: string }, today = bolaoDay()) => ({
  id: r.id,
  title: r.title,
  date: r.date,
  status: r.date < today && r.status !== "draft" ? "finished" : r.status,
  required: r.required === "winner_goals" ? "winner_goals" : "winner",
});

async function roundView(repo: Repo, roundId: string, userId: string, settings: Settings, now: Date, isAdmin: boolean) {
  const round = await repo.round(roundId);
  if (!round || (round.status === "draft" && !isAdmin)) throw notFound("Rodada não encontrada");
  const [matches, mine] = await Promise.all([repo.matchesOfRound(roundId), repo.predictionsOfUserRound(userId, roundId)]);
  const mineByMatch = new Map(mine.map((p) => [p.match_id, p]));
  return {
    rodada: roundSummary(round),
    jogos: matches.map((m) => matchView(m, mineByMatch.get(m.id) ?? null, settings, now)),
    agora: now,
    raw: matches,
  };
}

/** Atualiza o placar ao vivo em segundo plano (no máximo 1 chamada à API a cada 5 min por rodada). Fora do modo demo. */
function liveInBackground(c: any, repo: Repo, settings: Settings, roundId: string, matches: Parameters<typeof refreshLive>[3]) {
  if (c.env.DEV_MEMORY === "1") return;
  c.executionCtx.waitUntil(refreshLive(repo, new ApiFootball(c.env, repo, settings), roundId, matches).catch((e) => console.error("ao vivo:", e?.message)));
}

/** O ranking guarda o apelido da época; aqui ele é trocado pelo apelido de agora (a pessoa pode ter mudado). */
const withNick = <T extends { user_id?: string; nickname?: string }>(x: T, nick: Map<string, string>): T => ({ ...x, nickname: (x.user_id && nick.get(x.user_id)) || x.nickname });

/**
 * Rodada atual = a do DIA DE HOJE do bolão (a aberta, se houver mais de uma). Sem rodada hoje: null, e a tela de início
 * mostra os pedidos (votar em jogos, sugerir). Rodadas de dias anteriores aparecem como encerradas. `outras` = as mais recentes.
 */
async function roundsNav(repo: Repo) {
  const today = bolaoDay();
  const rounds = (await repo.rounds(30)).filter((x) => x.status !== "draft");
  const ofToday = rounds.filter((x) => x.date === today);
  const current = ofToday.find((x) => x.status === "open") ?? ofToday[0];
  return { outras: rounds.slice(0, 10).map((x) => roundSummary(x, today)), atual: current?.id ?? null, hoje: today };
}

export function playerRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/rodadas", async (c) => {
    const { repo } = c.get("ctx");
    const rounds = (await repo.rounds(60)).filter((x) => x.status !== "draft");
    return c.json({ rodadas: rounds.map((x) => roundSummary(x)) });
  });

  // Rodada atual: a aberta mais recente; senão a última fechada/encerrada.
  r.get("/rodada/atual", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const nav = await roundsNav(repo);
    if (!nav.atual) return c.json({ rodada: null, jogos: [], ...nav, agora: new Date() });
    const settings = await repo.settings();
    const { raw, ...view } = await roundView(repo, nav.atual, user.id, settings, new Date(), user.role === "admin");
    liveInBackground(c, repo, settings, nav.atual, raw);
    return c.json({ ...view, ...nav });
  });

  // Qualquer rodada (ex.: a de ontem). Devolve também a lista de rodadas e qual é a atual,
  // para a tela sempre ter como voltar para a rodada de hoje.
  r.get("/rodadas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const settings = await repo.settings();
    const { raw, ...view } = await roundView(repo, c.req.param("id"), user.id, settings, new Date(), user.role === "admin");
    liveInBackground(c, repo, settings, view.rodada.id, raw);
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
      // Rodada que exige gols: só vencedor não basta (gols ou placar exato, se algum dos dois estiver ligado).
      const precisaGols = round.required === "winner_goals" && (settings.goalsEnabled || settings.scoreEnabled);
      if (precisaGols && inp.mode === null) {
        erros[inp.match_id] = settings.goalsEnabled ? "Nesta rodada os gols também são obrigatórios: escolha mais ou menos de 2,5 (ou o placar exato)" : "Nesta rodada o placar exato também é obrigatório";
        continue;
      }
      const blocked = predictionBlockedReason(m, round, now);
      if (blocked) {
        erros[inp.match_id] = blocked;
        continue;
      }
      accepted.push(inp);
    }

    const writes: Write[] = [];

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
        joker: false,
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
        .map((p) => ({ id: p.id, user_id: p.user_id, nickname: nick.get(p.user_id) ?? "?", ...predictionView(p, view.extras)! }))
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
    const [st, users] = await Promise.all([escopo === "mes" && !id ? null : repo.standings(docId), repo.users()]);
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    return c.json({
      escopo,
      id,
      titulo,
      rows: (st?.rows ?? []).map((x) => withNick(x, nick)),
      zebra: st?.zebra ? withNick(st.zebra as any, nick) : null,
      updated_at: st?.updated_at ?? null,
      opcoes: { rodadas: rounds.slice(0, 30).map((x) => roundSummary(x)), meses },
    });
  });

  // Ganho por rodada: quanto cada participante fez em cada uma das últimas rodadas (usa o ranking já materializado de cada rodada).
  r.get("/ranking/rodadas", async (c) => {
    const { repo } = c.get("ctx");
    const rounds = (await repo.rounds(60)).filter((x) => x.status !== "draft").slice(0, 10).reverse();
    const [docs, users] = await Promise.all([repo.db.getMany<Standings>(rounds.map((x) => `standings/round_${x.id}`)), repo.users()]);
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const people = new Map<string, { user_id: string; nickname: string; total: number; porRodada: Record<string, number> }>();
    rounds.forEach((rd, i) => {
      for (const row of docs[i]?.data.rows ?? []) {
        if (!nick.has(row.user_id)) continue; // conta removida
        const p = people.get(row.user_id) ?? { user_id: row.user_id, nickname: nick.get(row.user_id)!, total: 0, porRodada: {} };
        p.porRodada[rd.id] = Math.round(row.points * 100) / 100;
        p.total = Math.round((p.total + row.points) * 100) / 100;
        people.set(row.user_id, p);
      }
    });
    return c.json({
      rodadas: rounds.map(roundSummary),
      participantes: [...people.values()].sort((a, b) => b.total - a.total || a.nickname.localeCompare(b.nickname, "pt-BR")),
    });
  });

  // ---------- perfil: apelido, telefone e senha, uma vez cada (depois, só o administrador libera outra) ----------

  const ONCE = (fem: boolean) => `só pode ser alterad${fem ? "a" : "o"} uma vez. Peça ao administrador para liberar uma nova alteração.`;

  r.put("/perfil", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const body: any = await c.req.json().catch(() => ({}));
    const edits: ProfileEdits = { ...(user.edits ?? {}) };
    const data: Record<string, any> = {};

    if (body.nickname !== undefined) {
      const nickname = parseNickname(body.nickname);
      if (nickname !== user.nickname) {
        if (edits.nickname) throw forbidden(`O apelido ${ONCE(false)}`);
        if (nicknameTaken(await repo.users(), nickname, user.id)) throw conflict("Esse apelido já está em uso. Escolha outro.");
        data.nickname = nickname;
        if (user.name === user.nickname) data.name = nickname;
        edits.nickname = true;
      }
    }
    if (body.phone !== undefined) {
      const phone = parsePhone(body.phone);
      if (phone !== (user.phone ?? null)) {
        if (edits.phone) throw forbidden(`O telefone ${ONCE(false)}`);
        data.phone = phone;
        edits.phone = true;
      }
    }
    if (!Object.keys(data).length) throw badRequest("Nada para alterar");

    await repo.db.commit([{ op: "merge", path: `users/${user.id}`, data: { ...data, edits }, mustExist: true }]);
    forgetUser(user.id);
    return c.json({ usuario: userView(user.id, { ...user, ...data, edits }) });
  });

  r.post("/perfil/senha", async (c) => {
    const { repo, auth } = c.get("ctx");
    const user = c.get("user");
    const body: any = await c.req.json().catch(() => ({}));
    const atual = String(body.atual ?? "");
    const nova = String(body.nova ?? "");
    if (user.edits?.password) throw forbidden(`A senha ${ONCE(true)}`);
    if (!atual) throw badRequest("Informe a senha atual");
    if (nova.length < 8 || nova.length > 100) throw badRequest("A senha nova deve ter pelo menos 8 caracteres");
    if (nova !== String(body.confirmar ?? "")) throw badRequest("As senhas não são iguais");
    if (nova === atual) throw badRequest("A senha nova deve ser diferente da atual");

    // Conferir a senha atual conta como tentativa de login (mesmo limite de 5 erros).
    const lim = limitsOf(c.env);
    const slot = await takeSlot(repo.db, `login:${await emailKey(user.email)}`, lim.loginFails, lim.loginWindowMs);
    if (!slot.ok) throw new HttpError(429, `Muitas tentativas erradas. Tente de novo em ${waitText(slot.resetAt)}.`);
    try {
      await auth.signIn(user.email, atual);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw badRequest("A senha atual está incorreta");
      throw e;
    }
    await slot.clear();

    await auth.updatePassword(user.id, nova);
    await repo.db.commit([{ op: "merge", path: `users/${user.id}`, data: { edits: { ...(user.edits ?? {}), password: true } }, mustExist: true }]);
    forgetUser(user.id);
    return c.json({ ok: true });
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

  // ---------- perguntas do dia (também basquete e UFC) ----------

  r.get("/perguntas", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const date = c.req.query("date") ?? bolaoDay();
    if (!isDateString(date)) throw badRequest("Data inválida");
    const now = new Date();
    const qs = await questionsOfDay(repo, date);
    if (!qs.length) return c.json({ date, perguntas: [] });
    const all = await answersOf(repo, "date", date);
    return c.json({
      date,
      perguntas: qs.map((q) => {
        const mine = all.find((a) => a.question_id === q.id && a.user_id === user.id) ?? null;
        return questionView(q, mine, all.filter((a) => a.question_id === q.id), now);
      }),
    });
  });

  // Responder: uma opção por pergunta, até a hora de fechar (conferida aqui, com a hora do servidor).
  r.put("/perguntas/:id/resposta", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const qid = c.req.param("id");
    const body: any = await c.req.json().catch(() => ({}));
    const doc = await repo.db.get<any>(`questions/${qid}`);
    if (!doc) throw notFound("Pergunta não encontrada");
    const q = { id: doc.id, ...doc.data };
    const now = new Date();
    if (isClosed(q, now) || isSettledQ(q)) throw badRequest("Esta pergunta já fechou");
    const optionId = String(body.option_id ?? "");
    if (!q.options.some((o: any) => o.id === optionId)) throw badRequest("Opção inválida");
    const id = `${qid}_${user.id}`;
    const prev = await repo.db.get<any>(`answers/${id}`);
    await repo.db.commit([
      { op: "set", path: `answers/${id}`, data: { question_id: qid, user_id: user.id, date: q.date, option_id: optionId, points: null, hits: null, created_at: prev?.data.created_at ?? now, updated_at: now } },
    ]);
    return c.json({ ok: true });
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
