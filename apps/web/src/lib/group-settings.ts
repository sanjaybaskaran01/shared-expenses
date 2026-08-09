export interface GroupConnectionMember {
  displayName: string;
  status?: string;
  importClaim?: {
    status: "unclaimed" | "reserved" | "awaiting_owner";
  };
}

type MemberConnectionState = "active" | "invitation-pending" | "import-unlinked" | "import-awaiting-review";

export const IMPORT_IDENTITY_LINK_EXPLANATION = "A shared group does not prove who owns imported history. The secure link verifies the right account before it receives access.";

function memberConnectionState(member: {
  status: string;
  importClaim?: GroupConnectionMember["importClaim"];
}): MemberConnectionState {
  if (member.importClaim?.status === "awaiting_owner") return "import-awaiting-review";
  if (member.importClaim) return "import-unlinked";
  if (member.status === "placeholder") return "invitation-pending";
  return "active";
}

export function pendingExpenseMemberLabel(member: {
  status: string;
  importClaim?: GroupConnectionMember["importClaim"];
}): string | undefined {
  const state = memberConnectionState(member);
  if (state === "import-unlinked" || state === "import-awaiting-review") return "Account not connected";
  return state === "invitation-pending" ? "Invite pending" : undefined;
}

export function pendingExpenseTargetLabel(member: {
  status: string;
  importClaim?: GroupConnectionMember["importClaim"];
}): string | undefined {
  const label = pendingExpenseMemberLabel(member);
  return label ? `${label}${label === "Invite pending" ? "" : " yet"} · you can still add expenses` : undefined;
}

export function memberBalanceContextPrefix(member: {
  status: string;
  importClaim?: GroupConnectionMember["importClaim"];
}): string {
  const state = memberConnectionState(member);
  if (state === "import-unlinked" || state === "import-awaiting-review") return "Account not connected · ";
  return state === "invitation-pending" ? "Invitation pending · " : "";
}

export function memberConnectionActionLabel(member: {
  status: string;
  importClaim?: GroupConnectionMember["importClaim"];
}): string {
  return memberConnectionState(member) === "invitation-pending" ? "Invite pending" : "Connect account";
}

export interface GroupConnectionCallout {
  count: number;
  title: string;
  detail: string;
}

export function groupConnectionCallout(
  members: readonly GroupConnectionMember[],
): GroupConnectionCallout | undefined {
  const pending = members.filter((member) => member.importClaim);
  if (pending.length === 0) return undefined;

  const awaitingReview = pending.filter(
    (member) => member.importClaim?.status === "awaiting_owner",
  );
  if (awaitingReview.length > 0) {
    return {
      count: pending.length,
      title: awaitingReview.length === 1
        ? `Review ${awaitingReview[0]!.displayName}’s connection`
        : `Review ${awaitingReview.length} account connections`,
      detail: "Confirm each account before sharing imported balances.",
    };
  }

  return {
    count: pending.length,
    title: pending.length === 1
      ? `Connect ${pending[0]!.displayName}’s imported history`
      : `Connect ${pending.length} imported histories`,
    detail: "You can add expenses now. Connect each person to their Tallied account when ready.",
  };
}

export function groupMemberStatus(
  member: { status: string; importClaim?: GroupConnectionMember["importClaim"] },
  isCurrentUser: boolean,
): string {
  if (isCurrentUser) return "You";
  const state = memberConnectionState(member);
  if (state === "import-awaiting-review") return "Account connection awaiting review";
  if (state === "import-unlinked") return "Account not connected · you can still add expenses";
  if (state === "invitation-pending") return "Invitation pending · you can still add expenses";
  return "Member";
}
