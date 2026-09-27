// Database connection and migrations (migrations/*.sql, applied in order, each once).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL ?? 8),
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export const q = (text, params) => pool.query(text, params);

export async function one(text, params) {
  return (await pool.query(text, params)).rows[0] ?? null;
}

/** A transaction. `hold` is off only for migrations: they run before the sequences the hold reads exist. */
export async function tx(fn, { hold = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (hold) await lockFeeds(client);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ----- safe feed positions -----
// The change feeds (/v1/changes, /v1/orders, partner messages) page by numbers taken from a sequence when a row is
// written, which is before its transaction commits. If an install read past a number still held by an open
// transaction, it would never get that row. So every write first takes a shared advisory lock keyed by where the
// sequences were (any number it takes will be higher). The lock lasts until the write commits or fails, and every hub
// process sees it in pg_locks, so a feed hands out rows only below the lowest key still held. This lives in the
// database rather than in memory because two hub processes overlap for a moment on every Railway redeploy (the old one
// finishes its requests while the new one already answers polls), and neither can see the other's open writes.
const KEYSPACE = { change: 1, partner: 2 }; // the lock's first key: which sequence the second key is a position of
const INT_MAX = 2147483647; // the second key is an int4; the hub would need two billion changes to reach it

/** Inside a transaction, before its writes: feeds stay below the numbers it may take until it commits or fails. */
export async function lockFeeds(client) {
  await client.query(
    `SELECT pg_advisory_xact_lock_shared($1::int, least((SELECT last_value FROM change_seq), $3::bigint)::int),
            pg_advisory_xact_lock_shared($2::int, least((SELECT last_value FROM partner_messages_seq_seq), $3::bigint)::int)`,
    [KEYSPACE.change, KEYSPACE.partner, INT_MAX],
  );
}

// The import (transfer.mjs) writes on its own connection and holds the feeds from this process instead: it notes where
// the sequences were, and feeds stay below the lowest note still open. Only this process can see such a note.
const open = new Set();
let latest = { change: 0n, partner: 0n }; // where the sequences were when a feed last looked: never ahead of where they are

/** Before a write outside tx(): feeds stay below the numbers it may take until release() (when it has committed or failed). */
export function holdFeeds() {
  const mark = { ...latest };
  open.add(mark);
  return () => open.delete(mark);
}

// Single statements through the pool that may take a number run in a transaction of their own, so they hold the same lock.
const rawQuery = pool.query.bind(pool);
pool.query = (text, params) => {
  const sql = typeof text === "string" ? text : (text?.text ?? "");
  if (!/\b(insert|update|nextval)\b/i.test(sql)) return rawQuery(text, params);
  return tx((client) => client.query(text, params));
};

/** The highest change number and partner message number a feed may hand out now. */
export async function feedLimit() {
  // The positions first, then the keys still held: a write that took its number before the first read still holds its
  // key at the second, because the key goes only when the row is committed and visible.
  const p = (await rawQuery(`SELECT (SELECT last_value FROM change_seq) AS change, (SELECT last_value FROM partner_messages_seq_seq) AS partner`)).rows[0];
  const held = (
    await rawQuery(
      `SELECT classid, min(objid) AS low FROM pg_locks
       WHERE locktype = 'advisory' AND objsubid = 2 AND classid IN ($1::int, $2::int)
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       GROUP BY classid`,
      [KEYSPACE.change, KEYSPACE.partner],
    )
  ).rows;
  let change = BigInt(p.change);
  let partner = BigInt(p.partner);
  latest = { change: change > latest.change ? change : latest.change, partner: partner > latest.partner ? partner : latest.partner };
  for (const h of held) {
    const low = BigInt(h.low);
    if (Number(h.classid) === KEYSPACE.change && low < change) change = low;
    if (Number(h.classid) === KEYSPACE.partner && low < partner) partner = low;
  }
  for (const m of open) {
    if (m.change < change) change = m.change;
    if (m.partner < partner) partner = m.partner;
  }
  return { change: change.toString(), partner: partner.toString() };
}

export async function migrate(dir) {
  await q(`CREATE TABLE IF NOT EXISTS hub_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await q(`SELECT name FROM hub_migrations`)).rows.map((r) => r.name));
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    // No hold: on a fresh database the sequences don't exist yet, and no migration writes rows that feeds page.
    await tx(
      async (c) => {
        await c.query(sql);
        await c.query(`INSERT INTO hub_migrations (name) VALUES ($1)`, [name]);
      },
      { hold: false },
    );
    console.log(`migration applied: ${name}`);
  }
}

export async function getSetting(key) {
  return (await one(`SELECT value FROM settings WHERE key = $1`, [key]))?.value ?? null;
}

export async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
