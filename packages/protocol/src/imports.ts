import type { JsonValue } from "./canonical";
import type { OperationEnvelope } from "./operations";

export const importProviders = ["splitwise"] as const;
export type ImportProvider = (typeof importProviders)[number];

export const importModes = ["current", "history", "balances", "custom"] as const;
export type ImportMode = (typeof importModes)[number];

export const importRecordKinds = ["expense", "payment", "balance_effect", "opening_balance"] as const;
export type ImportRecordKind = (typeof importRecordKinds)[number];

export interface ImportPerson {
  externalId: string;
  displayName: string;
  email?: string;
  emailTrust: "provider" | "exported" | "untrusted" | "none";
}

export interface ImportGroup {
  externalId: string;
  name: string;
  currency: string;
  status: "current" | "settled";
  memberExternalIds: string[];
  sourceHashes?: string[];
}

export interface ImportAmount {
  externalPersonId: string;
  amountMinor: number;
}

export interface NormalizedImportRecord {
  externalId: string;
  externalGroupId: string;
  kind: ImportRecordKind;
  description: string;
  category: string;
  amountMinor: number;
  currency: string;
  transactionDate: string;
  notes: string;
  recurrence: "none" | "weekly" | "fortnightly" | "monthly" | "yearly";
  deleted: boolean;
  payers?: ImportAmount[];
  allocations?: ImportAmount[];
  effects?: ImportAmount[];
  payerExternalId?: string;
  recipientExternalId?: string;
  source: {
    fileHash?: string;
    row?: number;
    providerRecordId?: string;
    providerGroupId?: string;
    providerFriendshipId?: string;
    createdAt?: string;
    updatedAt?: string;
    deletedAt?: string;
    rawKind?: string;
  };
}

export interface ImportWarning {
  code: string;
  message: string;
  sourceName?: string;
  sourceHash?: string;
  row?: number;
  field?: "personName" | "direction" | "amount" | "currency" | "groupName" | "effectiveDate";
  recordExternalId?: string;
  blocking: boolean;
}

export interface SourceBalance {
  externalGroupId?: string;
  externalPersonId: string;
  currency: string;
  amountMinor: number;
  sourceHash?: string;
}

export interface NormalizedImportDraft {
  schemaVersion: 1;
  provider: ImportProvider;
  mode: ImportMode;
  sourceAccountId?: string;
  sourceHashes: string[];
  /** Local-only accounting used to enforce the aggregate file limit on resume/add-more flows. */
  sourceByteSizes?: Record<string, number>;
  /** Local-only labels used for file-specific review and removal. */
  sourceNames?: Record<string, string>;
  people: ImportPerson[];
  groups: ImportGroup[];
  records: NormalizedImportRecord[];
  sourceBalances: SourceBalance[];
  warnings: ImportWarning[];
}

export interface ReconciliationLine {
  externalGroupId?: string;
  externalPersonId: string;
  currency: string;
  sourceMinor?: number;
  computedMinor: number;
  differenceMinor?: number;
  matches: boolean;
}

export interface ReconciliationParticipantTotal {
  externalPersonId: string;
  currency: string;
  paidMinor: number;
  owedMinor: number;
  paymentsSentMinor: number;
  paymentsReceivedMinor: number;
  netMinor: number;
}

export interface ReconciliationGroupTotal {
  externalGroupId: string;
  currency: string;
  paidMinor: number;
  owedMinor: number;
  paymentsMinor: number;
  netMinor: number;
}

export interface ImportReconciliation {
  groupCount: number;
  personCount: number;
  recordCount: number;
  duplicateCount: number;
  unresolvedPeople: number;
  malformedRecords: number;
  zeroSum: boolean;
  lines: ReconciliationLine[];
  participantTotals: ReconciliationParticipantTotal[];
  groupTotals: ReconciliationGroupTotal[];
  blockingWarnings: ImportWarning[];
}

export interface ImportExternalMapping {
  provider: ImportProvider;
  externalType: "group" | "person" | "record";
  externalId: string;
  localId: string;
}

export interface ImportOperationMetadata {
  importBatchId: string;
  sourceProvider: ImportProvider;
  sourceRecordId: string;
  importedAt: string;
  importedByDisplayName: string;
  readOnly: true;
  sourceDeleted?: boolean;
}

export interface PlannedImportIdentity {
  id: string;
  externalId: string;
  displayName: string;
  email?: string;
  emailTrust: ImportPerson["emailTrust"];
  groupIds: string[];
  isImporter?: boolean;
  /** Server-preflighted participant target used by signed operations. */
  localUserId: string;
}

export interface ImportIdentityResolutionRequest {
  provider: ImportProvider;
  identities: Array<Pick<PlannedImportIdentity,
    "id" | "externalId" | "displayName" | "email" | "emailTrust" | "isImporter">>;
}

export interface ImportIdentityResolutionResult {
  resolved: Record<string, string>;
}

export interface ImportOperationLink {
  operationId: string;
  externalType: "group" | "record";
  externalId: string;
  /** Stable provider ids are authoritative; CSV candidates require scoped review. */
  dedupeStrategy?: "provider_id" | "csv_candidate";
  /** SHA-256 of normalized financial semantics; stored only as a server-keyed digest. */
  semanticId?: string;
  /** Owner-scoped provider details. Never copied into a signed shared operation. */
  sourceMetadata?: JsonValue;
}

export interface ImportBatchCommitRequest {
  id: string;
  provider: ImportProvider;
  mode: ImportMode;
  fingerprint: string;
  sourceAccountId?: string;
  sourceHashes: string[];
  selectedSourceGroups: string[];
  identities: PlannedImportIdentity[];
  operations: OperationEnvelope[];
  operationLinks: ImportOperationLink[];
  sourceBalances: SourceBalance[];
  reconciliation: ImportReconciliation;
  warnings: ImportWarning[];
}

export interface ImportBatchSummary {
  id: string;
  provider: ImportProvider;
  mode: ImportMode;
  status: "completed" | "undone" | "cancelled";
  rollbackStatus: "available" | "completed" | "not_available";
  startedAt: string;
  completedAt?: string;
  undoneAt?: string;
  groupCount: number;
  recordCount: number;
  warningCount: number;
  sourceDataDeletedAt?: string;
}

export interface ImportActivationResult {
  batch: ImportBatchSummary;
  duplicate: boolean;
  accepted: Array<{ id: string; serverSequence: number }>;
}

/** Compact, locally persisted review after signed operations are encrypted-staged. */
export interface ImportPreparedReview {
  id: string;
  mode: ImportMode;
  operationCount: number;
  reconciliation: ImportReconciliation;
  people: Array<{ externalId: string; displayName: string }>;
  groups: Array<{ externalId: string; name: string }>;
}

/**
 * Canonical material that binds a resumable upload to the exact import the
 * user reviewed. Operation content hashes bind every signed field without
 * making nondeterministic ECDSA signature bytes part of retry identity.
 */
export function importPreparationMaterial(request: ImportBatchCommitRequest): JsonValue {
  const { operations, operationLinks, ...batch } = request;
  return JSON.parse(JSON.stringify({
    batch,
    operations: operations.map(({ id, contentHash }) => ({ id, contentHash })),
    operationLinks,
  })) as JsonValue;
}

export interface ImportStageStartRequest {
  batch: Omit<ImportBatchCommitRequest, "operations" | "operationLinks">;
  expectedOperationCount: number;
  /** SHA-256 of canonical importPreparationMaterial for this exact review. */
  preparationHash: string;
}

export interface ImportStageChunkRequest {
  start: number;
  operations: OperationEnvelope[];
  operationLinks: ImportOperationLink[];
}

export interface ImportStageStatus {
  batchId: string;
  expectedOperationCount: number;
  receivedOperationCount: number;
  status: "staging" | "ready" | "activated";
  expiresAt: string;
  /** Included when starting or resuming an upload; omitted from chunk acknowledgements. */
  missingRanges?: Array<{ start: number; endExclusive: number }>;
  completedBatch?: ImportBatchSummary;
}

export interface ImportUndoRequest {
  operations: OperationEnvelope[];
}

export interface ImportUndoStageStartRequest {
  expectedOperationCount: number;
}

export interface ImportUndoStageChunkRequest {
  start: number;
  operations: OperationEnvelope[];
}

export interface ImportUndoStageStatus {
  batchId: string;
  expectedOperationCount: number;
  receivedOperationCount: number;
  status: "staging" | "ready" | "undone";
  expiresAt: string;
  /** Included when starting or resuming an upload; omitted from chunk acknowledgements. */
  missingRanges?: Array<{ start: number; endExclusive: number }>;
  completedBatch?: ImportBatchSummary;
}

export interface ImportUndoResult {
  batch: ImportBatchSummary;
  duplicate: boolean;
  accepted: Array<{ id: string; serverSequence: number }>;
}

export interface ImportIdentitySummary {
  id: string;
  displayName: string;
  status: "unclaimed" | "reserved" | "awaiting_owner" | "claimed" | "revoked";
  emailTrust: ImportPerson["emailTrust"];
  claimExpiresAt?: string;
  claimant?: {
    displayName: string;
    email: string;
    requestedAt: string;
    expiresAt: string;
  };
}

export interface ImportClaimLink {
  identityId: string;
  token: string;
  expiresAt: string;
}

export interface ImportClaimPreview {
  provider: ImportProvider;
  expiresAt: string;
}

export interface ImportClaimResult {
  status: "claimed" | "awaiting_owner";
  displayName: string;
  requestId?: string;
  expiresAt?: string;
}

export interface ImportClaimStatus {
  status: "awaiting_owner" | "claimed" | "rejected" | "expired";
  displayName: string;
  expiresAt: string;
}
