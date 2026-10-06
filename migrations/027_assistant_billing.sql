-- Selling the Assistant (StitchBench docs/plans/ai-assistant-scope.md): its own Stripe subscription per shop, apart from the
-- base plan's (a shop can have either, both or neither, and the base plan's standing logic never reads this table), and the
-- one-time top-ups (300 more calls this month) credited once per Checkout session.

CREATE TABLE assistant_subscriptions (
  shop_id                text PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  stripe_customer_id     text,
  stripe_created         bigint,                  -- Stripe's created (unix seconds): a late event for an older subscription is ignored
  plan                   text,                    -- m | y, from the price
  status                 text NOT NULL,           -- Stripe's: incomplete | trialing | active | past_due | canceled | unpaid | incomplete_expired | paused
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  price_id               text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_subscriptions_customer ON assistant_subscriptions (stripe_customer_id);

-- One row per paid top-up Checkout session: the primary key is what makes a replayed or retried event credit once.
CREATE TABLE assistant_topups (
  stripe_session_id text PRIMARY KEY,
  shop_id           text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  calls             integer NOT NULL,
  month             text NOT NULL,                -- the company's month (its zone) the calls were added to
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_topups_shop ON assistant_topups (shop_id, created_at);
