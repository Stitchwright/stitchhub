-- Disputes per subscription, as lists (review of 3 Oct 2026): a subscription can have more than one open card-company
-- inquiry (one per charge), and the hub must know which disputes it has already acted on as chargebacks, so a late or
-- repeated event (evidence submitted, a won dispute's update) never lapses the shop a second time.

-- The open inquiries (status warning_*), replacing the single inquiry_dispute_id of 020.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS inquiry_dispute_ids text[] NOT NULL DEFAULT '{}';
-- The disputes the hub lapsed the shop for (charge.dispute.created as a chargeback, an inquiry escalated, a lost one).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS chargeback_dispute_ids text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'inquiry_dispute_id') THEN
    UPDATE subscriptions SET inquiry_dispute_ids = ARRAY[inquiry_dispute_id] WHERE inquiry_dispute_id IS NOT NULL;
    ALTER TABLE subscriptions DROP COLUMN inquiry_dispute_id;
  END IF;
END $$;
