// Área do administrador: jogos do dia → rodada, resultados, usuários, configurações, uso das APIs.
import { $, $$, api, avatar, crest, esc, fmtClock, fmtDate, fmtWhen, icon, leagueIcon, odd, openSheet, toast } from "./util.js";
import { state, go } from "./store.js";

const TABS = [
  ["", "Jogos do dia"],
  ["rodadas", "Rodadas e resultados"],
  ["perguntas", "Perguntas do dia"],
  ["campeonatos", "Campeonatos"],
  ["pedidos", "Pedidos"],
  ["usuarios", "Usuários"],
  ["config", "Configurações"],
  ["api", "APIs"],
];

// O dia do bolão vai das 06:00 às 06:00 (São Paulo): começa às 09:00 UTC.
const bolaoDay = () => new Date(Date.now() - 9 * 3600_000).toISOString().slice(0, 10);
const nextDay = (ymd) => new Date(Date.parse(ymd + "T12:00:00Z") + 86400_000).toISOString().slice(0, 10);

export function render(view, parts) {
  const [tab = "", arg] = parts;
  document.title = "Admin · Bolão";
  view.innerHTML = `<div class="page narrow">
    <h1 class="section-title">Administração</h1>
    <div class="subnav" role="tablist">${TABS.map(([k, t]) => `<a class="chip" data-link href="/admin${k ? "/" + k : ""}" aria-pressed="${tab === k}">${t}</a>`).join("")}</div>
    <div id="extras-box"></div>
    <div id="admin-body"><p class="boot">Carregando…</p></div>
  </div>`;
  extrasToggles($("#extras-box", view));
  const body = $("#admin-body", view);
  const pages = { "": daily, rodadas: rounds, perguntas: questions, campeonatos: championships, pedidos: requests, usuarios: users, config: settings, api: usage };
  (pages[tab] ?? daily)(body, arg).catch((e) => (body.innerHTML = `<div class="card card-pad"><p class="error">${esc(e.message)}</p></div>`));
}

/**
 * Interruptores dos palpites extras. Valem na hora, a qualquer momento:
 * o vencedor é sempre palpitado; gols (2,5) e placar exato ficam ou não à disposição.
 * Jogos que já começaram mantêm o que valia no início.
 */
async function extrasToggles(box) {
  let cfg;
  try {
    cfg = (await api("/admin/config")).config;
  } catch {
    return;
  }
  const draw = () => {
    box.innerHTML = `<div class="card card-pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline"><b>Palpites extras (além do vencedor)</b><span class="hint">vale na hora; jogos já iniciados não mudam</span></div>
      <div class="cols2" style="margin-top:8px">
        <label class="f" style="grid-template-columns:auto 1fr;align-items:center;gap:10px"><input type="checkbox" data-extra="goalsEnabled" ${cfg.goalsEnabled ? "checked" : ""}> Gols: mais/menos de 2,5</label>
        <label class="f" style="grid-template-columns:auto 1fr;align-items:center;gap:10px"><input type="checkbox" data-extra="scoreEnabled" ${cfg.scoreEnabled ? "checked" : ""}> Placar exato</label>
      </div>
      <div class="hint" style="margin-top:6px">${cfg.goalsEnabled && cfg.scoreEnabled ? "Cada participante pode escolher um dos dois extras, ou nenhum." : cfg.goalsEnabled || cfg.scoreEnabled ? "Só um extra à disposição (opcional)." : "Nenhum extra: só o vencedor."}</div>
    </div>`;
  };
  draw();
  box.addEventListener("change", async (e) => {
    const i = e.target.closest("[data-extra]");
    if (!i) return;
    i.disabled = true;
    try {
      cfg = (await api("/admin/config", { method: "PUT", body: { [i.dataset.extra]: i.checked } })).config;
      toast(i.checked ? "Extra ligado" : "Extra desligado", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
    draw();
  });
}

const busy = async (btn, fn) => {
  btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
};

// ---------- jogos do dia ----------

async function daily(body) {
  const S = { date: bolaoDay(), liga: 0, data: null, picked: new Set(), title: "" };

  async function load(refresh = false) {
    body.innerHTML = `<p class="boot">Buscando jogos…</p>`;
    S.data = await api(`/admin/jogos-do-dia?date=${S.date}${S.liga ? `&liga=${S.liga}` : ""}${refresh ? "&atualizar=1" : ""}`);
    paint();
  }

  function paint() {
    const d = S.data;
    const n = S.picked.size;
    const restam = Math.max(0, d.limite - d.ja_escolhidos);
    const ok = n >= 1 && n <= restam;
    body.innerHTML = `
      <div class="card card-pad form" style="margin-bottom:14px">
        <div class="cols2">
          <label class="f">Dia<input type="date" data-date value="${S.date}"></label>
          <label class="f">Campeonato<select data-liga><option value="0">Todos (mais relevantes)</option><option value="br" ${S.liga === "br" ? "selected" : ""}>Só Brasil (${d.brasil ?? 0})</option>${d.ligas.map((l) => `<option value="${l.id}" ${l.id === S.liga ? "selected" : ""}>${l.country === "Brazil" ? "BR · " : ""}${esc(l.name)} (${l.count})</option>`).join("")}</select></label>
        </div>
        <div class="notice">Dia do bolão: das <b>06:00 de ${fmtDate(S.date)}</b> até as <b>06:00 de ${fmtDate(nextDay(S.date))}</b> (horário de São Paulo). Limite de <b>${d.limite}</b> jogos por dia; já escolhidos: <b>${d.ja_escolhidos}</b>.</div>
        <div class="muted" style="font-size:13px">${d.total} jogos ainda por começar${d.comecados ? ` (${d.comecados} já começaram e saíram da lista)` : ""} · lista de ${fmtWhen(d.fetched_at)} · mostrando os 30 mais relevantes. <button class="btn small" data-refresh>${icon("refresh").replace("<svg", '<svg width="14" height="14"')} Buscar de novo (gasta 2 chamadas)</button></div>
      </div>
      <div class="card" style="overflow:hidden">
        ${d.jogos.length ? d.jogos.map((f) => `<label class="pick" style="cursor:${f.ja_em_rodada ? "not-allowed" : "pointer"}">
            <input type="checkbox" data-pick="${f.id}" ${S.picked.has(f.id) ? "checked" : ""} ${f.ja_em_rodada ? "disabled" : ""} aria-label="Escolher ${esc(f.home.name)} x ${esc(f.away.name)}">
            <span class="info"><b>${esc(f.home.name)} x ${esc(f.away.name)}</b><small>${leagueIcon(f.league).replace("league-icon", "league-icon")} ${esc(f.league.name)} · ${fmtClock(f.kickoff)}${f.ja_em_rodada ? " · já está em uma rodada" : ""}</small></span>
            <span class="rel" title="Relevância">${f.relevance}</span></label>`).join("") : `<div class="empty">Nenhum jogo encontrado para este dia.</div>`}
      </div>
      <div class="card card-pad form" style="margin-top:14px;position:sticky;bottom:78px;z-index:5">
        <label class="f">Nome da rodada<input data-title value="${esc(S.title)}" placeholder="Rodada de ${fmtDate(S.date)}" maxlength="80"></label>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span><b class="num" style="font-size:22px" data-count>${n}</b> <span data-count-label>escolhido${n === 1 ? "" : "s"}</span> <span class="muted">(restam ${restam} de ${d.limite} neste dia)</span></span>
        <button class="btn primary" data-create ${ok ? "" : "disabled"}>Criar e abrir rodada</button></div>
      </div>`;
  }

  body.addEventListener("change", (e) => {
    if (e.target.matches("[data-date]")) {
      S.date = e.target.value;
      S.picked.clear();
      S.liga = 0;
      load().catch((err) => toast(err.message, "err"));
    } else if (e.target.matches("[data-liga]")) {
      S.liga = e.target.value === "br" ? "br" : Number(e.target.value);
      load().catch((err) => toast(err.message, "err"));
    } else if (e.target.matches("[data-pick]")) {
      const id = Number(e.target.dataset.pick);
      const restam = Math.max(0, S.data.limite - S.data.ja_escolhidos);
      if (e.target.checked && S.picked.size >= restam) {
        e.target.checked = false;
        return toast(`Limite do dia: ${S.data.limite} jogos (já escolhidos: ${S.data.ja_escolhidos}).`, "err");
      }
      e.target.checked ? S.picked.add(id) : S.picked.delete(id);
      // Só atualiza o rodapé (repintar tudo perderia a rolagem e o foco).
      const n = S.picked.size;
      $("[data-count]", body).textContent = n;
      $("[data-count-label]", body).textContent = `escolhido${n === 1 ? "" : "s"}`;
      $("[data-create]", body).disabled = !(n >= 1 && n <= restam);
    }
  });
  body.addEventListener("input", (e) => {
    if (e.target.matches("[data-title]")) S.title = e.target.value;
  });
  body.addEventListener("click", (e) => {
    const r = e.target.closest("[data-refresh]");
    if (r) busy(r, () => load(true));
    const c = e.target.closest("[data-create]");
    if (c)
      busy(c, async () => {
        const res = await api("/admin/rodadas", { method: "POST", body: { date: S.date, title: S.title || `Rodada de ${fmtDate(S.date)}`, fixtureIds: [...S.picked], open: true } });
        toast("Rodada criada e aberta! Buscando as odds jogo a jogo…", "ok");
        try {
          sessionStorage.setItem("bolao-buscar-odds", res.id);
        } catch {}
        go(`/admin/rodadas/${res.id}`);
      });
  });
  await load();
}

// ---------- rodadas e resultados ----------

const STATUS = { draft: "rascunho", open: "aberta", closed: "fechada", finished: "encerrada" };

async function rounds(body, id) {
  if (id) return roundResults(body, id);
  const d = await api("/admin/rodadas");
  body.innerHTML = d.rodadas.length
    ? `<div class="card" style="overflow:hidden">${d.rodadas.map((r) => `<a class="pick" data-link href="/admin/rodadas/${esc(r.id)}" style="text-decoration:none;grid-template-columns:1fr auto"><span class="info"><b>${esc(r.title)}</b><small>${fmtDate(r.date)} · ${r.jogos} jogos</small></span><span class="tag ${r.status === "open" ? "ok" : ""}">${STATUS[r.status] ?? r.status}</span></a>`).join("")}</div>`
    : `<div class="card card-pad empty">Nenhuma rodada ainda. Crie uma em “Jogos do dia”.</div>`;
}

async function roundResults(body, id) {
  async function load() {
    const d = await api(`/admin/rodadas/${encodeURIComponent(id)}/jogos`);
    body.innerHTML = `
      <p><a data-link href="/admin/rodadas" class="muted">‹ Todas as rodadas</a></p>
      <div class="card card-pad" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><div><h2 style="font-size:28px">${esc(d.rodada.title)}</h2><span class="muted">${fmtDate(d.rodada.date)} · ${STATUS[d.rodada.status]}</span></div>
        <div class="actions" style="margin:0">
          ${d.rodada.status !== "finished" ? `<button class="btn small" data-status="${d.rodada.status === "open" ? "closed" : "open"}">${d.rodada.status === "open" ? "Fechar palpites" : "Reabrir palpites"}</button>` : ""}
          <button class="btn small" data-recalc>Recalcular pontos</button>
          <button class="btn small" data-fetch-scores>Buscar placares agora</button>
          <button class="btn small danger" data-del-round>Excluir rodada</button></div></div>
      </div>
      ${d.jogos.map(matchAdmin).join("")}`;
    return d;
  }

  const matchAdmin = (m) => {
    const started = Date.parse(m.kickoff_utc) <= Date.now();
    const calledOff = ["PST", "CANC", "ABD", "SUSP"].includes(m.status);
    return `<div class="card card-pad" style="margin-bottom:12px" data-m="${esc(m.id)}">
      <div class="m-head"><span>${fmtWhen(m.kickoff_utc)}</span><span>${esc(m.league.name)}</span><span class="tag">API: ${esc(m.status)}</span>${m.voided ? '<span class="tag">Anulado</span>' : ""}${m.manual_override ? '<span class="tag joker">Manual</span>' : ""}${calledOff && !m.voided ? '<span class="tag live">Adiado/cancelado? Anule</span>' : ""}<span class="tag">${m.palpites} palpite${m.palpites === 1 ? "" : "s"}</span></div>
      <div class="res-grid"><b style="text-align:right;font-family:var(--font-display);font-size:20px">${esc(m.home.name)}</b>
        <span style="display:flex;gap:6px;align-items:center"><input inputmode="numeric" data-h value="${m.home_goals ?? ""}" aria-label="Gols ${esc(m.home.name)}"><span>x</span><input inputmode="numeric" data-a value="${m.away_goals ?? ""}" aria-label="Gols ${esc(m.away.name)}"></span>
        <b style="font-family:var(--font-display);font-size:20px">${esc(m.away.name)}</b></div>
      <div class="actions"><button class="btn small primary" data-save-result>Salvar resultado</button>
        ${m.manual_override ? `<button class="btn small" data-clear-result>Voltar ao automático</button>` : ""}
        <button class="btn small ${m.voided ? "" : "danger"}" data-void="${m.voided ? "0" : "1"}">${m.voided ? "Desfazer anulação" : "Anular jogo"}</button></div>
      <div class="notice" style="margin-top:12px;font-size:13px">
        ${m.odds ? `Odds (${esc(m.odds.fonte)}): 1 <b>${odd(m.odds.justa["1"])}</b> · X <b>${odd(m.odds.justa.X)}</b> · 2 <b>${odd(m.odds.justa["2"])}</b>${m.odds.ou ? ` · Mais/Menos 2,5 <b>${odd(m.odds.ou.over)}</b>/<b>${odd(m.odds.ou.under)}</b>` : ""} · ${m.congeladas ? "congeladas" : "ao vivo"}` : `<span class="error">Sem odds.</span> ${esc(m.odds_error ?? "")}`}
        ${!started ? `<div class="actions"><button class="btn small" data-fetch-odds>Buscar odds na API</button><button class="btn small" data-manual-odds>Digitar odds</button></div>` : `<div class="actions"><button class="btn small" data-manual-odds>Digitar odds</button></div>`}
      </div></div>`;
  };

  /** Uma odd por vez, cada uma num pedido próprio (e ~6,5 s entre elas: a API grátis aceita ~10 por minuto). */
  let filling = false;
  async function fillOdds(jogos) {
    if (filling) return;
    filling = true;
    const todo = jogos.filter((m) => !m.odds && !m.voided && Date.parse(m.kickoff_utc) > Date.now());
    let ok = 0;
    let lastError = "";
    for (let i = 0; i < todo.length && body.isConnected; i++) {
      if (i) await new Promise((r) => setTimeout(r, 6500));
      if (!body.isConnected) break;
      toast(`Buscando odds ${i + 1} de ${todo.length}…`);
      try {
        await api(`/admin/jogos/${todo[i].id}/atualizar-odds`, { method: "POST" });
        ok++;
      } catch (e) {
        lastError = e.message;
      }
      if (body.isConnected) await load();
    }
    filling = false;
    if (todo.length) toast(ok === todo.length ? "Odds prontas!" : `Odds de ${ok} de ${todo.length} jogos. ${lastError}`, ok === todo.length ? "ok" : "err");
  }

  body.addEventListener("click", (e) => {
    const card = e.target.closest("[data-m]");
    const mid = card?.dataset.m;
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-status]")) busy(b, async () => (await api(`/admin/rodadas/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: b.dataset.status } }), load()));
    if (b.matches("[data-fetch-scores]"))
      busy(b, async () => {
        const r = await api(`/admin/rodadas/${encodeURIComponent(id)}/placares`, { method: "POST" });
        toast(r.motivo ?? `${r.atualizados} placar(es) atualizado(s).${r.pendentes?.length ? " Ainda sem resultado: " + r.pendentes.join(", ") : ""}`, r.atualizados ? "ok" : "");
        await load();
      });
    if (b.matches("[data-del-round]") && confirm("Excluir esta rodada? Os jogos, palpites, comentários e pontos dela somem do histórico e dos rankings. Não dá para desfazer."))
      busy(b, async () => {
        const r = await api(`/admin/rodadas/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(`Rodada excluída (${r.jogos} jogos, ${r.palpites} palpites).`, "ok");
        go("/admin/rodadas");
      });
    if (b.matches("[data-recalc]"))
      busy(b, async () => {
        const r = await api(`/admin/rodadas/${encodeURIComponent(id)}/recalcular`, { method: "POST" });
        toast(`Pontos recalculados (${r.palpites_alterados} alterados).`, "ok");
        await load();
      });
    if (b.matches("[data-save-result]"))
      busy(b, async () => {
        const h = $("[data-h]", card).value.trim();
        const a = $("[data-a]", card).value.trim();
        if (h === "" || a === "") throw new Error("Preencha os dois placares.");
        await api(`/admin/jogos/${mid}/resultado`, { method: "PUT", body: { home_goals: h, away_goals: a } });
        toast("Resultado salvo e pontos calculados.", "ok");
        await load();
      });
    if (b.matches("[data-clear-result]")) busy(b, async () => (await api(`/admin/jogos/${mid}/resultado`, { method: "PUT", body: { limpar: true } }), load()));
    if (b.matches("[data-void]"))
      busy(b, async () => {
        if (b.dataset.void === "1" && !confirm("Anular este jogo? Ninguém pontua nele.")) return;
        await api(`/admin/jogos/${mid}/anular`, { method: "POST", body: { anular: b.dataset.void === "1" } });
        await load();
      });
    if (b.matches("[data-fetch-odds]"))
      busy(b, async () => {
        const r = await api(`/admin/jogos/${mid}/atualizar-odds`, { method: "POST" });
        toast(r.ok ? "Odds atualizadas." : r.motivo, r.ok ? "ok" : "err");
        await load();
      });
    if (b.matches("[data-manual-odds]")) manualOdds(mid, load);
  });
  const first = await load();
  let fresh = false;
  try {
    fresh = sessionStorage.getItem("bolao-buscar-odds") === id;
    if (fresh) sessionStorage.removeItem("bolao-buscar-odds");
  } catch {}
  if (fresh) fillOdds(first.jogos);
}

function manualOdds(matchId, done) {
  const s = openSheet(`<h3 style="font-size:26px;margin-bottom:6px">Digitar odds</h3>
    <p class="muted">Use as odds normais (com margem) de uma casa de sua confiança. O sistema tira a margem sozinho.</p>
    <form class="form" id="mo">
      <div class="cols2"><label class="f">1 (casa)<input name="1" inputmode="decimal" required></label><label class="f">X (empate)<input name="X" inputmode="decimal" required></label></div>
      <div class="cols2"><label class="f">2 (fora)<input name="2" inputmode="decimal" required></label><span></span></div>
      <div class="cols2"><label class="f">Mais de 2,5 (opcional)<input name="over" inputmode="decimal"></label><label class="f">Menos de 2,5 (opcional)<input name="under" inputmode="decimal"></label></div>
      <button class="btn primary block" type="submit">Salvar odds</button></form>`);
  $("#mo", s.el).onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).replace(",", ".")]));
    try {
      await api(`/admin/jogos/${matchId}/odds`, { method: "PUT", body });
      s.close();
      toast("Odds salvas.", "ok");
      done();
    } catch (err) {
      toast(err.message, "err");
    }
  };
}

// ---------- perguntas do dia (também basquete e UFC) ----------

const KIND_HELP = {
  pergunta: { title: "Quem vence a eleição para prefeito de São Paulo?", options: "Candidato A = 1.80\nCandidato B = 2.10" },
  basquete: { title: "Lakers x Celtics: quem vence?", options: "Lakers = 2.10\nCeltics = 1.75" },
  ufc: { title: "UFC: Lutador A x Lutador B", options: "Lutador A = 1.60\nLutador B = 2.40" },
};
const pad = (n) => String(n).padStart(2, "0");
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const optionsText = (opts) => opts.map((o) => `${o.label} = ${odd(o.odd)}`).join("\n");
function parseOptions(text, prev = []) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(.*?)\s*[=:;|]\s*([\d.,]+)\s*$/.exec(l);
      if (!m) throw new Error(`Linha sem odd: “${l}”. Use “Nome = 1.80”.`);
      const label = m[1].trim();
      const same = prev.find((o) => o.label.toLowerCase() === label.toLowerCase());
      return { id: same?.id, label, odd: m[2].replace(",", ".") };
    });
}

async function questions(body) {
  const S = { date: nextDay(bolaoDay()), data: null, editing: null };
  async function load() {
    S.data = await api(`/admin/perguntas?date=${S.date}`);
    paint();
  }
  function form(q) {
    const kind = q?.kind ?? "pergunta";
    const close = q ? new Date(q.closes_at) : new Date(Date.parse(S.date + "T21:00:00-03:00"));
    return `<form class="card card-pad form" data-qform style="margin-bottom:14px">
      <h3 style="margin:0">${q ? "Editar" : "Nova pergunta, jogo ou luta"}</h3>
      <div class="cols2"><input type="hidden" name="kind" value="pergunta">
        <label class="f">Fecha em (hora do seu aparelho)<input name="closes_at" type="datetime-local" value="${localInput(close)}" required></label></div>
      <label class="f">Pergunta<input name="title" maxlength="160" value="${esc(q?.title ?? "")}" placeholder="${esc(KIND_HELP[kind].title)}" required></label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="hint" style="margin:0">Atalhos:</span><button class="btn small" type="button" data-preset="sn">Sim / Não</button><button class="btn small" type="button" data-preset="2">2 opções</button><button class="btn small" type="button" data-preset="3">3 opções</button></div>
      <label class="f">Opções e odds (uma por linha: Nome = odd)<textarea name="options" rows="5" placeholder="${esc(KIND_HELP[kind].options)}" required>${esc(q ? optionsText(q.options) : "")}</textarea></label>
      <p class="hint" style="margin:0">Acertar vale odd − 1 (ex.: 1.80 vale +0.80). As odds que você digita já são as que valem. Os pontos entram no ranking do mês e no geral.</p>
      <div class="error" data-err role="alert"></div>
      <div class="actions" style="margin:0"><button class="btn primary" type="submit">${q ? "Salvar alterações" : "Publicar"}</button>${q ? '<button class="btn" type="button" data-cancel>Cancelar</button>' : ""}</div>
    </form>`;
  }
  function item(q) {
    const total = q.respostas;
    return `<div class="card card-pad" style="margin-bottom:12px">
      <div class="m-head"><span class="tag">${esc(q.tipo)}</span><span>Fecha ${fmtWhen(q.closes_at)}</span><span class="tag">${total} resposta${total === 1 ? "" : "s"}</span>${q.voided ? '<span class="tag">Anulada</span>' : q.result ? '<span class="tag ok">Com resultado</span>' : ""}</div>
      <h3 style="font-size:20px;margin:6px 0 10px">${esc(q.title)}</h3>
      <div style="display:flex;flex-direction:column;gap:6px">${q.options
        .map(
          (o) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${esc(o.label)} · <b>${odd(o.odd)}</b> <span class="muted">(${q.counts?.[o.id] ?? 0})</span></span>
            ${q.result === o.id ? '<span class="tag ok">Certa</span>' : `<button class="btn small" data-res="${esc(q.id)}" data-opt="${esc(o.id)}">Deu esta</button>`}</div>`,
        )
        .join("")}</div>
      <div class="actions"><button class="btn small" data-edit-q="${esc(q.id)}">Editar</button>
        ${q.voided || q.result ? `<button class="btn small" data-clear-q="${esc(q.id)}">Tirar resultado</button>` : `<button class="btn small danger" data-void-q="${esc(q.id)}">Anular</button>`}
        <button class="btn small danger" data-del-q="${esc(q.id)}">Excluir</button></div>
    </div>`;
  }
  function paint() {
    const d = S.data;
    const editing = S.editing && d.perguntas.find((x) => x.id === S.editing);
    body.innerHTML = `
      <div class="card card-pad" style="margin-bottom:14px;display:flex;gap:12px;align-items:end;flex-wrap:wrap">
        <label class="f" style="flex-grow:1">Dia do bolão<input type="date" value="${S.date}" data-qdate></label>
        <p class="hint" style="margin:0;flex-basis:100%">Aparecem na tela de início, na seção “Perguntas do dia”, em cima dos jogos. Ninguém vê o que os outros escolheram até fechar.</p>
      </div>
      ${form(editing)}
      <h2 class="section-title">${fmtDate(S.date)}<small>${d.perguntas.length} evento${d.perguntas.length === 1 ? "" : "s"}</small></h2>
      ${d.perguntas.length ? d.perguntas.map(item).join("") : '<div class="card card-pad empty">Nenhuma pergunta neste dia ainda.</div>'}`;
  }
  body.addEventListener("change", (e) => {
    if (e.target.matches("[data-qdate]")) {
      S.date = e.target.value;
      S.editing = null;
      load().catch((err) => toast(err.message, "err"));
    }
    if (e.target.matches("[data-qform] select[name=kind]")) {
      const f = e.target.form;
      const h = KIND_HELP[e.target.value];
      f.title.placeholder = h.title;
      f.options.placeholder = h.options.replace(/\\n/g, "\n");
    }
  });
  body.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-qform]")) return;
    e.preventDefault();
    const f = e.target;
    const err = $("[data-err]", f);
    err.textContent = "";
    const prev = S.editing ? S.data.perguntas.find((x) => x.id === S.editing)?.options ?? [] : [];
    try {
      const payload = { date: S.date, kind: f.kind.value, title: f.title.value, closes_at: new Date(f.closes_at.value).toISOString(), options: parseOptions(f.options.value, prev) };
      if (S.editing) await api(`/admin/perguntas/${S.editing}`, { method: "PUT", body: payload });
      else await api("/admin/perguntas", { method: "POST", body: payload });
      toast(S.editing ? "Salvo." : "Publicada!", "ok");
      S.editing = null;
      await load();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-cancel]")) return ((S.editing = null), paint());
    if (b.dataset.preset) {
      const ta = b.closest("form").options;
      ta.value = { sn: "Sim = 1.90\nNão = 1.90", 2: "Opção A = 1.90\nOpção B = 1.90", 3: "Opção A = 2.50\nOpção B = 3.00\nOpção C = 3.00" }[b.dataset.preset];
      ta.focus();
      return;
    }
    if (b.dataset.editQ) return ((S.editing = b.dataset.editQ), paint(), window.scrollTo(0, 0));
    const go = (url, opts, msg) => busy(b, async () => (await api(url, opts), toast(msg, "ok"), await load()));
    if (b.dataset.res && confirm("Marcar esta opção como a certa? Os pontos são calculados na hora.")) go(`/admin/perguntas/${b.dataset.res}/resultado`, { method: "POST", body: { option_id: b.dataset.opt } }, "Resultado salvo e pontos calculados.");
    if (b.dataset.voidQ && confirm("Anular? Ninguém pontua nela.")) go(`/admin/perguntas/${b.dataset.voidQ}/resultado`, { method: "POST", body: { anular: true } }, "Anulada.");
    if (b.dataset.clearQ) go(`/admin/perguntas/${b.dataset.clearQ}/resultado`, { method: "POST", body: { limpar: true } }, "Resultado retirado.");
    if (b.dataset.delQ && confirm("Excluir esta pergunta e todas as respostas dela?")) go(`/admin/perguntas/${b.dataset.delQ}`, { method: "DELETE" }, "Excluída.");
  });
  await load();
}

// ---------- campeonatos ----------

async function championships(body) {
  let list = [];
  let editing = null;
  async function load() {
    list = (await api("/campeonatos")).campeonatos;
    paint();
  }
  function paint() {
    const c = list.find((x) => x.id === editing);
    const today = bolaoDay();
    body.innerHTML = `
      <form class="card card-pad form" data-chform style="margin-bottom:14px">
        <h3 style="margin:0">${c ? "Editar campeonato" : "Novo campeonato"}</h3>
        <label class="f">Nome<input name="name" maxlength="60" value="${esc(c?.name ?? "")}" placeholder="Copa da Galera de Outubro" required></label>
        <div class="cols2"><label class="f">Começa<input name="start_date" type="date" value="${c?.start_date ?? today}" required></label><label class="f">Termina<input name="end_date" type="date" value="${c?.end_date ?? nextDay(today)}" required></label></div>
        <label class="f">Premiação e regras (aparece no ranking)<textarea name="prize" rows="4" maxlength="600" placeholder="1º lugar: R$ 100 · 2º: R$ 50 · 3º: devolve a inscrição. Desempate: mais acertos.">${esc(c?.prize ?? "")}</textarea></label>
        <p class="hint" style="margin:0">O ranking do campeonato soma as rodadas e as perguntas do dia entre as duas datas. O ranking geral continua somando tudo.</p>
        <div class="error" data-err role="alert"></div>
        <div class="actions" style="margin:0"><button class="btn primary" type="submit">${c ? "Salvar" : "Criar campeonato"}</button>${c ? '<button class="btn" type="button" data-cancel>Cancelar</button>' : ""}</div>
      </form>
      ${
        list.length
          ? list
              .map(
                (x) => `<div class="card card-pad" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-size:18px">${esc(x.name)}</b><span class="tag">${x.situacao}</span></div>
                <div class="muted" style="font-size:13px">${fmtDate(x.start_date)} a ${fmtDate(x.end_date)}</div>${x.prize ? `<div class="prize" style="margin-top:6px;font-size:14px">${esc(x.prize)}</div>` : ""}
                <div class="actions"><button class="btn small" data-edit-ch="${esc(x.id)}">Editar</button><button class="btn small danger" data-del-ch="${esc(x.id)}">Excluir</button></div></div>`,
              )
              .join("")
          : '<div class="card card-pad empty">Nenhum campeonato ainda.</div>'
      }`;
  }
  body.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-chform]")) return;
    e.preventDefault();
    const f = e.target;
    const payload = Object.fromEntries(new FormData(f));
    try {
      if (editing) await api(`/admin/campeonatos/${editing}`, { method: "PUT", body: payload });
      else await api("/admin/campeonatos", { method: "POST", body: payload });
      toast(editing ? "Salvo." : "Campeonato criado!", "ok");
      editing = null;
      await load();
    } catch (err) {
      $("[data-err]", f).textContent = err.message;
    }
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-cancel]")) return ((editing = null), paint());
    if (b.dataset.editCh) return ((editing = b.dataset.editCh), paint(), window.scrollTo(0, 0));
    if (b.dataset.delCh && confirm("Excluir este campeonato? Os pontos continuam no ranking geral."))
      busy(b, async () => (await api(`/admin/campeonatos/${b.dataset.delCh}`, { method: "DELETE" }), toast("Excluído.", "ok"), await load()));
  });
  await load();
}

// ---------- pedidos: votos em jogos e sugestões ----------

async function requests(body) {
  async function load() {
    const d = await api("/admin/pedidos");
    body.innerHTML = `
      <p class="muted">Últimos 7 dias. Quando não há rodada no dia, a tela de início mostra os jogos da lista (de hoje e amanhã) para cada um votar, e um campo de sugestão.</p>
      <h2 class="section-title">Jogos mais pedidos</h2>
      <div class="card" style="overflow:hidden;margin-bottom:16px">${
        d.votos.length
          ? d.votos.map((v) => `<div class="list-row"><div class="grow"><b>${esc(v.label)}</b><div class="muted" style="font-size:12px">${esc(v.quem.join(", "))}</div></div><span class="tag ok">${v.votos} voto${v.votos === 1 ? "" : "s"}</span></div>`).join("")
          : '<div class="empty">Nenhum voto ainda.</div>'
      }</div>
      <h2 class="section-title">Sugestões</h2>
      <div class="card" style="overflow:hidden">${
        d.sugestoes.length
          ? d.sugestoes.map((s) => `<div class="list-row"><div class="grow"><b>${esc(s.nickname)}</b> <span class="muted" style="font-size:12px">${fmtWhen(s.created_at)}</span><div style="overflow-wrap:anywhere">${esc(s.text)}</div></div><button class="btn small" data-del-s="${esc(s.id)}">Apagar</button></div>`).join("")
          : '<div class="empty">Nenhuma sugestão ainda.</div>'
      }</div>`;
  }
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-del-s]");
    if (b) busy(b, async () => (await api(`/admin/pedidos/${b.dataset.delS}`, { method: "DELETE" }), await load()));
  });
  await load();
}

// ---------- usuários ----------

/** O admin muda apelido e telefone de qualquer pessoa e pode liberar uma nova alteração do perfil. */
function editUser(u, done) {
  if (!u) return;
  const feitas = Object.keys(u.edits ?? {}).filter((k) => u.edits[k]);
  const s = openSheet(`<h3 style="font-size:26px;margin-bottom:6px">Editar ${esc(u.nickname)}</h3>
    <p class="muted">${esc(u.email)}</p>
    <form class="form" id="eu">
      <label class="f">Apelido<input name="nickname" value="${esc(u.nickname)}" minlength="2" maxlength="20" required></label>
      <label class="f">Telefone<input name="phone" inputmode="tel" value="${esc(u.phone ? fmtPhone(u.phone) : "")}" placeholder="(11) 91234-5678"></label>
      ${feitas.length ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="liberar" style="width:auto"> Liberar nova alteração (já alterou: ${feitas.map((k) => ({ nickname: "apelido", phone: "telefone", password: "senha" })[k]).join(", ")})</label>` : ""}
      <div class="error" data-err role="alert"></div>
      <button class="btn primary block" type="submit">Salvar</button></form>`);
  $("#eu", s.el).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/admin/usuarios/${u.id}`, { method: "PATCH", body: { nickname: fd.get("nickname"), phone: fd.get("phone"), liberar: fd.get("liberar") === "on" } });
      s.close();
      toast("Salvo.", "ok");
      done();
    } catch (err) {
      $("[data-err]", s.el).textContent = err.message;
    }
  };
}

const fmtPhone = (d) => (d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d);

async function users(body) {
  let LIST = [];
  const EDITS = { nickname: "apelido", phone: "telefone", password: "senha" };
  async function load() {
    const d = await api("/admin/usuarios");
    LIST = d.usuarios;
    body.innerHTML = `<div class="card" style="overflow:hidden">${d.usuarios
      .map(
        (u) => `<div class="list-row">${avatar(u.nickname)}<div class="grow"><b>${esc(u.nickname)}</b> ${u.name !== u.nickname ? `<span class="muted">${esc(u.name)}</span>` : ""}<div class="muted" style="font-size:12px">${esc(u.email)}${u.phone ? " · " + esc(fmtPhone(u.phone)) : ""}</div>${Object.keys(u.edits ?? {}).filter((k) => u.edits[k]).length ? `<div class="muted" style="font-size:12px">já alterou: ${Object.keys(u.edits).filter((k) => u.edits[k]).map((k) => EDITS[k]).join(", ")}</div>` : ""}</div>
        <span class="tag ${u.role === "admin" ? "joker" : ""}">${u.role === "admin" ? "admin" : "jogador"}</span>
        <button class="btn small" data-edit="${esc(u.id)}">Editar</button>${u.id === state.user.id ? '<span class="tag">você</span>' : `<button class="btn small" data-role="${u.role === "admin" ? "player" : "admin"}" data-id="${esc(u.id)}">${u.role === "admin" ? "Tirar admin" : "Tornar admin"}</button><button class="btn small danger" data-del="${esc(u.id)}" data-name="${esc(u.nickname)}">Remover</button>`}</div>`,
      )
      .join("")}</div>`;
  }
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) editUser(LIST.find((x) => x.id === b.dataset.edit), load);
    if (b.dataset.role) busy(b, async () => (await api(`/admin/usuarios/${b.dataset.id}/papel`, { method: "POST", body: { role: b.dataset.role } }), load()));
    if (b.dataset.del && confirm(`Remover ${b.dataset.name}? A conta e os palpites dessa pessoa serão apagados.`)) busy(b, async () => (await api(`/admin/usuarios/${b.dataset.del}`, { method: "DELETE" }), load()));
  });
  await load();
}

// ---------- configurações ----------

async function settings(body) {
  const { config: c } = await api("/admin/config");
  body.innerHTML = `<form class="form" id="cfg">
    <div class="card card-pad form"><h3 style="font-size:22px">Pontuação</h3>
      <div class="cols2">
        <label class="f">Multiplicador do vencedor<input name="winnerMultiplier" inputmode="decimal" value="${c.winnerMultiplier}"></label>
        <label class="f">Multiplicador dos gols (2,5)<input name="ouMultiplier" inputmode="decimal" value="${c.ouMultiplier}"></label>
        <label class="f">Multiplicador do placar exato<input name="csMultiplier" inputmode="decimal" value="${c.csMultiplier}"></label>
        <label class="f">Limite de odd (teto)<input name="oddCap" inputmode="decimal" value="${c.oddCap}"></label>
      </div>
      <label class="f">Limite de jogos escolhidos por dia (dia = 06:00 às 06:00 em São Paulo)<input name="maxMatchesPerDay" inputmode="numeric" value="${c.maxMatchesPerDay}"></label>
      <label class="f" style="grid-template-columns:auto 1fr;align-items:center;gap:10px"><input type="checkbox" name="goalsEnabled" ${c.goalsEnabled ? "checked" : ""}> Extra de gols (mais/menos de 2,5) à disposição</label>
      <label class="f" style="grid-template-columns:auto 1fr;align-items:center;gap:10px"><input type="checkbox" name="scoreEnabled" ${c.scoreEnabled ? "checked" : ""}> Extra de placar exato à disposição</label>
      <label class="f" style="grid-template-columns:auto 1fr;align-items:center;gap:10px"><input type="checkbox" name="jokerEnabled" ${c.jokerEnabled ? "checked" : ""}> Coringa ligado (1 jogo por rodada)</label>
      <label class="f">Multiplicador do coringa<input name="jokerMultiplier" inputmode="decimal" value="${c.jokerMultiplier}"></label>
      <div class="notice">Mudanças valem para os próximos cálculos. Para aplicar em uma rodada já pontuada, use “Recalcular pontos” nela.</div>
    </div>
    <div class="card card-pad form"><h3 style="font-size:22px">Relevância dos jogos</h3>
      <label class="f">Pesos por liga (um por linha: <span class="mono">id-da-liga = peso</span>)<textarea name="leagueWeights" rows="8" class="mono">${esc(Object.entries(c.leagueWeights).map(([k, v]) => `${k} = ${v}`).join("\n"))}</textarea></label>
      <label class="f">Peso das outras ligas<input name="defaultLeagueWeight" inputmode="numeric" value="${c.defaultLeagueWeight}"></label>
      <div class="cols2"><label class="f">Bônus por time grande<input name="bigTeamBonus" inputmode="numeric" value="${c.bigTeamBonus}"></label><label class="f">Bônus de clássico (os dois grandes)<input name="derbyBonus" inputmode="numeric" value="${c.derbyBonus}"></label></div>
      <label class="f">Times grandes (um por linha, nome como na API-Football)<textarea name="bigTeams" rows="8" class="mono">${esc(c.bigTeams.join("\n"))}</textarea></label>
    </div>
    <div class="card card-pad form"><h3 style="font-size:22px">API-Football</h3>
      <div class="cols2"><label class="f">Limite diário de chamadas<input name="apiFootballDailyLimit" inputmode="numeric" value="${c.apiFootballDailyLimit}"></label><label class="f">Reserva para placares<input name="apiReserve" inputmode="numeric" value="${c.apiReserve}"></label>
      <label class="f">Atualizar odds só nas últimas (horas)<input name="oddsWindowHours" inputmode="numeric" value="${c.oddsWindowHours}"></label><label class="f">A cada (horas)<input name="oddsRefreshHours" inputmode="numeric" value="${c.oddsRefreshHours}"></label></div>
    </div>
    <button class="btn primary block" type="submit">Salvar configurações</button></form>`;
  $("#cfg", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const num = (k) => Number(String(f.get(k)).replace(",", "."));
    const lw = {};
    for (const line of String(f.get("leagueWeights")).split("\n")) {
      const m = /^\s*(\d+)\s*[=:]\s*(\d+)\s*$/.exec(line);
      if (m) lw[m[1]] = Number(m[2]);
      else if (line.trim()) return toast(`Linha inválida nos pesos: “${line.trim()}”`, "err");
    }
    const patch = {
      jokerEnabled: f.get("jokerEnabled") === "on",
      goalsEnabled: f.get("goalsEnabled") === "on",
      scoreEnabled: f.get("scoreEnabled") === "on",
      leagueWeights: lw,
      bigTeams: String(f.get("bigTeams")).split("\n").map((s) => s.trim()).filter(Boolean),
    };
    for (const k of ["winnerMultiplier", "ouMultiplier", "csMultiplier", "oddCap", "jokerMultiplier", "maxMatchesPerDay", "defaultLeagueWeight", "bigTeamBonus", "derbyBonus", "apiFootballDailyLimit", "apiReserve", "oddsWindowHours", "oddsRefreshHours"]) patch[k] = num(k);
    try {
      await api("/admin/config", { method: "PUT", body: patch });
      toast("Configurações salvas.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
}

// ---------- uso das APIs ----------

async function usage(body) {
  const u = await api("/admin/uso");
  const a = u.api_football;
  const pct = Math.min(100, Math.round((a.chamadas_hoje / a.limite) * 100));
  body.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px">
      <h3 style="font-size:24px;margin-bottom:8px">API-Football hoje</h3>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="num" style="font-size:44px;font-weight:700">${a.chamadas_hoje}<small class="muted" style="font-size:20px"> / ${a.limite}</small></span><span class="muted">${pct}% usado</span></div>
      <div class="meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <p class="muted" style="font-size:13px">Só as chamadas feitas por este sistema. A cota zera às 00:00 UTC (21:00 em Brasília). Reserva de ${a.reserva} chamadas para placares.</p>
    </div>
    <div class="card card-pad" style="margin-bottom:14px">
      <h3 style="font-size:24px;margin-bottom:8px">Testar minha chave</h3>
      <p class="muted" style="font-size:14px">Confere plano, cota e se a busca de jogos do dia funciona no seu plano (gasta 1 chamada).</p>
      <button class="btn primary" data-test>Testar API-Football</button>
      <pre id="test-out" class="mono" style="white-space:pre-wrap;margin-top:12px"></pre>
    </div>
    <div class="notice">Notificações push: ${u.push_configurado ? "configuradas ✓" : "ainda não configuradas (faltam as chaves VAPID)"}</div>`;
  $("[data-test]", body).onclick = (e) =>
    busy(e.target, async () => {
      const r = await api("/admin/api-teste");
      $("#test-out", body).textContent = JSON.stringify(r, null, 2);
    });
}
