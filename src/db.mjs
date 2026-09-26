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

export async function tx(fn) {
  const client = await pool.connect();
  const release = holdFeeds();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    release();
    client.release();
  }
}

// ----- safe feed positions -----
// The change feeds (/v1/changes, /v1/orders, partner messages) page by numbers taken from a sequence when a row is
// written, which is before its transaction commits. If an install read past a number still held by an open
// transaction, it would never get that row. So every write here first notes where the sequences were (any number it
// takes will be higher), and a feed only hands out rows below the lowest note still open. One hub process writes the
// database (Railway runs one), so it sees every write.
const open = new Set();
let latest = { change: 0n, partner: 0n }; // where the sequences were when last read: never ahead of where they are

async function positions() {
  const r = (await rawQuery(`SELECT (SELECT last_value FROM change_seq) AS change, (SELECT last_value FROM partner_messages_seq_seq) AS partner`)).rows[0];
  const now = { change: BigInt(r.change), partner: BigInt(r.partner) };
  latest = { change: now.change > latest.change ? now.change : latest.change, partner: now.partner > latest.partner ? now.partner : latest.partner };
  return now;
}

/** Before a write: feeds stay below the numbers it may take until release() (called when it has committed or failed). */
export function holdFeeds() {
  const mark = { ...latest };
  open.add(mark);
  return () => open.delete(mark);
}

// Single statements through the pool that may take a number are noted the same way.
const rawQuery = pool.query.bind(pool);
pool.query = (text, params) => {
  const sql = typeof text === "string" ? text : (text?.text ?? "");
  if (!/\b(insert|update|nextval)\b/i.test(sql)) return rawQuery(text, params);
  const release = holdFeeds();
  return rawQuery(text, params).finally(release);
};

/** Keep the noted positions fresh (after migrations). */
export async function startFeeds() {
  await positions();
  setInterval(() => positions().catch(() => {}), 1000).unref();
}

/** The highest change number and partner message number a feed may hand out now. */
export async function feedLimit() {
  let { change, partner } = await positions();
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
    await tx(async (c) => {
      await c.query(sql);
      await c.query(`INSERT INTO hub_migrations (name) VALUES ($1)`, [name]);
    });
    console.log(`migration applied: ${name}`);
  }
}

export async function getSetting(key) {
  return (await one(`SELECT value FROM settings WHERE key = $1`, [key]))?.value ?? null;
}

export async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
