-- Historical records were all created in sandbox before live was enabled.
ALTER TABLE billing_checkouts ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'test';
ALTER TABLE billing_checkouts ADD COLUMN product_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'test';
ALTER TABLE billing_subscriptions ADD COLUMN product_id TEXT;
CREATE INDEX billing_subscriptions_environment ON billing_subscriptions(sender_id, billing_mode, product_id, event_at);
