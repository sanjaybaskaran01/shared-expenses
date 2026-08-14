import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config";

export interface QueuedEmail {
  idempotencyKey: string;
  recipient: string;
  subject: string;
  text: string;
  html?: string;
}

export function enqueueEmail(db: Database, message: QueuedEmail): void {
  db.query(
    `INSERT OR IGNORE INTO email_outbox(
      id, idempotency_key, recipient, subject, text_body, html_body,
      status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    randomUUID(),
    message.idempotencyKey,
    message.recipient,
    message.subject,
    message.text,
    message.html ?? null,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

interface OutboxRow {
  id: string;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  attempts: number;
}

const deliveryLeaseMs = 5 * 60_000;

/**
 * A stopped process cannot finish a row it marked as sending. The lease stored
 * in next_attempt_at makes that state recoverable without retrying a mail that
 * is still actively being handed to SMTP by the current process.
 */
export function recoverStaleEmailDeliveries(db: Database, now = new Date()): number {
  const recovered = db.query(
    `UPDATE email_outbox
     SET status = 'failed', last_error_code = 'DELIVERY_INTERRUPTED',
         recipient = CASE WHEN attempts >= 8 THEN '[redacted]' ELSE recipient END,
         subject = CASE WHEN attempts >= 8 THEN '[redacted]' ELSE subject END,
         text_body = CASE WHEN attempts >= 8 THEN '[redacted]' ELSE text_body END,
         html_body = CASE WHEN attempts >= 8 THEN NULL ELSE html_body END
     WHERE status = 'sending' AND next_attempt_at <= ?`,
  ).run(now.toISOString()).changes;
  return Number(recovered);
}

export function markEmailDeliveryFailure(
  db: Database,
  id: string,
  priorAttempts: number,
  error: unknown,
  leaseExpiresAt: string,
  now = new Date(),
): boolean {
  const attempts = priorAttempts + 1;
  const terminal = attempts >= 8;
  const delayMinutes = Math.min(2 ** attempts, 360);
  const nextAttempt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  const code = error instanceof Error ? error.name.slice(0, 100) : "SMTP_ERROR";
  let changed: number;
  if (terminal) {
    changed = Number(db.query(
      `UPDATE email_outbox
       SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error_code = ?,
           recipient = '[redacted]', subject = '[redacted]', text_body = '[redacted]', html_body = NULL
       WHERE id = ? AND status = 'sending' AND next_attempt_at = ?`,
    ).run(attempts, nextAttempt, code, id, leaseExpiresAt).changes);
  } else {
    changed = Number(db.query(
      `UPDATE email_outbox
       SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error_code = ?
       WHERE id = ? AND status = 'sending' AND next_attempt_at = ?`,
    ).run(attempts, nextAttempt, code, id, leaseExpiresAt).changes);
  }
  return terminal && changed === 1;
}

export function markEmailDeliverySuccess(
  db: Database,
  id: string,
  leaseExpiresAt: string,
  now = new Date(),
): boolean {
  const changed = db.query(
    `UPDATE email_outbox
     SET status = 'sent', sent_at = ?, last_error_code = NULL,
         recipient = '[redacted]', subject = '[redacted]', text_body = '[redacted]', html_body = NULL
     WHERE id = ? AND status = 'sending' AND next_attempt_at = ?`,
  ).run(now.toISOString(), id, leaseExpiresAt).changes;
  return Number(changed) === 1;
}

export function startEmailWorker(db: Database, config: AppConfig): () => void {
  if (!config.smtp.enabled || !config.smtp.user || !config.smtp.appPassword) {
    console.info("SMTP credentials are absent; queued emails will remain pending");
    return () => undefined;
  }

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.appPassword },
  });
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      recoverStaleEmailDeliveries(db, now);
      const row = db
        .query<OutboxRow, [string]>(
          `SELECT id, recipient, subject, text_body, html_body, attempts
           FROM email_outbox
           WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? AND attempts < 8
           ORDER BY created_at LIMIT 1`,
        )
        .get(now.toISOString());
      if (!row) return;
      const leaseExpiresAt = new Date(now.getTime() + deliveryLeaseMs).toISOString();
      const claimed = db.query(
        `UPDATE email_outbox
         SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?
         WHERE id = ? AND status IN ('pending', 'failed') AND attempts < 8`,
      ).run(leaseExpiresAt, row.id);
      if (claimed.changes !== 1) return;
      try {
        await transport.sendMail({
          from: config.smtp.from,
          to: row.recipient,
          subject: row.subject,
          text: row.text_body,
          ...(row.html_body ? { html: row.html_body } : {}),
        });
        markEmailDeliverySuccess(db, row.id, leaseExpiresAt);
      } catch (error) {
        markEmailDeliveryFailure(db, row.id, row.attempts, error, leaseExpiresAt);
      }
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), 10_000);
  void tick();
  return () => clearInterval(interval);
}
