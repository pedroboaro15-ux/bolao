import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MemoryDb } from "../src/db/memory";
import { Repo } from "../src/db/repo";
import { utcDate } from "../src/lib/dates";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { ApiFootball } from "../src/services/apifootball";
import { LIVE_EVERY_MS, liveCandidates, refreshLive } from "../src/services/live";
import type { Env } from "../src/types";

const now = new Date("2026-10-01T20:00:00Z");
const min = (n: number) => new Date(now.getTime() + n * 60_000);
const base = { voided: false, home_goals: null, away_goals: null };

describe("quais jogos entram no placar ao vivo", () => {
  it("só os que já começaram, sem resultado oficial e dentro da janela de um jogo", () => {
    const ms = [
      { ...base, kickoff_utc: min(-60) }, // rolando
      { ...base, kickoff_utc: min(30) }, // ainda não começou
      { ...base, kickoff_utc: min(-60), home_goals: 1, away_goals: 0 }, // já tem resultado
      { ...base, kickoff_utc: min(-60), voided: true }, // anulado
      { ...base, kickoff_utc: min(-200) }, // passou da janela: quem fecha é o cron
    ];
    expect(liveCandidates(ms, now)).toEqual([0]);
  });
});

describe("atualização do placar ao vivo", () => {
  const original = globalThis.fetch;
  afterEach(() => (globalThis.fetch = original));

  const fixture = (id: number, h: number, a: number, short: string, elapsed: number | null) => ({
    fixture: { id, date: now.toISOString(), status: { short, elapsed } },
    league: { id: 1, name: "L", country: "C", logo: "" },
    teams: { home: { id: 1, name: "A", logo: "" }, away: { id: 2, name: "B", logo: "" } },
    goals: { home: h, away: a },
    score: { fulltime: { home: null, away: null } },
  });
  const setup = (response: unknown[]) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ errors: [], response }), { status: 200 });
    }) as unknown as typeof fetch;
    const repo = new Repo(new MemoryDb());
    const api = new ApiFootball({ API_FOOTBALL_KEY: "k" } as any, repo, DEFAULT_SETTINGS);
    const match = (id: string, fx: number, started: number) => ({ id, round_id: "r1", api_fixture_id: fx, status: "NS", kickoff_utc: min(started), ...base }) as any;
    return { urls, repo, api, match };
  };

  it("uma chamada por jogo em andamento (o plano grátis recusa ids) e grava placar, minuto e status", async () => {
    const { urls, repo, api, match } = setup([fixture(11, 2, 1, "2H", 63), fixture(12, 0, 0, "HT", 45)]);
    const n = await refreshLive(repo, api, "r1", [match("m1", 11, -70), match("m2", 12, -50), match("m3", 13, 30)], now);
    expect(n).toBe(2);
    expect(urls).toHaveLength(2); // o jogo que ainda não começou não entra
    expect(urls[0]).toContain("id=11");
    expect(urls[1]).toContain("id=12");
    expect(urls.join()).not.toContain("ids=");
    const m1: any = (await repo.db.get("matches/m1"))!.data;
    expect(m1.live).toMatchObject({ home: 2, away: 1, status: "2H", elapsed: 63 });
    expect(m1.status).toBe("2H");
    expect(m1.home_goals).toBeUndefined(); // o resultado OFICIAL continua sendo do cron
  });

  it("muita gente olhando ao mesmo tempo = uma chamada só; só chama de novo depois de 5 minutos", async () => {
    const { urls, repo, api, match } = setup([fixture(11, 1, 0, "1H", 20)]);
    const ms = [match("m1", 11, -30)];
    const [a, b, c] = await Promise.all([refreshLive(repo, api, "r1", ms, now), refreshLive(repo, api, "r1", ms, now), refreshLive(repo, api, "r1", ms, now)]);
    expect([a, b, c].filter((x) => x > 0)).toHaveLength(1);
    expect(urls).toHaveLength(1);
    await refreshLive(repo, api, "r1", ms, new Date(now.getTime() + 60_000));
    expect(urls).toHaveLength(1); // ainda na mesma janela de 5 minutos
    await refreshLive(repo, api, "r1", ms, new Date(now.getTime() + LIVE_EVERY_MS + 1000));
    expect(urls).toHaveLength(2);
  });

  it("sem jogo em andamento não chama a API", async () => {
    const { urls, repo, api, match } = setup([]);
    expect(await refreshLive(repo, api, "r1", [match("m1", 11, 60)], now)).toBe(0);
    expect(urls).toHaveLength(0);
  });

  it("não passa da reserva de chamadas (guardada para os placares finais) e não quebra", async () => {
    const { urls, repo, api, match } = setup([]);
    const day = utcDate(); // o código lê o uso de "hoje" (data real), não da data fixa do teste
    await repo.addUsage(day, "api-football", DEFAULT_SETTINGS.apiFootballDailyLimit - DEFAULT_SETTINGS.apiReserve);
    expect(await refreshLive(repo, api, "r1", [match("m1", 11, -30)], now)).toBe(0);
    expect(urls).toHaveLength(0);
  });
});

describe("o que o participante vê", () => {
  it("placar e minuto aparecem no jogo que está rolando, e não nos outros", async () => {
    const app = createApp();
    const env = { DEV_MEMORY: "1" } as unknown as Env;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const r = await app.request("http://localhost/api/rodada/atual", { headers: { cookie: "bolao_sessao=dev.lucas" } }, env, ctx);
    const d: any = await r.json();
    const rolando = d.jogos.find((j: any) => j.id === "900202");
    expect(rolando.live).toEqual({ home: 1, away: 0, status: "2H", elapsed: 63 });
    expect(d.jogos.find((j: any) => j.id === "900204").live).toBeNull();
    expect(d.jogos.find((j: any) => j.id === "900201").live).toBeNull(); // encerrado: vale o resultado oficial
  });
});
