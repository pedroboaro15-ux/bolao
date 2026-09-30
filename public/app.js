import { $, api, avatar, esc, icon, openSheet, toast } from "./js/util.js";
import { state, setGo } from "./js/store.js";
import * as roundPage from "./js/round.js";
import * as rankPage from "./js/ranking.js";
import * as adminPage from "./js/admin.js";

const app = document.getElementById("app");

let cleanup = null;

// ---------- rotas ----------

const PUBLIC = [
  [/^\/entrar\/?$/, loginPage],
  [/^\/esqueci\/?$/, forgotPage],
  [/^\/convite\/([^/]+)\/?$/, signupPage],
];

const PRIVATE = [
  [/^\/$/, (v) => roundPage.render(v, {})],
  [/^\/rodada\/([^/]+)\/?$/, (v, m) => roundPage.render(v, { id: m[1] })],
  [/^\/jogo\/([^/]+)\/?$/, (v, m) => rankPage.renderMatch(v, m[1])],
  [/^\/ranking\/?$/, (v) => rankPage.renderRanking(v)],
  [/^\/palpites\/?$/, (v) => rankPage.renderMine(v)],
  [/^\/admin(?:\/(.*))?$/, (v, m) => adminPage.render(v, (m[1] || "").split("/").filter(Boolean))],
];

function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  route();
}

setGo(go);
window.addEventListener("popstate", route);
window.addEventListener("auth-lost", () => {
  if (state.user) {
    state.user = null;
    toast("Sua sessão expirou. Entre de novo.", "err");
    go("/entrar", { replace: true });
  }
});

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
  e.preventDefault();
  go(a.getAttribute("href"));
});

async function route() {
  cleanup?.();
  cleanup = null;
  const path = location.pathname;

  for (const [re, fn] of PUBLIC) {
    const m = re.exec(path);
    if (m) {
      if (state.user && !path.startsWith("/convite")) return go("/", { replace: true });
      app.innerHTML = "";
      document.title = "Bolão";
      cleanup = fn(app, m) ?? null;
      return;
    }
  }
  if (!state.user) return go("/entrar", { replace: true });

  for (const [re, fn] of PRIVATE) {
    const m = re.exec(path);
    if (m) {
      if (path.startsWith("/admin") && state.user.role !== "admin") return go("/", { replace: true });
      const view = shell(path);
      const res = fn(view, m);
      cleanup = typeof res === "function" ? res : null;
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = `<div class="page narrow"><p class="empty">Página não encontrada. <a data-link href="/">Voltar ao início</a></p></div>`;
}

// ---------- casca (barra superior, navegação) ----------

function navItems() {
  const items = [
    ["/", "Rodada", "ball"],
    ["/ranking", "Ranking", "trophy"],
    ["/palpites", "Meus palpites", "user"],
  ];
  if (state.user?.role === "admin") items.push(["/admin", "Admin", "gear"]);
  return items;
}

const isCurrent = (href, path) => (href === "/" ? path === "/" || path.startsWith("/rodada") || path.startsWith("/jogo") : path.startsWith(href));

function shell(path) {
  const items = navItems();
  const dark = document.documentElement.dataset.tema === "dark" || (!document.documentElement.dataset.tema && matchMedia("(prefers-color-scheme: dark)").matches);
  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <a class="brand" data-link href="/"><i></i>BOLÃO</a>
      <nav class="nav" aria-label="Principal">${items.map(([h, t]) => `<a data-link href="${h}" ${isCurrent(h, path) ? 'aria-current="page"' : ""}>${t}</a>`).join("")}</nav>
      <span class="spacer"></span>
      <button class="iconbtn" data-act="push" aria-label="Notificações" title="Notificações">${icon("bell")}</button>
      <button class="iconbtn" data-act="theme" aria-label="Alternar tema" title="Tema">${icon(dark ? "sun" : "moon")}</button>
      <button class="chip-user" data-act="user" aria-label="Minha conta">${avatar(state.user.nickname)}<span>${esc(state.user.nickname)}</span></button>
    </div></header>
    ${state.config.demo ? `<div class="notice warn" style="border-radius:0;text-align:center">Modo demonstração: dados de mentira, nada é salvo de verdade.</div>` : ""}
    <main id="view"></main>
    <nav class="tabbar" aria-label="Principal">${items.map(([h, t, ic]) => `<a data-link href="${h}" ${isCurrent(h, path) ? 'aria-current="page"' : ""}>${icon(ic)}<span>${t.replace("Meus palpites", "Palpites")}</span></a>`).join("")}</nav>`;
  $("[data-act=theme]").onclick = toggleTheme;
  $("[data-act=push]").onclick = enablePush;
  $("[data-act=user]").onclick = userMenu;
  return $("#view");
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.tema === "dark" || (!root.dataset.tema && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  root.dataset.tema = next;
  try {
    localStorage.setItem("tema", next);
  } catch {}
  const btn = $("[data-act=theme]");
  if (btn) btn.innerHTML = icon(next === "dark" ? "sun" : "moon");
}

function userMenu() {
  const u = state.user;
  const s = openSheet(`
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">${avatar(u.nickname, "lg")}<div><h3 style="font-size:24px">${esc(u.name)}</h3><div class="muted">${esc(u.email)} · ${u.role === "admin" ? "administrador" : "jogador"}</div></div></div>
    <div class="actions" style="flex-direction:column">
      <a class="btn" data-link data-close href="/palpites">Meus palpites e estatísticas</a>
      <button class="btn" data-act="howto">Como ativar notificações no iPhone</button>
      <button class="btn danger" data-act="out">Sair</button>
    </div>`);
  $("[data-act=out]", s.el).onclick = async () => {
    await api("/sair", { method: "POST" }).catch(() => {});
    state.user = null;
    s.close();
    go("/entrar", { replace: true });
  };
  $("[data-act=howto]", s.el).onclick = () => {
    s.close();
    iosHowTo();
  };
}

// ---------- notificações (Web Push) ----------

function iosHowTo() {
  const s = openSheet(`
    <h3 style="font-size:26px;margin-bottom:10px">Ativar notificações no iPhone</h3>
    <p class="muted">No iPhone (iOS 16.4 ou mais novo) as notificações só funcionam com o site na Tela de Início.</p>
    <ol class="steps">
      <li>Abra este site no <b>Safari</b>.</li>
      <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima).</li>
      <li>Escolha <b>Adicionar à Tela de Início</b> e confirme.</li>
      <li>Abra o Bolão <b>pelo ícone novo</b> na Tela de Início.</li>
      <li>Toque no <b>sino</b> no topo e permita as notificações.</li>
    </ol>
    <div class="actions"><button class="btn primary block" data-close>Entendi</button></div>`);
  return s;
}

const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function enablePush() {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return iosHowTo();
  if (!state.config.vapidPublicKey) return toast("As notificações ainda não foram configuradas no servidor.", "err");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notificações bloqueadas. Libere nas configurações do aparelho.", "err");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(state.config.vapidPublicKey) });
    await api("/push/inscrever", { method: "POST", body: sub.toJSON() });
    toast("Notificações ativadas!", "ok");
  } catch (e) {
    toast(e.message || "Não foi possível ativar as notificações", "err");
  }
}

// ---------- telas de acesso ----------

function authFrame(inner) {
  return `<div class="auth"><div class="logo"><i></i>BOLÃO</div>${inner}</div>`;
}

function loginPage(view) {
  document.title = "Entrar · Bolão";
  view.innerHTML = authFrame(`
    <p class="lead">Palpite, some pontos e suba no ranking.</p>
    <form class="form card card-pad" id="f">
      <label class="f">E-mail<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
      <label class="f">Senha<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Entrar</button>
      <a data-link href="/esqueci" class="muted" style="text-align:center">Esqueci a senha</a>
    </form>
    <p class="muted" style="text-align:center;font-size:13px">O cadastro é só por convite. Peça o link a quem organiza o bolão.</p>
    ${state.config.demo ? `<div class="notice" style="margin-top:12px">Demonstração com dados de mentira. Toque para entrar direto:<div class="actions"><button class="btn small primary" type="button" data-demo="lucas@demo.local">Entrar como jogador</button><button class="btn small" type="button" data-demo="admin@demo.local">Entrar como admin</button></div></div>` : ""}`);
  view.querySelectorAll("[data-demo]").forEach((b) => {
    b.onclick = () => {
      $("input[name=email]", view).value = b.dataset.demo;
      $("input[name=password]", view).value = "demo1234";
      $("#f").requestSubmit();
    };
  });
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", view);
    btn.disabled = true;
    $("#err").textContent = "";
    try {
      const fd = new FormData(e.target);
      const r = await api("/entrar", { method: "POST", body: { email: fd.get("email"), password: fd.get("password") } });
      state.user = r.usuario;
      go("/", { replace: true });
    } catch (err) {
      $("#err").textContent = err.message;
      btn.disabled = false;
    }
  };
}

function forgotPage(view) {
  document.title = "Esqueci a senha · Bolão";
  view.innerHTML = authFrame(`
    <p class="lead">Enviamos um link para você criar uma senha nova.</p>
    <form class="form card card-pad" id="f">
      <label class="f">E-mail<input name="email" type="email" autocomplete="username" required></label>
      <div id="msg" class="muted" role="status"></div>
      <button class="btn primary block" type="submit">Enviar link</button>
      <a data-link href="/entrar" class="muted" style="text-align:center">Voltar</a>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    await api("/senha/esqueci", { method: "POST", body: { email: new FormData(e.target).get("email") } }).catch(() => {});
    $("#msg").textContent = "Se esse e-mail estiver cadastrado, o link chega em instantes. Olhe também o spam.";
  };
}

/** O link do e-mail de recuperação abre o site com #access_token=...&type=recovery. */
function recoveryToken() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  return h.get("type") === "recovery" ? h.get("access_token") : null;
}

function newPasswordPage(view, token) {
  document.title = "Nova senha · Bolão";
  view.innerHTML = authFrame(`
    <p class="lead">Escolha uma senha nova.</p>
    <form class="form card card-pad" id="f">
      <label class="f">Senha nova (mínimo 8 caracteres)<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
      <label class="f">Repita a senha<input name="again" type="password" autocomplete="new-password" required minlength="8"></label>
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Salvar senha</button>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $("#err");
    err.textContent = "";
    if (fd.get("password") !== fd.get("again")) return (err.textContent = "As senhas não são iguais.");
    try {
      await api("/senha/nova", { method: "POST", body: { token, password: fd.get("password") } });
      history.replaceState({}, "", "/entrar");
      toast("Senha alterada! Entre com a senha nova.", "ok");
      route();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
}

async function signupPage(view, m) {
  document.title = "Convite · Bolão";
  const token = m[1];
  view.innerHTML = authFrame(`<p class="lead">Verificando convite…</p>`);
  const info = await api(`/convite/${encodeURIComponent(token)}`).catch(() => ({ valido: false, motivo: "Não foi possível verificar o convite" }));
  if (!info.valido) {
    view.innerHTML = authFrame(`<div class="card card-pad"><p class="error">${esc(info.motivo)}</p><a class="btn block" data-link href="/entrar">Ir para o login</a></div>`);
    return;
  }
  view.innerHTML = authFrame(`
    <p class="lead">Você foi convidado! Crie sua conta.</p>
    <form class="form card card-pad" id="f">
      <label class="f">Nome completo<input name="name" autocomplete="name" required minlength="2" maxlength="60"></label>
      <label class="f">Apelido (aparece no ranking)<input name="nickname" autocomplete="nickname" required minlength="2" maxlength="20"></label>
      <label class="f">E-mail<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
      <label class="f">Senha (mínimo 8 caracteres)<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Criar conta e entrar</button>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", view);
    btn.disabled = true;
    $("#err").textContent = "";
    try {
      const r = await api(`/convite/${encodeURIComponent(token)}`, { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      state.user = r.usuario;
      go("/", { replace: true });
    } catch (err) {
      $("#err").textContent = err.message;
      btn.disabled = false;
    }
  };
}

// ---------- início ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

(async () => {
  const [cfg, me] = await Promise.all([api("/config").catch(() => null), api("/eu").catch(() => ({ usuario: null }))]);
  if (cfg) state.config = cfg;
  state.user = me.usuario;
  const recovery = recoveryToken();
  if (recovery) return newPasswordPage(app, recovery);
  route();
})();
