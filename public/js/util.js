// Utilidades de interface: escapar HTML, chamar a API, formatar datas/odds, escudos e avisos.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let serverOffset = 0; // servidor − relógio do aparelho (o iPhone pode estar adiantado/atrasado)
export const now = () => Date.now() + serverOffset;
export const syncClock = (serverIso) => {
  const t = Date.parse(serverIso);
  if (!Number.isNaN(t)) serverOffset = t - Date.now();
};

export async function api(path, { method = "GET", body, keepalive = false } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      keepalive,
    });
  } catch {
    throw new ApiError("Sem conexão. Confira a internet e tente de novo.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/entrar") && path !== "/eu") window.dispatchEvent(new CustomEvent("auth-lost"));
    throw new ApiError(data.erro || `Erro ${res.status}`, res.status);
  }
  return data;
}

// ---------- formatação ----------

const TZ = undefined; // fuso do aparelho
const dayKey = (d) => new Date(d).toLocaleDateString("sv-SE", { timeZone: TZ });

export function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function fmtWhen(iso) {
  const d = new Date(iso);
  const today = dayKey(now());
  const tomorrow = dayKey(now() + 86400_000);
  const yesterday = dayKey(now() - 86400_000);
  const k = dayKey(d);
  const clock = fmtClock(iso);
  if (k === today) return `Hoje ${clock}`;
  if (k === tomorrow) return `Amanhã ${clock}`;
  if (k === yesterday) return `Ontem ${clock}`;
  return `${d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ })} ${clock}`;
}

export const fmtDate = (ymd) => (ymd ? ymd.split("-").reverse().join("/") : "");
export const fmtMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
};
export const odd = (n) => (n == null ? "—" : Number(n).toFixed(2));
export const pts = (n) => (n == null ? "—" : Number(n).toFixed(2));
export const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}`);

export function countdown(iso) {
  const ms = Date.parse(iso) - now();
  if (ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(h / 24)}d`;
}

// ---------- pedaços de HTML ----------

const initials = (name) =>
  String(name ?? "?")
    .replace(/[^\p{L}\p{N}\s-]/gu, "") // só letras/números
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

const abbr = (name) => {
  const words = String(name ?? "?").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  return (words.length === 1 ? words[0].slice(0, 3) : words.slice(0, 3).map((w) => w[0]).join("")).toUpperCase() || "?";
};
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

/** Escudo genérico (cor pela hash do nome) para quando o time não tem logo. */
const shield = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 21 4v7.5c0 5.5-3.9 9.6-9 11-5.1-1.4-9-5.5-9-11V4z" fill="hsl(${hue(name)} 45% 36%)"/><text x="12" y="15" text-anchor="middle" font-family="Saira Condensed,Arial Narrow,sans-serif" font-size="7.5" font-weight="700" fill="#fff">${esc(abbr(name))}</text></svg>`;
window.__shield = (name) => {
  const t = document.createElement("span");
  t.innerHTML = shield(name);
  return t.firstChild;
};

export function crest(team, size = "") {
  const inner = team?.logo
    ? `<img src="${esc(team.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-n="${esc(team?.name)}" onerror="this.replaceWith(window.__shield(this.dataset.n))">`
    : shield(team?.name);
  return `<span class="crest ${size}" aria-hidden="true">${inner}</span>`;
}

export function leagueIcon(l) {
  const ini = esc(initials(l?.name));
  const img = l?.logo ? `<img src="${esc(l.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${ini}'))">` : ini;
  return `<span class="league-icon" aria-hidden="true">${img}</span>`;
}

export const avatar = (name, cls = "") => `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(name).slice(0, 1) || "?")}</span>`;

const I = {
  ball: '<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/><path d="M12 7V3M16 10l4-1M14.5 14.5l2.5 3.5M9.5 14.5L7 18M8 10L4 9"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H4v1a4 4 0 004 4M16 6h4v1a4 4 0 01-4 4M12 13v4M8 21h8M9 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  bell: '<path d="M6 16V11a6 6 0 1112 0v5l2 2H4z"/><path d="M10 21h4"/>',
  moon: '<path d="M20 14A8 8 0 0110 4a8 8 0 1010 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] ?? ""}</svg>`;

export const zebraLabel = (t) => (t === "placar" ? "Placar exato" : "Vencedor (1X2)");

/** Maior odd acertada (vencedor ou placar exato). */
export function zebraBlock(z, title) {
  return `<div class="zebra"><small>${esc(title)}</small>${
    z
      ? `<b class="num">@${odd(z.odd)}</b><span>${esc(zebraLabel(z.tipo))} · ${esc(z.jogo)}</span><span class="muted">acertada por <b>${esc(z.nickname)}</b></span>`
      : `<span class="muted">Ainda ninguém acertou um vencedor ou placar.</span>`
  }</div>`;
}

// ---------- avisos e janelas ----------

export function toast(message, kind = "") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 5000 : 2800);
}

export function openSheet(html, { onClose } = {}) {
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  const close = () => {
    bg.remove();
    document.body.style.overflow = prevOverflow;
    onClose?.();
  };
  bg.addEventListener("click", (e) => {
    if (e.target === bg || e.target.closest("[data-close]")) close();
  });
  document.body.appendChild(bg);
  return { el: bg.firstElementChild, close };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
