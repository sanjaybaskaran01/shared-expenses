import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAuth, deriveDisplayNameFromEmail } from "../src/auth";
import { resolveGoogleAuthConfig, type AppConfig } from "../src/config";

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
    ownerEmail: "owner@example.com",
    ...(googleAuth ? { googleAuth } : {}),
    bootstrapGroupName: "Test group",
    smtp: {
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

describe("Google authentication configuration", () => {
  test("stays disabled when no credentials are configured", () => {
    expect(resolveGoogleAuthConfig(undefined, undefined)).toBeUndefined();
    expect(resolveGoogleAuthConfig("", "")).toBeUndefined();
  });

  test("requires the client id and secret as a pair", () => {
    expect(() => resolveGoogleAuthConfig("client-id", undefined)).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
    expect(() => resolveGoogleAuthConfig(undefined, "client-secret")).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  });

  test("normalizes a complete credential pair", () => {
    expect(resolveGoogleAuthConfig(" client-id ", " client-secret ")).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  });

  test("registers Google with encrypted OAuth token storage", () => {
    const database = new Database(":memory:");
    const auth = createAuth(database, testConfig({ clientId: "client-id", clientSecret: "client-secret" }));
    expect(auth.options.socialProviders?.google?.clientId).toBe("client-id");
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    database.close();
  });
});
