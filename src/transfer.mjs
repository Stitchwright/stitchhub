// Moving a hub: export everything to one file (gzipped JSON lines) and import it on a new server.
// Keeps members working: installs (their hashed keys), the join key, links with history, notes, photos, figures, data sets.
import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pool, q } from "./db.mjs";

const TABLES = [
  // [type, table, columns]; binary columns are sent as base64
  ["setting", "settings", ["key", "value"]],
  ["install", "installs", ["id", "name", "contact", "key_hash", "blocked", "created_at", "last_seen_at"]],
  ["link", "links", ["id", "category", "brand", "models", "model_keys", "doc_type", "title", "file_name", "url", "source", "status", "http_status", "checked_at", "fail_count", "deleted", "created_at", "updated_at"]],
  ["revision", "link_revisions", ["id", "link_id", "action", "brand", "models", "doc_type", "title", "url", "by_name", "by_shop", "install_id", "note", "created_at"]],
  ["post", "posts", ["id", "install_id", "shop_name", "author_name", "brand", "model", "model_key", "kind", "title", "body", "deleted", "created_at", "updated_at"]],
  ["photo", "photos", ["id", "post_id", "kind", "caption", "mime", "data", "sort_order"]],
  ["figure", "figures", ["id", "mime", "data", "width", "height", "install_id", "created_at"]],
  ["dataset", "datasets", ["name", "version", "data", "updated_at"]],
];
const BINARY = new Set(["data"]);
const KEY = { settings: "key", datasets: "name" };
const WITH_SEQ = new Set(["links", "posts", "figures"]);

async function* lines() {
  yield JSON.stringify({ t: "meta", format: "stitchhub-export", version: 1, exportedAt: new Date().toISOString() }) + "\n";
  for (const [t, table, cols] of TABLES) {
    const key = KEY[table] ?? "id";
    let after = "";
    for (;;) {
      const { rows } = await q(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${key} > $1 ORDER BY ${key} LIMIT 200`, [after]);
      if (!rows.length) break;
      for (const r of rows) {
        for (const c of cols) if (BINARY.has(c) && r[c]) r[c] = r[c].toString("base64");
        yield JSON.stringify({ t, ...r }) + "\n";
      }
      after = rows[rows.length - 1][key];
    }
  }
}

/** A web stream of the whole hub, gzipped. */
export function exportStream() {
  return Readable.toWeb(Readable.from(lines()).pipe(zlib.createGzip()));
}

/** Load an export into this hub. Existing rows with the same id are replaced. */
export async function importStream(webStream) {
  const input = Readable.fromWeb(webStream).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const byType = Object.fromEntries(TABLES.map(([t, table, cols]) => [t, { table, cols }]));
  const counts = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.t === "meta") {
        if (row.format !== "stitchhub-export") throw new Error("Not a StitchHub export file.");
        continue;
      }
      const spec = byType[row.t];
      if (!spec) continue;
      const { table, cols } = spec;
      const vals = cols.map((c) => (BINARY.has(c) && row[c] != null ? Buffer.from(row[c], "base64") : (row[c] ?? null)));
      const key = KEY[table] ?? "id";
      const colList = WITH_SEQ.has(table) ? [...cols, "seq"] : cols;
      const params = cols.map((_, i) => `$${i + 1}`);
      if (WITH_SEQ.has(table)) params.push("nextval('change_seq')");
      const updates = colList.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`);
      await client.query(
        `INSERT INTO ${table} (${colList.join(", ")}) VALUES (${params.join(", ")}) ON CONFLICT (${key}) DO UPDATE SET ${updates.join(", ")}`,
        vals,
      );
      counts[table] = (counts[table] ?? 0) + 1;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return counts;
}
