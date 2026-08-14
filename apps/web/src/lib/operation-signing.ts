import { operationContentHash, type JsonValue, type OperationEnvelope, type UnsignedOperation } from "@expenses/protocol";

/**
 * Signs a ledger operation with browser Web Crypto. This module intentionally
 * has no document, storage, or application-state dependencies so both the UI
 * and dedicated import workers can use the same signing implementation.
 */
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

function encodeBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
