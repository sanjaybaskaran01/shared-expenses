ALTER TABLE expenses ADD COLUMN import_batch_id TEXT;
ALTER TABLE expenses ADD COLUMN source_provider TEXT;
ALTER TABLE expenses ADD COLUMN source_record_id TEXT;
ALTER TABLE expenses ADD COLUMN source_metadata_json TEXT;
ALTER TABLE expenses ADD COLUMN imported_by TEXT;
ALTER TABLE expenses ADD COLUMN imported_at TEXT;
ALTER TABLE expenses ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));

ALTER TABLE payments ADD COLUMN import_batch_id TEXT;
ALTER TABLE payments ADD COLUMN source_provider TEXT;
ALTER TABLE payments ADD COLUMN source_record_id TEXT;
ALTER TABLE payments ADD COLUMN source_metadata_json TEXT;
ALTER TABLE payments ADD COLUMN imported_by TEXT;
ALTER TABLE payments ADD COLUMN imported_at TEXT;
ALTER TABLE payments ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  imported_by TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('splitwise')),
  mode TEXT NOT NULL CHECK (mode IN ('current', 'history', 'balances', 'custom')),
  source_account_key TEXT,
  fingerprint TEXT NOT NULL,
  selected_source_groups_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  reconciliation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('activating', 'completed', 'undone', 'cancelled', 'failed')),
  rollback_status TEXT NOT NULL CHECK (rollback_status IN ('available', 'completed', 'not_available')),
  started_at TEXT NOT NULL,
  reviewed_at TEXT,
  completed_at TEXT,
  undone_at TEXT,
  cancelled_at TEXT,
  source_data_deleted_at TEXT,
  UNIQUE(imported_by, provider, fingerprint)
);

CREATE INDEX IF NOT EXISTS import_batches_owner_idx
  ON import_batches(imported_by, started_at DESC);

CREATE TABLE IF NOT EXISTS import_sources (
  batch_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY (batch_id, source_hash),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id)
);

CREATE TABLE IF NOT EXISTS imported_identities (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email_hash TEXT,
  email_trust TEXT NOT NULL CHECK (email_trust IN ('provider', 'exported', 'untrusted', 'none')),
  placeholder_user_id TEXT NOT NULL,
  claimed_by_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('unclaimed', 'reserved', 'awaiting_owner', 'claimed', 'revoked')),
  claim_token_hash TEXT UNIQUE,
  claim_expires_at TEXT,
  reserved_email_hash TEXT,
  reservation_requested_at TEXT,
  reservation_expires_at TEXT,
  reserved_by_user_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  revoked_at TEXT,
  UNIQUE(batch_id, external_user_id),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id)
);

CREATE INDEX IF NOT EXISTS imported_identities_claim_idx
  ON imported_identities(claim_token_hash, status, claim_expires_at);

CREATE TABLE IF NOT EXISTS import_external_mappings (
  batch_id TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_type TEXT NOT NULL CHECK (external_type IN ('group', 'person', 'record')),
  external_id TEXT NOT NULL,
  external_id_hash TEXT NOT NULL,
  semantic_id_hash TEXT,
  source_metadata_json TEXT,
  local_id TEXT NOT NULL,
  operation_id TEXT,
  PRIMARY KEY (batch_id, external_type, external_id),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id)
);

CREATE INDEX IF NOT EXISTS import_external_mappings_owner_hash_idx
  ON import_external_mappings(imported_by, provider, external_type, external_id_hash);

CREATE INDEX IF NOT EXISTS import_external_mappings_owner_semantic_idx
  ON import_external_mappings(imported_by, provider, external_type, semantic_id_hash);

CREATE TABLE IF NOT EXISTS imported_transactions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('balance_effect', 'opening_balance')),
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  notes TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_metadata_json TEXT,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'voided')),
  version INTEGER NOT NULL,
  UNIQUE(batch_id, source_record_id),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id),
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE INDEX IF NOT EXISTS imported_transactions_group_date_idx
  ON imported_transactions(group_id, transaction_date DESC);

CREATE TABLE IF NOT EXISTS imported_transaction_effects (
  transaction_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, participant_id),
  FOREIGN KEY (transaction_id) REFERENCES imported_transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_batch_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'activated', 'undone', 'cancelled', 'source_data_deleted',
    'claim_link_created', 'claim_auth_reserved', 'claim_awaiting_owner',
    'claim_rejected', 'identity_claimed'
  )),
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id)
);

CREATE TABLE IF NOT EXISTS import_claim_requests (
  token_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  claimant_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (identity_id) REFERENCES imported_identities(id)
);

CREATE INDEX IF NOT EXISTS import_claim_requests_identity_idx
  ON import_claim_requests(identity_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS splitwise_oauth_sessions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  encrypted_access_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'normalized', 'cancelled', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS splitwise_oauth_sessions_actor_idx
  ON splitwise_oauth_sessions(actor_id, status, expires_at);

CREATE TABLE IF NOT EXISTS import_uploads (
  batch_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  expected_operation_count INTEGER NOT NULL CHECK (expected_operation_count > 0 AND expected_operation_count <= 100500),
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'activating', 'activated', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(actor_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS import_staged_operations (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  operation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  group_id TEXT NOT NULL,
  external_type TEXT NOT NULL CHECK (external_type IN ('group', 'record')),
  external_id TEXT NOT NULL,
  semantic_id TEXT,
  source_metadata_json TEXT,
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, operation_id),
  FOREIGN KEY (batch_id) REFERENCES import_uploads(batch_id) ON DELETE CASCADE
);
