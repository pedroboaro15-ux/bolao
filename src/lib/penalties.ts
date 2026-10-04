/**
 * Disputa de pênaltis "de mentira" do mata-mata, usada só quando o confronto empata nos gols E no lucro.
 * Cada cobrança sorteia o canto do chute e o pulo do goleiro (coluna esquerda/meio/direita × altura em cima/meio/embaixo):
 * - 8% de qualquer chute vai para fora;
 * - goleiro acertou o canto e a altura: 90% de defesa;
 * - goleiro acertou o canto mas não a altura: 25% de defesa;
 * - goleiro foi para o outro lado: gol.
 * 5 cobranças para cada um (para antes se não der mais para alcançar), depois alternadas até alguém errar.
 * O sorteio usa uma semente fixa (o confronto), então o resultado é sempre o mesmo a cada vez que a tela abre.
 */

export type Col = "esq" | "meio" | "dir";
export type Row = "cima" | "meio" | "baixo";
export interface Kick {
  /** Quem bate: "a" ou "b". */
  by: "a" | "b";
  aim: { col: Col; row: Row };
  dive: { col: Col; row: Row };
  result: "gol" | "defesa" | "fora";
}
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

export function kick(by: "a" | "b", rand: () => number): Kick {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const aim = { col: pick(COLS), row: pick(ROWS) };
  const dive = { col: pick(COLS), row: pick(ROWS) };
  let result: Kick["result"] = "gol";
  if (rand() < OFF_TARGET) result = "fora";
  else if (dive.col === aim.col) {
    const p = dive.row === aim.row ? SAVE_EXACT : SAVE_SIDE;
    if (rand() < p) result = "defesa";
  }
  return { by, aim, dive, result };
}

export function shootout(seed: string): Shootout {
  const rand = rng(seed);
  const kicks: Kick[] = [];
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
  for (let n = 0; n < 200; n++) {
    const ka = kick("a", rand);
    const kb = kick("b", rand);
    kicks.push(ka, kb);
    if (ka.result === "gol") a++;
    if (kb.result === "gol") b++;
    if (a !== b) break;
  }
  return { kicks, a, b, winner: a > b ? "a" : "b" };
}
