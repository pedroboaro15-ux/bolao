// Ranking (ref. 1: líder em destaque + blocos de números), meus palpites e detalhe do jogo.
import { api, avatar, crest, esc, fmtDate, fmtMonth, fmtWhen, icon, leagueIcon, odd, pts, signed, zebraBlock, zebraLabel } from "./util.js";
import { state } from "./store.js";
import { openTeam } from "./team.js";

const fail = (view, e) => (view.innerHTML = `<div class="page narrow"><div class="card card-pad"><p class="error">${esc(e.message)}</p></div></div>`);

// ---------- ranking ----------

const rankOf = (rows, i) => 1 + rows.filter((r) => r.points > rows[i].points || (r.points === rows[i].points && r.hits > rows[i].hits)).length;

export function renderRanking(view) {
  const S = { escopo: "geral", id: "", tipo: "pontos", data: null };
  view.innerHTML = `<div class="page narrow"><p class="boot">Carregando ranking…</p></div>`;

  async function load() {
    try {
      S.data = await api(`/ranking?escopo=${S.escopo}&id=${encodeURIComponent(S.id)}`);
      S.id = S.data.id;
      paint();
    } catch (e) {
      fail(view, e);
    }
  }

  function paint() {
    const d = S.data;
    const rows = d.rows;
    const lead = rows[0];
    const second = rows[1];
    const me = state.user.id;
    document.title = "Ranking · Bolão";
    const selector =
      S.escopo === "rodada" && d.opcoes.rodadas.length
        ? `<select data-sel aria-label="Rodada">${d.opcoes.rodadas.map((r) => `<option value="${esc(r.id)}" ${r.id === S.id ? "selected" : ""}>${esc(r.title)} · ${fmtDate(r.date)}</option>`).join("")}</select>`
        : S.escopo === "mes" && d.opcoes.meses.length
          ? `<select data-sel aria-label="Mês">${d.opcoes.meses.map((m) => `<option value="${m}" ${m === S.id ? "selected" : ""}>${esc(fmtMonth(m))}</option>`).join("")}</select>`
          : "";
    const st = d.streaks ?? [];
    const rankStreak = (i) => 1 + st.filter((r) => r.current > st[i].current || (r.current === st[i].current && r.best > st[i].best)).length;
    const topNow = st[0];
    const topBest = [...st].sort((a, b) => b.best - a.best)[0];
    const streakBody = `
      <div class="summary" style="grid-template-columns:repeat(2,1fr)">
        <div><small>Maior sequência agora</small><b>${topNow && topNow.current > 0 ? `${topNow.current} · ${esc(topNow.nickname)}` : "–"}</b></div>
        <div><small>Maior recorde</small><b>${topBest && topBest.best > 0 ? `${topBest.best} · ${esc(topBest.nickname)}` : "–"}</b></div>
      </div>
      <div class="card" style="overflow:hidden">
        ${
          st.length
            ? `<table class="table"><thead><tr><th>#</th><th>Participante</th><th class="r">Agora</th><th class="r">Recorde</th></tr></thead><tbody>
              ${st.map((r, i) => `<tr class="${r.user_id === me ? "me" : ""} ${rankStreak(i) === 1 && r.current > 0 ? "first" : ""}"><td class="pos">${rankStreak(i)}</td><td><span class="who">${avatar(r.nickname)}${esc(r.nickname)}${r.user_id === me ? ' <span class="tag">você</span>' : ""}</span></td><td class="pts-cell">${r.current}</td><td class="r num">${r.best}</td></tr>`).join("")}
            </tbody></table>`
            : `<div class="empty">Ainda não há jogos com resultado neste período.</div>`
        }
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px">Conta os <b>vencedores (1X2)</b> certos em sequência, jogo a jogo, em ordem de horário. Errar zera a sequência de agora; o recorde fica. Não palpitar conta como erro. Jogo anulado não conta.</p>`;
    const tipoSeg = `<div style="margin-bottom:12px"><div class="seg" role="group" aria-label="Tipo de ranking"><button data-tipo="pontos" aria-pressed="${S.tipo === "pontos"}">Pontos</button><button data-tipo="sequencia" aria-pressed="${S.tipo === "sequencia"}">Sequência de acertos</button></div></div>`;
    view.innerHTML = `<div class="page narrow">
      <h1 class="section-title">Ranking<small>${esc(S.escopo === "mes" ? fmtMonth(S.id) : d.titulo)}</small></h1>
      <div class="tabs" role="tablist">${[["rodada", "Rodada"], ["mes", "Mês"], ["geral", "Geral"]].map(([k, t]) => `<button role="tab" data-esc="${k}" aria-selected="${S.escopo === k}">${t}</button>`).join("")}</div>
      ${selector ? `<div style="margin-bottom:12px">${selector}</div>` : ""}
      ${tipoSeg}
      ${S.tipo === "sequencia" ? streakBody : `${
        lead
          ? `<div class="card leader">
              <div class="wm">${esc(lead.nickname)}</div>
              <div class="kick"><span class="tag joker">${icon("trophy").replace("<svg", '<svg width="12" height="12"')} Líder</span><span>${esc(d.titulo)}</span></div>
              <div class="big-n"><small>#</small>1</div>
              <h2>${esc(lead.nickname)}</h2>
              <div class="statgrid">
                <div class="stat"><div class="l">Pontos</div><div class="v">${pts(lead.points)}</div></div>
                <div class="stat dark"><div class="l">Acertos</div><div class="v">${lead.hits}</div></div>
                <div class="stat"><div class="l">Vantagem</div><div class="v">${second ? pts(lead.points - second.points) : "—"}${second ? "<small>▲</small>" : ""}</div></div>
              </div>
            </div>`
          : ""
      }
      <div class="card card-pad" style="margin-bottom:12px">${zebraBlock(d.zebra, "Maior zebra vista · " + (S.escopo === "mes" ? fmtMonth(S.id) : d.titulo))}</div>
      <div class="card" style="overflow:hidden">
        ${
          rows.length
            ? `<table class="table"><thead><tr><th>#</th><th>Participante</th><th class="r">Acertos</th><th class="r">Pontos</th></tr></thead><tbody>
              ${rows.map((r, i) => `<tr class="${r.user_id === me ? "me" : ""} ${rankOf(rows, i) === 1 ? "first" : ""}"><td class="pos">${rankOf(rows, i)}</td><td><span class="who">${avatar(r.nickname)}${esc(r.nickname)}${r.user_id === me ? ' <span class="tag">você</span>' : ""}</span></td><td class="r num">${r.hits}</td><td class="pts-cell">${pts(r.points)}</td></tr>`).join("")}
            </tbody></table>`
            : `<div class="empty">Ainda não há pontos aqui. O ranking aparece quando os primeiros jogos terminarem.</div>`
        }
      </div>
      ${rows.length ? `<div class="actions"><a class="btn" target="_blank" rel="noopener" href="${whatsapp(d, rows)}">${icon("share").replace("<svg", '<svg width="16" height="16"')} Compartilhar no WhatsApp</a></div>` : ""}
      <p class="muted" style="font-size:12px;margin-top:14px">Cada acerto vale o lucro da odd justa (odd − 1). Desempate: mais acertos.${d.updated_at ? ` Atualizado ${fmtWhen(d.updated_at)}.` : ""}</p>`}
    </div>`;
  }

  view.addEventListener("click", (e) => {
    const tp = e.target.closest("[data-tipo]");
    if (tp) {
      S.tipo = tp.dataset.tipo;
      return paint();
    }
    const b = e.target.closest("[data-esc]");
    if (b) {
      S.escopo = b.dataset.esc;
      S.id = "";
      load();
    }
  });
  view.addEventListener("change", (e) => {
    if (e.target.matches("[data-sel]")) {
      S.id = e.target.value;
      load();
    }
  });
  load();
}

function whatsapp(d, rows) {
  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.slice(0, 8).map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.nickname} — ${pts(r.points)} pts`);
  const text = `🏆 Ranking do Bolão (${d.titulo})\n${lines.join("\n")}\n\n${location.origin}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// ---------- meus palpites + estatísticas ----------

const extraText = (p) => (p.mode === "ou" ? (p.pick_ou === "over" ? "Mais de 2,5" : "Menos de 2,5") : p.mode === "cs" ? `Placar ${p.home_goals}-${p.away_goals}` : "");
const pickText = (j, p) => {
  const w = p.pick_1x2 === "1" ? j.home.name : p.pick_1x2 === "2" ? j.away.name : "Empate";
  const x = extraText(p);
  return `${w}${x ? " · " + x : ""}${p.joker ? " · ★" : ""}`;
};

export async function renderMine(view) {
  view.innerHTML = `<div class="page narrow"><p class="boot">Carregando…</p></div>`;
  document.title = "Meus palpites · Bolão";
  let d;
  try {
    d = await api("/meus-palpites");
  } catch (e) {
    return fail(view, e);
  }
  const u = state.user;
  const s = d.stats;
  const byRound = new Map();
  for (const it of d.itens) {
    const g = byRound.get(it.rodada.id) ?? { rodada: it.rodada, items: [] };
    g.items.push(it);
    byRound.set(it.rodada.id, g);
  }
  view.innerHTML = `<div class="page narrow">
    <div class="card leader" style="min-height:0">
      <div class="wm">${esc(u.nickname)}</div>
      <div class="kick">${avatar(u.nickname, "lg")}<span>${esc(u.name)}</span></div>
      <h2 style="margin-bottom:6px">${esc(u.nickname)}</h2>
      <div class="statgrid" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat"><div class="l">Pontos totais</div><div class="v">${pts(s.total_pontos)}</div><div class="s">${s.palpites_pontuados} palpites pontuados</div></div>
        <div class="stat dark"><div class="l">Taxa de acerto</div><div class="v">${s.acerto_pct == null ? "—" : s.acerto_pct + "<small>%</small>"}</div><div class="s">palpites com algum acerto</div></div>
        <div class="stat dark"><div class="l">Melhor rodada</div><div class="v">${s.melhor_rodada ? pts(s.melhor_rodada.pontos) : "—"}</div><div class="s">${s.melhor_rodada ? esc(s.melhor_rodada.titulo) : "sem dados"}</div></div>
        <div class="stat"><div class="l">Maior zebra</div><div class="v">${s.maior_zebra ? "@" + odd(s.maior_zebra.odd) : "—"}</div><div class="s">${s.maior_zebra ? esc(zebraLabel(s.maior_zebra.tipo) + " · " + s.maior_zebra.jogo) : "vencedor ou placar exato"}</div></div>
      </div>
    </div>
    <h2 class="section-title">Histórico</h2>
    ${
      byRound.size
        ? [...byRound.values()]
            .map(
              (g) => `<div class="group"><div class="group-h" style="cursor:default"><b>${esc(g.rodada.title)}</b><span class="cnt">${fmtDate(g.rodada.date)}</span></div>
              <div class="matches">${g.items
                .map((it) => {
                  const j = it.jogo;
                  const done = j.home_goals != null && j.away_goals != null;
                  const p = it.palpite;
                  const cls = j.voided ? "" : p.points > 0 ? "pos" : "";
                  return `<a class="pick" data-link href="/jogo/${esc(j.id)}" style="text-decoration:none">
                    <span>${crest(j.home)}</span>
                    <span class="info"><b>${esc(j.home.name)} ${done ? `${j.home_goals} - ${j.away_goals}` : "x"} ${esc(j.away.name)}</b><small>${esc(pickText(j, p))}${j.voided ? " · anulado" : ""}</small></span>
                    <span class="pts-cell ${cls}" style="color:${p.points > 0 ? "var(--hit)" : "var(--muted-2)"}">${p.points == null ? "—" : signed(p.points)}</span></a>`;
                })
                .join("")}</div></div>`,
            )
            .join("")
        : `<div class="card card-pad empty">Você ainda não fez palpites. <a data-link href="/">Ir para a rodada</a></div>`
    }
  </div>`;
}

// ---------- detalhe do jogo ----------

export async function renderMatch(view, id) {
  view.innerHTML = `<div class="page narrow"><p class="boot">Carregando jogo…</p></div>`;
  let d;
  try {
    d = await api(`/jogos/${encodeURIComponent(id)}`);
  } catch (e) {
    return fail(view, e);
  }
  const j = d.jogo;
  document.title = `${j.home.name} x ${j.away.name} · Bolão`;
  const done = j.home_goals != null && j.away_goals != null;
  const label = (p) => {
    const w = p.pick_1x2 === "1" ? j.home.name : p.pick_1x2 === "2" ? j.away.name : "Empate";
    const x = extraText(p);
    return `<b>${esc(w)}</b><br><span class="muted">${esc(x || "só o vencedor")}${p.joker ? " · ★ coringa" : ""}</span>`;
  };
  view.innerHTML = `<div class="page narrow">
    <p><a data-link href="/" class="muted">‹ Voltar à rodada</a></p>
    <div class="card detail-hero">
      <div class="wm">${esc(j.home.name)}</div>
      <div class="muted" style="display:flex;justify-content:center;gap:8px;align-items:center;margin-bottom:12px">${leagueIcon(j.league)} ${esc(j.league.name)} · ${fmtWhen(j.kickoff_utc)}</div>
      <div class="row">
        <button class="team col" data-team="home">${crest(j.home, "xl")}<span class="tn">${esc(j.home.name)}</span></button>
        <div>${done ? `<div class="final">${j.home_goals} - ${j.away_goals}</div><span class="tag ${j.voided ? "" : "ok"}">${j.voided ? "Anulado" : "Final"}</span>` : `<div class="final" style="font-size:38px">${j.locked ? "x" : "vs"}</div>${j.locked ? '<span class="tag live">Em andamento</span>' : ""}`}</div>
        <button class="team col" data-team="away">${crest(j.away, "xl")}<span class="tn">${esc(j.away.name)}</span></button>
      </div>
      ${j.odds_1x2 ? `<div class="statgrid" style="margin-top:16px"><div class="stat"><div class="l">${j.locked ? "Odd justa · " : ""}Casa</div><div class="v">${odd(j.odds_1x2["1"])}</div></div><div class="stat dark"><div class="l">Empate</div><div class="v">${odd(j.odds_1x2.X)}</div></div><div class="stat"><div class="l">Fora</div><div class="v">${odd(j.odds_1x2["2"])}</div></div></div>` : ""}
    </div>
    ${j.mine ? `<div class="result-line" style="margin:14px 0"><span>Seu palpite: ${label(j.mine)}</span>${j.settled ? `<span class="pts ${j.mine.points > 0 ? "pos" : ""}">${signed(j.mine.points)}</span>` : ""}</div>` : ""}
    <h2 class="section-title">Palpites da galera</h2>
    ${
      d.palpites
        ? `<div class="card" style="overflow:hidden">${
            d.palpites.length
              ? `<table class="table"><thead><tr><th>Participante</th><th>Palpite</th><th class="r">Pontos</th></tr></thead><tbody>${d.palpites
                  .map((p) => `<tr class="${p.user_id === state.user.id ? "me" : ""}"><td><span class="who">${avatar(p.nickname)}${esc(p.nickname)}</span></td><td>${label(p)}</td><td class="pts-cell" style="color:${p.points > 0 ? "var(--hit)" : "var(--muted-2)"}">${p.points == null ? "—" : signed(p.points)}</td></tr>`)
                  .join("")}</tbody></table>`
              : `<div class="empty">Ninguém palpitou neste jogo.</div>`
          }</div>`
        : `<div class="notice">${icon("lock").replace("<svg", '<svg width="14" height="14" style="vertical-align:-2px"')} Os palpites dos outros aparecem quando o jogo começar (${fmtWhen(j.kickoff_utc)}).</div>`
    }
  </div>`;
  view.querySelectorAll("[data-team]").forEach((b) => (b.onclick = () => openTeam(j[b.dataset.team])));
}
