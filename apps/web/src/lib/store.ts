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
import { localDb, type LocalExpense, type LocalGroup, type LocalMember } from "./db";
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
  splitMethod: SplitMethod;
  splitValues: Record<string, string>;
  notes: string;
}

export type SplitMethod = "equal" | "exact" | "percentage" | "shares";

function nonNegativeMoneyToMinor(value: string): number {
  const normalized = value.trim();
  if (normalized === "" || /^0+(?:\.0{0,2})?$/.test(normalized)) return 0;
  return parseDecimalToMinor(normalized);
}

function percentageToBasisPoints(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError("Use percentages with at most two decimal places");
  const basisPoints = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new RangeError("Enter a valid percentage");
  return basisPoints;
}

export function calculateExpenseAllocations(input: Pick<NewExpenseInput, "amount" | "participantIds" | "splitMethod" | "splitValues">): ParticipantAmount[] {
  const amountMinor = parseDecimalToMinor(input.amount);
  if (input.participantIds.length === 0) throw new RangeError("Select at least one participant");
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
  return allocateByWeights(amountMinor, input.participantIds.map((participantId) => {
    const weight = Number(input.splitValues[participantId] ?? "0");
    if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError("Shares must be whole numbers");
    return { participantId, weight };
  }));
}

const [groups, setGroups] = createSignal<LocalGroup[]>([]);
const [members, setMembers] = createSignal<LocalMember[]>([]);
const [expenses, setExpenses] = createSignal<LocalExpense[]>([]);
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
  if (!input.description.trim()) throw new RangeError("Description is required");
  if (input.participantIds.length === 0) throw new RangeError("Select at least one participant");
  const amountMinor = parseDecimalToMinor(input.amount);
  const allocations = calculateExpenseAllocations(input);
  const operationId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const payers = [{ participantId: input.payerId, amountMinor }];
  const payload: JsonValue = {
    description: input.description.trim(),
    category: input.category,
    amountMinor,
    currency: input.currency,
    expenseDate: input.expenseDate,
    notes: input.notes,
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
  const paid = input.payerId === device.actorId ? amountMinor : 0;
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

export const appStore = {
  groups,
  members,
  expenses,
  connection,
  connectionMessage,
  sync: () => syncEngine.sync(),
};
