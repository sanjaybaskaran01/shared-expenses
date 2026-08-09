import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openDatabase, runDomainMigrations } from "../../apps/server/src/database";
import { LedgerStore } from "../../apps/server/src/ledger";
import {
  DEFAULT_SCENARIO_ACTORS,
  type ScenarioActor,
  type ScenarioExpenseProjection,
  type ScenarioPaymentProjection,
  type ScenarioServerSnapshot,
} from "./model";

interface ExpenseRow {
  id: string;
  description: string;
  status: "active" | "voided";
  version: number;
  amount_minor: number;
}

interface ParticipantRow {
  expense_id: string;
  participant_id: string;
  amount_minor: number;
}

interface PaymentRow {
  id: string;
  status: "active" | "reversed";
  payer_id: string;
  recipient_id: string;
  amount_minor: number;
}

interface OperationRow {
  id: string;
  target_id: string;
  status: "accepted" | "conflicted" | "rejected";
}

export interface SeedScenarioOptions {
  databasePath: string;
  groupId?: string;
  groupName?: string;
  currency?: string;
  actors?: readonly ScenarioActor[];
}

export const IMPORT_CLAIM_SCENARIO = {
  batchId: "scenario-import-batch",
  groupId: "scenario-imported-trip",
  groupName: "Imported winter trip",
  identityId: "scenario-imported-dev",
  placeholderUserId: "import:scenario-dev",
  expenseId: "scenario-imported-expense",
  operationId: "scenario-imported-operation",
  amountMinor: 186_101,
} as const;

export async function seedScenarioDatabase(options: SeedScenarioOptions): Promise<void> {
  const actors = options.actors ?? DEFAULT_SCENARIO_ACTORS;
  if (actors.length !== 4 || new Set(actors.map(({ id }) => id)).size !== 4) {
    throw new RangeError("The scenario sandbox requires four unique actors");
  }
  await mkdir(dirname(resolve(options.databasePath)), { recursive: true, mode: 0o700 });
  const database = openDatabase(resolve(options.databasePath));
  try {
    runDomainMigrations(database, resolve(import.meta.dir, "../../apps/server/migrations"));
    const ledger = new LedgerStore(database);
    for (const actor of actors) {
      ledger.bootstrapGroup({
        id: options.groupId ?? "scenario-goa-trip",
        name: options.groupName ?? "Goa trip",
        settlementCurrency: options.currency ?? "USD",
        userId: actor.id,
        displayName: actor.name,
      });
    }
    const now = "2026-08-08T12:00:00.000Z";
    const imported = IMPORT_CLAIM_SCENARIO;
    const payload = {
      description: "Imported winter trip balance",
      category: "Travel",
      amountMinor: imported.amountMinor,
      currency: "USD",
      expenseDate: "2026-08-01",
      notes: "",
      payers: [{ participantId: "maya", amountMinor: imported.amountMinor }],
      allocations: [{ participantId: imported.placeholderUserId, amountMinor: imported.amountMinor }],
      import: {
        importBatchId: imported.batchId,
        sourceProvider: "splitwise",
        importedAt: now,
        importedByDisplayName: "Maya",
        readOnly: true,
      },
    };
    database.transaction(() => {
      database.query(
        `INSERT INTO groups(id, name, settlement_currency, created_by, created_at)
         VALUES (?, ?, 'USD', 'maya', ?)`,
      ).run(imported.groupId, imported.groupName, now);
      database.query(
        `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, 'maya', 'Maya', 'maya@example.com', 'active', ?)`,
      ).run(imported.groupId, now);
      database.query(
        `INSERT INTO group_members(group_id, user_id, display_name, status, joined_at)
         VALUES (?, ?, 'Dev', 'placeholder', ?)`,
      ).run(imported.groupId, imported.placeholderUserId, now);
      database.query(
        `INSERT INTO expenses(
           id, group_id, description, category, amount_minor, currency, expense_date,
           notes, status, version, created_by, created_at, updated_at,
           import_batch_id, source_provider, imported_by, imported_at, read_only
         ) VALUES (?, ?, ?, 'Travel', ?, 'USD', '2026-08-01', '', 'active', 1,
           'maya', ?, ?, ?, 'splitwise', 'maya', ?, 1)`,
      ).run(imported.expenseId, imported.groupId, payload.description, imported.amountMinor, now, now, imported.batchId, now);
      database.query("INSERT INTO expense_payers(expense_id, participant_id, amount_minor) VALUES (?, 'maya', ?)")
        .run(imported.expenseId, imported.amountMinor);
      database.query("INSERT INTO expense_allocations(expense_id, participant_id, amount_minor) VALUES (?, ?, ?)")
        .run(imported.expenseId, imported.placeholderUserId, imported.amountMinor);
      database.query(
        `INSERT INTO operations(
           id, group_id, actor_id, device_id, type, target_id, base_version,
           client_timestamp, payload_json, content_hash, signature, received_at, status
         ) VALUES (?, ?, 'maya', 'scenario-import-device', 'ExpenseCreated', ?, 0,
           ?, ?, ?, 'scenario-fixture-signature', ?, 'accepted')`,
      ).run(imported.operationId, imported.groupId, imported.expenseId, now, JSON.stringify(payload), "f".repeat(64), now);
      database.query(
        "INSERT INTO entity_versions(group_id, target_id, version, operation_id) VALUES (?, ?, 1, ?)",
      ).run(imported.groupId, imported.expenseId, imported.operationId);
      database.query(
        `INSERT INTO import_batches(
           id, imported_by, provider, mode, fingerprint, selected_source_groups_json,
           warnings_json, reconciliation_json, status, rollback_status, started_at,
           reviewed_at, completed_at
         ) VALUES (?, 'maya', 'splitwise', 'history', ?, '["winter:USD"]', '[]', '{}',
           'completed', 'available', ?, ?, ?)`,
      ).run(imported.batchId, "a".repeat(64), now, now, now);
      database.query(
        `INSERT INTO imported_identities(
           id, batch_id, provider, external_user_id, display_name, email_trust,
           placeholder_user_id, status, created_at
         ) VALUES (?, ?, 'splitwise', 'scenario-dev-source', 'Dev', 'none', ?, 'unclaimed', ?)`,
      ).run(imported.identityId, imported.batchId, imported.placeholderUserId, now);
      database.query(
        `INSERT INTO import_external_mappings(
           batch_id, imported_by, provider, external_type, external_id,
           external_id_hash, local_id
         ) VALUES (?, 'maya', 'splitwise', 'group', 'winter:USD', ?, ?)`,
      ).run(imported.batchId, "b".repeat(64), imported.groupId);
    })();
  } finally {
    database.close();
  }
}

export function seedScenarioAuthUsers(databasePath: string, actors: readonly ScenarioActor[] = DEFAULT_SCENARIO_ACTORS): void {
  const database = openDatabase(resolve(databasePath));
  try {
    const now = new Date().toISOString();
    const insertUser = database.query(
      `INSERT OR IGNORE INTO "user"(id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    database.transaction(() => {
      for (const actor of actors) insertUser.run(actor.id, actor.name, `${actor.id}@example.com`, now, now);
    })();
  } finally {
    database.close();
  }
}

export function readScenarioMagicLink(databasePath: string, recipient: string): string | undefined {
  const database = new Database(resolve(databasePath), { readonly: true, strict: true });
  try {
    const email = database.query<{ textBody: string }, [string]>(
      `SELECT text_body AS textBody
       FROM email_outbox
       WHERE lower(recipient) = lower(?)
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(recipient);
    const match = email?.textBody.match(/https?:\/\/\S+/);
    if (!match) return undefined;
    const link = new URL(match[0]);
    if (link.hostname !== "127.0.0.1" || !link.pathname.includes("/api/auth/magic-link/verify")) {
      throw new Error("Scenario email contained a non-loopback or unexpected link");
    }
    return link.toString();
  } finally {
    database.close();
  }
}

export function readScenarioImportClaimEvidence(databasePath: string): {
  identityStatus: string;
  claimedByUserId: string | null;
  signedAllocationParticipantId: string;
  materializedAllocationParticipantId: string;
} {
  const database = new Database(resolve(databasePath), { readonly: true, strict: true });
  try {
    const imported = IMPORT_CLAIM_SCENARIO;
    const identity = database.query<{ status: string; claimedByUserId: string | null }, [string]>(
      "SELECT status, claimed_by_user_id AS claimedByUserId FROM imported_identities WHERE id = ?",
    ).get(imported.identityId);
    const operation = database.query<{ payload: string }, [string]>(
      "SELECT payload_json AS payload FROM operations WHERE id = ?",
    ).get(imported.operationId);
    const allocation = database.query<{ participantId: string }, [string]>(
      "SELECT participant_id AS participantId FROM expense_allocations WHERE expense_id = ?",
    ).get(imported.expenseId);
    const payload = JSON.parse(operation?.payload ?? "{}") as { allocations?: Array<{ participantId?: string }> };
    return {
      identityStatus: identity?.status ?? "missing",
      claimedByUserId: identity?.claimedByUserId ?? null,
      signedAllocationParticipantId: payload.allocations?.[0]?.participantId ?? "missing",
      materializedAllocationParticipantId: allocation?.participantId ?? "missing",
    };
  } finally {
    database.close();
  }
}

function participantMap(rows: readonly ParticipantRow[]): Map<string, Array<{ participantId: string; amountMinor: number }>> {
  const output = new Map<string, Array<{ participantId: string; amountMinor: number }>>();
  for (const row of rows) {
    const values = output.get(row.expense_id) ?? [];
    values.push({ participantId: row.participant_id, amountMinor: row.amount_minor });
    output.set(row.expense_id, values);
  }
  return output;
}

export function readScenarioServerSnapshot(databasePath: string, groupId = "scenario-goa-trip"): ScenarioServerSnapshot {
  const database = new Database(resolve(databasePath), { readonly: true, strict: true });
  database.exec("PRAGMA busy_timeout = 5000;");
  try {
    const memberIds = database.query<{ user_id: string }, [string]>(
      "SELECT user_id FROM group_members WHERE group_id = ? AND status = 'active' ORDER BY user_id",
    ).all(groupId).map(({ user_id }) => user_id);
    const expenseRows = database.query<ExpenseRow, [string]>(
      `SELECT id, description, status, version, amount_minor
       FROM expenses WHERE group_id = ? ORDER BY id`,
    ).all(groupId);
    const payerRows = database.query<ParticipantRow, [string]>(
      `SELECT ep.expense_id, ep.participant_id, ep.amount_minor
       FROM expense_payers ep JOIN expenses e ON e.id = ep.expense_id
       WHERE e.group_id = ? ORDER BY ep.expense_id, ep.participant_id`,
    ).all(groupId);
    const allocationRows = database.query<ParticipantRow, [string]>(
      `SELECT ea.expense_id, ea.participant_id, ea.amount_minor
       FROM expense_allocations ea JOIN expenses e ON e.id = ea.expense_id
       WHERE e.group_id = ? ORDER BY ea.expense_id, ea.participant_id`,
    ).all(groupId);
    const payers = participantMap(payerRows);
    const allocations = participantMap(allocationRows);
    const expenses: ScenarioExpenseProjection[] = expenseRows.map((row) => ({
      id: row.id,
      description: row.description,
      status: row.status,
      version: row.version,
      amountMinor: row.amount_minor,
      payers: payers.get(row.id) ?? [],
      allocations: allocations.get(row.id) ?? [],
    }));
    const payments: ScenarioPaymentProjection[] = database.query<PaymentRow, [string]>(
      `SELECT id, status, payer_id, recipient_id, amount_minor
       FROM payments WHERE group_id = ? ORDER BY id`,
    ).all(groupId).map((row) => ({
      id: row.id,
      status: row.status,
      payerId: row.payer_id,
      recipientId: row.recipient_id,
      amountMinor: row.amount_minor,
    }));
    const operations = database.query<OperationRow, [string]>(
      `SELECT id, target_id, status FROM operations WHERE group_id = ? ORDER BY server_sequence`,
    ).all(groupId).map((row) => ({ id: row.id, targetId: row.target_id, status: row.status }));
    return { groupId, memberIds, expenses, payments, operations };
  } finally {
    database.close();
  }
}
