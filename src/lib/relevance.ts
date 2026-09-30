import { normalizeName, type Settings } from "./settings";

export interface FixtureLike {
  league: { id: number };
  home: { name: string };
  away: { name: string };
}

/** Peso da liga + bônus por time grande e por clássico (os dois grandes). */
export function relevanceScore(f: FixtureLike, s: Pick<Settings, "leagueWeights" | "defaultLeagueWeight" | "bigTeams" | "bigTeamBonus" | "derbyBonus">): number {
  const base = s.leagueWeights[String(f.league.id)] ?? s.defaultLeagueWeight;
  const big = new Set(s.bigTeams.map(normalizeName));
  const homeBig = big.has(normalizeName(f.home.name));
  const awayBig = big.has(normalizeName(f.away.name));
  let bonus = 0;
  if (homeBig) bonus += s.bigTeamBonus;
  if (awayBig) bonus += s.bigTeamBonus;
  if (homeBig && awayBig) bonus += s.derbyBonus;
  return base + bonus;
}
