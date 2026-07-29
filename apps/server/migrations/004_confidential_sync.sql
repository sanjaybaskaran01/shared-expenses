ALTER TABLE devices ADD COLUMN encryption_public_key_jwk TEXT;

CREATE TABLE IF NOT EXISTS group_key_envelopes (
  group_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
  recipient_device_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, key_epoch, recipient_device_id),
  FOREIGN KEY (recipient_device_id) REFERENCES devices(id),
  FOREIGN KEY (sender_device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS confidential_operations (
  server_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
  client_timestamp TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS confidential_operations_group_sequence_idx
  ON confidential_operations(group_id, server_sequence);
