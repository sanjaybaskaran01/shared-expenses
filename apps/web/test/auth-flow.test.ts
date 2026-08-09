import { describe, expect, test } from "bun:test";
import { authEmailPlacement } from "../src/lib/auth-flow";

describe("authentication email placement", () => {
  test("keeps an invitation email field available on Google-only installations", () => {
    expect(authEmailPlacement({ invitationToken: "invite-token", migrationClaimToken: null })).toEqual({
      shared: true,
      magicLinkForm: false,
    });
  });

  test("shares one email field across migration sign-in methods", () => {
    expect(authEmailPlacement({ invitationToken: null, migrationClaimToken: "claim-token" })).toEqual({
      shared: true,
      magicLinkForm: false,
    });
  });

  test("keeps the ordinary email field inside the magic-link form", () => {
    expect(authEmailPlacement({ invitationToken: null, migrationClaimToken: null })).toEqual({
      shared: false,
      magicLinkForm: true,
    });
  });
});
