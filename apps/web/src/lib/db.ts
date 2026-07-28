import Dexie, { type EntityTable } from "dexie";
import type { JsonValue, OperationEnvelope, ParticipantAmount } from "@expenses/protocol";

export type SyncStatus = "pending" | "accepted" | "conflicted" | "rejected";

export interface LocalOperation extends OperationEnvelope {
  syncStatus: SyncStatus;
  errorCode?: string;
}

export interface LocalGroup {
  id: string;
  name: string;
  settlementCurrency: string;
  createdAt: string;
  version?: number;
}

export interface LocalMember {
  id: string;
  groupId: string;
  userId: string;
  displayName: string;
  email?: string;
  status: string;
}

export interface LocalExpense {
  id: string;
  groupId: string;
  description: string;
  category: string;
  amountMinor: number;
  currency: string;
  expenseDate: string;
  notes: string;
  recurrence?: "none" | "weekly" | "fortnightly" | "monthly" | "yearly";
  payers: ParticipantAmount[];
  allocations: ParticipantAmount[];
  yourNetMinor: number;
  status: "active" | "voided";
  version: number;
  createdBy: string;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export interface DeviceRecord {
  id: "current";
  deviceId: string;
  actorId: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

export interface SettingRecord {
  key: string;
  value: JsonValue;
}

export class ExpensesDatabase extends Dexie {
  operations!: EntityTable<LocalOperation, "id">;
  groups!: EntityTable<LocalGroup, "id">;
  members!: EntityTable<LocalMember, "id">;
  expenses!: EntityTable<LocalExpense, "id">;
  devices!: EntityTable<DeviceRecord, "id">;
  settings!: EntityTable<SettingRecord, "key">;

  constructor() {
    super("expenses-ledger");
    this.version(1).stores({
      operations: "id, syncStatus, serverSequence, groupId, targetId, clientTimestamp",
      groups: "id, createdAt",
      members: "id, groupId, userId, status",
      expenses: "id, groupId, expenseDate, status, syncStatus, updatedAt",
      devices: "id, deviceId, actorId",
      settings: "key",
    });
  }
}

export const localDb = new ExpensesDatabase();
