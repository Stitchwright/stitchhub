-- Three billing edge cases (StitchBench docs/HANDOFF.md section 3 item 17, 3 Oct 2026).
--   * A full refund of a subscription's first payment, made while the shop's 30-day trial still runs, puts the shop back
--     on its trial until the trial's original end instead of lapsing it (refunded_in_trial).
--   * A chargeback the shop wins (charge.dispute.closed, status won) is undone: the hub restores the period only when this
--     charge is the one that took it back (unpaid_charge_id), so a separate refund still stands.
-- Subscribing inside the trial (Stripe's own trial on the subscription, ending when the hub's trial ends) needs no column:
-- the subscription's status is trialing and its period ends with the trial.

-- The charge whose refund or dispute made the period unpaid (set with unpaid_since, cleared with it).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS unpaid_charge_id text;
-- That refund was a full refund of the subscription's first payment while the shop's trial still ran: the shop is back on
-- its trial through the trial's original last day, then a trial that ended (meaningful only while unpaid_since is set).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS refunded_in_trial boolean NOT NULL DEFAULT false;
