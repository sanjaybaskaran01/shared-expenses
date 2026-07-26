CREATE TABLE IF NOT EXISTS group_invitations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS group_invitations_pending_email_idx
  ON group_invitations(group_id, lower(email)) WHERE status = 'pending';
