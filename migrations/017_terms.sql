-- Terms of Service and Privacy Policy (StitchBench docs/plans/hub-accounts-billing-design.md 4.2, package terms-launch).
-- The pages are markdown files in legal/ (src/terms.mjs); the version in force is TERMS_VERSION, or the newest pair on
-- file. accounts.terms_version and terms_at keep the latest version an account accepted; this table keeps each time it
-- did: started from the program (its tick in Settings → Account), signed up on the hub, "We updated our terms" on
-- /account, and every Checkout (with the shop and the Stripe Checkout Session it was for). Rows go with the account.
CREATE TABLE terms_acceptances (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  version     text NOT NULL,                 -- 2026-11-15, or 2026-10-03-draft while the text is a draft
  via         text NOT NULL,                 -- program | signup | account | checkout | before-017
  shop_id     text REFERENCES shops (id) ON DELETE SET NULL, -- checkout: the shop being subscribed
  checkout_id text,                          -- checkout: the Stripe Checkout Session
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terms_acceptances_account ON terms_acceptances (account_id, created_at DESC);

-- What accounts accepted before this table existed, so each account's history starts with it.
INSERT INTO terms_acceptances (id, account_id, version, via, created_at)
SELECT substr(md5('terms:' || id), 1, 24), id, terms_version, 'before-017', coalesce(terms_at, created_at)
FROM accounts WHERE terms_version IS NOT NULL;
