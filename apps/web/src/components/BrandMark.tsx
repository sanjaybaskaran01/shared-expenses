export function BrandMark(props: { size?: number; class?: string }) {
  return (
    <img
      src="/brand-mark.svg"
      width={props.size ?? 38}
      height={props.size ?? 38}
      class={props.class}
      alt=""
      aria-hidden="true"
    />
  );
}
