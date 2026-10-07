-- Selling the trade add-ons on the hub (src/addons.mjs; StitchBench pricing-review-2026-10.md): Vac Shop $10, Small
-- Appliance Repair $5, Scheduling $15, Marketing $10, Maker Shop $10 a month (yearly ten times monthly), or all five for
-- $30 ($300 a year). Each add-on (or the bundle) is its own Stripe subscription per shop, like the Assistant's: its own
-- standing, its own key for its module ids, its own refunds and chargebacks. Extra stores ($25 a month, $250 a year each)
-- are a quantity on the shop's base subscription; the program reports its store count at every claim. A comp can cover
-- the add-ons too. A top-up refunded before its Checkout credit lands is held until the credit comes. Additive only.

CREATE TABLE IF NOT EXISTS addon_subscriptions (
  shop_id                text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  product                text NOT NULL,             -- vac | appliance | scheduling | marketing | maker | bundle
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_customer_id     text,
  stripe_created         bigint,                    -- a late event for an older subscription is ignored
  plan                   text,                      -- m | y
  status                 text NOT NULL,             -- Stripe's
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  price_id               text,
  unpaid_since           timestamptz,               -- its period was refunded or charged back: no key until paid again
  unpaid_charge_id       text,
  chargeback_dispute_ids text[] NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product)
);
CREATE INDEX IF NOT EXISTS addon_subscriptions_customer ON addon_subscriptions (stripe_customer_id);

-- The admin's comp covers the five add-ons too ("everything"); the Assistant keeps its own comp.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS comp_addons boolean NOT NULL DEFAULT false;
-- The stores the program says the company has (1 until a program with more stores reports it).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stores integer NOT NULL DEFAULT 1;
-- The extra stores billed on the base subscription (the quantity of its store item) and that item's id.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS store_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS store_item_id text;

-- A top-up's charge refunded (or charged back) before its checkout.session.completed was handled: the share to take back
-- once the credit lands (src/assistant-billing.mjs creditTopupSession).
CREATE TABLE IF NOT EXISTS assistant_topup_pending (
  stripe_payment_intent text PRIMARY KEY,
  share                 numeric NOT NULL,
  charge_id             text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
