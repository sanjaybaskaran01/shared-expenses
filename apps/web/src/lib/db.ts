import Dexie, { type EntityTable } from "dexie";
import type {
  ConfidentialOperationEnvelope,
  GroupKeyEnvelope,
  JsonValue,
  OperationEnvelope,
  ParticipantAmount,
} from "@expenses/protocol";

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
  agreementPrivateKey?: CryptoKey;
  agreementPublicKeyJwk?: JsonWebKey;
}

export interface SettingRecord {
  key: string;
  value: JsonValue;
}

export interface LocalConfidentialOperation extends ConfidentialOperationEnvelope {
  syncStatus: "pending" | "accepted" | "rejected";
  errorCode?: string;
}

export interface LocalGroupKeyEnvelope extends GroupKeyEnvelope {
  id: string;
}

export class ExpensesDatabase extends Dexie {
  operations!: EntityTable<LocalOperation, "id">;
  groups!: EntityTable<LocalGroup, "id">;
  members!: EntityTable<LocalMember, "id">;
  expenses!: EntityTable<LocalExpense, "id">;
  devices!: EntityTable<DeviceRecord, "id">;
  settings!: EntityTable<SettingRecord, "key">;
  confidentialOperations!: EntityTable<LocalConfidentialOperation, "id">;
  groupKeyEnvelopes!: EntityTable<LocalGroupKeyEnvelope, "id">;

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
    this.version(2).stores({
      operations: "id, syncStatus, serverSequence, groupId, targetId, clientTimestamp",
      groups: "id, createdAt",
      members: "id, groupId, userId, status",
      expenses: "id, groupId, expenseDate, status, syncStatus, updatedAt",
      devices: "id, deviceId, actorId",
      settings: "key",
    });
    this.version(3).stores({
      operations: "id, syncStatus, serverSequence, groupId, targetId, clientTimestamp",
      groups: "id, createdAt",
      members: "id, groupId, userId, status",
      expenses: "id, groupId, expenseDate, status, syncStatus, updatedAt",
      devices: "id, deviceId, actorId",
      settings: "key",
      confidentialOperations: "id, syncStatus, serverSequence, groupId, keyEpoch, clientTimestamp",
      groupKeyEnvelopes: "id, groupId, keyEpoch, recipientDeviceId",
    });
  }
}

export const localDb = new ExpensesDatabase();
