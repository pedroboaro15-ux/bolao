/**
 * Disputa de pênaltis do mata-mata, usada só quando o confronto empata nos gols E no lucro.
 * Em cada cobrança o canto do chute e o pulo do goleiro (coluna esquerda/meio/direita × altura em cima/meio/embaixo):
 * - 8% de qualquer chute vai para fora;
 * - goleiro acertou o canto e a altura: 90% de defesa;
 * - goleiro acertou o canto mas não a altura: 25% de defesa;
 * - goleiro foi para o outro lado: gol.
 * 5 cobranças para cada um (para antes se não der mais para alcançar), depois alternadas até alguém errar.
 * Cada jogador escolhe antes do prazo onde chuta e para onde pula em cada cobrança (5 + 5 alternadas); o que faltar,
 * a máquina sorteia (aleatório de verdade, `crypto`). O resultado é gravado uma vez só (tabela `shootouts`).
 */

export type Col = "esq" | "meio" | "dir";
export type Row = "cima" | "meio" | "baixo";
export interface Spot {
  col: Col;
  row: Row;
}
export interface Kick {
  /** Quem bate: "a" ou "b". */
  by: "a" | "b";
  aim: Spot;
  dive: Spot;
  result: "gol" | "defesa" | "fora";
  /** Escolhas feitas pela máquina (quem não palpitou). */
  auto?: { aim: boolean; dive: boolean };
}
/** Palpite de um jogador: onde chuta e para onde pula, cobrança a cobrança (null = a máquina escolhe). */
export interface ShootPicks {
  aims: (Spot | null)[];
  dives: (Spot | null)[];
}
/** Quantas cobranças cada um palpita: 5 + 5 alternadas (depois disso, a máquina). */
export const PICKS = 10;
export interface Shootout {
  kicks: Kick[];
  a: number;
  b: number;
  winner: "a" | "b";
}

export const OFF_TARGET = 0.08;
export const SAVE_EXACT = 0.9;
export const SAVE_SIDE = 0.25;

const COLS: Col[] = ["esq", "meio", "dir"];
const ROWS: Row[] = ["cima", "meio", "baixo"];

/** Gerador de números aleatórios com semente (mulberry32 sobre um hash do texto). */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) (h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)), (h = (h << 13) | (h >>> 19));
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Aleatório de verdade (sem semente e sem padrão), para a máquina e para o chute. */
export const secureRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

const randomSpot = (rand: () => number): Spot => ({ col: COLS[Math.floor(rand() * 3)], row: ROWS[Math.floor(rand() * 3)] });

export function kickWith(by: "a" | "b", rand: () => number, chosenAim?: Spot | null, chosenDive?: Spot | null): Kick {
  const aim = chosenAim ?? randomSpot(rand);
  const dive = chosenDive ?? randomSpot(rand);
  let result: Kick["result"] = "gol";
  if (rand() < OFF_TARGET) result = "fora";
  else if (dive.col === aim.col) {
    const p = dive.row === aim.row ? SAVE_EXACT : SAVE_SIDE;
    if (rand() < p) result = "defesa";
  }
  return { by, aim, dive, result, auto: { aim: !chosenAim, dive: !chosenDive } };
}

const isSpot = (x: any): x is Spot => !!x && COLS.includes(x.col) && ROWS.includes(x.row);

/** Confere o palpite vindo da tela: até PICKS chutes e PICKS pulos, cada um válido ou vazio. */
export function parsePicks(body: any): ShootPicks {
  const norm = (xs: any) => Array.from({ length: PICKS }, (_, i) => (Array.isArray(xs) && isSpot(xs[i]) ? { col: xs[i].col, row: xs[i].row } : null));
  return { aims: norm(body?.aims), dives: norm(body?.dives) };
}

/** Exemplo sorteado (tela "Ver exemplo" e testes): semente fixa = sempre o mesmo. */
export function shootout(seed: string): Shootout {
  return resolveShootout({}, rng(seed));
}

/** Disputa com os palpites dos dois; o que faltar, a máquina escolhe. */
export function resolveShootout(picks: { a?: ShootPicks | null; b?: ShootPicks | null }, rand: () => number = secureRandom): Shootout {
  const kicks: Kick[] = [];
  const n = { a: 0, b: 0 };
  const kick = (by: "a" | "b", r: () => number) => {
    const i = n[by]++;
    const other = by === "a" ? "b" : "a";
    return kickWith(by, r, picks[by]?.aims[i], picks[other]?.dives[i]);
  };
  let a = 0, b = 0;
  // série de 5
  for (let i = 0; i < 5; i++) {
    for (const by of ["a", "b"] as const) {
      const k = kick(by, rand);
      kicks.push(k);
      if (k.result === "gol") by === "a" ? a++ : b++;
      const leftA = 5 - (i + 1);
      const leftB = 5 - (by === "b" ? i + 1 : i);
      if (a > b + leftB || b > a + leftA) return { kicks, a, b, winner: a > b ? "a" : "b" };
    }
  }
  // alternadas
  for (let t = 0; t < 200; t++) {
    const ka = kick("a", rand);
    const kb = kick("b", rand);
    kicks.push(ka, kb);
    if (ka.result === "gol") a++;
    if (kb.result === "gol") b++;
    if (a !== b) break;
  }
  return { kicks, a, b, winner: a > b ? "a" : "b" };
}
