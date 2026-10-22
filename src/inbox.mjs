// The StitchFoundry inbox (docs/plan.md, "StitchFoundry inbox"): a designer sends an embroidery file from StitchFoundry to the
// shop that will sew it, by the Foundry Account the two programs share. Off unless FOUNDRY_SIGNIN is on or only: a hub account
// has a Foundry id only then. The bytes never pass through the hub: it hands out short-lived addresses for the same bucket as the
// off-site backups (src/s3.mjs, BACKUP_S3_*), under inbox/<account>/<item>.
//
// The sender (StitchFoundry) has no install key; it proves itself with its Foundry Account token. The hub asks the service whose
// token that is and keeps nothing of it. The receiver is a program (StitchBench or StitchShop) under its install key.
//
//   Sender, header  Authorization: Bearer sfs_...
//   GET    /v1/inbox/shops                             -> { shops: [{ id, name, program }] } the shops of the account, to pick one
//   POST   /v1/inbox/put   { fileName, size, sha256, meta?, toShopId? }
//                                                      -> { id, url, method: "PUT", expiresIn, headers } (the address is signed for that size)
//   POST   /v1/inbox/done  { id }                      the sender uploaded it: the hub checks the object is there at its size
//   POST   /v1/inbox/retract { id }                    the sender takes it back (before a shop has taken it)
//   Receiver, under the install key (shopRef names the company, as for backups)
//   GET    /v1/inbox/list  ?shopRef                    -> { linked, items: [{ id, fileName, size, sha256, meta, createdAt, expiresAt }] }
//   POST   /v1/inbox/get   { shopRef, id }             -> { url, expiresIn }
//   POST   /v1/inbox/take  { shopRef, id }             the shop imported it: it leaves the inbox and the bucket
import { bodyLimit } from "hono/body-limit";
import { one, q, tx } from "./db.mjs";
import { deleteObject, headObject, presign, s3Config } from "./s3.mjs";
import { FoundryError, accountOfToken, foundryMode } from "./foundry.mjs";
import { refuseIfMoved } from "./moves.mjs";

const MB = 1024 ** 2;
const SHA = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/;
const UP_SECONDS = 900;
const DOWN_SECONDS = 600;
const UNCONFIRMED_HOURS = 2;
export const MAX_FILE_BYTES = 10 * MB; // as StitchBench's design import
const posNum = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
/** How many files, how many bytes, and how many days one account may have waiting. */
export const maxItems = () => Math.floor(posNum(process.env.INBOX_MAX_ITEMS, 25));
export const quotaBytes = () => Math.round(posNum(process.env.INBOX_QUOTA_MB, 100) * MB);
export const keepDays = () => posNum(process.env.INBOX_DAYS, 30);

const str = (v, max) => {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const num = (v, lo, hi, whole = false) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) return null;
  return n;
};

/**
 * What StitchFoundry said about a file, made safe: only the keys below survive, each checked, and the whole is held to 4 KB.
 * Everything is optional; the program reads the file itself where it can (a DST) and uses these where it can't.
 */
export function cleanMeta(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out = {};
  for (const k of ["job", "customer", "garment", "placement", "program", "version"]) {
    const v = str(raw[k], 120);
    if (v) out[k] = v;
  }
  const notes = str(raw.notes, 500);
  if (notes) out.notes = notes;
  if (typeof raw.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.due.trim())) out.due = raw.due.trim();
  const ints = { quantity: [1, 100_000], stitches: [0, 5_000_000], colors: [1, 100], runMinutes: [0, 100_000] };
  for (const [k, [lo, hi]] of Object.entries(ints)) {
    const n = num(raw[k], lo, hi, true);
    if (n != null) out[k] = n;
  }
  for (const k of ["widthMm", "heightMm"]) {
    const n = num(raw[k], 0, 2000);
    if (n != null) out[k] = Math.round(n * 10) / 10;
  }
  if (Array.isArray(raw.threads)) {
    const t = raw.threads.map((x) => str(x, 60)).filter(Boolean).slice(0, 100);
    if (t.length) out.threads = t;
  }
  return JSON.stringify(out).length <= 4096 ? out : {};
}

export function registerInbox({ app, member, fail, newId, allow, clientIp }) {
  const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });
  const cfg = () => {
    const c = s3Config();
    if (!c) throw fail(503, "File storage isn't set up on this hub yet. Ask the hub admin.");
    return c;
  };
  const on = () => {
    if (foundryMode() === "off") throw fail(404, "Not found.");
  };
  const objectKey = (accountId, id) => `inbox/${accountId}/${id}`;

  /** The StitchHub account whose Foundry Account sent this request, from its token; the token is not kept. */
  async function senderOf(c) {
    on();
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!/^sfs_[0-9a-f]{64}$/.test(token)) throw fail(401, "Send your Foundry Account token (Authorization: Bearer sfs_...).");
    if (!allow(`inbox:ip:${clientIp(c)}`, 600)) throw fail(429, "Too many tries from this address. Try again later.");
    let who;
    try {
      who = await accountOfToken(token);
    } catch (e) {
      if (!(e instanceof FoundryError)) throw e;
      if (e.kind === "wrong") throw fail(401, "The Foundry Account service doesn't know that token: sign in to StitchFoundry again.");
      if (e.kind === "wait") throw fail(429, e.message);
      if (e.kind === "offline") throw fail(503, e.message);
      throw fail(502, e.message);
    }
    const acct = await one(`SELECT id, disabled FROM accounts WHERE foundry_id = $1`, [who.id]);
    if (!acct || acct.disabled) throw fail(404, "No StitchHub account is linked to this Foundry Account yet. In your shop's Settings, Foundry Account, link it, or sign in at the hub's account page with it.");
    if (!allow(`inbox:account:${acct.id}`, 300)) throw fail(429, "Too many requests for this account in the last hour. Try again later.");
    return acct.id;
  }

  /** The company on this install and its account, as a program under its install key (see src/backups.mjs shopOf). */
  async function shopOf(c, body) {
    on();
    const install = c.get("install");
    const ref = str(body?.shopRef ?? c.req.query("shopRef") ?? c.req.header("x-shop-ref"), 64);
    if (!ref) throw fail(400, "Send shopRef.");
    if (!allow(`inbox:shop:${install.id}:${ref}`, 1200)) throw fail(429, "Too many inbox requests in the last hour. Try again later.");
    const shop = await one(`SELECT id, account_id FROM shops WHERE install_id = $1 AND shop_ref = $2`, [install.id, ref]);
    if (!shop) {
      await refuseIfMoved(fail, install.id, ref);
      throw fail(404, "That shop hasn't told the hub about itself yet (it does at its next sync).");
    }
    return shop;
  }

  const itemId = (v) => {
    const id = String(v ?? "");
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw fail(400, "That isn't an inbox item id.");
    return id;
  };
  const visible = `account_id = $1 AND deleted_at IS NULL AND confirmed_at IS NOT NULL AND taken_at IS NULL AND expires_at > now()`;

  // Objects the sender never finished uploading, files that waited their days, and files a shop took are swept. Each row is
  // marked deleted only after its object went, so a bucket that is down leaves it for the next sweep.
  async function sweep() {
    const s3 = s3Config();
    if (!s3) return;
    const { rows } = await q(
      `SELECT id, account_id FROM inbox_items WHERE deleted_at IS NULL AND (
         (confirmed_at IS NULL AND created_at < now() - make_interval(hours => $1)) OR expires_at <= now() OR taken_at IS NOT NULL) LIMIT 500`,
      [UNCONFIRMED_HOURS],
    );
    let n = 0;
    for (const r of rows) {
      try {
        await deleteObject(s3, objectKey(r.account_id, r.id));
        n += (await q(`UPDATE inbox_items SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [r.id])).rowCount;
      } catch (e) {
        console.error(`inbox sweep: ${r.id}:`, e.message);
      }
    }
    if (n) console.log(`inbox sweep: ${n} file(s) removed (unfinished, expired or taken)`);
  }
  const sweepMs = Math.min(Number(process.env.INBOX_SWEEP_MS) > 0 ? Number(process.env.INBOX_SWEEP_MS) : 1800_000, 2 ** 31 - 1);
  const sweepSoon = () => sweep().catch((e) => console.error("inbox sweep:", e.message));
  setTimeout(sweepSoon, Math.min(sweepMs, 60_000)).unref();
  setInterval(sweepSoon, sweepMs).unref();

  // ----- the sender: StitchFoundry, by its Foundry Account token -----

  app.get("/v1/inbox/shops", async (c) => {
    const accountId = await senderOf(c);
    const { rows } = await q(`SELECT id, name, program FROM shops WHERE account_id = $1 ORDER BY name LIMIT 50`, [accountId]);
    return c.json({ shops: rows.map((r) => ({ id: r.id, name: r.name, program: r.program })) });
  });

  app.post("/v1/inbox/put", small, async (c) => {
    const s3 = cfg();
    const accountId = await senderOf(c);
    const body = await c.req.json().catch(() => ({}));
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    if (!FILE_NAME.test(fileName)) throw fail(400, "Send fileName: letters, digits, spaces and . _ ( ) + - only, up to 120 characters.");
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw fail(400, `Send the file's size in bytes: 1 to ${MAX_FILE_BYTES / MB} MB.`);
    if (!SHA.test(String(body.sha256 ?? ""))) throw fail(400, "Send the file's SHA-256 as 64 hex characters.");
    const toShop = body.toShopId == null || body.toShopId === "" ? null : String(body.toShopId);
    const id = newId();
    const out = await tx(async (client) => {
      // One request at a time per account, so two sends can't both fit under the limit.
      await client.query(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]);
      if (toShop && !(await client.query(`SELECT 1 FROM shops WHERE id = $1 AND account_id = $2`, [toShop, accountId])).rows[0]) throw fail(404, "That shop isn't one of this account's.");
      const used = (await client.query(`SELECT count(*)::int AS n, coalesce(sum(size), 0)::bigint AS bytes FROM inbox_items WHERE account_id = $1 AND deleted_at IS NULL AND taken_at IS NULL AND expires_at > now()`, [accountId])).rows[0];
      if (used.n >= maxItems()) throw fail(413, `${maxItems()} files are already waiting. Take some into orders (or retract them) first.`);
      if (Number(used.bytes) + size > quotaBytes()) throw fail(413, `The inbox holds ${quotaBytes() / MB} MB at most and this would go past it. Take some files into orders (or retract them) first.`);
      await client.query(
        `INSERT INTO inbox_items (id, account_id, to_shop_id, file_name, size, sha256, meta, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
        [id, accountId, toShop, fileName, size, String(body.sha256), JSON.stringify(cleanMeta(body.meta)), keepDays() * 86400],
      );
      return { accountId };
    });
    // Signed for its size, so the address can't take more than was counted, and for its bytes.
    const headers = { "x-amz-checksum-sha256": Buffer.from(String(body.sha256), "hex").toString("base64") };
    const url = presign(s3, "PUT", objectKey(out.accountId, id), { expires: UP_SECONDS, headers: { "content-length": String(size), ...headers } });
    return c.json({ id, url, method: "PUT", expiresIn: UP_SECONDS, headers });
  });

  app.post("/v1/inbox/done", small, async (c) => {
    const s3 = cfg();
    const accountId = await senderOf(c);
    const body = await c.req.json().catch(() => ({}));
    const id = itemId(body.id);
    const row = await one(`SELECT size FROM inbox_items WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [id, accountId]);
    if (!row) throw fail(404, "That file was never offered an upload address, or it has gone.");
    let there;
    try {
      there = await headObject(s3, objectKey(accountId, id));
    } catch (e) {
      console.error("inbox done:", e.message);
      throw fail(502, "The file store didn't answer. Try again.");
    }
    if (there === null || there !== Number(row.size)) throw fail(409, there === null ? "The file isn't in the store." : `The file in the store is ${there} bytes, not the ${row.size} announced.`);
    await q(`UPDATE inbox_items SET confirmed_at = coalesce(confirmed_at, now()) WHERE id = $1 AND account_id = $2`, [id, accountId]);
    return c.json({ ok: true });
  });

  app.post("/v1/inbox/retract", small, async (c) => {
    const s3 = cfg();
    const accountId = await senderOf(c);
    const body = await c.req.json().catch(() => ({}));
    const id = itemId(body.id);
    const row = await one(`SELECT taken_at FROM inbox_items WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [id, accountId]);
    if (!row) return c.json({ ok: true, retracted: 0 });
    if (row.taken_at) throw fail(409, "A shop has already taken that file into an order.");
    try {
      await deleteObject(s3, objectKey(accountId, id));
    } catch (e) {
      console.error("inbox retract:", e.message);
      throw fail(502, "The file store didn't answer. Try again.");
    }
    await q(`UPDATE inbox_items SET deleted_at = now() WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL AND taken_at IS NULL`, [id, accountId]);
    return c.json({ ok: true, retracted: 1 });
  });

  // ----- the receiver: the program, under its install key -----

  member.get("/inbox/list", async (c) => {
    const shop = await shopOf(c, null);
    if (!shop.account_id) return c.json({ linked: false, items: [] });
    const { rows } = await q(
      `SELECT id, file_name, size, sha256, meta, created_at, expires_at FROM inbox_items WHERE ${visible} AND (to_shop_id IS NULL OR to_shop_id = $2) ORDER BY created_at DESC LIMIT 100`,
      [shop.account_id, shop.id],
    );
    return c.json({ linked: true, items: rows.map((r) => ({ id: r.id, fileName: r.file_name, size: Number(r.size), sha256: r.sha256, meta: r.meta, createdAt: r.created_at, expiresAt: r.expires_at })) });
  });

  member.post("/inbox/get", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const id = itemId(body.id);
    const row = shop.account_id ? await one(`SELECT 1 AS ok FROM inbox_items WHERE id = $2 AND ${visible} AND (to_shop_id IS NULL OR to_shop_id = $3)`, [shop.account_id, id, shop.id]) : null;
    if (!row) throw fail(404, "That file isn't in this shop's inbox.");
    return c.json({ url: presign(s3, "GET", objectKey(shop.account_id, id), { expires: DOWN_SECONDS }), expiresIn: DOWN_SECONDS });
  });

  member.post("/inbox/take", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const id = itemId(body.id);
    if (!shop.account_id) throw fail(404, "That file isn't in this shop's inbox.");
    const took = await q(
      `UPDATE inbox_items SET taken_at = now(), taken_by_shop_id = $3 WHERE id = $2 AND ${visible} AND (to_shop_id IS NULL OR to_shop_id = $3) RETURNING id`,
      [shop.account_id, id, shop.id],
    );
    if (!took.rowCount) throw fail(404, "That file isn't in this shop's inbox (someone took it, or it ran out).");
    try {
      await deleteObject(s3, objectKey(shop.account_id, id));
      await q(`UPDATE inbox_items SET deleted_at = now() WHERE id = $1`, [id]);
    } catch (e) {
      console.error("inbox take:", e.message); // the next sweep removes it: it is taken either way
    }
    return c.json({ ok: true });
  });
}

