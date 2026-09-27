-- Round 3 review fixes: figure snapshots the hub admin can take down, and notes removed before this version.

-- A figure the hub admin removed stays as its id (so installs hear it's gone), without the picture.
ALTER TABLE figures ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;

-- Removing a note now takes back its text and photos. Notes removed before this version still had them.
UPDATE posts SET title = '', body = '', author_name = NULL WHERE deleted AND (title <> '' OR body <> '' OR author_name IS NOT NULL);
DELETE FROM photos WHERE post_id IN (SELECT id FROM posts WHERE deleted);
