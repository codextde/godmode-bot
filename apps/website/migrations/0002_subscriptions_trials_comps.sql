-- Subscription details mirrored from Stripe (trial, renewal, cancellation) and free ("comp") licenses.
-- Timestamps are epoch milliseconds, like the rest of the table.
ALTER TABLE orders ADD COLUMN sub_status TEXT;
ALTER TABLE orders ADD COLUMN trial_end INTEGER;
ALTER TABLE orders ADD COLUMN period_end INTEGER;
ALTER TABLE orders ADD COLUMN cancel_at_period_end INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN comp INTEGER DEFAULT 0;
CREATE INDEX orders_plan_status ON orders (plan, status);
