-- Two plans (StitchBench docs/plans/pricing-recommendation.md sections 12 and 13, decided 3 Oct 2026): Solo, up to two
-- people signed in, and Shop, everyone; the same features. Several Stripe prices count as one plan (price rises add new
-- prices, the old ones keep working): the hub maps each configured price id to a plan, an interval and founding or not
-- (src/billing.mjs priceBook). Founding shops: the first 25 accounts the admin marks get the founding prices, for as long
-- as their subscription runs without a gap of more than 60 days.

-- The plan Stripe's price says, written with the rest of the subscription (plan stays the interval letter, m | y).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tier text;                              -- solo | shop (shop for a price the hub doesn't know)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS founding boolean NOT NULL DEFAULT false; -- on a founding price
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_id text;                          -- the Stripe price it is on

-- Founding: marked by the admin (25 at most), the start of a gap (the account's last subscription stopped running; cleared
-- when one runs again), and when the mark went because the gap passed 60 days.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS founding_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS founding_gap_since timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS founding_lost_at timestamptz;

-- The plan each key carries (payload l, and fs for a founding price): the program limits logins on a Solo key only.
ALTER TABLE license_issues ADD COLUMN IF NOT EXISTS tier text;
ALTER TABLE license_issues ADD COLUMN IF NOT EXISTS founding boolean NOT NULL DEFAULT false;
