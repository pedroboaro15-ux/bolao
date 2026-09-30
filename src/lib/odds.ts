import type { MarketOdds, OddsMap } from "../types";

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Remove a margem da casa: p_i = 1/odd_i, normaliza por Σp e a odd justa é 1/p normalizada.
 * Devolve null se faltar alguma seleção ou houver odd inválida (≤ 1).
 */
export function removeMargin(raw: Record<string, number>, required: string[], cap = 150): Record<string, number> | null {
  const keys = Object.keys(raw);
  if (required.some((k) => !(raw[k] > 1))) return null;
  const use = keys.filter((k) => raw[k] > 1);
  if (use.length < 2) return null;
  const sum = use.reduce((s, k) => s + 1 / raw[k], 0);
  const fair: Record<string, number> = {};
  for (const k of use) {
    const p = 1 / raw[k] / sum;
    fair[k] = round2(Math.min(1 / p, cap));
  }
  return fair;
}

/** Margem (overround) do mercado, em %. Útil para diagnóstico. */
export function overround(raw: Record<string, number>): number {
  const sum = Object.values(raw).reduce((s, o) => s + 1 / o, 0);
  return round2((sum - 1) * 100);
}

// ---------- Poisson ----------

const MAXG = 10;

function pmf(lambda: number): number[] {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= MAXG; k++) out.push((out[k - 1] * lambda) / k);
  return out;
}

export function outcomeProbs(lh: number, la: number) {
  const ph = pmf(lh);
  const pa = pmf(la);
  let home = 0;
  let draw = 0;
  let away = 0;
  let over = 0;
  let total = 0;
  for (let i = 0; i <= MAXG; i++) {
    for (let j = 0; j <= MAXG; j++) {
      const p = ph[i] * pa[j];
      total += p;
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      if (i + j >= 3) over += p;
    }
  }
  return { home: home / total, draw: draw / total, away: away / total, over25: over / total };
}

/** Acha (λ casa, λ fora) cujo Poisson reproduz o 1X2 justo (e o Over 2,5 justo, se houver). */
export function fitPoisson(fair1x2: Record<string, number>, fairOu?: Record<string, number>): { lh: number; la: number } {
  const t = { home: 1 / fair1x2["1"], draw: 1 / fair1x2["X"], away: 1 / fair1x2["2"] };
  const tot = t.home + t.draw + t.away;
  t.home /= tot;
  t.draw /= tot;
  t.away /= tot;
  const tOver = fairOu?.over && fairOu?.under ? 1 / fairOu.over / (1 / fairOu.over + 1 / fairOu.under) : undefined;

  const loss = (lh: number, la: number) => {
    const p = outcomeProbs(lh, la);
    let l = (p.home - t.home) ** 2 + (p.draw - t.draw) ** 2 + (p.away - t.away) ** 2;
    if (tOver !== undefined) l += (p.over25 - tOver) ** 2;
    return l;
  };

  let best = { lh: 1.3, la: 1.1, l: Infinity };
  for (let lh = 0.1; lh <= 4.5; lh += 0.1) {
    for (let la = 0.1; la <= 4.5; la += 0.1) {
      const l = loss(lh, la);
      if (l < best.l) best = { lh, la, l };
    }
  }
  const c = best;
  for (let lh = Math.max(0.02, c.lh - 0.1); lh <= c.lh + 0.1; lh += 0.01) {
    for (let la = Math.max(0.02, c.la - 0.1); la <= c.la + 0.1; la += 0.01) {
      const l = loss(lh, la);
      if (l < best.l) best = { lh, la, l };
    }
  }
  return { lh: round2(best.lh), la: round2(best.la) };
}

/** Odd justa de um placar exato: mercado sem margem se existir; senão, modelo de Poisson. */
export function csFairOdd(odds: OddsMap | null | undefined, home: number, away: number, cap = 150): number | null {
  if (!odds) return null;
  const marketOdd = odds.CS?.fair[`${home}-${away}`];
  if (marketOdd) return round2(Math.min(marketOdd, cap));
  if (odds.model && home <= MAXG && away <= MAXG) {
    const p = pmf(odds.model.lh)[home] * pmf(odds.model.la)[away];
    return p > 0 ? round2(Math.min(1 / p, cap)) : cap;
  }
  return null;
}

/** Tabela "h-a" → odd justa para 0..max gols de cada lado (o front usa no stepper de placar). */
export function csTable(odds: OddsMap | null | undefined, cap = 150, max = 9): Record<string, number> {
  const out: Record<string, number> = {};
  for (let h = 0; h <= max; h++) {
    for (let a = 0; a <= max; a++) {
      const o = csFairOdd(odds, h, a, cap);
      if (o) out[`${h}-${a}`] = o;
    }
  }
  return out;
}

// ---------- montagem do mapa de odds ----------

export interface RawMarkets {
  "1X2"?: { source: string; raw: Record<string, number> };
  OU25?: { source: string; raw: Record<string, number> };
  CS?: { source: string; raw: Record<string, number> };
}

/** Transforma as odds brutas de cada mercado no mapa salvo no jogo (bruta + justa + modelo). */
export function buildOdds(markets: RawMarkets, now: Date, cap = 150): OddsMap | null {
  const out: OddsMap = {};
  const mk = (m: { source: string; raw: Record<string, number> } | undefined, required: string[]): MarketOdds | undefined => {
    if (!m) return undefined;
    const fair = removeMargin(m.raw, required, cap);
    return fair ? { source: m.source, fetched_at: now, raw: m.raw, fair } : undefined;
  };
  out["1X2"] = mk(markets["1X2"], ["1", "X", "2"]);
  out.OU25 = mk(markets.OU25, ["over", "under"]);
  out.CS = mk(markets.CS, []);
  for (const k of Object.keys(out) as (keyof OddsMap)[]) if (out[k] === undefined) delete out[k];
  if (out["1X2"]) out.model = fitPoisson(out["1X2"].fair, out.OU25?.fair);
  return Object.keys(out).length ? out : null;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
