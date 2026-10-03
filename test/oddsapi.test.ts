import { describe, expect, it } from "vitest";
import { normTeam, parseTheOddsApi } from "../src/services/oddsapi";

const ko = new Date("2026-10-04T19:00:00Z");
const home = { id: 1, name: "São Paulo", logo: "" };
const away = { id: 2, name: "Palmeiras", logo: "" };
const h2h = (key: string, title: string, a: number, x: number, b: number) => ({
  key, title,
  markets: [{ key: "h2h", outcomes: [{ name: "Sao Paulo FC", price: a }, { name: "Draw", price: x }, { name: "Palmeiras", price: b }] }],
});
const ev = (books: any[]) => [{ home_team: "Sao Paulo FC", away_team: "Palmeiras", commence_time: "2026-10-04T19:00:00Z", bookmakers: books }];

describe("The Odds API", () => {
  it("normaliza nomes", () => expect(normTeam("São Paulo FC")).toBe(normTeam("Sao Paulo")));
  it("prefere Pinnacle", () => {
    const r = parseTheOddsApi(ev([h2h("unibet_eu", "Unibet", 2, 3, 4), h2h("pinnacle", "Pinnacle", 2.1, 3.3, 3.6)]), home, away, ko);
    expect(r["1X2"]).toEqual({ source: "Pinnacle", raw: { "1": 2.1, X: 3.3, "2": 3.6 } });
  });
  it("sem Pinnacle/Betfair usa a mediana", () => {
    const r = parseTheOddsApi(ev([h2h("a", "A", 2, 3, 4), h2h("b", "B", 2.2, 3.2, 3.8), h2h("c", "C", 2.4, 3.4, 3.6)]), home, away, ko);
    expect(r["1X2"]?.raw).toEqual({ "1": 2.2, X: 3.2, "2": 3.8 });
  });
  it("ignora outro jogo ou outro horário", () => {
    expect(parseTheOddsApi(ev([h2h("pinnacle", "P", 2, 3, 4)]), home, { id: 3, name: "Santos", logo: "" }, ko)).toEqual({});
    expect(parseTheOddsApi(ev([h2h("pinnacle", "P", 2, 3, 4)]), home, away, new Date("2026-10-05T19:00:00Z"))).toEqual({});
  });
});

import { buildOdds } from "../src/lib/odds";
describe("sem mercado de gols", () => {
  it("O/U 2,5 vem do modelo quando a fonte só traz o 1X2", () => {
    const o = buildOdds({ "1X2": { source: "Pinnacle", raw: { "1": 2.1, X: 3.4, "2": 3.6 } } }, new Date(), 150)!;
    expect(o.OU25?.source).toBe("modelo");
    const { over, under } = o.OU25!.fair;
    expect(1 / over + 1 / under).toBeCloseTo(1, 1);
  });
});

import { matchSport } from "../src/services/oddsapi";
describe("liga sem mapa fixo", () => {
  const sports = [{ key: "soccer_uefa_nations_league", title: "UEFA Nations League" }, { key: "soccer_brazil_copa_do_brasil", title: "Copa do Brasil" }, { key: "basketball_nba", title: "NBA" }];
  it("acha pelo nome da liga", () => {
    expect(matchSport(sports, "UEFA Nations League")).toBe("soccer_uefa_nations_league");
    expect(matchSport(sports, "Copa Do Brasil")).toBe("soccer_brazil_copa_do_brasil");
    expect(matchSport(sports, "Liga Qualquer")).toBeNull();
  });
});
