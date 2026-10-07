-- The real-partnership rule for a partnered quilt shop's free plan (owner decided 5 Oct 2026): the waiver holds while the
-- repair partner is a paying subscriber AND a repair passed between the two shops in the last calendar quarter or this one.
-- When either stops, a 30-day grace runs. This row is that grace: written the first day the hub finds the rule broken for
-- a link, deleted the day the rule holds again (so activity or a subscription returning inside the grace keeps the waiver).
-- Nothing else is stored: the partner's standing and the repairs are read from what the hub already holds (subscriptions,
-- partner_messages).
CREATE TABLE IF NOT EXISTS waiver_grace (
  link_id text PRIMARY KEY REFERENCES partner_links (id) ON DELETE CASCADE,
  since   date NOT NULL,
  reason  text NOT NULL, -- partner | activity | both
  created_at timestamptz NOT NULL DEFAULT now()
);
