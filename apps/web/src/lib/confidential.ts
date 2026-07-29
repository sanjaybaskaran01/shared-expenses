import {
  canonicalJson,
  confidentialOperationContentHash,
  groupKeyEnvelopeContentHash,
  type ConfidentialOperationEnvelope,
  type GroupKeyEnvelope,
  type JsonValue,
  type UnsignedConfidentialOperation,
  type UnsignedGroupKeyEnvelope,
} from "@expenses/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer as ArrayBuffer;
}

function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function signHash(contentHash: string, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(contentHash),
  );
  return toBase64Url(signature);
}

function keyContext(groupId: string, keyEpoch: number, recipientDeviceId: string): Uint8Array {
  return encoder.encode(`tally/group-key/v1/${groupId}/${keyEpoch}/${recipientDeviceId}`);
}

export async function generateAgreementKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKeyJwk };
}

export function generateGroupKeyMaterial(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importGroupKey(keyMaterial: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asArrayBuffer(keyMaterial), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  context: Uint8Array,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: asArrayBuffer(context) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapGroupKey(input: {
  groupId: string;
  keyEpoch: number;
  recipientDeviceId: string;
  senderDeviceId: string;
  recipientPublicKeyJwk: JsonWebKey;
  groupKeyMaterial: Uint8Array;
}): Promise<UnsignedGroupKeyEnvelope> {
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const recipientPublicKey = await crypto.subtle.importKey(
    "jwk",
    input.recipientPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const context = keyContext(input.groupId, input.keyEpoch, input.recipientDeviceId);
  const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, recipientPublicKey, salt, context);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(context) },
    wrappingKey,
    asArrayBuffer(input.groupKeyMaterial),
  );
  return {
    version: 1,
    groupId: input.groupId,
    keyEpoch: input.keyEpoch,
    recipientDeviceId: input.recipientDeviceId,
    senderDeviceId: input.senderDeviceId,
    ephemeralPublicKeyJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

export async function signGroupKeyEnvelope(
  envelope: UnsignedGroupKeyEnvelope,
  signingPrivateKey: CryptoKey,
): Promise<GroupKeyEnvelope> {
  const contentHash = await groupKeyEnvelopeContentHash(envelope);
  return {
    ...envelope,
    contentHash,
    signature: await signHash(contentHash, signingPrivateKey),
  };
}

export async function unwrapGroupKey(
  envelope: UnsignedGroupKeyEnvelope | GroupKeyEnvelope,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "jwk",
    envelope.ephemeralPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const context = keyContext(envelope.groupId, envelope.keyEpoch, envelope.recipientDeviceId);
  const wrappingKey = await deriveWrappingKey(
    recipientPrivateKey,
    ephemeralPublicKey,
    fromBase64Url(envelope.salt),
    context,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(fromBase64Url(envelope.iv)),
      additionalData: asArrayBuffer(context),
    },
    wrappingKey,
    asArrayBuffer(fromBase64Url(envelope.ciphertext)),
  );
  return new Uint8Array(plaintext);
}

export async function encryptLedgerPayload(
  groupKey: CryptoKey,
  payload: JsonValue,
  authenticatedMetadata: JsonValue,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonicalJson(authenticatedMetadata));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aad) },
    groupKey,
    asArrayBuffer(encoder.encode(canonicalJson(payload))),
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

export async function decryptLedgerPayload(
  groupKey: CryptoKey,
  encrypted: { iv: string; ciphertext: string },
  authenticatedMetadata: JsonValue,
): Promise<JsonValue> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(fromBase64Url(encrypted.iv)),
      additionalData: asArrayBuffer(encoder.encode(canonicalJson(authenticatedMetadata))),
    },
    groupKey,
    asArrayBuffer(fromBase64Url(encrypted.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as JsonValue;
}

export async function createConfidentialOperation(input: {
  id: string;
  groupId: string;
  actorId: string;
  deviceId: string;
  keyEpoch: number;
  clientTimestamp: string;
  payload: JsonValue;
  groupKey: CryptoKey;
  signingPrivateKey: CryptoKey;
}): Promise<ConfidentialOperationEnvelope> {
  const metadata: JsonValue = {
    actorId: input.actorId,
    clientTimestamp: input.clientTimestamp,
    deviceId: input.deviceId,
    groupId: input.groupId,
    id: input.id,
    keyEpoch: input.keyEpoch,
    version: 1,
  };
  const encrypted = await encryptLedgerPayload(input.groupKey, input.payload, metadata);
  const unsigned: UnsignedConfidentialOperation = {
    version: 1,
    id: input.id,
    groupId: input.groupId,
    actorId: input.actorId,
    deviceId: input.deviceId,
    keyEpoch: input.keyEpoch,
    clientTimestamp: input.clientTimestamp,
    ...encrypted,
  };
  const contentHash = await confidentialOperationContentHash(unsigned);
  return {
    ...unsigned,
    contentHash,
    signature: await signHash(contentHash, input.signingPrivateKey),
  };
}
