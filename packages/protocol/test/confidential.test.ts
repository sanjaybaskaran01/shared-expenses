import { describe, expect, test } from "bun:test";
import {
  confidentialOperationContentHash,
  type UnsignedConfidentialOperation,
} from "../src/confidential";

describe("confidential operation envelopes", () => {
  test("bind the ciphertext and routing metadata into one deterministic hash", async () => {
    const operation: UnsignedConfidentialOperation = {
      version: 1,
      id: "op-1",
      groupId: "group-1",
      actorId: "alice",
      deviceId: "alice-phone",
      keyEpoch: 2,
      clientTimestamp: "2026-07-28T12:00:00.000Z",
      iv: "aXY",
      ciphertext: "Y2lwaGVydGV4dA",
    };
    const original = await confidentialOperationContentHash(operation);
    const changed = await confidentialOperationContentHash({ ...operation, keyEpoch: 3 });
    expect(original).toHaveLength(64);
    expect(changed).not.toBe(original);
  });
});
