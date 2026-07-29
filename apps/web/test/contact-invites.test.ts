import { describe, expect, test } from "bun:test";
import { inviteTokenFromHash } from "../src/lib/contact-invites";

describe("contact invitation links", () => {
  test("reads only a valid 256-bit base64url token from the URL fragment", () => {
    const token = "a".repeat(43);
    expect(inviteTokenFromHash(`#invite=${token}`)).toBe(token);
    expect(inviteTokenFromHash("#invite=too-short")).toBeUndefined();
    expect(inviteTokenFromHash(`?invite=${token}`)).toBeUndefined();
  });
});
