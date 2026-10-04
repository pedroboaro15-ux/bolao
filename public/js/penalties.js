import { api, esc, openSheet, toast } from "./util.js";

/**
 * Disputa de pênaltis animada (só visual; o resultado já vem pronto do servidor).
 * Duas opções de defesa para comparar: "luva" (uma luva vai até o canto) e "x" (um X vermelho onde a bola parou).
 * A rede é uma malha de pontos com integração de Verlet: cada ponto tem profundidade (z), os vizinhos puxam uns
 * aos outros e as bordas ficam presas na trave; a bola empurra os pontos, perde velocidade e cai dentro do gol.
 */
const X = { esq: 22, meio: 50, dir: 78 }; // % da largura do palco
const Y = { cima: 22, meio: 38, baixo: 53 }; // % da altura
const FORA = { esq: [6, 30], meio: [50, 4], dir: [94, 30] };
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STYLE_KEY = "pk-style";

// gol no SVG/canvas: viewBox 100 x 64, ocupando top 4% e 60% da altura do palco
const toNet = (sx, sy) => [sx, ((sy - 4) * 64) / 60];
const toStage = (nx, ny) => [nx, 4 + (ny * 60) / 64];
const NET = { x0: 12, x1: 88, y0: 12, y1: 58, nx: 20, ny: 12 };
const PERSP = 0.11; // quanto a profundidade "afunda" o ponto em direção ao fundo do gol
const VP = [50, 30]; // ponto de fuga

const GOAL_SVG = `<svg class="pk-goal" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
  <path d="M12 58 V12 H88 V58" fill="none" stroke="var(--pk-post)" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M0 58.6 H100" stroke="var(--pk-line)" stroke-width=".6"/>
</svg>`;

const GLOVE_SVG = `<svg viewBox="0 0 40 48" aria-hidden="true"><g stroke="#0d1b33" stroke-width="1.6" stroke-linejoin="round">
  <rect x="8" y="38" width="22" height="9" rx="2.5" fill="var(--pk-cuff)"/>
  <path d="M8 39 V20 Q8 16 11.5 16 Q15 16 15 20 V7 Q15 3 18.5 3 Q22 3 22 7 V5.5 Q22 2 25.5 2 Q29 2 29 5.5 V9 Q29 6 32 6 Q35 6 35 9.5 V27 Q35 34 30 39 Z" fill="#fff"/>
  <path d="M8 30 Q2 27 2.5 21 Q3 17 6.5 18 L8 24" fill="#fff"/>
  <path d="M15 20 V27 M22 9 V27 M29 9 V27" fill="none" stroke-width="1"/></g></svg>`;

/** Malha da rede: pontos com profundidade z (Verlet), presos nas bordas. */
function makeNet(canvas) {
  const { x0, x1, y0, y1, nx, ny } = NET;
  const pts = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const pin = i === 0 || i === nx || j === 0 || j === ny;
      pts.push({ x: x0 + ((x1 - x0) * i) / nx, y: y0 + ((y1 - y0) * j) / ny, z: 0, pz: 0, pin });
    }
  const at = (i, j) => pts[j * (nx + 1) + i];
  const links = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    if (i < nx) links.push([at(i, j), at(i + 1, j)]);
    if (j < ny) links.push([at(i, j), at(i, j + 1)]);
  }
  const ctx = canvas.getContext("2d");
  const proj = (p) => {
    const s = 1 / (1 + p.z * PERSP);
    return [VP[0] + (p.x - VP[0]) * s, VP[1] + (p.y - VP[1]) * s];
  };
  const step = (ball) => {
    for (const p of pts) {
      if (p.pin) continue;
      const v = (p.z - p.pz) * 0.97; // amortecimento
      p.pz = p.z;
      p.z += v;
    }
    for (let k = 0; k < 4; k++) {
      for (const [a, b] of links) {
        // mola: vizinhos tendem à mesma profundidade (a malha é esticada na trave)
        const d = (b.z - a.z) * 0.25;
        if (!a.pin) a.z += d;
        if (!b.pin) b.z -= d;
      }
      if (ball) {
        // a bola é uma esfera: os pontos perto dela não podem ficar "na frente" dela
        for (const p of pts) {
          if (p.pin) continue;
          const r2 = (p.x - ball.x) ** 2 + (p.y - ball.y) ** 2;
          if (r2 > 30) continue;
          const minZ = ball.z - r2 * 0.12;
          if (p.z < minZ) {
            ball.push += minZ - p.z;
            p.z = minZ;
          }
        }
      }
    }
  };
  const draw = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) (canvas.width = Math.round(w * dpr)), (canvas.height = Math.round(h * dpr));
    ctx.setTransform((canvas.width / 100), 0, 0, canvas.height / 64, 0, 0);
    ctx.clearRect(0, 0, 100, 64);
    ctx.lineWidth = 0.28;
    for (const [a, b] of links) {
      const depth = Math.min(1, (a.z + b.z) / 30);
      ctx.strokeStyle = `rgba(255,255,255,${0.42 - depth * 0.2})`;
      const [ax, ay] = proj(a), [bx, by] = proj(b);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  };
  const energy = () => pts.reduce((s, p) => s + Math.abs(p.z) + Math.abs(p.z - p.pz) * 10, 0);
  return { step, draw, energy, proj };
}

export function openShootout(t) {
  const p = t.pens;
  const names = { a: t.a_nick ?? "?", b: t.b_nick ?? "?" };
  let style = "luva";
  try { style = localStorage.getItem(STYLE_KEY) === "x" ? "x" : "luva"; } catch {}
  const s = openSheet(`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <h2 class="section-title" style="margin:0">Pênaltis</h2>
      <div class="seg" role="group" aria-label="Defesa"><button data-style="luva" aria-pressed="${style === "luva"}">Luva</button><button data-style="x" aria-pressed="${style === "x"}">X</button></div>
    </div>
    <div class="pk-score" style="margin-top:10px">
      <div class="pk-side" data-s="a"><b>${esc(names.a)}</b><span class="pk-dots"></span></div>
      <div class="pk-num num"><span data-n="a">0</span> x <span data-n="b">0</span></div>
      <div class="pk-side r" data-s="b"><b>${esc(names.b)}</b><span class="pk-dots"></span></div>
    </div>
    <div class="pk-stage">
      <canvas class="pk-net"></canvas>
      ${GOAL_SVG}
      <div class="pk-glove">${GLOVE_SVG}</div>
      <div class="pk-x" aria-hidden="true"></div>
      <div class="pk-spot"></div>
      <img class="pk-ball" src="/icons/soccerball.svg" alt="">
      <div class="pk-msg" aria-live="polite"></div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Chute para fora: 8%. Goleiro no canto e na altura certos: defende 90%; só no canto: 25%.</p>
    <div class="actions"><button class="btn" data-skip>Pular</button><button class="btn" data-again>Ver de novo</button><button class="btn primary" data-close>Fechar</button></div>`);
  const el = s.el;
  const stage = el.querySelector(".pk-stage");
  const ball = el.querySelector(".pk-ball");
  const glove = el.querySelector(".pk-glove");
  const xMark = el.querySelector(".pk-x");
  const msg = el.querySelector(".pk-msg");
  const net = makeNet(el.querySelector(".pk-net"));
  let score, skip, runId = 0;
  const setStyle = (v) => {
    style = v;
    stage.dataset.style = v;
    el.querySelectorAll("[data-style]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.style === v)));
    try { localStorage.setItem(STYLE_KEY, v); } catch {}
  };
  setStyle(style);

  // laço da física: roda só enquanto a rede mexe ou a bola está nela
  let netBall = null, looping = false;
  const loop = () => {
    if (!el.isConnected) return (looping = false);
    if (netBall) {
      const b = netBall;
      b.push = 0;
      b.z += b.vz;
      net.step(b);
      b.vz = Math.max(-0.2, b.vz - b.push * 0.05 - 0.01);
      if (b.vz <= 0.05) (b.vy += 0.035), (b.y = Math.min(NET.y1 - 2.2, b.y + b.vy)); // perdeu força: cai dentro do gol
      b.z = Math.max(0, b.z);
      const [px, py] = net.proj(b);
      const [sx, sy] = toStage(px, py);
      ball.style.left = `${sx}%`;
      ball.style.top = `${sy}%`;
      ball.style.transform = `translate(-50%,-50%) scale(${0.55 / (1 + b.z * PERSP)})`;
    } else net.step(null);
    net.draw();
    if (netBall || net.energy() > 0.5) requestAnimationFrame(loop);
    else looping = false;
  };
  const kickLoop = () => {
    if (!looping) (looping = true), requestAnimationFrame(loop);
  };
  net.draw();

  const mark = (k) => {
    if (k.result === "gol") score[k.by]++;
    el.querySelector(`[data-n="${k.by}"]`).textContent = score[k.by];
    el.querySelector(`[data-s="${k.by}"] .pk-dots`).insertAdjacentHTML("beforeend", `<i class="${k.result === "gol" ? "ok" : "no"}" title="${k.result}"></i>`);
  };
  const reset = () => {
    for (const e of [ball, glove, xMark]) e.getAnimations().forEach((a) => a.cancel());
    netBall = null;
    ball.style.cssText = "";
    xMark.classList.remove("show");
  };

  const run = async () => {
    const id = ++runId;
    score = { a: 0, b: 0 };
    skip = false;
    el.querySelectorAll(".pk-dots").forEach((d) => (d.innerHTML = ""));
    el.querySelectorAll("[data-n]").forEach((d) => (d.textContent = "0"));
    el.querySelector("[data-skip]").style.display = "";
    for (let i = 0; i < p.kicks.length; i++) {
      if (!el.isConnected || id !== runId) return;
      const k = p.kicks[i];
      if (skip || reduce) {
        mark(k);
        continue;
      }
      reset();
      msg.className = "pk-msg show";
      msg.textContent = `${names[k.by]} bate`;
      await wait(650);
      if (id !== runId) return;
      msg.className = "pk-msg";

      const [tx, ty] = k.result === "fora" ? FORA[k.aim.col] : [X[k.aim.col], Y[k.aim.row]];
      // luva: vai para o canto escolhido pelo goleiro; na defesa, vai exatamente na bola
      const [gx, gy] = k.result === "defesa" ? [tx, ty] : [X[k.dive.col], Y[k.dive.row]];
      const tilt = { esq: -35, meio: 0, dir: 35 }[k.dive.col];
      if (style === "luva")
        glove.animate(
          [{ left: "50%", top: "40%", opacity: 0, transform: "translate(-50%,-50%) scale(.6) rotate(0)" }, { left: `${gx}%`, top: `${gy}%`, opacity: 1, transform: `translate(-50%,-50%) scale(1) rotate(${tilt}deg)` }],
          { duration: 380, delay: 140, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" },
        );
      const fly = ball.animate(
        [
          { left: "50%", top: "86%", transform: "translate(-50%,-50%) scale(1) rotate(0)" },
          { left: `${tx}%`, top: `${ty}%`, transform: "translate(-50%,-50%) scale(.55) rotate(540deg)" },
        ],
        { duration: 520, easing: "cubic-bezier(.15,.6,.35,1)", fill: "forwards" },
      );
      await fly.finished.catch(() => {});
      if (id !== runId) return;
      if (k.result === "gol") {
        // a bola entra na malha e estufa a rede
        fly.commitStyles?.();
        fly.cancel();
        const [bx, by] = toNet(tx, ty);
        netBall = { x: bx, y: by, z: 0, vz: 2.2, vy: 0, push: 0 };
        kickLoop();
        setTimeout(() => (netBall = null), 900);
      } else if (k.result === "defesa") {
        if (style === "luva") {
          glove.animate([{ transform: `translate(-50%,-50%) scale(1) rotate(${tilt}deg)` }, { transform: `translate(-50%,-50%) scale(1.12) rotate(${tilt}deg)` }, { transform: `translate(-50%,-50%) scale(1) rotate(${tilt}deg)` }], { duration: 220 });
          ball.animate(
            [{ left: `${tx}%`, top: `${ty}%`, transform: "translate(-50%,-50%) scale(.55)" }, { left: `${50 + (tx - 50) * 1.6}%`, top: "80%", transform: "translate(-50%,-50%) scale(.85) rotate(-300deg)" }],
            { duration: 520, easing: "cubic-bezier(.3,.6,.4,1)", fill: "forwards" },
          );
        } else {
          xMark.style.left = `${tx}%`;
          xMark.style.top = `${ty}%`;
          xMark.classList.add("show");
          ball.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 250, fill: "forwards" });
        }
      }
      msg.textContent = { gol: "Gol!", defesa: "Defendeu!", fora: "Pra fora!" }[k.result];
      msg.className = `pk-msg show ${k.result}`;
      mark(k);
      await wait(1300);
    }
    if (id !== runId) return;
    msg.textContent = `Passa ${t.winner_nick ?? ""}`;
    msg.className = "pk-msg show";
    el.querySelector("[data-skip]").style.display = "none";
  };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-style],[data-skip],[data-again]");
    if (!b) return;
    if (b.dataset.style) setStyle(b.dataset.style);
    else if (b.hasAttribute("data-skip")) skip = true;
    else (reset(), run());
  });
  run();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- palpite dos pênaltis ----------

const COLS = ["esq", "meio", "dir"];
const ROWS = ["cima", "meio", "baixo"];
const PICKS = 10;
const ordinal = (i) => (i < 5 ? `${i + 1}ª cobrança` : `${i + 1}ª · alternada`);

/** Escolha de chute e pulo, cobrança a cobrança. O que ficar vazio, a máquina sorteia no fim do prazo. */
export function openPicker(t, campId, onSaved) {
  const mine = t.meu ?? { aims: [], dives: [] };
  const pick = { aims: Array.from({ length: PICKS }, (_, i) => mine.aims?.[i] ?? null), dives: Array.from({ length: PICKS }, (_, i) => mine.dives?.[i] ?? null) };
  const grid = (kind, i) => `<div class="pk-pick" role="group" aria-label="${kind === "aims" ? "Chute" : "Pulo"} da ${ordinal(i)}">${ROWS.map((r) => COLS.map((c) => `<button type="button" data-k="${kind}" data-i="${i}" data-c="${c}" data-r="${r}" aria-label="${r} ${c}"></button>`).join("")).join("")}</div>`;
  const s = openSheet(`
    <h2 class="section-title" style="margin-top:0">Seus pênaltis</h2>
    <p class="muted" style="font-size:13px;margin-top:0">${t.deadline ? `Até ${esc(new Date(t.deadline).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }))}.` : "O prazo será definido pelo admin."} Toque onde você chuta e para onde pula em cada cobrança. O que ficar em branco, a máquina sorteia.</p>
    <div class="pk-pick-head"><span></span><b>Você chuta</b><b>Você pula</b></div>
    ${Array.from({ length: PICKS }, (_, i) => `<div class="pk-pick-row"><span>${ordinal(i)}</span>${grid("aims", i)}${grid("dives", i)}</div>`).join("")}
    <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn primary" data-save>Salvar pênaltis</button></div>`);
  const paint = () =>
    s.el.querySelectorAll(".pk-pick button").forEach((b) => {
      const v = pick[b.dataset.k][b.dataset.i];
      b.setAttribute("aria-pressed", String(!!v && v.col === b.dataset.c && v.row === b.dataset.r));
    });
  paint();
  s.el.addEventListener("click", async (e) => {
    const b = e.target.closest(".pk-pick button");
    if (b) {
      const cur = pick[b.dataset.k][b.dataset.i];
      pick[b.dataset.k][b.dataset.i] = cur && cur.col === b.dataset.c && cur.row === b.dataset.r ? null : { col: b.dataset.c, row: b.dataset.r };
      return paint();
    }
    const save = e.target.closest("[data-save]");
    if (!save) return;
    save.disabled = true;
    try {
      await api(`/campeonatos/${encodeURIComponent(campId)}/penaltis/${encodeURIComponent(t.sid)}`, { method: "PUT", body: pick });
      toast("Pênaltis salvos");
      s.close();
      onSaved?.();
    } catch (err) {
      toast(err.message, "err");
      save.disabled = false;
    }
  });
}

/** Admin: prazo para palpitar (anunciado no WhatsApp). */
export function openDeadline(t, campId, onSaved) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = t.deadline ? new Date(t.deadline) : null;
  const val = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
  const s = openSheet(`
    <h2 class="section-title" style="margin-top:0">Prazo dos pênaltis</h2>
    <p class="muted" style="font-size:13px;margin-top:0">${esc(t.a_nick)} x ${esc(t.b_nick)}. Até essa hora os dois escolhem os chutes e pulos; depois a máquina completa o que faltar e a disputa sai.</p>
    <label class="f">Palpites até<input type="datetime-local" name="prazo" value="${val}"></label>
    <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn" data-clear>Sem prazo</button><button class="btn primary" data-save>Salvar</button></div>`);
  s.el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-save],[data-clear]");
    if (!b) return;
    const v = s.el.querySelector("[name=prazo]").value;
    if (b.hasAttribute("data-save") && !v) return toast("Escolha a data e a hora", "err");
    try {
      await api(`/admin/campeonatos/${encodeURIComponent(campId)}/penaltis/${encodeURIComponent(t.sid)}/prazo`, { method: "PUT", body: { deadline: b.hasAttribute("data-save") ? new Date(v).toISOString() : null } });
      toast("Prazo salvo");
      s.close();
      onSaved?.();
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

/** Exemplo com as mesmas regras (sorteado aqui no aparelho), para ver a animação. */
export function openExample() {
  const r = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const spot = () => ({ col: COLS[Math.floor(r() * 3)], row: ROWS[Math.floor(r() * 3)] });
  const kick = (by) => {
    const aim = spot(), dive = spot();
    let result = "gol";
    if (r() < 0.08) result = "fora";
    else if (dive.col === aim.col && r() < (dive.row === aim.row ? 0.9 : 0.25)) result = "defesa";
    return { by, aim, dive, result };
  };
  const kicks = [];
  let a = 0, b = 0, done = false;
  for (let i = 0; i < 5 && !done; i++)
    for (const by of ["a", "b"]) {
      const k = kick(by);
      kicks.push(k);
      if (k.result === "gol") by === "a" ? a++ : b++;
      if (a > b + 5 - (by === "b" ? i + 1 : i) || b > a + 4 - i) { done = true; break; }
    }
  while (!done && a === b) {
    const ka = kick("a"), kb = kick("b");
    kicks.push(ka, kb);
    a += ka.result === "gol";
    b += kb.result === "gol";
  }
  openShootout({ a_nick: "Mandante", b_nick: "Visitante", winner_nick: a > b ? "Mandante" : "Visitante", pens: { by: "cobranças", a, b, kicks } });
}
