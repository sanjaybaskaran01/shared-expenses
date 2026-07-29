CREATE TABLE IF NOT EXISTS contact_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  inviter_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'accepted', 'revoked')),
  reserved_email_hash TEXT,
  reservation_expires_at TEXT,
  claimed_by_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS contact_invitations_inviter_idx
  ON contact_invitations(inviter_user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS contact_invitations_reservation_idx
  ON contact_invitations(reserved_email_hash, status, reservation_expires_at);

CREATE TABLE IF NOT EXISTS contacts (
  owner_user_id TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, contact_user_id),
  CHECK (owner_user_id <> contact_user_id),
  FOREIGN KEY (invitation_id) REFERENCES contact_invitations(id)
);

CREATE INDEX IF NOT EXISTS contacts_contact_idx ON contacts(contact_user_id);
