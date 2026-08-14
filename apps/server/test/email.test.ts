import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { markEmailDeliveryFailure, markEmailDeliverySuccess, recoverStaleEmailDeliveries } from "../src/email";
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
    expect(markEmailDeliveryFailure(
      database,
      "mail-1",
      6,
      new Error("unavailable"),
      "2026-08-09T12:00:00.000Z",
      new Date("2026-08-09T12:00:00.000Z"),
    )).toBe(false);
    expect(database.query<{ attempts: number; recipient: string; text: string }, []>(
      "SELECT attempts, recipient, text_body AS text FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({ attempts: 7, recipient: "friend@example.com", text: "Open https://example.com/private-token" });
    database.close();
  });

  test("redacts recipient and message content after the eighth failed delivery", () => {
    const database = outbox(8);
    expect(markEmailDeliveryFailure(
      database,
      "mail-1",
      7,
      new Error("unavailable"),
      "2026-08-09T12:00:00.000Z",
      new Date("2026-08-09T12:00:00.000Z"),
    )).toBe(true);
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

  test("returns an abandoned sending row to the retry queue after its delivery lease", () => {
    const database = outbox(1);
    const recovered = recoverStaleEmailDeliveries(database, new Date("2026-08-09T12:10:00.000Z"));

    expect(recovered).toBe(1);
    expect(database.query<{ status: string; attempts: number; code: string | null }, []>(
      "SELECT status, attempts, last_error_code AS code FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({ status: "failed", attempts: 1, code: "DELIVERY_INTERRUPTED" });
    database.close();
  });

  test("keeps an in-flight row claimed until its delivery lease expires", () => {
    const database = outbox(1);
    database.query("UPDATE email_outbox SET next_attempt_at = ? WHERE id = 'mail-1'")
      .run("2026-08-09T12:20:00.000Z");

    expect(recoverStaleEmailDeliveries(database, new Date("2026-08-09T12:10:00.000Z"))).toBe(0);
    expect(database.query<{ status: string }, []>("SELECT status FROM email_outbox WHERE id = 'mail-1'").get())
      .toEqual({ status: "sending" });
    database.close();
  });

  test("terminates and redacts an abandoned final delivery attempt", () => {
    const database = outbox(8);

    expect(recoverStaleEmailDeliveries(database, new Date("2026-08-09T12:10:00.000Z"))).toBe(1);
    expect(database.query<{ status: string; recipient: string; text: string; html: string | null }, []>(
      "SELECT status, recipient, text_body AS text, html_body AS html FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({ status: "failed", recipient: "[redacted]", text: "[redacted]", html: null });
    database.close();
  });

  test("ignores a stale worker after another delivery lease replaces it", () => {
    const database = outbox(2);
    const staleLease = "2026-08-09T12:00:00.000Z";
    const activeLease = "2026-08-09T12:20:00.000Z";
    database.query("UPDATE email_outbox SET attempts = 3, next_attempt_at = ? WHERE id = 'mail-1'")
      .run(activeLease);

    expect(markEmailDeliveryFailure(
      database,
      "mail-1",
      2,
      new Error("late SMTP failure"),
      staleLease,
      new Date("2026-08-09T12:10:00.000Z"),
    )).toBe(false);
    expect(markEmailDeliverySuccess(
      database,
      "mail-1",
      staleLease,
      new Date("2026-08-09T12:10:00.000Z"),
    )).toBe(false);
    expect(database.query<{ status: string; attempts: number; lease: string; recipient: string }, []>(
      "SELECT status, attempts, next_attempt_at AS lease, recipient FROM email_outbox WHERE id = 'mail-1'",
    ).get()).toEqual({
      status: "sending",
      attempts: 3,
      lease: activeLease,
      recipient: "friend@example.com",
    });
    database.close();
  });
});
