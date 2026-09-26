// Moving a hub: export everything to one file (gzipped JSON lines) and import it on a new server.
// Keeps members working: installs (their hashed keys), the join key, links with history, notes, photos, figures,
// data sets, the parts cross-reference with its history, marketplace listings, orders and ratings, parts usage, and the
// partner links between repair shops and sewing shops with their messages and open invitations.
// Every row keeps its change number (seq) and the sequences carry on past the old hub's, so installs keep their
// place in the change, order and partner-message feeds after a move.
import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pool, q, holdFeeds } from "./db.mjs";

// In import order (parents before children). `key` pages the export; `conflict` is the primary key.
const TABLES = [
  { t: "setting", table: "settings", cols: ["key", "value"], key: "key" },
  { t: "install", table: "installs", cols: ["id", "name", "contact", "key_hash", "scope", "blocked", "created_at", "last_seen_at"] },
  {
    t: "link",
    table: "links",
    cols: ["id", "category", "brand", "models", "model_keys", "doc_type", "title", "file_name", "url", "source", "status", "http_status", "checked_at", "fail_count", "deleted", "created_at", "updated_at"],
  },
  { t: "revision", table: "link_revisions", cols: ["id", "link_id", "action", "brand", "models", "doc_type", "title", "url", "by_name", "by_shop", "install_id", "note", "created_at"] },
  { t: "post", table: "posts", cols: ["id", "install_id", "shop_name", "author_name", "brand", "model", "model_key", "kind", "title", "body", "deleted", "created_at", "updated_at"] },
  { t: "photo", table: "photos", cols: ["id", "post_id", "kind", "caption", "mime", "data", "sort_order"] },
  { t: "figure", table: "figures", cols: ["id", "mime", "data", "width", "height", "install_id", "created_at"] },
  { t: "dataset", table: "datasets", cols: ["name", "version", "data", "updated_at"], key: "name" },
  { t: "xpart", table: "xparts", cols: ["id", "name", "kind", "category", "specs", "notes", "deleted", "created_at", "updated_at"] },
  {
    t: "xpart_number",
    table: "xpart_numbers",
    cols: ["xpart_id", "brand", "number", "brand_key", "number_key"],
    key: "brand_key || '|' || number_key",
    conflict: ["brand_key", "number_key"],
  },
  {
    t: "xpart_fit",
    table: "xpart_fits",
    cols: ["xpart_id", "brand", "model", "brand_key", "model_key", "evidence", "source"],
    key: "xpart_id || '|' || brand_key || '|' || model_key",
    conflict: ["xpart_id", "brand_key", "model_key"],
  },
  { t: "xpart_source", table: "xpart_sources", cols: ["id", "xpart_id", "vendor", "url", "price_cents", "currency", "note", "by_shop", "updated_at"] },
  { t: "xpart_revision", table: "xpart_revisions", cols: ["id", "xpart_id", "action", "snapshot", "by_name", "by_shop", "install_id", "note", "created_at"] },
  {
    t: "listing",
    table: "listings",
    cols: ["id", "install_id", "shop_name", "title", "description", "kind", "condition", "brand", "part_number", "xpart_id", "fits", "price_cents", "currency", "qty", "shipping_cents", "shipping_note", "ships_from", "status", "created_at", "updated_at"],
  },
  { t: "listing_photo", table: "listing_photos", cols: ["id", "listing_id", "mime", "data", "sort_order"] },
  {
    t: "order",
    table: "orders",
    cols: [
      "id", "number", "listing_id", "seller_install_id", "buyer_install_id", "seller_shop", "buyer_shop", "item", "qty", "unit_price_cents",
      "shipping_cents", "currency", "ship_to", "buyer_note", "buyer_contact", "seller_contact", "pay_instructions", "status", "buyer_paid_note",
      "paid_at", "carrier", "tracking", "shipped_at", "received_at", "cancel_reason", "created_at", "updated_at",
    ],
  },
  { t: "order_event", table: "order_events", cols: ["id", "order_id", "by_role", "action", "note", "created_at"] },
  {
    t: "order_rating",
    table: "order_ratings",
    cols: ["order_id", "by_role", "rater_install_id", "rated_install_id", "stars", "comment", "created_at", "updated_at"],
    key: "order_id || '|' || by_role",
    conflict: ["order_id", "by_role"],
  },
  {
    t: "usage",
    table: "part_usage",
    cols: ["install_id", "month", "number_key", "number", "brand", "qty", "tickets", "updated_at"],
    key: "install_id || '|' || month || '|' || number_key",
    conflict: ["install_id", "month", "number_key"],
  },
  {
    t: "partner_link",
    table: "partner_links",
    cols: ["id", "repair_install_id", "repair_shop_ref", "repair_name", "retail_install_id", "retail_shop_ref", "retail_name", "terms", "status", "created_at", "ended_at"],
  },
  {
    t: "partner_invite",
    table: "partner_invites",
    cols: ["code_hash", "install_id", "shop_ref", "shop_name", "side", "terms", "expires_at", "used_at", "link_id", "created_at"],
    key: "code_hash",
  },
  {
    // In the order they were sent, with their numbers (an export from before version 3 has none: numbered again).
    t: "partner_message",
    table: "partner_messages",
    cols: ["id", "link_id", "from_side", "type", "data", "created_at"],
    key: "lpad(seq::text, 20, '0')",
    conflict: ["link_id", "from_side", "id"],
    json: ["data"],
    seq: "own",
  },
];
const BINARY = new Set(["data"]);
const JSONB = new Set(["snapshot", "item", "buyer_contact", "seller_contact", "terms"]);
// Tables whose rows carry a number from change_seq (the change feed); partner_messages has its own sequence.
const WITH_SEQ = new Set(["links", "posts", "figures", "xparts", "listings", "orders"]);
const hasSeq = (spec) => WITH_SEQ.has(spec.table) || spec.seq === "own";

async function* lines() {
  const seqs = (await q(`SELECT (SELECT last_value FROM change_seq) AS change, (SELECT last_value FROM partner_messages_seq_seq) AS partner`)).rows[0];
  yield JSON.stringify({ t: "meta", format: "stitchhub-export", version: 3, exportedAt: new Date().toISOString(), changeSeq: seqs.change, partnerSeq: seqs.partner }) + "\n";
  for (const spec of TABLES) {
    const { t, table, key = "id", json = [] } = spec;
    const cols = hasSeq(spec) ? [...spec.cols, "seq"] : spec.cols;
    let after = "";
    for (;;) {
      const { rows } = await q(`SELECT ${cols.join(", ")}, (${key}) AS _k FROM ${table} WHERE (${key}) > $1 ORDER BY (${key}) LIMIT 200`, [after]);
      if (!rows.length) break;
      after = rows[rows.length - 1]._k;
      for (const r of rows) {
        delete r._k;
        for (const c of cols) if (BINARY.has(c) && !json.includes(c) && r[c]) r[c] = r[c].toString("base64");
        yield JSON.stringify({ t, ...r }) + "\n";
      }
    }
  }
}

/** A web stream of the whole hub, gzipped. */
export function exportStream() {
  return Readable.toWeb(Readable.from(lines()).pipe(zlib.createGzip()));
}

/** Load an export into this hub. Existing rows with the same key are replaced. */
export async function importStream(webStream) {
  const byType = Object.fromEntries(TABLES.map((s) => [s.t, s]));
  const counts = {};
  const meta = {};
  const client = await pool.connect();
  const release = holdFeeds(); // members' feeds wait until the import has committed
  try {
    await client.query("BEGIN");
    // Start reading only now: readline drops lines that arrive before its iterator is being consumed,
    // so creating it before the awaits above lost the first rows of an upload that was already buffered.
    const input = Readable.fromWeb(webStream).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.t === "meta") {
        if (row.format !== "stitchhub-export") throw new Error("Not a StitchHub export file.");
        Object.assign(meta, row);
        continue;
      }
      const spec = byType[row.t];
      if (!spec) continue;
      const { table, cols } = spec;
      const conflict = spec.conflict ?? [spec.key ?? "id"];
      const vals = cols.map((c) => {
        const v = row[c] ?? null;
        if (v == null) return null;
        if (JSONB.has(c) || spec.json?.includes(c)) return JSON.stringify(v);
        if (BINARY.has(c)) return Buffer.from(v, "base64");
        return v;
      });
      // The row's own change number when the export has it (version 3); a new one otherwise.
      const kept = hasSeq(spec) && row.seq != null;
      const colList = kept || WITH_SEQ.has(table) ? [...cols, "seq"] : cols;
      const params = cols.map((_, i) => `$${i + 1}`);
      if (kept) {
        vals.push(String(row.seq));
        params.push(`$${vals.length}`);
      } else if (WITH_SEQ.has(table)) params.push("nextval('change_seq')");
      const updates = colList.filter((c) => !conflict.includes(c) && !(spec.seq === "own" && c === "seq")).map((c) => `${c} = EXCLUDED.${c}`);
      await client.query(
        `INSERT INTO ${table} (${colList.join(", ")}) VALUES (${params.join(", ")})
         ON CONFLICT (${conflict.join(", ")}) ${updates.length ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING"}`,
        vals,
      );
      counts[table] = (counts[table] ?? 0) + 1;
    }
    // New change and partner-message numbers carry on after the old hub's, so no install's place is behind them.
    await client.query(
      `SELECT setval('change_seq', greatest($1::bigint, (SELECT last_value FROM change_seq),
         (SELECT max(seq) FROM links), (SELECT max(seq) FROM posts), (SELECT max(seq) FROM figures),
         (SELECT max(seq) FROM xparts), (SELECT max(seq) FROM listings), (SELECT max(seq) FROM orders), 1))`,
      [String(meta.changeSeq ?? 0)],
    );
    await client.query(
      `SELECT setval('partner_messages_seq_seq', greatest($1::bigint, (SELECT last_value FROM partner_messages_seq_seq), (SELECT max(seq) FROM partner_messages), 1))`,
      [String(meta.partnerSeq ?? 0)],
    );
    // New order numbers carry on after the imported ones.
    await client.query(
      `SELECT setval('order_number_seq', greatest((SELECT max(substring(number from 4)::bigint) FROM orders WHERE number ~ '^SH-[0-9]+$'), (SELECT last_value FROM order_number_seq), 1))`,
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    release();
    client.release();
  }
  return counts;
}
