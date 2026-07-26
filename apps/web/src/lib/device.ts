import { operationContentHash, type JsonValue, type OperationEnvelope, type UnsignedOperation } from "@expenses/protocol";
import { localDb, type DeviceRecord } from "./db";

function encodeBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function ensureDevice(actorId?: string): Promise<DeviceRecord> {
  const existing = await localDb.devices.get("current");
  if (existing) {
    if (actorId && existing.actorId === "pending-authentication") {
      const rebound = { ...existing, actorId };
      await localDb.devices.put(rebound);
      return rebound;
    }
    if (actorId && existing.actorId !== actorId) {
      throw new Error("This device contains another account's local ledger. Sign out and clear local data first.");
    }
    return existing;
  }

  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const record: DeviceRecord = {
    id: "current",
    deviceId: crypto.randomUUID(),
    actorId: actorId ?? (import.meta.env.DEV ? "dev-user" : "pending-authentication"),
    privateKey,
    publicKeyJwk,
  };
  await localDb.devices.add(record);
  return record;
}

export async function signOperation<TPayload extends JsonValue>(
  operation: UnsignedOperation<TPayload>,
  privateKey: CryptoKey,
): Promise<OperationEnvelope<TPayload>> {
  const contentHash = await operationContentHash(operation);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(contentHash),
  );
  return { ...operation, contentHash, signature: encodeBase64Url(signature) };
}
