import { normalizeName, type Settings } from "./settings";

export interface FixtureLike {
  league: { id: number; country?: string };
  home: { name: string };
  away: { name: string };
}

/** Peso da liga + bônus por time grande e por clássico (os dois grandes). */
export function relevanceScore(f: FixtureLike, s: Pick<Settings, "leagueWeights" | "defaultLeagueWeight" | "bigTeams" | "bigTeamBonus" | "derbyBonus">): number {
  const base = s.leagueWeights[String(f.league.id)] ?? s.defaultLeagueWeight;
  const big = new Set(s.bigTeams.map(normalizeName));
  const homeBig = big.has(normalizeName(f.home.name));
  const awayBig = big.has(normalizeName(f.away.name));
  // Brasileirão Série A, B, C e D: sempre no topo, nessa ordem, acima de qualquer outro campeonato.
  const serie = BR_SERIES[f.league.id];
  if (serie !== undefined && f.league.country === "Brazil") return serie;
  let bonus = 0;
  if (homeBig) bonus += s.bigTeamBonus;
  if (awayBig) bonus += s.bigTeamBonus;
  if (homeBig && awayBig) bonus += s.derbyBonus;
  return base + bonus;
}

/**
 * Séries do Brasileirão (ids da API-Football) e a relevância fixa de cada uma: A, B, C, D.
 * O resto do futebol brasileiro (estaduais, sub-20, feminino, ligas regionais) entra como qualquer outra liga.
 */
export const BR_SERIES: Record<number, number> = { 71: 1000, 72: 990, 75: 980, 76: 970 };
export const SERIE_NAME: Record<number, string> = { 71: "Série A", 72: "Série B", 75: "Série C", 76: "Série D" };
export const isBrSerie = (f: { league: { id: number; country?: string } }) => f.league.country === "Brazil" && f.league.id in BR_SERIES;
