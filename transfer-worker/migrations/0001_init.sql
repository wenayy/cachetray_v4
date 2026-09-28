CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pair_code_hash TEXT,
  pair_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE pairings (
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sender_id, receiver_id),
  FOREIGN KEY (sender_id) REFERENCES devices(id),
  FOREIGN KEY (receiver_id) REFERENCES devices(id)
);

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  sender_device_id TEXT NOT NULL,
  receiver_device_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (sender_device_id) REFERENCES devices(id),
  FOREIGN KEY (receiver_device_id) REFERENCES devices(id)
);

CREATE INDEX transfers_inbox ON transfers(receiver_device_id, status, expires_at, created_at);
CREATE INDEX transfers_expiry ON transfers(expires_at);
