-- The StitchFoundry inbox (docs/plan.md, "StitchFoundry inbox"): a designer sends an embroidery file (and what StitchFoundry knows
-- about it) from StitchFoundry to the shop that will sew it, through the Foundry Account the two share. The file waits here
-- (in the same bucket as the off-site backups, under inbox/<account>/<item>) until a shop of that account takes it into an order
-- or it has waited INBOX_DAYS. The hub keeps the row; the bytes go straight between the program and the bucket.
CREATE TABLE inbox_items (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,   -- the StitchHub account whose foundry_id sent it
  to_shop_id       text REFERENCES shops (id) ON DELETE SET NULL,              -- null = any shop of the account
  file_name        text NOT NULL,
  size             bigint NOT NULL CHECK (size > 0),
  sha256           text NOT NULL,
  meta             jsonb NOT NULL DEFAULT '{}',                                -- what StitchFoundry said about it (src/inbox.mjs cleanMeta)
  created_at       timestamptz NOT NULL DEFAULT now(),                         -- the upload address was handed out
  confirmed_at     timestamptz,                                                -- the sender said it was uploaded and the hub saw the object, at its size
  expires_at       timestamptz NOT NULL,
  taken_at         timestamptz,                                                -- a shop took it into an order
  taken_by_shop_id text REFERENCES shops (id) ON DELETE SET NULL,
  deleted_at       timestamptz                                                 -- the object is gone from the bucket
);
CREATE INDEX inbox_items_live ON inbox_items (account_id) WHERE deleted_at IS NULL;
