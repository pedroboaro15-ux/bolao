// Cria o primeiro administrador: conta no Supabase Auth + linha em users.
// Uso: npm run seed:admin
//      npm run seed:admin -- --email voce@exemplo.com --nome "Seu Nome" --apelido Chefe
// SUPABASE_URL vem do wrangler.toml; a chave secreta (SUPABASE_SERVICE_KEY) vem do .dev.vars, do ambiente ou é perguntada.
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { SupabaseDb } from "../src/db/supabase";
import { SupabaseAuth } from "../src/auth/provider";

function readVars(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function readToml(): Record<string, string> {
  if (!existsSync("wrangler.toml")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync("wrangler.toml", "utf8").split(/\r?\n/)) {
    const m = /^\s*(SUPABASE_[A-Z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const vars = { ...readToml(), ...readVars(".dev.vars") };
const url = process.env.SUPABASE_URL ?? vars.SUPABASE_URL;
if (!url || url.startsWith("COLOQUE")) {
  console.error("Falta SUPABASE_URL: preencha no wrangler.toml (https://SEU-PROJETO.supabase.co).");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, given?: string) => given ?? (await rl.question(q)).trim();

const serviceKey = await ask("Chave secreta do Supabase (service_role ou sb_secret_...): ", process.env.SUPABASE_SERVICE_KEY ?? vars.SUPABASE_SERVICE_KEY);
const email = (await ask("E-mail do admin: ", arg("email"))).toLowerCase();
const name = await ask("Nome completo: ", arg("nome"));
const nickname = await ask("Apelido (aparece no ranking): ", arg("apelido"));
const password = await ask("Senha (mínimo 8 caracteres): ", process.env.ADMIN_PASSWORD ?? arg("senha"));
rl.close();
if (!serviceKey || password.length < 8 || !email.includes("@") || !name || !nickname) {
  console.error("Dados inválidos.");
  process.exit(1);
}

const db = new SupabaseDb(url, serviceKey);
// O segredo de sessão só serve para o site; aqui só precisamos criar a conta (e reaproveitá-la se já existir).
const auth = new SupabaseAuth(url, serviceKey, "seed-admin-sem-uso-de-sessao-0123456789");

let uid: string;
try {
  uid = await auth.createUser(email, password, nickname);
  console.log("Conta criada no Supabase Auth.");
} catch (e: any) {
  if (e.status !== 409) throw e;
  // Já existe (rodou antes e parou no meio): confere a senha e reaproveita.
  uid = (await auth.signIn(email, password)).uid;
  console.log("A conta já existia no Supabase Auth; reaproveitando.");
}

await db.commit([{ op: "set", path: `users/${uid}`, data: { name, nickname, email, role: "admin", created_at: new Date() } }]);
console.log(`Pronto! ${nickname} (${email}) é administrador. Entre no site com esse e-mail e senha.`);
