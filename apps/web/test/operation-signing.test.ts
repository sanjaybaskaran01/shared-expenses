import { describe, expect, test } from "bun:test";
import { operationContentHash, type UnsignedOperation } from "@expenses/protocol";
import { signOperation } from "../src/lib/operation-signing";

const operation = {
  id: "operation-1",
  groupId: "group-1",
  actorId: "user-1",
  deviceId: "device-1",
  type: "ExpenseCreated",
  targetId: "expense-1",
  baseVersion: 0,
  clientTimestamp: "2026-08-14T12:00:00.000Z",
  payload: { description: "Ramen", amountMinor: 2_400 },
} satisfies UnsignedOperation;

describe("operation signing", () => {
  test("hashes and signs the canonical operation payload with a base64url signature", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const signed = await signOperation(operation, keyPair.privateKey);

    expect(signed.contentHash).toBe(await operationContentHash(operation));
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const signature = Uint8Array.from(
      atob(signed.signature.replace(/-/g, "+").replace(/_/g, "/")),
      (character) => character.charCodeAt(0),
    );
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      signature,
      new TextEncoder().encode(signed.contentHash),
    )).toBe(true);
  });
});
