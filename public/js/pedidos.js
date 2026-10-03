// Sem rodada hoje: cada um vota nos jogos que quer ver no bolão ou escreve uma sugestão. O admin vê tudo em Admin → Pedidos.
import { api, crest, esc, fmtWhen, leagueIcon, toast } from "./util.js";

export async function renderPedidos(box) {
  box.innerHTML = `<p class="boot">Carregando jogos…</p>`;
  let d;
  try {
    d = await api("/pedidos");
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  const paint = () => {
    box.innerHTML = `
      ${
        d.jogos.length
          ? `<p class="muted" style="margin:0 0 10px">Toque nos jogos que você quer na próxima rodada. O mais votado tem mais chance de entrar.</p>
             <div class="card" style="overflow:hidden">${d.jogos
               .map(
                 (j) => `<button class="vote-row" data-vote="${j.id}" aria-pressed="${j.meu}">
                   <span class="vote-teams">${crest(j.home)}<b>${esc(j.home.name)}</b><span class="muted">x</span><b>${esc(j.away.name)}</b>${crest(j.away)}</span>
                   <span class="vote-meta">${leagueIcon(j.league)}${esc(j.league.name)} · ${fmtWhen(j.kickoff)}</span>
                   <span class="vote-n">${j.meu ? "Votei" : "Quero"} · ${j.votos}</span></button>`,
               )
               .join("")}</div>`
          : `<p class="muted" style="margin:0 0 10px">A lista de jogos ainda não foi buscada. Escreva abaixo o que você quer ver no bolão.</p>`
      }
      <form class="form card card-pad" data-sug style="margin-top:14px">
        <label class="f">Sugestão (um jogo, uma pergunta, uma ideia)<textarea name="texto" rows="3" maxlength="280" placeholder="Ex.: coloquem o clássico de domingo e uma pergunta sobre a eleição" required></textarea></label>
        <button class="btn primary" type="submit">Enviar sugestão</button>
      </form>`;
  };
  paint();
  box.onclick = async (e) => {
    const b = e.target.closest("[data-vote]");
    if (!b) return;
    const j = d.jogos.find((x) => String(x.id) === b.dataset.vote);
    b.disabled = true;
    try {
      const r = await api("/pedidos/voto", { method: "POST", body: { fixture_id: j.id } });
      j.meu = r.votou;
      j.votos += r.votou ? 1 : -1;
      paint();
    } catch (err) {
      toast(err.message, "err");
      b.disabled = false;
    }
  };
  box.onsubmit = async (e) => {
    if (!e.target.matches("[data-sug]")) return;
    e.preventDefault();
    const f = e.target;
    try {
      await api("/pedidos/sugestao", { method: "POST", body: { texto: f.texto.value } });
      f.reset();
      toast("Sugestão enviada. Valeu!", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
}
