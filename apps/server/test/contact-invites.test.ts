import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ContactInviteError,
  ContactInviteStore,
  hashInviteToken,
} from "../src/contact-invites";

function fixture(now = new Date("2026-07-28T12:00:00.000Z")) {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE contact_invitations (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      inviter_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'accepted', 'revoked')),
      reserved_email_hash TEXT,
      reservation_expires_at TEXT,
      claimed_by_user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE contacts (
      owner_user_id TEXT NOT NULL,
      contact_user_id TEXT NOT NULL,
      invitation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, contact_user_id)
    );
    INSERT INTO "user"(id, name, email) VALUES
      ('alice', 'Alice', 'alice@example.com'),
      ('bob', 'Bob', 'bob@example.com'),
      ('carol', 'Carol', 'carol@example.com');
  `);
  let clock = now;
  const store = new ContactInviteStore(db, {
    emailHashSecret: "test-only-email-hash-secret",
    now: () => clock,
  });
  return {
    db,
    store,
    setNow(value: Date) {
      clock = value;
    },
  };
}

describe("standalone contact invitations", () => {
  test("stores only a token hash and enforces five active credits", () => {
    const { db, store } = fixture();
    const created = Array.from({ length: 5 }, () => store.create("alice"));

    expect(created[0]!.token).not.toBe(created[1]!.token);
    expect(
      db.query<{ token_hash: string }, []>("SELECT token_hash FROM contact_invitations LIMIT 1").get()
        ?.token_hash,
    ).not.toBe(created[0]!.token);
    expect(store.list("alice").creditsRemaining).toBe(0);
    expect(() => store.create("alice")).toThrow(ContactInviteError);
  });

  test("binds a forwarded bearer link to the first reserving email", () => {
    const { store } = fixture();
    const invite = store.create("alice");

    expect(store.reserve(invite.token, "bob@example.com").invitationId).toBe(invite.id);
    expect(store.canCreateAccount("bob@example.com")).toBe(true);
    expect(() => store.reserve(invite.token, "carol@example.com")).toThrow(
      "This invitation was opened with another email address. Use that email or ask the sender for a new link.",
    );
    expect(store.canCreateAccount("carol@example.com")).toBe(false);
  });

  test("lets an expired reservation be claimed by a different verified identity", () => {
    const { store, setNow } = fixture();
    const invite = store.create("alice");
    store.reserve(invite.token, "bob@example.com");

    setNow(new Date("2026-07-28T12:16:00.000Z"));
    expect(store.reserve(invite.token, "carol@example.com").invitationId).toBe(invite.id);
  });

  test("creates symmetric contacts only after the reserved email is verified", () => {
    const { db, store } = fixture();
    const invite = store.create("alice");
    store.reserve(invite.token, "bob@example.com");

    expect(store.acceptReservedForUser("bob", "bob@example.com")).toBe(1);
    expect(store.acceptReservedForUser("bob", "bob@example.com")).toBe(0);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM contacts").get()?.count,
    ).toBe(2);
    expect(store.list("alice").contacts).toEqual([
      expect.objectContaining({ userId: "bob", displayName: "Bob" }),
    ]);
    expect(store.list("bob").contacts).toEqual([
      expect.objectContaining({ userId: "alice", displayName: "Alice" }),
    ]);
  });

  test("revoking an unclaimed link returns its credit and invalidates the token", () => {
    const { store } = fixture();
    const invite = store.create("alice");
    expect(store.list("alice").creditsRemaining).toBe(4);

    store.revoke("alice", invite.id);

    expect(store.list("alice").creditsRemaining).toBe(5);
    expect(() => store.reserve(invite.token, "bob@example.com")).toThrow(
      "This invitation has expired or is no longer available. Ask the sender for a new one.",
    );
  });

  test("uses a keyed email hash rather than storing the invitee email", () => {
    const { db, store } = fixture();
    const invite = store.create("alice");
    store.reserve(invite.token, "BOB@example.com");
    const row = db.query<{ reserved_email_hash: string }, [string]>(
      "SELECT reserved_email_hash FROM contact_invitations WHERE id = ?",
    ).get(invite.id);

    expect(row?.reserved_email_hash).not.toContain("bob@example.com");
    expect(hashInviteToken(invite.token)).toHaveLength(64);
  });
});
