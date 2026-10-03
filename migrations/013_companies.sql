-- Companies on the hub (StitchBench docs/HANDOFF.md section 3 item 8: a hosted StitchBench is one install shared by
-- every company, so each company must post, list and be rated under its own name). Listings, orders, ratings, notes,
-- usage and revisions already carry shop_ref ('' = the whole install, migrations 009 and 011); this adds what still
-- credited the install, and the indexes the join to the shops table (migration 012) and the per-company lookups use.
-- Nothing here is destructive: rows from before show the install's name as they did.

-- Where to buy: a buying link is credited to the shop that added or last changed it (by_shop, the install's name).
-- Null = the install, or the hub admin's scan, as before.
ALTER TABLE xpart_sources ADD COLUMN IF NOT EXISTS shop_ref text;
ALTER TABLE xpart_sources ADD COLUMN IF NOT EXISTS shop_name text;

-- Figure snapshots: which company on the install shared it (from X-Shop-Ref). Null = the install, as before. The first
-- install to share a figure still keeps it: ownership stays by install.
ALTER TABLE figures ADD COLUMN IF NOT EXISTS shop_ref text;

-- The company's rows on an install: the join to shops (install_id, shop_ref), a company's listings going out again
-- when its rating changes, and claim handing an install's earlier rows to its one company.
CREATE INDEX IF NOT EXISTS listings_shop ON listings (install_id, shop_ref);
CREATE INDEX IF NOT EXISTS posts_shop ON posts (install_id, shop_ref);
CREATE INDEX IF NOT EXISTS orders_seller_shop ON orders (seller_install_id, seller_shop_ref);
CREATE INDEX IF NOT EXISTS orders_buyer_shop ON orders (buyer_install_id, buyer_shop_ref);
CREATE INDEX IF NOT EXISTS link_revisions_shop ON link_revisions (install_id, shop_ref) WHERE install_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS xpart_revisions_shop ON xpart_revisions (install_id, shop_ref) WHERE install_id IS NOT NULL;
