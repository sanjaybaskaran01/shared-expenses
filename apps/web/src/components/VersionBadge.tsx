import { Show } from "solid-js";
import { releaseWatch } from "../lib/release-watch";
import { Badge } from "./ui";

export function VersionBadge(props: { class?: string }) {
  return (
    <Show when={releaseWatch.runningRelease()}>
      {(info) => (
        <Badge class={props.class} title={`Built ${new Date(info().builtAt).toLocaleString()}`}>
          v{info().version} · {info().commit.slice(0, 7)}
        </Badge>
      )}
    </Show>
  );
}
