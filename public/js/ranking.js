// Ranking (ref. 1: líder em destaque + blocos de números), meus palpites e detalhe do jogo.
import { toast } from "./util.js";
import { api, avatar, crest, esc, fmtDate, fmtMonth, fmtWhen, icon, leagueIcon, liveLabel, odd, pts, signed, zebraBlock, zebraLabel } from "./util.js";
import { state } from "./store.js";
import { openTeam } from "./team.js";

const fail = (view, e) => (view.innerHTML = `<div class="page narrow"><div class="card card-pad"><p class="error">${esc(e.message)}</p></div></div>`);

// ---------- ranking ----------

/** Sem desempate: pontuação igual divide a posição (1º, 1º, 3º). */
const rankOf = (rows, i) => 1 + rows.filter((r) => r.points > rows[i].points).length;

export function renderRanking(view) {
  const S = { escopo: "geral", id: "", tipo: "pontos", data: null, perRound: null, camps: null, camp: null, completa: false };
  view.innerHTML = `<div class="page narrow"><p class="boot">Carregando ranking…</p></div>`;

  async function loadCamp() {
    try {
      S.camps ??= (await api("/campeonatos")).campeonatos;
      if (!S.camps.length) {
        S.camp = null;
        return paintCamp();
      }
      if (!S.camps.some((x) => x.id === S.id)) S.id = (S.camps.find((x) => x.situacao === "em andamento") ?? S.camps[0]).id;
      S.camp = await api(`/campeonatos/${encodeURIComponent(S.id)}/ranking`);
      paintCamp();
    } catch (e) {
      fail(view, e);
    }
  }

  function paintCamp() {
    const tabs = `<div class="tabs" role="tablist">${[["rodada", "Rodada"], ["mes", "Mês"], ["geral", "Geral"], ["camp", "Campeonato"]].map(([k, t]) => `<button role="tab" data-esc="${k}" aria-selected="${S.escopo === k}">${t}</button>`).join("")}</div>`;
    if (!S.camp) {
      view.innerHTML = `<div class="page narrow"><h1 class="section-title">Ranking<small>Campeonato</small></h1>${tabs}<div class="card card-pad empty">Nenhum campeonato criado ainda.</div></div>`;
      return;
    }
    const c = S.camp.campeonato;
    const rows = S.camp.rows;
    const me = state.user.id;
    const sit = S.camps.find((x) => x.id === c.id)?.situacao ?? "";
    view.innerHTML = `<div class="page narrow">
      <h1 class="section-title">Ranking<small>${esc(c.name)}</small></h1>
      ${tabs}
      ${S.camps.length > 1 ? `<div style="margin-bottom:12px"><select data-sel aria-label="Campeonato">${S.camps.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.name)} · ${x.situacao}</option>`).join("")}</select></div>` : ""}
      <div class="card card-pad" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-family:var(--font-display);font-size:24px">${esc(c.name)}</b><span class="tag ${sit === "em andamento" ? "ok" : ""}">${sit}</span></div>
        <div class="muted" style="font-size:13px">De ${fmtDate(c.start_date)} a ${fmtDate(c.end_date)} · ${c.formato ? `${esc(c.formato)}, ${c.legs === 2 ? "ida e volta" : "só ida"}` : "soma as rodadas e as perguntas extras desse período"}</div>
        ${c.fee ? `<div style="margin-top:8px"><span class="tag">Competição paga: ${esc(c.fee)}</span> <span class="muted" style="font-size:12px">combinado entre vocês; o app não recebe pagamentos</span></div>` : ""}
        ${c.prize ? `<div style="margin-top:10px"><div style="font-size:12px;font-weight:600;color:var(--ink-3)">PREMIAÇÃO</div><div class="prize">${esc(c.prize)}</div></div>` : ""}
      </div>
      ${S.camp.confrontos ? confrontosBody(S.camp, me) : `<div class="card" style="overflow:hidden">${
        rows.length
          ? `<table class="table"><thead><tr><th>#</th><th>Participante</th><th class="r">Acertos</th><th class="r">Pontos</th></tr></thead><tbody>${rows.map((r, i) => `<tr class="${r.user_id === me ? "me" : ""} ${rankOf(rows, i) === 1 ? "first" : ""}"><td class="pos">${rankOf(rows, i)}</td><td><span class="who">${avatar(r.nickname)}${esc(r.nickname)}${r.user_id === me ? ' <span class="tag">você</span>' : ""}</span></td><td class="r num">${r.hits}</td><td class="pts-cell">${pts(r.points)}</td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">Ainda sem pontos neste campeonato.</div>`
      }</div>`}</div>`;
  }

  /** Campeonato de confrontos: classificação (reduzida/completa), rodadas e mata-mata. */
  function confrontosBody(d, me) {
    const c = d.campeonato;
    const dot = (r) => `<i class="f5 ${r}" title="${{ V: "Vitória", E: "Empate", D: "Derrota" }[r]}">${r}</i>`;
    const tabela = (g) => `<div class="card matrix" style="margin-bottom:12px">${d.grupos.length > 1 || c.format !== "pontos" ? `<div class="group-h" style="cursor:default"><b>${esc(g.name)}</b></div>` : ""}<table class="table">
      <thead><tr><th>#</th><th>Nome</th><th class="r">P</th><th class="r">J</th>${S.completa ? '<th class="r">V</th><th class="r">E</th><th class="r">D</th><th class="r">GP</th><th class="r">GC</th>' : ""}<th class="r">SG</th>${S.completa ? "<th>Últimos 5</th>" : ""}</tr></thead>
      <tbody>${g.table.map((r) => `<tr class="${r.user_id === me ? "me" : ""} ${r.pos === 1 ? "first" : ""}"><td class="pos">${r.pos}</td><td><span class="who">${avatar(r.nickname)}${esc(r.nickname)}</span></td><td class="pts-cell">${r.P}</td><td class="r num">${r.J}</td>${S.completa ? `<td class="r num">${r.V}</td><td class="r num">${r.E}</td><td class="r num">${r.D}</td><td class="r num">${r.GP}</td><td class="r num">${r.GC}</td>` : ""}<td class="r num">${r.SG > 0 ? "+" : ""}${r.SG}</td>${S.completa ? `<td><span class="last5">${r.last5.map(dot).join("") || '<span class="muted">–</span>'}</span></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
    const placar = (f) => (f.hg == null ? '<span class="muted">x</span>' : `<b>${f.hg}</b> x <b>${f.ag}</b>`);
    const nome = (n) => (n ? esc(n) : '<span class="muted">a definir</span>');
    return `
      ${d.campeao ? `<div class="card card-pad" style="margin-bottom:12px;text-align:center"><div class="muted" style="font-size:12px;font-weight:600">CAMPEÃO</div><div style="font-family:var(--font-display);font-size:32px;font-weight:700">${esc(d.campeao)}</div></div>` : ""}
      ${d.grupos.length ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px"><h2 class="section-title" style="margin:0">Classificação</h2><div class="seg" role="group" aria-label="Tipo de tabela"><button data-tab="red" aria-pressed="${!S.completa}">Reduzida</button><button data-tab="comp" aria-pressed="${S.completa}">Completa</button></div></div>${d.grupos.map(tabela).join("")}` : ""}
      ${d.mata.length ? `<h2 class="section-title">Mata-mata</h2>${d.mata.map((m) => `<div class="card" style="margin-bottom:12px;overflow:hidden"><div class="group-h" style="cursor:default"><b>${esc(m.stage)}</b></div>${m.ties.map((t) => `<div class="list-row"><div class="grow">${nome(t.a_nick)} <span class="muted">x</span> ${nome(t.b_nick)}</div><span class="num">${t.ga == null ? "" : `${t.ga} x ${t.gb}`}</span>${t.winner_nick ? `<span class="tag ok">passa ${esc(t.winner_nick)}${t.decidedBy === "pênaltis" ? " (pênaltis)" : t.decidedBy === "folga" ? " (folga)" : ""}</span>` : ""}</div>`).join("")}</div>`).join("")}` : ""}
      <h2 class="section-title">Rodadas<small>${d.rodadas.length} de ${d.rodadas_necessarias}</small></h2>
      ${d.rodadas.map((r) => `<div class="card" style="margin-bottom:10px;overflow:hidden"><div class="group-h" style="cursor:default"><b>${r.n}ª rodada</b><span class="cnt">${esc(r.stage)} · ${r.date ? fmtDate(r.date) : "data a definir"}${r.date && !r.final ? " · em andamento" : ""}</span></div>${r.fixtures.map((f) => `<div class="list-row"><div class="grow" style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center"><span style="text-align:right">${nome(f.home_nick)}</span><span class="num">${placar(f)}</span><span>${nome(f.away_nick)}</span></div>${f.note ? `<span class="tag">${esc(f.note)}</span>` : ""}</div>`).join("")}</div>`).join("")}
      <p class="muted" style="font-size:12px">Cada dia com rodada é uma rodada do campeonato. Seu lucro do dia vira gols (${c.goal_step ?? 1} ponto${(c.goal_step ?? 1) === 1 ? "" : "s"} = 1 gol). Vitória vale 3, empate 1. Classificação por pontos, vitórias, saldo e gols pró; tudo igual divide a posição.${c.format === "mata" || c.format === "copa" ? " No mata-mata, empate no placar vai para os pênaltis: passa quem teve mais acertos (regra provisória)." : ""}</p>`;
  }

  async function load() {
    if (S.escopo === "camp") return loadCamp();
    try {
      S.data = await api(`/ranking?escopo=${S.escopo}&id=${encodeURIComponent(S.id)}`);
      S.id = S.data.id;
      paint();
    } catch (e) {
      fail(view, e);
    }
  }

  async function loadPerRound() {
    try {
      S.perRound = await api("/ranking/rodadas");
    } catch {
      S.perRound = { rodadas: [], participantes: [] }; // é só um complemento
    }
    if (S.tipo === "pontos" && S.data && S.escopo !== "camp") paint();
  }

  /** Quanto cada participante fez em cada uma das últimas rodadas (melhor de cada rodada em destaque). */
  function perRoundCard() {
    const pr = S.perRound;
    if (!pr) return "";
    const me = state.user.id;
    if (!pr.rodadas.length || !pr.participantes.length) return "";
    const best = Object.fromEntries(pr.rodadas.map((r) => [r.id, Math.max(...pr.participantes.map((p) => p.porRodada[r.id] ?? -Infinity))]));
    return `<h2 class="section-title" style="margin-top:22px">Ganho por rodada<small>últimas ${pr.rodadas.length}</small></h2>
      <div class="card matrix"><table class="table"><thead><tr><th>Participante</th>${pr.rodadas.map((r) => `<th class="r" title="${esc(r.title)}">${fmtDate(r.date).slice(0, 5)}</th>`).join("")}<th class="r">Total</th></tr></thead><tbody>
        ${pr.participantes
          .map(
            (p) => `<tr class="${p.user_id === me ? "me" : ""}"><td><span class="who">${avatar(p.nickname)}${esc(p.nickname)}</span></td>${pr.rodadas
              .map((r) => {
                const v = p.porRodada[r.id];
                return v == null ? `<td class="r none">–</td>` : `<td class="r num ${v === best[r.id] && v > 0 ? "best" : ""}">${pts(v)}</td>`;
              })
              .join("")}<td class="r pts-cell">${pts(p.total)}</td></tr>`,
          )
          .join("")}
      </tbody></table></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Em verde, o melhor de cada rodada. “–” = não participou daquela rodada.</p>`;
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
    view.innerHTML = `<div class="page narrow">
      <h1 class="section-title">Ranking<small>${esc(S.escopo === "mes" ? fmtMonth(S.id) : d.titulo)}</small></h1>
      <div class="tabs" role="tablist">${[["rodada", "Rodada"], ["mes", "Mês"], ["geral", "Geral"], ["camp", "Campeonato"]].map(([k, t]) => `<button role="tab" data-esc="${k}" aria-selected="${S.escopo === k}">${t}</button>`).join("")}</div>
      ${selector ? `<div style="margin-bottom:12px">${selector}</div>` : ""}
      ${`${
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
      ${perRoundCard()}
      ${rows.length ? `<div class="actions"><a class="btn" target="_blank" rel="noopener" href="${whatsapp(d, rows)}">${icon("share").replace("<svg", '<svg width="16" height="16"')} Compartilhar no WhatsApp</a></div>` : ""}
      <p class="muted" style="font-size:12px;margin-top:14px">Cada acerto vale o lucro da odd justa (odd − 1). Pontos iguais dividem a posição.${d.updated_at ? ` Atualizado ${fmtWhen(d.updated_at)}.` : ""}</p>`}
    </div>`;
  }

  view.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tab]");
    if (tb) {
      S.completa = tb.dataset.tab === "comp";
      return paintCamp();
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
  loadPerRound();
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
  return `${w}${x ? " · " + x : ""}`;
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
              (g) => {
                const ganho = g.items.reduce((s, it) => s + (it.palpite.points ?? 0), 0);
                const fechada = g.items.some((it) => it.palpite.points != null);
                return `<div class="group"><div class="group-h" style="cursor:default"><b>${esc(g.rodada.title)}</b><span class="cnt">${fmtDate(g.rodada.date)}${fechada ? ` · ganho <b style="color:${ganho > 0 ? "var(--hit)" : "inherit"}">${ganho > 0 ? signed(ganho) : "0.00"}</b>` : ""}</span></div>
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
                .join("")}</div></div>`;
              },
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
    return `<b>${esc(w)}</b><br><span class="muted">${esc(x || "só o vencedor")}</span>`;
  };
  view.innerHTML = `<div class="page narrow">
    <p><a data-link href="/" class="muted">‹ Voltar à rodada</a></p>
    <div class="card detail-hero">
      <div class="wm">${esc(j.home.name)}</div>
      <div class="muted" style="display:flex;justify-content:center;gap:8px;align-items:center;margin-bottom:12px">${leagueIcon(j.league)} ${esc(j.league.name)} · ${fmtWhen(j.kickoff_utc)}</div>
      <div class="row">
        <button class="team col" data-team="home">${crest(j.home, "xl")}<span class="tn">${esc(j.home.name)}</span></button>
        <div>${done ? `<div class="final">${j.home_goals} - ${j.away_goals}</div><span class="tag ${j.voided ? "" : "ok"}">${j.voided ? "Excluído da rodada" : "Final"}</span>` : j.live ? `<div class="final">${j.live.home ?? 0} - ${j.live.away ?? 0}</div><span class="tag live">${esc(liveLabel(j.live))}</span>` : `<div class="final" style="font-size:38px">${j.locked ? "x" : "vs"}</div>${j.locked ? '<span class="tag live">Em andamento</span>' : ""}`}</div>
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
                  .map((p) => `<tr class="${p.user_id === state.user.id ? "me" : ""}"><td><span class="who">${avatar(p.nickname)}${esc(p.nickname)}</span></td><td>${label(p)}<div class="reacts" data-reacts="${esc(p.id)}" data-own="${p.user_id === state.user.id}"></div></td><td class="pts-cell" style="color:${p.points > 0 ? "var(--hit)" : "var(--muted-2)"}">${p.points == null ? "—" : signed(p.points)}</td></tr>`)
                  .join("")}</tbody></table>`
              : `<div class="empty">Ninguém palpitou neste jogo.</div>`
          }</div>`
        : `<div class="notice">${icon("lock").replace("<svg", '<svg width="14" height="14" style="vertical-align:-2px"')} Os palpites dos outros aparecem quando o jogo começar (${fmtWhen(j.kickoff_utc)}).</div>`
    }
  </div>`;
  view.querySelectorAll("[data-team]").forEach((b) => (b.onclick = () => openTeam(j[b.dataset.team])));
  view.querySelector(".page").insertAdjacentHTML("beforeend", `<h2 class="section-title">Comentários</h2><div id="social"></div>`);
  social(view, j.id);
}

/** Comentários do jogo e reações aos palpites (as reações só existem depois do apito). */
async function social(view, matchId) {
  const box = view.querySelector("#social");
  let s;
  async function load() {
    try {
      s = await api(`/jogos/${encodeURIComponent(matchId)}/social`);
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    paint();
  }
  function paint() {
    view.querySelectorAll("[data-reacts]").forEach((el) => {
      const mine = s.reacoes[el.dataset.reacts] ?? {};
      const own = el.dataset.own === "true";
      el.innerHTML = s.reacoes_possiveis
        .map((e) => {
          const r = mine[e];
          if (own && !r) return "";
          return `<button class="react" data-emoji="${e}" data-pred="${esc(el.dataset.reacts)}" aria-pressed="${!!r?.meu}" aria-label="Reagir ${e}" ${own ? "disabled" : ""}>${e}${r ? " " + r.n : ""}</button>`;
        })
        .join("");
    });
    box.innerHTML = `<div class="card" style="overflow:hidden;margin-bottom:12px">${
      s.comentarios.length
        ? s.comentarios
            .map(
              (c) => `<div class="cmt"><div style="display:flex;justify-content:space-between;gap:8px"><span class="who">${esc(c.nickname)}</span><span class="muted" style="font-size:12px">${fmtWhen(c.created_at)}${c.pode_apagar ? ` · <button class="linkish" data-del-c="${esc(c.id)}">apagar</button>` : ""}</span></div><div style="margin-top:2px;overflow-wrap:anywhere">${esc(c.text)}</div></div>`,
            )
            .join("")
        : `<div class="empty">Ninguém comentou ainda. Comece a resenha!</div>`
    }</div>
    <form class="form" data-cform style="display:flex;gap:8px;align-items:flex-end"><label class="f" style="flex-grow:1">Seu comentário<input name="texto" maxlength="280" placeholder="Manda a resenha" autocomplete="off" required></label><button class="btn primary" type="submit">Enviar</button></form>`;
  }
  view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-emoji]");
    if (b && !b.disabled) {
      b.disabled = true;
      try {
        await api(`/palpites/${encodeURIComponent(b.dataset.pred)}/reacao`, { method: "POST", body: { emoji: b.dataset.emoji } });
        await load();
      } catch (err) {
        toast(err.message, "err");
        b.disabled = false;
      }
    }
    const d = e.target.closest("[data-del-c]");
    if (d && confirm("Apagar este comentário?")) {
      try {
        await api(`/comentarios/${encodeURIComponent(d.dataset.delC)}`, { method: "DELETE" });
        await load();
      } catch (err) {
        toast(err.message, "err");
      }
    }
  });
  view.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-cform]")) return;
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      await api(`/jogos/${encodeURIComponent(matchId)}/comentarios`, { method: "POST", body: { texto: f.texto.value } });
      f.reset();
      await load();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
  load();
}
