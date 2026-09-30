// Checks that need the hub's own database (a scratch one: it writes a few rows).
// usage: DATABASE_URL=postgresql://... ADMIN_TOKEN=any-16-or-more-characters node test/db.mjs
import assert from "node:assert/strict";
import { pool, tx, feedLimit, startFeeds } from "../src/db.mjs";
import { TABLES } from "../src/transfer.mjs";
import { checkLink } from "../src/checker.mjs";

// Every column of every table a move carries is in the export (a column added by a migration and forgotten there is
// lost in a move); only the change numbers, which are carried separately, and the migration list are left out.
const cols = (await pool.query(`SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = 'public'`)).rows;
for (const spec of TABLES) {
  const have = cols.filter((r) => r.t === spec.table).map((r) => r.c);
  assert.deepEqual(spec.cols.filter((c) => !have.includes(c)), [], `${spec.table}: exported columns the table doesn't have`);
  assert.deepEqual(have.filter((c) => !spec.cols.includes(c) && c !== "seq"), [], `${spec.table}: columns the export leaves out`);
}
const carried = new Set(TABLES.map((s) => s.table));
assert.deepEqual([...new Set(cols.map((r) => r.t))].filter((t) => !carried.has(t) && t !== "hub_migrations"), [], "tables the export leaves out");
console.log("export columns: ok");

// A feed stops below a change number a write in progress has taken, even though nothing shows it yet.
await startFeeds();
await tx(async (c) => {
  const n = BigInt((await c.query(`SELECT nextval('change_seq') AS n`)).rows[0].n);
  assert.ok(BigInt((await feedLimit()).change) < n, "a feed passed a number that is still being written");
});
console.log("feed hold: ok");

// What a probe found is dropped when the link got another address meanwhile (a member fixed it).
const id = `chk${Date.now().toString(36)}`;
await pool.query(`INSERT INTO links (id, brand, models, model_keys, title, url) VALUES ($1, 'B', 'M1', '{M1}', 't', 'not a web address')`, [id]);
const row = () => pool.query(`SELECT status, fail_count FROM links WHERE id = $1`, [id]).then((r) => r.rows[0]);
const stale = await checkLink({ id, url: "the old address", status: "unchecked", fail_count: 0 });
assert.equal(stale.dropped, true);
assert.deepEqual(await row(), { status: "unchecked", fail_count: 0 });
const fresh = await checkLink({ id, url: "not a web address", status: "unchecked", fail_count: 0 });
assert.equal(fresh.dropped, false);
assert.deepEqual(await row(), { status: "dead", fail_count: 1 });
await pool.query(`DELETE FROM links WHERE id = $1`, [id]);
console.log("link checker: ok");
await pool.end();
