import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/types";
import { bolaoDay, bolaoWindow } from "../src/lib/dates";
import { MemoryDb } from "../src/db/memory";
import { Repo } from "../src/db/repo";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { chosenToday, createRound, loadFixtures, type CachedFixture } from "../src/services/rounds";
import { bestZebra, maxZebra } from "../src/lib/zebra";

describe("dia do bolão: 06:00 → 06:00 em São Paulo", () => {
  it("vira o dia às 06:00 de Brasília (09:00 UTC)", () => {
    expect(bolaoDay(new Date("2026-09-29T08:59:59Z"))).toBe("2026-09-28"); // 05:59 em SP
    expect(bolaoDay(new Date("2026-09-29T09:00:00Z"))).toBe("2026-09-29"); // 06:00 em SP
    expect(bolaoDay(new Date("2026-09-30T02:30:00Z"))).toBe("2026-09-29"); // 23:30 em SP ainda é o dia 29
    expect(bolaoDay(new Date("2026-09-30T08:59:59Z"))).toBe("2026-09-29"); // 05:59 em SP do dia 30
  });

  it("janela vai de 06:00 até 06:00 do dia seguinte", () => {
    const w = bolaoWindow("2026-09-29");
    expect(w.start.toISOString()).toBe("2026-09-29T09:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-09-30T09:00:00.000Z");
  });
});

const fx = (id: number, iso: string, relevance = 50): CachedFixture => ({
  id,
  kickoff: new Date(iso),
  status: "NS",
  league: { id: 71, name: "Série A" },
  home: { id: id * 10, name: `Casa ${id}` },
  away: { id: id * 10 + 1, name: `Fora ${id}` },
  relevance,
});

describe("busca dos jogos do dia", () => {
  it("junta dois dias do calendário, filtra pela janela e usa cache na segunda vez", async () => {
    const repo = new Repo(new MemoryDb());
    const calls: string[] = [];
    const api: any = {
      fixturesByDate: async (date: string) => {
        calls.push(date);
        const day: Record<string, any[]> = {
          "2026-09-29": [
            { id: 1, kickoff: new Date("2026-09-29T02:00:00Z") }, // 23:00 de 28/09 em SP → dia anterior
            { id: 2, kickoff: new Date("2026-09-29T22:00:00Z") }, // 19:00 em SP → dentro
          ],
          "2026-09-30": [
            { id: 3, kickoff: new Date("2026-09-30T04:00:00Z") }, // 01:00 de 30/09 em SP → ainda no dia 29 do bolão
            { id: 4, kickoff: new Date("2026-09-30T12:00:00Z") }, // 09:00 de 30/09 em SP → dia seguinte
          ],
        };
        return (day[date] ?? []).map((f) => ({ ...f, status: "NS", league: { id: 71, name: "Série A" }, home: { id: 1, name: "A" }, away: { id: 2, name: "B" } }));
      },
    };
    const r = await loadFixtures(repo, api, DEFAULT_SETTINGS, "2026-09-29");
    expect(r.fixtures.map((f) => f.id).sort()).toEqual([2, 3]);
    expect(calls).toEqual(["2026-09-29", "2026-09-30"]);
    await loadFixtures(repo, api, DEFAULT_SETTINGS, "2026-09-29");
    expect(calls).toHaveLength(2); // cache: nenhuma chamada nova
    await loadFixtures(repo, api, DEFAULT_SETTINGS, "2026-09-29", true);
    expect(calls).toHaveLength(4); // "buscar de novo" gasta 2 chamadas
  });
});

describe("limite de jogos por dia", () => {
  const future = (n: number) => Array.from({ length: n }, (_, i) => fx(100 + i, `2099-01-01T${String(10 + i).padStart(2, "0")}:00:00Z`));
  const input = (ids: number[], date = "2099-01-01") => ({ title: "Teste", date, fixtureIds: ids, open: true });

  it("recusa passar do limite definido e conta as rodadas do mesmo dia", async () => {
    const repo = new Repo(new MemoryDb());
    const fixtures = future(8);
    const settings = { maxMatchesPerDay: 5 };
    await expect(createRound(repo, input([100, 101, 102, 103, 104, 105]), fixtures, settings)).rejects.toThrow(/máximo mais 5/);
    const ok = await createRound(repo, input([100, 101, 102]), fixtures, settings);
    expect(ok.matchIds).toHaveLength(3);
    expect(await chosenToday(repo, "2099-01-01")).toBe(3);
    await expect(createRound(repo, input([103, 104, 105]), fixtures, settings)).rejects.toThrow(/máximo mais 2/);
    await createRound(repo, input([103, 104]), fixtures, settings);
    await expect(createRound(repo, input([105]), fixtures, settings)).rejects.toThrow(/já foi atingido/);
  });

  it("o limite vale por dia: outro dia começa do zero", async () => {
    const repo = new Repo(new MemoryDb());
    const fixtures = future(4);
    await createRound(repo, input([100, 101]), fixtures, { maxMatchesPerDay: 2 });
    await expect(createRound(repo, input([102], "2099-01-02"), fixtures, { maxMatchesPerDay: 2 })).resolves.toBeTruthy();
  });

  it("não deixa escolher jogo que já está em outra rodada", async () => {
    const repo = new Repo(new MemoryDb());
    const fixtures = future(3);
    await createRound(repo, input([100]), fixtures, { maxMatchesPerDay: 10 });
    await expect(createRound(repo, input([100], "2099-01-02"), fixtures, { maxMatchesPerDay: 10 })).rejects.toThrow(/outra rodada/);
  });
});

describe("maior zebra (só vencedor 1X2 e placar exato)", () => {
  const matches = new Map([
    ["m1", { home: { name: "A" }, away: { name: "B" }, voided: false }],
    ["m2", { home: { name: "C" }, away: { name: "D" }, voided: false }],
    ["m3", { home: { name: "E" }, away: { name: "F" }, voided: true }],
  ]);
  const nick = new Map([["u1", "Ana"], ["u2", "Beto"]]);

  it("pega a maior odd acertada, no 1X2 ou no placar", () => {
    const z = bestZebra(
      [
        { user_id: "u1", match_id: "m1", parts: { winner: 4.5, ou: 0, cs: 0 } },
        { user_id: "u2", match_id: "m2", parts: { winner: 0, ou: 0, cs: 11.2 } },
      ],
      matches,
      nick,
    );
    expect(z).toEqual({ odd: 12.2, tipo: "placar", jogo: "C x D", match_id: "m2", user_id: "u2", nickname: "Beto" });
  });

  it("gols (2,5) não vira zebra, nem jogo anulado", () => {
    expect(bestZebra([{ user_id: "u1", match_id: "m1", parts: { winner: 0, ou: 30, cs: 0 } }], matches, nick)).toBeNull();
    expect(bestZebra([{ user_id: "u1", match_id: "m3", parts: { winner: 9, ou: 0, cs: 0 } }], matches, nick)).toBeNull();
  });

  it("maxZebra escolhe a maior entre as rodadas", () => {
    const a = { odd: 5, tipo: "1x2" as const, jogo: "x", match_id: "1", user_id: "u", nickname: "n" };
    expect(maxZebra([null, a, { ...a, odd: 8 }, undefined])?.odd).toBe(8);
    expect(maxZebra([null])).toBeNull();
  });
});

describe("pela API (modo demo)", () => {
  const app = createApp();
  const env = { DEV_MEMORY: "1" } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
    app.request(
      `http://localhost${path}`,
      { method: init.method ?? "GET", headers: { "content-type": "application/json", cookie: `bolao_sessao=dev.${init.user ?? "admin"}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      env,
      ctx,
    );
  const json = async (r: Response) => (await r.json()) as any;

  it("ranking geral, do mês e da rodada trazem a maior zebra", async () => {
    for (const q of ["escopo=geral", "escopo=mes", "escopo=rodada"]) {
      const d = await json(await call(`/api/ranking?${q}`));
      expect(d.zebra, q).toBeTruthy();
      expect(["1x2", "placar"]).toContain(d.zebra.tipo);
      expect(d.zebra.odd).toBeGreaterThan(1);
      expect(d.zebra.nickname).toBeTruthy();
    }
  });

  it("admin vê o limite do dia e a janela de 6h, e não passa do limite", async () => {
    await call("/api/admin/config", { method: "PUT", body: { maxMatchesPerDay: 4 } });
    const d = await json(await call("/api/admin/jogos-do-dia"));
    expect(d.limite).toBe(4);
    expect(d.ja_escolhidos).toBeGreaterThanOrEqual(6); // a rodada de hoje do demo já tem 6 jogos
    expect(new Date(d.janela.fim).getTime() - new Date(d.janela.inicio).getTime()).toBe(24 * 3600_000);
    const ids = d.jogos.slice(0, 2).map((j: any) => j.id);
    const res = await call("/api/admin/rodadas", { method: "POST", body: { date: d.date, title: "Extra", fixtureIds: ids, open: true } });
    expect(res.status).toBe(400);
    expect((await json(res)).erro).toMatch(/limite de 4 jogos/);
    expect((await call("/api/admin/config", { method: "PUT", body: { maxMatchesPerDay: 0 } })).status).toBe(400);
    expect((await call("/api/admin/config", { method: "PUT", body: { maxMatchesPerDay: 31 } })).status).toBe(400);
    expect((await call("/api/admin/config", { method: "PUT", body: { maxMatchesPerDay: 2.5 } })).status).toBe(400);
  });
});
