// Moving a hub: export everything to one file (gzipped JSON lines) and import it on a new server.
// Keeps members working: installs (their hashed keys), the join key, links with history, notes, photos, figures,
// data sets, the parts cross-reference with its history, marketplace listings, orders and ratings, parts usage, and the
// partner links between repair shops and sewing shops with their messages and open invitations.
// Into an empty hub every row keeps its change number (seq) and the sequences carry on well past the old hub's, so
// installs keep their place in the change, order and partner-message feeds after a move. Into a hub already in use,
// imported rows are numbered after its own, so every install receives them.
import zlib from "node:zlib";
import { Readable, pipeline } from "node:stream";
import { pool, holdFeeds } from "./db.mjs";

// In import order (parents before children). `key` pages the export; `conflict` is the primary key.
export const TABLES = [
  { t: "setting", table: "settings", cols: ["key", "value"], key: "key" },
  { t: "install", table: "installs", cols: ["id", "name", "contact", "key_hash", "scope", "blocked", "invited_by", "created_at", "last_seen_at", "repo_uploads_off"] },
  // Shop owners' accounts (hashed passwords), their shops with standing, the links and codes out (hashed), and signed-in
  // browsers: a move keeps everyone signed in and every link they were sent working.
  { t: "account", table: "accounts", cols: ["id", "email", "password_hash", "verified_at", "terms_version", "terms_at", "stripe_customer_id", "disabled", "created_at", "last_sign_in_at", "founding_at", "founding_gap_since", "founding_lost_at", "repo_uploads_off"] },
  {
    t: "shop",
    table: "shops",
    cols: ["id", "install_id", "shop_ref", "name", "kind", "program", "version", "account_id", "comp_until", "comp_note", "lapsed_at", "reset_opt_in", "created_at", "last_seen_at"],
  },
  // Companies moving between installs: the move tokens out (hashed) and the record of each move, so a company's old
  // install still hears where it went after the hub itself moved (src/moves.mjs).
  {
    t: "shop_move",
    table: "shop_moves",
    cols: ["id", "shop_id", "shop_ref", "token_hash", "from_install_id", "to_install_id", "expires_at", "used_at", "cancelled_at", "by_admin", "moved", "created_at"],
    json: ["moved"],
  },
  // Password resets asked for on an account for a Windows install (signed grants, public, one use), and the hosted shops
  // accounts started (src/provisioning.mjs): a moved hub still knows what was asked and answered.
  {
    t: "reset_grant",
    table: "reset_grants",
    cols: ["id", "shop_id", "account_id", "email", "nonce", "grant_text", "expires_at", "fetched_at", "used_at", "result", "why", "created_at"],
  },
  { t: "hosted_start", table: "hosted_starts", cols: ["id", "account_id", "program", "shop_name", "kind", "shop_ref", "install_id", "shop_id", "error", "created_at"] },
  // Each time an account accepted the terms (src/terms.mjs): which version, how, and for a Checkout the shop and session.
  { t: "terms_acceptance", table: "terms_acceptances", cols: ["id", "account_id", "version", "via", "shop_id", "checkout_id", "created_at"] },
  { t: "account_token", table: "account_tokens", cols: ["token_hash", "kind", "account_id", "shop_id", "expires_at", "used_at", "created_at"], key: "token_hash" },
  { t: "session", table: "sessions", cols: ["id_hash", "account_id", "created_at", "last_seen_at", "expires_at"], key: "id_hash" },
  // Billing: each shop's subscription as Stripe last reported it, the webhook events handled (a replay on the new hub
  // does nothing either), and every key the hub signed (the program keeps working on a moved hub; a kid can be retired).
  {
    t: "subscription",
    table: "subscriptions",
    cols: ["shop_id", "stripe_subscription_id", "stripe_customer_id", "plan", "status", "current_period_end", "cancel_at_period_end", "unpaid_since", "disputed_at", "mailed", "created_at", "updated_at", "tier", "founding", "price_id", "unpaid_charge_id", "refunded_in_trial", "inquiry_at", "inquiry_dispute_ids", "chargeback_dispute_ids"],
    key: "shop_id",
    json: ["mailed"],
  },
  // The Assistant's own subscription per shop and its paid top-ups (src/assistant-billing.mjs).
  {
    t: "assistant_subscription",
    table: "assistant_subscriptions",
    cols: ["shop_id", "stripe_subscription_id", "stripe_customer_id", "stripe_created", "plan", "status", "current_period_end", "cancel_at_period_end", "price_id", "created_at", "updated_at", "unpaid_since", "unpaid_charge_id"],
    key: "shop_id",
  },
  { t: "assistant_topup", table: "assistant_topups", cols: ["stripe_session_id", "shop_id", "calls", "month", "created_at", "stripe_payment_intent", "calls_taken"], key: "stripe_session_id" },
  { t: "stripe_event", table: "stripe_events", cols: ["id", "type", "received_at"] },
  { t: "license_issue", table: "license_issues", cols: ["key_id", "shop_id", "kid", "plan", "modules", "first_day", "last_day", "grace_days", "key", "issued_at", "revoked_at", "tier", "founding"], key: "key_id" },
  // Off-site backups (src/backups.mjs): the index of what each company has in the bucket (the bytes stay there).
  {
    t: "backup_object",
    table: "backup_objects",
    cols: ["shop_id", "name", "kind", "size", "sha256", "created_at", "confirmed_at", "deleted_at"],
    key: "shop_id || '|' || name",
    conflict: ["shop_id", "name"],
  },
  // The manual repository (src/repository.mjs): the manuals shops see (numbered in the change sequence, which the
  // repository feed pages by), the files in R2 by hash (the bytes stay in the bucket; a moved hub keeps the bucket), the
  // offers, the hashes that may not come back, and the download counts.
  {
    t: "manual",
    table: "manuals",
    cols: ["id", "category", "brand", "models", "model_keys", "doc_type", "year", "language", "title", "file_id", "origin", "source_url", "status", "why", "created_at", "updated_at"],
  },
  { t: "manual_file", table: "manual_files", cols: ["id", "sha256", "sha1", "size_bytes", "pages", "object_key", "status", "manual_id", "checks", "created_at", "updated_at"], json: ["checks"] },
  {
    t: "upload",
    table: "uploads",
    cols: ["id", "shop_id", "account_id", "install_id", "shop_ref", "by_name", "sha256", "size_bytes", "offered", "original_name", "statement_version", "statement_at", "state", "reason", "file_id", "manual_id", "created_at", "updated_at"],
    json: ["offered"],
  },
  // The takedown process (src/takedown.mjs): notices and counter-notices with their timelines, and the strikes.
  {
    t: "takedown_notice",
    table: "takedown_notices",
    cols: ["id", "kind", "parent_id", "via", "status", "missing", "complainant", "work", "locations", "statements", "signature", "raw_text", "manual_ids", "file_ids", "account_id", "reason", "received_at", "actioned_at", "countered_at", "restore_earliest", "restore_latest", "reminded_at", "restored_at", "closed_at", "notes", "updated_at"],
    json: ["complainant", "statements", "notes"],
  },
  { t: "strike", table: "strikes", cols: ["id", "account_id", "install_id", "shop_id", "notice_id", "file_id", "created_at", "withdrawn_at"] },
  { t: "blocked_hash", table: "blocked_hashes", cols: ["sha256", "why", "notice_id", "file_id", "created_at", "lifted_at"], key: "sha256" },
  {
    t: "repo_download",
    table: "repo_downloads",
    cols: ["file_id", "day", "who", "n"],
    key: "file_id || '|' || day || '|' || who",
    conflict: ["file_id", "day", "who"],
  },
  {
    t: "link",
    table: "links",
    cols: ["id", "category", "brand", "models", "model_keys", "doc_type", "title", "file_name", "url", "source", "status", "http_status", "checked_at", "fail_count", "deleted", "created_at", "updated_at"],
  },
  { t: "revision", table: "link_revisions", cols: ["id", "link_id", "action", "brand", "models", "doc_type", "title", "url", "by_name", "by_shop", "install_id", "note", "created_at", "shop_ref", "shop_name"] },
  { t: "post", table: "posts", cols: ["id", "install_id", "client_id", "shop_name", "shop_ref", "author_name", "brand", "model", "model_key", "kind", "title", "body", "deleted", "created_at", "updated_at"] },
  { t: "photo", table: "photos", cols: ["id", "post_id", "kind", "caption", "mime", "data", "sort_order"] },
  { t: "figure", table: "figures", cols: ["id", "mime", "data", "width", "height", "install_id", "shop_ref", "deleted", "created_at"] },
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
  { t: "xpart_source", table: "xpart_sources", cols: ["id", "xpart_id", "vendor", "url", "price_cents", "currency", "note", "by_shop", "shop_ref", "shop_name", "updated_at"] },
  { t: "xpart_revision", table: "xpart_revisions", cols: ["id", "xpart_id", "action", "snapshot", "by_name", "by_shop", "install_id", "note", "merged_from", "created_at", "shop_ref", "shop_name"] },
  {
    t: "listing",
    table: "listings",
    cols: ["id", "install_id", "shop_name", "shop_ref", "client_id", "title", "description", "kind", "condition", "origin", "brand", "part_number", "xpart_id", "fits", "price_cents", "currency", "qty", "shipping_cents", "shipping_note", "ships_from", "status", "created_at", "updated_at"],
  },
  { t: "listing_photo", table: "listing_photos", cols: ["id", "listing_id", "mime", "data", "sort_order"] },
  {
    t: "order",
    table: "orders",
    cols: [
      "id", "number", "listing_id", "seller_install_id", "buyer_install_id", "seller_shop", "buyer_shop", "seller_shop_ref", "buyer_shop_ref", "client_id", "item", "qty", "unit_price_cents",
      "shipping_cents", "currency", "ship_to", "buyer_note", "buyer_contact", "seller_contact", "pay_instructions", "status", "buyer_paid_note",
      "paid_at", "carrier", "tracking", "shipped_at", "received_at", "cancel_reason", "created_at", "updated_at",
    ],
  },
  { t: "order_event", table: "order_events", cols: ["id", "order_id", "by_role", "action", "note", "created_at"] },
  {
    t: "order_rating",
    table: "order_ratings",
    cols: ["order_id", "by_role", "rater_install_id", "rated_install_id", "rater_shop_ref", "rated_shop_ref", "stars", "comment", "created_at", "updated_at"],
    key: "order_id || '|' || by_role",
    conflict: ["order_id", "by_role"],
  },
  {
    t: "usage",
    table: "part_usage",
    cols: ["install_id", "shop_ref", "month", "number_key", "number", "brand", "qty", "tickets", "updated_at"],
    key: "install_id || '|' || shop_ref || '|' || month || '|' || number_key",
    conflict: ["install_id", "shop_ref", "month", "number_key"],
  },
  {
    t: "partner_link",
    table: "partner_links",
    cols: ["id", "repair_install_id", "repair_shop_ref", "repair_name", "retail_install_id", "retail_shop_ref", "retail_name", "terms", "status", "created_at", "ended_at", "repair_key", "repair_proof", "retail_key", "retail_proof"],
  },
  // The Assistant proxy's counts (src/assistant.mjs): tokens and cost per company and month, never any text.
  { t: "assistant_shop", table: "assistant_shops", cols: ["install_id", "shop_ref", "tz", "comp_until", "comp_note", "updated_at"], key: "install_id || '|' || shop_ref", conflict: ["install_id", "shop_ref"] },
  {
    t: "assistant_usage",
    table: "assistant_usage",
    cols: ["install_id", "shop_ref", "month", "calls", "bonus", "free_reads", "input_tokens", "output_tokens", "cost_millicents", "updated_at"],
    key: "install_id || '|' || shop_ref || '|' || month",
    conflict: ["install_id", "shop_ref", "month"],
  },
  { t: "assistant_key_bind", table: "assistant_key_binds", cols: ["kid", "key_id", "install_id", "shop_ref", "created_at"], key: "kid || '|' || key_id", conflict: ["kid", "key_id"] },
  { t: "assistant_call", table: "assistant_calls", cols: ["id", "install_id", "shop_ref", "feature", "class", "model", "free", "input_tokens", "cache_tokens", "output_tokens", "cost_millicents", "ms", "error", "created_at"] },
  // The 30-day grace of the real-partnership rule (billing.mjs): after the links it hangs on.
  { t: "waiver_grace", table: "waiver_grace", cols: ["link_id", "since", "reason", "created_at"], key: "link_id" },
  {
    t: "partner_invite",
    table: "partner_invites",
    cols: ["code_hash", "install_id", "shop_ref", "shop_name", "side", "terms", "expires_at", "used_at", "link_id", "created_at", "pub_key", "invite_sig"],
    key: "code_hash",
  },
  {
    // In the order they were sent, with their numbers (an export from before version 3 has none: numbered again).
    t: "partner_message",
    table: "partner_messages",
    cols: ["id", "link_id", "from_side", "type", "data", "bytes", "created_at", "sig", "verified"],
    key: "lpad(seq::text, 20, '0')",
    conflict: ["link_id", "from_side", "id"],
    json: ["data", "sig"],
    seq: "own",
  },
];
const BINARY = new Set(["data"]);
const JSONB = new Set(["snapshot", "item", "buyer_contact", "seller_contact", "terms", "repair_proof", "retail_proof", "invite_sig"]);
// Tables whose rows carry a number from change_seq (the change feed); partner_messages has its own sequence.
const WITH_SEQ = new Set(["links", "posts", "figures", "xparts", "listings", "orders", "manuals"]);
const hasSeq = (spec) => WITH_SEQ.has(spec.table) || spec.seq === "own";

// An import reads the file line by line, and no more of it than these: a gzip a few hundred KB long can hold a single
// line of hundreds of MB (which would stop the hub for everyone), or a gigabyte of lines. A photo or a data set is one
// line of base64.
const MAX_LINE = 64 * 1024 * 1024;
const MAX_INFLATED = (Number(process.env.ADMIN_UPLOAD_MB) || 1024) * 16 * 1024 * 1024;

// How far past an export's numbers an import carries on: far more than a hub hands out in years (the link checker
// takes about 17,000 a day), so no install's place can be beyond it.
const GAP = "1000000000";

async function* lines() {
  const client = await pool.connect();
  let done = false;
  try {
    // One snapshot of every table: a row written while the file downloads (a new shop's first note) can't end up in
    // it without its parent, which would stop the import of this file.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const seqs = (await client.query(`SELECT (SELECT last_value FROM change_seq) AS change, (SELECT last_value FROM partner_messages_seq_seq) AS partner`)).rows[0];
    yield JSON.stringify({ t: "meta", format: "stitchhub-export", version: 3, exportedAt: new Date().toISOString(), changeSeq: seqs.change, partnerSeq: seqs.partner }) + "\n";
    for (const spec of TABLES) {
      const { t, table, key = "id", json = [] } = spec;
      const cols = hasSeq(spec) ? [...spec.cols, "seq"] : spec.cols;
      let after = "";
      for (;;) {
        const { rows } = await client.query(`SELECT ${cols.join(", ")}, (${key}) AS _k FROM ${table} WHERE (${key}) > $1 ORDER BY (${key}) LIMIT 200`, [after]);
        if (!rows.length) break;
        after = rows[rows.length - 1]._k;
        for (const r of rows) {
          delete r._k;
          for (const c of cols) if (BINARY.has(c) && !json.includes(c) && r[c]) r[c] = r[c].toString("base64");
          yield JSON.stringify({ t, ...r }) + "\n";
        }
      }
    }
    await client.query("COMMIT");
    done = true;
  } finally {
    // Also when the download stopped part way: the snapshot ends and the connection goes back (or is dropped if broken).
    const broken = !done && (await client.query("ROLLBACK").then(() => false, () => true));
    client.release(broken);
  }
}

/** A web stream of the whole hub, gzipped. */
export function exportStream() {
  // pipeline (not pipe): a download that stops part way stops reading the database too, and an error while reading
  // it (a dropped connection, a timeout) ends the download with an error instead of stopping the hub.
  return Readable.toWeb(pipeline(Readable.from(lines()), zlib.createGzip(), (e) => e && console.error("export stopped:", e.message)));
}

function refused(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

/** Why an import stopped, for the admin page: where in the file, and that nothing was imported. */
function importError(e, lineNo, table) {
  if (e.expose) return e; // too large, or not an export at all
  if (e.code === "Z_DATA_ERROR" || e.code === "Z_BUF_ERROR") return refused(400, "Nothing was imported: that file isn't a gzipped StitchHub export (.ndjson.gz).");
  if (e instanceof SyntaxError) return refused(400, `Nothing was imported: line ${lineNo} of the file isn't valid JSON.`);
  return refused(400, `Nothing was imported: line ${lineNo} of the file${table ? ` (${table})` : ""} was refused: ${e.message}`);
}

/** The lines of an inflated export. A line or a file past the limits above is refused. */
async function* linesOf(input) {
  let parts = [];
  let held = 0;
  let total = 0;
  for await (const chunk of input) {
    total += chunk.length;
    if (total > MAX_INFLATED) throw refused(413, "Nothing was imported: that file holds far more than an export can.");
    for (let start = 0; start < chunk.length; ) {
      const nl = chunk.indexOf(10, start);
      const end = nl < 0 ? chunk.length : nl;
      held += end - start;
      if (held > MAX_LINE) throw refused(413, `Nothing was imported: a line of the file is longer than ${MAX_LINE / 1024 / 1024} MB.`);
      parts.push(chunk.subarray(start, end));
      if (nl < 0) break;
      yield Buffer.concat(parts).toString("utf8");
      parts = [];
      held = 0;
      start = nl + 1;
    }
  }
  if (held) yield Buffer.concat(parts).toString("utf8");
}

// What the file may say, by the rules the live routes hold members to: a file handed over by someone else isn't
// trusted more than a member is. (Members' key hashes are what let them carry on after a move, so only import files
// from your own hub.)
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const webAddress = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};
const SETTINGS = {
  join_key: (v) => /^\S{8,}$/.test(v),
  discord_webhook: (v) => /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(v),
  discord_invite: (v) => /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(v),
  repo_refused_brands: (v) => {
    try {
      return Array.isArray(JSON.parse(v));
    } catch {
      return false;
    }
  },
  feed_gaps: (v) => {
    try {
      const g = JSON.parse(v);
      return Boolean(g) && typeof g === "object" && !Array.isArray(g);
    } catch {
      return false;
    }
  },
};

/** Throws why a row isn't taken. Returns false for a row that isn't one of the hub's own kind (skipped). */
function checkRow(table, row) {
  const refuse = (why) => {
    throw new Error(why);
  };
  if (table === "settings") {
    if (!Object.hasOwn(SETTINGS, row.key)) return false;
    row.value = String(row.value ?? "").trim();
    if (!SETTINGS[row.key](row.value)) refuse(`the setting ${row.key} has a value the hub wouldn't take`);
  } else if (table === "installs") {
    if (!/^[0-9a-f]{64}$/.test(row.key_hash ?? "")) refuse("a member's key must be a SHA-256 hash");
  } else if (table === "accounts") {
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(row.email ?? "")) refuse("an account needs an email address");
    if (row.password_hash != null && !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(row.password_hash)) refuse("an account's password must be a scrypt hash");
  } else if (table === "shop_moves") {
    if (row.token_hash != null && !/^[0-9a-f]{64}$/.test(row.token_hash)) refuse("a move token must be a SHA-256 hash");
  } else if (table === "account_tokens" || table === "sessions") {
    if (!/^[0-9a-f]{64}$/.test((table === "sessions" ? row.id_hash : row.token_hash) ?? "")) refuse("a token or session must be a SHA-256 hash");
  } else if (table === "manual_files") {
    if (!/^[0-9a-f]{64}$/.test(row.sha256 ?? "")) refuse("a manual file needs its sha-256");
    if (!/^(files|held|retired)\/[0-9a-f]{64}\.pdf$/.test(row.object_key ?? "")) refuse("a manual file's object key must be files/, held/ or retired/ and its hash");
  } else if (table === "blocked_hashes" || table === "uploads") {
    if (!/^[0-9a-f]{64}$/.test(row.sha256 ?? "")) refuse("a hash must be a SHA-256");
  } else if (table === "manuals") {
    if (row.source_url && !webAddress(row.source_url)) refuse("a maker mirror's source must start with http:// or https://");
  } else if (table === "links" || table === "link_revisions") {
    if (!webAddress(row.url)) refuse("a link must start with http:// or https://");
  } else if (table === "xpart_sources") {
    if (row.url && !webAddress(row.url)) refuse("a buying link must start with http:// or https://");
  } else if (["photos", "figures", "listing_photos"].includes(table) && !IMAGE.has(row.mime)) {
    refuse("a picture must be a JPEG, PNG or WebP");
  }
  return true;
}

/** Load an export into this hub. Existing rows with the same key are replaced. */
export async function importStream(webStream) {
  const byType = Object.fromEntries(TABLES.map((s) => [s.t, s]));
  const counts = {};
  const meta = {};
  const linkIds = new Map(); // an imported link whose address is already here under another id: merged into that one
  const release = holdFeeds(); // members' feeds wait until the import has committed (refuses while waiting for the writer lock)
  const client = await pool.connect().catch((e) => {
    release();
    throw e;
  });
  let lineNo = 0;
  let table = null;
  try {
    if (!webStream) throw refused(400, "Nothing was imported: send the export file as the request body.");
    await client.query("BEGIN");
    // An empty hub takes the export's numbers as they are, so installs keep their place after a move. A hub already in
    // use numbers imported rows after its own: kept numbers could be behind its installs' places (they would never get
    // those rows) or the same as rows already here (a page of changes would skip one of the two).
    const empty = (await client.query(`SELECT ${[...WITH_SEQ, "partner_messages"].map((t) => `NOT EXISTS (SELECT 1 FROM ${t})`).join(" AND ")} AS empty`)).rows[0].empty;
    // Start reading only now: readline drops lines that arrive before its iterator is being consumed,
    // so creating it before the awaits above lost the first rows of an upload that was already buffered.
    // pipeline (not pipe): an upload that breaks off or is too large stops the import instead of leaving it waiting.
    const input = pipeline(Readable.fromWeb(webStream), zlib.createGunzip(), () => {});
    for await (const line of linesOf(input)) {
      lineNo++;
      table = null;
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.t === "meta") {
        if (row.format !== "stitchhub-export") throw refused(400, "Nothing was imported: that isn't a StitchHub export file.");
        Object.assign(meta, row);
        // New numbers for the imported rows come after the old hub's too, so its members receive them wherever they were.
        if (!empty) {
          await client.query(
            `SELECT setval('change_seq', greatest($1::bigint, (SELECT last_value FROM change_seq))),
               setval('partner_messages_seq_seq', greatest($2::bigint, (SELECT last_value FROM partner_messages_seq_seq)))`,
            [String(meta.changeSeq ?? 0), String(meta.partnerSeq ?? 0)],
          );
        }
        continue;
      }
      const spec = byType[row.t];
      if (!spec) continue;
      if (!empty && row.t === "setting" && row.key === "feed_gaps") continue; // about the old hub's numbers, not this one's
      table = spec.table;
      if (!checkRow(table, row)) continue;
      if (table === "links" && !empty) {
        const same = (await client.query(`SELECT id FROM links WHERE url = $1 AND coalesce(file_name, '') = coalesce($2, '') AND id <> $3`, [row.url, row.file_name ?? null, row.id])).rows[0];
        if (same) {
          linkIds.set(row.id, same.id);
          row.id = same.id;
        }
      }
      if (table === "link_revisions" && linkIds.has(row.link_id)) row.link_id = linkIds.get(row.link_id);
      const cols = spec.cols.filter((c) => row[c] !== undefined); // a column an older export doesn't have takes its default
      const conflict = spec.conflict ?? [spec.key ?? "id"];
      const vals = cols.map((c) => {
        const v = row[c] ?? null;
        if (v == null) return null;
        if (JSONB.has(c) || spec.json?.includes(c)) return JSON.stringify(v);
        if (BINARY.has(c)) return Buffer.from(v, "base64");
        return v;
      });
      // The row's own change number going into an empty hub (exports from version 3 have it); a new one otherwise.
      const kept = empty && hasSeq(spec) && row.seq != null;
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
    table = null;
    if (empty) {
      // Numbers carry on well past the export's. An install whose place is in between had synced past this export
      // (a backup restored after the old hub was lost): its feed starts over (staleCursor in db.mjs) rather than skip
      // what is numbered next.
      const gaps = JSON.parse((await client.query(`SELECT value FROM settings WHERE key = 'feed_gaps'`)).rows[0]?.value ?? "{}");
      const carryOn = async (feed, sequence, fromExport, highest) => {
        const after = (await client.query(`SELECT greatest($1::bigint, ${highest}, 0)::text AS n`, [String(fromExport ?? 0)])).rows[0].n;
        const upTo = (
          await client.query(`SELECT setval('${sequence}', greatest($1::bigint, (SELECT last_value FROM ${sequence})) + $2::bigint)::text AS n`, [after, GAP])
        ).rows[0].n;
        gaps[feed] = [...(gaps[feed] ?? []), [after, upTo]];
      };
      await carryOn("change", "change_seq", meta.changeSeq, [...WITH_SEQ].map((t) => `(SELECT max(seq) FROM ${t})`).join(", "));
      await carryOn("partner", "partner_messages_seq_seq", meta.partnerSeq, "(SELECT max(seq) FROM partner_messages)");
      await client.query(`INSERT INTO settings (key, value) VALUES ('feed_gaps', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(gaps)]);
    }
    // New order numbers carry on after the imported ones.
    await client.query(
      `SELECT setval('order_number_seq', greatest((SELECT max(substring(number from 4)::bigint) FROM orders WHERE number ~ '^SH-[0-9]+$'), (SELECT last_value FROM order_number_seq), 1))`,
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw importError(e, lineNo, table);
  } finally {
    release();
    client.release();
  }
  return counts;
}
