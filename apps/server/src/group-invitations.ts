import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { deriveDisplayNameFromEmail } from "./auth";

export type GroupInvitationErrorCode =
  | "INVITATION_DELIVERY_UNAVAILABLE"
  | "NOT_A_GROUP_MEMBER"
  | "ALREADY_INVITED"
  | "INVITE_EMAIL_FAILED";

export class GroupInvitationError extends Error {
  constructor(
    readonly code: GroupInvitationErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GroupInvitationError";
  }
}

export interface GroupInvitationResult {
  id: string;
  email: string;
  status: "pending";
  delivery: "email" | "share";
  joinUrl: string;
}

interface CreateGroupInvitationInput {
  db: Database;
  actorId: string;
  groupId: string;
  email: string;
  webOrigin: string;
  smtpEnabled: boolean;
  googleEnabled: boolean;
  sendMagicLink(input: { email: string; displayName: string; invitationId: string }): Promise<void>;
  now?: () => Date;
}

export async function createGroupInvitation(input: CreateGroupInvitationInput): Promise<GroupInvitationResult> {
  if (!input.smtpEnabled && !input.googleEnabled) {
    throw new GroupInvitationError(
      "INVITATION_DELIVERY_UNAVAILABLE",
      "Configure email or Google sign-in before inviting someone.",
      503,
    );
  }
  const membership = input.db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'",
  ).get(input.groupId, input.actorId);
  if (!membership) {
    throw new GroupInvitationError("NOT_A_GROUP_MEMBER", "You must be a current group member to do this.", 403);
  }
  const email = input.email.trim().toLowerCase();
  const existingUser = input.db.query<{ name: string }, [string]>(
    `SELECT name FROM "user" WHERE lower(email) = ? LIMIT 1`,
  ).get(email);
  const displayName = existingUser?.name.trim() || deriveDisplayNameFromEmail(email);
  const duplicate = input.db.query<{ one: number }, [string, string]>(
    `SELECT 1 AS one FROM group_members
     WHERE group_id = ? AND lower(email) = ? AND status IN ('placeholder', 'active') LIMIT 1`,
  ).get(input.groupId, email);
  if (duplicate) throw new GroupInvitationError("ALREADY_INVITED", "This email is already in the group.", 409);

  const invitationId = randomUUID();
  const now = (input.now?.() ?? new Date()).toISOString();
  const placeholderUserId = `invite:${invitationId}`;
  input.db.transaction(() => {
    input.db.query(
      `INSERT INTO group_invitations(id, group_id, email, display_name, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(invitationId, input.groupId, email, displayName, input.actorId, now);
    input.db.query(
      `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
       VALUES (?, ?, ?, ?, 'placeholder', ?)`,
    ).run(input.groupId, placeholderUserId, displayName, email, now);
  })();

  if (input.smtpEnabled) {
    try {
      await input.sendMagicLink({ email, displayName, invitationId });
    } catch {
      input.db.transaction(() => {
        input.db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
          .run(input.groupId, placeholderUserId);
        input.db.query("DELETE FROM group_invitations WHERE id = ?").run(invitationId);
      })();
      throw new GroupInvitationError(
        "INVITE_EMAIL_FAILED",
        "Unable to send the invitation. Check the email address and try again.",
        503,
      );
    }
  }

  return {
    id: invitationId,
    email,
    status: "pending",
    delivery: input.smtpEnabled ? "email" : "share",
    joinUrl: input.webOrigin,
  };
}
