import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/database";
import { assertSplitwiseReadPath, SplitwiseImportConnector } from "../src/splitwise-import";

const config = {
  clientId: "approved-client",
  clientSecret: "approved-secret",
  redirectUri: "https://expenses.example.com/api/v1/imports/splitwise/callback",
};

describe("approval-gated Splitwise connector", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/001_domain.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/005_imports.sql"), "utf8"));
  });

  afterEach(() => db.close());

  test("creates a short-lived state-bound authorization without exposing the client secret", () => {
    const connector = new SplitwiseImportConnector(db, config, "test-secret");
    const started = connector.start("user-1");
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://secure.splitwise.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("approved-client");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toHaveLength(43);
    expect(started.authorizationUrl).not.toContain("approved-secret");
    const stored = db.query<{ state_hash: string; encrypted_access_token: string | null }, [string]>(
      "SELECT state_hash, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(started.sessionId)!;
    expect(stored.state_hash).not.toBe(url.searchParams.get("state"));
    expect(stored.encrypted_access_token).toBeNull();
  });

  test("uses only read endpoints and erases the token immediately after one snapshot", async () => {
    const calls: Array<{ method: string; url: string; authorization: string | null }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      calls.push({
        method: init?.method ?? "GET",
        url: url.toString(),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "ephemeral-access-token" });
      if (url.pathname.endsWith("/get_current_user")) {
        return Response.json({ user: { id: 1, first_name: "Sam", last_name: "Lee", email: "sam@example.com" } });
      }
      if (url.pathname.endsWith("/get_groups")) return Response.json({ groups: [{ id: 9, name: "Goa", members: [] }] });
      if (url.pathname.endsWith("/get_friends")) return Response.json({ friends: [] });
      if (url.pathname.endsWith("/get_categories")) {
        return Response.json({ categories: [{ id: 5, name: "Food", subcategories: [{ id: 15, name: "Dining out" }] }] });
      }
      if (url.pathname.endsWith("/get_currencies")) return Response.json({ currencies: [{ currency_code: "USD" }] });
      if (url.pathname.endsWith("/get_expenses")) {
        return Response.json({
          expenses: [{
            id: 10,
            group_id: 9,
            cost: "12.00",
            currency_code: "USD",
            category_id: 15,
            description: "Ramen",
            users: [],
          }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const connector = new SplitwiseImportConnector(db, config, "test-secret", { fetchFn: fakeFetch });
    const started = connector.start("user-1");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completed = await connector.complete(state, "authorization-code");
    expect(connector.complete(state, "replayed-code")).rejects.toThrow("invalid or expired");
    expect(connector.snapshot("attacker", completed.sessionId)).rejects.toThrow("invalid or expired");
    const snapshot = await connector.snapshot("user-1", completed.sessionId);
    expect((snapshot.expenses as Array<{ category_name: string }>)[0]?.category_name).toBe("Dining out");
    expect(calls[0]).toEqual(expect.objectContaining({ method: "POST", authorization: null }));
    expect(calls.slice(1).every((call) => call.method === "GET")).toBe(true);
    expect(calls.slice(1).every((call) => call.authorization === "Bearer ephemeral-access-token")).toBe(true);
    expect(calls.slice(1).every((call) => call.url.startsWith("https://secure.splitwise.com/api/v3.0/"))).toBe(true);
    expect(db.query<{ status: string; encrypted_access_token: string | null }, [string]>(
      "SELECT status, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(completed.sessionId)).toEqual({ status: "normalized", encrypted_access_token: null });
    expect(connector.snapshot("user-1", completed.sessionId)).rejects.toThrow("invalid or expired");
  });

  test("clears authorization after a failed provider read", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "ephemeral-access-token" });
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const connector = new SplitwiseImportConnector(db, config, "test-secret", { fetchFn: fakeFetch });
    const started = connector.start("user-1");
    const completed = await connector.complete(new URL(started.authorizationUrl).searchParams.get("state")!, "code");
    expect(connector.snapshot("user-1", completed.sessionId)).rejects.toThrow("Splitwise read failed");
    expect(db.query<{ status: string; encrypted_access_token: string | null }, [string]>(
      "SELECT status, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(completed.sessionId)).toEqual({ status: "failed", encrypted_access_token: null });
  });

  test("periodic cleanup erases expired authorization even without another OAuth start", () => {
    const connector = new SplitwiseImportConnector(db, config, "test-secret");
    const started = connector.start("user-1");
    db.query(
      `UPDATE splitwise_oauth_sessions SET status = 'authorized', encrypted_access_token = ?, expires_at = ?
       WHERE id = ?`,
    ).run("must-be-erased", "2020-01-01T00:00:00.000Z", started.sessionId);
    expect(connector.pruneExpired()).toBe(1);
    expect(db.query<{ status: string; encrypted_access_token: string | null }, [string]>(
      "SELECT status, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(started.sessionId)).toEqual({ status: "expired", encrypted_access_token: null });
  });

  test("provider denial consumes the state and retains no authorization", async () => {
    const connector = new SplitwiseImportConnector(db, config, "test-secret");
    const started = connector.start("user-1");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(connector.deny(state)).toBe(true);
    expect(connector.deny(state)).toBe(false);
    expect(connector.complete(state, "late-code")).rejects.toThrow("invalid or expired");
    expect(db.query<{ status: string; encrypted_access_token: string | null }, [string]>(
      "SELECT status, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(started.sessionId)).toEqual({ status: "cancelled", encrypted_access_token: null });
  });

  test("owner cancellation erases an authorized token and a different account cannot cancel it", async () => {
    const fakeFetch = (async () => Response.json({ access_token: "ephemeral-access-token" })) as unknown as typeof fetch;
    const connector = new SplitwiseImportConnector(db, config, "test-secret", { fetchFn: fakeFetch });
    const started = connector.start("user-1");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completed = await connector.complete(state, "code");
    connector.cancel("attacker", completed.sessionId);
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(completed.sessionId)?.status).toBe("authorized");
    connector.cancel("user-1", completed.sessionId);
    expect(db.query<{ status: string; encrypted_access_token: string | null }, [string]>(
      "SELECT status, encrypted_access_token FROM splitwise_oauth_sessions WHERE id = ?",
    ).get(completed.sessionId)).toEqual({ status: "cancelled", encrypted_access_token: null });
  });

  test("refuses any write or undocumented path", () => {
    expect(() => assertSplitwiseReadPath("/get_expenses")).not.toThrow();
    expect(() => assertSplitwiseReadPath("/create_expense")).toThrow("only permits documented read endpoints");
    expect(() => assertSplitwiseReadPath("https://attacker.invalid/get_expenses")).toThrow();
  });
});
