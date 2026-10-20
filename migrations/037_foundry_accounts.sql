-- Foundry Accounts on the hub (docs/plan.md FA-1, FA-2): an account may be linked to one Foundry Account, by the account's lasting id
-- (never its email: the account service doesn't verify email at sign-up yet). One Foundry Account links to at most one hub account.
-- password_hash is already nullable: a linked account's password can be retired (scripts/retire-passwords.mjs).
ALTER TABLE accounts ADD COLUMN foundry_id integer;
CREATE UNIQUE INDEX accounts_foundry_id ON accounts (foundry_id) WHERE foundry_id IS NOT NULL;
