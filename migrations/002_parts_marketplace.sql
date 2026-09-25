-- Parts cross-reference and marketplace (see docs/parts-and-marketplace.md).

-- One physical part, known under one or more part numbers, fitting many machines.
CREATE TABLE xparts (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'PART', -- PART | ACCESSORY | SUPPLY
  category   text,                         -- e.g. Screw, Presser foot, Bobbin case
  specs      text,                         -- e.g. M3 x 6 mm pan head
  notes      text,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX xparts_seq ON xparts (seq);

-- Each (brand, number) belongs to one part only; keys are upper-case letters and digits.
CREATE TABLE xpart_numbers (
  xpart_id   text NOT NULL REFERENCES xparts (id) ON DELETE CASCADE,
  brand      text NOT NULL,
  number     text NOT NULL,
  brand_key  text NOT NULL,
  number_key text NOT NULL,
  PRIMARY KEY (brand_key, number_key)
);
CREATE INDEX xpart_numbers_part ON xpart_numbers (xpart_id);
CREATE INDEX xpart_numbers_number ON xpart_numbers (number_key);

-- Machines a part fits. evidence: listed (in that model's parts list), tested (a tech fitted it), maker (maker says).
CREATE TABLE xpart_fits (
  xpart_id  text NOT NULL REFERENCES xparts (id) ON DELETE CASCADE,
  brand     text NOT NULL,
  model     text NOT NULL,
  brand_key text NOT NULL,
  model_key text NOT NULL,
  evidence  text NOT NULL DEFAULT 'listed',
  source    text,
  PRIMARY KEY (xpart_id, brand_key, model_key)
);
CREATE INDEX xpart_fits_model ON xpart_fits (model_key);

-- Where to buy it.
CREATE TABLE xpart_sources (
  id          text PRIMARY KEY,
  xpart_id    text NOT NULL REFERENCES xparts (id) ON DELETE CASCADE,
  vendor      text NOT NULL,
  url         text,
  price_cents int,
  currency    text NOT NULL DEFAULT 'USD',
  note        text,
  by_shop     text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX xpart_sources_part ON xpart_sources (xpart_id);

-- Every change keeps the whole entry, so any version can be restored.
CREATE TABLE xpart_revisions (
  id         text PRIMARY KEY,
  xpart_id   text NOT NULL REFERENCES xparts (id) ON DELETE CASCADE,
  action     text NOT NULL, -- added | edited | merged | removed | restored | reverted
  snapshot   jsonb NOT NULL,
  by_name    text,
  by_shop    text,
  install_id text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX xpart_revisions_part ON xpart_revisions (xpart_id, created_at);

-- Marketplace: parts and accessories shops sell to each other. Buyers pay sellers directly.
CREATE TABLE listings (
  id             text PRIMARY KEY,
  install_id     text REFERENCES installs (id) ON DELETE SET NULL,
  shop_name      text NOT NULL,
  title          text NOT NULL,
  description    text,
  kind           text NOT NULL DEFAULT 'PART',
  condition      text NOT NULL DEFAULT 'NEW', -- NEW | USED | REFURB
  brand          text,
  part_number    text,
  xpart_id       text,
  fits           text,
  price_cents    int NOT NULL,
  currency       text NOT NULL DEFAULT 'USD',
  qty            int NOT NULL DEFAULT 1,
  shipping_cents int, -- flat rate; null = quoted per order
  shipping_note  text,
  ships_from     text,
  status         text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PAUSED | SOLD_OUT | REMOVED
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  seq            bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX listings_seq ON listings (seq);

CREATE TABLE listing_photos (
  id         text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX listing_photos_listing ON listing_photos (listing_id);

-- Orders are private to the buyer and the seller; they never go out in /v1/changes.
CREATE SEQUENCE order_number_seq;

CREATE TABLE orders (
  id                text PRIMARY KEY,
  number            text NOT NULL UNIQUE, -- SH-000123
  listing_id        text REFERENCES listings (id) ON DELETE SET NULL,
  seller_install_id text REFERENCES installs (id) ON DELETE SET NULL,
  buyer_install_id  text REFERENCES installs (id) ON DELETE SET NULL,
  seller_shop       text NOT NULL,
  buyer_shop        text NOT NULL,
  item              jsonb NOT NULL, -- { title, brand, partNumber, condition } when ordered
  qty               int NOT NULL,
  unit_price_cents  int NOT NULL,
  shipping_cents    int,
  currency          text NOT NULL DEFAULT 'USD',
  ship_to           text,
  buyer_note        text,
  buyer_contact     jsonb,
  seller_contact    jsonb,
  pay_instructions  text,
  status            text NOT NULL DEFAULT 'REQUESTED',
  buyer_paid_note   text,
  paid_at           timestamptz,
  carrier           text,
  tracking          text,
  shipped_at        timestamptz,
  received_at       timestamptz,
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  seq               bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX orders_seller ON orders (seller_install_id, seq);
CREATE INDEX orders_buyer ON orders (buyer_install_id, seq);

CREATE TABLE order_events (
  id         text PRIMARY KEY,
  order_id   text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  by_role    text NOT NULL, -- buyer | seller
  action     text NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, created_at);
