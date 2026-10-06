CREATE TABLE connect_sessions (
  id_hash TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_id TEXT,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES devices(id),
  FOREIGN KEY (receiver_id) REFERENCES devices(id)
);

CREATE INDEX connect_sessions_expiry ON connect_sessions(expires_at);

CREATE TABLE clip_snapshots (
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (sender_id, receiver_id),
  FOREIGN KEY (sender_id) REFERENCES devices(id),
  FOREIGN KEY (receiver_id) REFERENCES devices(id)
);

CREATE INDEX clip_snapshots_receiver ON clip_snapshots(receiver_id, expires_at);
CREATE INDEX clip_snapshots_expiry ON clip_snapshots(expires_at);
