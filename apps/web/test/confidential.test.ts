import { describe, expect, test } from "bun:test";
import {
  decryptLedgerPayload,
  createConfidentialOperation,
  encryptLedgerPayload,
  generateAgreementKeyPair,
  generateGroupKeyMaterial,
  importGroupKey,
  unwrapGroupKey,
  wrapGroupKey,
} from "../src/lib/confidential";

describe("client-side confidential ledger primitives", () => {
  test("wraps a group key to a device and encrypts an authenticated payload", async () => {
    const recipient = await generateAgreementKeyPair();
    const material = generateGroupKeyMaterial();
    const envelope = await wrapGroupKey({
      groupId: "group-1",
      keyEpoch: 1,
      recipientDeviceId: "bob-phone",
      senderDeviceId: "alice-phone",
      recipientPublicKeyJwk: recipient.publicKeyJwk,
      groupKeyMaterial: material,
    });
    const unwrapped = await unwrapGroupKey(envelope, recipient.privateKey);
    expect([...unwrapped]).toEqual([...material]);

    const key = await importGroupKey(unwrapped);
    const metadata = { groupId: "group-1", keyEpoch: 1, id: "op-1" };
    const encrypted = await encryptLedgerPayload(key, { amountMinor: 5_550, for: "Ramen" }, metadata);
    expect(encrypted.ciphertext).not.toContain("Ramen");
    expect(await decryptLedgerPayload(key, encrypted, metadata)).toEqual({ amountMinor: 5_550, for: "Ramen" });
    await expect(decryptLedgerPayload(key, encrypted, { ...metadata, keyEpoch: 2 })).rejects.toThrow();

    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const operation = await createConfidentialOperation({
      id: "op-1",
      groupId: "group-1",
      actorId: "alice",
      deviceId: "alice-phone",
      keyEpoch: 1,
      clientTimestamp: "2026-07-28T12:00:00.000Z",
      payload: { amountMinor: 5_550, for: "Ramen" },
      groupKey: key,
      signingPrivateKey: signing.privateKey,
    });
    expect(operation.contentHash).toHaveLength(64);
    expect(operation.signature.length).toBeGreaterThan(40);
  });
});
