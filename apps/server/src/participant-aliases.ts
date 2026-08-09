import type { Database } from "bun:sqlite";

function mergeParticipantAmounts(
  db: Database,
  table: "expense_payers" | "expense_allocations",
  fromUserId: string,
  toUserId: string,
): void {
  const rows = db.query<{ expenseId: string; amountMinor: number }, [string]>(
    `SELECT expense_id AS expenseId, amount_minor AS amountMinor
     FROM ${table} WHERE participant_id = ?`,
  ).all(fromUserId);
  for (const row of rows) {
    const existing = db.query<{ amountMinor: number }, [string, string]>(
      `SELECT amount_minor AS amountMinor FROM ${table}
       WHERE expense_id = ? AND participant_id = ?`,
    ).get(row.expenseId, toUserId);
    if (existing) {
      db.query(`UPDATE ${table} SET amount_minor = ? WHERE expense_id = ? AND participant_id = ?`)
        .run(existing.amountMinor + row.amountMinor, row.expenseId, toUserId);
      db.query(`DELETE FROM ${table} WHERE expense_id = ? AND participant_id = ?`)
        .run(row.expenseId, fromUserId);
    } else {
      db.query(`UPDATE ${table} SET participant_id = ? WHERE expense_id = ? AND participant_id = ?`)
        .run(toUserId, row.expenseId, fromUserId);
    }
  }
}

/**
 * Moves mutable projections to the verified account. Accepted operations stay
 * immutable; a group-scoped alias reprojects their participant ids on clients.
 */
export function reassignFinancialParticipant(
  db: Database,
  fromUserId: string,
  toUserId: string,
): void {
  if (fromUserId === toUserId) return;
  mergeParticipantAmounts(db, "expense_payers", fromUserId, toUserId);
  mergeParticipantAmounts(db, "expense_allocations", fromUserId, toUserId);
  db.query("UPDATE payments SET payer_id = ? WHERE payer_id = ?").run(toUserId, fromUserId);
  db.query("UPDATE payments SET recipient_id = ? WHERE recipient_id = ?").run(toUserId, fromUserId);
  db.query("UPDATE imported_transaction_effects SET participant_id = ? WHERE participant_id = ?")
    .run(toUserId, fromUserId);
}
