import { Dialog } from "@kobalte/core/dialog";
import { AlertDialog } from "@kobalte/core/alert-dialog";
import ArrowLeft from "lucide-solid/icons/arrow-left";
import Check from "lucide-solid/icons/check";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleDollarSign from "lucide-solid/icons/circle-dollar-sign";
import Database from "lucide-solid/icons/database";
import ExternalLink from "lucide-solid/icons/external-link";
import FileText from "lucide-solid/icons/file-text";
import Link from "lucide-solid/icons/link";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import ShieldCheck from "lucide-solid/icons/shield-check";
import Trash2 from "lucide-solid/icons/trash-2";
import Upload from "lucide-solid/icons/upload";
import WalletCards from "lucide-solid/icons/wallet-cards";
import X from "lucide-solid/icons/x";
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import type {
  ImportBatchSummary,
  ImportIdentitySummary,
  ImportPreparedReview,
  JsonValue,
  NormalizedImportDraft,
} from "@expenses/protocol";
import {
  activateStagedImport,
  approveImportIdentityClaim,
  cancelImportUpload,
  createImportClaimLink,
  deleteImportSourceData,
  getImportCapabilities,
  getImportIdentities,
  getImports,
  getSplitwiseSnapshot,
  rejectImportIdentityClaim,
  startSplitwiseImport,
} from "../lib/api";
import { localDb } from "../lib/db";
import { ensureDevice } from "../lib/device";
import { planImportOffMainThread } from "../lib/import-commit-worker";
import { undoImportOffMainThread } from "../lib/import-undo-worker";
import {
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_FILE_LIMIT,
  IMPORT_TOTAL_BYTES_LIMIT,
  combineImportDrafts,
  createOpeningBalanceDraft,
  openingBalanceReviewRows,
  migrationRowLimit,
  sha256ImportSource,
  supportedImportFileKind,
} from "../lib/splitwise-import";
import { parseImportTextOffMainThread } from "../lib/splitwise-import-worker";
import { appStore } from "../lib/store";
import { Avatar, Badge, Button, Card } from "./ui";

type Step = "choose" | "select" | "balances" | "review" | "complete" | "manage";

interface OpeningRow {
  rowId: string;
  personKey: string;
  personName: string;
  direction: "owes_me" | "i_owe";
  amount: string;
  currency: string;
  groupName: string;
  effectiveDate: string;
}

type OpeningField = "personName" | "direction" | "amount" | "currency" | "groupName" | "effectiveDate";

function today(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function newOpeningRow(template?: Partial<OpeningRow>): OpeningRow {
  const rowId = crypto.randomUUID();
  return {
    rowId,
    personKey: rowId,
    personName: "",
    direction: "owes_me",
    amount: "",
    currency: "USD",
    groupName: "Opening balances",
    effectiveDate: today(),
    ...template,
  };
}

function formatMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function formatSignedMinor(amountMinor: number, currency: string): string {
  if (amountMinor === 0) return formatMinor(0, currency);
  return `${amountMinor > 0 ? "+" : "−"}${formatMinor(Math.abs(amountMinor), currency)}`;
}

export function MigrationDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  actorId: string;
  displayName: string;
  launchMessage?: string;
  splitwiseSession?: string;
  onSplitwiseSessionConsumed?(): void;
  onComplete?(message: string): void;
}) {
  const [step, setStep] = createSignal<Step>("choose");
  const [draft, setDraft] = createSignal<NormalizedImportDraft>();
  const [selectedGroupIds, setSelectedGroupIds] = createSignal<string[]>([]);
  const [importerExternalIds, setImporterExternalIds] = createSignal<string[]>([]);
  const [commit, setCommit] = createSignal<ImportPreparedReview>();
  const [completedBatch, setCompletedBatch] = createSignal<ImportBatchSummary>();
  const [identities, setIdentities] = createSignal<ImportIdentitySummary[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [reviewed, setReviewed] = createSignal(false);
  const [destructiveAction, setDestructiveAction] = createSignal<{ kind: "discard" | "undo" | "delete"; batch?: ImportBatchSummary }>();
  const [expandedPeopleBatch, setExpandedPeopleBatch] = createSignal<string>();
  const [managedIdentities, setManagedIdentities] = createSignal<ImportIdentitySummary[]>([]);
  const [claimDecision, setClaimDecision] = createSignal<{ identity: ImportIdentitySummary; batchId: string }>();
  const [openingError, setOpeningError] = createSignal<{ row: number; field: OpeningField; message: string }>();
  const [openingRows, setOpeningRows] = createSignal<OpeningRow[]>([newOpeningRow()]);
  let contentRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let wasOpen = false;
  let focusedStep: Step | undefined;
  const migrationDraftId = `active-migration:${props.actorId}`;
  const openingRowsStorageKey = `migration-opening-rows:${props.actorId}`;
  const deviceRowLimit = migrationRowLimit(
    typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(pointer: coarse)").matches,
  );

  function rowLimitError(): string {
    return deviceRowLimit < 100_000
      ? `This phone supports up to ${deviceRowLimit.toLocaleString()} entries in one migration. Use Tallied on a desktop for exports up to 100,000.`
      : `A migration can contain at most ${deviceRowLimit.toLocaleString()} financial entries in total`;
  }

  const [capabilities] = createResource(() => props.open, async (open) => open ? getImportCapabilities() : undefined);
  const [imports, { refetch: refetchImports }] = createResource(() => props.open, async (open) => open ? getImports() : undefined);
  const messageIsError = createMemo(() => /(could not|invalid|must|resolve|unavailable|failed|too (?:many|large)|at most|mismatch|already imported|expired)/i.test(message()));
  const currentGroups = createMemo(() => draft()?.groups.filter((group) => group.status === "current") ?? []);
  const olderGroups = createMemo(() => draft()?.groups.filter((group) => group.status !== "current") ?? []);
  const currencyCount = createMemo(() => new Set(draft()?.groups.map(({ currency }) => currency) ?? []).size);
  const sourceBytes = createMemo(() => Object.values(draft()?.sourceByteSizes ?? {}).reduce((sum, bytes) => sum + bytes, 0));
  const selectedEntryCount = createMemo(() => {
    const selected = new Set(selectedGroupIds());
    return draft()?.records.filter(({ externalGroupId }) => selected.has(externalGroupId)).length ?? 0;
  });
  const balanceReviewRows = createMemo(() => {
    const value = draft();
    return value ? openingBalanceReviewRows(value, importerExternalIds(), selectedGroupIds()) : [];
  });

  createEffect(() => {
    if (!props.open || wasOpen) {
      wasOpen = props.open;
      return;
    }
    wasOpen = true;
    if (props.launchMessage) setMessage(props.launchMessage);
    void restoreOpeningRows();
    void restoreDraft();
    if (props.splitwiseSession) void consumeSplitwiseSession(props.splitwiseSession);
  });

  createEffect(() => {
    const next = step();
    if (!props.open) {
      focusedStep = undefined;
      return;
    }
    if (focusedStep === undefined) {
      focusedStep = next;
      return;
    }
    if (focusedStep === next) return;
    focusedStep = next;
    queueMicrotask(() => contentRef?.querySelector<HTMLElement>(`[data-migration-step="${next}"]`)?.focus());
  });

  async function restoreDraft(): Promise<void> {
    const saved = await localDb.importDrafts.get(migrationDraftId);
    if (!saved || saved.ownerActorId !== props.actorId || props.splitwiseSession) return;
    setDraft(saved.draft);
    setSelectedGroupIds(saved.selectedGroupIds ?? saved.draft.groups.map(({ externalId }) => externalId));
    setImporterExternalIds(saved.importerExternalIds ?? [saved.importerExternalId ?? saved.draft.sourceAccountId ?? saved.draft.people[0]?.externalId ?? ""].filter(Boolean));
    if (saved.prepared) {
      setCommit(saved.prepared);
      setStep("review");
      if (saved.draft.mode !== "balances") setDraft(undefined);
    } else {
      setStep(saved.draft.mode === "balances" ? "balances" : "select");
    }
    if (saved.commit) void persistDraft(saved.draft, saved.prepared);
    setMessage("Your migration draft was restored on this device.");
  }

  async function restoreOpeningRows(): Promise<void> {
    const saved = await localDb.settings.get(openingRowsStorageKey);
    if (!saved || !Array.isArray(saved.value)) return;
    const rows = saved.value.flatMap((item): OpeningRow[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, JsonValue>;
      if (
        typeof row.personName !== "string" ||
        (row.direction !== "owes_me" && row.direction !== "i_owe") ||
        typeof row.amount !== "string" ||
        typeof row.currency !== "string" ||
        typeof row.groupName !== "string" ||
        typeof row.effectiveDate !== "string"
      ) return [];
      const rowId = typeof row.rowId === "string" && row.rowId ? row.rowId : crypto.randomUUID();
      return [{
        rowId,
        personKey: typeof row.personKey === "string" && row.personKey ? row.personKey : rowId,
        personName: row.personName,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        groupName: row.groupName,
        effectiveDate: row.effectiveDate,
      }];
    });
    if (rows.length > 0) setOpeningRows(rows);
  }

  function updateOpeningRows(update: (rows: OpeningRow[]) => OpeningRow[]): void {
    setOpeningRows((rows) => {
      const next = update(rows);
      void localDb.settings.put({ key: openingRowsStorageKey, value: next as unknown as JsonValue });
      if (draft()?.mode === "balances" || commit()?.mode === "balances") {
        setDraft(undefined);
        setCommit(undefined);
        setReviewed(false);
        void localDb.importDrafts.delete(migrationDraftId);
      }
      return next;
    });
  }

  async function persistDraft(value: NormalizedImportDraft, prepared?: ImportPreparedReview): Promise<void> {
    await localDb.importDrafts.put({
      id: migrationDraftId,
      ownerActorId: props.actorId,
      updatedAt: new Date().toISOString(),
      status: prepared ? "ready" : "draft",
      draft: value,
      selectedGroupIds: selectedGroupIds(),
      importerExternalIds: importerExternalIds(),
      ...(prepared ? { prepared } : {}),
    });
  }

  async function consumeSplitwiseSession(sessionId: string): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const result = await getSplitwiseSnapshot(sessionId);
      const text = JSON.stringify(result.snapshot);
      const sourceHash = await sha256ImportSource(text);
      applyDraft(await parseImportTextOffMainThread("json", text, {
        sourceName: "Connected Splitwise account",
        sourceHash,
        maxBytes: IMPORT_TOTAL_BYTES_LIMIT,
        maxRows: deviceRowLimit,
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Splitwise could not be read");
    } finally {
      // The provider token is single-use and erased server-side even when
      // normalization fails. Clearing the callback session avoids offering a
      // retry that can never succeed; the user can reconnect explicitly.
      props.onSplitwiseSessionConsumed?.();
      setBusy(false);
    }
  }

  function applyDraft(value: NormalizedImportDraft, append = false): void {
    const previous = draft();
    const previousGroupIds = new Set(previous?.groups.map(({ externalId }) => externalId) ?? []);
    const previousSelections = new Set(selectedGroupIds());
    setDraft(value);
    const preferredGroups = value.groups.filter(({ status }) => status === "current");
    const defaults = (preferredGroups.length ? preferredGroups : value.groups).map(({ externalId }) => externalId);
    setSelectedGroupIds(append && previous
      ? value.groups.filter((group) => previousSelections.has(group.externalId) || (!previousGroupIds.has(group.externalId) && group.status === "current")).map(({ externalId }) => externalId)
      : defaults);
    if (!append || importerExternalIds().length === 0) setImporterExternalIds([value.sourceAccountId ?? value.people[0]?.externalId ?? ""].filter(Boolean));
    setCommit(undefined);
    setReviewed(false);
    setStep("select");
    void persistDraft(value);
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    setBusy(true);
    setMessage("");
    try {
      const chosen = [...files];
      if (chosen.length > IMPORT_FILE_LIMIT) throw new RangeError(`Choose at most ${IMPORT_FILE_LIMIT} files at once`);
      const total = chosen.reduce((sum, file) => sum + file.size, 0);
      if (total > IMPORT_TOTAL_BYTES_LIMIT) throw new RangeError("Choose files totalling less than 50 MiB");
      const drafts: NormalizedImportDraft[] = [];
      const skipped: string[] = [];
      for (const file of chosen) {
        try {
          const kind = supportedImportFileKind(file.name, file.type);
          if (!kind) throw new TypeError("not a supported Splitwise CSV or JSON export");
          if (file.size > IMPORT_FILE_BYTES_LIMIT) throw new RangeError("larger than 10 MiB");
          const text = await file.text();
          const sourceHash = await sha256ImportSource(text);
          const options = { sourceName: file.name, sourceHash, maxRows: deviceRowLimit };
          drafts.push(await parseImportTextOffMainThread(kind, text, options));
        } catch (error) {
          skipped.push(`${file.name}: ${error instanceof Error ? error.message : "could not be read"}`);
        }
      }
      if (drafts.length === 0) throw new Error(skipped[0] ?? "No supported exports were selected");
      const previous = draft();
      const combined = combineImportDrafts(previous ? [previous, ...drafts] : drafts);
      if (combined.sourceHashes.length > IMPORT_FILE_LIMIT) throw new RangeError(`A migration can contain at most ${IMPORT_FILE_LIMIT} unique exports`);
      if (combined.records.length > deviceRowLimit) throw new RangeError(rowLimitError());
      const combinedBytes = Object.values(combined.sourceByteSizes ?? {}).reduce((sum, bytes) => sum + bytes, 0);
      if (combinedBytes > IMPORT_TOTAL_BYTES_LIMIT) throw new RangeError("A migration can contain at most 50 MiB of exports in total");
      applyDraft(combined, Boolean(previous));
      if (skipped.length > 0) setMessage(`${drafts.length} file${drafts.length === 1 ? "" : "s"} read. Skipped ${skipped.join(" · ")}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "These files could not be read");
    } finally {
      setBusy(false);
      if (fileInputRef) fileInputRef.value = "";
    }
  }

  function updateOpeningRow(index: number, changes: Partial<OpeningRow>): void {
    setOpeningError(undefined);
    updateOpeningRows((rows) => {
      const personKey = rows[index]?.personKey;
      return rows.map((row, rowIndex) => {
        if (rowIndex === index) return { ...row, ...changes };
        if (changes.personName !== undefined && personKey && row.personKey === personKey) {
          return { ...row, personName: changes.personName };
        }
        return row;
      });
    });
  }

  async function editOpeningBalances(): Promise<void> {
    const stagedBatchId = commit()?.id;
    if (stagedBatchId) await cancelImportUpload(stagedBatchId).catch(() => undefined);
    setDraft(undefined);
    setCommit(undefined);
    setReviewed(false);
    void localDb.importDrafts.delete(migrationDraftId);
    setStep("balances");
  }

  function useOpeningBalances(): void {
    const value = createOpeningBalanceDraft({
      ownerExternalId: "opening:self",
      ownerName: props.displayName,
      rows: openingRows(),
    });
    const firstBlocking = value.warnings.find(({ blocking }) => blocking);
    if (firstBlocking) {
      setMessage(`Balance ${firstBlocking.row ?? 1}: ${firstBlocking.message}`);
      const row = firstBlocking.row ?? 1;
      const field = firstBlocking.field ?? "amount";
      setOpeningError({ row, field, message: firstBlocking.message });
      queueMicrotask(() => {
        const control = contentRef?.querySelector<HTMLElement>(`[data-opening-field="${row}:${field}"]`);
        control?.focus();
        control?.scrollIntoView({
          block: "center",
          behavior: typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      });
      return;
    }
    setOpeningError(undefined);
    applyDraft(value);
    setStep("balances");
    setImporterExternalIds(["opening:self"]);
    setSelectedGroupIds(value.groups.map(({ externalId }) => externalId));
    queueMicrotask(() => void prepareReview());
  }

  function updateGroupSelection(ids: string[]): void {
    setSelectedGroupIds([...new Set(ids)]);
    const value = draft();
    if (value) queueMicrotask(() => void persistDraft(value));
  }

  function toggleGroup(groupId: string): void {
    const ids = selectedGroupIds();
    updateGroupSelection(ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId]);
  }

  function removeSource(sourceHash: string): void {
    const value = draft();
    if (!value) return;
    const groups = value.groups.flatMap((group) => {
      const sourceHashes = (group.sourceHashes ?? []).filter((hash) => hash !== sourceHash);
      return sourceHashes.length > 0 ? [{ ...group, sourceHashes }] : [];
    });
    const records = value.records.filter((record) => record.source.fileHash !== sourceHash);
    const memberIds = new Set(groups.flatMap(({ memberExternalIds }) => memberExternalIds));
    const sourceByteSizes = { ...(value.sourceByteSizes ?? {}) };
    delete sourceByteSizes[sourceHash];
    const sourceNames = { ...(value.sourceNames ?? {}) };
    delete sourceNames[sourceHash];
    const cleaned: NormalizedImportDraft = {
      ...value,
      sourceHashes: value.sourceHashes.filter((hash) => hash !== sourceHash),
      sourceByteSizes,
      sourceNames,
      groups,
      records,
      people: value.people.filter(({ externalId }) => memberIds.has(externalId)),
      sourceBalances: value.sourceBalances.filter((balance) => balance.sourceHash !== sourceHash),
      warnings: value.warnings.filter((warning) => warning.sourceHash !== sourceHash),
    };
    if (cleaned.sourceHashes.length === 0) {
      void discardDraft();
      return;
    }
    applyDraft(cleaned);
    setMessage("That export was removed. The other files are unchanged.");
  }

  async function prepareReview(): Promise<void> {
    let value = draft();
    if (!value) return;
    const mode = value.mode;
    setBusy(true);
    setMessage("Preparing and signing this migration on your device…");
    try {
      const device = await ensureDevice(props.actorId);
      await persistDraft(value);
      const planning = planImportOffMainThread(value, {
        selectedGroupIds: selectedGroupIds(),
        importerExternalIds: importerExternalIds(),
        importedByDisplayName: props.displayName,
        actorId: device.actorId,
        deviceId: device.deviceId,
        importedAt: new Date().toISOString(),
        privateKey: device.privateKey,
        onProgress: (phase, completed, total) => {
          if (completed === total || completed % 1_000 === 0) {
            setMessage(`${phase === "planning" ? "Preparing" : "Securing"} migration… ${completed.toLocaleString()} of ${total.toLocaleString()} entries`);
          }
        },
      });
      if (mode !== "balances") {
        setDraft(undefined);
        value = undefined;
      }
      const planned = await planning;
      setCommit(planned);
      await localDb.importDrafts.update(migrationDraftId, {
        status: "ready",
        updatedAt: new Date().toISOString(),
        prepared: planned,
      });
      setMessage("Encrypted staging is ready. Nothing changes until you finish.");
      setReviewed(false);
      setStep("review");
    } catch (error) {
      const saved = value ?? (await localDb.importDrafts.get(migrationDraftId))?.draft;
      if (saved) setDraft(saved);
      setStep(mode === "balances" ? "balances" : "select");
      queueMicrotask(() => contentRef?.querySelector<HTMLElement>(`[data-migration-step="${mode === "balances" ? "balances" : "select"}"]`)?.focus());
      setMessage(error instanceof Error ? error.message : "This migration is not ready to review");
    } finally {
      setBusy(false);
    }
  }

  async function finishImport(): Promise<void> {
    const planned = commit();
    if (!planned || !reviewed()) return;
    setBusy(true);
    setMessage("");
    await localDb.importDrafts.update(migrationDraftId, { status: "submitting" }).catch(() => undefined);
    let result: Awaited<ReturnType<typeof activateStagedImport>>;
    try {
      result = await activateStagedImport(planned.id);
    } catch (error) {
      const recovered = await getImports()
        .then(({ imports }) => imports.find(({ id }) => id === planned.id))
        .catch(() => undefined);
      if (recovered) {
        result = { batch: recovered, duplicate: true, accepted: [] };
      } else {
        const cause = error instanceof Error ? error.message : "The connection ended before Tallied confirmed the migration";
        if (/upload is unavailable|expired|prepared migration details do not match/i.test(cause)) {
          await cancelImportUpload(planned.id).catch(() => undefined);
          const saved = await localDb.importDrafts.get(migrationDraftId);
          if (saved?.draft) {
            setDraft(saved.draft);
            setCommit(undefined);
            await persistDraft(saved.draft);
            setStep(saved.draft.mode === "balances" ? "balances" : "select");
            setMessage("Encrypted staging needs to be refreshed. Review the saved draft again to prepare a fresh retry-safe upload.");
            setBusy(false);
            return;
          }
        }
        const detail = `${cause}. Retry Finish migration: Tallied will resume the same batch and will not create duplicates.`;
        setMessage(detail);
        await localDb.importDrafts.update(migrationDraftId, { status: "failed", error: detail });
        setBusy(false);
        return;
      }
    }

    // The activation response is the commit point. Every refresh below is
    // recoverable and must never make a completed migration look failed.
    setCompletedBatch(result.batch);
    setStep("complete");
    props.onComplete?.(result.duplicate ? "This migration was already safely completed" : "Splitwise history moved to Tallied");
    try {
      await localDb.importDrafts.delete(migrationDraftId);
      await localDb.settings.delete(openingRowsStorageKey);
    } catch {
      setMessage("Migration completed safely. Its local draft will be cleared the next time this screen opens.");
    }
    const followUps = await Promise.allSettled([
      getImportIdentities(result.batch.id),
      appStore.sync(),
      refetchImports(),
    ]);
    const identityResult = followUps[0];
    if (identityResult?.status === "fulfilled") setIdentities(identityResult.value.identities);
    if (followUps.some(({ status }) => status === "rejected")) {
      setMessage("Migration completed safely. Reconnect or reopen this screen to refresh people and balances.");
    }
    setBusy(false);
  }

  async function connectSplitwise(): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const started = await startSplitwiseImport();
      window.location.assign(started.authorizationUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Direct connection is unavailable");
      setBusy(false);
    }
  }

  async function shareClaim(batchId: string, identityId: string): Promise<void> {
    setBusy(true);
    try {
      const link = await createImportClaimLink(batchId, identityId);
      const canShare = typeof navigator.share === "function";
      if (canShare) await navigator.share({ title: "Claim your Tallied history", text: "I moved our Splitwise history to Tallied. Claim your side here:", url: link.url });
      else await navigator.clipboard.writeText(link.url);
      setMessage(canShare ? "Claim link ready to share." : "Claim link copied.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Claim link could not be created");
    } finally {
      setBusy(false);
    }
  }

  async function showImportedPeople(batchId: string): Promise<void> {
    if (expandedPeopleBatch() === batchId) {
      setExpandedPeopleBatch(undefined);
      return;
    }
    setBusy(true);
    try {
      setManagedIdentities((await getImportIdentities(batchId)).identities);
      setExpandedPeopleBatch(batchId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Imported people could not be loaded");
    } finally {
      setBusy(false);
    }
  }

  async function approveClaim(identityId: string, batchId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await approveImportIdentityClaim(identityId);
      setMessage(`${result.displayName}'s account is now connected to the imported history.`);
      setManagedIdentities((await getImportIdentities(batchId)).identities);
      setClaimDecision(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The claim could not be approved");
    } finally {
      setBusy(false);
    }
  }

  async function rejectClaim(identityId: string, batchId: string): Promise<void> {
    setBusy(true);
    try {
      await rejectImportIdentityClaim(identityId);
      setMessage("Claim rejected. Share a new link only with the intended person.");
      setManagedIdentities((await getImportIdentities(batchId)).identities);
      setClaimDecision(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The claim could not be rejected");
    } finally {
      setBusy(false);
    }
  }

  async function performUndo(batch: ImportBatchSummary): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const device = await ensureDevice(props.actorId);
      setMessage("Preparing a signed, exact undo. This can take a moment for a large migration.");
      await undoImportOffMainThread(batch.id, appStore.operations(), {
        actorId: device.actorId,
        deviceId: device.deviceId,
        timestamp: new Date().toISOString(),
        privateKey: device.privateKey,
        onProgress: (phase, completed, total) => setMessage(
          `${phase === "planning" ? "Preparing" : "Safely undoing"} migration… ${completed.toLocaleString()} of ${total.toLocaleString()} entries`,
        ),
      });
      await appStore.sync();
      await refetchImports();
      setDestructiveAction(undefined);
      setMessage("Migration undone. Later Tallied entries were left intact.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The migration could not be undone");
    } finally {
      setBusy(false);
    }
  }

  async function performSourceDelete(batch: ImportBatchSummary): Promise<void> {
    setBusy(true);
    try {
      await deleteImportSourceData(batch.id);
      await refetchImports();
      setDestructiveAction(undefined);
      setMessage("Raw source identifiers, file fingerprints, and provider details deleted. A one-way duplicate marker and Tallied balances remain.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Source data could not be deleted");
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft(): Promise<void> {
    const stagedBatchId = commit()?.id;
    let remoteCleanupFailed = false;
    if (stagedBatchId) {
      try {
        await cancelImportUpload(stagedBatchId);
      } catch {
        remoteCleanupFailed = true;
      }
    }
    await localDb.importDrafts.delete(migrationDraftId);
    await localDb.settings.delete(openingRowsStorageKey);
    setDraft(undefined);
    setCommit(undefined);
    setMessage(remoteCleanupFailed
      ? "Draft removed from this device. An interrupted server upload could not be cleared now and will expire automatically within 24 hours."
      : "");
    setStep("choose");
  }

  async function startFresh(): Promise<void> {
    await discardDraft();
    props.onComplete?.("Starting fresh—nothing was imported");
  }

  async function back(): Promise<void> {
    setDestructiveAction(undefined);
    if (step() === "review") {
      const stagedBatchId = commit()?.id;
      const saved = draft() ?? (await localDb.importDrafts.get(migrationDraftId))?.draft;
      let cleanupFailed = false;
      if (stagedBatchId) await cancelImportUpload(stagedBatchId).catch(() => {
        cleanupFailed = true;
      });
      setMessage(cleanupFailed
        ? "Changes are available, but the previous encrypted upload could not be cleared and will expire automatically."
        : "");
      setCommit(undefined);
      setReviewed(false);
      if (saved) {
        setDraft(saved);
        await persistDraft(saved);
        setStep(saved.mode === "balances" ? "balances" : "select");
      } else {
        setStep("choose");
      }
    }
    else if (step() === "select" || step() === "balances" || step() === "manage") setStep("choose");
    else if (step() === "complete") setStep("manage");
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content
            ref={contentRef}
            role="dialog"
            class="composer-dialog migration-dialog flex max-h-[96dvh] w-full flex-col overflow-hidden border border-border bg-card shadow-2xl outline-none sm:max-w-2xl sm:rounded-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => contentRef?.focus());
            }}
          >
            <header class="grid min-h-16 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border px-3 sm:px-5">
              <Show when={step() !== "choose"} fallback={<span />}>
                <button class="icon-button" type="button" aria-label="Go back" disabled={busy()} onClick={() => void back()}><ArrowLeft size={18} /></button>
              </Show>
              <div class="min-w-0 text-center">
                <Dialog.Title class="truncate text-base font-semibold">Move from Splitwise</Dialog.Title>
                <Dialog.Description class="truncate text-xs text-muted-foreground">
                  {step() === "review" ? "Check the numbers before anything changes" : "Private, reversible, and currency-safe"}
                </Dialog.Description>
              </div>
              <Dialog.CloseButton class="icon-button" aria-label="Close migration"><X size={18} /></Dialog.CloseButton>
            </header>

            <div class="migration-scroll min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6">
              <span class="sr-only" role="status" aria-live="polite">Migration step: {step()}</span>
              <Show when={message()}>
                <p class="mb-4 rounded-lg border border-border bg-muted/45 px-3 py-2.5 text-sm leading-5" role={messageIsError() ? "alert" : "status"} aria-live={messageIsError() ? "assertive" : "polite"}>{message()}</p>
              </Show>

              <Show when={busy() && step() !== "review"}>
                <div class="grid min-h-56 place-items-center text-center" role="status" aria-live="polite">
                  <div><LoaderCircle class="mx-auto mb-3 animate-spin" size={24} /><strong class="text-sm">Preparing your migration…</strong><p class="mt-1 text-xs text-muted-foreground">Keep this window open.</p></div>
                </div>
              </Show>

              <Show when={!busy() || step() === "review"}>
                <Show when={step() === "choose"}>
                  <div class="space-y-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="choose" tabindex="-1">
                    <div>
                      <p class="eyebrow">Choose a route</p>
                      <h2 class="mt-1 text-xl font-semibold tracking-tight">Bring over what matters.</h2>
                      <p class="mt-1.5 max-w-lg text-sm leading-6 text-muted-foreground">Tallied checks every balance before it writes to your shared ledger. Nothing is converted between currencies.</p>
                    </div>
                    <div class="grid gap-2">
                      <button class="migration-route" type="button" disabled={!capabilities()?.splitwiseOAuth.available} onClick={() => void connectSplitwise()}>
                        <span class="migration-route-icon"><Link size={19} /></span><span><strong>Connect Splitwise</strong><small>{capabilities()?.splitwiseOAuth.available ? "Read once, then disconnect automatically" : "Requires written Splitwise API approval"}</small></span><ExternalLink size={16} />
                      </button>
                      <button class="migration-route" type="button" onClick={() => fileInputRef?.click()}>
                        <span class="migration-route-icon"><Upload size={19} /></span><span><strong>Choose CSV or JSON files</strong><small>Best for complete, self-service migration</small></span><ChevronRight size={16} />
                      </button>
                      <input ref={fileInputRef} class="sr-only" type="file" name="splitwise-import-files" aria-label="Choose Splitwise CSV or JSON files" accept=".csv,.json,text/csv,application/json" multiple onChange={(event) => void handleFiles(event.currentTarget.files)} />
                      <button class="migration-route" type="button" onClick={() => setStep("balances")}>
                        <span class="migration-route-icon"><CircleDollarSign size={19} /></span><span><strong>Enter balances only</strong><small>Start now; keep old transactions in Splitwise</small></span><ChevronRight size={16} />
                      </button>
                      <Dialog.CloseButton class="migration-route" onClick={() => void startFresh()}>
                        <span class="migration-route-icon"><WalletCards size={19} /></span><span><strong>Start fresh</strong><small>Use Tallied without bringing anything over</small></span><ChevronRight size={16} />
                      </Dialog.CloseButton>
                    </div>
                    <div class="migration-privacy-note"><ShieldCheck size={17} /><p><strong>Your files stay on this device while they’re read.</strong><br />Only the signed ledger prepared for your final review and owner-only identifiers needed for undo and duplicate protection are sent. Temporary staging is encrypted, changes no balances, and expires within 24 hours.</p></div>
                    <Show when={(imports()?.imports.length ?? 0) > 0}>
                      <Button variant="secondary" class="w-full" onClick={() => setStep("manage")}><Database size={16} /> Manage previous migrations</Button>
                    </Show>
                  </div>
                </Show>

                <Show when={step() === "balances"}>
                  <div class="space-y-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="balances" tabindex="-1">
                    <div><p class="eyebrow">Balances only</p><h2 class="mt-1 text-xl font-semibold tracking-tight">Who owes whom today?</h2><p class="mt-1 text-sm text-muted-foreground">These entries affect balances, never spending charts.</p></div>
                    <For each={openingRows()}>{(row, index) => {
                      const rowError = () => openingError()?.row === index() + 1 ? openingError() : undefined;
                      const invalid = (field: OpeningField) => rowError()?.field === field;
                      const errorId = () => `opening-balance-error-${index() + 1}`;
                      const previousPeople = () => openingRows()
                        .slice(0, index())
                        .filter((candidate, candidateIndex, candidates) =>
                          candidate.personName.trim() && candidates.findIndex(({ personKey }) => personKey === candidate.personKey) === candidateIndex,
                        );
                      const reusesPreviousPerson = () => previousPeople().some(({ personKey }) => personKey === row.personKey);
                      return <Card class="grid gap-3 p-4">
                        <Show when={previousPeople().length > 0}>
                          <label class="grid gap-1 text-xs font-medium">Person identity<select class="field-input min-h-11 text-base" value={reusesPreviousPerson() ? row.personKey : "new"} onChange={(event) => {
                            const selected = previousPeople().find(({ personKey }) => personKey === event.currentTarget.value);
                            updateOpeningRow(index(), selected
                              ? { personKey: selected.personKey, personName: selected.personName }
                              : { personKey: row.rowId });
                          }}><option value="new">Different person</option><For each={previousPeople()}>{(person) => <option value={person.personKey}>Same person as {person.personName}</option>}</For></select></label>
                        </Show>
                        <div class="grid grid-cols-[1fr_auto] gap-2">
                          <label class="grid gap-1 text-xs font-medium">Person<input data-opening-field={`${index() + 1}:personName`} class="field-input min-h-11 text-base" name={`opening-balance-${row.rowId}-person`} autocomplete="off" aria-invalid={invalid("personName")} aria-describedby={invalid("personName") ? errorId() : undefined} value={row.personName} placeholder="Mira" readOnly={reusesPreviousPerson()} onInput={(event) => updateOpeningRow(index(), { personName: event.currentTarget.value })} /></label>
                          <Show when={openingRows().length > 1}><button class="icon-button self-end" aria-label={`Remove ${row.personName || "balance"}`} onClick={() => updateOpeningRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index()))}><Trash2 size={16} /></button></Show>
                        </div>
                        <div class="migration-balance-grid">
                          <label class="grid gap-1 text-xs font-medium">Direction<select data-opening-field={`${index() + 1}:direction`} class="field-input min-h-11 text-base" name={`opening-balance-${row.rowId}-direction`} autocomplete="off" aria-invalid={invalid("direction")} aria-describedby={invalid("direction") ? errorId() : undefined} value={row.direction} onChange={(event) => updateOpeningRow(index(), { direction: event.currentTarget.value as OpeningRow["direction"] })}><option value="owes_me">They owe me</option><option value="i_owe">I owe them</option></select></label>
                          <label class="grid gap-1 text-xs font-medium">Amount<input data-opening-field={`${index() + 1}:amount`} class="field-input min-h-11 text-base" name={`opening-balance-${row.rowId}-amount`} autocomplete="off" aria-invalid={invalid("amount")} aria-describedby={invalid("amount") ? errorId() : undefined} inputmode="decimal" value={row.amount} placeholder="0.00" onInput={(event) => updateOpeningRow(index(), { amount: event.currentTarget.value })} /></label>
                        </div>
                        <div class="migration-balance-grid">
                          <label class="grid gap-1 text-xs font-medium">Currency (2-decimal)<input data-opening-field={`${index() + 1}:currency`} class="field-input min-h-11 text-base uppercase" name={`opening-balance-${row.rowId}-currency`} autocomplete="off" aria-invalid={invalid("currency")} aria-describedby={invalid("currency") ? errorId() : undefined} maxlength={3} value={row.currency} onInput={(event) => updateOpeningRow(index(), { currency: event.currentTarget.value.toUpperCase() })} /></label>
                          <label class="grid gap-1 text-xs font-medium">As of<input data-opening-field={`${index() + 1}:effectiveDate`} class="field-input min-h-11 text-base" name={`opening-balance-${row.rowId}-effective-date`} autocomplete="off" aria-invalid={invalid("effectiveDate")} aria-describedby={invalid("effectiveDate") ? errorId() : undefined} type="date" value={row.effectiveDate} onInput={(event) => updateOpeningRow(index(), { effectiveDate: event.currentTarget.value })} /></label>
                        </div>
                        <label class="grid gap-1 text-xs font-medium">Group name (optional)<input data-opening-field={`${index() + 1}:groupName`} class="field-input min-h-11 text-base" name={`opening-balance-${row.rowId}-group`} autocomplete="off" aria-invalid={invalid("groupName")} aria-describedby={invalid("groupName") ? errorId() : undefined} value={row.groupName} placeholder="Opening balances" onInput={(event) => updateOpeningRow(index(), { groupName: event.currentTarget.value })} /></label>
                        <Show when={rowError()}>{(error) => <p id={errorId()} role="alert" class="text-xs leading-5 text-destructive">{error().message}</p>}</Show>
                      </Card>
                    }}</For>
                    <p class="text-xs leading-5 text-muted-foreground">Tallied currently imports currencies that use two decimal places. Other currencies are blocked instead of rounded.</p>
                    <button class="migration-text-action min-h-11 text-sm font-medium text-primary" onClick={() => updateOpeningRows((rows) => [...rows, newOpeningRow({ currency: rows[0]?.currency ?? "USD", groupName: rows[0]?.groupName ?? "Opening balances", effectiveDate: rows[0]?.effectiveDate ?? today() })])}>+ Add another balance</button>
                    <Button class="w-full" onClick={useOpeningBalances}>Review these balances</Button>
                  </div>
                </Show>

                <Show when={step() === "select" && draft()}>
                  <div class="space-y-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="select" tabindex="-1">
                    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div class="migration-stat"><strong>{currentGroups().length}</strong><span>current groups</span></div>
                      <div class="migration-stat"><strong>{olderGroups().length}</strong><span>older or settled</span></div>
                      <div class="migration-stat"><strong>{draft()!.people.length}</strong><span>people</span></div>
                      <div class="migration-stat"><strong>{draft()!.records.length}</strong><span>entries</span></div>
                    </div>
                    <div class="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/35 px-3 py-2.5"><p class="text-xs leading-5 text-muted-foreground"><strong class="text-foreground">{selectedGroupIds().length}</strong> groups · <strong class="text-foreground">{selectedEntryCount()}</strong> entries selected<br />{currencyCount()} {currencyCount() === 1 ? "currency" : "currencies"} · {sourceBytes() < 1024 * 1024 ? `${Math.max(1, Math.ceil(sourceBytes() / 1024))} KiB` : `${(sourceBytes() / (1024 * 1024)).toFixed(1)} MiB`} source</p><Button size="sm" variant="secondary" onClick={() => fileInputRef?.click()}><Upload size={15} /> Add files</Button></div>
                    <section>
                      <div class="mb-2"><p class="eyebrow">Identity check</p><h2 class="mt-1 font-semibold">Which names are you?</h2><p class="mt-1 text-xs leading-5 text-muted-foreground">Select every version of your name across exports. Everyone else remains an unclaimed placeholder until they verify a claim link.</p></div>
                      <div class="divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
                        <For each={draft()!.people}>{(person) => {
                          const occurrences = () => draft()!.groups.filter(({ memberExternalIds }) => memberExternalIds.includes(person.externalId)).length;
                          return <label class="migration-check-row"><input type="checkbox" checked={importerExternalIds().includes(person.externalId)} onChange={() => {
                            const current = importerExternalIds();
                            setImporterExternalIds(current.includes(person.externalId) ? current.filter((id) => id !== person.externalId) : [...current, person.externalId]);
                            queueMicrotask(() => void persistDraft(draft()!));
                          }} /><span><strong>{person.displayName}</strong><small>{occurrences()} group{occurrences() === 1 ? "" : "s"}{person.email ? ` · ${person.email}` : ""}</small></span><Show when={importerExternalIds().includes(person.externalId)}><Badge>You</Badge></Show></label>;
                        }}</For>
                      </div>
                    </section>
                    <section>
                      <div class="mb-2 flex items-end justify-between gap-3"><div><p class="eyebrow">Current groups</p><h2 class="mt-1 font-semibold">Choose what to bring</h2></div><div class="flex flex-wrap justify-end"><button class="migration-text-action min-h-11 px-2 text-xs font-medium text-primary" onClick={() => updateGroupSelection(currentGroups().map(({ externalId }) => externalId))}>Current</button><button class="migration-text-action min-h-11 px-2 text-xs font-medium text-primary" onClick={() => updateGroupSelection(draft()!.groups.map(({ externalId }) => externalId))}>All history</button><button class="migration-text-action min-h-11 px-2 text-xs font-medium text-muted-foreground" onClick={() => updateGroupSelection([])}>Clear</button></div></div>
                      <div class="divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
                        <For each={currentGroups()}>{(group) => <label class="migration-check-row"><input type="checkbox" checked={selectedGroupIds().includes(group.externalId)} onChange={() => toggleGroup(group.externalId)} /><span><strong>{group.name}</strong><small>{group.currency} · {group.memberExternalIds.length} people</small></span></label>}</For>
                        <Show when={currentGroups().length === 0}><p class="p-4 text-sm text-muted-foreground">No active groups were identified. Older groups are below.</p></Show>
                      </div>
                    </section>
                    <Show when={olderGroups().length}>
                      <details class="rounded-xl border border-border"><summary class="min-h-12 cursor-pointer px-4 py-3 text-sm font-medium">Older or settled groups <span class="text-muted-foreground">({olderGroups().length})</span></summary><div class="divide-y divide-border/60 border-t border-border"><For each={olderGroups()}>{(group) => <label class="migration-check-row"><input type="checkbox" checked={selectedGroupIds().includes(group.externalId)} onChange={() => toggleGroup(group.externalId)} /><span><strong>{group.name}</strong><small>{group.currency}</small></span></label>}</For></div></details>
                    </Show>
                    <Show when={draft()!.warnings.length}><section><p class="eyebrow mb-2">Needs attention</p><div class="space-y-2"><For each={draft()!.warnings}>{(warning) => <div class={`rounded-lg border px-3 py-2 text-xs leading-5 ${warning.blocking ? "border-destructive/35 text-destructive" : "border-border text-muted-foreground"}`}><p>{warning.sourceName ? `${warning.sourceName}${warning.row ? ` · row ${warning.row}` : ""}: ` : ""}{warning.message}</p><Show when={warning.blocking && warning.sourceHash}><button type="button" class="migration-text-action mt-1 min-h-11 font-semibold underline underline-offset-4" onClick={() => removeSource(warning.sourceHash!)}>Remove this file</button></Show></div>}</For></div></section></Show>
                    <div class="grid grid-cols-[1fr_auto] gap-2"><Button disabled={selectedGroupIds().length === 0 || importerExternalIds().length === 0 || busy()} onClick={() => void prepareReview()}>Review migration <ChevronRight size={16} /></Button><Button variant="ghost" onClick={() => setDestructiveAction({ kind: "discard" })}>Discard</Button></div>
                  </div>
                </Show>

                <Show when={step() === "review" && commit()}>
                  <div class="space-y-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="review" tabindex="-1">
                    <div><p class="eyebrow">Final check</p><h2 class="mt-1 text-xl font-semibold tracking-tight">Do these balances look right?</h2><p class="mt-1 text-sm leading-6 text-muted-foreground">Tallied will create {commit()!.reconciliation.groupCount} groups and {commit()!.reconciliation.recordCount} ledger entries. Nothing changes until you finish; imported records stay read-only.</p></div>
                    <Card class="overflow-hidden">
                      <Show when={commit()!.mode === "balances"} fallback={
                        <>
                          <For each={commit()!.reconciliation.lines}>{(line) => {
                            const person = () => commit()!.people.find(({ externalId }) => externalId === line.externalPersonId)?.displayName ?? "Unknown person";
                            const group = () => commit()!.groups.find(({ externalId }) => externalId === line.externalGroupId)?.name;
                            return <div class="grid min-h-16 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0"><Avatar name={person()} /><div class="min-w-0"><strong class="block truncate text-sm">{person()}</strong><span class="block truncate text-xs text-muted-foreground">{group() ?? "Across selected groups"}</span></div><div class="text-right text-xs"><span class="block text-muted-foreground">Splitwise {line.sourceMinor === undefined ? "not provided" : formatSignedMinor(line.sourceMinor, line.currency)}</span><strong class="mt-0.5 block">Tallied {formatSignedMinor(line.computedMinor, line.currency)}</strong><span class="sr-only">{line.differenceMinor === undefined ? "Not independently compared." : `Difference ${formatSignedMinor(line.differenceMinor, line.currency)}. Matches.`}</span></div></div>;
                          }}</For>
                          <Show when={commit()!.reconciliation.lines.length === 0}><p class="p-4 text-sm leading-6 text-muted-foreground"><strong class="text-foreground">Closing-balance comparison unavailable.</strong><br />Splitwise CSV exports do not include an independent balance summary. Tallied verified every included row, but you should compare the final balances with Splitwise before finishing.</p></Show>
                        </>
                      }>
                        <For each={balanceReviewRows()}>{(row) => <div class="grid min-h-16 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0"><Avatar name={row.personName} /><div class="min-w-0"><strong class="block truncate text-sm">{row.personName}</strong><span class="block truncate text-xs text-muted-foreground">{row.groupName} · as of {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${row.effectiveDate}T12:00:00`))}</span></div><div class="text-right"><span class="block text-xs text-muted-foreground">{row.direction === "owes_me" ? "owes you" : "you owe"}</span><strong class={`mt-0.5 block text-sm ${row.direction === "owes_me" ? "text-positive" : "text-negative"}`}>{formatMinor(row.amountMinor, row.currency)}</strong></div></div>}</For>
                      </Show>
                    </Card>
                    <Show when={commit()!.mode !== "balances"}><details class="rounded-xl border border-border">
                      <summary class="min-h-12 cursor-pointer px-4 py-3 text-sm font-medium">Paid, owed, and payment totals <span class="text-muted-foreground">({commit()!.reconciliation.participantTotals.length})</span></summary>
                      <div class="divide-y divide-border/60 border-t border-border">
                        <For each={commit()!.reconciliation.participantTotals}>{(total) => {
                          const person = () => commit()!.people.find(({ externalId }) => externalId === total.externalPersonId)?.displayName ?? "Unknown person";
                          return <div class="grid gap-1 px-4 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><strong class="text-sm">{person()} · {total.currency}</strong><span class="tabular-nums text-muted-foreground">Paid {formatMinor(total.paidMinor, total.currency)} · owed {formatMinor(total.owedMinor, total.currency)} · sent {formatMinor(total.paymentsSentMinor, total.currency)} · received {formatMinor(total.paymentsReceivedMinor, total.currency)}</span></div>;
                        }}</For>
                      </div>
                    </details></Show>
                    <div class="migration-reconcile"><span><Check size={16} /></span><div><strong>{commit()!.mode === "balances" ? "Balance entries validated" : commit()!.reconciliation.lines.length > 0 ? "Reconciliation passed" : "Integrity checks passed"}</strong><p>{commit()!.mode === "balances" ? "Every balance above is zero-sum and will stay outside spending charts." : commit()!.reconciliation.lines.length > 0 ? "Every currency adds to zero and every available Splitwise balance matches Tallied exactly." : "Every included financial row is valid and zero-sum. An independent closing-balance comparison was not available."}</p></div></div>
                    <Show when={commit()!.mode === "balances"}><Button variant="secondary" class="w-full" onClick={() => void editOpeningBalances()}>Edit balances</Button></Show>
                    <label class="flex min-h-12 items-start gap-3 rounded-lg border border-border p-3 text-sm"><input class="mt-1 size-4" type="checkbox" checked={reviewed()} onChange={(event) => setReviewed(event.currentTarget.checked)} /><span>I reviewed the people, groups, currencies, and totals above.</span></label>
                    <Button class="w-full" disabled={!reviewed() || busy()} onClick={() => void finishImport()}>{busy() ? <><LoaderCircle class="animate-spin" size={16} /> Finishing safely…</> : <>Finish migration</>}</Button>
                    <p class="text-center text-xs leading-5 text-muted-foreground">If the connection drops, reopen this screen. The same signed batch will resume without duplicates.</p>
                  </div>
                </Show>

                <Show when={step() === "complete" && completedBatch()}>
                  <div class="space-y-5 text-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="complete" tabindex="-1">
                    <div class="mx-auto grid size-14 place-items-center rounded-full bg-positive/10 text-positive"><Check size={26} stroke-width={2.5} /></div>
                    <div><p class="eyebrow">Migration complete</p><h2 class="mt-1 text-2xl font-semibold tracking-tight">Your balances are tallied.</h2><p class="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{completedBatch()!.recordCount} entries across {completedBatch()!.groupCount} groups are ready. Your original Splitwise data was not changed.</p></div>
                    <Show when={identities().length}>
                      <Card class="overflow-hidden text-left">
                        <div class="border-b border-border px-4 py-3">
                          <strong class="text-sm">Let people claim their history</strong>
                          <p class="mt-0.5 text-xs text-muted-foreground">Each single-use link reveals no identity or balance before sign-in.</p>
                        </div>
                        <For each={identities()}>{(identity) => (
                          <div class="flex min-h-14 items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0">
                            <Avatar name={identity.displayName} />
                            <div class="min-w-0 flex-1"><strong class="block truncate text-sm">{identity.displayName}</strong><span class="text-xs text-muted-foreground">{identity.status === "claimed" ? "Claimed" : identity.status === "awaiting_owner" ? "Waiting for your approval" : "Not claimed"}</span></div>
                            <Show when={identity.status === "unclaimed" || identity.status === "reserved"}><Button size="sm" variant="secondary" onClick={() => void shareClaim(completedBatch()!.id, identity.id)}>Share</Button></Show>
                          </div>
                        )}</For>
                      </Card>
                    </Show>
                    <div class="grid grid-cols-2 gap-2"><Dialog.CloseButton class="ui-button min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Done</Dialog.CloseButton><Button variant="secondary" onClick={() => setStep("manage")}>Manage</Button></div>
                  </div>
                </Show>

                <Show when={step() === "manage"}>
                  <div class="space-y-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-migration-step="manage" tabindex="-1">
                    <div><p class="eyebrow">Migration history</p><h2 class="mt-1 text-xl font-semibold tracking-tight">Imported into Tallied</h2><p class="mt-1 text-sm text-muted-foreground">Undo affects only records created by that migration.</p></div>
                    <Show when={imports.error}><div role="alert" class="rounded-xl border border-destructive/35 p-4 text-sm leading-6 text-destructive"><p>Migration history could not be loaded. Your imported ledger is unchanged.</p><Button class="mt-3" size="sm" variant="secondary" onClick={() => void refetchImports()}>Try again</Button></div></Show>
                    <Show when={!imports.error}>
                      <Show when={!imports.loading} fallback={<p class="text-sm text-muted-foreground" role="status" aria-live="polite">Loading migrations…</p>}>
                        <Show when={imports()?.imports.length} fallback={<p class="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No completed migrations yet.</p>}>
                        <div class="space-y-3">
                          <For each={imports()?.imports}>{(batch) => (
                            <Card class="p-4">
                              <div class="flex items-start justify-between gap-3"><div><div class="flex items-center gap-2"><strong class="text-sm">Splitwise migration</strong><Badge>{batch.status}</Badge></div><p class="mt-1 text-xs text-muted-foreground">{batch.groupCount} groups · {batch.recordCount} entries · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(batch.completedAt ?? batch.startedAt))}</p></div><Database size={18} class="text-muted-foreground" /></div>
                              <div class="mt-3 flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={busy()} onClick={() => void showImportedPeople(batch.id)}>People</Button><Show when={batch.status === "completed" && batch.rollbackStatus === "available"}><Button variant="destructive" size="sm" disabled={busy()} onClick={() => setDestructiveAction({ kind: "undo", batch })}><RotateCcw size={15} /> Undo migration</Button></Show><Show when={!batch.sourceDataDeletedAt}><Button variant="secondary" size="sm" disabled={busy()} onClick={() => setDestructiveAction({ kind: "delete", batch })}><Trash2 size={15} /> Delete source data</Button></Show></div>
                              <Show when={expandedPeopleBatch() === batch.id}>
                                <div class="mt-3 divide-y divide-border/60 rounded-lg border border-border">
                                  <For each={managedIdentities()} fallback={<p class="p-3 text-xs text-muted-foreground">No unclaimed people in this migration.</p>}>{(identity) => (
                                    <div class="flex min-h-14 items-center gap-3 px-3 py-2">
                                      <Avatar name={identity.displayName} />
                                      <div class="min-w-0 flex-1"><strong class="block truncate text-sm">{identity.displayName}</strong><span class="block truncate text-xs text-muted-foreground">{identity.status === "awaiting_owner" ? identity.claimant ? `${identity.claimant.displayName} · ${identity.claimant.email}` : "Waiting for your approval" : identity.status}</span></div>
                                      <Show when={identity.status === "awaiting_owner"} fallback={<Show when={identity.status === "unclaimed" || identity.status === "reserved"}><Button size="sm" variant="secondary" onClick={() => void shareClaim(batch.id, identity.id)}>Share</Button></Show>}>
                                        <Button size="sm" onClick={() => setClaimDecision({ identity, batchId: batch.id })}>Review claim</Button>
                                      </Show>
                                    </div>
                                  )}</For>
                                </div>
                              </Show>
                            </Card>
                          )}</For>
                        </div>
                        </Show>
                      </Show>
                    </Show>
                    <Button variant="secondary" class="w-full" onClick={() => setStep("choose")}>Start another migration</Button>
                  </div>
                </Show>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
      <AlertDialog open={Boolean(claimDecision())} onOpenChange={(open) => { if (!open) setClaimDecision(undefined); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="confirm-overlay fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]" />
          <div class="fixed inset-0 z-[70] grid place-items-center p-5">
            <AlertDialog.Content class="confirm-dialog w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl outline-none">
              <div class="mx-auto grid size-11 place-items-center rounded-full bg-primary/10 text-primary"><ShieldCheck size={19} /></div>
              <AlertDialog.Title class="mt-4 text-center text-lg font-semibold tracking-tight">Confirm who is claiming this history</AlertDialog.Title>
              <AlertDialog.Description class="mt-2 text-center text-sm leading-6 text-muted-foreground">
                <Show when={claimDecision()?.identity.claimant} fallback={<>Claimant details are unavailable. Reject this request and share a new link.</>}>
                  {(claimant) => <><strong class="text-foreground">{claimant().displayName}</strong> verified <strong class="break-all text-foreground">{claimant().email}</strong>. Approving connects that account as imported <strong class="text-foreground">{claimDecision()!.identity.displayName}</strong> and gives it access to the shared imported groups.</>}
                </Show>
              </AlertDialog.Description>
              <Show when={claimDecision()?.identity.claimant}>{(claimant) => <p class="mt-3 text-center text-xs text-muted-foreground">Requested {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(claimant().requestedAt))} · expires {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(claimant().expiresAt))}</p>}</Show>
              <div class="mt-5 grid grid-cols-2 gap-2">
                <Button variant="destructive" disabled={busy()} onClick={() => void rejectClaim(claimDecision()!.identity.id, claimDecision()!.batchId)}>Reject</Button>
                <Button disabled={busy() || !claimDecision()?.identity.claimant} onClick={() => void approveClaim(claimDecision()!.identity.id, claimDecision()!.batchId)}>Approve claim</Button>
              </div>
              <Button class="mt-2 w-full" variant="ghost" disabled={busy()} onClick={() => setClaimDecision(undefined)}>Cancel</Button>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      </AlertDialog>
      <AlertDialog open={Boolean(destructiveAction())} onOpenChange={(open) => { if (!open && !busy()) setDestructiveAction(undefined); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="confirm-overlay fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]" />
          <div class="fixed inset-0 z-[70] grid place-items-center p-5">
            <AlertDialog.Content class="confirm-dialog w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl outline-none">
              <div class="mx-auto grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive"><Trash2 size={19} /></div>
              <AlertDialog.Title class="mt-4 text-center text-lg font-semibold tracking-tight">
                {destructiveAction()?.kind === "discard" ? "Discard this migration draft?" : destructiveAction()?.kind === "undo" ? "Undo this migration?" : "Delete source data?"}
              </AlertDialog.Title>
              <AlertDialog.Description class="mt-2 text-center text-sm leading-6 text-muted-foreground">
                {destructiveAction()?.kind === "discard"
                  ? "The files you selected and your review progress will be removed from this device. Nothing has been added to Tallied yet."
                  : destructiveAction()?.kind === "undo"
                    ? "Only entries created by this migration will be reversed. Tallied entries added later will stay."
                    : "Raw provider IDs, file fingerprints, and retained source details will be erased. A one-way duplicate marker, migrated balances, and descriptions will stay."}
              </AlertDialog.Description>
              <div class="mt-5 grid grid-cols-2 gap-2">
                <Button variant="secondary" disabled={busy()} onClick={() => setDestructiveAction(undefined)}>Cancel</Button>
                <Button variant="destructive" disabled={busy()} onClick={() => {
                  const action = destructiveAction();
                  if (!action) return;
                  if (action.kind === "discard") void discardDraft().then(() => setDestructiveAction(undefined));
                  else if (action.kind === "undo" && action.batch) void performUndo(action.batch);
                  else if (action.kind === "delete" && action.batch) void performSourceDelete(action.batch);
                }}>{busy() ? "Working…" : destructiveAction()?.kind === "discard" ? "Discard draft" : destructiveAction()?.kind === "undo" ? "Undo migration" : "Delete source data"}</Button>
              </div>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      </AlertDialog>
    </Dialog>
  );
}
