CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL UNIQUE,
  encrypted_subscription TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (actor_id, device_id)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_actor_idx
  ON push_subscriptions(actor_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (actor_id, source_operation_id, kind)
);

CREATE INDEX IF NOT EXISTS notifications_actor_unread_idx
  ON notifications(actor_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (notification_id, subscription_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS push_deliveries_pending_idx
  ON push_deliveries(status, next_attempt_at, created_at);
