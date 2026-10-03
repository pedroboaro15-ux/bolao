import { badRequest } from "./errors";

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;

/** Telefone brasileiro: só dígitos, com DDD (10 ou 11 dígitos). Aceita +55 na frente. */
export function parsePhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) throw badRequest("Telefone inválido. Use o DDD e o número, por exemplo (11) 91234-5678");
  return d;
}

export function parseNickname(raw: unknown): string {
  const n = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (n.length < NICKNAME_MIN || n.length > NICKNAME_MAX) throw badRequest(`O apelido deve ter de ${NICKNAME_MIN} a ${NICKNAME_MAX} letras`);
  return n;
}

/** Para comparar apelidos: sem maiúsculas, acentos e espaços repetidos (Luquinha = luquínha). */
const canon = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function nicknameTaken(users: { id: string; nickname: string }[], nickname: string, exceptId?: string): boolean {
  const c = canon(nickname);
  return users.some((u) => u.id !== exceptId && canon(u.nickname) === c);
}

/** Apelido livre a partir do desejado: se já existe, acrescenta 2, 3... (sem passar do limite de letras). */
export function uniqueNickname(users: { id: string; nickname: string }[], desired: string): string {
  if (!nicknameTaken(users, desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const cand = desired.slice(0, NICKNAME_MAX - suffix.length).trim() + suffix;
    if (!nicknameTaken(users, cand)) return cand;
  }
  return desired;
}
