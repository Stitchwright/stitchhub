-- Shop hop passports (StitchBench shop-features-round-2-design.md 4.6; src/hops.mjs). Additive only: new tables.
-- An organizing shop starts a hop, other shops join it with the organizer's one-use code (their choice), shoppers sign
-- up on the hub's public hop page and get a passport (a code), and each shop stamps it at the counter, signed with the
-- shop's partner key pinned here when it started or joined. A shopper's details are only what she typed, and go to the
-- shops only when she ticked "share" (off by default).

CREATE TABLE IF NOT EXISTS hops (
  id                 text PRIMARY KEY,
  slug               text NOT NULL UNIQUE,         -- the public page: /hop/<slug>
  name               text NOT NULL,
  starts_on          date,
  ends_on            date,
  rule               text NOT NULL DEFAULT 'all',  -- all | any:N
  organizer_install  text NOT NULL,                -- the organizing company (install + shop_ref); a move rewrites it
  organizer_shop_ref text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);

CREATE TABLE IF NOT EXISTS hop_shops (
  hop_id     text NOT NULL REFERENCES hops (id) ON DELETE CASCADE,
  install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref   text NOT NULL,
  shop_name  text NOT NULL,
  public_key text,                                 -- base64 SPKI DER of the company's Ed25519 partner key, pinned
  role       text NOT NULL DEFAULT 'MEMBER',       -- ORGANIZER | MEMBER
  status     text NOT NULL DEFAULT 'JOINED',       -- JOINED | LEFT
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  PRIMARY KEY (hop_id, install_id, shop_ref),
  UNIQUE (hop_id, shop_ref)                        -- a company is in a hop once, from the install it is on
);
CREATE INDEX IF NOT EXISTS hop_shops_shop ON hop_shops (install_id, shop_ref);

CREATE TABLE IF NOT EXISTS hop_invites (
  code_hash        text PRIMARY KEY,               -- sha256 of the code, as partner codes
  hop_id           text NOT NULL REFERENCES hops (id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,           -- 14 days
  used_by_install  text,
  used_by_shop_ref text,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hop_passports (
  id         text PRIMARY KEY,
  hop_id     text NOT NULL REFERENCES hops (id) ON DELETE CASCADE,
  code       char(8) NOT NULL UNIQUE,              -- Crockford letters and digits (no I L O U): HOP-XXXX-XXXX
  name       text NOT NULL,
  email      text,
  phone      text,
  share      boolean NOT NULL DEFAULT false,       -- "share my name and contact with each shop I visit"
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS hop_passports_email ON hop_passports (hop_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hop_passports_phone ON hop_passports (hop_id, regexp_replace(phone, '[^0-9]', '', 'g')) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS hop_stamps (
  id          text PRIMARY KEY,
  hop_id      text NOT NULL REFERENCES hops (id) ON DELETE CASCADE,
  passport_id text NOT NULL REFERENCES hop_passports (id) ON DELETE CASCADE,
  shop_ref    text NOT NULL,
  stamp_id    text NOT NULL UNIQUE,                -- the program's own id for the stamp
  at          timestamptz NOT NULL,                -- when the shop stamped it (the signed time)
  sig         jsonb NOT NULL,                      -- { v: 1, pub, sig } over SBHS1 (src/hops.mjs stampText)
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hop_id, passport_id, shop_ref)
);

CREATE TABLE IF NOT EXISTS hop_draws (
  id          text PRIMARY KEY,
  hop_id      text NOT NULL REFERENCES hops (id) ON DELETE CASCADE,
  passport_id text NOT NULL REFERENCES hop_passports (id) ON DELETE CASCADE,
  prize       text NOT NULL,
  present     boolean NOT NULL DEFAULT true,
  drawn_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hop_draws_hop ON hop_draws (hop_id, drawn_at);
