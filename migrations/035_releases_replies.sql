-- Program updates (StitchBench docs/plans/ease-of-use-design.md, section 1; src/releases.mjs) and the owner's written
-- answers to Help items (section 4; src/feedback.mjs). Additive only.
CREATE TABLE IF NOT EXISTS releases (
  id           text PRIMARY KEY,
  flavor       text NOT NULL,                      -- stitchbench | stitchshop
  version      text NOT NULL,                      -- x.y.z
  url          text,                               -- an https address the installer lives at (null when it is in R2)
  r2_key       text,                               -- the installer in the hub's R2 bucket (null when url is set)
  sha256       text NOT NULL,                      -- hex
  size         bigint NOT NULL,
  signature    text NOT NULL,                      -- base64 Ed25519, made by the owner's release key; the hub only stores it
  notes        jsonb NOT NULL DEFAULT '[]',        -- what's new, a list of short lines
  created_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  UNIQUE (flavor, version),
  CHECK ((url IS NULL) <> (r2_key IS NULL))
);

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at timestamptz;
CREATE INDEX IF NOT EXISTS feedback_replies ON feedback (install_id, shop_ref, replied_at DESC) WHERE reply IS NOT NULL;
