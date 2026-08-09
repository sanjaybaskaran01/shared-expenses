import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import type { SplitwiseOAuthConfig } from "./config";
import { decryptServerValue, encryptServerValue, keyedDigest } from "./security-keys";

const AUTHORIZE_URL = "https://secure.splitwise.com/oauth/authorize";
const TOKEN_URL = "https://secure.splitwise.com/oauth/token";
const API_BASE_URL = "https://secure.splitwise.com/api/v3.0";
const SESSION_TTL_MS = 15 * 60_000;
const RESPONSE_BYTES_LIMIT = 10 * 1024 * 1024;
const TOTAL_BYTES_LIMIT = 50 * 1024 * 1024;
const EXPENSE_LIMIT = 100_000;

export const splitwiseReadPaths = [
  "/get_current_user",
  "/get_groups",
  "/get_friends",
  "/get_expenses",
  "/get_categories",
  "/get_currencies",
] as const;

export function assertSplitwiseReadPath(pathname: string): void {
  if (!(splitwiseReadPaths as readonly string[]).includes(pathname)) {
    throw new Error("Tallied can import only from documented, read-only Splitwise endpoints.");
  }
}

function categoryNames(value: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!value || typeof value !== "object") return names;
  const categories = Array.isArray((value as { categories?: unknown }).categories)
    ? (value as { categories: unknown[] }).categories
    : [];
  for (const category of categories) {
    if (!category || typeof category !== "object") continue;
    const object = category as { id?: unknown; name?: unknown; subcategories?: unknown };
    if (object.id !== undefined && typeof object.name === "string") names.set(String(object.id), object.name);
    for (const child of Array.isArray(object.subcategories) ? object.subcategories : []) {
      if (!child || typeof child !== "object") continue;
      const nested = child as { id?: unknown; name?: unknown };
      if (nested.id !== undefined && typeof nested.name === "string") names.set(String(nested.id), nested.name);
    }
  }
  return names;
}

export class SplitwiseImportConnector {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly db: Database,
    private readonly config: SplitwiseOAuthConfig,
    private readonly rootSecret: string,
    options: { fetchFn?: typeof fetch } = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private stateHash(state: string): string {
    return keyedDigest(this.rootSecret, "splitwise-oauth-state", state);
  }

  private encrypt(value: string): string {
    return encryptServerValue(this.rootSecret, "splitwise-access-token", value);
  }

  private decrypt(value: string): string {
    return decryptServerValue(this.rootSecret, "splitwise-access-token", value);
  }

  pruneExpired(now = new Date()): number {
    return this.db.query(
      `UPDATE splitwise_oauth_sessions SET status = 'expired', encrypted_access_token = NULL,
         consumed_at = COALESCE(consumed_at, ?)
       WHERE expires_at <= ? AND status IN ('pending', 'authorized')`,
    ).run(now.toISOString(), now.toISOString()).changes;
  }

  start(actorId: string): { sessionId: string; authorizationUrl: string; expiresAt: string } {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const sessionId = randomUUID();
    const state = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      this.pruneExpired(now);
      this.db.query(
        `INSERT INTO splitwise_oauth_sessions(
           id, actor_id, state_hash, status, created_at, expires_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(sessionId, actorId, this.stateHash(state), now.toISOString(), expiresAt);
    })();
    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.config.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", state);
    return { sessionId, authorizationUrl: authorizationUrl.toString(), expiresAt };
  }

  async complete(state: string, code: string): Promise<{ sessionId: string; actorId: string }> {
    const row = this.db.query<{ id: string; actor_id: string; expires_at: string; status: string }, [string]>(
      `SELECT id, actor_id, expires_at, status FROM splitwise_oauth_sessions
       WHERE state_hash = ? LIMIT 1`,
    ).get(this.stateHash(state));
    if (!row || row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      throw new Error("Splitwise authorization is invalid or expired");
    }
    const claimed = this.db.query(
      `UPDATE splitwise_oauth_sessions SET state_hash = ?
       WHERE id = ? AND state_hash = ? AND status = 'pending' AND expires_at > ?`,
    ).run(
      this.stateHash(randomBytes(32).toString("base64url")),
      row.id,
      this.stateHash(state),
      new Date().toISOString(),
    );
    if (claimed.changes !== 1) throw new Error("Splitwise authorization is invalid or expired");
    const response = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
      }),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok || text.length > 20_000) {
      this.fail(row.id);
      throw new Error("Splitwise did not authorize this import. Connect again or use exported files.");
    }
    let token: unknown;
    try {
      token = (JSON.parse(text) as { access_token?: unknown }).access_token;
    } catch {
      token = undefined;
    }
    if (typeof token !== "string" || token.length < 10 || token.length > 4_096) {
      this.fail(row.id);
      throw new Error("Splitwise returned an invalid access token");
    }
    this.db.query(
      `UPDATE splitwise_oauth_sessions SET status = 'authorized', encrypted_access_token = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(this.encrypt(token), row.id);
    return { sessionId: row.id, actorId: row.actor_id };
  }

  async snapshot(actorId: string, sessionId: string): Promise<Record<string, unknown>> {
    const row = this.db.query<{ encrypted_access_token: string; expires_at: string }, [string, string]>(
      `SELECT encrypted_access_token, expires_at FROM splitwise_oauth_sessions
       WHERE id = ? AND actor_id = ? AND status = 'authorized' LIMIT 1`,
    ).get(sessionId, actorId);
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.fail(sessionId, "expired");
      throw new Error("Splitwise authorization is invalid or expired");
    }
    const accessToken = this.decrypt(row.encrypted_access_token);
    try {
      const [currentUser, groups, friends, categories, currencies] = await Promise.all([
        this.get(accessToken, "/get_current_user"),
        this.get(accessToken, "/get_groups"),
        this.get(accessToken, "/get_friends"),
        this.get(accessToken, "/get_categories"),
        this.get(accessToken, "/get_currencies"),
      ]);
      const expenses: unknown[] = [];
      for (let offset = 0; offset < EXPENSE_LIMIT; offset += 100) {
        const page = await this.get(accessToken, "/get_expenses", { limit: "100", offset: String(offset) });
        const records = page && typeof page === "object" && Array.isArray((page as { expenses?: unknown }).expenses)
          ? (page as { expenses: unknown[] }).expenses
          : [];
        expenses.push(...records);
        if (records.length < 100) break;
      }
      if (expenses.length >= EXPENSE_LIMIT) throw new Error("This Splitwise history exceeds the 100,000-row import limit.");
      const names = categoryNames(categories);
      const enrichedExpenses = expenses.map((expense) => {
        if (!expense || typeof expense !== "object") return expense;
        const object = expense as Record<string, unknown>;
        return { ...object, category_name: names.get(String(object.category_id ?? "")) ?? "Imported" };
      });
      const result: Record<string, unknown> = {
        user: currentUser && typeof currentUser === "object" ? (currentUser as { user?: unknown }).user : undefined,
        groups: groups && typeof groups === "object" ? (groups as { groups?: unknown }).groups : [],
        friends: friends && typeof friends === "object" ? (friends as { friends?: unknown }).friends : [],
        expenses: enrichedExpenses,
        categories: categories && typeof categories === "object" ? (categories as { categories?: unknown }).categories : [],
        currencies: currencies && typeof currencies === "object" ? (currencies as { currencies?: unknown }).currencies : [],
        fetchedAt: new Date().toISOString(),
      };
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > TOTAL_BYTES_LIMIT) {
        throw new Error("This Splitwise history exceeds the 50 MiB import limit.");
      }
      this.db.query(
        `UPDATE splitwise_oauth_sessions SET status = 'normalized', encrypted_access_token = NULL,
           consumed_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), sessionId);
      return result;
    } catch (error) {
      this.fail(sessionId);
      throw error;
    }
  }

  cancel(actorId: string, sessionId: string): void {
    this.db.query(
      `UPDATE splitwise_oauth_sessions SET status = 'cancelled', encrypted_access_token = NULL,
         consumed_at = ?
       WHERE id = ? AND actor_id = ? AND status IN ('pending', 'authorized')`,
    ).run(new Date().toISOString(), sessionId, actorId);
  }

  deny(state: string): boolean {
    if (!state) return false;
    const now = new Date().toISOString();
    return this.db.query(
      `UPDATE splitwise_oauth_sessions SET status = 'cancelled', encrypted_access_token = NULL,
         state_hash = ?, consumed_at = ?
       WHERE state_hash = ? AND status = 'pending' AND expires_at > ?`,
    ).run(
      this.stateHash(randomBytes(32).toString("base64url")),
      now,
      this.stateHash(state),
      now,
    ).changes === 1;
  }

  private fail(sessionId: string, status: "failed" | "expired" = "failed"): void {
    this.db.query(
      `UPDATE splitwise_oauth_sessions SET status = ?, encrypted_access_token = NULL,
         consumed_at = ? WHERE id = ?`,
    ).run(status, new Date().toISOString(), sessionId);
  }

  private async get(accessToken: string, pathname: string, query: Record<string, string> = {}): Promise<unknown> {
    assertSplitwiseReadPath(pathname);
    const url = new URL(`${API_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Splitwise read failed (${response.status})`);
    if (new TextEncoder().encode(text).byteLength > RESPONSE_BYTES_LIMIT) {
      throw new Error("A Splitwise response exceeded the 10 MiB safety limit");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Splitwise returned invalid JSON");
    }
  }
}
