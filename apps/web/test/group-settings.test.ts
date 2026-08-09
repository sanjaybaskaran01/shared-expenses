import { describe, expect, test } from "bun:test";
import { groupConnectionCallout, groupMemberStatus, IMPORT_IDENTITY_LINK_EXPLANATION } from "../src/lib/group-settings";

describe("group settings copy", () => {
  test("prioritizes a claim awaiting owner review", () => {
    expect(groupConnectionCallout([
      { displayName: "Jordan Example", importClaim: { status: "awaiting_owner" } },
      { displayName: "Casey Example", importClaim: { status: "unclaimed" } },
    ])).toEqual({
      count: 2,
      title: "Review Jordan Example’s account link",
      detail: "Confirm the right account before sharing imported balances.",
    });
  });

  test("describes one unlinked imported identity by name", () => {
    expect(groupConnectionCallout([
      { displayName: "Jordan Example", importClaim: { status: "unclaimed" } },
    ])?.title).toBe("Link Jordan Example’s imported history");
  });

  test("explains why another shared group is not proof of identity", () => {
    expect(IMPORT_IDENTITY_LINK_EXPLANATION).toContain("Names are not unique");
    expect(IMPORT_IDENTITY_LINK_EXPLANATION).toContain("sharing another group does not prove");
    expect(IMPORT_IDENTITY_LINK_EXPLANATION).toContain("secure link");
  });

  test("uses one status vocabulary across member surfaces", () => {
    expect(groupMemberStatus({ status: "active" }, true)).toBe("You");
    expect(groupMemberStatus({ status: "placeholder" }, false)).toBe("Invitation pending · you can still add expenses");
    expect(groupMemberStatus({ status: "placeholder", importClaim: { status: "unclaimed" } }, false)).toBe("Account not linked · you can still add expenses");
    expect(groupMemberStatus({ status: "placeholder", importClaim: { status: "awaiting_owner" } }, false)).toBe("Account link awaiting review");
  });
});
