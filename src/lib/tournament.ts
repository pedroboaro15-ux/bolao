/**
 * Campeonato de confrontos 1×1. Cada "rodada do campeonato" é um dia do bolão (com rodada de jogos) dentro do período.
 * O lucro do dia de cada participante vira GOLS no confronto: gols = piso(lucro): 1 de lucro = 1 gol.
 * No confronto, mesmo número de gols é empate; as casas decimais só desempatam a classificação.
 *
 * Formatos (o admin escolhe): pontos corridos (todos contra todos), grupos, mata-mata e copa (grupos + mata-mata),
 * cada um só ida ou ida e volta. Tudo é calculado na leitura a partir dos resultados de cada dia: nada é gravado.
 *
 * Provisório até o dono decidir:
 * - pênaltis no mata-mata (empate no agregado): passa quem teve mais acertos no confronto; se ainda empatar, a melhor posição de entrada;
 * - quem não palpitou no dia faz 0 gols (não há W.O. especial).
 */

export type TournamentFormat = "pontos" | "grupos" | "mata" | "copa";
export const FORMATS: Record<TournamentFormat, string> = {
  pontos: "Pontos corridos",
  grupos: "Grupos",
  mata: "Mata-mata",
  copa: "Copa (grupos + mata-mata)",
};

export interface TournamentConfig {
  format: TournamentFormat;
  /** 1 = só ida; 2 = ida e volta. */
  legs: 1 | 2;
  /** Participantes na ordem de entrada (a ordem também é a "cabeça de chave"). */
  participants: string[];
  /** Quantos grupos (grupos e copa). */
  groups: number;
  /** Quantos de cada grupo passam para o mata-mata (copa). */
  advance: number;
  /** Quantos pontos de lucro valem 1 gol. */
  goalStep: number;
}

/** Resultado de um participante num dia (ausente = não palpitou: 0). */
export interface DayScore {
  points: number;
  hits: number;
}
export interface Matchday {
  date: string | null;
  /** Já tem resultado (o dia acabou ou todas as rodadas do dia terminaram). */
  final: boolean;
  /** Já começou (há pontos parciais). */
  started: boolean;
  scores: Map<string, DayScore>;
}

export interface Fixture {
  home: string | null; // null = a definir
  away: string | null;
  hg: number | null;
  ag: number | null;
  /** Rótulo do confronto no mata-mata (ida/volta). */
  note?: string;
}

export interface TableRow {
  user_id: string;
  pos: number;
  P: number;
  J: number;
  V: number;
  E: number;
  D: number;
  GP: number;
  GC: number;
  SG: number;
  /** Lucro somado nos confrontos: só desempata (as casas decimais que não viraram gol). */
  L: number;
  /** Últimos 5 confrontos, do mais antigo para o mais recente: "V", "E" ou "D". */
  last5: ("V" | "E" | "D")[];
}

import type { Shootout } from "./penalties";

/** Chave de uma disputa de pênaltis: fase + os dois participantes. */
export const shootoutKey = (stage: string, a: string, b: string) => `${stage}|${a}|${b}`;

export interface Tie {
  a: string | null;
  b: string | null;
  ga: number | null;
  gb: number | null;
  winner: string | null;
  /** "pênaltis" quando o agregado empatou. */
  decidedBy?: string;
  /** Lucro somado nos jogos do confronto (ida + volta). */
  la?: number | null;
  lb?: number | null;
  /** Pênaltis: vence quem teve mais lucro; lucro igual = disputa sorteada (cobranças). */
  pens?: { by: "lucro" } | { by: "cobranças"; key: string; pending: true } | ({ by: "cobranças"; key: string; pending?: false } & Shootout);
}

export interface TournamentView {
  groups: { name: string; table: TableRow[] }[];
  rounds: { n: number; date: string | null; stage: string; final: boolean; fixtures: Fixture[] }[];
  knockout: { stage: string; ties: Tie[] }[];
  champion: string | null;
}

export const goalsOf = (points: number, step: number) => Math.max(0, Math.floor(points / (step > 0 ? step : 1) + 1e-9));

/** Todos contra todos (método do círculo). Número ímpar ganha uma "folga" (null). Alterna mando por rodada. */
export function roundRobin(players: string[]): [string, string][][] {
  const list: (string | null)[] = [...players];
  if (list.length < 2) return [];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const out: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) round.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    out.push(round);
    list.splice(1, 0, list.pop()!); // gira mantendo o primeiro fixo
  }
  return out;
}

/** Divide em grupos pela cabeça de chave, em "serpentina": 1º→A, 2º→B, 3º→B, 4º→A... */
export function splitGroups(players: string[], groups: number): string[][] {
  const g = Math.max(1, Math.min(groups, Math.floor(players.length / 2) || 1));
  const out: string[][] = Array.from({ length: g }, () => []);
  players.forEach((p, i) => {
    const lap = Math.floor(i / g);
    const idx = lap % 2 === 0 ? i % g : g - 1 - (i % g);
    out[idx].push(p);
  });
  return out;
}

const groupName = (i: number) => `Grupo ${String.fromCharCode(65 + i)}`;

function emptyRow(id: string): TableRow {
  return { user_id: id, pos: 0, P: 0, J: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0, SG: 0, L: 0, last5: [] };
}

/** Classificação: pontos (V=3, E=1), vitórias, saldo, gols pró e, por fim, o lucro com as casas decimais. Tudo igual = mesma posição. */
export function table(players: string[], games: { home: string; away: string; hg: number; ag: number; lh?: number; la?: number }[]): TableRow[] {
  const rows = new Map(players.map((p) => [p, emptyRow(p)]));
  const hist = new Map<string, ("V" | "E" | "D")[]>(players.map((p) => [p, []]));
  for (const g of games) {
    const h = rows.get(g.home);
    const a = rows.get(g.away);
    if (!h || !a) continue;
    h.J++, a.J++;
    h.GP += g.hg, h.GC += g.ag, a.GP += g.ag, a.GC += g.hg;
    h.L += g.lh ?? 0, a.L += g.la ?? 0;
    const rh = g.hg > g.ag ? "V" : g.hg === g.ag ? "E" : "D";
    const ra = rh === "V" ? "D" : rh === "D" ? "V" : "E";
    for (const [row, res] of [[h, rh], [a, ra]] as const) {
      if (res === "V") (row.V++, (row.P += 3));
      else if (res === "E") (row.E++, (row.P += 1));
      else row.D++;
    }
    hist.get(g.home)!.push(rh);
    hist.get(g.away)!.push(ra);
  }
  const list = [...rows.values()].map((r) => ({ ...r, SG: r.GP - r.GC, last5: hist.get(r.user_id)!.slice(-5) }));
  const key = (r: TableRow) => [r.P, r.V, r.SG, r.GP, Math.round(r.L * 100)];
  const cmp = (x: TableRow, y: TableRow) => {
    const a = key(x), b = key(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };
  // ordem estável pela cabeça de chave quando tudo empata
  const seed = new Map(players.map((p, i) => [p, i]));
  list.sort((x, y) => cmp(x, y) || seed.get(x.user_id)! - seed.get(y.user_id)!);
  list.forEach((r, i) => (r.pos = i > 0 && cmp(list[i - 1], r) === 0 ? list[i - 1].pos : i + 1));
  return list;
}

/** Placar de um confronto num dia (null se o dia ainda não começou). */
function play(day: Matchday | undefined, home: string, away: string, step: number) {
  if (!day || !day.started) return null;
  const sh = day.scores.get(home);
  const sa = day.scores.get(away);
  return { hg: goalsOf(sh?.points ?? 0, step), ag: goalsOf(sa?.points ?? 0, step), lh: sh?.points ?? 0, la: sa?.points ?? 0, hh: sh?.hits ?? 0, ha: sa?.hits ?? 0, final: day.final };
}

/** Quantos dias (rodadas do campeonato) o formato precisa. */
export function matchdaysNeeded(cfg: TournamentConfig): number {
  const legs = cfg.legs;
  const groupRounds = (players: string[]) => Math.max(0, ...splitGroups(players, cfg.groups).map((g) => roundRobin(g).length));
  const koRounds = (n: number) => (n < 2 ? 0 : Math.ceil(Math.log2(n)));
  if (cfg.format === "pontos") return roundRobin(cfg.participants).length * legs;
  if (cfg.format === "grupos") return groupRounds(cfg.participants) * legs;
  if (cfg.format === "mata") return koRounds(cfg.participants.length) * legs;
  const g = splitGroups(cfg.participants, cfg.groups);
  const q = g.reduce((s, x) => s + Math.min(cfg.advance, x.length), 0);
  return groupRounds(cfg.participants) * legs + koRounds(q) * legs;
}

const KO_NAMES: Record<number, string> = { 2: "Final", 4: "Semifinal", 8: "Quartas de final", 16: "Oitavas de final" };

/** Monta tudo: grupos/tabela, rodadas com os confrontos e o mata-mata. */
export function buildTournament(cfg: TournamentConfig, days: Matchday[], shootouts: Map<string, Shootout> = new Map()): TournamentView {
  const view: TournamentView = { groups: [], rounds: [], knockout: [], champion: null };
  const step = cfg.goalStep;
  let cursor = 0; // próximo dia livre
  const dayAt = (i: number) => days[i];

  // ---------- fase de pontos / grupos ----------
  const hasGroups = cfg.format !== "mata";
  const groups = cfg.format === "pontos" ? [cfg.participants] : hasGroups ? splitGroups(cfg.participants, cfg.groups) : [];
  if (hasGroups && groups.length) {
    const schedules = groups.map((g) => {
      const rr = roundRobin(g);
      return cfg.legs === 2 ? [...rr, ...rr.map((r) => r.map(([h, a]) => [a, h] as [string, string]))] : rr;
    });
    const total = Math.max(...schedules.map((s) => s.length));
    const played = groups.map(() => [] as { home: string; away: string; hg: number; ag: number; lh: number; la: number }[]);
    for (let r = 0; r < total; r++) {
      const day = dayAt(cursor);
      const fixtures: Fixture[] = [];
      schedules.forEach((sch, gi) => {
        for (const [home, away] of sch[r] ?? []) {
          const res = play(day, home, away, step);
          fixtures.push({ home, away, hg: res?.hg ?? null, ag: res?.ag ?? null, note: groups.length > 1 ? groupName(gi) : undefined });
          if (res) played[gi].push({ home, away, hg: res.hg, ag: res.ag, lh: res.lh, la: res.la });
        }
      });
      view.rounds.push({ n: r + 1, date: day?.date ?? null, stage: cfg.format === "pontos" ? "Pontos corridos" : "Fase de grupos", final: !!day?.final, fixtures });
      cursor++;
    }
    view.groups = groups.map((g, gi) => ({ name: cfg.format === "pontos" ? "Classificação" : groupName(gi), table: table(g, played[gi]) }));
    if (cfg.format === "pontos" || cfg.format === "grupos") {
      const allFinal = view.rounds.length > 0 && view.rounds.every((r) => r.final);
      if (allFinal && view.groups.length === 1) view.champion = view.groups[0].table[0]?.user_id ?? null;
      return view;
    }
  }

  // ---------- mata-mata ----------
  let seeds: (string | null)[];
  let groupsDone = true;
  if (cfg.format === "copa") {
    groupsDone = view.rounds.every((r) => r.final);
    const perPos: (string | null)[] = [];
    for (let p = 0; p < cfg.advance; p++) for (const g of view.groups) if (g.table[p]) perPos.push(groupsDone ? g.table[p].user_id : null);
    seeds = perPos;
  } else seeds = [...cfg.participants];

  let size = 1;
  while (size < seeds.length) size *= 2;
  // chave: 1 x último, 2 x penúltimo...; vagas sobrando viram folga para as melhores cabeças
  let current: (string | null | "BYE")[] = [];
  const padded: (string | null | "BYE")[] = [...seeds, ...Array(size - seeds.length).fill("BYE")];
  for (let i = 0; i < size / 2; i++) current.push(padded[i], padded[size - 1 - i]);

  while (current.length >= 2) {
    const stage = KO_NAMES[current.length] ?? `Rodada de ${current.length}`;
    const ties: Tie[] = [];
    const next: (string | null | "BYE")[] = [];
    const legDays = Array.from({ length: cfg.legs }, (_, l) => dayAt(cursor + l));
    const roundFixtures: Fixture[][] = Array.from({ length: cfg.legs }, () => []);
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i];
      const b = current[i + 1];
      if (a === "BYE" || b === "BYE") {
        const w = a === "BYE" ? b : a;
        ties.push({ a: a === "BYE" ? null : a, b: b === "BYE" ? null : b, ga: null, gb: null, winner: w === "BYE" ? null : w, decidedBy: "folga" });
        next.push(w);
        continue;
      }
      let ga = 0, gb = 0, la = 0, lb = 0, done = true, any = false;
      legDays.forEach((day, l) => {
        const home = l === 0 ? a : b;
        const away = l === 0 ? b : a;
        const res = a && b ? play(day, home!, away!, step) : null;
        roundFixtures[l].push({ home, away, hg: res?.hg ?? null, ag: res?.ag ?? null, note: cfg.legs === 2 ? (l === 0 ? "ida" : "volta") : undefined });
        if (!res || !res.final) done = false;
        if (res) {
          any = true;
          if (l === 0) (ga += res.hg, gb += res.ag, la += res.lh, lb += res.la);
          else (ga += res.ag, gb += res.hg, la += res.la, lb += res.lh);
        }
      });
      let winner: string | null = null;
      let decidedBy: string | undefined;
      let pens: Tie["pens"];
      const ca = Math.round(la * 100), cb = Math.round(lb * 100);
      if (a && b && done) {
        if (ga !== gb) winner = ga > gb ? a : b;
        else {
          decidedBy = "pênaltis";
          if (ca !== cb) (winner = ca > cb ? a : b), (pens = { by: "lucro" });
          else {
            // pênaltis com palpite: sem resultado gravado, a vaga fica em aberto
            const key = shootoutKey(stage, a, b);
            const so = shootouts.get(key);
            if (so) (winner = so.winner === "a" ? a : b), (pens = { by: "cobranças", key, ...so });
            else pens = { by: "cobranças", key, pending: true };
          }
        }
      }
      ties.push({ a, b, ga: any ? ga : null, gb: any ? gb : null, la: any ? ca / 100 : null, lb: any ? cb / 100 : null, winner, decidedBy, pens });
      next.push(winner);
    }
    roundFixtures.forEach((fx, l) => {
      const day = legDays[l];
      if (fx.length) view.rounds.push({ n: view.rounds.length + 1, date: day?.date ?? null, stage: stage + (cfg.legs === 2 ? (l === 0 ? " · ida" : " · volta") : ""), final: !!day?.final, fixtures: fx });
    });
    cursor += cfg.legs;
    view.knockout.push({ stage, ties });
    current = next;
    if (current.length === 1) {
      view.champion = typeof current[0] === "string" && current[0] !== "BYE" ? current[0] : null;
      break;
    }
  }
  return view;
}
