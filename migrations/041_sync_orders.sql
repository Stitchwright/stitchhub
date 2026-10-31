-- MakerFoundry orders through the sync queue (#34, src/sync.mjs, src/sync-orders.mjs): which orders are open per shop (for the
-- per-shop cap, and so that only a real order's conversation can carry status, proofs and cancels), and the files a message points at.
-- Neither holds anything personal: ids, sizes and hashes.

CREATE TABLE sync_orders (
  service      text NOT NULL,                 -- the service's name (makerfoundry)
  conversation text NOT NULL,                 -- the service's order reference
  shop_id      text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  why_closed   text,                          -- shipped | collected | cancelled | expired
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  PRIMARY KEY (service, conversation)
);
CREATE INDEX sync_orders_open ON sync_orders (shop_id, service) WHERE state = 'open';

-- A file (art, a mock-up) uploaded for a conversation: the bytes are in the bucket under sync/<hash of the conversation>/<sha256>.
CREATE TABLE sync_files (
  conversation text NOT NULL,
  sha256       text NOT NULL,
  uploader     text NOT NULL,                 -- shop:<id> | service:<name>
  audience     text NOT NULL,                 -- who may fetch it besides the uploader: the other side of the conversation
  kind         text NOT NULL CHECK (kind IN ('art', 'mockup')),
  size         integer NOT NULL CHECK (size > 0),
  type         text,                          -- image/png | image/jpeg for a mock-up
  state        text NOT NULL DEFAULT 'announced' CHECK (state IN ('announced', 'ready')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (conversation, sha256)
);
