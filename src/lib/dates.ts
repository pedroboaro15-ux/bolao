/**
 * "Dia do bolão": começa às 06:00 e termina às 06:00 (horário de São Paulo, UTC−3, sem horário de verão).
 * Ou seja, vai de 09:00Z do dia D até 09:00Z do dia D+1. Jogos de madrugada pertencem ao dia anterior.
 */
export const DAY_START_UTC_HOUR = 9;

export function bolaoDay(d: Date = new Date()): string {
  return new Date(d.getTime() - DAY_START_UTC_HOUR * 3600_000).toISOString().slice(0, 10);
}

/** Janela [início, fim) do dia do bolão. */
export function bolaoWindow(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T0${DAY_START_UTC_HOUR}:00:00Z`);
  return { start, end: new Date(start.getTime() + 24 * 3600_000) };
}

/** Dia em UTC: a cota da API-Football zera às 00:00 UTC. */
export function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isDateString = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
