import type { Env, LeagueRef, Match, Round, TeamRef } from "../types";
import type { Repo, WithId } from "../db/repo";
import { ConflictError, type Write } from "../db/types";
import type { Settings } from "../lib/settings";
import { badRequest, conflict } from "../lib/errors";
import { buildOdds } from "../lib/odds";
import { isBrazil, relevanceScore } from "../lib/relevance";
import { addDays, bolaoWindow } from "../lib/dates";
import { ApiFootball, QuotaError } from "./apifootball";

export interface CachedFixture {
  id: number;
  kickoff: Date;
  status: string;
  league: LeagueRef;
  home: TeamRef;
  away: TeamRef;
  relevance: number;
}

const MAX_CACHED = 150;

/** Jogos de um dia do calendário (Brasília) com relevância. Cache no banco; `force` busca de novo (1 chamada). */
async function calendarFixtures(repo: Repo, api: ApiFootball, settings: Settings, date: string, force: boolean) {
  if (!force) {
    const cached = await repo.db.get<{ fixtures: CachedFixture[]; fetched_at: Date }>(`fixtures_cache/${date}`);
    if (cached) return cached.data;
  }
  const list = await api.fixturesByDate(date);
  const fixtures: CachedFixture[] = list
    .filter((f) => !["CANC", "PST", "ABD"].includes(f.status))
    .map((f) => ({ id: f.id, kickoff: f.kickoff, status: f.status, league: f.league, home: f.home, away: f.away, relevance: relevanceScore(f, settings) }))
    .sort((a, b) => b.relevance - a.relevance || a.kickoff.getTime() - b.kickoff.getTime());
  // Os 150 mais relevantes do mundo + TODOS os do Brasil (Série B, C, D, estaduais), que nunca podem sumir da lista.
  const kept = fixtures.filter((f, i) => i < MAX_CACHED || isBrazil(f));
  const doc = { date, fetched_at: new Date(), total: fixtures.length, fixtures: kept };
  await repo.db.commit([{ op: "set", path: `fixtures_cache/${date}`, data: doc }]);
  return doc;
}

/**
 * Jogos do DIA DO BOLÃO `date`: das 06:00 desse dia até as 06:00 do seguinte (São Paulo).
 * Como a API separa por dia do calendário, junta o dia `date` e o seguinte e filtra pela janela.
 * Cada dia do calendário fica em cache, então em regime normal gasta ~1 chamada por dia.
 */
export async function loadFixtures(repo: Repo, api: ApiFootball, settings: Settings, date: string, force = false) {
  const first = await calendarFixtures(repo, api, settings, date, force);
  const second = await calendarFixtures(repo, api, settings, addDays(date, 1), force);
  const { start, end } = bolaoWindow(date);
  const seen = new Set<number>();
  const fixtures = [...first.fixtures, ...second.fixtures]
    .filter((f) => f.kickoff >= start && f.kickoff < end && !seen.has(f.id) && seen.add(f.id))
    .map((f) => ({ ...f, relevance: relevanceScore(f, settings) })) // recalcula: vale a configuração de agora, mesmo com a lista em cache
    .sort((a, b) => b.relevance - a.relevance || a.kickoff.getTime() - b.kickoff.getTime());
  const fetched = [first.fetched_at, second.fetched_at].sort((a, b) => a.getTime() - b.getTime())[0];
  return { date, fetched_at: fetched, total: fixtures.length, fixtures, janela: { inicio: start, fim: end } };
}

async function freeRoundId(repo: Repo, date: string): Promise<string> {
  const same = (await repo.rounds(60)).filter((r) => r.date === date).length;
  return same === 0 ? date : `${date}-${same + 1}`;
}

export interface CreateRoundInput {
  title: string;
  date: string;
  fixtureIds: number[];
  open: boolean;
}

/** Quantos jogos já foram escolhidos neste dia do bolão (somando todas as rodadas do dia). */
export async function chosenToday(repo: Repo, date: string): Promise<number> {
  return (await repo.rounds(60)).filter((r) => r.date === date).reduce((n, r) => n + r.match_ids.length, 0);
}

/** Cria a rodada (e os jogos) a partir dos jogos escolhidos pelo admin, respeitando o limite de jogos por dia. */
export async function createRound(repo: Repo, input: CreateRoundInput, fixtures: CachedFixture[], settings: Pick<Settings, "maxMatchesPerDay">): Promise<{ roundId: string; matchIds: string[] }> {
  const ids = [...new Set(input.fixtureIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length < 1) throw badRequest("Escolha pelo menos 1 jogo");
  const already = await chosenToday(repo, input.date);
  const left = Math.max(0, settings.maxMatchesPerDay - already);
  if (ids.length > left) {
    throw badRequest(
      left === 0
        ? `O limite de ${settings.maxMatchesPerDay} jogos deste dia já foi atingido`
        : `Este dia permite ${settings.maxMatchesPerDay} jogos e já tem ${already}: você pode escolher no máximo mais ${left}`,
    );
  }
  const title = input.title.trim().slice(0, 80);
  if (!title) throw badRequest("Dê um nome para a rodada");

  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const chosen = ids.map((id) => byId.get(id));
  if (chosen.some((f) => !f)) throw badRequest("Algum jogo escolhido não está na lista do dia");
  const now = new Date();
  if ((chosen as CachedFixture[]).every((f) => f.kickoff <= now)) throw badRequest("Todos os jogos escolhidos já começaram");

  const roundId = await freeRoundId(repo, input.date);
  const writes: Write[] = [];
  for (const f of chosen as CachedFixture[]) {
    const match: Match = {
      round_id: roundId,
      api_fixture_id: f.id,
      league: f.league,
      home: f.home,
      away: f.away,
      kickoff_utc: f.kickoff,
      status: f.status,
      home_goals: null,
      away_goals: null,
      manual_override: false,
      voided: false,
      relevance: f.relevance,
      odds: null,
      frozen_odds: null,
    };
    writes.push({ op: "set", path: `matches/${f.id}`, data: match as any, mustNotExist: true });
  }
  const round: Round = { title, date: input.date, status: input.open ? "open" : "draft", created_at: now, match_ids: ids.map(String) };
  writes.push({ op: "set", path: `rounds/${roundId}`, data: round as any, mustNotExist: true });
  try {
    await repo.db.commit(writes);
  } catch (e) {
    if (e instanceof ConflictError) throw conflict("Algum desses jogos já está em outra rodada");
    throw e;
  }
  return { roundId, matchIds: ids.map(String) };
}

/** Busca as odds de um jogo e grava o mapa inteiro (bruta + justa + modelo). */
export async function refreshMatchOdds(repo: Repo, api: ApiFootball, settings: Settings, match: WithId<Match>, opts: { keepReserve?: boolean; spaced?: boolean } = {}) {
  if (match.kickoff_utc <= new Date()) return { ok: false as const, motivo: "O jogo já começou" };
  const raw = await api.odds(match.api_fixture_id, opts);
  const built = buildOdds(raw, new Date(), settings.oddCap);
  if (!built || !built["1X2"]) {
    await repo.db.commit([{ op: "merge", path: `matches/${match.id}`, data: { odds_error: "A API não trouxe odds 1X2 para este jogo" } }]);
    return { ok: false as const, motivo: "A API não trouxe odds 1X2 para este jogo" };
  }
  await repo.db.commit([{ op: "merge", path: `matches/${match.id}`, data: { odds: built, odds_error: null } }]);
  return { ok: true as const };
}

/** Odds digitadas pelo admin (quando a API não traz): entram como fonte "manual". */
export async function setManualOdds(repo: Repo, settings: Settings, match: WithId<Match>, input: any) {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const m1 = { "1": num(input?.["1"]), X: num(input?.X), "2": num(input?.["2"]) };
  const ou = { over: num(input?.over), under: num(input?.under) };
  const clean = (o: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, number>;
  const raw1 = clean(m1);
  if (Object.keys(raw1).length !== 3 || Object.values(raw1).some((v) => !(v > 1))) throw badRequest("Informe as três odds 1, X e 2 (maiores que 1)");
  const rawOu = clean(ou);
  const built = buildOdds(
    { "1X2": { source: "manual", raw: raw1 }, ...(Object.keys(rawOu).length === 2 ? { OU25: { source: "manual", raw: rawOu } } : {}) },
    new Date(),
    settings.oddCap,
  );
  if (!built) throw badRequest("Odds inválidas");
  const data: Record<string, any> = { odds: built, odds_error: null };
  // Se o jogo já começou e não havia odd congelada, a manual também vale como congelada.
  if (match.kickoff_utc <= new Date() && !match.frozen_odds) data.frozen_odds = built;
  await repo.db.commit([{ op: "merge", path: `matches/${match.id}`, data }]);
}

/**
 * Congela o que valia quando o jogo começou: as odds (copia `odds` → `frozen_odds`) e os extras ligados
 * (gols / placar exato). Assim ligar ou desligar um extra depois do início não muda o jogo que já começou.
 */
export async function freezeStarted(repo: Repo, matches: WithId<Match>[], settings: Pick<Settings, "goalsEnabled" | "scoreEnabled">, now = new Date()): Promise<number> {
  const writes: Write[] = [];
  for (const m of matches) {
    if (m.kickoff_utc > now) continue;
    const data: Record<string, any> = {};
    if (!m.frozen_odds && m.odds) data.frozen_odds = m.odds;
    if (!m.extras_frozen) data.extras_frozen = { ou: settings.goalsEnabled, cs: settings.scoreEnabled };
    if (Object.keys(data).length) writes.push({ op: "merge", path: `matches/${m.id}`, data });
  }
  if (writes.length) await repo.db.commit(writes);
  return writes.length;
}

/** open → closed quando todos os jogos já começaram (ou foram anulados). */
export async function closeStartedRounds(repo: Repo, rounds: WithId<Round>[], now = new Date()): Promise<void> {
  for (const r of rounds.filter((x) => x.status === "open")) {
    const matches = await repo.matchesOfRound(r.id);
    if (matches.length && matches.every((m) => m.voided || m.kickoff_utc <= now)) {
      await repo.db.commit([{ op: "merge", path: `rounds/${r.id}`, data: { status: "closed" } }]);
    }
  }
}

/** Jogos que precisam de odds agora (sem odds, ou desatualizadas dentro da janela). */
export function needsOdds(m: Pick<Match, "kickoff_utc" | "odds" | "voided">, settings: Settings, now = new Date()): boolean {
  if (m.voided) return false;
  const untilKickoff = m.kickoff_utc.getTime() - now.getTime();
  if (untilKickoff <= 0) return false;
  if (!m.odds?.["1X2"]) return true;
  const age = now.getTime() - m.odds["1X2"].fetched_at.getTime();
  // Foto final perto do jogo: é a que vai ser congelada.
  if (untilKickoff <= 75 * 60_000) return age >= 30 * 60_000;
  if (untilKickoff <= settings.oddsWindowHours * 3600_000) return age >= settings.oddsRefreshHours * 3600_000;
  return false;
}

export async function refreshOddsBatch(repo: Repo, api: ApiFootball, settings: Settings, matches: WithId<Match>[], max: number, now = new Date()) {
  const todo = matches.filter((m) => needsOdds(m, settings, now)).sort((a, b) => a.kickoff_utc.getTime() - b.kickoff_utc.getTime()).slice(0, max);
  const out = { atualizados: 0, falhas: 0, parou: null as string | null };
  for (const m of todo) {
    try {
      const r = await refreshMatchOdds(repo, api, settings, m, { keepReserve: true, spaced: true });
      if (r.ok) out.atualizados++;
      else out.falhas++;
    } catch (e: any) {
      if (e instanceof QuotaError) {
        out.parou = e.message;
        break;
      }
      out.falhas++;
      console.error("odds falhou", m.id, e?.message);
    }
  }
  return out;
}
