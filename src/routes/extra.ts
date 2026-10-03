import { Hono } from "hono";
import type { AppEnv } from "../http";
import type { Repo } from "../db/repo";
import type { Write } from "../db/types";
import type { StandingRow, Standings } from "../types";
import { HttpError, badRequest, forbidden, notFound } from "../lib/errors";
import { addDays, bolaoDay, isDateString } from "../lib/dates";
import { takeSlot, waitText } from "../lib/ratelimit";
import { isLocked } from "../lib/predictions";
import { round2 } from "../lib/odds";
import { ApiFootball, FINISHED } from "../services/apifootball";
import { recalcRound } from "../services/results";
import { rebuildTotals, sortRows } from "../services/standings";

/**
 * Social e organização:
 * - Pedidos: sem rodada hoje, cada um vota nos jogos que quer (da lista de jogos já buscada pelo admin) ou escreve uma sugestão.
 * - Comentários em cada jogo e reações aos palpites (as reações só existem depois do apito, quando os palpites aparecem).
 * - Campeonatos: um período com nome e premiação; o ranking soma as rodadas (e perguntas do dia) dentro do período.
 * - Exclusão de rodada (fase de teste): apaga jogos, palpites, comentários e o ranking dela.
 */

export const REACTIONS = ["🔥", "😂", "👏", "😱", "🤡"] as const;
const COMMENT_MAX = 280;
const clean = (s: unknown, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const rand = () => `${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const list = async <T>(repo: Repo, coll: string, where: [string, "==", any][] = []) => (await repo.db.query<T>(coll, { where })).map((d) => ({ id: d.id, ...d.data }));

// ---------- campeonatos ----------

export interface Championship {
  name: string;
  start_date: string;
  end_date: string;
  prize: string;
  created_at: Date;
}

/** Ranking de um campeonato: soma os rankings já materializados das rodadas e das perguntas do dia dentro do período. */
export async function championshipRows(repo: Repo, ch: Championship): Promise<StandingRow[]> {
  const rounds = (await repo.rounds(400)).filter((r) => r.status !== "draft" && r.date >= ch.start_date && r.date <= ch.end_date);
  const days: string[] = [];
  for (let d = ch.start_date; d <= ch.end_date && days.length < 400; d = addDays(d, 1)) days.push(d);
  const paths = [...rounds.map((r) => `standings/round_${r.id}`), ...days.map((d) => `standings/questions_${d}`)];
  const docs: (Standings | null)[] = [];
  for (let i = 0; i < paths.length; i += 100) docs.push(...(await repo.db.getMany<Standings>(paths.slice(i, i + 100))).map((d) => d?.data ?? null));
  const acc = new Map<string, StandingRow>();
  for (const st of docs) {
    for (const r of st?.rows ?? []) {
      const cur = acc.get(r.user_id) ?? { ...r, points: 0, hits: 0 };
      cur.points = round2(cur.points + r.points);
      cur.hits += r.hits;
      acc.set(r.user_id, cur);
    }
  }
  return sortRows([...acc.values()]);
}

export function parseChampionship(b: any): Omit<Championship, "created_at"> {
  const name = clean(b?.name, 60);
  const start_date = String(b?.start_date ?? "");
  const end_date = String(b?.end_date ?? "");
  const prize = String(b?.prize ?? "").trim().slice(0, 600);
  if (name.length < 3) throw badRequest("Dê um nome ao campeonato");
  if (!isDateString(start_date) || !isDateString(end_date)) throw badRequest("Datas inválidas");
  if (end_date < start_date) throw badRequest("O fim precisa ser depois do início");
  return { name, start_date, end_date, prize };
}

/** Rotas do participante (já logado). */
export function extraPlayerRoutes() {
  const r = new Hono<AppEnv>();

  // ---------- pedidos: votar em jogos e sugerir ----------

  r.get("/pedidos", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const today = bolaoDay();
    const dates = [today, addDays(today, 1)];
    const caches = await repo.db.getMany<any>(dates.map((d) => `fixtures_cache/${d}`));
    const now = Date.now();
    const jogos = caches
      .flatMap((d) => d?.data.fixtures ?? [])
      .filter((f: any) => f.kickoff.getTime() > now)
      .sort((a: any, b: any) => b.relevance - a.relevance)
      .slice(0, 24)
      .map((f: any) => ({ id: f.id, kickoff: f.kickoff, league: f.league, home: f.home, away: f.away }));
    const votes = await list<any>(repo, "suggestions", [["kind", "==", "voto"]]);
    const recent = votes.filter((v) => dates.includes(v.date));
    const count = new Map<number, number>();
    for (const v of recent) count.set(v.fixture_id, (count.get(v.fixture_id) ?? 0) + 1);
    const mine = new Set(recent.filter((v) => v.user_id === user.id).map((v) => v.fixture_id));
    return c.json({ jogos: jogos.map((j) => ({ ...j, votos: count.get(j.id) ?? 0, meu: mine.has(j.id) })) });
  });

  // Votar (ou tirar o voto) num jogo da lista.
  r.post("/pedidos/voto", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const b: any = await c.req.json().catch(() => ({}));
    const fixture = Number(b.fixture_id);
    if (!Number.isInteger(fixture) || fixture <= 0) throw badRequest("Jogo inválido");
    const today = bolaoDay();
    const caches = await repo.db.getMany<any>([today, addDays(today, 1)].map((d) => `fixtures_cache/${d}`));
    const f = caches.flatMap((d) => d?.data.fixtures ?? []).find((x: any) => x.id === fixture);
    if (!f) throw badRequest("Esse jogo não está na lista");
    const id = `v_${fixture}_${user.id}`;
    const has = await repo.db.get(`suggestions/${id}`);
    if (has) await repo.db.commit([{ op: "delete", path: `suggestions/${id}` }]);
    else
      await repo.db.commit([
        { op: "set", path: `suggestions/${id}`, data: { kind: "voto", user_id: user.id, date: today, fixture_id: fixture, label: `${f.home.name} x ${f.away.name}`, text: null, created_at: new Date() } },
      ]);
    return c.json({ votou: !has });
  });

  // Sugestão livre (no máximo 5 por pessoa por dia).
  r.post("/pedidos/sugestao", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const text = clean((await c.req.json().catch(() => ({})) as any).texto, 280);
    if (text.length < 3) throw badRequest("Escreva a sugestão");
    const slot = await takeSlot(repo.db, `sugestao:${user.id}`, 5, 86400_000);
    if (!slot.ok) throw new HttpError(429, `Você já mandou 5 sugestões hoje. Volte em ${waitText(slot.resetAt)}.`);
    await repo.db.commit([{ op: "set", path: `suggestions/s_${rand()}`, data: { kind: "texto", user_id: user.id, date: bolaoDay(), fixture_id: null, label: null, text, created_at: new Date() } }]);
    return c.json({ ok: true }, 201);
  });

  // ---------- comentários e reações ----------

  r.get("/jogos/:id/social", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const matchId = c.req.param("id");
    const [comments, reactions, users] = await Promise.all([list<any>(repo, "comments", [["match_id", "==", matchId]]), list<any>(repo, "reactions", [["match_id", "==", matchId]]), repo.users()]);
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const byPred: Record<string, Record<string, { n: number; meu: boolean }>> = {};
    for (const x of reactions) {
      if (!nick.has(x.user_id)) continue;
      const slot = ((byPred[x.prediction_id] ??= {})[x.emoji] ??= { n: 0, meu: false });
      slot.n++;
      if (x.user_id === user.id) slot.meu = true;
    }
    return c.json({
      reacoes_possiveis: REACTIONS,
      reacoes: byPred,
      comentarios: comments
        .filter((x) => nick.has(x.user_id))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(-200)
        .map((x) => ({ id: x.id, nickname: nick.get(x.user_id), meu: x.user_id === user.id, text: x.text, created_at: x.created_at, pode_apagar: x.user_id === user.id || user.role === "admin" })),
    });
  });

  r.post("/jogos/:id/comentarios", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const match = await repo.match(c.req.param("id"));
    if (!match) throw notFound("Jogo não encontrado");
    const text = clean((await c.req.json().catch(() => ({})) as any).texto, COMMENT_MAX);
    if (!text) throw badRequest("Escreva o comentário");
    const slot = await takeSlot(repo.db, `comentario:${user.id}`, 6, 60_000);
    if (!slot.ok) throw new HttpError(429, `Calma! Espere ${waitText(slot.resetAt)} para comentar de novo.`);
    await repo.db.commit([{ op: "set", path: `comments/c_${rand()}`, data: { match_id: match.id, round_id: match.round_id, user_id: user.id, text, created_at: new Date() } }]);
    return c.json({ ok: true }, 201);
  });

  r.delete("/comentarios/:id", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const doc = await repo.db.get<any>(`comments/${c.req.param("id")}`);
    if (!doc) throw notFound("Comentário não encontrado");
    if (doc.data.user_id !== user.id && user.role !== "admin") throw forbidden("Só quem escreveu (ou o admin) apaga");
    await repo.db.commit([{ op: "delete", path: `comments/${doc.id}` }]);
    return c.json({ ok: true });
  });

  // Reagir a um palpite: só depois do apito (antes disso ninguém vê os palpites dos outros); não vale reagir ao próprio.
  r.post("/palpites/:id/reacao", async (c) => {
    const { repo } = c.get("ctx");
    const user = c.get("user");
    const emoji = String((await c.req.json().catch(() => ({})) as any).emoji ?? "");
    if (!(REACTIONS as readonly string[]).includes(emoji)) throw badRequest("Reação inválida");
    const pred = await repo.db.get<any>(`predictions/${c.req.param("id")}`);
    if (!pred) throw notFound("Palpite não encontrado");
    if (pred.data.user_id === user.id) throw badRequest("Não dá para reagir ao próprio palpite");
    const match = await repo.match(pred.data.match_id);
    if (!match || !isLocked(match.kickoff_utc, new Date())) throw badRequest("Os palpites só aparecem depois que o jogo começa");
    const id = `${pred.id}_${user.id}_${[...emoji].map((ch) => ch.codePointAt(0)!.toString(16)).join("")}`;
    const has = await repo.db.get(`reactions/${id}`);
    if (has) await repo.db.commit([{ op: "delete", path: `reactions/${id}` }]);
    else await repo.db.commit([{ op: "set", path: `reactions/${id}`, data: { prediction_id: pred.id, match_id: match.id, round_id: match.round_id, user_id: user.id, emoji, created_at: new Date() } }]);
    return c.json({ reagiu: !has });
  });

  // ---------- campeonatos ----------

  r.get("/campeonatos", async (c) => {
    const { repo } = c.get("ctx");
    const today = bolaoDay();
    const all = (await list<Championship>(repo, "championships")).sort((a, b) => b.start_date.localeCompare(a.start_date));
    return c.json({ campeonatos: all.map((x) => ({ ...x, situacao: today < x.start_date ? "em breve" : today > x.end_date ? "encerrado" : "em andamento" })) });
  });

  r.get("/campeonatos/:id/ranking", async (c) => {
    const { repo } = c.get("ctx");
    const doc = await repo.db.get<Championship>(`championships/${c.req.param("id")}`);
    if (!doc) throw notFound("Campeonato não encontrado");
    const users = await repo.users();
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const rows = (await championshipRows(repo, doc.data)).filter((x) => nick.has(x.user_id)).map((x) => ({ ...x, nickname: nick.get(x.user_id)! }));
    return c.json({ campeonato: { id: doc.id, ...doc.data }, rows });
  });

  return r;
}

/** Rotas do admin. */
export function extraAdminRoutes() {
  const r = new Hono<AppEnv>();

  // Pedidos: votos por jogo e sugestões escritas dos últimos dias.
  r.get("/pedidos", async (c) => {
    const { repo } = c.get("ctx");
    const since = addDays(bolaoDay(), -7);
    const [all, users] = await Promise.all([list<any>(repo, "suggestions"), repo.users()]);
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const recent = all.filter((x) => x.date >= since);
    const votos = new Map<number, { fixture_id: number; label: string; date: string; votos: number; quem: string[] }>();
    for (const v of recent.filter((x) => x.kind === "voto")) {
      const cur = votos.get(v.fixture_id) ?? { fixture_id: v.fixture_id, label: v.label, date: v.date, votos: 0, quem: [] };
      cur.votos++;
      cur.quem.push(nick.get(v.user_id) ?? "?");
      votos.set(v.fixture_id, cur);
    }
    return c.json({
      votos: [...votos.values()].sort((a, b) => b.votos - a.votos),
      sugestoes: recent
        .filter((x) => x.kind === "texto")
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((x) => ({ id: x.id, nickname: nick.get(x.user_id) ?? "?", text: x.text, created_at: x.created_at })),
    });
  });

  r.delete("/pedidos/:id", async (c) => {
    await c.get("ctx").repo.db.commit([{ op: "delete", path: `suggestions/${c.req.param("id")}` }]);
    return c.json({ ok: true });
  });

  // Excluir rodada (fase de teste): some do histórico, dos rankings e dos palpites.
  r.delete("/rodadas/:id", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const round = await repo.round(id);
    if (!round) throw notFound("Rodada não encontrada");
    const [matches, preds, comments, reactions] = await Promise.all([
      repo.matchesOfRound(id),
      repo.predictionsOfRound(id),
      list<any>(repo, "comments", [["round_id", "==", id]]),
      list<any>(repo, "reactions", [["round_id", "==", id]]),
    ]);
    const writes: Write[] = [
      ...preds.map((p) => ({ op: "delete" as const, path: `predictions/${p.id}` })),
      ...comments.map((x) => ({ op: "delete" as const, path: `comments/${x.id}` })),
      ...reactions.map((x) => ({ op: "delete" as const, path: `reactions/${x.id}` })),
      ...matches.map((m) => ({ op: "delete" as const, path: `matches/${m.id}` })),
      { op: "delete", path: `standings/round_${id}` },
      { op: "delete", path: `rounds/${id}` },
    ];
    for (let i = 0; i < writes.length; i += 400) await repo.db.commit(writes.slice(i, i + 400));
    const users = await repo.users();
    await rebuildTotals(repo, round.date.slice(0, 7), new Map(users.map((u) => [u.id, u.nickname])));
    return c.json({ ok: true, jogos: matches.length, palpites: preds.length });
  });

  // Buscar placares agora (sem o limite de 36 h do automático): para jogos que ficaram sem resultado.
  r.post("/rodadas/:id/placares", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    const settings = await repo.settings();
    const now = Date.now();
    const due = (await repo.matchesOfRound(id)).filter((m) => !m.voided && !m.manual_override && (m.home_goals === null || m.away_goals === null) && m.kickoff_utc.getTime() + 105 * 60_000 <= now);
    if (!due.length) return c.json({ atualizados: 0, motivo: "Nenhum jogo terminado sem placar" });
    const api = new ApiFootball(c.env, repo, settings);
    const fixtures = await api.fixturesByIds(due.slice(0, 20).map((m) => m.api_fixture_id));
    const byFx = new Map(fixtures.map((f) => [f.id, f]));
    const writes: Write[] = [];
    const pendentes: string[] = [];
    for (const m of due.slice(0, 20)) {
      const f = byFx.get(m.api_fixture_id);
      if (f && FINISHED.has(f.status) && f.home_goals !== null && f.away_goals !== null) writes.push({ op: "merge", path: `matches/${m.id}`, data: { status: f.status, home_goals: f.home_goals, away_goals: f.away_goals } });
      else pendentes.push(`${m.home.name} x ${m.away.name} (${f?.status ?? "não encontrado"})`);
    }
    if (writes.length) await repo.db.commit(writes);
    await recalcRound(repo, id, settings);
    return c.json({ atualizados: writes.length, pendentes });
  });

  // Campeonatos
  r.post("/campeonatos", async (c) => {
    const input = parseChampionship(await c.req.json().catch(() => ({})));
    const id = `ch_${rand()}`;
    await c.get("ctx").repo.db.commit([{ op: "set", path: `championships/${id}`, data: { ...input, created_at: new Date() }, mustNotExist: true }]);
    return c.json({ id }, 201);
  });
  r.put("/campeonatos/:id", async (c) => {
    const { repo } = c.get("ctx");
    const id = c.req.param("id");
    if (!(await repo.db.get(`championships/${id}`))) throw notFound("Campeonato não encontrado");
    await repo.db.commit([{ op: "merge", path: `championships/${id}`, data: parseChampionship(await c.req.json().catch(() => ({}))) }]);
    return c.json({ ok: true });
  });
  r.delete("/campeonatos/:id", async (c) => {
    await c.get("ctx").repo.db.commit([{ op: "delete", path: `championships/${c.req.param("id")}` }]);
    return c.json({ ok: true });
  });

  return r;
}
