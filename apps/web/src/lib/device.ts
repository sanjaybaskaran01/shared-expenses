import { localDb, type DeviceRecord } from "./db";
import { generateAgreementKeyPair } from "./confidential";

export { signOperation } from "./operation-signing";

export async function ensureDevice(actorId?: string): Promise<DeviceRecord> {
  const existing = await localDb.devices.get("current");
  if (existing) {
    if (!existing.agreementPrivateKey || !existing.agreementPublicKeyJwk) {
      const agreement = await generateAgreementKeyPair();
      const upgraded = {
        ...existing,
        agreementPrivateKey: agreement.privateKey,
        agreementPublicKeyJwk: agreement.publicKeyJwk,
      };
      await localDb.devices.put(upgraded);
      return upgraded;
    }
    if (actorId && existing.actorId === "pending-authentication") {
      const rebound = { ...existing, actorId };
      await localDb.devices.put(rebound);
      return rebound;
    }
    if (actorId && existing.actorId !== actorId) {
      throw new Error("This device has saved data for another account. Sign out of that account and clear its local data first.");
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
  const agreement = await generateAgreementKeyPair();
  const record: DeviceRecord = {
    id: "current",
    deviceId: crypto.randomUUID(),
    actorId: actorId ?? (import.meta.env.DEV ? "dev-user" : "pending-authentication"),
    privateKey,
    publicKeyJwk,
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKeyJwk: agreement.publicKeyJwk,
  };
  await localDb.devices.add(record);
  return record;
}
