import {
  allocateEqually,
  computeBalances,
  parseDecimalToMinor,
  type JsonValue,
  type OperationType,
  type ScopedBalance,
  type UnsignedOperation,
} from "@expenses/protocol";
import { createSignal } from "solid-js";
import { liveQuery } from "dexie";
import {
  localDb,
  type LocalExpense,
  type LocalGroup,
  type LocalMember,
  type LocalOperation,
  type LocalPayment,
} from "./db";
import { ensureDevice, signOperation } from "./device";
import { SyncEngine, type ConnectionState } from "./sync";

export interface NewExpenseInput {
  groupId: string;
  description: string;
  amount: string;
  currency: string;
  category: string;
  expenseDate: string;
  payerId: string;
  participantIds: string[];
  notes: string;
}

export interface AmendExpenseInput {
  description: string;
  amount: string;
  category: string;
  expenseDate: string;
  payerId: string;
  participantIds: string[];
  notes: string;
}

export interface NewPaymentInput {
  groupId: string;
  payerId: string;
  recipientId: string;
  amount: string;
  currency: string;
  paymentDate: string;
  note: string;
}

const [groups, setGroups] = createSignal<LocalGroup[]>([]);
const [members, setMembers] = createSignal<LocalMember[]>([]);
const [expenses, setExpenses] = createSignal<LocalExpense[]>([]);
const [payments, setPayments] = createSignal<LocalPayment[]>([]);
const [operations, setOperations] = createSignal<LocalOperation[]>([]);
const [connection, setConnection] = createSignal<ConnectionState>("connecting");
const [connectionMessage, setConnectionMessage] = createSignal("");

const syncEngine = new SyncEngine((state, message) => {
  setConnection(state);
  setConnectionMessage(message ?? "");
});

let initialized = false;
const subscriptions: Array<{ unsubscribe(): void }> = [];

export async function initializeStore(actorId?: string): Promise<void> {
  if (initialized) return;
  initialized = true;
  await ensureDevice(actorId);
  subscriptions.push(
    liveQuery(() => localDb.groups.orderBy("createdAt").toArray()).subscribe(setGroups),
    liveQuery(() => localDb.members.toArray()).subscribe(setMembers),
    liveQuery(() => localDb.expenses.orderBy("expenseDate").reverse().toArray()).subscribe(setExpenses),
    liveQuery(() => localDb.payments.orderBy("paymentDate").reverse().toArray()).subscribe(setPayments),
    liveQuery(() => localDb.operations.orderBy("clientTimestamp").reverse().limit(200).toArray()).subscribe(setOperations),
  );
  window.addEventListener("online", () => void syncEngine.sync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncEngine.sync();
  });
  setInterval(() => void syncEngine.sync(), 30_000);
  await syncEngine.sync();
}

async function signAndQueue(input: {
  groupId: string;
  type: OperationType;
  targetId: string;
  baseVersion: number;
  payload: JsonValue;
}): Promise<{ operation: LocalOperation; clientTimestamp: string; actorId: string }> {
  const device = await ensureDevice();
  const unsigned: UnsignedOperation = {
    id: crypto.randomUUID(),
    groupId: input.groupId,
    actorId: device.actorId,
    deviceId: device.deviceId,
    type: input.type,
    targetId: input.targetId,
    baseVersion: input.baseVersion,
    clientTimestamp: new Date().toISOString(),
    payload: input.payload,
  };
  const signed = await signOperation(unsigned, device.privateKey);
  return {
    operation: { ...signed, syncStatus: "pending" },
    clientTimestamp: unsigned.clientTimestamp,
    actorId: device.actorId,
  };
}

function expensePayload(
  input: { description: string; category: string; expenseDate: string; notes: string; currency: string },
  amountMinor: number,
  payers: Array<{ participantId: string; amountMinor: number }>,
  allocations: Array<{ participantId: string; amountMinor: number }>,
): JsonValue {
  return {
    description: input.description.trim(),
    category: input.category,
    amountMinor,
    currency: input.currency,
    expenseDate: input.expenseDate,
    notes: input.notes,
    payers: payers.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
    allocations: allocations.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
  };
}

function assertExpenseInput(description: string, participantIds: readonly string[]): void {
  if (!description.trim()) throw new RangeError("Description is required");
  if (participantIds.length === 0) throw new RangeError("Select at least one participant");
}

export async function createExpense(input: NewExpenseInput): Promise<string> {
  assertExpenseInput(input.description, input.participantIds);
  const amountMinor = parseDecimalToMinor(input.amount);
  const allocations = allocateEqually(amountMinor, input.participantIds);
  const payers = [{ participantId: input.payerId, amountMinor }];
  const expenseId = crypto.randomUUID();
  const { operation, clientTimestamp, actorId } = await signAndQueue({
    groupId: input.groupId,
    type: "ExpenseCreated",
    targetId: expenseId,
    baseVersion: 0,
    payload: expensePayload(input, amountMinor, payers, allocations),
  });
  const paid = input.payerId === actorId ? amountMinor : 0;
  const owed = allocations.find(({ participantId }) => participantId === actorId)?.amountMinor ?? 0;
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    await localDb.operations.add(operation);
    await localDb.expenses.add({
      id: expenseId,
      groupId: input.groupId,
      description: input.description.trim(),
      category: input.category,
      amountMinor,
      currency: input.currency,
      expenseDate: input.expenseDate,
      notes: input.notes,
      payers,
      allocations,
      yourNetMinor: paid - owed,
      status: "active",
      version: 1,
      createdBy: actorId,
      updatedAt: clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
  return expenseId;
}

export async function amendExpense(expenseId: string, input: AmendExpenseInput): Promise<void> {
  const existing = await localDb.expenses.get(expenseId);
  if (!existing) throw new RangeError("This expense is no longer available");
  if (existing.status === "voided") throw new RangeError("A deleted expense cannot be edited");
  assertExpenseInput(input.description, input.participantIds);
  const amountMinor = parseDecimalToMinor(input.amount);
  const allocations = allocateEqually(amountMinor, input.participantIds);
  const payers = [{ participantId: input.payerId, amountMinor }];
  const { operation, clientTimestamp, actorId } = await signAndQueue({
    groupId: existing.groupId,
    type: "ExpenseAmended",
    targetId: expenseId,
    baseVersion: existing.version,
    payload: expensePayload({ ...input, currency: existing.currency }, amountMinor, payers, allocations),
  });
  const paid = input.payerId === actorId ? amountMinor : 0;
  const owed = allocations.find(({ participantId }) => participantId === actorId)?.amountMinor ?? 0;
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    await localDb.operations.add(operation);
    await localDb.expenses.update(expenseId, {
      description: input.description.trim(),
      category: input.category,
      amountMinor,
      expenseDate: input.expenseDate,
      notes: input.notes,
      payers,
      allocations,
      yourNetMinor: paid - owed,
      version: existing.version + 1,
      updatedAt: clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
}

export async function voidExpense(expenseId: string): Promise<void> {
  const existing = await localDb.expenses.get(expenseId);
  if (!existing) throw new RangeError("This expense is no longer available");
  if (existing.status === "voided") return;
  const { operation, clientTimestamp } = await signAndQueue({
    groupId: existing.groupId,
    type: "ExpenseVoided",
    targetId: expenseId,
    baseVersion: existing.version,
    payload: {},
  });
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    await localDb.operations.add(operation);
    await localDb.expenses.update(expenseId, {
      status: "voided",
      version: existing.version + 1,
      updatedAt: clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
}

export async function recordPayment(input: NewPaymentInput): Promise<string> {
  if (input.payerId === input.recipientId) throw new RangeError("Choose two different people");
  const amountMinor = parseDecimalToMinor(input.amount);
  const paymentId = crypto.randomUUID();
  const { operation, clientTimestamp, actorId } = await signAndQueue({
    groupId: input.groupId,
    type: "PaymentRecorded",
    targetId: paymentId,
    baseVersion: 0,
    payload: {
      payerId: input.payerId,
      recipientId: input.recipientId,
      amountMinor,
      currency: input.currency,
      paymentDate: input.paymentDate,
      note: input.note,
    },
  });
  await localDb.transaction("rw", localDb.operations, localDb.payments, async () => {
    await localDb.operations.add(operation);
    await localDb.payments.add({
      id: paymentId,
      groupId: input.groupId,
      payerId: input.payerId,
      recipientId: input.recipientId,
      amountMinor,
      currency: input.currency,
      paymentDate: input.paymentDate,
      note: input.note,
      status: "active",
      version: 1,
      recordedBy: actorId,
      updatedAt: clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
  return paymentId;
}

/** Scoped by group and currency — never summed across either. */
function balances(): ScopedBalance[] {
  return computeBalances(
    expenses()
      .filter((expense) => expense.status === "active")
      .map(({ groupId, currency, payers, allocations }) => ({ groupId, currency, payers, allocations })),
    payments()
      .filter((payment) => payment.status === "active")
      .map(({ groupId, currency, payerId, recipientId, amountMinor }) => ({
        groupId,
        currency,
        payerId,
        recipientId,
        amountMinor,
      })),
  );
}

export const appStore = {
  groups,
  members,
  expenses,
  payments,
  operations,
  balances,
  connection,
  connectionMessage,
  sync: () => syncEngine.sync(),
};
