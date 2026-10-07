-- Review fixes for the release (additive only: new tables, new nullable or defaulted columns, indexes; safe on a live
-- database).

-- An Assistant key from the owner's own signer (ASSISTANT_PUBLIC_KEYS, not in license_issues) belongs to the first
-- company that used it: the same key offered by another install or company is refused (src/assistant.mjs).
CREATE TABLE IF NOT EXISTS assistant_key_binds (
  kid        text NOT NULL,
  key_id     text NOT NULL,
  install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kid, key_id)
);

-- The hub-wide daily ceiling on free plate reads counts these.
CREATE INDEX IF NOT EXISTS assistant_calls_free ON assistant_calls (created_at) WHERE free;

-- A refund or chargeback of the Assistant's own subscription: the period is taken back (like subscriptions.unpaid_since).
ALTER TABLE assistant_subscriptions ADD COLUMN IF NOT EXISTS unpaid_since timestamptz;
ALTER TABLE assistant_subscriptions ADD COLUMN IF NOT EXISTS unpaid_charge_id text;

-- A refunded or disputed top-up takes its calls back: found by its payment, and how many were taken back so far.
ALTER TABLE assistant_topups ADD COLUMN IF NOT EXISTS stripe_payment_intent text;
ALTER TABLE assistant_topups ADD COLUMN IF NOT EXISTS calls_taken integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS assistant_topups_payment ON assistant_topups (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

-- Upload addresses handed out and never confirmed are swept (src/backups.mjs).
CREATE INDEX IF NOT EXISTS backup_objects_unconfirmed ON backup_objects (created_at) WHERE confirmed_at IS NULL AND deleted_at IS NULL;

-- One strike per notice per uploader (src/takedown.mjs).
CREATE INDEX IF NOT EXISTS strikes_notice_account ON strikes (notice_id, account_id);
