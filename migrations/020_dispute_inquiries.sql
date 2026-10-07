-- Card-company inquiries (a dispute whose status starts with warning_: a retrieval request, no money taken yet) don't
-- lock a paying shop: the hub records the inquiry on the subscription, shows it to the admin and logs it. Only a real
-- chargeback (needs_response, under_review), from the start or an inquiry that escalates into one, lapses the shop.
-- warning_closed clears the inquiry.

-- When the open inquiry was first seen, and which dispute it is (matched on charge.dispute.updated and .closed).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS inquiry_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS inquiry_dispute_id text;
