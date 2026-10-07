// Database connection and migrations (migrations/*.sql, applied in order, each once).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const SSL = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL ?? 8),
  ssl: SSL,
});
// An idle connection the database drops (a restart, maintenance, a proxy's idle timeout) is reported here and replaced
// on the next query. Without a listener the error would stop the whole hub.
pool.on("error", (e) => console.error("database connection lost:", e.message));
// The same for a connection the database drops while a request is using it (a restart, a statement timeout, a proxy):
// that request fails, and the client also reports it as an 'error' event, which stops the whole hub when nothing
// listens. The pool listens only while a connection is idle, so every connection gets a listener of its own.
pool.on("connect", (client) => client.on("error", (e) => console.error("database connection lost while in use:", e.message)));

export const q = (text, params) => pool.query(text, params);

export async function one(text, params) {
  return (await pool.query(text, params)).rows[0] ?? null;
}

/**
 * SQL that is true for a hub shop (the shops row aliased `s`) that pays its own way: a subscription running and not taken
 * back, or the admin's comp. The per-install limits (backup space, free plate reads) count only the other companies, so a
 * hosted service's paying companies never share one install's allowance.
 */
export const paysOwnWay = (s) =>
  `(coalesce(${s}.comp_until > now(), false) OR EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.shop_id = ${s}.id AND sub.status IN ('active', 'trialing', 'past_due') AND sub.unpaid_since IS NULL))`;

export async function tx(fn) {
  // Noted before a connection is taken: a hub still waiting for the writer lock refuses here, with nothing to give back.
  const release = holdFeeds();
  const client = await pool.connect().catch((e) => {
    release();
    throw e;
  });
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
// takes will be higher), and a feed only hands out rows below the lowest note still open. The notes live in this
// process, so exactly one hub process may serve a database (railway.json says numReplicas 1; the README says the
// same): a second one could hand out a number the first still holds. The writer lock below enforces it.
const open = new Set();
let latest = { change: 0n, partner: 0n }; // where the sequences were when last read: never ahead of where they are

// The last number a sequence has handed out. A sequence nothing has used yet (a new hub), or one set to carry on from
// a number (setval with is_called false), shows the number it will hand out next as its last_value: one less is the
// last one out, or a feed would hand out the first write's number while that write is still open.
const lastOut = (seq) => `(SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM ${seq})`;

async function positions() {
  const r = (await rawQuery(`SELECT ${lastOut("change_seq")} AS change, ${lastOut("partner_messages_seq_seq")} AS partner`)).rows[0];
  const now = { change: BigInt(r.change), partner: BigInt(r.partner) };
  latest = { change: now.change > latest.change ? now.change : latest.change, partner: now.partner > latest.partner ? now.partner : latest.partner };
  return now;
}

/**
 * Before a write: feeds stay below the numbers it may take until release() (called when it has committed or failed).
 * Throws a 503 while this hub waits for the writer lock (another hub process still serves the database).
 */
export function holdFeeds() {
  if (writer === false) throw restarting();
  const mark = { ...latest };
  open.add(mark);
  return () => open.delete(mark);
}

// Single statements through the pool that may take a number are noted the same way.
const rawQuery = pool.query.bind(pool);
pool.query = (text, params) => {
  const sql = typeof text === "string" ? text : (text?.text ?? "");
  if (!/\b(insert|update|nextval)\b/i.test(sql)) return rawQuery(text, params);
  let release;
  try {
    release = holdFeeds();
  } catch (e) {
    return Promise.reject(e);
  }
  return rawQuery(text, params).finally(release);
};

// ----- one writer -----
// Enforced, not only stated: at start a hub takes a lock in the database on a connection of its own and keeps it
// while it runs. A second hub on the same database (a deploy that overlaps the old one, a second replica, an
// `npm start` beside the container) can't take it and tries again every second. Until it has it, its writes and
// feeds answer 503 ("restarting") while /health and plain reads go on, so the platform can finish a deploy and stop
// the old process, which lets the lock go. Migrations, scripts and tests that use the database without starting the
// feeds aren't held to it (migrations take a lock of their own).
const WRITER_LOCK = "stitchhub:writer";
let writer = null; // null: feeds not started; false: waiting for the lock (or stopped); true: holding it
let lockClient = null; // the connection that holds it
let trying = false;
let stopped = false;
let timers = [];

function restarting() {
  const e = new Error("The hub is restarting. Try again in a moment.");
  e.status = 503;
  e.expose = true;
  return e;
}

/** The connection holding (or trying for) the lock failed: the lock is gone with it, so writes wait until it's back. */
function lostWriterLock(c, e) {
  if (!c || c !== lockClient) return;
  lockClient = null;
  c.end().catch(() => {});
  if (writer === true) console.error(`lost the database connection that holds the writer lock${e ? ` (${e.message})` : ""}: writes and feeds wait until it is back`);
  writer = false;
}

async function takeWriterLock() {
  if (trying || stopped || writer !== false) return;
  trying = true;
  let c = lockClient;
  try {
    if (!c) {
      c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: SSL, keepAlive: true, query_timeout: 10_000 });
      c.on("error", (e) => lostWriterLock(c, e));
      c.on("end", () => lostWriterLock(c));
      lockClient = c;
      await c.connect();
    }
    const got = (await c.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, [WRITER_LOCK])).rows[0].got;
    if (got && !stopped && c === lockClient) writer = true;
  } catch (e) {
    lostWriterLock(c, e);
  } finally {
    trying = false;
  }
}

/** Keep the noted positions fresh (after migrations), and take the writer lock (or wait for it). */
export async function startFeeds() {
  await positions();
  writer = false;
  stopped = false;
  await takeWriterLock();
  if (!writer) console.log("another StitchHub process is serving this database: waiting for it to stop (until then writes and feeds answer 503)");
  let ticks = 0;
  timers = [
    setInterval(() => positions().catch(() => {}), 1000),
    setInterval(() => {
      if (writer === false) {
        const waited = !trying;
        takeWriterLock().then(() => waited && writer && console.log("this StitchHub process now serves the database"));
      } else if (++ticks % 10 === 0 && lockClient) {
        // A connection that died quietly would hold nothing: ask it something now and then.
        const c = lockClient;
        c.query(`SELECT 1`).catch((e) => lostWriterLock(c, e));
      }
    }, 1000),
  ];
  for (const t of timers) t.unref();
}

/** True while this process holds the writer lock (startFeeds took it). */
export const holdsWriterLock = () => writer === true;

/** Let the writer lock go (a stop, or a test): writes and feeds answer 503 from then on. */
export async function stopFeeds() {
  stopped = true;
  for (const t of timers) clearInterval(t);
  timers = [];
  writer = false;
  const c = lockClient;
  lockClient = null;
  if (c) await c.end().catch(() => {});
}

/** The highest change number and partner message number a feed may hand out now. */
export async function feedLimit() {
  if (writer === false) throw restarting();
  let { change, partner } = await positions();
  for (const m of open) {
    if (m.change < change) change = m.change;
    if (m.partner < partner) partner = m.partner;
  }
  return { change: change.toString(), partner: partner.toString() };
}

/**
 * After an import, the numbers between the end of the export and where this hub carries on were never handed out. An
 * install whose place in a feed ("change" or "partner") is among them had synced past the export (a backup older than
 * its last sync): that feed starts over for it, or it would skip everything numbered in between.
 */
export async function staleCursor(feed, since) {
  const gaps = JSON.parse((await getSetting("feed_gaps")) ?? "{}")[feed] ?? [];
  const n = BigInt(since);
  return gaps.some(([after, upTo]) => n > BigInt(after) && n <= BigInt(upTo));
}

export async function migrate(dir) {
  // The database may still be starting (docker compose starts both together) or restarting: wait up to a minute.
  for (let i = 0; ; i++) {
    try {
      await q(`SELECT 1`);
      break;
    } catch (e) {
      if (i >= 30) throw e;
      console.log(`waiting for the database: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // One process applies the migrations at a time. Two hubs starting together on one database (a second replica, an
  // overlapping deploy, a `npm start` beside the container) would both try the same file, and the loser would crash
  // on the tables the winner just made. The lock is held on its own connection; the second one waits, then finds
  // everything done.
  const lock = await pool.connect();
  try {
    for (let i = 0; !(await lock.query(`SELECT pg_try_advisory_lock(hashtext('stitchhub:migrate')) AS got`)).rows[0].got; i++) {
      if (i >= 60) throw new Error("another StitchHub process has been applying migrations for over two minutes");
      if (i === 0) console.log("another StitchHub process is applying migrations: waiting for it");
      await new Promise((r) => setTimeout(r, 2000));
    }
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
  } finally {
    // A connection that may still hold the lock is closed rather than handed back to the pool.
    const unlocked = await lock.query(`SELECT pg_advisory_unlock(hashtext('stitchhub:migrate'))`).then(() => true, () => false);
    lock.release(!unlocked);
  }
}

export async function getSetting(key) {
  return (await one(`SELECT value FROM settings WHERE key = $1`, [key]))?.value ?? null;
}

export async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
