-- StitchHub billing (docs/plans/hub-accounts-billing-design.md in the StitchBench repo, package hub-billing).
-- $25 a month or $250 a year per shop through Stripe Billing on the hub: Checkout starts a subscription, the Customer
-- Portal changes it, webhooks tell the hub what happened. The program learns its standing from a key the hub signs for
-- the module "base" (HUB_LICENSE_KEY); every key the hub issues is written down here, so a signing key can be retired
-- with an allow list, and a refunded period's keys can be named to the program for removal.

-- One subscription per shop, as Stripe last reported it. The hub re-reads the subscription from Stripe before writing a
-- row, so a forged webhook can't change anything.
CREATE TABLE subscriptions (
  shop_id                text PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  stripe_customer_id     text,
  plan                   text,                    -- m | y, from the price (null for a price the hub doesn't know)
  status                 text NOT NULL,           -- Stripe's: incomplete | trialing | active | past_due | canceled | unpaid | incomplete_expired | paused
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  unpaid_since           timestamptz,             -- a refund or a chargeback took the period's payment back: lapsed at once
  disputed_at            timestamptz,             -- a chargeback (charge.dispute.created): shown on the admin page
  mailed                 jsonb NOT NULL DEFAULT '{}', -- which dunning mails went for which period (sent once each)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_customer ON subscriptions (stripe_customer_id);

-- Every webhook event the hub has handled. A replay (Stripe retries, or someone re-sending a captured event) finds its
-- id here and does nothing. The row is written in the same transaction as the handling, so a failure is retried.
CREATE TABLE stripe_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Every key the hub signed: the key text (public once issued), who for, which plan and days. revoked_at: the program
-- is told to drop it (a refund, a chargeback, the admin's "Lapse now").
CREATE TABLE license_issues (
  key_id     text PRIMARY KEY,
  shop_id    text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  kid        text NOT NULL,                       -- which signing key (HUB_LICENSE_KID)
  plan       text NOT NULL,                       -- t trial | m monthly | y yearly | c comped | w waived
  modules    text[] NOT NULL,
  first_day  date NOT NULL,
  last_day   date NOT NULL,
  grace_days integer NOT NULL DEFAULT 14,
  key        text NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX license_issues_shop ON license_issues (shop_id, issued_at DESC);

-- The admin's "Lapse now": the shop's standing ends at this moment whatever else holds (a trial, a comp, a partner's
-- waiver). Cleared by a comp, by "Undo", or by a payment that comes in afterwards.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lapsed_at timestamptz;
