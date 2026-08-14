import { describe, expect, test } from "bun:test";
import type { ServerConfig, TalliedAuth } from "../src/api-context";
import { createApiHttp } from "../src/api-http";

function http() {
  return createApiHttp({
    nodeEnv: "test",
    webOrigin: "http://localhost:5173",
    trustCloudflareProxy: false,
    trustedProxies: [],
  } as unknown as ServerConfig, {} as TalliedAuth);
}

describe("API JSON request parsing", () => {
  test("accepts a JSON object", async () => {
    await expect(http().bodyJson<{ operation: string }>(new Request("https://api.example.com", {
      method: "POST",
      body: JSON.stringify({ operation: "sync" }),
    }))).resolves.toEqual({ operation: "sync" });
  });

  test("rejects scalar and array JSON before a route can dereference it", async () => {
    for (const body of ["null", "true", "[]", '"unexpected"', "42"]) {
      await expect(http().bodyJson(new Request("https://api.example.com", { method: "POST", body })))
        .rejects.toThrow("Request body must be a JSON object");
    }
  });
});
