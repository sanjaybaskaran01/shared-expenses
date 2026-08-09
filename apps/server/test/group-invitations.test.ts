import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { runDomainMigrations } from "../src/database";
import { createGroupInvitation, GroupInvitationError } from "../src/group-invitations";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  runDomainMigrations(database, resolve(import.meta.dir, "../migrations"));
  const now = "2026-08-09T12:00:00.000Z";
  database.exec(`
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO "user"(id, name, email)
    VALUES ('owner', 'Owner Example', 'owner@example.com');
    INSERT INTO groups(id, name, settlement_currency, created_by, created_at)
    VALUES ('group-1', 'Synthetic trip', 'USD', 'owner', '${now}');
    INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
    VALUES ('group-1', 'owner', 'Owner Example', 'owner@example.com', 'active', '${now}');
  `);
  return database;
}

describe("group invitation delivery", () => {
  test("rejects a non-member before writing or delivering anything", async () => {
    const database = fixture();
    let delivered = false;
    await expect(createGroupInvitation({
      db: database,
      actorId: "outsider",
      groupId: "group-1",
      email: "friend@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: true,
      googleEnabled: true,
      sendMagicLink: async () => { delivered = true; },
    })).rejects.toMatchObject({ code: "NOT_A_GROUP_MEMBER", status: 403 });
    expect(delivered).toBe(false);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_invitations",
    ).get()?.count).toBe(0);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_members WHERE email = 'friend@example.com'",
    ).get()?.count).toBe(0);
    database.close();
  });

  test("rejects an existing member before writing or delivering anything", async () => {
    const database = fixture();
    database.exec(`
      INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
      VALUES ('group-1', 'friend', 'Friend Example', 'friend@example.com', 'active', '2026-08-09T12:00:00.000Z');
    `);
    let delivered = false;
    await expect(createGroupInvitation({
      db: database,
      actorId: "owner",
      groupId: "group-1",
      email: "FRIEND@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: true,
      googleEnabled: true,
      sendMagicLink: async () => { delivered = true; },
    })).rejects.toMatchObject({ code: "ALREADY_INVITED", status: 409 });
    expect(delivered).toBe(false);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_invitations",
    ).get()?.count).toBe(0);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_members WHERE lower(email) = 'friend@example.com'",
    ).get()?.count).toBe(1);
    database.close();
  });

  test("creates a pending participant and shareable Google path without SMTP", async () => {
    const database = fixture();
    const result = await createGroupInvitation({
      db: database,
      actorId: "owner",
      groupId: "group-1",
      email: "friend@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: false,
      googleEnabled: true,
      sendMagicLink: async () => { throw new Error("must not send"); },
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    expect(result).toEqual(expect.objectContaining({
      email: "friend@example.com",
      status: "pending",
      delivery: "share",
      joinUrl: "https://tallied.example.com",
    }));
    expect(database.query<{ status: string }, []>(
      "SELECT status FROM group_members WHERE email = 'friend@example.com'",
    ).get()).toEqual({ status: "placeholder" });
    database.close();
  });

  test("keeps email delivery when SMTP is configured", async () => {
    const database = fixture();
    const sent: string[] = [];
    const result = await createGroupInvitation({
      db: database,
      actorId: "owner",
      groupId: "group-1",
      email: "friend@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: true,
      googleEnabled: true,
      sendMagicLink: async ({ email }) => { sent.push(email); },
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    expect(result.delivery).toBe("email");
    expect(sent).toEqual(["friend@example.com"]);
    database.close();
  });

  test("fails closed without a delivery method and leaves no placeholder", async () => {
    const database = fixture();
    await expect(createGroupInvitation({
      db: database,
      actorId: "owner",
      groupId: "group-1",
      email: "friend@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: false,
      googleEnabled: false,
      sendMagicLink: async () => {},
    })).rejects.toBeInstanceOf(GroupInvitationError);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_members WHERE email = 'friend@example.com'",
    ).get()?.count).toBe(0);
    database.close();
  });

  test("rolls back the pending participant when email dispatch fails", async () => {
    const database = fixture();
    await expect(createGroupInvitation({
      db: database,
      actorId: "owner",
      groupId: "group-1",
      email: "friend@example.com",
      webOrigin: "https://tallied.example.com",
      smtpEnabled: true,
      googleEnabled: false,
      sendMagicLink: async () => { throw new Error("smtp unavailable"); },
    })).rejects.toThrow("Unable to send the invitation");
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM group_members WHERE email = 'friend@example.com'",
    ).get()?.count).toBe(0);
    database.close();
  });
});
