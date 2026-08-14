import Activity from "lucide-solid/icons/activity";
import ArrowRightLeft from "lucide-solid/icons/arrow-right-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import DatabaseBackup from "lucide-solid/icons/database-backup";
import MessageCircle from "lucide-solid/icons/message-circle";
import PencilLine from "lucide-solid/icons/pencil-line";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import Trash2 from "lucide-solid/icons/trash-2";
import UserMinus from "lucide-solid/icons/user-minus";
import UserPlus from "lucide-solid/icons/user-plus";
import UsersRound from "lucide-solid/icons/users-round";
import { For, Show, createMemo, createSignal } from "solid-js";
import { paymentActivityDetails, restoreExpenseFailureMessage } from "../lib/activity-view";
import { accountSyncCopy } from "../lib/connection-status";
import type { LocalExpense, LocalOperation } from "../lib/db";
import { money } from "../lib/format-money";
import { memberName } from "../lib/member-label";
import { appStore, restoreExpense } from "../lib/store";
import { CategoryMark } from "./CategoryMark";
import { Card } from "./ui";

const activityCopy: Partial<Record<LocalOperation["type"], string>> = {
  ExpenseCreated: "added an expense",
  ExpenseAmended: "updated an expense",
  ExpenseVoided: "deleted an expense",
  ExpenseRestored: "restored an expense",
  CommentAdded: "commented",
  PaymentRecorded: "recorded a payment",
  PaymentReversed: "reversed a payment",
  ImportedTransactionRecorded: "imported a balance adjustment",
  ImportedTransactionVoided: "removed an imported adjustment",
  OpeningBalanceCreated: "added an opening balance",
  OpeningBalanceVoided: "removed an opening balance",
  GroupCreated: "created a group",
  GroupCurrencyChanged: "changed the group currency",
  GroupMemberAdded: "added a member",
  GroupMemberRemoved: "removed a member",
};

function ActivityMark(props: { operation: LocalOperation; expense: LocalExpense | undefined }) {
  if (props.operation.type === "ExpenseCreated" && props.expense) {
    return <CategoryMark category={props.expense.category} />;
  }
  const visual = () => {
    switch (props.operation.type) {
      case "ExpenseAmended": return { Icon: PencilLine, tone: "change" };
      case "ExpenseVoided": return { Icon: Trash2, tone: "danger" };
      case "ExpenseRestored": return { Icon: RotateCcw, tone: "change" };
      case "CommentAdded": return { Icon: MessageCircle, tone: "change" };
      case "PaymentRecorded":
      case "PaymentReversed": return { Icon: ArrowRightLeft, tone: "payment" };
      case "ImportedTransactionRecorded":
      case "ImportedTransactionVoided":
      case "OpeningBalanceCreated":
      case "OpeningBalanceVoided": return { Icon: DatabaseBackup, tone: "import" };
      case "GroupCreated": return { Icon: UsersRound, tone: "group" };
      case "GroupCurrencyChanged": return { Icon: RefreshCw, tone: "change" };
      case "GroupMemberAdded": return { Icon: UserPlus, tone: "group" };
      case "GroupMemberRemoved": return { Icon: UserMinus, tone: "danger" };
      default: return { Icon: Activity, tone: "general" };
    }
  };
  const { Icon, tone } = visual();
  return <span class={`category-icon activity-mark category-tone-${tone}`} aria-hidden="true"><Icon size={17} stroke-width={2} /></span>;
}
export function ActivityView(props: {
  actorId: string;
  onOpenExpense(expense: LocalExpense): void;
  onToast(message: string): void;
}) {
  const [restoringExpenseId, setRestoringExpenseId] = createSignal<string>();
  const syncCopy = createMemo(() => accountSyncCopy({
    connection: appStore.connection(),
    pendingCount: appStore.operations().filter(({ syncStatus }) => syncStatus === "pending").length,
    groupCount: appStore.groups().length,
  }));
  const activityDays = createMemo(() => {
    const groups = new Map<string, { label: string; operations: LocalOperation[] }>();
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
    for (const operation of [...appStore.operations()].sort((left, right) => right.clientTimestamp.localeCompare(left.clientTimestamp))) {
      const date = new Date(operation.clientTimestamp);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const label = key === todayKey
        ? "Today"
        : key === yesterdayKey
          ? "Yesterday"
          : new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(date);
      const existing = groups.get(key);
      if (existing) existing.operations.push(operation);
      else groups.set(key, { label, operations: [operation] });
    }
    return [...groups.values()];
  });
  async function restore(expense: LocalExpense) {
    if (restoringExpenseId() === expense.id) return;
    setRestoringExpenseId(expense.id);
    try {
      await restoreExpense(expense);
      props.onToast("Expense restored");
    } catch (error) {
      props.onToast(restoreExpenseFailureMessage(error));
    } finally {
      setRestoringExpenseId(undefined);
    }
  }
  return (
    <div class="page-enter space-y-5">
      <header>
        <h1 class="page-title">Activity</h1>
        <p class="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          <span class="sync-dot" classList={{ pending: appStore.connection() !== "online" }} />
          {syncCopy().detail}
        </p>
      </header>
      <div>
        <h2 class="activity-feed-title">Recent changes</h2>
        <For
          each={activityDays()}
          fallback={
            <Card class="mt-4 px-6 py-12 text-center text-sm text-muted-foreground">
              No activity yet. Add an expense or record a payment to see changes here.
            </Card>
          }
        >
          {(day) => <section class="activity-day" aria-label={day.label}>
            <h3>{day.label}</h3>
            <Card class="activity-day-card overflow-hidden">
              <For each={day.operations}>{(operation) => {
                const expense = createMemo(() => appStore.expenses().find((item) => item.id === operation.targetId));
                const payment = createMemo(() => paymentActivityDetails(operation));
                const imported = createMemo(() => {
                  if (operation.type !== "ImportedTransactionRecorded" && operation.type !== "OpeningBalanceCreated") return undefined;
                  const payload = operation.payload as { description?: unknown; amountMinor?: unknown; currency?: unknown };
                  return typeof payload.description === "string" && Number.isSafeInteger(payload.amountMinor) && typeof payload.currency === "string"
                    ? { description: payload.description, amountMinor: Number(payload.amountMinor), currency: payload.currency }
                    : undefined;
                });
                const group = createMemo(() => appStore.groups().find((item) => item.id === operation.groupId));
                const actor = createMemo(() => operation.actorId === props.actorId ? "You" : memberName(operation.groupId, operation.actorId, props.actorId));
                return <article class="activity-row">
                  <ActivityMark operation={operation} expense={expense()} />
                  <Show when={expense()} fallback={
                    <div class="activity-row-main min-h-11">
                      <strong>{actor()} {activityCopy[operation.type] ?? "updated the group"}</strong>
                      <span>{payment() ? `${memberName(operation.groupId, payment()!.payerId, props.actorId)} paid ${memberName(operation.groupId, payment()!.recipientId, props.actorId)} · ${group()?.name ?? "Shared group"}${payment()!.note ? ` · ${payment()!.note}` : ""}` : imported() ? `${imported()!.description} · ${group()?.name ?? "Shared group"}` : group()?.name ?? "Shared group"}</span>
                      <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(operation.clientTimestamp))}</time>
                    </div>
                  }>{(item) => <button type="button" class="activity-row-main min-h-11" onClick={() => props.onOpenExpense(item())}>
                    <strong>{actor()} {activityCopy[operation.type] ?? "updated the group"}</strong>
                    <span>{item().description} · {group()?.name ?? "Shared group"}</span>
                    <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(operation.clientTimestamp))}</time>
                  </button>}</Show>
                  <div class="activity-row-value">
                    <Show when={expense()} fallback={<Show when={payment()} fallback={<Show when={imported()}>{(item) => <><strong>{money(item().amountMinor, item().currency)}</strong><span class="activity-payment-label">imported</span></>}</Show>}>{(item) => <><strong>{money(item().amountMinor, item().currency)}</strong><span class="activity-payment-label">payment</span></>}</Show>}>{(item) => <strong>{money(item().amountMinor, item().currency)}</strong>}</Show>
                    <Show when={operation.type === "ExpenseVoided" && expense()?.status === "voided" && !expense()?.readOnly}>
                      <button class="min-h-11 px-2" disabled={restoringExpenseId() === expense()?.id} onClick={() => expense() && void restore(expense()!)}>{restoringExpenseId() === expense()?.id ? "Restoring…" : "Restore expense"}</button>
                    </Show>
                  </div>
                  <Show when={expense()}><ChevronRight size={15} class="activity-row-chevron" /></Show>
                </article>;
              }}</For>
            </Card>
          </section>}
        </For>
      </div>
    </div>
  );
}
