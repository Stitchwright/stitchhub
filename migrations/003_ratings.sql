-- Ratings after a marketplace order: the buyer rates the seller (by_role = 'buyer'), the seller rates the buyer
-- (by_role = 'seller'). One rating per side per order; rating again replaces it.
CREATE TABLE order_ratings (
  order_id         text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  by_role          text NOT NULL CHECK (by_role IN ('buyer', 'seller')),
  rater_install_id text REFERENCES installs (id) ON DELETE SET NULL,
  rated_install_id text REFERENCES installs (id) ON DELETE SET NULL,
  stars            int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, by_role)
);
CREATE INDEX order_ratings_rated ON order_ratings (rated_install_id, by_role, updated_at);

-- Bulk "where to buy" imports look sources up by part and link.
CREATE INDEX xpart_sources_part_url ON xpart_sources (xpart_id, url);
