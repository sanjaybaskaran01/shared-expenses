import type { LocalGroup, LocalMember } from "./db";
import type { ExpenseTarget } from "./expense-targets";

export type GroupComposerOrigin = "groups" | "expense";

export type ExpenseLaunchDecision =
  | { kind: "pick-target" }
  | { kind: "compose"; target: ExpenseTarget };

export type GroupCreationDestination =
  | { kind: "open-group"; groupId: string }
  | { kind: "compose"; target: ExpenseTarget };

interface ExpenseLaunchInput {
  groups: LocalGroup[];
  members: LocalMember[];
  groupId?: string;
}

function groupTarget(
  groups: LocalGroup[],
  members: LocalMember[],
  groupId: string,
): ExpenseTarget | undefined {
  const group = groups.find((item) => item.id === groupId);
  if (!group) return undefined;
  const count = members.filter((member) => member.groupId === groupId && member.status === "active").length;
  return {
    key: `group:${group.id}`,
    kind: "group",
    groupId: group.id,
    label: group.name,
    detail: `${count} ${count === 1 ? "person" : "people"}`,
  };
}

export function decideExpenseLaunch(input: ExpenseLaunchInput): ExpenseLaunchDecision {
  if (!input.groupId) return { kind: "pick-target" };
  const target = groupTarget(input.groups, input.members, input.groupId);
  return target ? { kind: "compose", target } : { kind: "pick-target" };
}

export function decideGroupCreationDestination(
  origin: GroupComposerOrigin,
  groups: LocalGroup[],
  members: LocalMember[],
  groupId: string,
  fallbackLabel?: string,
): GroupCreationDestination {
  if (origin === "groups") return { kind: "open-group", groupId };
  const target = groupTarget(groups, members, groupId);
  if (target) return { kind: "compose", target };
  if (fallbackLabel) {
    return {
      kind: "compose",
      target: {
        key: `group:${groupId}`,
        kind: "group",
        groupId,
        label: fallbackLabel,
        detail: "1 person",
      },
    };
  }
  return { kind: "open-group", groupId };
}

export function groupComposerOriginAfterOpenChange(
  open: boolean,
  origin: GroupComposerOrigin,
): GroupComposerOrigin {
  return open ? origin : "groups";
}

/**
 * iOS Safari may restore focus to the closing sheet after a replacement sheet
 * has already opened. Let the close animation and focus restoration finish on
 * coarse-pointer devices before mounting the next dialog.
 */
export function dialogHandoffDelay(coarsePointer: boolean): number {
  return coarsePointer ? 180 : 0;
}
