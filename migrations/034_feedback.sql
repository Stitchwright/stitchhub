-- Help, ideas, ratings and error alerts from the programs (StitchBench docs/plans/help-feedback-design.md, section 4;
-- src/feedback.mjs). Additive only: one new table. No foreign key to installs: the owner's product feedback outlives
-- an install. Not part of the hub's export or a company's move.
CREATE TABLE IF NOT EXISTS feedback (
  id          text PRIMARY KEY,
  install_id  text NOT NULL,
  shop_ref    text NOT NULL,
  shop_name   text NOT NULL,
  kind        text NOT NULL,                       -- help | idea | rating | error
  body        jsonb NOT NULL,                      -- the validated item without the picture (text, stars, context, error ...)
  picture     bytea,                               -- a JPEG of the screen, 1 MB at most; cleared 90 days after done
  fingerprint text,                                -- errors only: the same error on the same day is one row
  day         text,                                -- errors only: YYYY-MM-DD, the day the program saw it
  count       integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),  -- the latest time the same error came in
  status      text NOT NULL DEFAULT 'new',         -- new | seen | done
  done_at     timestamptz,
  owner_note  text
);

-- Errors upsert on this (adding to count).
CREATE UNIQUE INDEX IF NOT EXISTS feedback_error_once ON feedback (install_id, shop_ref, fingerprint, day) WHERE kind = 'error';
CREATE INDEX IF NOT EXISTS feedback_by_status ON feedback (status, last_at DESC);
