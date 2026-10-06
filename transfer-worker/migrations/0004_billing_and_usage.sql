-- Short-lived reservations prevent concurrent uploads exceeding an inbox limit.
CREATE TABLE image_usage (
  transfer_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES devices(id),
  receiver_id TEXT NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'sent')),
  reserved_until INTEGER NOT NULL
);
CREATE INDEX image_usage_receiver ON image_usage(receiver_id, status, reserved_until);

CREATE TABLE billing_checkouts (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES devices(id),
  recovery_hash TEXT NOT NULL UNIQUE,
  session_id TEXT,
  checkout_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX billing_checkouts_sender ON billing_checkouts(sender_id, created_at);
-- One unresolved checkout per installation prevents duplicate subscriptions.
CREATE TABLE billing_checkout_locks (
  sender_id TEXT PRIMARY KEY REFERENCES devices(id),
  checkout_id TEXT NOT NULL UNIQUE REFERENCES billing_checkouts(id)
);

CREATE TABLE billing_subscriptions (
  id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL UNIQUE REFERENCES billing_checkouts(id),
  sender_id TEXT NOT NULL REFERENCES devices(id),
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_until INTEGER NOT NULL,
  event_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX billing_subscriptions_sender ON billing_subscriptions(sender_id);
CREATE TABLE billing_events (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
