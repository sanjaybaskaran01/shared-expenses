import { Dialog } from "@kobalte/core/dialog";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Scale from "lucide-solid/icons/scale";
import X from "lucide-solid/icons/x";
import { For, Show, createMemo } from "solid-js";
import { settlementBlockerCount } from "../lib/group-insights";
import { computeRelationshipBalances, type RelationshipBalance, type Settlement } from "../lib/ledger-view";
import { appStore } from "../lib/store";
import { Avatar, Button } from "./ui";

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

export function RelationshipDetail(props: {
  open: boolean;
  actorId: string;
  relationship: RelationshipBalance | undefined;
  onOpenChange(open: boolean): void;
  onOpenGroup(groupId: string): void;
  onSettle(settlement: Settlement, currency: string, groupId: string): void;
}) {
  const personName = createMemo(() => appStore.members().find((member) => member.userId === props.relationship?.userId)?.displayName ?? "Friend");
  const contributions = createMemo(() => (props.relationship?.groupIds ?? []).flatMap((groupId) => {
    const group = appStore.groups().find((item) => item.id === groupId);
    const relationship = props.relationship;
    if (!group || !relationship) return [];
    const contribution = computeRelationshipBalances(
      appStore.expenses(),
      appStore.operations(),
      [group],
      appStore.members(),
      props.actorId,
    ).find((item) => item.userId === relationship.userId && item.currency === relationship.currency);
    const sharedExpenseCount = appStore.expenses().filter((expense) => expense.groupId === groupId && expense.status === "active" && (
      expense.payers.some((payer) => payer.participantId === relationship.userId) ||
      expense.allocations.some((allocation) => allocation.participantId === relationship.userId)
    )).length;
    return [{ group, amountMinor: contribution?.amountMinor ?? 0, sharedExpenseCount }];
  }));
  const settlement = createMemo<Settlement | undefined>(() => {
    const relationship = props.relationship;
    if (!relationship || relationship.groupIds.length !== 1 || relationship.amountMinor === 0) return undefined;
    return relationship.amountMinor > 0
      ? { payerId: relationship.userId, recipientId: props.actorId, amountMinor: relationship.amountMinor }
      : { payerId: props.actorId, recipientId: relationship.userId, amountMinor: Math.abs(relationship.amountMinor) };
  });
  const canSettle = createMemo(() => {
    const relationship = props.relationship;
    return Boolean(settlement() && relationship && settlementBlockerCount(appStore.expenses(), relationship.groupIds[0]!, relationship.currency) === 0);
  });

  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
      <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
        <Dialog.Content role="dialog" class="composer-dialog glass-sheet max-h-[92dvh] w-full overflow-y-auto border border-border bg-card outline-none sm:max-w-md sm:rounded-xl">
          <header class="flex min-h-16 items-center justify-between border-b border-border px-5">
            <div class="flex min-w-0 items-center gap-3">
              <Avatar name={personName()} class="size-9 text-xs" />
              <div class="min-w-0"><Dialog.Title class="truncate font-semibold">{personName()}</Dialog.Title><Dialog.Description class="text-xs text-muted-foreground">Your balance across shared groups</Dialog.Description></div>
            </div>
            <Dialog.CloseButton class="icon-button" aria-label="Close person details"><X size={18} /></Dialog.CloseButton>
          </header>
          <div class="grid gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <section class="relationship-detail-summary">
              <span>{props.relationship?.amountMinor && props.relationship.amountMinor > 0 ? `${personName()} owes you` : "You owe"}</span>
              <strong>{money(Math.abs(props.relationship?.amountMinor ?? 0), props.relationship?.currency ?? "USD")}</strong>
              <p>{contributions().length} contributing {contributions().length === 1 ? "group" : "groups"}</p>
            </section>
            <section aria-labelledby="relationship-groups-heading">
              <h3 id="relationship-groups-heading" class="micro-label mb-2">Where this balance comes from</h3>
              <div class="relationship-contribution-list">
                <For each={contributions()}>{(item) => <button type="button" onClick={() => { props.onOpenChange(false); props.onOpenGroup(item.group.id); }}>
                  <span class="min-w-0 flex-1"><strong>{item.group.name}</strong><small>{item.sharedExpenseCount} shared {item.sharedExpenseCount === 1 ? "expense" : "expenses"}</small></span>
                  <span class="text-right"><small>{item.amountMinor > 0 ? "owes you" : item.amountMinor < 0 ? "you owe" : "settled"}</small><strong>{money(Math.abs(item.amountMinor), props.relationship?.currency ?? item.group.settlementCurrency)}</strong></span>
                  <ChevronRight size={16} />
                </button>}</For>
              </div>
            </section>
            <Show when={canSettle() && settlement()} fallback={<Show when={contributions().length > 1}><p class="text-xs leading-5 text-muted-foreground">Open a group to settle its part separately. This keeps every shared record explainable.</p></Show>}>
              {(value) => <Button onClick={() => { const relationship = props.relationship!; props.onOpenChange(false); props.onSettle(value(), relationship.currency, relationship.groupIds[0]!); }}><Scale size={16} /> Settle with {personName()}</Button>}
            </Show>
          </div>
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  </Dialog>;
}
