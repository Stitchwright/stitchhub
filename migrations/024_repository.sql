-- The manual repository (docs/plans/manual-repository-design.md in the StitchBench repo, package repo-hub).
-- NUMBERING: 030 on purpose, so it can't clash with the migrations the other branches add (023 on hub-accounts);
-- renumber at merge (migrate() applies files in name order, once each, so the order only has to be sane: this file
-- needs accounts, installs and shops from 012, and change_seq from 001).
--
-- manuals: what shops see (one row per manual, its current file). manual_files: the bytes in R2, by sha256. uploads: one
-- row per offer (who, what they said, what happened). blocked_hashes: bytes that may not come back. repo_downloads: a
-- count per file per day per who (an install, an account or an address hash), for the download limits and the admin page.

CREATE TABLE manuals (
  id         text PRIMARY KEY,
  category   text,
  brand      text NOT NULL,
  models     text NOT NULL,
  model_keys text[] NOT NULL DEFAULT '{}',
  doc_type   text NOT NULL,
  year       int,
  language   text NOT NULL DEFAULT 'English',
  title      text NOT NULL,
  file_id    text,                                   -- the current file (manual_files.id)
  origin     text NOT NULL DEFAULT 'user',           -- user | maker-mirror (the seed package, later)
  source_url text,                                   -- a maker mirror's verified address
  status     text NOT NULL DEFAULT 'published',      -- published | removed
  why        text,                                   -- when removed: copyright | replaced | withdrawn
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint NOT NULL DEFAULT nextval('change_seq')  -- the repository feed pages by this, as the change feed does
);
CREATE INDEX manuals_seq ON manuals (seq);
CREATE INDEX manuals_model_keys ON manuals USING gin (model_keys);

CREATE TABLE manual_files (
  id         text PRIMARY KEY,
  sha256     text NOT NULL UNIQUE,
  sha1       text,
  size_bytes bigint NOT NULL,
  pages      int,
  object_key text NOT NULL,                          -- files/<sha256>.pdf, held/..., retired/...
  status     text NOT NULL,                          -- pending | published | held | retired
  manual_id  text REFERENCES manuals (id) ON DELETE SET NULL,
  checks     jsonb NOT NULL DEFAULT '{}',            -- the hub's automatic checks, markings included
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manual_files_status ON manual_files (status);

CREATE TABLE uploads (
  id                text PRIMARY KEY,
  shop_id           text REFERENCES shops (id) ON DELETE SET NULL,
  account_id        text REFERENCES accounts (id) ON DELETE SET NULL,
  install_id        text REFERENCES installs (id) ON DELETE SET NULL,
  shop_ref          text NOT NULL,                   -- the company on that install (X-Shop-Ref)
  by_name           text,                            -- the person's name; seen by the hub's owner only. No IP address is kept.
  sha256            text NOT NULL,
  size_bytes        bigint NOT NULL,
  offered           jsonb NOT NULL DEFAULT '{}',     -- category, brand, models, docType, year, language, title as offered
  original_name     text,
  statement_version text NOT NULL,
  statement_at      timestamptz NOT NULL,
  state             text NOT NULL,                   -- slot | sent | duplicate | refused | pending | approved | rejected | removed
  reason            text,
  file_id           text REFERENCES manual_files (id) ON DELETE SET NULL,
  manual_id         text REFERENCES manuals (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_shop ON uploads (install_id, shop_ref, created_at DESC);
CREATE INDEX uploads_account ON uploads (account_id, created_at DESC);
CREATE INDEX uploads_file ON uploads (file_id) WHERE file_id IS NOT NULL;

CREATE TABLE blocked_hashes (
  sha256     text PRIMARY KEY,
  why        text NOT NULL,
  notice_id  text,                                   -- the takedown notice, once that package exists
  file_id    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz
);

CREATE TABLE repo_downloads (
  file_id text NOT NULL REFERENCES manual_files (id) ON DELETE CASCADE,
  day     text NOT NULL,                             -- YYYY-MM-DD, UTC
  who     text NOT NULL,                             -- install:<id> | account:<id> | ip:<first 16 hex of a sha-256 of the address>
  n       int NOT NULL DEFAULT 0,
  PRIMARY KEY (file_id, day, who)
);
CREATE INDEX repo_downloads_who ON repo_downloads (who, day);

-- Uploading ended for an account (three strikes, or the owner's decision) or for an install (a new account made to
-- dodge it). The strike table itself comes with the takedown package.
ALTER TABLE accounts ADD COLUMN repo_uploads_off boolean NOT NULL DEFAULT false;
ALTER TABLE installs ADD COLUMN repo_uploads_off boolean NOT NULL DEFAULT false;
