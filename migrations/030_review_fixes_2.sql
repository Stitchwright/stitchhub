-- Review fixes, second round (additive only: a new column with a constant default; safe on a live database).

-- The Assistant's own subscription: the chargebacks already acted on (like subscriptions.chargeback_dispute_ids), so a
-- later event for the same dispute (evidence, review, lost) doesn't take back a period a later payment made good
-- (src/billing.mjs disputeEvent).
ALTER TABLE assistant_subscriptions ADD COLUMN IF NOT EXISTS chargeback_dispute_ids text[] NOT NULL DEFAULT '{}';
