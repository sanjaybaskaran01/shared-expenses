import { ReceiptText } from "lucide-solid";
import { cn } from "../lib/cn";

export function BrandMark(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 38;
  return (
    <span
      class={cn("inline-grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground", props.class)}
      style={{ width: size() + "px", height: size() + "px" }}
      aria-hidden="true"
    >
      <ReceiptText size={Math.round(size() * 0.5)} stroke-width={2.25} />
    </span>
  );
}
