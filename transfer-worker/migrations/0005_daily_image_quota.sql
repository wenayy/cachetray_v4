ALTER TABLE image_usage ADD COLUMN sent_at INTEGER;
CREATE INDEX image_usage_sender_sent ON image_usage(sender_id, status, sent_at);
-- Preserve earlier successful sends, including images already deleted from the inbox.
UPDATE image_usage SET sent_at = COALESCE(
  (SELECT COALESCE(ready_at, created_at) FROM transfers WHERE id = image_usage.transfer_id),
  reserved_until - 600000
) WHERE status = 'sent';
