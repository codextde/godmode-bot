-- Requests for the done-for-you setup service (/setup). ts is epoch milliseconds.
CREATE TABLE setup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  team_size TEXT,
  message TEXT,
  locale TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  notified_at INTEGER
);
CREATE INDEX setup_requests_ts ON setup_requests (ts);
