import { cn } from "../lib/cn";

export function BrandMark(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 38;
  return (
    <span
      class={cn("inline-grid shrink-0 place-items-center rounded-md bg-primary text-primary-foreground", props.class)}
      style={{ width: size() + "px", height: size() + "px" }}
      aria-hidden="true"
    >
      <span style={{ "font-size": `${Math.round(size() * 0.48)}px`, "font-weight": 680, "letter-spacing": "-.06em" }}>T</span>
    </span>
  );
}
