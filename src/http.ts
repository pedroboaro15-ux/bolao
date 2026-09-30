import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, Match, Prediction, UserDoc } from "./types";
import type { Ctx } from "./context";
import type { WithId } from "./db/repo";

export type AppEnv = {
  Bindings: Env;
  Variables: { ctx: Ctx; user: WithId<UserDoc> };
};

export const COOKIE = "bolao_sessao";

/** Cache curto do usuário logado (a existência e o papel vêm do banco, 1 leitura a cada 30 s por isolate). */
export const userCache = new Map<string, { user: WithId<UserDoc> | null; exp: number }>();
export const forgetUser = (uid: string) => userCache.delete(uid);

/** Cookie de sessão da requisição. */
export const sessionCookie = (c: Context<AppEnv>): string | undefined => getCookie(c, COOKIE);

// ---------- visões (o que sai para o navegador) ----------

import { csTable } from "./lib/odds";
import type { Settings } from "./lib/settings";
import { isLocked } from "./lib/predictions";
import { activeMode, ALL_EXTRAS, type Extras } from "./lib/scoring";

/** Extras valendo neste jogo: se já começou, os que valiam no início; senão, a configuração de agora. */
export function extrasOf(m: Pick<Match, "extras_frozen">, settings: Settings, locked: boolean): Extras {
  return locked && m.extras_frozen ? m.extras_frozen : { ou: settings.goalsEnabled, cs: settings.scoreEnabled };
}

/** Palpite como o navegador vê. Se o extra escolhido foi desligado, ele some (vale só o vencedor). */
export function predictionView(p: Prediction | null, extras: Extras = ALL_EXTRAS) {
  if (!p) return null;
  const mode = activeMode(p.mode, extras);
  return {
    mode,
    pick_1x2: p.pick_1x2,
    pick_ou: mode === "ou" ? p.pick_ou : null,
    home_goals: mode === "cs" ? p.home_goals : null,
    away_goals: mode === "cs" ? p.away_goals : null,
    joker: p.joker,
    points: p.points,
    hits: p.hits,
  };
}

/** Jogo como o participante vê. Odds: as congeladas se já começou, senão as ao vivo. */
export function matchView(m: WithId<Match>, mine: Prediction | null, settings: Settings, now: Date) {
  const locked = isLocked(m.kickoff_utc, now);
  const odds = locked ? (m.frozen_odds ?? m.odds) : m.odds;
  const extras = extrasOf(m, settings, locked);
  return {
    id: m.id,
    round_id: m.round_id,
    league: m.league,
    home: m.home,
    away: m.away,
    kickoff_utc: m.kickoff_utc,
    status: m.status,
    voided: m.voided,
    locked,
    settled: m.voided || (m.home_goals !== null && m.away_goals !== null),
    home_goals: m.home_goals,
    away_goals: m.away_goals,
    odds_1x2: odds?.["1X2"]?.fair ?? null,
    odds_ou: odds?.OU25?.fair ?? null,
    cs: odds?.["1X2"] || odds?.CS ? csTable(odds, settings.oddCap) : null,
    odds_source: odds?.["1X2"]?.source ?? null,
    extras,
    mine: predictionView(mine, extras),
  };
}
