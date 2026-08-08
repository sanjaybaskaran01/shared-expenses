CREATE TABLE IF NOT EXISTS import_participant_aliases (
  group_id TEXT NOT NULL,
  placeholder_user_id TEXT NOT NULL,
  claimed_user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, placeholder_user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES imported_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS import_participant_aliases_claimed_idx
  ON import_participant_aliases(claimed_user_id, group_id);

-- One-time upgrade path for claims completed before this materialized scope
-- existed. Accepted operations remain immutable, so they are the authority for
-- the placeholder's exact historical groups. Future claims insert rows inside
-- the claim transaction and never pay this scan cost.
INSERT OR IGNORE INTO import_participant_aliases(
  group_id,
  placeholder_user_id,
  claimed_user_id,
  identity_id,
  created_at
)
SELECT DISTINCT
  signed_history.group_id,
  identity.placeholder_user_id,
  identity.claimed_by_user_id,
  identity.id,
  COALESCE(identity.claimed_at, identity.created_at)
FROM imported_identities identity
JOIN operations signed_history ON signed_history.status = 'accepted'
JOIN group_members claimed_member
  ON claimed_member.group_id = signed_history.group_id
 AND claimed_member.user_id = identity.claimed_by_user_id
 AND claimed_member.status = 'active'
WHERE identity.status = 'claimed'
  AND identity.claimed_by_user_id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM json_each(signed_history.payload_json, '$.payers') payer
      WHERE json_extract(payer.value, '$.participantId') = identity.placeholder_user_id
    )
    OR EXISTS (
      SELECT 1 FROM json_each(signed_history.payload_json, '$.allocations') allocation
      WHERE json_extract(allocation.value, '$.participantId') = identity.placeholder_user_id
    )
    OR EXISTS (
      SELECT 1 FROM json_each(signed_history.payload_json, '$.effects') effect
      WHERE json_extract(effect.value, '$.participantId') = identity.placeholder_user_id
    )
    OR json_extract(signed_history.payload_json, '$.payerId') = identity.placeholder_user_id
    OR json_extract(signed_history.payload_json, '$.recipientId') = identity.placeholder_user_id
  );
