import type { Db, Doc } from "./types";
import type { Invite, Match, Prediction, Round, Standings, UserDoc } from "../types";
import { mergeSettings, type Settings } from "../lib/settings";

export type WithId<T> = T & { id: string };
const withId = <T>(d: Doc<T>): WithId<T> => ({ id: d.id, ...d.data });

/** Acesso tipado às coleções. A lógica de negócio só fala com isto (testável com MemoryDb). */
export class Repo {
  constructor(public db: Db) {}

  // ----- configurações -----
  async settings(): Promise<Settings> {
    const d = await this.db.get<Partial<Settings>>("settings/app");
    return mergeSettings(d?.data);
  }
  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.db.commit([{ op: "merge", path: "settings/app", data: patch }]);
    return this.settings();
  }

  // ----- usuários -----
  async user(uid: string): Promise<WithId<UserDoc> | null> {
    const d = await this.db.get<UserDoc>(`users/${uid}`);
    return d ? withId(d) : null;
  }
  async users(): Promise<WithId<UserDoc>[]> {
    const rows = await this.db.query<UserDoc>("users");
    return rows.map(withId).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  // ----- convites -----
  async invite(token: string): Promise<Doc<Invite> | null> {
    return this.db.get<Invite>(`invites/${token}`);
  }
  async invites(): Promise<WithId<Invite>[]> {
    const rows = await this.db.query<Invite>("invites");
    return rows.map(withId).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  // ----- rodadas -----
  async round(id: string): Promise<WithId<Round> | null> {
    const d = await this.db.get<Round>(`rounds/${id}`);
    return d ? withId(d) : null;
  }
  /** Rodadas mais recentes primeiro (índice de campo único, sem índice composto). */
  async rounds(limit = 60): Promise<WithId<Round>[]> {
    const rows = await this.db.query<Round>("rounds", { orderBy: [{ field: "date", dir: "desc" }], limit });
    return rows.map(withId);
  }
  async roundsByStatus(status: string): Promise<WithId<Round>[]> {
    const rows = await this.db.query<Round>("rounds", { where: [["status", "==", status]] });
    return rows.map(withId).sort((a, b) => b.date.localeCompare(a.date));
  }

  // ----- jogos -----
  async match(id: string): Promise<WithId<Match> | null> {
    const d = await this.db.get<Match>(`matches/${id}`);
    return d ? withId(d) : null;
  }
  async matchesOfRound(roundId: string): Promise<WithId<Match>[]> {
    const rows = await this.db.query<Match>("matches", { where: [["round_id", "==", roundId]] });
    return rows.map(withId).sort((a, b) => a.kickoff_utc.getTime() - b.kickoff_utc.getTime());
  }
  async matchesByIds(ids: string[]): Promise<WithId<Match>[]> {
    const docs = await this.db.getMany<Match>(ids.map((i) => `matches/${i}`));
    return docs.filter((d): d is Doc<Match> => !!d).map(withId);
  }

  // ----- palpites -----
  predictionId = (matchId: string, userId: string) => `${matchId}_${userId}`;
  async predictionsOfRound(roundId: string): Promise<WithId<Prediction>[]> {
    const rows = await this.db.query<Prediction>("predictions", { where: [["round_id", "==", roundId]] });
    return rows.map(withId);
  }
  async predictionsOfUserRound(userId: string, roundId: string): Promise<WithId<Prediction>[]> {
    const rows = await this.db.query<Prediction>("predictions", { where: [["user_id", "==", userId], ["round_id", "==", roundId]] });
    return rows.map(withId);
  }
  async predictionsOfUser(userId: string, limit = 400): Promise<WithId<Prediction>[]> {
    const rows = await this.db.query<Prediction>("predictions", { where: [["user_id", "==", userId]], limit });
    return rows.map(withId).sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  }
  async predictionsOfMatch(matchId: string): Promise<WithId<Prediction>[]> {
    const rows = await this.db.query<Prediction>("predictions", { where: [["match_id", "==", matchId]] });
    return rows.map(withId);
  }

  // ----- ranking materializado -----
  async standings(id: string): Promise<Standings | null> {
    const d = await this.db.get<Standings>(`standings/${id}`);
    return d?.data ?? null;
  }
  async roundStandings(month?: string): Promise<WithId<Standings>[]> {
    const where: [string, "==", any][] = [["scope", "==", "round"]];
    if (month) where.push(["month", "==", month]);
    const rows = await this.db.query<Standings>("standings", { where });
    return rows.map(withId);
  }

  // ----- uso das APIs -----
  usageId = (date: string, provider: string) => `${date}_${provider}`;
  async usage(date: string, provider: string): Promise<number> {
    const d = await this.db.get<{ calls: number }>(`api_usage/${this.usageId(date, provider)}`);
    return d?.data.calls ?? 0;
  }
  async addUsage(date: string, provider: string, by = 1): Promise<void> {
    const path = `api_usage/${this.usageId(date, provider)}`;
    await this.db.commit([
      { op: "merge", path, data: { date, provider } },
      { op: "increment", path, field: "calls", by },
    ]);
  }
}
