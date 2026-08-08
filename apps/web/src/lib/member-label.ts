import { appStore } from "./store";

export function memberName(groupId: string, userId: string, actorId: string): string {
  if (userId === actorId) return "You";
  return appStore.members().find((member) => member.groupId === groupId && member.userId === userId)?.displayName ?? "Member";
}

export function isVisibleGroupMember(status: string): boolean {
  return status === "active" || status === "placeholder";
}
