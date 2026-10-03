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
  [/^\/cadastro\/?$/, signupPage],
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
      if (state.user) return go("/", { replace: true });
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
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">${avatar(u.nickname, "lg")}<div><h3 style="font-size:24px">${esc(u.nickname)}</h3><div class="muted">${esc(u.email)} · ${u.role === "admin" ? "administrador" : "jogador"}</div></div></div>
    <div class="actions" style="flex-direction:column">
      <a class="btn" data-link data-close href="/palpites">Meus palpites e estatísticas</a>
      <button class="btn" data-act="profile">Editar perfil (apelido, telefone, senha)</button>
      <button class="btn" data-act="howto">Como ativar notificações no iPhone</button>
      <button class="btn danger" data-act="out">Sair</button>
    </div>`);
  $("[data-act=out]", s.el).onclick = async () => {
    await api("/sair", { method: "POST" }).catch(() => {});
    state.user = null;
    s.close();
    go("/entrar", { replace: true });
  };
  $("[data-act=profile]", s.el).onclick = () => {
    s.close();
    profileSheet();
  };
  $("[data-act=howto]", s.el).onclick = () => {
    s.close();
    iosHowTo();
  };
}

// ---------- editar perfil: apelido, telefone e senha, uma vez cada ----------

async function profileSheet() {
  let u = state.user;
  try {
    u = (await api("/eu")).usuario ?? u;
    state.user = u;
  } catch {}
  const sheet = openSheet(`<div data-profile></div>`);
  const box = $("[data-profile]", sheet.el);
  const used = (k) => !!u.edits?.[k];
  const note = (k, what) => (used(k) ? `<p class="hint">Você já alterou ${what}. Para mudar de novo, peça ao administrador.</p>` : `<p class="hint">Só dá para alterar ${what} <b>uma vez</b>. Depois, só o administrador altera.</p>`);
  const WHAT = { nickname: "o apelido", phone: "o telefone", senha: "a senha" };

  function paintBox() {
    box.innerHTML = `
      <h3 style="font-size:26px;margin-bottom:4px">Editar perfil</h3>
      <p class="muted" style="margin-bottom:12px">${esc(u.email)}</p>
      <form class="form card card-pad" data-form="nickname" style="margin-bottom:12px">
        <label class="f">Apelido (aparece no ranking)<input name="nickname" value="${esc(u.nickname)}" minlength="2" maxlength="20" required ${used("nickname") ? "disabled" : ""}></label>
        ${note("nickname", "o apelido")}
        <div class="error" data-err role="alert"></div>
        <button class="btn primary" type="submit" ${used("nickname") ? "disabled" : ""}>Salvar apelido</button>
      </form>
      <form class="form card card-pad" data-form="phone" style="margin-bottom:12px">
        <label class="f">Telefone (com DDD)<input name="phone" type="tel" inputmode="tel" value="${esc(fmtPhone(u.phone))}" placeholder="(11) 91234-5678" required ${used("phone") ? "disabled" : ""}></label>
        ${note("phone", "o telefone")}
        <div class="error" data-err role="alert"></div>
        <button class="btn primary" type="submit" ${used("phone") ? "disabled" : ""}>Salvar telefone</button>
      </form>
      <form class="form card card-pad" data-form="senha" style="margin-bottom:12px">
        ${
          used("password")
            ? `<h4 style="margin:0">Senha</h4>${note("password", "a senha")}`
            : `${pwField("atual", "Senha atual", "current-password")}${pwField("nova", "Senha nova (mínimo 8 caracteres)", "new-password", 'minlength="8"')}${pwField("confirmar", "Repita a senha nova", "new-password", 'minlength="8"')}${note("password", "a senha")}
               <div class="error" data-err role="alert"></div>
               <button class="btn primary" type="submit">Salvar senha</button>`
        }
      </form>
      <div class="actions"><button class="btn block" data-close>Fechar</button></div>`;
    wirePasswordEyes(box);
    const phone = $("input[name=phone]", box);
    if (phone) phone.oninput = maskPhone;
    box.querySelectorAll("form[data-form]").forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const kind = f.dataset.form;
        const fd = Object.fromEntries(new FormData(f));
        const err = $("[data-err]", f);
        if (err) err.textContent = "";
        if (kind === "senha" && fd.nova !== fd.confirmar) return (err.textContent = "As senhas não são iguais.");
        if (!confirm(`Só dá para alterar ${WHAT[kind]} uma vez. Confirmar a alteração?`)) return;
        const btn = $("button[type=submit]", f);
        btn.disabled = true;
        try {
          if (kind === "senha") {
            await api("/perfil/senha", { method: "POST", body: fd });
            u = { ...u, edits: { ...u.edits, password: true } };
            toast("Senha alterada!", "ok");
          } else {
            const r = await api("/perfil", { method: "PUT", body: kind === "nickname" ? { nickname: fd.nickname } : { phone: fd.phone } });
            u = r.usuario;
            toast(kind === "nickname" ? "Apelido alterado!" : "Telefone alterado!", "ok");
          }
          state.user = { ...state.user, ...u };
          const chip = $(".chip-user span");
          if (chip) chip.textContent = u.nickname;
          paintBox();
        } catch (ex) {
          if (err) err.textContent = ex.message;
          btn.disabled = false;
        }
      };
    });
  }
  paintBox();
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

/** (11) 91234-5678 enquanto a pessoa digita. */
const fmtPhone = (raw) => {
  const d = String(raw ?? "").replace(/\D/g, "").slice(0, 11);
  const cut = d.length > 10 ? 7 : 6;
  return d.length > cut ? `(${d.slice(0, 2)}) ${d.slice(2, cut)}-${d.slice(cut)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d;
};
const maskPhone = (e) => (e.target.value = fmtPhone(e.target.value));

const EYE = '<svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

/** Campo de senha com o olhinho para mostrar/esconder o que foi digitado. */
function pwField(name, label, autocomplete, extra = "") {
  return `<label class="f">${label}<span class="pw"><input name="${name}" type="password" autocomplete="${autocomplete}" required ${extra}><button class="pw-eye" type="button" aria-label="Mostrar senha" aria-pressed="false">${EYE}</button></span></label>`;
}

function wirePasswordEyes(root) {
  root.querySelectorAll(".pw-eye").forEach((b) => {
    b.onclick = () => {
      const input = b.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.setAttribute("aria-pressed", String(show));
      b.setAttribute("aria-label", show ? "Esconder senha" : "Mostrar senha");
      b.classList.toggle("on", show);
    };
  });
}

function authFrame(inner) {
  return `<div class="auth"><div class="logo"><i></i>BOLÃO</div>${inner}</div>`;
}

function loginPage(view) {
  document.title = "Entrar · Bolão";
  view.innerHTML = authFrame(`
    <p class="lead">Palpite, some pontos e suba no ranking.</p>
    <form class="form card card-pad" id="f">
      <label class="f">E-mail<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
      ${pwField("password", "Senha", "current-password")}
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Entrar</button>
      <a data-link href="/esqueci" class="muted" style="text-align:center">Esqueci a senha</a>
    </form>
    <p class="muted" style="text-align:center">Ainda não tem conta? <a data-link href="/cadastro"><b>Criar conta</b></a></p>
    ${state.config.demo ? `<div class="notice" style="margin-top:12px">Demonstração com dados de mentira. Toque para entrar direto:<div class="actions"><button class="btn small primary" type="button" data-demo="lucas@demo.local">Entrar como jogador</button><button class="btn small" type="button" data-demo="admin@demo.local">Entrar como admin</button></div></div>` : ""}`);
  wirePasswordEyes(view);
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
      ${pwField("password", "Senha nova (mínimo 8 caracteres)", "new-password", 'minlength="8"')}
      ${pwField("again", "Repita a senha", "new-password", 'minlength="8"')}
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Salvar senha</button>
    </form>`);
  wirePasswordEyes(view);
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

function signupPage(view) {
  document.title = "Criar conta · Bolão";
  view.innerHTML = authFrame(`
    <p class="lead">Crie sua conta para palpitar.</p>
    <form class="form card card-pad" id="f" novalidate>
      <label class="f">E-mail<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
      <label class="f">Telefone (com DDD)<input name="phone" type="tel" autocomplete="tel-national" inputmode="tel" placeholder="(11) 91234-5678" required></label>
      <label class="f">Apelido no ranking <span class="muted">(opcional)</span><input name="nickname" autocomplete="nickname" maxlength="20"></label>
      ${pwField("password", "Senha (mínimo 8 caracteres)", "new-password", 'minlength="8"')}
      ${pwField("confirm", "Confirmar senha", "new-password", 'minlength="8"')}
      <div class="error" id="err" role="alert"></div>
      <button class="btn primary block" type="submit">Criar conta</button>
      <a data-link href="/entrar" class="muted" style="text-align:center">Já tenho conta · Entrar</a>
    </form>`);
  wirePasswordEyes(view);
  $("input[name=phone]", view).oninput = maskPhone;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", view);
    const err = $("#err");
    err.textContent = "";
    const body = Object.fromEntries(new FormData(e.target));
    if (!body.email || !body.phone || !body.password) return (err.textContent = "Preencha e-mail, telefone e senha.");
    if (body.password !== body.confirm) return (err.textContent = "As senhas não são iguais.");
    btn.disabled = true;
    try {
      const r = await api("/cadastro", { method: "POST", body });
      state.user = r.usuario;
      go("/", { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
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
