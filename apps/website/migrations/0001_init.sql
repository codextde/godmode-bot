-- First-party, cookieless analytics. `visitor` is a salted daily hash of IP + user agent
-- (the salt rotates every day, so a visitor can't be followed across days); no raw IPs are stored.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  label TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  has_click_id INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  device TEXT
);
CREATE INDEX events_day_type ON events (day, type);
CREATE INDEX events_visitor ON events (visitor);

-- One row per completed Checkout Session. The license key is generated when the session is
-- created and becomes active once Stripe confirms the payment.
CREATE TABLE orders (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  plan TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_total INTEGER,
  currency TEXT,
  email TEXT,
  name TEXT,
  country TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  payment_intent_id TEXT,
  license_key TEXT UNIQUE,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  twclid TEXT,
  referrer TEXT,
  landing TEXT,
  livemode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_subscription ON orders (subscription_id);
CREATE INDEX orders_payment_intent ON orders (payment_intent_id);
CREATE INDEX orders_paid_at ON orders (paid_at);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT NOT NULL UNIQUE,
  source TEXT,
  utm_source TEXT,
  utm_campaign TEXT
);

-- Stripe retries webhooks; remember what was processed.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL
);
