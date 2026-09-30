// Área do administrador: jogos do dia → rodada, resultados, convites, usuários, configurações, uso das APIs.
import { $, $$, api, avatar, crest, esc, fmtClock, fmtDate, fmtWhen, icon, leagueIcon, odd, openSheet, toast } from "./util.js";
import { state, go } from "./store.js";

const TABS = [
  ["", "Jogos do dia"],
  ["rodadas", "Rodadas e resultados"],
  ["convites", "Convites"],
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
  const pages = { "": daily, rodadas: rounds, convites: invites, usuarios: users, config: settings, api: usage };
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
          <label class="f">Campeonato<select data-liga><option value="0">Todos (mais relevantes)</option>${d.ligas.map((l) => `<option value="${l.id}" ${l.id === S.liga ? "selected" : ""}>${esc(l.name)} (${l.count})</option>`).join("")}</select></label>
        </div>
        <div class="notice">Dia do bolão: das <b>06:00 de ${fmtDate(S.date)}</b> até as <b>06:00 de ${fmtDate(nextDay(S.date))}</b> (horário de São Paulo). Limite de <b>${d.limite}</b> jogos por dia; já escolhidos: <b>${d.ja_escolhidos}</b>.</div>
        <div class="muted" style="font-size:13px">${d.total} jogos no dia · lista de ${fmtWhen(d.fetched_at)} · mostrando os 30 mais relevantes. <button class="btn small" data-refresh>${icon("refresh").replace("<svg", '<svg width="14" height="14"')} Buscar de novo (gasta 2 chamadas)</button></div>
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
      S.liga = Number(e.target.value);
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
        toast("Rodada criada e aberta! As odds chegam em instantes.", "ok");
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
          <button class="btn small" data-recalc>Recalcular pontos</button></div></div>
      </div>
      ${d.jogos.map(matchAdmin).join("")}`;
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

  body.addEventListener("click", (e) => {
    const card = e.target.closest("[data-m]");
    const mid = card?.dataset.m;
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-status]")) busy(b, async () => (await api(`/admin/rodadas/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: b.dataset.status } }), load()));
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
  await load();
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

// ---------- convites ----------

async function invites(body) {
  async function load() {
    const d = await api("/admin/convites");
    body.innerHTML = `
      <div class="card card-pad form" style="margin-bottom:14px">
        <div class="cols2"><label class="f">Quantas pessoas podem usar<input type="number" min="1" max="100" value="1" data-max></label><label class="f">Vale por (dias)<input type="number" min="1" max="60" value="7" data-dias></label></div>
        <button class="btn primary" data-new>Gerar link de convite</button>
      </div>
      <div class="card" style="overflow:hidden">${
        d.convites.length
          ? d.convites
              .map((c) => {
                const dead = c.revoked || Date.parse(c.expires_at) < Date.now() || c.uses >= c.max_uses;
                return `<div class="list-row"><div class="grow"><div class="mono">${esc(c.url)}</div><div class="muted" style="font-size:12px">${c.uses}/${c.max_uses} usos · vence ${fmtDate(new Date(c.expires_at).toISOString().slice(0, 10))} ${c.revoked ? "· revogado" : dead ? "· inativo" : ""}</div></div>
                  ${dead ? "" : `<button class="btn small" data-copy="${esc(c.url)}">Copiar</button><button class="btn small danger" data-revoke="${esc(c.token)}">Revogar</button>`}</div>`;
              })
              .join("")
          : `<div class="empty">Nenhum convite ainda.</div>`
      }</div>`;
  }
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-new]"))
      busy(b, async () => {
        const r = await api("/admin/convites", { method: "POST", body: { max_uses: Number($("[data-max]", body).value), dias: Number($("[data-dias]", body).value) } });
        await copy(r.url);
        toast("Link criado e copiado!", "ok");
        await load();
      });
    if (b.matches("[data-copy]")) copy(b.dataset.copy).then(() => toast("Link copiado!", "ok"));
    if (b.matches("[data-revoke]") && confirm("Revogar este convite?")) busy(b, async () => (await api(`/admin/convites/${b.dataset.revoke}`, { method: "DELETE" }), load()));
  });
  await load();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    prompt("Copie o link:", text);
  }
}

// ---------- usuários ----------

async function users(body) {
  async function load() {
    const d = await api("/admin/usuarios");
    body.innerHTML = `<div class="card" style="overflow:hidden">${d.usuarios
      .map(
        (u) => `<div class="list-row">${avatar(u.nickname)}<div class="grow"><b>${esc(u.nickname)}</b> <span class="muted">${esc(u.name)}</span><div class="muted" style="font-size:12px">${esc(u.email)}</div></div>
        <span class="tag ${u.role === "admin" ? "joker" : ""}">${u.role === "admin" ? "admin" : "jogador"}</span>
        ${u.id === state.user.id ? '<span class="tag">você</span>' : `<button class="btn small" data-role="${u.role === "admin" ? "player" : "admin"}" data-id="${esc(u.id)}">${u.role === "admin" ? "Tirar admin" : "Tornar admin"}</button><button class="btn small danger" data-del="${esc(u.id)}" data-name="${esc(u.nickname)}">Remover</button>`}</div>`,
      )
      .join("")}</div>`;
  }
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
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
