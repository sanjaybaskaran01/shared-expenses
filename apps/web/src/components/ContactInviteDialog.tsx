import { Dialog } from "@kobalte/core/dialog";
import Check from "lucide-solid/icons/check";
import Copy from "lucide-solid/icons/copy";
import MessageCircle from "lucide-solid/icons/message-circle";
import Send from "lucide-solid/icons/send";
import UserPlus from "lucide-solid/icons/user-plus";
import X from "lucide-solid/icons/x";
import { For, Show, createResource, createSignal } from "solid-js";
import {
  createContactInvitation,
  getContacts,
  revokeContactInvitation,
  type ContactInviteState,
} from "../lib/api";
import {
  contactPickerAvailable,
  messageInvitation,
  pickContactForMessage,
  shareInvitation,
} from "../lib/contact-invites";
import { Avatar, Button } from "./ui";

export function ContactInviteDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onChanged?(): void;
}) {
  const [state, { mutate, refetch }] = createResource(
    () => props.open,
    async (open) => open ? getContacts() : undefined,
  );
  const [lastInviteUrl, setLastInviteUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [messageTone, setMessageTone] = createSignal<"status" | "error">("status");
  let contentRef: HTMLDivElement | undefined;

  function applyState(value: ContactInviteState): void {
    mutate(value);
    props.onChanged?.();
  }

  async function createAndShare(mode: "share" | "message"): Promise<void> {
    setBusy(true);
    setMessage("");
    setMessageTone("status");
    try {
      const invitation = await createContactInvitation();
      applyState(invitation);
      setLastInviteUrl(invitation.url);
      if (mode === "message") {
        let phone = "";
        if (contactPickerAvailable()) {
          const contact = await pickContactForMessage();
          if (!contact) {
            setMessage("Invite created. Choose Share invite whenever you’re ready.");
            return;
          }
          phone = contact.tel?.[0] ?? "";
        }
        messageInvitation(invitation.url, phone);
        setMessage("Invite created. Messages is ready for you to choose or confirm the recipient.");
        return;
      }
      const result = await shareInvitation(invitation.url);
      setMessage(
        result === "copied"
          ? "Invite copied. Send it to one person."
          : result === "cancelled"
            ? "Invite saved below—you can share it later."
            : "Invite ready. It can be claimed by one verified email.",
      );
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "Could not create an invitation");
    } finally {
      setBusy(false);
    }
  }

  async function copyLatest(): Promise<void> {
    await navigator.clipboard.writeText(lastInviteUrl());
    setMessageTone("status");
    setMessage("Invite link copied.");
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    try {
      applyState(await revokeContactInvitation(id));
      setMessageTone("status");
      setMessage("Invite revoked and its credit returned.");
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "Could not revoke the invite");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => {
      props.onOpenChange(open);
      if (open) void refetch();
      else {
        props.onChanged?.();
        setLastInviteUrl("");
        setMessage("");
        setMessageTone("status");
      }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content
            ref={contentRef}
            role="dialog"
            class="composer-dialog invite-dialog w-full border border-border bg-card shadow-2xl outline-none sm:max-w-md sm:rounded-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => contentRef?.focus());
            }}
          >
            <header class="flex min-h-16 items-center justify-between border-b border-border px-5">
              <div>
                <Dialog.Title class="text-base font-semibold">Invite friends</Dialog.Title>
                <Dialog.Description class="mt-0.5 text-xs text-muted-foreground">
                  No group required. Each link works once.
                </Dialog.Description>
              </div>
              <Dialog.CloseButton class="icon-button" aria-label="Close invite form"><X size={18} /></Dialog.CloseButton>
            </header>

            <div class="grid gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
              <section class="invite-credit-panel">
                <div>
                  <span class="micro-label">Invitations available</span>
                  <strong>{state.loading ? "Checking…" : state.error ? "Connect to check" : `${state()?.creditsRemaining ?? 0} of ${state()?.creditsTotal ?? 5}`}</strong>
                </div>
                <UserPlus size={20} />
              </section>

              <Show when={state.error}>
                <p class="invite-offline-note" role="status">Connect to the internet to create a new link. Your contacts and existing invitations are unchanged.</p>
              </Show>

              <div class="grid grid-cols-2 gap-2">
                <Button disabled={busy() || state.loading || Boolean(state.error) || state()?.creditsRemaining === 0} onClick={() => void createAndShare("share")}>
                  <Send size={16} /> Share invite
                </Button>
                <Button variant="secondary" disabled={busy() || state.loading || Boolean(state.error) || state()?.creditsRemaining === 0} onClick={() => void createAndShare("message")}>
                  <MessageCircle size={16} /> Message
                </Button>
              </div>

              <Show when={lastInviteUrl()}>
                <button class="invite-copy-row" type="button" onClick={() => void copyLatest()}>
                  <span class="truncate">{lastInviteUrl()}</span><Copy size={15} />
                </button>
              </Show>

              <Show when={message()}><p class="text-xs leading-5 text-muted-foreground" role={messageTone() === "error" ? "alert" : "status"} aria-live={messageTone() === "error" ? "assertive" : "polite"}>{message()}</p></Show>

              <Show when={state()?.contacts.length}>
                <section>
                  <h3 class="micro-label mb-2">On Tallied</h3>
                  <div class="divide-y divide-border/60 rounded-lg border border-border">
                    <For each={state()?.contacts}>{(contact) => (
                      <div class="flex items-center gap-3 px-3 py-3">
                        <Avatar name={contact.displayName} />
                        <strong class="min-w-0 flex-1 truncate text-sm">{contact.displayName}</strong>
                        <span class="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check size={13} /> Joined</span>
                      </div>
                    )}</For>
                  </div>
                </section>
              </Show>

              <Show when={state()?.invitations.some((invite) => invite.status === "pending" || invite.status === "reserved")}>
                <section>
                  <h3 class="micro-label mb-2">Open invitations</h3>
                  <div class="divide-y divide-border/60 rounded-lg border border-border">
                    <For each={state()?.invitations.filter((invite) => invite.status === "pending" || invite.status === "reserved")}>
                      {(invite) => (
                        <div class="flex items-center gap-3 px-3 py-3 text-sm">
                          <span class="min-w-0 flex-1">
                            <strong class="block">{invite.status === "reserved" ? "Verifying email" : "Ready to share"}</strong>
                            <small class="text-muted-foreground">Expires {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(invite.expiresAt))}</small>
                          </span>
                          <button class="min-h-11 px-2 text-xs font-medium text-destructive" type="button" disabled={busy()} onClick={() => void revoke(invite.id)}>Revoke</button>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              <p class="text-xs leading-5 text-muted-foreground">
                Tallied never uploads your address book. On iPhone, the share sheet or Messages lets you choose a recipient privately. Anyone with the link can claim it once, so confirm who joined before sharing expenses.
              </p>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
