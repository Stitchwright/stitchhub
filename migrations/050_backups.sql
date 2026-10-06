-- Off-site backup storage (StitchBench docs/plans/later-round-1-design.md 1.6, package offsite-hub). The hub arranges an
-- S3-compatible bucket (Cloudflare R2) in the operator's name and hands the programs short-lived upload and download
-- addresses; the bytes never pass through the hub, and they are encrypted on the shop's side with a key only the owner
-- holds, so neither the hub nor the bucket can read them. This table is the hub's index of what each company has there,
-- keyed by the hub's shops.id so a company that moves to another install (moves.mjs rewrites shops.install_id) keeps its store.
CREATE TABLE backup_objects (
  shop_id      text NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  name         text NOT NULL,                       -- data/2026-10-06-020000.sbob or photo/MachinePhoto/<id>-<hash>
  kind         text NOT NULL CHECK (kind IN ('data', 'photo')),
  size         bigint NOT NULL CHECK (size >= 0),
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),  -- the upload address was handed out
  confirmed_at timestamptz,                         -- the program said it was uploaded and the hub saw the object, at its size
  deleted_at   timestamptz,
  PRIMARY KEY (shop_id, name)
);
CREATE INDEX backup_objects_live ON backup_objects (shop_id) WHERE deleted_at IS NULL;
