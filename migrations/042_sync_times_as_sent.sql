-- A signed message (order.placed) is signed over created_at and expires_at exactly as the sender wrote them, so the hub delivers
-- them byte for byte. created_at and expires_at stay the hub's own (expires_at is the clamped expiry the sweep uses); these keep
-- the sender's text. expires_at_sent is NULL when the sender sent no expiry. Both are NULL for messages stored before this
-- migration and for the types that aren't signed: those are delivered from the timestamps, as before.
ALTER TABLE sync_messages ADD COLUMN created_at_sent text;
ALTER TABLE sync_messages ADD COLUMN expires_at_sent text;
