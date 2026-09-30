-- Round 3 partner fixes.

-- Each message's size as the feed sends it (its JSON), so a page of the feed can be cut by size. The stored size is
-- compressed and can be a hundredth of it. Messages from before this version are measured once here.
ALTER TABLE partner_messages ADD COLUMN IF NOT EXISTS bytes integer;
UPDATE partner_messages SET bytes = octet_length(data::text) WHERE bytes IS NULL;

-- A partner-only install (joined with a partner code): the member install whose code, directly or through other
-- partner-only installs, brought it on. The hub limits how many one member brings on.
ALTER TABLE installs ADD COLUMN IF NOT EXISTS invited_by text;
CREATE INDEX IF NOT EXISTS installs_invited_by ON installs (invited_by) WHERE invited_by IS NOT NULL;
