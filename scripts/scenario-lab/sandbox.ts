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
