import type { JSX } from "solid-js";

export function SectionHeading(props: {
  title: string;
  detail?: string;
  action?: JSX.Element;
}) {
  return (
    <div class="flex min-h-14 items-center justify-between gap-4 border-b border-border/65 px-4 sm:px-5">
      <div>
        <h2 class="text-sm font-semibold tracking-tight">{props.title}</h2>
        {props.detail ? <p class="mt-0.5 text-xs text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.action}
    </div>
  );
}
