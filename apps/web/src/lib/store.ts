import {
  allocateByWeights,
  allocateEqually,
  parseDecimalToMinor,
  validateExactAllocation,
  type JsonValue,
  type ParticipantAmount,
  type UnsignedOperation,
} from "@expenses/protocol";
import { createSignal } from "solid-js";
import { liveQuery } from "dexie";
import { localDb, type LocalExpense, type LocalGroup, type LocalMember, type LocalOperation } from "./db";
import { ensureDevice, signOperation } from "./device";
import { SyncEngine, type ConnectionState } from "./sync";

export interface NewExpenseInput {
  groupId: string;
  description: string;
  amount: string;
  currency: string;
  category: string;
  expenseDate: string;
  payerId?: string;
  payerIds?: string[];
  payerValues?: Record<string, string>;
  participantIds: string[];
  splitMethod: SplitMethod;
  splitValues: Record<string, string>;
  notes: string;
  recurrence?: "none" | "weekly" | "fortnightly" | "monthly" | "yearly";
}

export type SplitMethod = "equal" | "exact" | "percentage" | "shares" | "adjustment";

export interface NewGroupInput {
  name: string;
  settlementCurrency: string;
}

function nonNegativeMoneyToMinor(value: string): number {
  const normalized = value.trim();
  if (normalized === "" || /^0+(?:\.0{0,2})?$/.test(normalized)) return 0;
  return parseDecimalToMinor(normalized);
}

function signedMoneyToMinor(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError("Enter an amount with no more than two decimal places.");
  const negative = normalized.startsWith("-");
  const absolute = negative ? normalized.slice(1) : normalized;
  const minor = /^0+(?:\.0{1,2})?$/.test(absolute) ? 0 : parseDecimalToMinor(absolute);
  return negative ? -minor : minor;
}

function percentageToBasisPoints(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError("Enter percentages with no more than two decimal places.");
  const basisPoints = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new RangeError("Enter a valid percentage.");
  return basisPoints;
}

export function calculateExpenseAllocations(input: Pick<NewExpenseInput, "amount" | "participantIds" | "splitMethod" | "splitValues">): ParticipantAmount[] {
  const amountMinor = parseDecimalToMinor(input.amount);
  if (input.participantIds.length === 0) throw new RangeError("Select at least one person.");
  if (input.splitMethod === "equal") return allocateEqually(amountMinor, input.participantIds);
  if (input.splitMethod === "exact") {
    return validateExactAllocation(amountMinor, input.participantIds.map((participantId) => ({
      participantId,
      amountMinor: nonNegativeMoneyToMinor(input.splitValues[participantId] ?? ""),
    })));
  }
  if (input.splitMethod === "percentage") {
    return allocateByWeights(amountMinor, input.participantIds.map((participantId) => ({
      participantId,
      weight: percentageToBasisPoints(input.splitValues[participantId] ?? "0"),
    })), 10_000);
  }
  if (input.splitMethod === "adjustment") {
    const adjustments = input.participantIds.map((participantId) => ({
      participantId,
      amountMinor: signedMoneyToMinor(input.splitValues[participantId] ?? "0"),
    }));
    const remaining = amountMinor - adjustments.reduce((sum, item) => sum + item.amountMinor, 0);
    if (remaining < 0) throw new RangeError("Reduce the adjustments so they do not exceed the total.");
    const shared = allocateEqually(remaining, input.participantIds);
    return validateExactAllocation(amountMinor, shared.map((item, index) => ({
      participantId: item.participantId,
      amountMinor: item.amountMinor + adjustments[index]!.amountMinor,
    })));
  }
  return allocateByWeights(amountMinor, input.participantIds.map((participantId) => {
    const weight = Number(input.splitValues[participantId] ?? "0");
    if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError("Enter shares as whole numbers.");
    return { participantId, weight };
  }));
}

export function calculateExpensePayers(input: {
  amount: string;
  payerIds: string[];
  payerValues: Record<string, string>;
}): ParticipantAmount[] {
  const amountMinor = parseDecimalToMinor(input.amount);
  if (input.payerIds.length === 0) throw new RangeError("Select at least one person who paid.");
  if (input.payerIds.length === 1) return [{ participantId: input.payerIds[0]!, amountMinor }];
  return validateExactAllocation(amountMinor, input.payerIds.map((participantId) => ({
    participantId,
    amountMinor: nonNegativeMoneyToMinor(input.payerValues[participantId] ?? ""),
  })));
}

const [groups, setGroups] = createSignal<LocalGroup[]>([]);
const [members, setMembers] = createSignal<LocalMember[]>([]);
const [expenses, setExpenses] = createSignal<LocalExpense[]>([]);
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
    liveQuery(() => localDb.operations.orderBy("clientTimestamp").reverse().toArray()).subscribe(setOperations),
  );
  window.addEventListener("online", () => void syncEngine.sync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncEngine.sync();
  });
  setInterval(() => void syncEngine.sync(), 30_000);
  await syncEngine.sync();
}

export async function createExpense(input: NewExpenseInput): Promise<string> {
  const device = await ensureDevice();
  if (!input.description.trim()) throw new RangeError("Enter what the expense was for.");
  if (input.participantIds.length === 0) throw new RangeError("Select at least one person.");
  const amountMinor = parseDecimalToMinor(input.amount);
  const allocations = calculateExpenseAllocations(input);
  const operationId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const payerIds = input.payerIds ?? (input.payerId ? [input.payerId] : []);
  const payers = calculateExpensePayers({ amount: input.amount, payerIds, payerValues: input.payerValues ?? {} });
  const payload: JsonValue = {
    description: input.description.trim(),
    category: input.category,
    amountMinor,
    currency: input.currency,
    expenseDate: input.expenseDate,
    notes: input.notes,
    recurrence: input.recurrence ?? "none",
    payers: payers.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
    allocations: allocations.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
  };
  const unsigned: UnsignedOperation = {
    id: operationId,
    groupId: input.groupId,
    actorId: device.actorId,
    deviceId: device.deviceId,
    type: "ExpenseCreated",
    targetId: expenseId,
    baseVersion: 0,
    clientTimestamp: new Date().toISOString(),
    payload,
  };
  const operation = await signOperation(unsigned, device.privateKey);
  const paid = payers.find(({ participantId }) => participantId === device.actorId)?.amountMinor ?? 0;
  const owed = allocations.find(({ participantId }) => participantId === device.actorId)?.amountMinor ?? 0;
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.expenses.add({
      id: expenseId,
      groupId: input.groupId,
      description: input.description.trim(),
      category: input.category,
      amountMinor,
      currency: input.currency,
      expenseDate: input.expenseDate,
      notes: input.notes,
      recurrence: input.recurrence ?? "none",
      payers,
      allocations,
      yourNetMinor: paid - owed,
      status: "active",
      version: 1,
      createdBy: device.actorId,
      updatedAt: unsigned.clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
  return expenseId;
}

export async function updateExpense(expense: LocalExpense, input: NewExpenseInput): Promise<string> {
  const device = await ensureDevice();
  const current = await localDb.expenses.get(expense.id);
  if (!current) throw new RangeError("This expense no longer exists.");
  if (current.version !== expense.version) throw new RangeError("This expense changed. Reopen it and try again.");
  if (current.status !== "active") throw new RangeError("Restore this expense before editing it.");
  if (current.readOnly) throw new RangeError("Imported expenses can’t be edited. Undo the import and import again to make changes.");
  if (current.groupId !== input.groupId) throw new RangeError("Keep this expense in its original group.");
  if (!input.description.trim()) throw new RangeError("Enter what the expense was for.");
  if (input.participantIds.length === 0) throw new RangeError("Select at least one person.");
  const amountMinor = parseDecimalToMinor(input.amount);
  const allocations = calculateExpenseAllocations(input);
  const payerIds = input.payerIds ?? (input.payerId ? [input.payerId] : []);
  const payers = calculateExpensePayers({ amount: input.amount, payerIds, payerValues: input.payerValues ?? {} });
  const clientTimestamp = new Date().toISOString();
  const payload: JsonValue = {
    description: input.description.trim(),
    category: input.category,
    amountMinor,
    currency: input.currency,
    expenseDate: input.expenseDate,
    notes: input.notes,
    recurrence: input.recurrence ?? "none",
    payers: payers.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
    allocations: allocations.map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
  };
  const unsigned: UnsignedOperation = {
    id: crypto.randomUUID(),
    groupId: current.groupId,
    actorId: device.actorId,
    deviceId: device.deviceId,
    type: "ExpenseAmended",
    targetId: current.id,
    baseVersion: current.version,
    clientTimestamp,
    payload,
  };
  const operation = await signOperation(unsigned, device.privateKey);
  const paid = payers.find(({ participantId }) => participantId === device.actorId)?.amountMinor ?? 0;
  const owed = allocations.find(({ participantId }) => participantId === device.actorId)?.amountMinor ?? 0;
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    const latest = await localDb.expenses.get(current.id);
    if (!latest || latest.version !== current.version || latest.status !== "active") {
      throw new RangeError("This expense changed while you were editing it. Reopen it and try again.");
    }
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.expenses.put({
      ...current,
      description: input.description.trim(),
      category: input.category,
      amountMinor,
      currency: input.currency,
      expenseDate: input.expenseDate,
      notes: input.notes,
      recurrence: input.recurrence ?? "none",
      payers,
      allocations,
      yourNetMinor: paid - owed,
      version: current.version + 1,
      updatedAt: clientTimestamp,
      syncStatus: "pending",
    });
  });
  void syncEngine.sync();
  return current.id;
}

export async function createGroup(input: NewGroupInput): Promise<string> {
  const device = await ensureDevice();
  const name = input.name.trim();
  const settlementCurrency = input.settlementCurrency.trim().toUpperCase();
  if (!name || name.length > 100) throw new RangeError("Enter a group name with 100 characters or fewer.");
  if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new RangeError("Choose a valid three-letter currency code.");
  const groupId = crypto.randomUUID();
  const clientTimestamp = new Date().toISOString();
  const unsigned: UnsignedOperation = {
    id: crypto.randomUUID(),
    groupId,
    actorId: device.actorId,
    deviceId: device.deviceId,
    type: "GroupCreated",
    targetId: groupId,
    baseVersion: 0,
    clientTimestamp,
    payload: { name, settlementCurrency },
  };
  const operation = await signOperation(unsigned, device.privateKey);
  const currentMember = members().find((member) => member.userId === device.actorId);
  await localDb.transaction("rw", localDb.operations, localDb.groups, localDb.members, async () => {
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.groups.add({ id: groupId, name, settlementCurrency, createdAt: clientTimestamp, version: 0 });
    await localDb.members.add({
      id: `${groupId}:${device.actorId}`,
      groupId,
      userId: device.actorId,
      displayName: currentMember?.displayName ?? "You",
      ...(currentMember?.email ? { email: currentMember.email } : {}),
      status: "active",
    });
  });
  void syncEngine.sync();
  return groupId;
}

export async function changeGroupCurrency(groupId: string, value: string): Promise<void> {
  const device = await ensureDevice();
  const settlementCurrency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new RangeError("Choose a valid three-letter currency code.");
  const group = await localDb.groups.get(groupId);
  if (!group) throw new RangeError("This group no longer exists.");
  if (group.settlementCurrency === settlementCurrency) return;
  const expenseCount = await localDb.expenses.where("groupId").equals(groupId).count();
  const hasPayment = await localDb.operations
    .where("groupId")
    .equals(groupId)
    .filter((operation) =>
      operation.type === "PaymentRecorded" &&
      operation.syncStatus !== "rejected" &&
      operation.syncStatus !== "conflicted",
    )
    .first();
  if (expenseCount > 0 || hasPayment) {
    throw new RangeError("The currency cannot change after the first expense or payment.");
  }
  const clientTimestamp = new Date().toISOString();
  const operation = await signOperation({
    id: crypto.randomUUID(),
    groupId,
    actorId: device.actorId,
    deviceId: device.deviceId,
    type: "GroupCurrencyChanged",
    targetId: groupId,
    baseVersion: group.version ?? 0,
    clientTimestamp,
    payload: { settlementCurrency },
  }, device.privateKey);
  await localDb.transaction("rw", localDb.operations, localDb.groups, async () => {
    const current = await localDb.groups.get(groupId);
    if (!current || (current.version ?? 0) !== (group.version ?? 0)) {
      throw new RangeError("This group changed. Refresh and try again.");
    }
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.groups.update(groupId, {
      settlementCurrency,
      version: (group.version ?? 0) + 1,
    });
  });
  void syncEngine.sync();
}

async function enqueueOperation(unsigned: UnsignedOperation): Promise<LocalOperation> {
  const device = await ensureDevice();
  const operation = await signOperation(unsigned, device.privateKey);
  const localOperation: LocalOperation = { ...operation, syncStatus: "pending" };
  await localDb.operations.add(localOperation);
  void syncEngine.sync();
  return localOperation;
}

export async function voidExpense(expense: LocalExpense, reason = ""): Promise<void> {
  const device = await ensureDevice();
  const current = await localDb.expenses.get(expense.id);
  if (!current) throw new RangeError("This expense no longer exists.");
  if (current.version !== expense.version) throw new RangeError("This expense changed. Reopen it and try again.");
  if (current.status !== "active") throw new RangeError("This expense is already deleted.");
  if (current.readOnly) throw new RangeError("Undo the import to remove an imported expense.");
  const clientTimestamp = new Date().toISOString();
  const operation = await signOperation({
    id: crypto.randomUUID(), groupId: current.groupId, actorId: device.actorId, deviceId: device.deviceId,
    type: "ExpenseVoided", targetId: current.id, baseVersion: current.version, clientTimestamp, payload: { reason },
  }, device.privateKey);
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    const latest = await localDb.expenses.get(current.id);
    if (!latest || latest.version !== current.version || latest.status !== "active") {
      throw new RangeError("This expense changed. Reopen it and try again.");
    }
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.expenses.update(current.id, { status: "voided", version: current.version + 1, updatedAt: clientTimestamp, syncStatus: "pending" });
  });
  void syncEngine.sync();
}

export async function restoreExpense(expense: LocalExpense): Promise<void> {
  const device = await ensureDevice();
  const current = await localDb.expenses.get(expense.id);
  if (!current) throw new RangeError("This expense no longer exists.");
  if (current.version !== expense.version) throw new RangeError("This expense changed. Reopen it and try again.");
  if (current.status !== "voided") throw new RangeError("This expense is already active.");
  if (current.readOnly) throw new RangeError("Undo the import to restore an imported expense.");
  const clientTimestamp = new Date().toISOString();
  const operation = await signOperation({
    id: crypto.randomUUID(), groupId: current.groupId, actorId: device.actorId, deviceId: device.deviceId,
    type: "ExpenseRestored", targetId: current.id, baseVersion: current.version, clientTimestamp, payload: { reason: "Restored from activity" },
  }, device.privateKey);
  await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
    const latest = await localDb.expenses.get(current.id);
    if (!latest || latest.version !== current.version || latest.status !== "voided") {
      throw new RangeError("This expense changed. Reopen it and try again.");
    }
    await localDb.operations.add({ ...operation, syncStatus: "pending" });
    await localDb.expenses.update(current.id, { status: "active", version: current.version + 1, updatedAt: clientTimestamp, syncStatus: "pending" });
  });
  void syncEngine.sync();
}

export async function addComment(expense: LocalExpense, body: string): Promise<void> {
  const device = await ensureDevice();
  const value = body.trim();
  if (!value || value.length > 2_000) throw new RangeError("Enter a comment with 2,000 characters or fewer.");
  await enqueueOperation({
    id: crypto.randomUUID(), groupId: expense.groupId, actorId: device.actorId, deviceId: device.deviceId,
    type: "CommentAdded", targetId: expense.id, baseVersion: expense.version, clientTimestamp: new Date().toISOString(), payload: { body: value },
  });
}

export async function recordPayment(input: {
  groupId: string; payerId: string; recipientId: string; amount: string; currency: string; paymentDate: string; note: string;
}): Promise<string> {
  const device = await ensureDevice();
  const amountMinor = parseDecimalToMinor(input.amount);
  if (input.payerId === input.recipientId) throw new RangeError("Choose two different people for the payment.");
  const paymentId = crypto.randomUUID();
  await enqueueOperation({
    id: crypto.randomUUID(), groupId: input.groupId, actorId: device.actorId, deviceId: device.deviceId,
    type: "PaymentRecorded", targetId: paymentId, baseVersion: 0, clientTimestamp: new Date().toISOString(),
    payload: { payerId: input.payerId, recipientId: input.recipientId, amountMinor, currency: input.currency, paymentDate: input.paymentDate, note: input.note.trim() },
  });
  return paymentId;
}

export const appStore = {
  groups,
  members,
  expenses,
  operations,
  connection,
  connectionMessage,
  sync: () => syncEngine.sync(),
};
