-- Godmode Partners: clippers who post about Godmode and earn a share of what the customers they bring pay
-- (src/config/partners.ts, src/lib/partners.ts). Money is in EUR cents, timestamps are epoch milliseconds.
CREATE TABLE partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  country TEXT,
  links TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  rate_bps INTEGER NOT NULL DEFAULT 2000,
  email_verified_at INTEGER,
  payout_method TEXT,
  paypal_email TEXT,
  stripe_account_id TEXT,
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  promotion_code_id TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX partners_promotion_code ON partners (promotion_code_id);

-- One row per subscription a partner brought. status: active | rejected (self-referral) | canceled.
CREATE TABLE partner_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  session_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  customer_id TEXT,
  email TEXT,
  source TEXT NOT NULL,
  plan TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_paid_at INTEGER,
  created_at INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX partner_referrals_partner ON partner_referrals (partner_id, status);

-- kind: 'sale' for an invoice's commission; 'refund:<cents refunded so far>' and 'dispute' for reversals (negative).
-- status: pending (refund window) | available | paid | reversed.
CREATE TABLE partner_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  referral_id INTEGER,
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  charge_id TEXT,
  base_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  payout_id INTEGER,
  created_at INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, kind)
);
CREATE INDEX partner_commissions_partner ON partner_commissions (partner_id, status);
CREATE INDEX partner_commissions_charge ON partner_commissions (charge_id);
CREATE INDEX partner_commissions_payout ON partner_commissions (payout_id);

-- status: proposed | approved | paid | failed | canceled. The hourly cron pays out every approved Stripe payout.
CREATE TABLE partner_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  stripe_transfer_id TEXT,
  reference TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,
  paid_at INTEGER,
  error TEXT,
  livemode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX partner_payouts_status ON partner_payouts (status);
CREATE INDEX partner_payouts_partner ON partner_payouts (partner_id);

-- status: submitted | approved | rejected.
CREATE TABLE partner_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  url TEXT NOT NULL UNIQUE,
  platform TEXT,
  posted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'submitted',
  views INTEGER,
  likes INTEGER,
  views_checked_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX partner_clips_partner ON partner_clips (partner_id);

-- The partner code a visitor came through (gm_ref cookie): on ref_click, download and checkout_start events.
ALTER TABLE events ADD COLUMN ref TEXT;
CREATE INDEX events_ref ON events (ref, type, day) WHERE ref IS NOT NULL;

ALTER TABLE orders ADD COLUMN partner_id INTEGER;
