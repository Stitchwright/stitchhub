-- Partner messages signed end to end (stitchbench round-3 W2). Each company has an Ed25519 key in its program; its public
-- key is published here with an invite or a redeem (and for a partnership made before this, with the first signed
-- message), and the hub keeps it per side of the link. The hub checks a message's signature against that key when it
-- takes it, marks the message verified, and the real-partnership rule (billing.mjs) counts verified messages only on a
-- partnership whose two sides both have a key. The programs check the signatures again themselves (the hub is not trusted).
-- Everything is nullable: an older program sends none of it and its messages are stored unsigned, as before.

ALTER TABLE partner_invites ADD COLUMN IF NOT EXISTS pub_key text;      -- the inviter's public key (SPKI DER, base64)
ALTER TABLE partner_invites ADD COLUMN IF NOT EXISTS invite_sig jsonb;  -- { issuedAt, sig }: the inviter's signature over the invite

ALTER TABLE partner_links ADD COLUMN IF NOT EXISTS repair_key text;
ALTER TABLE partner_links ADD COLUMN IF NOT EXISTS repair_proof jsonb;  -- the invite signature or the redeem proof that came with the key
ALTER TABLE partner_links ADD COLUMN IF NOT EXISTS retail_key text;
ALTER TABLE partner_links ADD COLUMN IF NOT EXISTS retail_proof jsonb;

ALTER TABLE partner_messages ADD COLUMN IF NOT EXISTS sig jsonb;        -- { v, pub, seq, ts, sig } as the sender's program made it
ALTER TABLE partner_messages ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
