-- Marketplace: who made the listed item (GENUINE, COMPATIBLE or PRINTED = 3D printed). Null = the seller's install
-- didn't say (installs from before this don't send it), which is not the same as genuine.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS origin text;
