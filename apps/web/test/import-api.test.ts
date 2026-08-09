import { afterEach, describe, expect, test } from "bun:test";
import type { ImportBatchCommitRequest, OperationEnvelope } from "@expenses/protocol";
import { activateStagedImport, stageImport } from "../src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("prepared import API", () => {
  test("encrypted-stages every operation without activating before final review", async () => {
    const operations: OperationEnvelope[] = ["GroupCreated", "ExpenseCreated"].map((type, index) => ({
      id: `operation-${index}`,
      groupId: "group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: type as OperationEnvelope["type"],
      targetId: index === 0 ? "group-1" : "expense-1",
      baseVersion: 0,
      clientTimestamp: "2026-08-04T12:00:00.000Z",
      payload: {},
      contentHash: "a".repeat(64),
      signature: "signed",
    }));
    const body = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "splitwise",
      mode: "history",
      fingerprint: "b".repeat(64),
      sourceHashes: [],
      selectedSourceGroups: ["source-group"],
      identities: [],
      operations,
      operationLinks: operations.map((operation, index) => ({
        operationId: operation.id,
        externalType: index === 0 ? "group" as const : "record" as const,
        externalId: `source-${index}`,
        ...(index === 1 ? { dedupeStrategy: "provider_id" as const, semanticId: "c".repeat(64) } : {}),
      })),
      sourceBalances: [],
      reconciliation: {
        zeroSum: true,
        lines: [],
        participantTotals: [],
        groupTotals: [],
        blockingWarnings: [],
        groupCount: 1,
        recordCount: 1,
      },
      warnings: [],
    } satisfies ImportBatchCommitRequest;
    const paths: string[] = [];
    let stageBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/v1/imports/stage") {
        stageBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          batchId: body.id,
          expectedOperationCount: 2,
          receivedOperationCount: 0,
          status: "staging",
          expiresAt: "2026-08-05T12:00:00.000Z",
          missingRanges: [{ start: 0, endExclusive: 2 }],
        });
      }
      if (path.endsWith("/chunks")) {
        return response({
          batchId: body.id,
          expectedOperationCount: 2,
          receivedOperationCount: 2,
          status: "ready",
          expiresAt: "2026-08-05T12:00:00.000Z",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const progress: Array<[number, number]> = [];

    await expect(stageImport(body, (completed, total) => progress.push([completed, total]))).resolves.toEqual(
      expect.objectContaining({ status: "ready", receivedOperationCount: 2 }),
    );
    expect(paths).toEqual(["/api/v1/imports/stage", `/api/v1/imports/${body.id}/chunks`]);
    expect(paths.some((path) => path.endsWith("/activate"))).toBe(false);
    expect(progress).toEqual([[0, 2], [2, 2]]);
    expect(stageBody?.preparationHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("cancels and restarts a stale preparation instead of mixing its chunks", async () => {
    const operation = {
      id: "operation-1",
      groupId: "group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "GroupCreated",
      targetId: "group-1",
      baseVersion: 0,
      clientTimestamp: "2026-08-04T12:00:00.000Z",
      payload: {},
      contentHash: "a".repeat(64),
      signature: "signed",
    } satisfies OperationEnvelope;
    const body = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "splitwise",
      mode: "history",
      fingerprint: "b".repeat(64),
      sourceHashes: [],
      selectedSourceGroups: ["source-group"],
      identities: [],
      operations: [operation],
      operationLinks: [{ operationId: operation.id, externalType: "group", externalId: "source-group" }],
      sourceBalances: [],
      reconciliation: {
        zeroSum: true,
        lines: [],
        participantTotals: [],
        groupTotals: [],
        blockingWarnings: [],
        groupCount: 1,
        personCount: 0,
        recordCount: 0,
        duplicateCount: 0,
        unresolvedPeople: 0,
        malformedRecords: 0,
      },
      warnings: [],
    } satisfies ImportBatchCommitRequest;
    const paths: string[] = [];
    let starts = 0;
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/v1/imports/stage" && starts++ === 0) {
        return response({ error: { message: "The prepared import changed. Cancel the earlier upload and start again." } }, 400);
      }
      if (path.endsWith("/cancel")) return response({ status: "cancelled" });
      if (path === "/api/v1/imports/stage") return response({
        batchId: body.id,
        expectedOperationCount: 1,
        receivedOperationCount: 1,
        status: "ready",
        expiresAt: "2026-08-05T12:00:00.000Z",
        missingRanges: [],
      });
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    await expect(stageImport(body)).resolves.toEqual(expect.objectContaining({ status: "ready" }));
    expect(paths).toEqual([
      "/api/v1/imports/stage",
      `/api/v1/imports/${body.id}/cancel`,
      "/api/v1/imports/stage",
    ]);
  });

  test("activates only the already prepared batch", async () => {
    const batchId = "11111111-1111-4111-8111-111111111111";
    globalThis.fetch = (async (input) => {
      expect(new URL(String(input)).pathname).toBe(`/api/v1/imports/${batchId}/activate`);
      return response({
        batch: {
          id: batchId,
          provider: "splitwise",
          mode: "history",
          status: "completed",
          rollbackStatus: "available",
          startedAt: "2026-08-04T12:00:00.000Z",
          groupCount: 1,
          recordCount: 1,
          warningCount: 0,
        },
        duplicate: false,
        accepted: [],
      });
    }) as typeof fetch;

    await expect(activateStagedImport(batchId)).resolves.toEqual(expect.objectContaining({ duplicate: false }));
  });
});
