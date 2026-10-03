-- Hosted provisioning and password resets for the programs (StitchBench docs/plans/hub-accounts-billing-design.md
-- sections 4.3.4 and 4.4, package hosted-provisioning).
--
-- A reset from the hub account to a Windows install: the program says at each claim whether its owner allows it
-- (reset_opt_in, stored on the PC and only mirrored here, so the hub can't switch it on). The account's owner asks on
-- /account/shops; the hub signs a grant (HUB_LICENSE_KEY) for that company, that install and the account's email, good
-- for an hour and once; the program fetches it at its sync, shows it only in its own window, and says what was answered.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reset_opt_in boolean NOT NULL DEFAULT false;

CREATE TABLE reset_grants (
  id         text PRIMARY KEY,
  shop_id    text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  account_id text REFERENCES accounts (id) ON DELETE SET NULL,
  email      text NOT NULL,                 -- the owner login it is for (the account's email, decision 11)
  nonce      text NOT NULL UNIQUE,          -- what the program keeps (hashed) once it has answered: one use
  grant_text text NOT NULL,                 -- SBG1.<payload>.<signature>; public, useless without the PC's window
  expires_at timestamptz NOT NULL,
  fetched_at timestamptz,                   -- the program last fetched it
  used_at    timestamptz,                   -- answered, or replaced by a newer request, or withdrawn with the opt-in
  result     text,                          -- allowed | refused | replaced | withdrawn
  why        text,                          -- the program's reason for a refusal it made itself (no-owner)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reset_grants_shop ON reset_grants (shop_id, created_at DESC);

-- "Start a hosted StitchShop / StitchBench": each request an account made to a hosted service (POST
-- /api/platform/companies there, with PLATFORM_API_TOKEN), what came of it, and the hub shop it was tied to. One
-- request per account per 10 minutes. The owner's set-password link is shown once and never stored.
CREATE TABLE hosted_starts (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  program    text NOT NULL,                 -- StitchShop | StitchBench
  shop_name  text NOT NULL,
  kind       text NOT NULL,
  shop_ref   text,                          -- the company's id on the hosted service, once made
  install_id text REFERENCES installs (id) ON DELETE SET NULL,
  shop_id    text REFERENCES shops (id) ON DELETE SET NULL,
  error      text,                          -- why it failed, in the hosted service's words
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosted_starts_account ON hosted_starts (account_id, created_at DESC);
