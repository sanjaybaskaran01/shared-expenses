import { canonicalJson, sha256Hex, type JsonValue } from "./canonical";

export interface ConfidentialOperationEnvelope {
  version: 1;
  id: string;
  groupId: string;
  actorId: string;
  deviceId: string;
  keyEpoch: number;
  clientTimestamp: string;
  iv: string;
  ciphertext: string;
  contentHash: string;
  signature: string;
  serverSequence?: number;
  receivedAt?: string;
}

export type UnsignedConfidentialOperation = Omit<
  ConfidentialOperationEnvelope,
  "contentHash" | "signature"
>;

export interface GroupKeyEnvelope {
  version: 1;
  groupId: string;
  keyEpoch: number;
  recipientDeviceId: string;
  senderDeviceId: string;
  ephemeralPublicKeyJwk: JsonWebKey;
  salt: string;
  iv: string;
  ciphertext: string;
  contentHash: string;
  signature: string;
}

export type UnsignedGroupKeyEnvelope = Omit<GroupKeyEnvelope, "contentHash" | "signature">;

export function confidentialOperationSigningValue(
  operation: UnsignedConfidentialOperation | ConfidentialOperationEnvelope,
): JsonValue {
  return {
    actorId: operation.actorId,
    ciphertext: operation.ciphertext,
    clientTimestamp: operation.clientTimestamp,
    deviceId: operation.deviceId,
    groupId: operation.groupId,
    id: operation.id,
    iv: operation.iv,
    keyEpoch: operation.keyEpoch,
    version: operation.version,
  };
}

export function groupKeyEnvelopeSigningValue(
  envelope: UnsignedGroupKeyEnvelope | GroupKeyEnvelope,
): JsonValue {
  return {
    ciphertext: envelope.ciphertext,
    ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk as JsonValue,
    groupId: envelope.groupId,
    iv: envelope.iv,
    keyEpoch: envelope.keyEpoch,
    recipientDeviceId: envelope.recipientDeviceId,
    salt: envelope.salt,
    senderDeviceId: envelope.senderDeviceId,
    version: envelope.version,
  };
}

export function confidentialOperationContentHash(
  operation: UnsignedConfidentialOperation,
): Promise<string> {
  return sha256Hex(canonicalJson(confidentialOperationSigningValue(operation)));
}

export function groupKeyEnvelopeContentHash(envelope: UnsignedGroupKeyEnvelope): Promise<string> {
  return sha256Hex(canonicalJson(groupKeyEnvelopeSigningValue(envelope)));
}
