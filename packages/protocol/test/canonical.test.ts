import { expect, test } from "bun:test";
import { canonicalJson, operationContentHash } from "../src";

test("canonical JSON sorts object keys recursively", () => {
  expect(canonicalJson({ z: 1, a: { y: true, b: "ok" } })).toBe(
    '{"a":{"b":"ok","y":true},"z":1}',
  );
});

test("operation content hash ignores object key insertion order", async () => {
  const base = {
    id: "op-1",
    groupId: "group-1",
    actorId: "user-1",
    deviceId: "device-1",
    type: "ExpenseCreated" as const,
    targetId: "expense-1",
    baseVersion: 0,
    clientTimestamp: "2026-07-25T00:00:00.000Z",
  };
  const first = await operationContentHash({ ...base, payload: { b: 2, a: 1 } });
  const second = await operationContentHash({ ...base, payload: { a: 1, b: 2 } });
  expect(first).toBe(second);
});
