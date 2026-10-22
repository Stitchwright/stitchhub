-- A preview picture with an inbox file (docs/plan.md, "StitchFoundry inbox"): StitchFoundry renders the design as sewn (or on a
-- garment) and sends it with the file; the shop shows it to the customer as the mock-up. A PNG or JPEG of 2 MB at most, kept
-- in the bucket next to the file (inbox/<account>/<item>.preview) and counted in the account's room.
ALTER TABLE inbox_items ADD COLUMN preview_size bigint CHECK (preview_size IS NULL OR preview_size > 0);
ALTER TABLE inbox_items ADD COLUMN preview_sha256 text;
ALTER TABLE inbox_items ADD COLUMN preview_type text CHECK (preview_type IS NULL OR preview_type IN ('image/png', 'image/jpeg'));
