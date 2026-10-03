import type { Repo, WithId } from "../db/repo";
import type { Write } from "../db/types";
import type { Answer, Question, QuestionKind, StandingRow } from "../types";
import { badRequest } from "../lib/errors";
import { round2 } from "../lib/odds";
import { rebuildTotals, sortRows } from "./standings";

/**
 * "Perguntas do dia": eventos criados pelo admin, com as odds que ele escolhe. Servem para perguntas (eleição...),
 * jogos de basquete e lutas do UFC. Cada participante escolhe UMA opção até `closes_at`; acertar vale `odd − 1`
 * (as odds digitadas já são as que valem: não há margem a tirar). Os pontos de cada dia viram um documento de
 * ranking `standings/questions_{dia}` com scope "round", então entram sozinhos no ranking do mês e no geral.
 */

export const KINDS: Record<QuestionKind, string> = { pergunta: "Pergunta", basquete: "Basquete", ufc: "UFC" };
/** Por enquanto só perguntas (o foco é o futebol). Basquete e UFC voltam com API, como o futebol. */
export const ACTIVE_KINDS: QuestionKind[] = ["pergunta"];

export interface QuestionInput {
  date: string;
  kind: QuestionKind;
  title: string;
  options: { id: string; label: string; odd: number }[];
  closes_at: Date;
}

/** Valida o que o admin digitou. Opções: lista de {label, odd}; 2 a 12; odd > 1. */
export function parseQuestionInput(body: any, isDate: (s: string) => boolean): QuestionInput {
  const kind = String(body?.kind ?? "pergunta") as QuestionKind;
  if (!(kind in KINDS)) throw badRequest("Tipo inválido");
  if (!ACTIVE_KINDS.includes(kind)) throw badRequest("Basquete e UFC estão em espera: vão entrar depois, com jogos e odds automáticos como no futebol");
  const title = String(body?.title ?? "").trim().replace(/\s+/g, " ");
  if (title.length < 3 || title.length > 160) throw badRequest("Escreva a pergunta (de 3 a 160 letras)");
  const date = String(body?.date ?? "");
  if (!isDate(date)) throw badRequest("Data inválida");
  const raw: any[] = Array.isArray(body?.options) ? body.options : [];
  if (raw.length < 2 || raw.length > 12) throw badRequest("Coloque de 2 a 12 opções");
  const seen = new Set<string>();
  const options = raw.map((o, i) => {
    const label = String(o?.label ?? "").trim().replace(/\s+/g, " ");
    const odd = Math.round(Number(String(o?.odd ?? "").replace(",", ".")) * 100) / 100;
    if (!label || label.length > 60) throw badRequest(`Opção ${i + 1}: escreva o nome (até 60 letras)`);
    if (!(odd > 1) || odd > 1000) throw badRequest(`Opção “${label}”: a odd precisa ser maior que 1`);
    const key = label.toLowerCase();
    if (seen.has(key)) throw badRequest(`Opção repetida: “${label}”`);
    seen.add(key);
    return { id: String(o?.id ?? "") || `o${i + 1}`, label, odd };
  });
  const closes = new Date(String(body?.closes_at ?? ""));
  if (Number.isNaN(closes.getTime())) throw badRequest("Informe até quando dá para responder");
  return { date, kind, title, options, closes_at: closes };
}

export const isClosed = (q: Pick<Question, "closes_at">, now = new Date()) => q.closes_at.getTime() <= now.getTime();
export const isSettledQ = (q: Pick<Question, "result" | "voided">) => q.voided || !!q.result;

export async function questionsOfDay(repo: Repo, date: string): Promise<WithId<Question>[]> {
  const rows = await repo.db.query<Question>("questions", { where: [["date", "==", date]] });
  return rows.map((d) => ({ id: d.id, ...d.data })).sort((a, b) => a.closes_at.getTime() - b.closes_at.getTime() || a.created_at.getTime() - b.created_at.getTime());
}

export async function answersOf(repo: Repo, field: "question_id" | "date" | "user_id", value: string): Promise<WithId<Answer>[]> {
  const rows = await repo.db.query<Answer>("answers", { where: [[field, "==", value]] });
  return rows.map((d) => ({ id: d.id, ...d.data }));
}

/** Pontos de uma resposta: anulada → 0; sem resultado → null; acertou → odd − 1. */
export function answerPoints(q: Pick<Question, "options" | "result" | "voided">, optionId: string): { points: number | null; hits: number | null } {
  if (q.voided) return { points: 0, hits: 0 };
  if (!q.result) return { points: null, hits: null };
  if (q.result !== optionId) return { points: 0, hits: 0 };
  const opt = q.options.find((o) => o.id === optionId);
  return { points: opt ? round2(opt.odd - 1) : 0, hits: 1 };
}

/** Recalcula as respostas de um dia e o ranking (documento do dia + mês + geral). */
export async function settleDay(repo: Repo, date: string): Promise<void> {
  const [qs, answers, users] = await Promise.all([questionsOfDay(repo, date), answersOf(repo, "date", date), repo.users()]);
  const byId = new Map(qs.map((q) => [q.id, q]));
  const nick = new Map(users.map((u) => [u.id, u.nickname]));
  const writes: Write[] = [];
  const acc = new Map<string, StandingRow>();
  for (const a of answers) {
    const q = byId.get(a.question_id);
    const r = q ? answerPoints(q, a.option_id) : { points: null, hits: null };
    if (r.points !== a.points || r.hits !== a.hits) writes.push({ op: "merge", path: `answers/${a.id}`, data: { points: r.points, hits: r.hits } });
    if (r.points === null || !nick.has(a.user_id)) continue;
    const row = acc.get(a.user_id) ?? { user_id: a.user_id, nickname: nick.get(a.user_id)!, points: 0, hits: 0 };
    row.points = round2(row.points + r.points);
    row.hits += r.hits ?? 0;
    acc.set(a.user_id, row);
  }
  for (let i = 0; i < writes.length; i += 400) await repo.db.commit(writes.slice(i, i + 400));
  const month = date.slice(0, 7);
  const start = new Date(`${date}T12:00:00Z`);
  await repo.db.commit([
    { op: "set", path: `standings/questions_${date}`, data: { scope: "round", month, rows: sortRows([...acc.values()]), zebra: null, start, updated_at: new Date() } },
  ]);
  await rebuildTotals(repo, month, nick);
}

/** O que o participante vê. As escolhas dos outros (quantos em cada opção) só depois de fechar. */
export function questionView(q: WithId<Question>, mine: WithId<Answer> | null, all: WithId<Answer>[] | null, now = new Date()) {
  const closed = isClosed(q, now);
  const counts = closed && all ? Object.fromEntries(q.options.map((o) => [o.id, all.filter((a) => a.option_id === o.id).length])) : null;
  return {
    id: q.id,
    date: q.date,
    kind: q.kind,
    tipo: KINDS[q.kind] ?? "Pergunta",
    title: q.title,
    options: q.options,
    closes_at: q.closes_at,
    closed,
    result: q.result ?? null,
    voided: !!q.voided,
    mine: mine ? { option_id: mine.option_id, points: mine.points ?? null } : null,
    counts,
  };
}
