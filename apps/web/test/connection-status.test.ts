import { describe, expect, test } from "bun:test";
import { accountSyncCopy } from "../src/lib/connection-status";

describe("account-scoped sync copy", () => {
  test("does not imply that another account or device has the same memberships", () => {
    expect(accountSyncCopy({ connection: "online", pendingCount: 0, groupCount: 3 })).toEqual({
      short: "Up to date",
      detail: "Up to date on this account · 3 groups",
    });
  });

  test("states when changes are only saved on this device", () => {
    expect(accountSyncCopy({ connection: "offline", pendingCount: 2, groupCount: 1 }).detail)
      .toBe("Offline · 2 changes saved on this device · 1 group");
  });
});
