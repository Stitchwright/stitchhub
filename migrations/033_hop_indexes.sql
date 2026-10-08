-- Shop hop look-ups by passport and by hop (src/hops.mjs): a passport's stamps (stamping, the passport page, the
-- completed list) and a hop's passports (the completed list, the counts). Additive only: two indexes.

CREATE INDEX IF NOT EXISTS hop_stamps_passport ON hop_stamps (passport_id, at);
CREATE INDEX IF NOT EXISTS hop_passports_hop ON hop_passports (hop_id, created_at);
