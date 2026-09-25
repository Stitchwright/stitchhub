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
  try {
    await client.query("BEGIN");
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
