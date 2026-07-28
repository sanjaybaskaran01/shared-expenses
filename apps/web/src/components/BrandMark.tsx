import { cn } from "../lib/cn";

export function BrandMark(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 38;
  return (
    <img
      class={cn("block shrink-0", props.class)}
      style={{ width: size() + "px", height: size() + "px" }}
      src="/brand-mark.svg"
      alt=""
      aria-hidden="true"
    />
  );
}
