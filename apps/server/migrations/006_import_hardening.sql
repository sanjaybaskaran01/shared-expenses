ALTER TABLE import_uploads ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0);
ALTER TABLE import_staged_operations ADD COLUMN dedupe_strategy TEXT
  CHECK (dedupe_strategy IS NULL OR dedupe_strategy IN ('provider_id', 'csv_candidate'));

-- Rebuild the mapping table so the same proven person mapping can appear in
-- more than one owner-scoped import batch. The batch-scoped primary key still
-- prevents duplicates inside one migration.
CREATE TABLE import_external_mappings_v2 (
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

INSERT INTO import_external_mappings_v2(
  batch_id, imported_by, provider, external_type, external_id, external_id_hash,
  semantic_id_hash, source_metadata_json, local_id, operation_id
)
SELECT batch_id, imported_by, provider, external_type, external_id, external_id_hash,
       semantic_id_hash, source_metadata_json, local_id, operation_id
FROM import_external_mappings;

DROP TABLE import_external_mappings;
ALTER TABLE import_external_mappings_v2 RENAME TO import_external_mappings;

CREATE INDEX import_external_mappings_owner_hash_idx
  ON import_external_mappings(imported_by, provider, external_type, external_id_hash);

CREATE INDEX import_external_mappings_owner_semantic_idx
  ON import_external_mappings(imported_by, provider, external_type, semantic_id_hash);

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
