import type { LocalExpense, LocalGroup, LocalMember, LocalOperation } from "./db";

export interface ExpenseTarget {
  key: string;
  kind: "group" | "person";
  groupId: string;
  label: string;
  detail: string;
  participantIds?: string[];
}

export function mostRecentExpenseGroupId(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[] = [],
  actorId?: string,
): string | undefined {
  if (actorId) {
    const expenseById = new Map(expenses.map((expense) => [expense.id, expense]));
    const ownGroupId = operations
      .filter((operation) => operation.actorId === actorId && (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended"))
      .slice()
      .sort((left, right) => right.clientTimestamp.localeCompare(left.clientTimestamp) || right.id.localeCompare(left.id))
      .map((operation) => expenseById.get(operation.targetId)?.groupId)
      .find(Boolean);
    if (ownGroupId) return ownGroupId;
  }
  return expenses
    .filter((expense) => expense.status === "active")
    .filter((expense) => !actorId || expense.createdBy === actorId)
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    ?.groupId;
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
  const membershipsByPerson = new Map<string, LocalMember[]>();
  for (const member of activeMembers) {
    if (member.userId === actorId || !groupNames.has(member.groupId)) continue;
    membershipsByPerson.set(member.userId, [...(membershipsByPerson.get(member.userId) ?? []), member]);
  }
  const groupPriority = new Map(groupTargets.map((target, index) => [target.groupId, index]));
  const peopleTargets = [...membershipsByPerson.entries()]
    .map(([userId, memberships]) => {
      const membership = memberships.find((item) => item.groupId === preferredGroupId)
        ?? [...memberships].sort((left, right) => (groupPriority.get(left.groupId) ?? 0) - (groupPriority.get(right.groupId) ?? 0))[0]!;
      const groupName = groupNames.get(membership.groupId)!;
      return {
        key: `person:${userId}`,
        kind: "person" as const,
        groupId: membership.groupId,
        label: membership.displayName,
        detail: memberships.length > 1 ? `${groupName} · ${memberships.length} shared groups` : groupName,
        participantIds: [actorId, userId],
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label) || left.detail.localeCompare(right.detail));

  return [...groupTargets, ...peopleTargets];
}
