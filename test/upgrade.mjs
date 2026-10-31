// The upgrade path: a database that already holds data (as the live hub's does) is brought up by the hub's own startup.
// Applies migrations up to 037 to a scratch database, writes representative rows (installs, shops, listings, orders,
// partner links and messages, accounts, posts, subscriptions), starts the hub so the remaining migrations (038, 039 ...)
// run, then checks every row that was there is intact and the new tables and columns exist and work.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/upgrade.mjs
//   UPGRADE_SELF_CHECK=drop-rows | rewrite-rows  adds a deliberately destructive migration, which this test must catch.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const OLD_LAST = 37; // the live hub runs the code up to this migration
const SELF_CHECK = process.env.UPGRADE_SELF_CHECK;
const num = (f) => Number(f.split("_")[0]);
const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const newer = all.filter((f) => num(f) > OLD_LAST);
assert.ok(newer.length > 0, "no migrations after 037");

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const q = (t, p) => pool.query(t, p);
assert.equal((await q(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n, 0, "give this check an empty scratch database");

// ----- 1. the old schema, from the migrations the live hub has run -----
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-old-"));
for (const f of all) if (num(f) <= OLD_LAST) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
async function runHub(port) {
  const hub = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: "upgrade-test-admin-token", JOIN_KEY: "join-upgrade-test", PORT: String(port),
      LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Upgrade Test Hub",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  hub.stdout.on("data", (d) => (log += d));
  hub.stderr.on("data", (d) => (log += d));
  for (let i = 0; ; i++) {
    if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) { hub.kill(); throw new Error(`the hub didn't start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { hub, log: () => log };
}

// The old schema is made by the hub's own migrate() on the old files only (the hub itself always reads migrations/).
const { migrate, pool: dbPool } = await import("../src/db.mjs");
await migrate(stage);
await dbPool.end();
const applied = (await q(`SELECT name FROM hub_migrations`)).rows.map((r) => r.name);
assert.equal(applied.length, all.filter((f) => num(f) <= OLD_LAST).length);
assert.ok(!applied.some((n) => num(n) > OLD_LAST));

// ----- 2. representative rows -----
const T = new Date("2026-01-15T12:00:00Z");
await q(`INSERT INTO installs (id, name, contact, key_hash) VALUES ('inst-a', 'Alpha Repairs', 'a@example.test', 'hash-a'), ('inst-b', 'Beta Retail', 'b@example.test', 'hash-b')`);
await q(`INSERT INTO accounts (id, email, password_hash, verified_at, foundry_id) VALUES ('acc-1', 'owner@example.test', 'pw-hash', $1, 77), ('acc-2', 'other@example.test', NULL, NULL, NULL)`, [T]);
await q(`INSERT INTO shops (id, install_id, shop_ref, name, kind, account_id) VALUES ('shop-a', 'inst-a', 'ref-a', 'Alpha Repairs', 'repair', 'acc-1'), ('shop-b', 'inst-b', 'ref-b', 'Beta Retail', 'retail', 'acc-2')`);
await q(`INSERT INTO subscriptions (shop_id, plan, status) VALUES ('shop-a', 'standard', 'active')`);
await q(`INSERT INTO links (id, brand, models, model_keys, title, url) VALUES ('link-1', 'Brother', 'PR1055X', '{PR1055X}', 'Service manual', 'https://example.test/manual')`);
await q(`INSERT INTO posts (id, install_id, shop_name, brand, model, model_key, title, body) VALUES ('post-1', 'inst-a', 'Alpha Repairs', 'Brother', 'PR1055X', 'PR1055X', 'Timing tip', 'Check the hook gap')`);
await q(`INSERT INTO xparts (id, name, kind) VALUES ('xp-1', 'Needle bar', 'part')`);
await q(`INSERT INTO listings (id, install_id, shop_name, title, description, price_cents, qty, xpart_id) VALUES ('lst-1', 'inst-b', 'Beta Retail', 'Needle bar', 'New', 4500, 3, 'xp-1')`);
await q(`INSERT INTO orders (id, number, listing_id, seller_install_id, buyer_install_id, seller_shop, buyer_shop, item, qty, unit_price_cents, status, created_at) VALUES ('ord-1', 'SH-0001', 'lst-1', 'inst-b', 'inst-a', 'Beta Retail', 'Alpha Repairs', '{"title":"Needle bar"}', 2, 4500, 'paid', $1)`, [T]);
await q(`INSERT INTO partner_links (id, repair_install_id, repair_shop_ref, repair_name, retail_install_id, retail_shop_ref, retail_name, terms, status) VALUES ('pl-1', 'inst-a', 'ref-a', 'Alpha Repairs', 'inst-b', 'ref-b', 'Beta Retail', '{"discount":10}', 'active')`);
await q(`INSERT INTO partner_messages (id, link_id, from_side, type, data) VALUES ('pm-1', 'pl-1', 'repair', 'note', '{"text":"hello"}'), ('pm-2', 'pl-1', 'retail', 'note', '{"text":"hi back"}')`);

// A snapshot of every row of every table, as JSON, keyed by the table's primary key / whole-row text.
const tables = async () => (await q(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
async function snapshot() {
  const out = {};
  for (const t of await tables()) out[t] = (await q(`SELECT to_jsonb(x) j FROM "${t}" x`)).rows.map((r) => r.j);
  return out;
}
const before = await snapshot();
const SEEDED = ["installs", "accounts", "shops", "subscriptions", "links", "posts", "xparts", "listings", "orders", "partner_links", "partner_messages"];
for (const t of SEEDED) assert.ok(before[t].length > 0, `${t}: no seeded rows`);
const sequences = async () => Object.fromEntries((await q(`SELECT sequencename n, last_value v FROM pg_sequences WHERE schemaname = 'public'`)).rows.map((r) => [r.n, r.v]));
const seqBefore = await sequences();

// ----- 3. start the hub on it: it applies the remaining migrations -----
let broken;
if (SELF_CHECK) {
  // Only for showing the check catches a break: a migration file added to the real directory for the length of the run.
  broken = path.join(MIGRATIONS, "999_selfcheck_break.sql");
  fs.writeFileSync(broken, SELF_CHECK === "drop-rows" ? `DELETE FROM orders;` : `UPDATE listings SET price_cents = price_cents + 1;`);
}
let hub;
try {
  hub = await runHub(await freePort());
} finally {
  if (broken) fs.rmSync(broken, { force: true });
}
try {
  // ----- 4. everything that was there still is -----
  const after = await snapshot();
  for (const t of SEEDED) {
    // Compare only the columns the old row had: a new column is allowed, a changed or lost value is not.
    const keyed = (rows) => rows.map((r) => JSON.stringify(r)).sort();
    const trimmed = after[t].map((row) => Object.fromEntries(Object.keys(before[t][0]).map((k) => [k, row[k]])));
    // Rows the hub itself touches on start (last_seen_at and the like) are compared by identity and the seeded values only.
    const strip = (r) => { const { last_seen_at, updated_at, checked_at, ...rest } = r; return rest; };
    assert.deepEqual(keyed(trimmed.map(strip)), keyed(before[t].map(strip)), `${t}: rows changed or lost by the upgrade`);
  }
  for (const t of Object.keys(before)) assert.ok(t in after, `${t}: table dropped by the upgrade`);
  const seqAfter = await sequences();
  // A sequence nothing has used yet shows no last value.
  for (const [n, v] of Object.entries(seqBefore)) if (v !== null) assert.ok(seqAfter[n] !== null && BigInt(seqAfter[n]) >= BigInt(v), `sequence ${n} went backwards`);
  console.log("existing rows intact: ok");

  // ----- 5. the new schema is there -----
  const now = (await q(`SELECT name FROM hub_migrations`)).rows.map((r) => r.name).sort();
  assert.deepEqual(now, all.filter((f) => !f.startsWith("999_")), "the migration list after the upgrade");
  const colsOf = async (t) => (await q(`SELECT column_name c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).rows.map((r) => r.c);
  assert.ok((await tables()).includes("inbox_items"), "038: inbox_items missing");
  for (const c of ["id", "account_id", "to_shop_id", "file_name", "size", "sha256", "meta", "created_at", "confirmed_at", "expires_at", "taken_at", "taken_by_shop_id", "deleted_at", "preview_size", "preview_sha256", "preview_type"]) {
    assert.ok((await colsOf("inbox_items")).includes(c), `038/039: inbox_items.${c} missing`);
  }
  // The new table works against the old accounts and shops, with its constraints and cascades.
  await q(`INSERT INTO inbox_items (id, account_id, to_shop_id, file_name, size, sha256, expires_at, preview_size, preview_sha256, preview_type) VALUES ('in-1', 'acc-1', 'shop-a', 'logo.dst', 1234, 'abc', now() + interval '1 day', 55, 'def', 'image/png')`);
  await assert.rejects(q(`INSERT INTO inbox_items (id, account_id, file_name, size, sha256, expires_at) VALUES ('in-bad', 'acc-1', 'x', 0, 'a', now())`), /check/i, "size must be positive");
  await assert.rejects(q(`INSERT INTO inbox_items (id, account_id, file_name, size, sha256, expires_at, preview_type) VALUES ('in-bad2', 'acc-1', 'x', 1, 'a', now(), 'image/gif')`), /check/i, "preview type is png or jpeg");
  console.log("new tables and columns: ok");
} finally {
  hub.hub.kill();
  await pool.end();
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log("upgrade: ok");
