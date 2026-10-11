-- Room for members' pictures (src/media.mjs): every upload sums the pictures its install keeps, by company. Notes and
-- listings are found by their (install_id, shop_ref) indexes from 013; figures and Help pictures get theirs here.
-- Additive only: two indexes.

CREATE INDEX IF NOT EXISTS figures_install ON figures (install_id, shop_ref);
CREATE INDEX IF NOT EXISTS feedback_pictures ON feedback (install_id, shop_ref) WHERE picture IS NOT NULL;
