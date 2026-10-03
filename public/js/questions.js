// "Perguntas do dia" na tela de início: perguntas (eleição...), basquete e UFC, com odds escolhidas pelo admin.
import { api, esc, fmtClock, fmtWhen, now, odd, pts, signed, toast } from "./util.js";

const Q = { date: null, list: [], html: "", busy: new Set(), loadedAt: 0 };
let slotRef = null;

const TAG = { pergunta: "Pergunta", basquete: "Basquete", ufc: "UFC" };

/** Coloca a seção no lugar reservado (a tela da rodada redesenha tudo; aqui só reaproveita o último HTML). */
export function mountQuestions(slot, date) {
  slotRef = slot;
  if (!slot) return;
  slot.innerHTML = Q.html;
  if (!slot.dataset.wired) {
    slot.dataset.wired = "1";
    slot.addEventListener("click", onClick);
  }
  if (Q.date !== date || Date.now() - Q.loadedAt > 60_000) loadQuestions(date);
}

async function loadQuestions(date) {
  Q.date = date;
  Q.loadedAt = Date.now();
  try {
    const d = await api(`/perguntas?date=${encodeURIComponent(date)}`);
    Q.list = d.perguntas;
  } catch {
    Q.list = []; // é um complemento: sem perguntas, a seção some
  }
  paint();
}

function paint() {
  Q.html = Q.list.length
    ? `<section class="qday"><h2 class="section-title" style="margin-top:4px">Perguntas do dia<small>${Q.list.length} ${Q.list.length > 1 ? "eventos" : "evento"}</small></h2>${Q.list.map(card).join("")}</section>`
    : "";
  if (slotRef?.isConnected) slotRef.innerHTML = Q.html;
}

function card(q) {
  const closed = q.closed || Date.parse(q.closes_at) <= now();
  const settled = q.voided || !!q.result;
  const pick = q.mine?.option_id ?? null;
  const total = q.counts ? Object.values(q.counts).reduce((a, b) => a + b, 0) : 0;
  const badge = q.voided
    ? `<span class="badge end">Anulada</span>`
    : settled
      ? `<span class="badge end">Resultado</span>`
      : closed
        ? `<span class="badge live">Fechada</span>`
        : `<span class="badge open">Fecha ${fmtWhen(q.closes_at).replace(/^Hoje /, "às ")}</span>`;
  const opts = q.options
    .map((o) => {
      const cls = q.result === o.id ? "hit" : settled && pick === o.id ? "miss" : "";
      const share = q.counts && total ? Math.round((q.counts[o.id] / total) * 100) : null;
      return `<button class="odd ${cls}" data-q="${esc(q.id)}" data-o="${esc(o.id)}" aria-pressed="${pick === o.id}" ${closed || settled ? "disabled" : ""}>
        <span>${esc(o.label)}${share != null ? ` <small class="muted">· ${share}%</small>` : ""}</span><b>${odd(o.odd)}</b></button>`;
    })
    .join("");
  let foot;
  if (settled && q.mine) foot = `<span>${q.voided ? "Anulada: ninguém pontua" : q.mine.option_id === q.result ? "Você acertou!" : "Não foi dessa vez"}</span><span class="pts ${q.mine.points > 0 ? "pos" : ""}">${q.mine.points > 0 ? signed(q.mine.points) : "0.00"}</span>`;
  else if (settled) foot = `<span class="hint">Você não respondeu.</span>`;
  else if (closed) foot = `<span>${pick ? "Resposta travada" : "Você não respondeu"}</span>${q.counts ? `<span class="hint">${total} resposta${total === 1 ? "" : "s"}</span>` : ""}`;
  else if (pick) {
    const o = q.options.find((x) => x.id === pick);
    foot = `<span><i class="st-dot"></i>Salvo · pode render <b class="num">+${pts((o?.odd ?? 1) - 1)}</b></span>`;
  } else foot = `<span class="hint">Escolha uma opção até ${fmtClock(q.closes_at)}</span>`;
  return `<div class="ev q-ev">
    <div class="ev-top"><span><span class="tag">${TAG[q.kind] ?? "Pergunta"}</span></span>${badge}</div>
    <h3 class="q-title">${esc(q.title)}</h3>
    <div class="odds ${q.options.length === 2 ? "c2" : q.options.length === 3 ? "c3" : "cq"}">${opts}</div>
    <div class="ev-f">${foot}</div>
  </div>`;
}

async function onClick(e) {
  const b = e.target.closest("[data-q][data-o]");
  if (!b || b.disabled) return;
  const q = Q.list.find((x) => x.id === b.dataset.q);
  if (!q || Q.busy.has(q.id)) return;
  const before = q.mine;
  q.mine = { option_id: b.dataset.o, points: null };
  paint();
  Q.busy.add(q.id);
  try {
    await api(`/perguntas/${encodeURIComponent(q.id)}/resposta`, { method: "PUT", body: { option_id: b.dataset.o } });
    toast("Resposta salva", "ok");
  } catch (err) {
    q.mine = before;
    paint();
    toast(err.message, "err");
  } finally {
    Q.busy.delete(q.id);
  }
}
