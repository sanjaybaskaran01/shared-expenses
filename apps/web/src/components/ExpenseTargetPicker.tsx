import { Dialog } from "@kobalte/core/dialog";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Plus from "lucide-solid/icons/plus";
import Search from "lucide-solid/icons/search";
import UserRound from "lucide-solid/icons/user-round";
import UsersRound from "lucide-solid/icons/users-round";
import X from "lucide-solid/icons/x";
import { For, Show, createMemo, createSignal } from "solid-js";
import { buildExpenseTargets, type ExpenseTarget } from "../lib/expense-targets";
import { appStore } from "../lib/store";
import { Avatar, Button } from "./ui";

interface ExpenseTargetPickerProps {
  open: boolean;
  actorId: string;
  preferredGroupId?: string | undefined;
  onOpenChange(open: boolean): void;
  onSelect(target: ExpenseTarget): void;
  onCreateGroup(): void;
}

export function ExpenseTargetPicker(props: ExpenseTargetPickerProps) {
  const [query, setQuery] = createSignal("");
  let contentRef: HTMLDivElement | undefined;
  let searchRef: HTMLInputElement | undefined;
  const targets = createMemo(() => buildExpenseTargets(appStore.groups(), appStore.members(), props.actorId, props.preferredGroupId));
  const visible = createMemo(() => {
    const value = query().trim().toLocaleLowerCase();
    return value ? targets().filter((target) => `${target.label} ${target.detail}`.toLocaleLowerCase().includes(value)) : targets();
  });
  const groups = createMemo(() => visible().filter((target) => target.kind === "group"));
  const recentGroup = createMemo(() => query().trim() ? undefined : groups().find((target) => target.groupId === props.preferredGroupId));
  const otherGroups = createMemo(() => groups().filter((target) => target.key !== recentGroup()?.key));
  const people = createMemo(() => visible().filter((target) => target.kind === "person"));

  function choose(target: ExpenseTarget): void {
    setQuery("");
    props.onSelect(target);
  }

  return <Show when={props.open}><Dialog open={true} onOpenChange={(open) => { if (!open) setQuery(""); props.onOpenChange(open); }}>
    <Dialog.Portal>
      <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
      <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
        <Dialog.Content
          ref={contentRef}
          role="dialog"
          class="composer-dialog max-h-[92dvh] w-full overflow-hidden rounded-t-[1.4rem] border border-border bg-card shadow-2xl outline-none sm:max-w-md sm:rounded-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            queueMicrotask(() => {
              if (matchMedia("(pointer: coarse)").matches) contentRef?.focus();
              else searchRef?.focus();
            });
          }}
        >
          <header class="flex min-h-16 items-center justify-between border-b border-border px-5">
            <div>
              <Dialog.Title class="text-base font-semibold tracking-[-.015em]">Who is this with?</Dialog.Title>
              <Dialog.Description class="mt-0.5 text-xs text-muted-foreground">Choose a person or group for this expense.</Dialog.Description>
            </div>
            <Dialog.CloseButton class="icon-button" aria-label="Close expense group picker"><X size={18} /></Dialog.CloseButton>
          </header>
          <div class="border-b border-border p-4">
            <label class="relative block">
              <Search class="absolute left-3 top-3 text-muted-foreground" size={17} />
              <span class="sr-only">Search people and groups</span>
              <input ref={searchRef} class="form-control h-11 pl-9" type="search" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search people or groups" autocomplete="off" />
            </label>
          </div>
          <div class="max-h-[62dvh] overflow-y-auto px-2 py-2">
            <Show when={recentGroup()}>{(target) => <>
              <p class="target-section-label">Recently used</p>
              <button class="target-row" type="button" data-testid={`expense-target-${target().key}`} onClick={() => choose(target())}>
                <span class="target-icon"><UsersRound size={17} /></span>
                <span class="min-w-0 flex-1"><strong>{target().label}</strong><small>{target().detail}</small></span>
                <ChevronRight size={16} class="text-muted-foreground" />
              </button>
            </>}</Show>
            <Show when={otherGroups().length}>
              <p class="target-section-label">Groups</p>
              <For each={otherGroups()}>{(target) => <button class="target-row" type="button" data-testid={`expense-target-${target.key}`} onClick={() => choose(target)}>
                <span class="target-icon"><UsersRound size={17} /></span>
                <span class="min-w-0 flex-1"><strong>{target.label}</strong><small>{target.detail}</small></span>
                <ChevronRight size={16} class="text-muted-foreground" />
              </button>}</For>
            </Show>
            <Show when={people().length}>
              <p class="target-section-label mt-3">People</p>
              <For each={people()}>{(target) => <button class="target-row" type="button" data-testid={`expense-target-${target.key}`} onClick={() => choose(target)}>
                <Avatar name={target.label} class="size-9 text-xs" />
                <span class="min-w-0 flex-1"><strong>{target.label}</strong><small>{target.detail}</small><Show when={target.pendingLabel}><small class="target-pending-label">{target.pendingLabel}</small></Show></span>
                <ChevronRight size={16} class="text-muted-foreground" />
              </button>}</For>
            </Show>
            <Show when={!visible().length}>
              <div class="px-5 py-10 text-center"><UserRound class="mx-auto text-muted-foreground" size={25} /><p class="mt-3 text-sm font-medium">No results for “{query().trim()}”</p><button type="button" class="mt-2 min-h-11 px-3 text-sm font-medium text-primary" onClick={() => { setQuery(""); searchRef?.focus(); }}>Clear search</button></div>
            </Show>
          </div>
          <footer class="border-t border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <Button variant="secondary" class="w-full" onClick={() => { props.onOpenChange(false); props.onCreateGroup(); }}><Plus size={16} /> Create group</Button>
          </footer>
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  </Dialog></Show>;
}
