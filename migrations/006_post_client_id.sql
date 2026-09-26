-- A shop's own id for a note it shares: a retried upload (the answer was lost on a slow line) gets the note already
-- made instead of a second copy.
ALTER TABLE posts ADD COLUMN client_id text;
CREATE UNIQUE INDEX posts_client ON posts (install_id, client_id) WHERE client_id IS NOT NULL;
