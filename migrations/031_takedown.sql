-- The manual repository's takedown process (docs/plans/manual-repository-design.md section 4.2, package repo-takedown).
-- NUMBERING: 031 on purpose (030 is repo-hub); renumber at merge.
--
-- takedown_notices: every notice and counter-notice, whatever way it came (the /copyright form, or logged by the owner from an
-- email or a letter). Never edited but for its status and dates; `notes` only ever gets entries added (a timeline).
-- strikes: one per file removed on a notice for the account whose upload was published; withdrawn when the file is restored.

CREATE TABLE takedown_notices (
  id             text PRIMARY KEY,
  kind           text NOT NULL DEFAULT 'notice',      -- notice | counter
  parent_id      text,                                -- a counter-notice: the notice it answers
  via            text NOT NULL DEFAULT 'form',        -- form | email | post
  status         text NOT NULL,                       -- notice: new | incomplete | actioned | rejected | countered | restored | lawsuit | closed; counter: received
  missing        text[] NOT NULL DEFAULT '{}',        -- what a notice lacked when it came in (empty: complete)
  complainant    jsonb NOT NULL DEFAULT '{}',         -- name, organization, address, phone, email (a counter-notice: the uploader's)
  work           text,                                -- the copyrighted work
  locations      text,                                -- the material and where it is (a counter-notice: the file and where it was)
  statements     jsonb NOT NULL DEFAULT '{}',         -- the sworn statements ticked (goodFaith, accuracy; counter: goodFaith, jurisdiction, service)
  signature      text,
  raw_text       text,                                -- an emailed or posted notice, as pasted
  manual_ids     text[] NOT NULL DEFAULT '{}',        -- what the notice was actioned against (manuals.id)
  file_ids       text[] NOT NULL DEFAULT '{}',        -- ... and their files (manual_files.id)
  account_id     text,                                -- counter-notice: the uploader's account
  reason         text,                                -- why rejected
  received_at    timestamptz NOT NULL DEFAULT now(),
  actioned_at    timestamptz,
  countered_at   timestamptz,
  restore_earliest text,                              -- YYYY-MM-DD, business day 10 after the counter-notice
  restore_latest   text,                              -- business day 14
  reminded_at    timestamptz,                         -- the owner's day-10 reminder
  restored_at    timestamptz,
  closed_at      timestamptz,
  notes          jsonb NOT NULL DEFAULT '[]',         -- [{ at, by, text }], appended only
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX takedown_notices_status ON takedown_notices (status, received_at);
CREATE INDEX takedown_notices_parent ON takedown_notices (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE strikes (
  id           text PRIMARY KEY,
  account_id   text REFERENCES accounts (id) ON DELETE SET NULL,
  install_id   text REFERENCES installs (id) ON DELETE SET NULL,
  shop_id      text REFERENCES shops (id) ON DELETE SET NULL,
  notice_id    text NOT NULL,
  file_id      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  UNIQUE (notice_id, file_id)
);
CREATE INDEX strikes_account ON strikes (account_id, created_at DESC);
