import { afterEach, describe, expect, it } from "vitest";
import { SupabaseDb } from "../src/db/supabase";
import { SupabaseAuth } from "../src/auth/provider";

// No Cloudflare Workers, o `fetch` global só funciona se for chamado solto. Se o código o guardar numa propriedade
// e chamar como método (obj.fetch(...)), dá "Illegal invocation" e todo pedido vira erro 500. O Node não reclama,
// então este teste imita a regra: o `fetch` falso só aceita ser chamado sem `this`.

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function strictFetch(body: unknown) {
  const f = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  globalThis.fetch = f as unknown as typeof fetch;
}

describe("fetch do Cloudflare (chamada solta)", () => {
  it("o cliente do banco usa o fetch global sem guardá-lo como método", async () => {
    strictFetch([{ id: "u1", version: 1, name: "Ana" }]);
    const db = new SupabaseDb("https://x.supabase.co", "sb_secret_abc");
    expect((await db.get("users/u1"))?.data).toMatchObject({ name: "Ana" });
    await db.commit([{ op: "delete", path: "users/u1" }]);
  });

  it("o cliente do login também", async () => {
    strictFetch({ user: { id: "u-1" } });
    const auth = new SupabaseAuth("https://x.supabase.co", "sb_secret_abc", "um-segredo-bem-longo-com-mais-de-trinta-e-dois-caracteres");
    const s = await auth.signIn("a@x.com", "senha1234");
    expect(s.uid).toBe("u-1");
  });
});
