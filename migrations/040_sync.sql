-- Hub sync v2 (docs/hub-sync-design.md): what each program or service says it understands, service keys the admin issues, shops'
-- opt-ins to take orders from a service, and the durable per-recipient message queue.

-- What a program (one row per install) or a service says it understands at /v2/hello.
CREATE TABLE sync_caps (
  principal text PRIMARY KEY,                 -- install:<install id> | service:<name>
  app       text NOT NULL,
  version   text NOT NULL,
  types     jsonb NOT NULL DEFAULT '{}',      -- { "order.placed": [1], ... }
  hello_at  timestamptz NOT NULL DEFAULT now()
);

-- Keys the hub admin issues to a service (MakerFoundry): only the hash is kept, the key is shown once.
CREATE TABLE service_keys (
  id           text PRIMARY KEY,
  name         text NOT NULL UNIQUE,          -- the service's name: its address is service:<name>
  key_hash     text NOT NULL UNIQUE,
  scopes       jsonb NOT NULL DEFAULT '[]',   -- ["orders:send", "shops:list"]
  public_key   text,                          -- Ed25519, base64 of the SPKI DER: the key it signs its messages with
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

-- A shop takes orders from a service only after it says so here. No row, or enabled = false: not listed, orders refused.
CREATE TABLE shop_service_optins (
  shop_id    text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  service    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  max_open   integer NOT NULL DEFAULT 200 CHECK (max_open BETWEEN 1 AND 10000),
  per_minute integer NOT NULL DEFAULT 50 CHECK (per_minute BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, service)
);

-- The message, as the sender made it. The body is erased 30 days after the ack (or when it expires), leaving the row as the
-- audit stub: ids, type, sizes, hash and times, nothing personal.
CREATE TABLE sync_messages (
  sender       text NOT NULL,                 -- shop:<shop id> | service:<name> | hub
  id           text NOT NULL,                 -- the sender's own id (a UUID): the receiver de-duplicates by it
  type         text NOT NULL,
  version      integer NOT NULL,
  conversation text NOT NULL,                 -- an order, a job, a link
  seq          integer NOT NULL,              -- per sender per conversation, from 1
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  body         jsonb,
  body_sha256  text NOT NULL,
  body_bytes   integer NOT NULL,
  sig          jsonb,
  stored_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender, id),
  UNIQUE (sender, conversation, seq)
);

-- One row per recipient of a message: where it is on its way.
CREATE TABLE sync_deliveries (
  delivery_seq bigserial PRIMARY KEY,         -- the cursor a recipient polls with
  sender       text NOT NULL,
  message_id   text NOT NULL,
  recipient    text NOT NULL,                 -- shop:<shop id> | service:<name>
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'held_capability', 'delivered', 'acked', 'expired')),
  delivered_at timestamptz,
  acked_at     timestamptz,
  expired_at   timestamptz,
  FOREIGN KEY (sender, message_id) REFERENCES sync_messages (sender, id) ON DELETE CASCADE,
  UNIQUE (sender, message_id, recipient)
);
CREATE INDEX sync_deliveries_open ON sync_deliveries (recipient, delivery_seq) WHERE state IN ('queued', 'delivered', 'held_capability');
