import type { Zebra } from "../types";
import { round2 } from "./odds";

export interface ZebraPrediction {
  user_id: string;
  match_id: string;
  parts?: { winner: number; ou: number; cs: number } | null;
}

export interface ZebraMatch {
  home: { name: string };
  away: { name: string };
  voided: boolean;
}

/**
 * Maior odd acertada entre os palpites: vencedor (1X2) ou placar exato. Gols (2,5) não conta.
 * `parts` guarda o lucro (odd − 1) de cada acerto, sem o coringa; a odd acertada é `parte + 1`.
 */
export function bestZebra(preds: ZebraPrediction[], matches: Map<string, ZebraMatch>, nicknames: Map<string, string>): Zebra | null {
  let best: Zebra | null = null;
  for (const p of preds) {
    const m = matches.get(p.match_id);
    if (!p.parts || !m || m.voided) continue;
    const kinds: ["1x2" | "placar", number][] = [["1x2", p.parts.winner], ["placar", p.parts.cs]];
    for (const [tipo, part] of kinds) {
      const odd = round2(part + 1);
      if (part > 0 && (!best || odd > best.odd)) {
        best = { odd, tipo, jogo: `${m.home.name} x ${m.away.name}`, match_id: p.match_id, user_id: p.user_id, nickname: nicknames.get(p.user_id) ?? "?" };
      }
    }
  }
  return best;
}

/** A maior zebra entre várias (usado para somar rodadas em mês e geral). */
export function maxZebra(list: (Zebra | null | undefined)[]): Zebra | null {
  let best: Zebra | null = null;
  for (const z of list) if (z && (!best || z.odd > best.odd)) best = z;
  return best;
}
