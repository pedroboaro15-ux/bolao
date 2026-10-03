import { normalizeName, type Settings } from "./settings";

export interface FixtureLike {
  league: { id: number; country?: string };
  home: { name: string };
  away: { name: string };
}

/** Peso da liga + bônus por time grande e por clássico (os dois grandes). */
export function relevanceScore(f: FixtureLike, s: Pick<Settings, "leagueWeights" | "defaultLeagueWeight" | "bigTeams" | "bigTeamBonus" | "derbyBonus"> & { brazilBonus?: number }): number {
  const base = s.leagueWeights[String(f.league.id)] ?? s.defaultLeagueWeight;
  const big = new Set(s.bigTeams.map(normalizeName));
  const homeBig = big.has(normalizeName(f.home.name));
  const awayBig = big.has(normalizeName(f.away.name));
  let bonus = isBrazil(f) ? (s.brazilBonus ?? 0) : 0;
  if (homeBig) bonus += s.bigTeamBonus;
  if (awayBig) bonus += s.bigTeamBonus;
  if (homeBig && awayBig) bonus += s.derbyBonus;
  return base + bonus;
}

/** Campeonato brasileiro (a API-Football chama o país de "Brazil"). */
export const isBrazil = (f: { league: { country?: string } }) => f.league.country === "Brazil";
