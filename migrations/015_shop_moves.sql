-- A company moving from one install to another (StitchBench docs/plans/company-move-design.md section 5, package
-- move-hub). The program the company leaves asks for a move token when it makes the move file (POST
-- /v1/shops/:ref/move-token); the token goes in the file, and the install it moves to redeems it (POST /v1/shops/move).
-- The hub then rewrites install_id on every row of that company (shop_ref) in one transaction, so partner links,
-- listings, orders, ratings, notes, revisions and parts usage follow it. Only the token's hash is kept; it works once,
-- for 14 days, and a newer token for the same shop cancels the older one. A row with used_at set is the record of a
-- move: the old install's next claim or standing for that shop answers 410 { moved, to, at } from it. by_admin: the hub
-- admin's "Move this shop" by hand (no token).
CREATE TABLE shop_moves (
  id              text PRIMARY KEY,
  shop_id         text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  shop_ref        text NOT NULL,                 -- the company's id (the same on both installs)
  token_hash      text UNIQUE,                   -- sha256 of the token; null for a move by hand
  from_install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  to_install_id   text REFERENCES installs (id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,                   -- redeemed: the move happened
  cancelled_at    timestamptz,                   -- replaced by a newer token, or the owner cancelled the move
  by_admin        boolean NOT NULL DEFAULT false,
  moved           jsonb,                         -- rows rewritten, per table, for the admin page
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_moves_shop ON shop_moves (shop_id, created_at DESC);
-- The old install asking about a company that left it.
CREATE INDEX shop_moves_from ON shop_moves (from_install_id, shop_ref, used_at DESC) WHERE used_at IS NOT NULL;

-- A company's rows on an install, found by (install_id, shop_ref) when it moves: the indexes the rewrite uses that
-- migration 013 didn't add.
CREATE INDEX IF NOT EXISTS partner_links_repair_shop ON partner_links (repair_install_id, repair_shop_ref);
CREATE INDEX IF NOT EXISTS partner_links_retail_shop ON partner_links (retail_install_id, retail_shop_ref);
CREATE INDEX IF NOT EXISTS order_ratings_rater_shop ON order_ratings (rater_install_id, rater_shop_ref);
CREATE INDEX IF NOT EXISTS partner_invites_shop ON partner_invites (install_id, shop_ref) WHERE used_at IS NULL;
