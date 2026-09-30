import { round2 } from "./odds";

export interface StatPrediction {
  match_id: string;
  round_id: string;
  points: number | null;
  hits: number | null;
  parts?: { winner: number; ou: number; cs: number } | null;
}

export interface StatMatch {
  id: string;
  home: { name: string };
  away: { name: string };
  voided: boolean;
}

export interface UserStats {
  palpites_pontuados: number;
  total_pontos: number;
  /** % de palpites em que acertou alguma coisa. */
  acerto_pct: number | null;
  melhor_rodada: { round_id: string; pontos: number } | null;
  /** Acerto de maior odd no vencedor (1X2) ou no placar exato. Gols (2,5) não conta. */
  maior_zebra: { odd: number; tipo: "1x2" | "placar"; jogo: string } | null;
}

/** Estatísticas do participante (blocos da tela de perfil). Anulados não entram. */
export function computeStats(preds: StatPrediction[], matches: Map<string, StatMatch>): UserStats {
  const settled = preds.filter((p) => p.points !== null && !matches.get(p.match_id)?.voided);
  const byRound = new Map<string, number>();
  let zebra: UserStats["maior_zebra"] = null;
  let total = 0;
  for (const p of settled) {
    total += p.points ?? 0;
    byRound.set(p.round_id, round2((byRound.get(p.round_id) ?? 0) + (p.points ?? 0)));
    const m = matches.get(p.match_id);
    if (!p.parts || !m) continue;
    const kinds: ["1x2" | "placar", number][] = [
      ["1x2", p.parts.winner],
      ["placar", p.parts.cs],
    ];
    for (const [tipo, part] of kinds) {
      if (part > 0 && (!zebra || part + 1 > zebra.odd)) zebra = { odd: round2(part + 1), tipo, jogo: `${m.home.name} x ${m.away.name}` };
    }
  }
  let best: UserStats["melhor_rodada"] = null;
  for (const [round_id, pontos] of byRound) if (!best || pontos > best.pontos) best = { round_id, pontos };
  return {
    palpites_pontuados: settled.length,
    total_pontos: round2(total),
    acerto_pct: settled.length ? Math.round((100 * settled.filter((p) => (p.hits ?? 0) > 0).length) / settled.length) : null,
    melhor_rodada: best,
    maior_zebra: zebra,
  };
}
