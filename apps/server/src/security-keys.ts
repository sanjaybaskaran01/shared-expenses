import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function keyFor(rootSecret: string, purpose: string): Buffer {
  if (!rootSecret) throw new Error("A server secret is required");
  return createHmac("sha256", rootSecret).update(`tallied:key:v1:${purpose}`).digest();
}

export function keyedDigest(rootSecret: string, purpose: string, value: string): string {
  return createHmac("sha256", keyFor(rootSecret, purpose)).update(value).digest("hex");
}

export function encryptServerValue(rootSecret: string, purpose: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(rootSecret, purpose), iv);
  cipher.setAAD(Buffer.from(`tallied:${purpose}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptServerValue(rootSecret: string, purpose: string, value: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Stored encrypted data is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(rootSecret, purpose),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(Buffer.from(`tallied:${purpose}:v1`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
