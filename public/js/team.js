import { api, crest, esc, fmtWhen, openSheet } from "./util.js";

const fx = (f) => {
  const done = f.home_goals != null && f.away_goals != null;
  return `<div class="fx"><span class="h">${esc(f.home.name)}</span><span class="sc">${done ? `${f.home_goals} - ${f.away_goals}` : "x"}</span><span class="a">${esc(f.away.name)}</span></div>
    <div class="muted" style="font-size:12px;margin:-6px 0 4px;text-align:center">${esc(f.league)} · ${done ? "Final" : fmtWhen(f.kickoff)}</div>`;
};

/** Ficha do time (ref. 1): nome gigante, abas Últimos 5 / Próximos 3. Nunca quebra se a API não tiver esses dados. */
export async function openTeam(team) {
  const s = openSheet(`
    <div class="detail-hero" style="padding:8px 0 16px">
      <div class="wm">${esc(team.name)}</div>
      ${crest(team, "xl")}
      <div class="tn" style="font-size:28px;margin-top:8px">${esc(team.name)}</div>
    </div>
    <div id="team-body" class="muted" style="text-align:center;padding:16px 0">Carregando…</div>
    <div class="actions"><button class="btn block" data-close>Fechar</button></div>`);
  const body = s.el.querySelector("#team-body");
  try {
    const d = await api(`/times/${team.id}`);
    if (!d.ultimos.length && !d.proximos.length) {
      body.innerHTML = `<div class="notice">Últimos e próximos jogos indisponíveis agora${d.erro ? ` (${esc(d.erro)})` : ""}.</div>`;
      return;
    }
    body.className = "";
    body.innerHTML = `
      <div class="tabs2" role="tablist"><button role="tab" aria-selected="true" data-tab="u">Últimos jogos</button><button role="tab" aria-selected="false" data-tab="p">Próximos jogos</button></div>
      <div class="card card-pad" id="team-list">${d.ultimos.map(fx).join("") || '<p class="muted">Sem jogos.</p>'}</div>`;
    body.onclick = (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      body.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      const list = b.dataset.tab === "u" ? d.ultimos : d.proximos;
      body.querySelector("#team-list").innerHTML = list.map(fx).join("") || '<p class="muted">Sem jogos.</p>';
    };
  } catch (e) {
    body.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
  }
}
