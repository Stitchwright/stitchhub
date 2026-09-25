-- StitchHub: what the StitchBench community shares. No customer data and no manual PDFs, only links to them.

-- Every change to a shared row takes the next number from this sequence, so an install asks for
-- "everything after number N" and never misses an edit.
CREATE SEQUENCE change_seq;

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Each StitchBench install that joined with the community's join key.
CREATE TABLE installs (
  id           text PRIMARY KEY,
  name         text NOT NULL,          -- company name shown on what it shares
  contact      text,
  key_hash     text NOT NULL UNIQUE,   -- sha256 of the install's own key
  blocked      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- Where a manual can be downloaded from. Anyone can fix a link; every change is a revision and can be rolled back.
CREATE TABLE links (
  id          text PRIMARY KEY,
  category    text,
  brand       text NOT NULL,
  models      text NOT NULL,
  model_keys  text[] NOT NULL DEFAULT '{}',
  doc_type    text,
  title       text NOT NULL,
  file_name   text,
  url         text NOT NULL,
  source      text,
  status      text NOT NULL DEFAULT 'unchecked', -- ok | dead | blocked | unchecked
  http_status int,
  checked_at  timestamptz,
  fail_count  int NOT NULL DEFAULT 0,
  deleted     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX links_seq ON links (seq);
CREATE INDEX links_model_keys ON links USING gin (model_keys);
CREATE INDEX links_check ON links (checked_at NULLS FIRST) WHERE NOT deleted;
CREATE UNIQUE INDEX links_url_file ON links (url, coalesce(file_name, ''));

CREATE TABLE link_revisions (
  id         text PRIMARY KEY,
  link_id    text NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  action     text NOT NULL, -- added | edited | reverted | removed | restored
  brand      text NOT NULL,
  models     text NOT NULL,
  doc_type   text,
  title      text NOT NULL,
  url        text NOT NULL,
  by_name    text,
  by_shop    text,
  install_id text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_revisions_link ON link_revisions (link_id, created_at);

-- Tech notes: an issue found, a fix, a tip, with photos. Customer names and serials are never sent.
CREATE TABLE posts (
  id          text PRIMARY KEY,
  install_id  text REFERENCES installs (id) ON DELETE SET NULL,
  shop_name   text NOT NULL,
  author_name text,
  brand       text NOT NULL,
  model       text NOT NULL,
  model_key   text NOT NULL,
  kind        text NOT NULL DEFAULT 'GOTCHA', -- GOTCHA (issue found) | TIP (fix) | FACT
  title       text NOT NULL,
  body        text NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX posts_seq ON posts (seq);

CREATE TABLE photos (
  id         text PRIMARY KEY,
  post_id    text NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  caption    text,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX photos_post ON photos (post_id);

-- Small snapshots of manual figures (a crop of one page), keyed by the id StitchBench computes for them.
CREATE TABLE figures (
  id         text PRIMARY KEY,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  width      int,
  height     int,
  install_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX figures_seq ON figures (seq);

-- Data sets the hub admin publishes to every install (e.g. "specs": factory tension and timing values).
CREATE TABLE datasets (
  name       text PRIMARY KEY,
  version    text NOT NULL,
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
