import { Dialog } from "@kobalte/core/dialog";
import Bug from "lucide-solid/icons/bug";
import Check from "lucide-solid/icons/check";
import Lightbulb from "lucide-solid/icons/lightbulb";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import MessageCircle from "lucide-solid/icons/message-circle";
import X from "lucide-solid/icons/x";
import { Show, createSignal, onCleanup } from "solid-js";
import { sendFeedback } from "../lib/api";
import { cn } from "../lib/cn";
import { Button } from "./ui";

type FeedbackCategory = "bug" | "idea";

export function FeedbackButton(props: { compact?: boolean; class?: string }) {
  const [open, setOpen] = createSignal(false);
  const [category, setCategory] = createSignal<FeedbackCategory>("bug");
  const [message, setMessage] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal("");
  let resetTimer: number | undefined;
  let closeTimer: number | undefined;
  let messageRef: HTMLTextAreaElement | undefined;

  onCleanup(() => {
    if (resetTimer !== undefined) window.clearTimeout(resetTimer);
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
  });

  function handleOpenChange(next: boolean): void {
    if (resetTimer !== undefined) window.clearTimeout(resetTimer);
    if (next && closeTimer !== undefined) {
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    setOpen(next);
    if (!next) {
      resetTimer = window.setTimeout(() => {
        setCategory("bug");
        setMessage("");
        setSending(false);
        setSent(false);
        setError("");
        resetTimer = undefined;
      }, 200);
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      await sendFeedback({ category: category(), message: message().trim(), pageUrl: window.location.href });
      setSent(true);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        closeTimer = undefined;
        handleOpenChange(false);
      }, 1400);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not send this — try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size={props.compact ? "icon" : "sm"}
        class={cn(props.compact ? "" : "w-full justify-start gap-2", props.class)}
        onClick={() => handleOpenChange(true)}
        aria-label="Send feedback"
      >
        <MessageCircle size={16} /> <Show when={!props.compact}>Feedback</Show>
      </Button>
      <Dialog open={open()} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45 data-[expanded]:animate-in data-[closed]:animate-out" />
          <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
            <Dialog.Content
              role="dialog"
              class="w-full overflow-y-auto rounded-t-xl border border-border bg-card shadow-xl outline-none sm:max-w-md sm:rounded-xl"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                queueMicrotask(() => messageRef?.focus());
              }}
            >
              <header class="flex h-14 items-center justify-between border-b border-border px-5">
                <Dialog.Title class="text-base font-semibold">Send feedback</Dialog.Title>
                <Dialog.CloseButton
                  class="icon-button"
                  aria-label="Close feedback form"
                >
                  <X size={17} />
                </Dialog.CloseButton>
              </header>
              <Show
                when={!sent()}
                fallback={
                  <div class="grid place-items-center gap-3 px-6 py-12 text-center" role="status" aria-live="polite">
                    <span class="feedback-success grid size-11 place-items-center rounded-md">
                      <Check size={20} />
                    </span>
                    <p class="text-sm font-medium">Thanks — we got it.</p>
                  </div>
                }
              >
                <form class="grid gap-4 p-5 sm:p-6" onSubmit={(event) => void submit(event)}>
                  <div class="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      class="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                      classList={{ "border-primary bg-primary/5 ring-1 ring-primary": category() === "bug" }}
                      onClick={() => setCategory("bug")}
                      aria-pressed={category() === "bug"}
                    >
                      <Bug size={16} /> Bug
                    </button>
                    <button
                      type="button"
                      class="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                      classList={{ "border-primary bg-primary/5 ring-1 ring-primary": category() === "idea" }}
                      onClick={() => setCategory("idea")}
                      aria-pressed={category() === "idea"}
                    >
                      <Lightbulb size={16} /> Idea
                    </button>
                  </div>
                  <label class="grid gap-2 text-sm font-medium">
                    {category() === "bug" ? "What went wrong?" : "What would help?"}
                    <textarea
                      ref={messageRef}
                      class="form-control min-h-28 resize-y py-2"
                      required
                      maxlength={4000}
                      value={message()}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                      placeholder={category() === "bug" ? "Tell us what happened…" : "Tell us what you'd like to see…"}
                    />
                  </label>
                  <Show when={error()}>
                    <p class="error-callout" role="alert">
                      {error()}
                    </p>
                  </Show>
                  <Button type="submit" disabled={sending() || !message().trim()}>
                    <Show when={sending()} fallback={<><Check size={16} /> Send</>}>
                      <LoaderCircle class="animate-spin" size={16} /> Sending…
                    </Show>
                  </Button>
                </form>
              </Show>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
    </>
  );
}
