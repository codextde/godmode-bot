-- Free downloaders who leave their email in the app: reminders before and after their free days end.
-- free_ends_at and unsubscribed_at are epoch milliseconds; the emails table keys these leads as `lead:<id>`.
ALTER TABLE leads ADD COLUMN free_ends_at INTEGER;
ALTER TABLE leads ADD COLUMN locale TEXT;
ALTER TABLE leads ADD COLUMN app_version TEXT;
ALTER TABLE leads ADD COLUMN unsubscribed_at INTEGER;
CREATE INDEX leads_free_ends_at ON leads (free_ends_at);
