-- Round 3 review fixes: marketplace, notes and parts usage per company, and a few cross-reference safeguards.

-- A hosted StitchBench holds several companies on one install. Each listing, order, rating, note and usage report now
-- says which company it is for (its shopRef, the company's id on that install; '' = the whole install, as before).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS shop_ref text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_shop_ref text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_shop_ref text NOT NULL DEFAULT '';
ALTER TABLE order_ratings ADD COLUMN IF NOT EXISTS rater_shop_ref text NOT NULL DEFAULT '';
ALTER TABLE order_ratings ADD COLUMN IF NOT EXISTS rated_shop_ref text NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS shop_ref text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS order_ratings_rated_shop ON order_ratings (rated_install_id, rated_shop_ref, by_role);

-- A listing or an order sent again after a lost answer is the same one, not a second (as notes already are).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS listings_client_id ON listings (install_id, client_id) WHERE client_id IS NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_client_id ON orders (buyer_install_id, client_id) WHERE client_id IS NOT NULL;

-- Usage is reported per company too.
ALTER TABLE part_usage ADD COLUMN IF NOT EXISTS shop_ref text NOT NULL DEFAULT '';
ALTER TABLE part_usage DROP CONSTRAINT IF EXISTS part_usage_pkey;
ALTER TABLE part_usage ADD PRIMARY KEY (install_id, shop_ref, month, number_key);

-- A merge remembers which part it took in, so rolling the merged part back can give that part its entry back.
ALTER TABLE xpart_revisions ADD COLUMN IF NOT EXISTS merged_from text;
