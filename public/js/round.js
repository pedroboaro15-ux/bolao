// Tela principal: rodada atual. Palpites salvos automaticamente (sem cupom).
import { api, crest, esc, fmtClock, fmtDate, fmtWhen, icon, leagueIcon, liveLabel, now, odd, pts, signed, syncClock, toast, zebraBlock } from "./util.js";
import { go, state } from "./store.js";
import { openTeam } from "./team.js";
import { mountQuestions } from "./questions.js";
import { renderPedidos } from "./pedidos.js";

let S = null;

const outcome = (h, a) => (h > a ? "1" : h === a ? "X" : "2");
const isLocked = (m) => m.locked || Date.parse(m.kickoff_utc) <= now();
const blank = () => ({ pick_1x2: null, mode: null, pick_ou: null, home_goals: null, away_goals: null, joker: false });
const goalsOf = (d) => (d.mode === "cs" ? [d.home_goals ?? null, d.away_goals ?? null] : [null, null]);
const ouOf = (d) => (d.mode === "ou" ? (d.pick_ou ?? null) : null);
/** O que vai para o servidor: só os campos do modo escolhido. */
const payload = (d) => ({ pick_1x2: d.pick_1x2, mode: d.mode ?? null, pick_ou: ouOf(d), home_goals: goalsOf(d)[0], away_goals: goalsOf(d)[1], joker: !!d.joker });
const complete = (d) => !!d && !!d.pick_1x2 && (d.mode === "ou" ? !!d.pick_ou : d.mode === "cs" ? d.home_goals != null && d.away_goals != null : true);
const same = (d, mine) => {
  if (!mine || !d) return false;
  const a = payload(d);
  const b = payload(mine);
  return a.pick_1x2 === b.pick_1x2 && a.mode === b.mode && a.pick_ou === b.pick_ou && a.home_goals === b.home_goals && a.away_goals === b.away_goals && a.joker === b.joker;
};
/** Extras ligados pelo admin neste jogo. */
const extrasOf = (m) => m.extras ?? { ou: true, cs: true };
const dirty = (m) => !isLocked(m) && !!S.drafts[m.id] && !same(S.drafts[m.id], m.mine);

export function render(view, { id }) {
  S = { view, id, data: null, drafts: {}, touched: new Set(), errors: {}, league: "all", tab: "todos", collapsed: new Set(), saving: false, again: false, saveTimer: null, rank: null, rankAt: 0 };
  view.innerHTML = `<div class="page"><p class="boot">Carregando rodada…</p></div>`;
  load();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const jogos = S?.data?.jogos ?? [];
    const virou = jogos.some((m) => !m.locked && isLocked(m)); // um jogo acabou de começar
    const rolando = jogos.some((m) => isLocked(m) && !m.settled && !m.voided); // placar ao vivo: olha de novo a cada 1 min
    if (document.visibilityState === "visible" && (virou || (rolando && tick % 3 === 0))) load();
  }, 20000);
  const onClick = (e) => handle(e);
  const beforeUnload = (e) => {
    if (S?.data?.jogos.some((m) => dirty(m) && complete(S.drafts[m.id]))) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  const flush = () => {
    if (!S?.data || document.visibilityState === "visible") return;
    clearTimeout(S.saveTimer);
    save(true); // o iPhone suspende a página ao trocar de app: salva já, com keepalive
  };
  view.addEventListener("click", onClick);
  window.addEventListener("beforeunload", beforeUnload);
  document.addEventListener("visibilitychange", flush);
  window.addEventListener("pagehide", flush);
  return () => {
    clearInterval(timer);
    clearTimeout(S?.saveTimer);
    window.removeEventListener("beforeunload", beforeUnload);
    document.removeEventListener("visibilitychange", flush);
    window.removeEventListener("pagehide", flush);
    S = null;
  };
}

async function load() {
  const mine = S;
  try {
    const d = await api(mine.id ? `/rodadas/${encodeURIComponent(mine.id)}` : "/rodada/atual");
    if (S !== mine) return;
    syncClock(d.agora);
    S.data = d;
    document.title = d.rodada ? `${d.rodada.title} · Bolão` : "Bolão";
    for (const m of d.jogos) {
      if (S.touched.has(m.id) && !isLocked(m)) {
        // mantém o que a pessoa está editando, mas sem um extra que o admin acabou de desligar
        const dr = S.drafts[m.id];
        if (dr?.mode === "ou" && !extrasOf(m).ou) Object.assign(dr, { mode: null, pick_ou: null });
        if (dr?.mode === "cs" && !extrasOf(m).cs) Object.assign(dr, { mode: null, home_goals: null, away_goals: null });
        continue;
      }
      S.drafts[m.id] = m.mine ? { ...m.mine } : undefined;
    }
    paint();
    if (d.rodada && Date.now() - S.rankAt > 60_000) loadRank(d.rodada.id);
  } catch (e) {
    if (S === mine) S.view.innerHTML = `<div class="page narrow"><div class="card card-pad"><p class="error">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Tentar de novo</button></div></div>`;
  }
}

async function loadRank(roundId) {
  const mine = S;
  mine.rankAt = Date.now();
  try {
    const r = await api(`/ranking?escopo=rodada&id=${encodeURIComponent(roundId)}`);
    if (S !== mine) return;
    S.rank = r.rows;
    S.zebra = r.zebra;
    paint();
  } catch {
    /* o ranking é só um complemento */
  }
}

// ---------- ações ----------

function handle(e) {
  const t = e.target.closest("[data-act]");
  if (!t || !S?.data) return;
  const act = t.dataset.act;
  const m = S.data.jogos.find((x) => x.id === t.dataset.m);

  if (act === "league") {
    S.league = t.dataset.v === "all" ? "all" : Number(t.dataset.v);
    return paint();
  }
  if (act === "tab") {
    S.tab = t.dataset.v;
    return paint();
  }
  if (act === "group") {
    const k = t.dataset.v;
    S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k);
    return paint();
  }
  if (act === "round") return go(!t.dataset.v || t.dataset.v === S.data.atual ? "/" : `/rodada/${t.dataset.v}`);
  if (act === "team") {
    const [id, ...rest] = t.dataset.v.split("|");
    const team = m ? (m.home.id === Number(id) ? m.home : m.away) : { id: Number(id), name: rest.join("|") };
    return openTeam(team);
  }
  if (!m || isLocked(m)) return;

  const d = (S.drafts[m.id] ??= blank());
  S.touched.add(m.id);
  delete S.errors[m.id];

  if (act === "w") {
    if (d.mode === "cs") return; // no placar exato o vencedor sai do placar
    d.pick_1x2 = t.dataset.v;
  } else if (act === "mode") {
    const want = t.dataset.v === "cs" ? "cs" : t.dataset.v === "ou" ? "ou" : null;
    if (want === "ou" && !extrasOf(m).ou) return;
    if (want === "cs" && !extrasOf(m).cs) return;
    d.mode = want;
    if (want === "cs") {
      d.pick_ou = null;
      if (d.home_goals == null || d.away_goals == null) {
        // parte de um placar coerente com o vencedor já escolhido; sem vencedor, a pessoa define pelo placar
        d.home_goals = d.away_goals = null;
        if (d.pick_1x2) {
          d.home_goals = d.pick_1x2 === "2" ? 0 : 1;
          d.away_goals = d.pick_1x2 === "1" ? 0 : 1;
        }
      } else d.pick_1x2 = outcome(d.home_goals, d.away_goals);
    } else {
      d.home_goals = d.away_goals = null;
      if (want === null) d.pick_ou = null;
    }
  } else if (act === "ou") {
    d.pick_ou = t.dataset.v;
  } else if (act === "goal") {
    const side = t.dataset.side === "h" ? "home_goals" : "away_goals";
    d.home_goals ??= 0;
    d.away_goals ??= 0;
    d[side] = Math.max(0, Math.min(9, d[side] + Number(t.dataset.d)));
    d.pick_1x2 = outcome(d.home_goals, d.away_goals); // mexer no placar muda o vencedor junto
  } else if (act === "joker") {
    if (!complete(d)) return toast("Complete o palpite antes de usar o coringa.", "err");
    const on = !d.joker;
    for (const x of S.data.jogos) {
      if (x.id !== m.id && S.drafts[x.id]?.joker) {
        S.drafts[x.id].joker = false;
        S.touched.add(x.id);
      }
    }
    d.joker = on;
  }
  paint();
  scheduleSave();
}

const scheduleSave = () => {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => save(), 700);
};

async function save(keepalive = false) {
  if (!S?.data) return;
  if (S.saving) {
    S.again = true;
    return;
  }
  const send = S.data.jogos.filter((m) => dirty(m) && complete(S.drafts[m.id]) && !S.errors[m.id]);
  if (!send.length) return;
  const mine = S;
  S.saving = true;
  try {
    const palpites = send.map((m) => ({ match_id: m.id, ...payload(S.drafts[m.id]) }));
    const r = await api(`/rodadas/${S.data.rodada.id}/palpites`, { method: "PUT", body: { palpites }, keepalive });
    for (const id of r.salvos) S.touched.delete(id);
    Object.assign(S.errors, r.erros);
    if (Object.keys(r.erros).length) toast(Object.values(r.erros)[0], "err");
    else if (r.salvos.length) toast("Palpites salvos", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    if (S === mine) {
      S.saving = false;
      await load();
      if (S === mine && S.again) {
        S.again = false;
        scheduleSave();
      }
    }
  }
}

// ---------- desenho ----------

/** Dia do bolão de agora (06:00 → 06:00 em São Paulo = começa às 09:00 UTC). */
const todayBolao = () => new Date(now() - 9 * 3600_000).toISOString().slice(0, 10);

const statusText = (s) => ({ open: "aberta para palpites", closed: "palpites encerrados", finished: "encerrada", draft: "rascunho" })[s] ?? s;
const pickLabel = (m, d) => (d.pick_1x2 === "1" ? m.home.name : d.pick_1x2 === "2" ? m.away.name : "Empate");

function maxPoints(m, d) {
  const w = m.odds_1x2?.[d.pick_1x2];
  const x = d.mode === "ou" ? m.odds_ou?.[d.pick_ou] : d.mode === "cs" ? m.cs?.[`${d.home_goals}-${d.away_goals}`] : null;
  let p = d.mode === "cs" ? (x ? x - 1 : 0) : (w ? w - 1 : 0) + (d.mode === "ou" && x ? x - 1 : 0);
  if (d.joker && S.data.coringa.ativo) p *= S.data.coringa.multiplicador;
  return p;
}

function paint() {
  if (!S?.data) return;
  const y = window.scrollY;
  const d = S.data;
  if (!d.rodada) {
    if (S.pedidosOn) return; // já desenhado: não refaz (perderia o que a pessoa digitou)
    S.pedidosOn = true;
    S.view.innerHTML = `<div class="page narrow">
      <h1 class="section-title">Sem rodada hoje<small>${fmtDate(d.hoje ?? todayBolao())}</small></h1>
      ${d.outras?.length ? `<div class="chips" aria-label="Rodadas anteriores">${d.outras.map((x) => `<button class="chip" data-act="round" data-v="${esc(x.id)}">${esc(x.title)} · encerrada</button>`).join("")}</div>` : ""}
      <div id="perguntas-slot"></div>
      <h2 class="section-title">O que você quer no próximo bolão?</h2>
      <div id="pedidos-box"></div></div>`;
    mountQuestions(S.view.querySelector("#perguntas-slot"), d.hoje ?? todayBolao());
    renderPedidos(S.view.querySelector("#pedidos-box"));
    return;
  }
  const leagues = new Map();
  for (const m of d.jogos) {
    const l = leagues.get(m.league.id) ?? { ...m.league, n: 0 };
    l.n++;
    leagues.set(m.league.id, l);
  }
  const visible = d.jogos.filter((m) => (S.league === "all" || m.league.id === S.league) && (S.tab === "todos" || (S.tab === "abertos" ? !isLocked(m) : isLocked(m))));
  const groups = new Map();
  for (const m of visible) {
    const g = groups.get(m.league.id) ?? { league: m.league, items: [] };
    g.items.push(m);
    groups.set(m.league.id, g);
  }
  const open = d.jogos.filter((m) => !isLocked(m) && !m.voided);
  const done = open.filter((m) => S.drafts[m.id] && complete(S.drafts[m.id]) && !dirty(m)).length;

  const rank = S.rank;
  const meIdx = rank ? rank.findIndex((r) => r.user_id === state.user.id) : -1;
  const meRow = meIdx >= 0 ? rank[meIdx] : null;
  const position = meRow ? 1 + rank.filter((r) => r.points > meRow.points || (r.points === meRow.points && r.hits > meRow.hits)).length : null;

  S.view.innerHTML = `
  <div class="page">
    <div class="grid3">
      <aside class="side">
        <div class="card">
          <h3>Campeonatos</h3>
          <button class="side-item" data-act="league" data-v="all" aria-pressed="${S.league === "all"}">${icon("ball")}<span>Todos os jogos</span><span class="count">${d.jogos.length}</span></button>
          ${[...leagues.values()].map((l) => `<button class="side-item" data-act="league" data-v="${l.id}" aria-pressed="${S.league === l.id}">${leagueIcon(l)}<span>${esc(l.name)}</span><span class="count">${l.n}</span></button>`).join("")}
        </div>
        ${
          d.outras?.length > 1
            ? `<div class="card"><h3>Rodadas</h3>${d.outras.map((r) => `<button class="side-item" data-act="round" data-v="${esc(r.id)}" aria-pressed="${r.id === d.rodada.id}"><span>${esc(r.title)}</span><span class="count">${r.id === d.atual ? "atual" : fmtDate(r.date).slice(0, 5)}</span></button>`).join("")}</div>`
            : ""
        }
      </aside>

      <section>
        <h1 class="section-title">${esc(d.rodada.title)}<small>${fmtDate(d.rodada.date)} · ${statusText(d.rodada.status)}</small></h1>
        ${d.rodada.id !== d.atual ? `<div class="notice" style="margin-bottom:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span>Você está vendo uma rodada anterior (encerrada).</span><button class="btn small primary" data-act="round" data-v="${esc(d.atual ?? "")}">${d.atual ? "Voltar para a rodada de hoje" : "Voltar para o início"}</button></div>` : ""}
        ${d.outras?.length > 1 ? `<div class="chips mobile-only" aria-label="Rodadas">${d.outras.map((r) => `<button class="chip" data-act="round" data-v="${esc(r.id)}" aria-pressed="${r.id === d.rodada.id}">${esc(r.title)}${r.id === d.atual ? " · atual" : ""}</button>`).join("")}</div>` : ""}
        <div class="chips mobile-only" aria-label="Campeonatos">
          <button class="chip" data-act="league" data-v="all" aria-pressed="${S.league === "all"}">Todos</button>
          ${[...leagues.values()].map((l) => `<button class="chip" data-act="league" data-v="${l.id}" aria-pressed="${S.league === l.id}">${esc(l.name)}</button>`).join("")}
        </div>
        <div class="summary">
          <div><small>Sua posição</small><b>${position ? position + "º" : "–"}</b></div>
          <div><small>Lucro na rodada</small><b>${meRow ? pts(meRow.points) : "0.00"}</b></div>
          <div><small>Palpites feitos</small><b>${done} de ${open.length}</b></div>
        </div>
        ${open.some((m) => m.odds_1x2) ? `<div class="notice" style="margin-bottom:12px">${icon("lock").replace("<svg", '<svg width="14" height="14" style="vertical-align:-2px"')} As odds podem mudar até cada jogo começar e <b>congelam no início da partida</b>: vale a odd daquele momento, não a de quando você palpitou.</div>` : ""}
        <div id="perguntas-slot"></div>
        <div class="tabs" role="tablist">${[["todos", "Todos"], ["abertos", "Abertos"], ["encerrados", "Encerrados"]].map(([k, t]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${S.tab === k}">${t}</button>`).join("")}</div>
        ${groups.size ? [...groups.values()].map(group).join("") : `<div class="empty">Nenhum jogo com esse filtro.</div>`}
      </section>

      <aside class="aside">
        <div class="card">
          <h3 style="padding:12px 12px 0;font-size:16px">Top 3 da rodada</h3>
          ${
            rank?.length
              ? `<table class="table mini"><tbody>${rank.slice(0, 3).map((r, i) => `<tr class="${r.user_id === state.user.id ? "me" : ""}"><td class="pos">${i + 1}</td><td>${esc(r.nickname)}</td><td class="pts-cell">${pts(r.points)}</td></tr>`).join("")}</tbody></table>
                 <div style="padding:0 12px 12px"><a data-link href="/ranking" style="font-size:13px;color:var(--brand-text)">Ver classificação completa ›</a></div>`
              : `<p class="hint" style="padding:8px 12px 12px">O ranking aparece quando os primeiros jogos terminarem.</p>`
          }
        </div>
        <div class="card card-pad">${zebraBlock(S.zebra, "Maior zebra da rodada")}</div>
        <div class="card card-pad">
          <h3 style="font-size:16px;margin-bottom:6px">Como pontua</h3>
          <p class="hint" style="margin:0">Cada acerto vale o lucro da odd justa (odd − 1). Placar exato vale no lugar do vencedor. O coringa dobra um jogo por rodada.</p>
        </div>
      </aside>
    </div>
  </div>`;
  mountQuestions(S.view.querySelector("#perguntas-slot"), d.rodada.date);
  window.scrollTo(0, y);
}

function group(g) {
  const key = String(g.league.id);
  const collapsed = S.collapsed.has(key);
  return `<div class="group ${collapsed ? "collapsed" : ""}">
    <button class="group-h" data-act="group" data-v="${key}" aria-expanded="${!collapsed}">${leagueIcon(g.league)}<b>${esc(g.league.name)}</b><span class="cnt">${g.items.length} jogo${g.items.length > 1 ? "s" : ""}${g.league.country ? " · " + esc(g.league.country) : ""}</span><span class="chev">${icon("chev")}</span></button>
    <div class="matches">${g.items.map(matchCard).join("")}</div>
  </div>`;
}

const extraHit = (m, mine) => {
  if (!mine) return null;
  if (!mine.mode) return null;
  if (mine.mode === "ou") return mine.pick_ou === (m.home_goals + m.away_goals > 2.5 ? "over" : "under");
  return mine.home_goals === m.home_goals && mine.away_goals === m.away_goals;
};

function teamRow(m, side, showScore) {
  const t = side === "h" ? m.home : m.away;
  const live = !showScore && isLocked(m) && m.live ? m.live : null;
  const sc = showScore ? (side === "h" ? m.home_goals : m.away_goals) : live ? (side === "h" ? live.home : live.away) : null;
  const op = side === "h" ? m.away_goals : m.home_goals;
  const lose = showScore && sc < op;
  return `<button class="team${lose ? " lose" : ""}" data-act="team" data-m="${m.id}" data-v="${t.id}|${esc(t.name)}">${crest(t)}<span class="tn">${esc(t.name)}</span><span class="sc num${live ? " live" : ""}">${sc ?? ""}</span></button>`;
}

function matchCard(m) {
  const locked = isLocked(m);
  const d = S.drafts[m.id];
  const mine = m.mine;
  const o1 = m.odds_1x2;
  const scored = m.settled && !m.voided;
  const real = scored ? outcome(m.home_goals, m.away_goals) : null;
  const realOu = scored ? (m.home_goals + m.away_goals > 2.5 ? "over" : "under") : null;
  const badge = m.voided ? `<span class="badge end">Anulado</span>` : scored ? `<span class="badge end">Encerrado</span>` : locked ? (m.live ? `<span class="badge live">${esc(liveLabel(m.live))}</span>` : now() - Date.parse(m.kickoff_utc) > 150 * 60_000 ? `<span class="badge end">Aguardando resultado</span>` : `<span class="badge live">Em andamento</span>`) : `<span class="badge open">Fecha às ${fmtClock(m.kickoff_utc)}</span>`;
  const top = `<div class="ev-top"><span>${fmtWhen(m.kickoff_utc)}</span>${badge}</div>`;
  const teams = `<div class="teams">${teamRow(m, "h", scored)}${teamRow(m, "a", scored)}</div>`;
  const cur = locked ? mine : d;

  const ex = extrasOf(m);
  const mode = cur?.mode ?? null;
  const chips = ["1", "X", "2"]
    .map((k) => {
      const label = k === "1" ? "Casa" : k === "2" ? "Fora" : "Empate";
      const cls = real === k ? "hit" : locked && cur?.pick_1x2 === k && scored ? "miss" : "";
      // Sem odds ainda: o botão mostra o time (ou "Empate") e já dá para escolher; a odd aparece quando chegar.
      const who = k === "1" ? m.home.name : k === "2" ? m.away.name : "Empate";
      const value = o1 ? `<b>${odd(o1[k])}</b>` : `<b class="no-odd">${esc(who)}</b>`;
      return `<button class="odd ${cls}${o1 ? "" : " waiting"}" data-act="w" data-m="${m.id}" data-v="${k}" aria-pressed="${cur?.pick_1x2 === k}" aria-label="${label}${o1 ? `, odd ${odd(o1[k])}` : `: ${esc(who)}`}" ${locked || mode === "cs" ? "disabled" : ""}><span>${k}</span>${value}</button>`;
    })
    .join("");

  let extra = "";
  if (mode === "ou") {
    extra = `<div class="odds c2">${[["over", "Mais de 2,5"], ["under", "Menos de 2,5"]]
      .map(([k, l]) => `<button class="odd ${realOu === k ? "hit" : ""}" data-act="ou" data-m="${m.id}" data-v="${k}" aria-pressed="${cur?.pick_ou === k}" ${locked ? "disabled" : ""}><span>${l}</span><b>${odd(m.odds_ou?.[k])}</b></button>`)
      .join("")}</div>`;
  } else if (mode === "cs") {
    const hg = cur?.home_goals ?? null;
    const ag = cur?.away_goals ?? null;
    const stp = (side, v) =>
      locked
        ? `<div class="stp"><span class="v">${v ?? "–"}</span></div>`
        : `<div class="stp"><button data-act="goal" data-m="${m.id}" data-side="${side}" data-d="-1" aria-label="Diminuir" ${(v ?? 0) <= 0 ? "disabled" : ""}>−</button><span class="v">${v ?? "–"}</span><button data-act="goal" data-m="${m.id}" data-side="${side}" data-d="1" aria-label="Aumentar" ${(v ?? 0) >= 9 ? "disabled" : ""}>+</button></div>`;
    const csOdd = hg != null && ag != null ? m.cs?.[`${hg}-${ag}`] : null;
    extra = `<div class="cs">${stp("h", hg)}<span class="x">x</span>${stp("a", ag)}</div>${
      locked ? "" : hg == null ? `<div class="hint">Defina o placar: o vencedor sai dele.</div>` : csOdd ? `<div class="hint">Acertou o placar exato: <b>+${pts(csOdd - 1)}</b> (no lugar do vencedor). Errou o placar mas acertou o vencedor: <b>+${pts((m.odds_1x2?.[cur?.pick_1x2] ?? 1) - 1)}</b>.</div>` : `<div class="hint">Odd do placar ainda indisponível.</div>`
    }`;
  }
  const modeLabel = mode === "ou" ? "Gols" : mode === "cs" ? "Placar exato" : "Só o vencedor";
  const seg = locked
    ? `<span>${modeLabel}</span>`
    : `<div class="seg" role="group" aria-label="Palpite extra"><button aria-pressed="${mode === null}" data-act="mode" data-m="${m.id}" data-v="none">Só vencedor</button>${ex.ou ? `<button aria-pressed="${mode === "ou"}" data-act="mode" data-m="${m.id}" data-v="ou">Gols</button>` : ""}${ex.cs ? `<button aria-pressed="${mode === "cs"}" data-act="mode" data-m="${m.id}" data-v="cs">Placar exato</button>` : ""}</div>`;
  const showExtra = locked ? !!(ex.ou || ex.cs) || !!mode : ex.ou || ex.cs;
  const noOdds = !o1 && !locked ? `<div class="hint">Odds a caminho. Já dá para escolher o vencedor: os pontos usam a odd do início do jogo.</div>` : "";
  const mk = `<div class="mk"><div class="mk-l"><span>${mode === "cs" && !locked ? "Vencedor · definido pelo placar" : "Vencedor"}</span><span>${locked ? "odd congelada no início" : o1 ? `odd justa · congela às ${fmtClock(m.kickoff_utc)}` : "odds a caminho"}</span></div><div class="odds c3">${chips}</div>${noOdds}${showExtra ? `<div class="mk-l"><span>${ex.ou && ex.cs ? "Extra opcional: gols OU placar exato (só um)" : "Palpite extra (opcional)"}</span>${seg}</div>${extra}` : ""}</div>`;

  let foot;
  if (scored) {
    if (!mine) foot = `<span class="hint">Você não palpitou neste jogo.</span><span class="pts">0.00</span>`;
    else {
      const wOk = mine.pick_1x2 === real;
      const xOk = extraHit(m, mine);
      foot = `<span><span class="tick ${wOk ? "y" : "n"}">Vencedor ${wOk ? "✓" : "✗"}</span>${mine.mode ? ` · <span class="tick ${xOk ? "y" : "n"}">${mine.mode === "ou" ? "Gols" : "Placar"} ${xOk ? "✓" : "✗"}</span>` : ""}${mine.joker ? " · coringa" : ""}</span><span class="pts ${mine.points > 0 ? "pos" : ""}">${mine.points > 0 ? signed(mine.points) : "0.00"}</span>${mine.mode === "cs" && wOk && !xOk ? `<span class="hint" style="flex-basis:100%">Placar exato errado, mas o vencedor certo também conta.</span>` : ""}`;
    }
    foot += ``;
  } else if (locked) {
    foot = `<span>${mine ? "Palpite travado" : "Você não palpitou"}${mine?.joker ? " · coringa" : ""}</span><a data-link href="/jogo/${esc(m.id)}">Palpites de todos ›</a>`;
  } else {
    const err = S.errors[m.id];
    let status;
    if (err) status = `<span class="hint err">${esc(err)}</span>`;
    else if (dirty(m) && complete(d)) status = `<span><i class="st-dot pending"></i>Salvando…</span>`;
    else if (dirty(m)) status = `<span class="hint err"><i class="st-dot warn"></i>${d?.pick_1x2 ? (d.mode === "ou" ? "Falta escolher mais ou menos de 2,5 (ou toque em Só vencedor)" : "Falta o placar") : "Falta escolher o vencedor"}</span>`;
    else if (mine) status = o1 ? `<span><i class="st-dot"></i>Salvo · pode render <b class="num">+${pts(maxPoints(m, mine))}</b></span>` : `<span><i class="st-dot"></i>Salvo · a odd aparece quando chegar</span>`;
    else status = `<span class="hint">${ex.ou || ex.cs ? "Escolha o vencedor (o extra é opcional)" : "Escolha o vencedor"}</span>`;
    const jk = S.data.coringa.ativo ? `<button class="jk" data-act="joker" data-m="${m.id}" aria-pressed="${!!d?.joker}" ${!complete(d) ? "disabled" : ""} title="Vale ×${S.data.coringa.multiplicador} neste jogo. Um por rodada.">${d?.joker ? `Coringa ×${S.data.coringa.multiplicador}` : "Usar coringa"}</button>` : "";
    foot = `${status}${jk}`;
  }
  return `<div class="ev">${top}${teams}${mk}<div class="ev-f">${foot}</div></div>`;
}
