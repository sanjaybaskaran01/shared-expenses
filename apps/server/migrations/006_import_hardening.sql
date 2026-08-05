ALTER TABLE import_uploads ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0);
ALTER TABLE import_staged_operations ADD COLUMN dedupe_strategy TEXT
  CHECK (dedupe_strategy IS NULL OR dedupe_strategy IN ('provider_id', 'csv_candidate'));

CREATE TABLE IF NOT EXISTS import_undo_uploads (
  batch_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  expected_operation_count INTEGER NOT NULL CHECK (expected_operation_count > 0 AND expected_operation_count <= 100500),
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'activating')),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_staged_undo_operations (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  operation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, operation_id),
  FOREIGN KEY (batch_id) REFERENCES import_undo_uploads(batch_id) ON DELETE CASCADE
);
