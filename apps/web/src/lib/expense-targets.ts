import type { LocalGroup, LocalMember } from "./db";

export interface ExpenseTarget {
  key: string;
  kind: "group" | "person";
  groupId: string;
  label: string;
  detail: string;
  participantIds?: string[];
}

export function buildExpenseTargets(
  groups: LocalGroup[],
  members: LocalMember[],
  actorId: string,
  preferredGroupId?: string,
): ExpenseTarget[] {
  const activeMembers = members.filter((member) => member.status === "active");
  const groupTargets = groups.map((group) => {
    const count = activeMembers.filter((member) => member.groupId === group.id).length;
    return {
      key: `group:${group.id}`,
      kind: "group" as const,
      groupId: group.id,
      label: group.name,
      detail: `${count} ${count === 1 ? "person" : "people"}`,
    };
  }).sort((left, right) => {
    if (left.groupId === preferredGroupId) return -1;
    if (right.groupId === preferredGroupId) return 1;
    return left.label.localeCompare(right.label);
  });

  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const peopleTargets = activeMembers
    .filter((member) => member.userId !== actorId && groupNames.has(member.groupId))
    .map((member) => ({
      key: `person:${member.groupId}:${member.userId}`,
      kind: "person" as const,
      groupId: member.groupId,
      label: member.displayName,
      detail: groupNames.get(member.groupId)!,
      participantIds: [actorId, member.userId],
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.detail.localeCompare(right.detail));

  return [...groupTargets, ...peopleTargets];
}
