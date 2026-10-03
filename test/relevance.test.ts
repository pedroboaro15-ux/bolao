import { describe, expect, it } from "vitest";
import { relevanceScore } from "../src/lib/relevance";
import { DEFAULT_SETTINGS, mergeSettings, parseSettingsPatch } from "../src/lib/settings";

const f = (league: number, home: string, away: string) => ({ league: { id: league }, home: { name: home }, away: { name: away } });

describe("relevância", () => {
  it("usa o peso da liga", () => {
    expect(relevanceScore(f(2, "X", "Y"), DEFAULT_SETTINGS)).toBe(100);
    expect(relevanceScore(f(39, "X", "Y"), DEFAULT_SETTINGS)).toBe(90);
    expect(relevanceScore(f(61, "X", "Y"), DEFAULT_SETTINGS)).toBe(80);
    expect(relevanceScore(f(999, "X", "Y"), DEFAULT_SETTINGS)).toBe(40);
  });

  it("dá bônus por time grande e por clássico", () => {
    expect(relevanceScore(f(999, "Flamengo", "Y"), DEFAULT_SETTINGS)).toBe(45);
    expect(relevanceScore(f(999, "São Paulo", "Corinthians"), DEFAULT_SETTINGS)).toBe(40 + 5 + 5 + 10);
  });

  it("ordena um clássico acima de um jogo comum da mesma liga", () => {
    const classico = relevanceScore(f(71, "Flamengo", "Palmeiras"), DEFAULT_SETTINGS);
    const comum = relevanceScore(f(71, "Bahia", "Juventude"), DEFAULT_SETTINGS);
    expect(classico).toBeGreaterThan(comum);
  });
});

describe("configurações", () => {
  it("campos ausentes voltam ao padrão", () => {
    expect(mergeSettings({ oddCap: 80 }).oddCap).toBe(80);
    expect(mergeSettings(null)).not.toHaveProperty("jokerMultiplier");
  });

  it("valida o que o admin envia", () => {
    expect(parseSettingsPatch({ oddCap: 100, jokerEnabled: false })).toEqual({ oddCap: 100 }); // coringa não existe mais
    expect(() => parseSettingsPatch({ oddCap: -1 })).toThrow();
    expect(() => parseSettingsPatch({ oddCap: 1 })).toThrow();
    expect(() => parseSettingsPatch({ leagueWeights: { abc: 3 } })).toThrow();
    expect(parseSettingsPatch({ bigTeams: ["São Paulo"] }).bigTeams).toEqual(["sao paulo"]);
  });
});
