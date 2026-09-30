// Estado global mínimo e navegação (evita import circular com app.js).
export const state = { user: null, config: { vapidPublicKey: null, demo: false } };

let goImpl = (path) => {
  location.href = path;
};
export const setGo = (fn) => {
  goImpl = fn;
};
export const go = (path, opts) => goImpl(path, opts);
