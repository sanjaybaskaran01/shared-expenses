import ChevronRight from "lucide-solid/icons/chevron-right";
import Cloud from "lucide-solid/icons/cloud";
import DatabaseBackup from "lucide-solid/icons/database-backup";
import LogOut from "lucide-solid/icons/log-out";
import Moon from "lucide-solid/icons/moon";
import Scale from "lucide-solid/icons/scale";
import ShieldCheck from "lucide-solid/icons/shield-check";
import Sparkles from "lucide-solid/icons/sparkles";
import Sun from "lucide-solid/icons/sun";
import { For, Show, createEffect, createSignal } from "solid-js";
import { signOutAndClearLocalLedger } from "../lib/auth";
import { applyTheme, type Theme } from "../lib/theme";
import { FeedbackButton } from "./FeedbackDialog";
import { NotificationSettings } from "./NotificationSettings";
import { SectionHeading } from "./SectionHeading";
import { VersionBadge } from "./VersionBadge";
import { Avatar, Button, Card } from "./ui";

export function AccountView(props: { displayName: string; email: string | undefined; smartCategoriesEnabled: boolean; onSmartCategoriesChange(enabled: boolean): void; onOpenMigration(): void; onNotify(message: string): void }) {
  const [theme, setTheme] = createSignal<Theme>(
    (localStorage.getItem("expenses-theme") as Theme | null) ?? "system",
  );
  createEffect(() => {
    const value = theme();
    localStorage.setItem("expenses-theme", value);
    applyTheme(value);
  });
  return (
    <div class="page-enter space-y-5">
      <header>
        <p class="eyebrow">Preferences & security</p>
        <h1 class="page-title">Account</h1>
      </header>
      <Card class="p-5">
        <div class="flex items-center gap-4">
          <Avatar name={props.displayName} class="size-14 text-lg" />
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold">{props.displayName}</h2>
            <p class="truncate text-sm text-muted-foreground">{props.email ?? "Offline account on this device"}</p>
          </div>
          <Show when={!import.meta.env.DEV}>
            <Button
              variant="secondary"
              size="sm"
              class="shrink-0"
              onClick={() => void signOutAndClearLocalLedger()}
            >
              <LogOut size={15} /> Log out
            </Button>
          </Show>
        </div>
        <Show when={!import.meta.env.DEV}>
          <p class="mt-4 border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
            Logging out removes this account's cached ledger from this device.
          </p>
        </Show>
      </Card>
      <button class="migration-account-card" type="button" onClick={props.onOpenMigration}>
        <span class="category-icon"><DatabaseBackup size={18} /></span>
        <span class="min-w-0 flex-1 text-left"><strong class="block text-sm">Move from Splitwise</strong><small class="mt-0.5 block text-xs text-muted-foreground">Review balances before anything changes</small></span>
        <ChevronRight size={16} class="text-muted-foreground" />
      </button>
      <Card class="overflow-hidden">
        <SectionHeading title="Expense entry" detail="On-device preview" />
        <div class="smart-category-setting">
          <span class="category-icon category-tone-leisure"><Sparkles size={17} /></span>
          <span class="min-w-0 flex-1"><strong>Smart category suggestions</strong><small>Uses built-in English rules and your past choices. No description is sent to a model.</small></span>
          <button type="button" class="preference-switch" role="switch" aria-checked={props.smartCategoriesEnabled} aria-label="Smart category suggestions" onClick={() => props.onSmartCategoriesChange(!props.smartCategoriesEnabled)}><span /></button>
        </div>
      </Card>
      <NotificationSettings onNotify={props.onNotify} />
      <Card class="overflow-hidden">
        <SectionHeading title="Appearance" detail="Optimized for iPhone" />
        <div class="grid grid-cols-3 gap-2 p-4">
          <For
            each={
              [
                { id: "system", label: "System", icon: Sparkles },
                { id: "light", label: "Light", icon: Sun },
                { id: "dark", label: "Dark", icon: Moon },
              ] as const
            }
          >
            {(item) => (
              <button
                class="appearance-choice"
                classList={{ active: theme() === item.id }}
                aria-pressed={theme() === item.id}
                onClick={() => setTheme(item.id)}
              >
                <item.icon size={17} />
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </div>
      </Card>
      <Card class="overflow-hidden">
        <For
          each={[
            {
              icon: ShieldCheck,
              title: "Protected on this device",
              detail: "This device signs changes so edits can be attributed",
            },
            {
              icon: Cloud,
              title: "Works offline",
              detail: "New entries stay safe here until sync resumes",
            },
            {
              icon: Scale,
              title: "Reviewable history",
              detail: "Edits and deletions remain visible in Activity",
            },
          ]}
        >
          {(item) => (
            <article class="flex items-center gap-3 border-b border-border/60 px-4 py-4 last:border-0">
              <span class="category-icon">
                <item.icon size={17} />
              </span>
              <div>
                <strong class="block text-sm">{item.title}</strong>
                <span class="text-xs text-muted-foreground">{item.detail}</span>
              </div>
            </article>
          )}
        </For>
        <Show when={!import.meta.env.DEV}>
          <div class="border-t border-border/60 p-3">
            <FeedbackButton />
          </div>
        </Show>
      </Card>
      <Card class="p-4 text-xs text-muted-foreground">
        <VersionBadge />
      </Card>
    </div>
  );
}
