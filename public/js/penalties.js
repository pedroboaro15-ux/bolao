import { esc, openSheet } from "./util.js";

/**
 * Disputa de pênaltis animada (só visual; o resultado já vem pronto do servidor).
 * Palco em % para escalar no celular: gol com rede, goleiro e bola. Cada cobrança: corrida da bola,
 * pulo do goleiro, e no gol a rede balança; na defesa a bola volta; fora passa por cima/ao lado da trave.
 */
const X = { esq: 22, meio: 50, dir: 78 }; // % da largura do palco
const Y = { cima: 22, meio: 38, baixo: 53 }; // % da altura
const FORA = { esq: [6, 30], meio: [50, 4], dir: [94, 30] };
const DIVE = { esq: -1, meio: 0, dir: 1 };
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const GOAL_SVG = `<svg class="pk-goal" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
  <defs><pattern id="pk-net" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <path d="M0 0H3.2M0 0V3.2" stroke="currentColor" stroke-width=".35" fill="none"/></pattern></defs>
  <g class="pk-net"><path d="M12 12 L18 6 H82 L88 12 V58 H12 Z" fill="url(#pk-net)" opacity=".55"/></g>
  <path d="M12 58 V12 H88 V58" fill="none" stroke="var(--pk-post)" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M0 58.6 H100" stroke="var(--pk-line)" stroke-width=".6"/>
</svg>`;

export function openShootout(t) {
  const p = t.pens;
  const names = { a: t.a_nick ?? "?", b: t.b_nick ?? "?" };
  const s = openSheet(`
    <h2 class="section-title" style="margin-top:0">Pênaltis</h2>
    <div class="pk-score">
      <div class="pk-side" data-s="a"><b>${esc(names.a)}</b><span class="pk-dots"></span></div>
      <div class="pk-num num"><span data-n="a">0</span> x <span data-n="b">0</span></div>
      <div class="pk-side r" data-s="b"><b>${esc(names.b)}</b><span class="pk-dots"></span></div>
    </div>
    <div class="pk-stage">
      ${GOAL_SVG}
      <div class="pk-keeper"><i></i></div>
      <div class="pk-spot"></div>
      <img class="pk-ball" src="/icons/soccerball.svg" alt="">
      <div class="pk-msg" aria-live="polite"></div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Gols e lucro empatados: a vaga saiu numa disputa sorteada. Chute para fora: 8%. Goleiro no canto e na altura certos: defende 90%; só no canto: 25%.</p>
    <div class="actions"><button class="btn" data-skip>Pular</button><button class="btn primary" data-close>Fechar</button></div>`);
  const el = s.el;
  const ball = el.querySelector(".pk-ball");
  const keeper = el.querySelector(".pk-keeper");
  const net = el.querySelector(".pk-net");
  const msg = el.querySelector(".pk-msg");
  const score = { a: 0, b: 0 };
  let skip = false;

  const mark = (k) => {
    if (k.result === "gol") score[k.by]++;
    el.querySelector(`[data-n="${k.by}"]`).textContent = score[k.by];
    el.querySelector(`[data-s="${k.by}"] .pk-dots`).insertAdjacentHTML("beforeend", `<i class="${k.result === "gol" ? "ok" : "no"}" title="${k.result}"></i>`);
  };
  const finish = () => {
    msg.textContent = `Passa ${t.winner_nick ?? ""}`;
    msg.className = "pk-msg show";
  };
  el.querySelector("[data-skip]").onclick = (e) => {
    skip = true;
    e.target.remove();
  };

  const run = async () => {
    for (let i = 0; i < p.kicks.length; i++) {
      if (!el.isConnected) return;
      const k = p.kicks[i];
      if (skip || reduce) {
        mark(k);
        continue;
      }
      msg.className = "pk-msg";
      msg.textContent = `${names[k.by]} bate`;
      msg.classList.add("show");
      ball.getAnimations().forEach((a) => a.cancel());
      keeper.getAnimations().forEach((a) => a.cancel());
      net.getAnimations().forEach((a) => a.cancel());
      await wait(650);
      msg.classList.remove("show");

      const [tx, ty] = k.result === "fora" ? FORA[k.aim.col] : [X[k.aim.col], Y[k.aim.row]];
      const dx = DIVE[k.dive.col];
      const ky = k.dive.row === "cima" ? -16 : k.dive.row === "baixo" ? 6 : -4;
      keeper.animate(
        [{ transform: "translate(-50%,0) rotate(0)" }, { transform: `translate(calc(-50% + ${dx * 120}%), ${ky}%) rotate(${dx * (k.dive.row === "baixo" ? 80 : 60)}deg)` }],
        { duration: 420, delay: 120, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
      );
      const fly = ball.animate(
        [
          { left: "50%", top: "86%", transform: "translate(-50%,-50%) scale(1) rotate(0)" },
          { left: `${tx}%`, top: `${ty}%`, transform: "translate(-50%,-50%) scale(.55) rotate(540deg)" },
        ],
        { duration: 520, easing: "cubic-bezier(.15,.6,.35,1)", fill: "forwards" },
      );
      await fly.finished.catch(() => {});
      if (k.result === "gol") {
        net.animate([{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-1.5px) scale(1.035,1.05)" }, { transform: "none" }], { duration: 380, easing: "ease-out" });
        ball.animate([{ transform: "translate(-50%,-50%) scale(.55)" }, { transform: "translate(-50%,-30%) scale(.5)" }], { duration: 300, fill: "forwards" });
      } else if (k.result === "defesa") {
        ball.animate(
          [{ left: `${tx}%`, top: `${ty}%`, transform: "translate(-50%,-50%) scale(.55)" }, { left: `${50 + (tx - 50) * 0.4}%`, top: "78%", transform: "translate(-50%,-50%) scale(.8) rotate(-300deg)" }],
          { duration: 480, easing: "cubic-bezier(.3,.6,.4,1)", fill: "forwards" },
        );
      }
      msg.textContent = { gol: "Gol!", defesa: "Defendeu!", fora: "Pra fora!" }[k.result];
      msg.className = `pk-msg show ${k.result}`;
      mark(k);
      await wait(1000);
    }
    finish();
    el.querySelector("[data-skip]")?.remove();
  };
  run();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
