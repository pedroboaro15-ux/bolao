// Página de entrada para quem ainda não entrou: hero "no padrão do site" + "Como funciona" (passo a passo e exemplos de pontos).
// Usa os tokens do styles.css, então acompanha o tema claro/escuro do resto do site.
import { esc } from "./util.js";

const ODDS = { 1: 2.49, X: 3.82, 2: 2.97 };
const LABEL = { 1: "Casa", X: "Empate", 2: "Fora" };

/** Exemplos com o mesmo jogo: Casa 1 x 2 Fora (3 gols). */
const EXEMPLOS = [
  { titulo: "Acertou tudo", palpite: "Fora + Mais de 2,5", conta: "vencedor 2,97 − 1 = 1,97 · gols 1,83 − 1 = 0,83", pts: "+2,80", tipo: "ok" },
  { titulo: "Acertou um", palpite: "Fora + Menos de 2,5", conta: "vencedor certo (+1,97) · gols errado (0)", pts: "+1,97", tipo: "ok" },
  { titulo: "Errou tudo", palpite: "Casa + Menos de 2,5", conta: "nada certo, nada perdido: só não soma", pts: "0,00", tipo: "zero" },
  { titulo: "Cravou o placar", palpite: "Placar 1 x 2", conta: "placar exato 9,50 − 1 = 8,50 (vale no lugar do vencedor)", pts: "+8,50", tipo: "ok" },
  { titulo: "Placar errado, vencedor certo", palpite: "Placar 0 x 1", conta: "o placar não bateu, mas o Fora venceu: vale o vencedor", pts: "+1,97", tipo: "ok" },
];

export function renderLanding(view) {
  document.title = "Bolão · palpite com os amigos";
  const S = { pick: "2" };
  view.innerHTML = `
  <div class="hs">
    <header class="hs-bar">
      <a class="brand" data-link href="/"><img src="/icons/soccerball.svg" alt="" width="26" height="26">BOLÃO</a>
      <span style="flex:1"></span>
      <a class="hs-enter" data-link href="/entrar">Entrar</a>
    </header>

    <section class="hs-hero">
      <div class="hs-wm" aria-hidden="true">1X2</div>
      <div class="hs-kicker">Bolão entre amigos · de graça</div>
      <h1>Palpite nos jogos do dia e prove no ranking.</h1>
      <p>Quem entende mais de futebol? Escolha quem ganha, cada acerto vale o lucro da odd, e o ranking não deixa ninguém mentir.</p>
    </section>

    <div class="hs-body">
      <div class="summary hs-sum">
        <div><small>Jogos por dia</small><b>4 a 10</b></div>
        <div><small>Palpite</small><b>antes da bola rolar</b></div>
        <div><small>Custa</small><b>R$ 0</b></div>
      </div>

      <div class="card hs-game">
        <div class="hs-game-h"><b>Brasileirão Série A</b><span class="muted">exemplo</span></div>
        <div class="hs-game-b">
          <div class="hs-row muted"><span>Final · 90 min</span><span class="hs-open">Encerrado</span></div>
          <div class="hs-teams"><span><img class="hs-crest" src="/icons/escudo-gremio.svg" alt="" width="26" height="26">Grêmio<b>10</b></span><span><img class="hs-crest hs-flip" src="/icons/escudo-inter-rosa.svg" alt="" width="26" height="26">Inter<b>0</b></span></div>
          <div class="hs-row muted"><span>Vencedor · toque para testar</span><span>odd justa</span></div>
          <div class="odds c3">${["1", "X", "2"].map((k) => `<button class="odd" data-k="${k}" aria-pressed="${k === S.pick}" aria-label="${LABEL[k]}, odd ${ODDS[k].toFixed(2)}"><span>${k}</span><b>${ODDS[k].toFixed(2)}</b></button>`).join("")}</div>
          <div class="hint" data-gain></div>
        </div>
      </div>

      <div class="hs-ctas">
        <a class="btn primary block" data-link href="/cadastro">Criar conta</a>
        <a class="btn block" href="#como">Como funciona</a>
      </div>

      <div class="card hs-list">
        <div><span>Obrigatório</span><b>Quem ganha (1X2)</b></div>
        <div><span>Extra</span><b>Gols ou placar exato</b></div>
        <div><span>Ponto</span><b>odd − 1</b></div>
        <div><span>Ranking</span><b>Rodada · mês · geral</b></div>
      </div>

      <section id="como" class="hs-how">
        <div class="hs-kicker">Como funciona</div>
        <h2>4 passos. Zero dinheiro no site.</h2>
        <p class="muted">É uma brincadeira entre amigos pra ver quem tem a melhor previsão. Qualquer um pode entrar.</p>

        <ol class="hs-steps">
          <li class="card">
            <div class="hs-step-h"><span class="hs-n">01</span><b>Escolha quem ganha</b></div>
            <p>Casa, empate ou fora. É o básico de todo jogo. Às vezes o admin pede também os gols, e aí isso vem escrito na rodada.</p>
          </li>
          <li class="card">
            <div class="hs-step-h"><span class="hs-n">02</span><b>Quer arriscar mais? Um extra</b></div>
            <p><b>Gols:</b> "Mais de 2,5" é jogo com 3 gols ou mais (somando os dois times); "Menos de 2,5" é 2 gols ou menos.<br><b>Placar exato:</b> cravar 2 a 1, 1 a 0... Se acertar, já acertou quem ganhou, então ele vale <b>no lugar</b> do vencedor.<br>É gols <b>ou</b> placar, nunca os dois.</p>
          </li>
          <li class="card">
            <div class="hs-step-h"><span class="hs-n">03</span><b>A odd vira ponto</b></div>
            <p>Odd é um multiplicador da chance de acontecer: quanto mais improvável, maior. Acertou? Ganha o <b>lucro</b>: odd − 1 (odd 2,97 vale +1,97). Zebra paga mais.</p>
            <p>A odd <b>congela no apito</b>: depois que a bola rola, saiu um gol e a odd despenca. Vale a do início do jogo.</p>
          </li>
          <li class="card">
            <div class="hs-step-h"><span class="hs-n">04</span><b>Suba no ranking</b></div>
            <p>Rodada, mês e geral. Empatou nos pontos? Empatou na posição: ninguém fica pra trás por detalhe.</p>
          </li>
        </ol>

        <h3 class="hs-sub">Na prática: Casa 1 x 2 Fora</h3>
        <p class="muted" style="margin-top:0">Odds do exemplo: Fora 2,97 · Mais de 2,5 1,83 · placar 1 x 2 9,50.</p>
        <div class="card hs-examples">${EXEMPLOS.map(
          (e) => `<div class="hs-ex"><div><b>${esc(e.titulo)}</b><div class="muted">${esc(e.palpite)}</div><small class="muted">${esc(e.conta)}</small></div><span class="hs-pts ${e.tipo}">${esc(e.pts)}</span></div>`,
        ).join("")}</div>

        <div class="card hs-list">
          <div><span>Mudar o palpite</span><b>até o jogo começar</b></div>
          <div><span>Esqueceu um jogo?</span><b>tudo bem, só não pontua</b></div>
          <div><span>Palpite dos outros</span><b>aparece quando a bola rola</b></div>
          <div><span>Jogo adiado ou cancelado</span><b>sai da rodada</b></div>
          <div><span>Maior zebra</span><b>a odd mais alta acertada</b></div>
          <div><span>Prêmio</span><b>só se a competição definir</b></div>
        </div>

        <div class="hs-ctas">
          <a class="btn primary block" data-link href="/cadastro">Criar conta</a>
          <a class="btn block" data-link href="/entrar">Já tenho conta</a>
        </div>
        <p class="muted hs-note">O app é de graça. Competição paga, se tiver, é combinada entre vocês: nada de pagamento no site.</p>
      </section>
    </div>
  </div>`;

  const gain = view.querySelector("[data-gain]");
  const update = () => {
    gain.innerHTML = `Se acertar, vale <b>+${(ODDS[S.pick] - 1).toFixed(2)} pts</b>`;
    view.querySelectorAll(".hs-game .odd").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === S.pick)));
  };
  view.querySelectorAll(".hs-game .odd").forEach((b) => {
    b.onclick = () => {
      S.pick = b.dataset.k;
      update();
    };
  });
  view.querySelectorAll('a[href="#como"]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      view.querySelector("#como").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
  });
  update();
}
