CREATE TABLE IF NOT EXISTS invitation_participant_aliases (
  group_id TEXT NOT NULL,
  placeholder_user_id TEXT NOT NULL,
  claimed_user_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, placeholder_user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (invitation_id) REFERENCES group_invitations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS invitation_participant_aliases_claimed_idx
  ON invitation_participant_aliases(claimed_user_id, group_id);
