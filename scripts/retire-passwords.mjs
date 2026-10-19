// Retire the hub passwords of every account that has a Foundry Account linked (docs/plan.md FA-2 on the hub). Needs FOUNDRY_SIGNIN=only.
// A dry run unless --apply is given. From a Railway service: railway run node scripts/retire-passwords.mjs [--apply]
// A linked account signs in with its Foundry Account; its hub password is dead weight and a hash someone could try to crack, so
// it is removed (the column is simply emptied). Accounts with no Foundry Account linked keep theirs: they can't sign in with it while
// the switch is "only", but it is how they could prove who they are when linking; they link, or get an emailed link, first. Idempotent.
import pg from "pg";
import { foundryMode } from "../src/foundry.mjs";

if (foundryMode() !== "only") {
  console.error("Set FOUNDRY_SIGNIN=only first: until then people still sign in with their hub passwords.");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  const withPassword = (await client.query(`SELECT count(*)::int AS n FROM accounts WHERE foundry_id IS NOT NULL AND password_hash IS NOT NULL`)).rows[0].n;
  const linked = (await client.query(`SELECT count(*)::int AS n FROM accounts WHERE foundry_id IS NOT NULL`)).rows[0].n;
  console.log(`${linked} account(s) have a Foundry Account linked; ${withPassword} of them still have a hub password.`);
  if (apply) {
    const r = await client.query(`UPDATE accounts SET password_hash = NULL WHERE foundry_id IS NOT NULL AND password_hash IS NOT NULL`);
    console.log(`Retired the hub password of ${r.rowCount}.`);
  } else console.log("Dry run: nothing changed. Add --apply to retire their hub passwords.");
  const waiting = (await client.query(`SELECT email, verified_at IS NOT NULL AS verified FROM accounts WHERE foundry_id IS NULL AND NOT disabled ORDER BY created_at`)).rows;
  if (waiting.length) {
    console.log(`\n${waiting.length} active account(s) have no Foundry Account yet. They can't sign in until they link (an emailed link from "Lost access to your Foundry Account?", or "Link it to your StitchHub account" on the sign-in page):`);
    for (const w of waiting) console.log(`  ${w.email}${w.verified ? "" : "  (email not confirmed)"}`);
  }
} finally {
  await client.end();
}
