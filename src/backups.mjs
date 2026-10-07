// Off-site backups for the programs (StitchBench docs/plans/later-round-1-design.md 1.6 and 1.5, package offsite-hub). The hub
// arranges the bucket and hands out short-lived addresses; the bytes never pass through it and are already encrypted with the
// owner's key, so the hub can't read them. Objects are keyed by the hub's shops.id, so a company that moves to another install
// keeps its store. Named in the design: put, list, get, delete; and the restore code (a move token the owner mints from the
// StitchHub account, good 24 hours) that lets a new install read the store and then take the company over (/v1/shops/move).
//
//   POST   /v1/backup/put     { shopRef, name, size, sha256 } -> { url, method: "PUT", expiresIn }   refused over the quota (photos)
//   POST   /v1/backup/done    { shopRef, name }               the program uploaded it: the hub checks the object is there at its size
//   GET    /v1/backup/list    ?shopRef                        -> { objects, usedBytes, quotaBytes }
//   POST   /v1/backup/get     { shopRef, name }               -> { url, expiresIn }
//   POST   /v1/backup/delete  { shopRef, name }
//   POST   /v1/backup/restore/list { code }                   (no key: the restore code) -> { shop, objects }
//   POST   /v1/backup/restore/get  { code, name }             -> { url, expiresIn }
//   POST   /account/api/shops/:id/restore-code                the owner, from the account page: a restore code for 24 hours
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q, tx } from "./db.mjs";
import { deleteObject, headObject, presign, s3Config } from "./s3.mjs";
import { refuseIfMoved } from "./moves.mjs";

export const NAME = /^(data|photo)\/[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{64}$/;
const GB = 1024 ** 3;
/** What a company may keep there: 25 GB included (design 1.4), BACKUP_QUOTA_GB to change. */
export const quotaBytes = () => Math.round((Number(process.env.BACKUP_QUOTA_GB) > 0 ? Number(process.env.BACKUP_QUOTA_GB) : 25) * GB);
const RESTORE_HOURS = 24;
const UP_SECONDS = 3600; // a big file on a slow line
const DOWN_SECONDS = 900;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

export function registerBackups({ app, member, acct, fail, newId, allow, bucket, requireAccount }) {
  const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });
  const cfg = () => {
    const c = s3Config();
    if (!c) throw fail(503, "Off-site backup storage isn't set up on this hub yet. Ask the hub admin.");
    return c;
  };
  const objectKey = (shopId, name) => `${shopId}/${name}`;
  const checkName = (name) => {
    if (typeof name !== "string" || !NAME.test(name) || name.includes("..") || name.includes("//")) throw fail(400, "That isn't a backup object name.");
    return name;
  };

  /** The company on this install, from X-Shop-Ref or the body's shopRef; 404 when it hasn't told the hub about itself, 410 when it moved away. */
  async function shopOf(c, body) {
    const install = c.get("install");
    const ref = str(body?.shopRef ?? c.req.query("shopRef") ?? c.req.header("x-shop-ref"), 64);
    if (!ref) throw fail(400, "Send shopRef.");
    if (!allow(`backup:${install.id}:${ref}`, 6000)) throw fail(429, "Too many backup requests in the last hour. Try again later.");
    const shop = await one(`SELECT * FROM shops WHERE install_id = $1 AND shop_ref = $2`, [install.id, ref]);
    if (!shop) {
      await refuseIfMoved(fail, install.id, ref);
      throw fail(404, "That shop hasn't told the hub about itself yet (it does at its next sync).");
    }
    return shop;
  }

  const usedBytes = async (shopId) => Number((await one(`SELECT coalesce(sum(size), 0) AS n FROM backup_objects WHERE shop_id = $1 AND deleted_at IS NULL`, [shopId])).n);

  member.post("/backup/put", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const name = checkName(body.name);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > 5 * GB) throw fail(400, "Send the object's size in bytes (up to 5 GB).");
    if (!SHA.test(String(body.sha256 ?? ""))) throw fail(400, "Send the object's SHA-256 as 64 hex characters.");
    const kind = name.startsWith("photo/") ? "photo" : "data";
    // Over the space: new pictures wait; the company file still goes (design 1.4), up to a fifth over.
    const used = await usedBytes(shop.id);
    const had = await one(`SELECT size FROM backup_objects WHERE shop_id = $1 AND name = $2 AND deleted_at IS NULL`, [shop.id, name]);
    const after = used - Number(had?.size ?? 0) + size;
    const limit = quotaBytes();
    if (kind === "photo" ? after > limit : after > limit * 1.2) throw fail(413, "This company's backup space is full. Pictures wait until space is freed; the company file is still kept.");
    await q(
      `INSERT INTO backup_objects (shop_id, name, kind, size, sha256) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id, name) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, created_at = now(), confirmed_at = NULL, deleted_at = NULL`,
      [shop.id, name, kind, size, String(body.sha256)],
    );
    return c.json({ url: presign(s3, "PUT", objectKey(shop.id, name), { expires: UP_SECONDS }), method: "PUT", expiresIn: UP_SECONDS });
  });

  member.post("/backup/done", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const name = checkName(body.name);
    const row = await one(`SELECT size FROM backup_objects WHERE shop_id = $1 AND name = $2 AND deleted_at IS NULL`, [shop.id, name]);
    if (!row) throw fail(404, "That object was never offered an upload address.");
    let there;
    try {
      there = await headObject(s3, objectKey(shop.id, name));
    } catch (e) {
      console.error("backup done:", e.message);
      throw fail(502, "The backup store didn't answer. Try again.");
    }
    if (there === null || there !== Number(row.size)) {
      throw fail(409, there === null ? "The object isn't in the backup store." : `The object in the store is ${there} bytes, not the ${row.size} announced.`);
    }
    await q(`UPDATE backup_objects SET confirmed_at = now() WHERE shop_id = $1 AND name = $2`, [shop.id, name]);
    return c.json({ ok: true });
  });

  member.get("/backup/list", async (c) => {
    const shop = await shopOf(c, null);
    const { rows } = await q(`SELECT name, kind, size, sha256, created_at FROM backup_objects WHERE shop_id = $1 AND deleted_at IS NULL AND confirmed_at IS NOT NULL ORDER BY name`, [shop.id]);
    return c.json({ objects: rows.map((r) => ({ name: r.name, kind: r.kind, size: Number(r.size), sha256: r.sha256, createdAt: r.created_at })), usedBytes: await usedBytes(shop.id), quotaBytes: quotaBytes() });
  });

  member.post("/backup/get", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const name = checkName(body.name);
    const row = await one(`SELECT 1 AS ok FROM backup_objects WHERE shop_id = $1 AND name = $2 AND deleted_at IS NULL AND confirmed_at IS NOT NULL`, [shop.id, name]);
    if (!row) throw fail(404, "That backup object isn't there.");
    return c.json({ url: presign(s3, "GET", objectKey(shop.id, name), { expires: DOWN_SECONDS }), expiresIn: DOWN_SECONDS });
  });

  member.post("/backup/delete", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await shopOf(c, body);
    const name = checkName(body.name);
    const row = await one(`SELECT 1 AS ok FROM backup_objects WHERE shop_id = $1 AND name = $2 AND deleted_at IS NULL`, [shop.id, name]);
    if (!row) return c.json({ ok: true, deleted: 0 });
    try {
      await deleteObject(s3, objectKey(shop.id, name));
    } catch (e) {
      console.error("backup delete:", e.message);
      throw fail(502, "The backup store didn't answer. Try again.");
    }
    await q(`UPDATE backup_objects SET deleted_at = now() WHERE shop_id = $1 AND name = $2`, [shop.id, name]);
    return c.json({ ok: true, deleted: 1 });
  });

  // ----- the restore code: a new install reads the store, then takes the company over with /v1/shops/move -----

  /** The company a live restore code is for, or the same refusal for any wrong, used, cancelled or expired code. */
  async function byCode(c, body) {
    const wrong = bucket("restore-code:wrong");
    if (wrong.n >= 100) throw fail(429, "Too many wrong restore codes were tried lately. Try again in an hour.");
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const row = code
      ? await one(
          `SELECT s.* FROM shop_moves m JOIN shops s ON s.id = m.shop_id
           WHERE m.token_hash = $1 AND m.used_at IS NULL AND m.cancelled_at IS NULL AND m.expires_at > now()`,
          [sha(code)],
        )
      : null;
    if (!row) {
      wrong.n++;
      throw fail(403, "That restore code isn't right, or it has been used or has run out. Make a new one on your StitchHub account.");
    }
    return row;
  }

  app.post("/v1/backup/restore/list", small, async (c) => {
    const shop = await byCode(c, await c.req.json().catch(() => ({})));
    const { rows } = await q(`SELECT name, kind, size, sha256, created_at FROM backup_objects WHERE shop_id = $1 AND deleted_at IS NULL AND confirmed_at IS NOT NULL ORDER BY name`, [shop.id]);
    return c.json({
      shop: { shopRef: shop.shop_ref, name: shop.name, kind: shop.kind, program: shop.program },
      objects: rows.map((r) => ({ name: r.name, kind: r.kind, size: Number(r.size), sha256: r.sha256, createdAt: r.created_at })),
    });
  });

  app.post("/v1/backup/restore/get", small, async (c) => {
    const s3 = cfg();
    const body = await c.req.json().catch(() => ({}));
    const shop = await byCode(c, body);
    const name = checkName(body.name);
    const row = await one(`SELECT 1 AS ok FROM backup_objects WHERE shop_id = $1 AND name = $2 AND deleted_at IS NULL AND confirmed_at IS NOT NULL`, [shop.id, name]);
    if (!row) throw fail(404, "That backup object isn't there.");
    return c.json({ url: presign(s3, "GET", objectKey(shop.id, name), { expires: DOWN_SECONDS }), expiresIn: DOWN_SECONDS });
  });

  // The owner, signed in on the account page: a restore code for one of the account's shops.
  acct.post("/shops/:id/restore-code", async (c) => {
    const a = await requireAccount(c);
    if (!a.verified_at) throw fail(403, "Confirm your email first: open the link we sent you.");
    if (!allow(`restore-code:${a.id}`, 10)) throw fail(429, "Too many restore codes in the last hour. Use the one you have, or wait.");
    const code = `shr_${crypto.randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + RESTORE_HOURS * 3600_000);
    const out = await tx(async (client) => {
      const shop = (await client.query(`SELECT * FROM shops WHERE id = $1 AND account_id = $2 FOR UPDATE`, [String(c.req.param("id") ?? ""), a.id])).rows[0];
      if (!shop) throw fail(404, "Shop not found.");
      // One live code or move token per company: the newest is the one that works.
      await client.query(`UPDATE shop_moves SET cancelled_at = now() WHERE shop_id = $1 AND used_at IS NULL AND cancelled_at IS NULL`, [shop.id]);
      await client.query(`INSERT INTO shop_moves (id, shop_id, shop_ref, token_hash, from_install_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), shop.id, shop.shop_ref, sha(code), shop.install_id, expiresAt]);
      return shop;
    });
    return c.json({ code, expiresAt, shopRef: out.shop_ref, shopName: out.name });
  });
}
