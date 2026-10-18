-- Activation: the app checks its key at start and every 6 hours (user agent GodmodeBot/<version>).
ALTER TABLE orders ADD COLUMN first_seen_at INTEGER;
ALTER TABLE orders ADD COLUMN last_seen_at INTEGER;
ALTER TABLE orders ADD COLUMN app_version TEXT;

-- Lifecycle emails, at most one of each kind per order.
CREATE TABLE emails (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  message_id TEXT,
  PRIMARY KEY (session_id, kind)
);
