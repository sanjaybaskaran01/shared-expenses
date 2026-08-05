import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canCreateTalliedAccount, createAuth, deriveDisplayNameFromEmail } from "../src/auth";
import {
  resolveGoogleAuthConfig,
  resolvePublicRateKey,
  resolveSplitwiseOAuthConfig,
  validateProductionAuthSecret,
  type AppConfig,
} from "../src/config";
import { ContactInviteStore } from "../src/contact-invites";
import { keyedDigest } from "../src/security-keys";

function testConfig(googleAuth?: AppConfig["googleAuth"]): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    attachmentsPath: "/tmp/tally-test-attachments",
    webOrigin: "http://localhost:5173",
    publicApiUrl: "http://localhost:3000",
    authSecret: "test-only-auth-secret-not-for-production",
    devAuthBypass: false,
    trustCloudflareProxy: false,
    ownerEmail: "owner@example.com",
    ...(googleAuth ? { googleAuth } : {}),
    bootstrapGroupName: "Test group",
    smtp: {
      enabled: false,
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "test@example.com",
    },
  };
}

describe("invitation display names", () => {
  test("derives a readable name from the only required field", () => {
    expect(deriveDisplayNameFromEmail("sam.jones+trip@example.com")).toBe("Sam Jones Trip");
    expect(deriveDisplayNameFromEmail("alex-doe@example.com")).toBe("Alex Doe");
  });

  test("uses a safe fallback", () => {
    expect(deriveDisplayNameFromEmail("@example.com")).toBe("Friend");
  });
});

describe("public rate-limit identity", () => {
  test("ignores a forged Cloudflare header unless the proxy is explicitly trusted", () => {
    expect(resolvePublicRateKey({ cloudflareIp: "203.0.113.9", trustCloudflareProxy: false, production: true })).toBe("unidentified");
    expect(resolvePublicRateKey({ cloudflareIp: "203.0.113.9", trustCloudflareProxy: true, production: true })).toBe("203.0.113.9");
  });
});

describe("Google authentication configuration", () => {
  test("stays disabled when no credentials are configured", () => {
    expect(resolveGoogleAuthConfig(undefined, undefined)).toBeUndefined();
    expect(resolveGoogleAuthConfig("", "")).toBeUndefined();
  });

  test("requires the client id and secret as a pair", () => {
    expect(() => resolveGoogleAuthConfig("client-id", undefined)).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
    expect(() => resolveGoogleAuthConfig(undefined, "not-a-real-google-client-secret")).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  });

  test("normalizes a complete credential pair", () => {
    expect(resolveGoogleAuthConfig(" client-id ", " not-a-real-google-client-secret ")).toEqual({
      clientId: "client-id",
      clientSecret: "not-a-real-google-client-secret",
    });
  });

  test("registers Google with encrypted OAuth token storage", () => {
    const database = new Database(":memory:");
    const config = testConfig({ clientId: "client-id", clientSecret: "not-a-real-google-client-secret" });
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: config.authSecret });
    const auth = createAuth(database, config, contactInvites);
    expect(auth.options.socialProviders?.google?.clientId).toBe("client-id");
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    database.close();
  });
});

describe("production authentication secret", () => {
  test("rejects empty, short, and example secrets", () => {
    expect(() => validateProductionAuthSecret("")).toThrow();
    expect(() => validateProductionAuthSecret("too-short")).toThrow();
    expect(() => validateProductionAuthSecret("development-only-secret-change-before-production")).toThrow();
    expect(() => validateProductionAuthSecret("replace-with-at-least-32-random-characters")).toThrow();
    expect(() => validateProductionAuthSecret("example-secret-that-is-intentionally-long-enough")).toThrow();
    expect(() => validateProductionAuthSecret("test-only-auth-secret-not-for-production")).toThrow();
  });

  test("accepts a sufficiently long non-example secret", () => {
    expect(() => validateProductionAuthSecret("a-secure-random-value-that-is-long-enough")).not.toThrow();
  });
});

describe("migration-claim account gate", () => {
  test("allows only the email currently reserved by a valid claim", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE group_members (email TEXT, status TEXT NOT NULL);
      CREATE TABLE contact_invitations (
        status TEXT NOT NULL, reserved_email_hash TEXT,
        reservation_expires_at TEXT, expires_at TEXT NOT NULL
      );
      CREATE TABLE imported_identities (
        status TEXT NOT NULL, reserved_email_hash TEXT,
        reservation_expires_at TEXT, claim_expires_at TEXT
      );
    `);
    const config = testConfig();
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: config.authSecret });
    const email = "new-friend@example.com";
    const emailHash = keyedDigest(config.authSecret, "identity-email", email);
    database.query(
      `INSERT INTO imported_identities(
         status, reserved_email_hash, reservation_expires_at, claim_expires_at
       ) VALUES ('reserved', ?, '2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z')`,
    ).run(emailHash);

    expect(canCreateTalliedAccount(database, config, contactInvites, email)).toBe(true);
    expect(canCreateTalliedAccount(database, config, contactInvites, "forwarded@example.com")).toBe(false);
    database.query("UPDATE imported_identities SET reservation_expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect(canCreateTalliedAccount(database, config, contactInvites, email)).toBe(false);
    database.close();
  });
});

describe("Splitwise API approval gate", () => {
  test("stays disabled even when credentials exist without written approval", () => {
    expect(resolveSplitwiseOAuthConfig({
      approved: false,
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/callback",
    })).toBeUndefined();
  });

  test("requires a complete approved configuration", () => {
    expect(() => resolveSplitwiseOAuthConfig({ approved: true, clientId: "client-id" })).toThrow(
      "required after approval",
    );
  });

  test("accepts an approved HTTPS callback", () => {
    expect(resolveSplitwiseOAuthConfig({
      approved: true,
      clientId: " client-id ",
      clientSecret: " client-secret ",
      redirectUri: " https://expenses.example.com/api/v1/imports/splitwise/callback ",
    })).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://expenses.example.com/api/v1/imports/splitwise/callback",
    });
  });

  test("rejects callback URLs with a wrong path, credentials, query, or fragment", () => {
    const base = { approved: true, clientId: "client-id", clientSecret: "client-secret" };
    for (const redirectUri of [
      "https://expenses.example.com/callback",
      "https://user:pass@expenses.example.com/api/v1/imports/splitwise/callback",
      "https://expenses.example.com/api/v1/imports/splitwise/callback?next=evil",
      "https://expenses.example.com/api/v1/imports/splitwise/callback#fragment",
    ]) {
      expect(() => resolveSplitwiseOAuthConfig({ ...base, redirectUri })).toThrow("exact Tallied callback");
    }
  });
});
