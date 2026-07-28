import { canonicalJson, sha256Hex, type JsonValue } from "./canonical";

export const operationTypes = [
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
  "CommentAdded",
  "PaymentRecorded",
  "PaymentReversed",
  "GroupCreated",
  "GroupCurrencyChanged",
  "GroupMemberAdded",
  "GroupMemberRemoved",
  "ConflictResolved",
] as const;

export type OperationType = (typeof operationTypes)[number];

export interface OperationEnvelope<TPayload extends JsonValue = JsonValue> {
  id: string;
  groupId: string;
  actorId: string;
  deviceId: string;
  type: OperationType;
  targetId: string;
  baseVersion: number;
  clientTimestamp: string;
  payload: TPayload;
  contentHash: string;
  signature: string;
  serverSequence?: number;
  receivedAt?: string;
}

export type UnsignedOperation<TPayload extends JsonValue = JsonValue> = Omit<
  OperationEnvelope<TPayload>,
  "contentHash" | "signature"
>;

export function operationSigningValue(operation: UnsignedOperation | OperationEnvelope): JsonValue {
  return {
    actorId: operation.actorId,
    baseVersion: operation.baseVersion,
    clientTimestamp: operation.clientTimestamp,
    deviceId: operation.deviceId,
    groupId: operation.groupId,
    id: operation.id,
    payload: operation.payload,
    targetId: operation.targetId,
    type: operation.type,
  };
}

export async function operationContentHash(operation: UnsignedOperation): Promise<string> {
  return sha256Hex(canonicalJson(operationSigningValue(operation)));
}

export function isOperationType(value: string): value is OperationType {
  return operationTypes.includes(value as OperationType);
}

export interface SyncPushRequest {
  operations: OperationEnvelope[];
}

export interface SyncPushResult {
  accepted: Array<{ id: string; serverSequence: number }>;
  duplicates: Array<{ id: string; serverSequence: number }>;
  conflicts: Array<{ id: string; conflictId: string; currentVersion: number }>;
  rejected: Array<{ id: string; code: string; message: string }>;
  latestServerSequence: number;
  generation: string;
}
