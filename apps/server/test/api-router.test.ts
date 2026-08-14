import { describe, expect, test } from "bun:test";
import type { ApiContext } from "../src/api-context";
import { createApiRouter } from "../src/api-router";

function testContext(options: {
  requireActor?: ApiContext["http"]["requireActor"];
  onAuthDispatch?: () => void;
} = {}): ApiContext {
  const corsHeaders = () => ({
    "Access-Control-Allow-Origin": "https://app.example.com",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });
  return {
    config: {
      nodeEnv: "test",
      experimentalConfidentialSync: false,
      trustCloudflareProxy: false,
      trustedProxies: [],
    },
    releaseMetadata: { version: "0.1.0", commit: "development", builtAt: "1970-01-01T00:00:00.000Z" },
    auth: {
      handler: async () => {
        options.onAuthDispatch?.();
        return Response.json({ session: null });
      },
    },
    http: {
      corsHeaders,
      securityHeaders: () => ({ "X-Content-Type-Options": "nosniff" }),
      json: (_request: Request, value: unknown, status = 200) => Response.json(value, { status }),
      error: (_request: Request, status: number, code: string, message: string) =>
        Response.json({ error: { code, message } }, { status }),
      requireActor: options.requireActor ?? (async (request) =>
        Response.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, { status: 401 })),
    },
  } as unknown as ApiContext;
}

describe("API router trust boundary", () => {
  test("handles Better Auth preflights before auth dispatch", async () => {
    let authDispatched = false;
    const context = testContext({ onAuthDispatch: () => { authDispatched = true; } });
    const router = createApiRouter(context);
    const request = new Request("https://api.example.com/api/auth/sign-in/social", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });

    const response = await router(request, new URL(request.url), "127.0.0.1");

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Dev-User");
    expect(authDispatched).toBe(false);
  });

  test("allows only the explicit public and auth handlers before the actor gate", async () => {
    let actorChecks = 0;
    let authDispatched = false;
    const context = testContext({
      onAuthDispatch: () => { authDispatched = true; },
      requireActor: async () => {
        actorChecks += 1;
        return Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
      },
    });
    const router = createApiRouter(context);

    const health = new Request("https://api.example.com/health");
    expect((await router(health, new URL(health.url), "127.0.0.1")).status).toBe(200);
    const auth = new Request("https://api.example.com/api/auth/get-session");
    expect((await router(auth, new URL(auth.url), "127.0.0.1")).status).toBe(200);
    expect(authDispatched).toBe(true);
    expect(actorChecks).toBe(0);

    for (const path of [
      "/api/v1/snapshot",
      "/api/v1/imports",
      "/api/v1/notifications/read",
      "/api/v1/feedback",
      "/api/v1/groups/example/invitations",
      "/api/v1/unknown",
    ]) {
      const request = new Request(`https://api.example.com${path}`, { method: path.endsWith("snapshot") || path.endsWith("imports") ? "GET" : "POST" });
      expect((await router(request, new URL(request.url), "127.0.0.1")).status).toBe(401);
    }
    expect(actorChecks).toBe(6);
  });

  test("keeps disabled experimental confidential routes unavailable before the actor gate", async () => {
    let actorChecks = 0;
    const context = testContext({
      requireActor: async () => {
        actorChecks += 1;
        return "verified-user";
      },
    });
    const router = createApiRouter(context);
    const request = new Request("https://api.example.com/api/v2/sync/pull");

    const response = await router(request, new URL(request.url), "127.0.0.1");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    expect(actorChecks).toBe(0);
  });

  test("returns not found only after an authenticated unknown route passes the gate", async () => {
    let actorChecks = 0;
    const context = testContext({
      requireActor: async () => {
        actorChecks += 1;
        return "verified-user";
      },
    });
    const router = createApiRouter(context);
    const request = new Request("https://api.example.com/api/v1/unknown");

    const response = await router(request, new URL(request.url), "127.0.0.1");

    expect(response.status).toBe(404);
    expect(actorChecks).toBe(1);
  });
});
