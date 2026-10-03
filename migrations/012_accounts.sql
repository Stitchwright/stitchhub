-- StitchHub accounts (docs/plans/hub-accounts-billing-design.md in the StitchBench repo, package hub-accounts).
-- A shop owner gets an account on the hub: an email address and a password, verified by email. The account owns one or
-- more hub shops. The install key stays what the program uses; the account is what a person uses on the hub's pages.
-- Billing (subscriptions, Stripe events, issued keys, reset grants) comes with later packages and its own migration.

CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  email              text NOT NULL,          -- kept lower-case
  password_hash      text,                   -- scrypt; null until the owner has set one (an account started from the program)
  verified_at        timestamptz,            -- the owner followed a link we mailed
  terms_version      text,                   -- which terms the owner accepted, and when
  terms_at           timestamptz,
  stripe_customer_id text,                   -- filled by the billing package
  disabled           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at    timestamptz
);
CREATE UNIQUE INDEX accounts_email ON accounts (lower(email));

-- One shop as the hub knows it: a company on one install (a hosted StitchBench holds several; a Windows install one).
-- It belongs to at most one account. created_at is when it first claimed itself, which starts its trial.
CREATE TABLE shops (
  id           text PRIMARY KEY,
  install_id   text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref     text NOT NULL,                -- the company's id on that install
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'repair', -- repair | retail | both
  program      text,                         -- StitchBench | StitchShop, as the install reported it
  version      text,
  account_id   text REFERENCES accounts (id) ON DELETE SET NULL,
  comp_until   timestamptz,                  -- the hub admin's "free until" (2099-12-31 = for good)
  comp_note    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (install_id, shop_ref)
);
CREATE INDEX shops_account ON shops (account_id) WHERE account_id IS NOT NULL;

-- Links we mail and codes the program shows, hashed like partner codes. verify: an account made on the hub confirms
-- its address. reset: the owner sets a password (an account started from the program, or a forgotten password).
-- link: a code the program shows for one of its shops, typed in under "Connect a shop" by a signed-in owner.
CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL,                  -- verify | reset | link
  account_id text REFERENCES accounts (id) ON DELETE CASCADE,
  shop_id    text REFERENCES shops (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'link' AND shop_id IS NOT NULL) OR (kind <> 'link' AND account_id IS NOT NULL))
);
CREATE INDEX account_tokens_account ON account_tokens (account_id) WHERE account_id IS NOT NULL;

-- A signed-in browser: the cookie carries a random id, only its hash is kept here.
CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);
