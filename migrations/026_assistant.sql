-- The Assistant proxy (StitchBench docs/plans/ai-assistant-scope.md section 2.2): the hub holds the Anthropic key, counts
-- each company's calls and keeps tokens and cost only. No prompt or answer text is stored here.

-- A company that has used the Assistant: its time zone as last sent (the month turns there) and the admin's free pass.
CREATE TABLE assistant_shops (
  install_id text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref   text NOT NULL,
  tz         text NOT NULL DEFAULT 'UTC',
  comp_until date,                      -- the admin's "Assistant free until" (a day, in the shop's zone)
  comp_note  text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, shop_ref)
);

-- One row per company and month (the shop's zone): calls counted against the 300, top-ups added by the admin
-- (bonus, 300 each), free plate reads (20 a month without the module) and what it all cost.
CREATE TABLE assistant_usage (
  install_id       text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref         text NOT NULL,
  month            text NOT NULL,       -- 2026-10
  calls            integer NOT NULL DEFAULT 0,
  bonus            integer NOT NULL DEFAULT 0,
  free_reads       integer NOT NULL DEFAULT 0,
  input_tokens     bigint NOT NULL DEFAULT 0,
  output_tokens    bigint NOT NULL DEFAULT 0,
  cost_millicents  bigint NOT NULL DEFAULT 0, -- thousandths of a cent
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, shop_ref, month)
);

-- Every call, without its content.
CREATE TABLE assistant_calls (
  id               text PRIMARY KEY,
  install_id       text NOT NULL REFERENCES installs (id) ON DELETE CASCADE,
  shop_ref         text NOT NULL,
  feature          text NOT NULL,
  class            text NOT NULL,
  model            text,
  free             boolean NOT NULL DEFAULT false,
  input_tokens     integer NOT NULL DEFAULT 0,
  cache_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  cost_millicents  integer NOT NULL DEFAULT 0,
  ms               integer NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_calls_shop ON assistant_calls (install_id, shop_ref, created_at);
