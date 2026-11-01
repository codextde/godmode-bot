-- Abandoned Godmode checkouts: what an expired Checkout Session left behind, for at most one recovery email per person.
-- `consent` is 'opt_in' only when the person agreed to it: Stripe's promotional consent checkbox (consent_source
-- 'stripe') or the "email me this checkout" form on /checkout/canceled ('site'). Timestamps are epoch milliseconds.
CREATE TABLE checkout_recovery (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expired_at INTEGER,
  plan TEXT,
  email TEXT,
  consent TEXT,
  consent_source TEXT,
  recovery_url TEXT,
  recovery_expires_at INTEGER,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  referrer TEXT,
  livemode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX checkout_recovery_expired ON checkout_recovery (expired_at);
CREATE INDEX checkout_recovery_email ON checkout_recovery (email);

-- Addresses that unsubscribed from Godmode's promotional emails.
CREATE TABLE unsubscribes (
  email TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
