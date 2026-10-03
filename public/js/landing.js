// Página de entrada para quem ainda não entrou (hero "Ao vivo", opção C do design): escolha 1, X ou 2 e veja o ganho.
const ODDS = { 1: 2.49, X: 3.82, 2: 2.97 };
const LABEL = { 1: "1 · Casa", X: "X · Empate", 2: "2 · Fora" };
const FEATURES = ["Vencedor (1X2)", "Mais ou menos de 2,5 gols", "Placar exato", "Coringa ×2", "Odds congeladas no apito", "Ranking de sequência", "Maior zebra vista", "Perguntas do dia", "Aviso no iPhone"];

const shield = (txt, hue) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 21 4v7.5c0 5.5-3.9 9.6-9 11-5.1-1.4-9-5.5-9-11V4z" fill="hsl(${hue})"/><text x="12" y="15" text-anchor="middle" font-family="Saira Condensed,sans-serif" font-size="7.5" font-weight="700" fill="#fff">${txt}</text></svg>`;

export function renderLanding(view) {
  document.title = "Bolão · palpite com os amigos";
  const S = { pick: "2", joker: false, shown: ODDS[2] - 1, raf: 0 };
  const ticker = [...FEATURES, ...FEATURES].map((t) => `<span class="lp-chip">${t}</span>`).join("");
  view.innerHTML = `
  <div class="lp">
    <div class="lp-field" aria-hidden="true"><i class="c"></i><i class="l"></i><i class="d"></i></div>
    <div class="lp-in">
      <header class="lp-top">
        <div class="lp-logo"><img src="/icons/ball-64.png" alt="" width="30" height="30">BOLÃO</div>
        <a class="lp-ghost" data-link href="/entrar">Entrar</a>
      </header>

      <section class="lp-hero">
        <div class="lp-pill r1"><i class="beat"></i>Palpite até o apito</div>
        <h1 class="r2">Quem ganha hoje?</h1>
        <p class="r3">Escolha o vencedor e veja na hora quanto você ganha. Cada acerto vale o lucro da odd, e o ranking mostra quem está na frente.</p>

        <div class="lp-stage r4">
          <span class="lp-crest f1" style="left:-8px;top:-30px">${shield("BAR", "345 45% 36%")}</span>
          <span class="lp-crest f2" style="right:-8px;top:-26px">${shield("BAY", "0 55% 40%")}</span>
          <span class="lp-crest sm f3" style="left:-4px;bottom:-24px">${shield("COR", "30 30% 28%")}</span>
          <span class="lp-crest sm f4" style="right:-4px;bottom:-22px">${shield("PSG", "215 45% 36%")}</span>
          <div class="lp-card">
            <div class="lp-row"><span>Monte um palpite de exemplo</span><span class="lp-tag">Exemplo</span></div>
            <div class="lp-match"><span>Barcelona</span><small>x</small><span>Bayern</span></div>
            <div class="lp-odds">${["1", "X", "2"].map((k) => `<button class="lp-odd" data-k="${k}" aria-pressed="${k === S.pick}"><small>${LABEL[k]}</small><b>${ODDS[k].toFixed(2)}</b></button>`).join("")}</div>
            <div class="lp-foot">
              <button class="lp-joker" data-joker aria-pressed="false">Coringa ×2</button>
              <div class="lp-gain"><span>Se acertar</span><b data-gain>+${S.shown.toFixed(2)}</b></div>
            </div>
            <div class="lp-why" data-why>lucro da odd justa: ${ODDS[2].toFixed(2)} − 1</div>
          </div>
        </div>

        <div class="lp-ctas r4">
          <a class="lp-cta" data-link href="/cadastro">Criar conta e palpitar</a>
          <a class="lp-ghost lg" href="#como">Como funciona</a>
        </div>
      </section>
    </div>

    <div class="lp-ticker" aria-hidden="true"><div class="tick">${ticker}</div></div>

    <section class="lp-how" id="como">
      <h2>Como funciona</h2>
      <ol>
        <li><b>Crie sua conta</b><span>E-mail, telefone e senha. Leva um minuto.</span></li>
        <li><b>Palpite o vencedor</b><span>Se quiser, some um extra: mais ou menos de 2,5 gols, ou o placar exato.</span></li>
        <li><b>As odds congelam no apito</b><span>Dá para mudar o palpite até o jogo começar. Depois, tudo trava.</span></li>
        <li><b>Suba no ranking</b><span>Acertou? Ganha o lucro da odd (odd − 1). Errou, zero. Desempate: mais acertos.</span></li>
      </ol>
      <p class="lp-note">Sem pagamentos no site: o dinheiro é combinado entre vocês. Os palpites dos outros só aparecem quando o jogo começa.</p>
      <div class="lp-ctas"><a class="lp-cta" data-link href="/cadastro">Criar conta</a><a class="lp-ghost lg" data-link href="/entrar">Já tenho conta</a></div>
    </section>
  </div>`;

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gainEl = view.querySelector("[data-gain]");
  const whyEl = view.querySelector("[data-why]");
  const update = () => {
    const to = (ODDS[S.pick] - 1) * (S.joker ? 2 : 1);
    const from = S.shown;
    cancelAnimationFrame(S.raf);
    const t0 = performance.now();
    const step = (t) => {
      const k = reduce ? 1 : Math.min(1, (t - t0) / 450);
      S.shown = from + (to - from) * (1 - Math.pow(1 - k, 3));
      gainEl.textContent = `+${S.shown.toFixed(2)}`;
      if (k < 1) S.raf = requestAnimationFrame(step);
    };
    S.raf = requestAnimationFrame(step);
    whyEl.textContent = `lucro da odd justa: ${ODDS[S.pick].toFixed(2)} − 1${S.joker ? ", vezes 2 do coringa" : ""}`;
  };
  view.querySelectorAll(".lp-odd").forEach((b) => {
    b.onclick = () => {
      S.pick = b.dataset.k;
      view.querySelectorAll(".lp-odd").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      update();
    };
  });
  const jk = view.querySelector("[data-joker]");
  jk.onclick = () => {
    S.joker = !S.joker;
    jk.setAttribute("aria-pressed", String(S.joker));
    update();
  };
  view.querySelector('a[href="#como"]').onclick = (e) => {
    e.preventDefault();
    view.querySelector("#como").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  };
  return () => cancelAnimationFrame(S.raf);
}
