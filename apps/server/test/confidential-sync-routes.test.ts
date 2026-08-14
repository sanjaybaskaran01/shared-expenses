import { describe, expect, test } from "bun:test";
import type { ApiContext } from "../src/api-context";
import { handleSyncRoutes } from "../src/routes/sync";

function testContext(experimentalConfidentialSync: boolean): {
  context: ApiContext;
  pullCalls: () => number;
} {
  let pulls = 0;
  return {
    context: {
      config: { experimentalConfidentialSync },
      http: {
        json: (_request: Request, value: unknown, status = 200) => Response.json(value, { status }),
        error: (_request: Request, status: number, code: string, message: string) =>
          Response.json({ error: { code, message } }, { status }),
      },
      confidentialLedger: {
        pull: () => {
          pulls += 1;
          return [{ id: "confidential-operation" }];
        },
        latestSequenceFor: () => 7,
      },
    } as unknown as ApiContext,
    pullCalls: () => pulls,
  };
}

async function requestRoute(context: ApiContext, path: string): Promise<Response> {
  const request = new Request(`https://api.example.test${path}`);
  const response = await handleSyncRoutes(context, {
    request,
    url: new URL(request.url),
    peerAddress: "127.0.0.1",
    actorId: "verified-user",
  });
  if (!(response instanceof Response)) throw new Error(`No response for ${path}`);
  return response;
}

describe("experimental confidential sync routes", () => {
  test("returns a generic 404 and does not touch confidential storage while disabled", async () => {
    const { context, pullCalls } = testContext(false);

    const response = await requestRoute(context, "/api/v2/sync/pull");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    expect(pullCalls()).toBe(0);
  });

  test("keeps the confidential pull route available after explicit opt-in", async () => {
    const { context, pullCalls } = testContext(true);

    const response = await requestRoute(context, "/api/v2/sync/pull?after=4");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operations: [{ id: "confidential-operation" }],
      latestServerSequence: 7,
    });
    expect(pullCalls()).toBe(1);
  });
});
