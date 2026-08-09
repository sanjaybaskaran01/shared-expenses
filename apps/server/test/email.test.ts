import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { markEmailDeliveryFailure } from "../src/email";
import { runDomainMigrations } from "../src/database";

function outbox(attempts: number): Database {
  const database = new Database(":memory:", { strict: true });
  runDomainMigrations(database, resolve(import.meta.dir, "../migrations"));
  database.query(
    `INSERT INTO email_outbox(
       id, idempotency_key, recipient, subject, text_body, html_body,
       status, attempts, next_attempt_at, created_at
     ) VALUES ('mail-1', 'key-1', 'friend@example.com', 'Join Tallied',
       'Open https://example.com/private-token', '<a>private</a>',
       'sending', ?, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:00.000Z')`,
  ).run(attempts);
  return database;
}

describe("email outbox retention", () => {
  test("keeps retryable content before the eighth failed delivery", () => {
    const database = outbox(7);
    expect(markEmailDeliveryFailure(database, "mail-1", 6, new Error("unavailable"), new Date("2026-08-09T12:00:00.000Z"))).toBe(false);
    expect(database.query<{ attempts: number; recipient: string; text: string }, []>(
      "SELECT attempts, recipient, text_body AS text FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({ attempts: 7, recipient: "friend@example.com", text: "Open https://example.com/private-token" });
    database.close();
  });

  test("redacts recipient and message content after the eighth failed delivery", () => {
    const database = outbox(8);
    expect(markEmailDeliveryFailure(database, "mail-1", 7, new Error("unavailable"), new Date("2026-08-09T12:00:00.000Z"))).toBe(true);
    expect(database.query<{ status: string; attempts: number; recipient: string; subject: string; text: string; html: string | null }, []>(
      "SELECT status, attempts, recipient, subject, text_body AS text, html_body AS html FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({
      status: "failed",
      attempts: 8,
      recipient: "[redacted]",
      subject: "[redacted]",
      text: "[redacted]",
      html: null,
    });
    database.close();
  });
});
