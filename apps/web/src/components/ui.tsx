import { cva, type VariantProps } from "class-variance-authority";
import { For, splitProps, type JSX } from "solid-js";
import { cn } from "../lib/cn";
import { nextTabIndex } from "../lib/ui-navigation";

const buttonVariants = cva(
  "ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "border border-border bg-background text-foreground shadow-sm hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "border border-destructive/20 bg-background text-destructive hover:bg-destructive/5",
      },
      size: {
        default: "min-h-11 px-4 py-2",
        sm: "min-h-11 rounded-md px-3",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return <button class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)} {...rest} />;
}

export function Card(props: JSX.HTMLAttributes<HTMLElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <section class={cn("ui-card rounded-xl border border-border bg-card text-card-foreground shadow-sm", local.class)} {...rest} />;
}

export function Badge(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <span class={cn("inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground", local.class)} {...rest} />;
}

export function Avatar(props: { name: string; class?: string }) {
  const tone = [...props.name].reduce((total, character) => total + character.charCodeAt(0), 0) % 4;
  return (
    <span class={cn(`avatar-tile avatar-tone-${tone} inline-grid size-9 shrink-0 place-items-center rounded-md text-sm font-semibold`, props.class)}>
      {props.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.slice(0, 1).toUpperCase())
        .join("") || "?"}
    </span>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: () => JSX.Element;
}

interface AccessibleTabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange(value: T): void;
  ariaLabel: string;
  idPrefix: string;
  class?: string;
}

export function tabId(idPrefix: string, value: string): string {
  return `${idPrefix}-tab-${value}`;
}

export function tabPanelId(idPrefix: string, value: string): string {
  return `${idPrefix}-panel-${value}`;
}

export function AccessibleTabs<T extends string>(props: AccessibleTabsProps<T>) {
  const refs: HTMLButtonElement[] = [];

  function onKeyDown(index: number, event: KeyboardEvent): void {
    const nextIndex = nextTabIndex(index, props.items.length, event.key);
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = props.items[nextIndex];
    if (!next) return;
    props.onChange(next.id);
    queueMicrotask(() => refs[nextIndex]?.focus());
  }

  return (
    <div class={props.class} role="tablist" aria-label={props.ariaLabel}>
      <For each={props.items}>{(item, index) => (
        <button
          ref={(element) => { refs[index()] = element; }}
          id={tabId(props.idPrefix, item.id)}
          type="button"
          role="tab"
          tabindex={props.value === item.id ? 0 : -1}
          aria-selected={props.value === item.id}
          aria-controls={tabPanelId(props.idPrefix, item.id)}
          classList={{ active: props.value === item.id }}
          onClick={() => props.onChange(item.id)}
          onKeyDown={(event) => onKeyDown(index(), event)}
        >
          {item.icon?.()}
          <span>{item.label}</span>
        </button>
      )}</For>
    </div>
  );
}
