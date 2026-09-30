-- Round 3 review fix (M12): a hosted StitchBench holds several companies on one install, so a link or cross-reference
-- revision names the company that made it (its shopRef, the company's id on that install, and its name at the time)
-- beside the install (by_shop / install_id). '' and NULL = the whole install, as installs from before this send:
-- the history then shows the install's name, as it did.
ALTER TABLE link_revisions ADD COLUMN IF NOT EXISTS shop_ref text NOT NULL DEFAULT '';
ALTER TABLE link_revisions ADD COLUMN IF NOT EXISTS shop_name text;
ALTER TABLE xpart_revisions ADD COLUMN IF NOT EXISTS shop_ref text NOT NULL DEFAULT '';
ALTER TABLE xpart_revisions ADD COLUMN IF NOT EXISTS shop_name text;
