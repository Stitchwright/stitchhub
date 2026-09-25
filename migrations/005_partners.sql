-- Partner links: a private channel between one repair shop and one sewing / quilt shop (StitchShop) that takes machines
-- in for it, orders parts and notions from it and holds its stock on consignment. The hub only relays the messages
-- between the two; nobody else can read them.

-- member: joined with the community's join key. partner: joined with a partner invite only (partner routes only).
ALTER TABLE installs ADD COLUMN scope text NOT NULL DEFAULT 'member';

CREATE TABLE partner_invites (
  code_hash  text PRIMARY KEY,         -- sha256 of the code the inviting shop hands over (never stored in the clear)
  install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref   text NOT NULL,            -- which shop inside that install (an install can host several)
  shop_name  text NOT NULL,
  side       text NOT NULL,            -- the inviter's side: repair | retail
  terms      jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  link_id    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_links (
  id                text PRIMARY KEY,
  repair_install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  repair_shop_ref   text NOT NULL,
  repair_name       text NOT NULL,
  retail_install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  retail_shop_ref   text NOT NULL,
  retail_name       text NOT NULL,
  terms             jsonb NOT NULL DEFAULT '{}', -- as offered with the invite; later changes travel as messages
  status            text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ENDED
  created_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);
CREATE INDEX partner_links_repair ON partner_links (repair_install_id);
CREATE INDEX partner_links_retail ON partner_links (retail_install_id);

-- What one side sent the other, in order. `id` is the sender's own id, so a send that is retried is stored once.
CREATE TABLE partner_messages (
  seq        bigserial PRIMARY KEY,
  id         text NOT NULL,
  link_id    text NOT NULL REFERENCES partner_links (id) ON DELETE CASCADE,
  from_side  text NOT NULL, -- repair | retail | hub
  type       text NOT NULL,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, from_side, id)
);
CREATE INDEX partner_messages_link ON partner_messages (link_id, seq);
