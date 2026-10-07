// The manual repository, hub side (docs/plans/manual-repository-design.md in the StitchBench repo; packages repo-storage
// and repo-hub). Manuals are PDFs a tech chose to offer, kept in one private R2 bucket (src/r2.mjs); the bytes go
// between the program and R2 on presigned URLs, never through the hub. The owner reviews every upload before any shop
// can download it.
//
// Member routes (install key; X-Shop-Ref names the company; partner and pending installs are refused by the member
// router before they get here):
//   POST /v1/repository/uploads             { sha256, sizeBytes, fileName, offered: { category, brand, models[], docType,
//                                             year, language, title }, statement: { version, accepted: true }, byName }
//                                           -> { duplicate, id } | { blocked, message } | { uploadId, putUrl, putHeaders, expiresAt }
//   POST /v1/repository/uploads/:id/sent    the hub reads the stored object, checks size, sha256 and structure -> { state }
//   GET  /v1/repository/uploads             this company's offers and their states
//   GET  /v1/repository/changes?since=N     the repository feed { manuals, next, more }; its own cursor, the same change_seq
//   POST /v1/repository/files/:id/url       { url, expiresAt, sha256, sizeBytes } for a published manual (id: the feed's)
// Account routes (session cookie, /account/api): GET /manuals (search; the free side, design 0.1), POST /manuals/:id/url.
// Admin routes (ADMIN_TOKEN, /v1/admin/repository...): the review queue, preview, approve, reject, remove, blocked
// hashes, uploading off for an account or an install.
//
// Switches (environment): REPO_UPLOADS=on opens uploads (unset: "The manual repository opens soon."; reading what is
// published needs nothing), R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET (R2_ENDPOINT for a
// test), REPO_MAX_MB (150), REPO_STATEMENT_VERSION (when set, an offer must name it), REPO_OPERATOR_ACCOUNTS (account
// emails or ids, comma separated: the hub's owner uploads nothing of his own).
import crypto from "node:crypto";
import { one, q, tx, feedLimit } from "./db.mjs";
import { standingOf } from "./billing.mjs";
import { r2FromEnv } from "./r2.mjs";
import { inspectPdfIsolated } from "./pdfcheck.mjs";
import { ocrOn, ocrMarkings, ocrQueue } from "./ocr.mjs";

const MB = 1024 * 1024;
export const DOC_TYPES = ["ServiceManual", "TechnicalManual", "MaintenanceManual", "PartsList", "OperatorManual", "ErrorCodes", "WiringDiagram", "Schematic", "Firmware", "Training", "Bulletin"];
export const LIMITS = { companyPerDay: 25, accountPerDay: 100, accountBytesPerDay: 2 * 1024 * MB, accountWaiting: 50, installUrlsPerHour: 300, installUrlsPerDay: 3000, webDownloadsPerDay: 25 };
const DOWNLOAD_SECONDS = 300;
const PUT_SECONDS = 900;

const sha256of = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sha1of = (b) => crypto.createHash("sha1").update(b).digest("hex");
const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const today = () => new Date().toISOString().slice(0, 10);
const uploadsOn = () => /^(on|true|1|yes)$/i.test(process.env.REPO_UPLOADS ?? "");
const maxBytes = () => Math.max(1, Number(process.env.REPO_MAX_MB) || 150) * MB;
const modelKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const part = (s) => String(s ?? "").replace(/[^A-Za-z0-9.\-]+/g, "-").replace(/^-+|-+$/g, "");

/** The library's name for a manual: Brand_Model_DocType_Year.pdf (year left out when unknown). */
export const libraryName = (m) => `${[part(m.brand), part(String(m.models ?? "").split(/[,;]/)[0]), part(m.doc_type ?? m.docType), m.year ?? ""].filter((x) => x !== "").join("_")}.pdf`;

/** Two at a time: a verifying read holds a whole file (up to REPO_MAX_MB) in memory. */
function limiter(n) {
  let running = 0;
  const waiting = [];
  return async (fn) => {
    while (running >= n) await new Promise((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
const verifying = limiter(2);

export function registerRepository({ app, member, admin, acct, fail, newId, allow, clientIp, requireAccount }) {
  const r2 = r2FromEnv();
  const storage = () => {
    if (!r2) throw fail(503, "The hub's file storage isn't set up yet.");
    return r2;
  };
  const operators = () => new Set((process.env.REPO_OPERATOR_ACCOUNTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const refusedBrands = async () => {
    try {
      return new Set(JSON.parse((await one(`SELECT value FROM settings WHERE key = 'repo_refused_brands'`))?.value ?? "[]").map((b) => String(b).toLowerCase()));
    } catch {
      return new Set();
    }
  };

  // ----- what an offer says -----

  /** The offered fields checked and tidied; throws a 400 in words. */
  function cleanOffer(o, { title = true } = {}) {
    o = o && typeof o === "object" ? o : {};
    const brand = str(o.brand, 60);
    if (!brand) throw fail(400, "Name the brand.");
    const models = (Array.isArray(o.models) ? o.models : String(o.models ?? "").split(/[,;]/)).map((m) => str(m, 40)).filter(Boolean).slice(0, 20);
    if (!models.length) throw fail(400, "Name at least one model.");
    const docType = DOC_TYPES.find((d) => d.toLowerCase() === String(o.docType ?? "").toLowerCase());
    if (!docType) throw fail(400, `Choose a document type: ${DOC_TYPES.join(", ")}.`);
    const category = str(o.category, 60);
    if (!category) throw fail(400, "Choose the category (Sewing machine, Embroidery machine, Serger, Vacuum ...).");
    let year = null;
    if (o.year !== undefined && o.year !== null && o.year !== "") {
      year = Number(o.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) throw fail(400, "The year isn't right (1900 to 2100, or leave it empty).");
    }
    const language = str(o.language, 30) ?? "English";
    const t = str(o.title, 200) ?? (title ? `${brand} ${models[0]} ${docType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}` : null);
    return { category, brand, models, docType, year, language, title: t };
  }

  // ----- the company and its account (design 3: the account rule) -----

  /** The shop row for this request (install + X-Shop-Ref) or a 403 in words. */
  async function shopOf(c, body) {
    const install = c.get("install");
    const ref = str(c.req.header("x-shop-ref") ?? body?.shopRef ?? c.req.query("shopRef"), 64);
    if (!ref) throw fail(400, "Send X-Shop-Ref: the company's id.");
    const shop = await one(`SELECT * FROM shops WHERE install_id = $1 AND shop_ref = $2`, [install.id, ref]);
    if (!shop) throw fail(403, "This company hasn't claimed itself on the hub yet. Sync with StitchHub once, then try again.");
    return shop;
  }

  /** Who may offer: a company claimed by a verified, enabled account that isn't the hub's own, on an enabled install. */
  async function mayOffer(install, shop) {
    const a = shop.account_id ? await one(`SELECT * FROM accounts WHERE id = $1`, [shop.account_id]) : null;
    if (!a || !a.verified_at) throw fail(403, "Offering a manual needs a verified StitchHub account for this company. Open Settings → Account and confirm your email first.");
    if (a.disabled) throw fail(403, "This StitchHub account is disabled.");
    if (operators().has(a.email.toLowerCase()) || operators().has(a.id.toLowerCase())) throw fail(403, "The hub's own account doesn't upload to the repository.");
    if (a.repo_uploads_off) throw fail(403, "Uploading to the repository has ended for this account.");
    const inst = await one(`SELECT repo_uploads_off FROM installs WHERE id = $1`, [install.id]);
    if (inst?.repo_uploads_off) throw fail(403, "Uploading to the repository has ended for this install.");
    if ((await standingOf(shop)).standing === "lapsed") throw fail(403, "This company's subscription has lapsed: it is read-only until it is renewed.");
    return a;
  }

  // ----- an upload slot -----

  member.post("/repository/uploads", async (c) => {
    const install = c.get("install");
    if (!uploadsOn()) throw fail(403, "The manual repository opens soon.");
    storage();
    const body = await c.req.json();
    if (!allow(`repo-offer:${install.id}`, 120)) throw fail(429, "Too many offers in the last hour. Try again later.");
    const shop = await shopOf(c, body);
    const account = await mayOffer(install, shop);
    const sha = String(body.sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw fail(400, "Send the file's sha256 (64 hex digits).");
    const size = Number(body.sizeBytes);
    if (!Number.isInteger(size) || size < 8) throw fail(400, "Send the file's size in bytes.");
    if (size > maxBytes()) throw fail(413, `That file is larger than ${Math.round(maxBytes() / MB)} MB, the most the repository takes.`);
    const offered = cleanOffer(body.offered);
    const st = body.statement ?? {};
    if (st.accepted !== true || !str(st.version, 40)) throw fail(400, "The statement must be ticked for this file.");
    if (process.env.REPO_STATEMENT_VERSION && st.version !== process.env.REPO_STATEMENT_VERSION) throw fail(409, "The statement has been updated. Update the program, then offer the file again.");
    if ((await refusedBrands()).has(offered.brand.toLowerCase())) throw fail(403, `The repository doesn't take ${offered.brand} manuals.`);

    const blocked = await one(`SELECT 1 FROM blocked_hashes WHERE sha256 = $1 AND lifted_at IS NULL`, [sha]);
    if (blocked) return c.json({ blocked: true, message: "That file was removed from the repository and can't be offered again." });

    const out = await tx(async (client) => {
      // One offer at a time per account, so the limits below can't be passed by two at once.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`repo:${account.id}`]);
      const day = (await client.query(
        `SELECT count(*) FILTER (WHERE shop_id = $1)::int AS company, count(*)::int AS acct, coalesce(sum(size_bytes), 0)::bigint AS bytes
         FROM uploads WHERE account_id = $2 AND created_at > now() - interval '1 day'`,
        [shop.id, account.id],
      )).rows[0];
      // The waiting count looks further back than a day: a file waits for review for as long as it takes.
      const waiting = (await client.query(`SELECT count(*)::int AS n FROM uploads WHERE account_id = $1 AND (state = 'pending' OR (state IN ('slot', 'sent') AND created_at > now() - interval '1 hour'))`, [account.id])).rows[0].n;
      if (day.company >= LIMITS.companyPerDay) throw fail(429, `This company has made ${LIMITS.companyPerDay} offers in the last day, the most it may. Try again tomorrow.`);
      if (day.acct >= LIMITS.accountPerDay || Number(day.bytes) + size > LIMITS.accountBytesPerDay) throw fail(429, "This account has offered as much as it may in a day (100 files or 2 GB). Try again tomorrow.");
      if (waiting >= LIMITS.accountWaiting) throw fail(429, `${LIMITS.accountWaiting} of this account's offers are waiting for review. Wait for some to be decided.`);
      const f = (await client.query(`SELECT id, status, manual_id FROM manual_files WHERE sha256 = $1`, [sha])).rows[0];
      const id = newId();
      const dup = f && (f.status === "pending" || f.status === "published");
      await client.query(
        `INSERT INTO uploads (id, shop_id, account_id, install_id, shop_ref, by_name, sha256, size_bytes, offered, original_name, statement_version, statement_at, state, file_id, manual_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, $13, $14)`,
        [id, shop.id, account.id, install.id, shop.shop_ref, str(body.byName, 120), sha, size, JSON.stringify(offered), str(body.fileName, 200), st.version, dup ? "duplicate" : "slot", dup ? f.id : null, dup ? f.manual_id : null],
      );
      return { id, dup: dup ? f : null };
    });
    if (out.dup) return c.json({ duplicate: true, id: out.dup.manual_id ?? out.dup.id, message: out.dup.status === "pending" ? "That file is already here, waiting for review." : "That file is already in the repository." });
    const slot = r2.putUrl(`incoming/${out.id}.pdf`, { size, expires: PUT_SECONDS });
    return c.json({ uploadId: out.id, putUrl: slot.url, putHeaders: slot.headers, expiresAt: slot.expiresAt });
  });

  // ----- the verifying read -----

  const refuseUpload = async (id, reason) => {
    await q(`UPDATE uploads SET state = 'refused', reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await r2.remove(`incoming/${id}.pdf`).catch(() => {});
    return { state: "refused", reason };
  };

  member.post("/repository/uploads/:id/sent", async (c) => {
    const install = c.get("install");
    storage();
    const ref = str(c.req.header("x-shop-ref") ?? c.req.query("shopRef"), 64);
    if (!ref) throw fail(400, "Send X-Shop-Ref: the company's id.");
    const up = await one(`SELECT * FROM uploads WHERE id = $1 AND install_id = $2 AND shop_ref = $3`, [c.req.param("id"), install.id, ref]);
    if (!up) throw fail(404, "No such offer.");
    if (up.state !== "slot") return c.json({ state: up.state, reason: up.reason });
    if (!allow(`repo-sent:${install.id}`, 120)) throw fail(429, "Too many tries in the last hour. Try again later.");
    // Taken for this call only: a second call meanwhile finds it 'sent'.
    const took = await q(`UPDATE uploads SET state = 'sent', updated_at = now() WHERE id = $1 AND state = 'slot' RETURNING id`, [up.id]);
    if (!took.rowCount) return c.json({ state: "sent" });
    const key = `incoming/${up.id}.pdf`;
    try {
      const head = await r2.head(key);
      if (!head) {
        await q(`UPDATE uploads SET state = 'slot', updated_at = now() WHERE id = $1`, [up.id]);
        throw fail(409, "The file hasn't arrived in storage yet. Send it with the upload URL, then say it was sent.");
      }
      if (head.size !== Number(up.size_bytes) || head.size > maxBytes()) return c.json(await refuseUpload(up.id, "The file in storage isn't the size that was offered."));
      const result = await verifying(async () => {
        const bytes = await r2.get(key);
        if (!bytes) return { refused: "The file went missing from storage. Offer it again." };
        if (bytes.length !== Number(up.size_bytes)) return { refused: "The file in storage isn't the size that was offered." };
        const sha = sha256of(bytes);
        if (sha !== up.sha256) return { refused: "The file's contents don't match its sha256: it changed or broke on the way. Offer it again." };
        // In a worker thread with a time and memory limit (src/pdfcheck.mjs): a file that runs over is refused.
        const look = await inspectPdfIsolated(bytes, { ocr: ocrOn() });
        if (look.refused) return { refused: look.refused };
        return { sha, sha1: sha1of(bytes), look };
      });
      if (result.refused) return c.json(await refuseUpload(up.id, result.refused));
      const { look } = result;
      const checks = { structure: { ok: true, flags: look.flags }, markings: look.markings, pages: look.pages };
      const state = await tx(async (client) => {
        const f = (await client.query(`SELECT * FROM manual_files WHERE sha256 = $1 FOR UPDATE`, [up.sha256])).rows[0];
        if (f && (f.status === "pending" || f.status === "published")) {
          await client.query(`UPDATE uploads SET state = 'duplicate', file_id = $2, manual_id = $3, updated_at = now() WHERE id = $1`, [up.id, f.id, f.manual_id]);
          return { state: "duplicate", dropIncoming: true };
        }
        if (f && f.status === "held") {
          await client.query(`UPDATE uploads SET state = 'refused', reason = 'That file was removed from the repository and can''t be offered again.', updated_at = now() WHERE id = $1`, [up.id]);
          return { state: "refused", dropIncoming: true };
        }
        const fileId = f?.id ?? newId();
        const objectKey = `files/${up.sha256}.pdf`;
        // Into its place (the manual's name is on the download, set again then): the old bytes of a retired copy are replaced.
        await r2.copy(key, objectKey, { disposition: `attachment; filename="${libraryName({ ...up.offered, doc_type: up.offered.docType })}"` });
        if (f) await client.query(`UPDATE manual_files SET status = 'pending', object_key = $2, checks = $3, pages = $4, manual_id = NULL, updated_at = now() WHERE id = $1`, [f.id, objectKey, JSON.stringify(checks), look.pages]);
        else await client.query(`INSERT INTO manual_files (id, sha256, sha1, size_bytes, pages, object_key, status, checks) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`, [fileId, up.sha256, result.sha1, up.size_bytes, look.pages, objectKey, JSON.stringify(checks)]);
        await client.query(`UPDATE uploads SET state = 'pending', file_id = $2, updated_at = now() WHERE id = $1`, [up.id, fileId]);
        return { state: "pending", dropIncoming: true };
      });
      if (state.dropIncoming) await r2.remove(key).catch(() => {});
      if (state.state === "pending" && look.markings.status === "checking") queueOcr(up.sha256);
      const row = await one(`SELECT state, reason FROM uploads WHERE id = $1`, [up.id]);
      return c.json({ state: row.state, reason: row.reason });
    } catch (e) {
      // A failure that isn't an answer (storage down, the database): the slot is open again, so asking again works.
      if (!e.expose) await q(`UPDATE uploads SET state = 'slot', updated_at = now() WHERE id = $1 AND state = 'sent'`, [up.id]).catch(() => {});
      throw e;
    }
  });

  // ----- OCR of scanned pages, after the upload is filed (design 0.2; src/ocr.mjs): one at a time, off the request path -----

  const saveMarkings = (fileId, m) =>
    q(`UPDATE manual_files SET checks = jsonb_set(checks, '{markings}', $2::jsonb), updated_at = now() WHERE id = $1 AND status = 'pending' AND checks->'markings'->>'status' = 'checking'`, [fileId, JSON.stringify(m)]);
  function queueOcr(sha) {
    ocrQueue(async () => {
      const f = await one(`SELECT id, object_key, checks FROM manual_files WHERE sha256 = $1 AND status = 'pending'`, [sha]);
      const prior = f?.checks?.markings;
      if (!f || prior?.status !== "checking") return;
      let m;
      try {
        if (!ocrOn()) throw new Error("OCR is switched off (REPO_OCR=off)");
        const bytes = await r2.get(f.object_key);
        if (!bytes) throw new Error("the file is gone from storage");
        m = await ocrMarkings(bytes, prior.ocrPages ?? [], prior);
      } catch (e) {
        m = { status: "not-checked", reason: `not checked for markings: OCR failed (${e.message}); look at the cover yourself`, hits: prior.hits ?? [], pagesRead: prior.pagesRead ?? [] };
      }
      delete m.ocrPages;
      await saveMarkings(f.id, m);
    });
  }
  // After a restart the queue is empty: files still "checking" are put back in it.
  if (r2) {
    const t = setTimeout(async () => {
      try {
        for (const f of (await q(`SELECT sha256 FROM manual_files WHERE status = 'pending' AND checks->'markings'->>'status' = 'checking' ORDER BY created_at`)).rows) queueOcr(f.sha256);
      } catch (e) {
        console.error("ocr resume:", e.message);
      }
    }, 5000);
    t.unref?.();
  }

  // ----- this company's offers -----

  member.get("/repository/uploads", async (c) => {
    const install = c.get("install");
    const ref = str(c.req.header("x-shop-ref") ?? c.req.query("shopRef"), 64);
    if (!ref) throw fail(400, "Send X-Shop-Ref (or ?shopRef=): the company's id.");
    const { rows } = await q(
      `SELECT id, state, reason, sha256, size_bytes, offered, original_name, manual_id, created_at, updated_at FROM uploads
       WHERE install_id = $1 AND shop_ref = $2 ORDER BY created_at DESC LIMIT 200`,
      [install.id, ref],
    );
    return c.json({
      uploads: rows.map((u) => ({ id: u.id, state: u.state, reason: u.reason, sha256: u.sha256, sizeBytes: Number(u.size_bytes), offered: u.offered, originalName: u.original_name, manualId: u.manual_id, createdAt: u.created_at, updatedAt: u.updated_at })),
    });
  });

  // ----- the feed -----

  const itemOf = (m) =>
    m.status === "removed"
      ? { id: m.id, removed: true, why: m.why ?? "withdrawn", seq: String(m.seq) }
      : {
          id: m.id,
          category: m.category,
          brand: m.brand,
          models: m.models.split(/,\s*/),
          modelKeys: m.model_keys,
          docType: m.doc_type,
          year: m.year,
          language: m.language,
          title: m.title,
          fileName: libraryName(m),
          sizeBytes: Number(m.size_bytes),
          pages: m.pages,
          sha256: m.sha256,
          sha1: m.sha1,
          sourceUrl: m.source_url,
          seq: String(m.seq),
        };

  member.get("/repository/changes", async (c) => {
    const since = c.req.query("since") || "0";
    if (!/^\d{1,18}$/.test(since)) throw fail(400, "since is the number from the previous answer.");
    const asked = Math.floor(Number(c.req.query("limit")));
    const limit = Math.min(1000, asked >= 1 ? asked : 500);
    const { rows } = await q(
      `SELECT m.*, f.sha256, f.sha1, f.size_bytes, f.pages FROM manuals m LEFT JOIN manual_files f ON f.id = m.file_id
       WHERE m.seq > $1 AND m.seq <= $3 ORDER BY m.seq LIMIT $2`,
      [since, limit, (await feedLimit()).change],
    );
    return c.json({ manuals: rows.map(itemOf), next: rows.length ? String(rows[rows.length - 1].seq) : since, more: rows.length === limit });
  });

  // ----- downloads -----

  const dayCount = async (who) => Number((await one(`SELECT coalesce(sum(n), 0)::int AS n FROM repo_downloads WHERE day = $1 AND who = $2`, [today(), who])).n);
  const count = (fileId, whos) =>
    Promise.all(whos.map((who) => q(`INSERT INTO repo_downloads (file_id, day, who, n) VALUES ($1, $2, $3, 1) ON CONFLICT (file_id, day, who) DO UPDATE SET n = repo_downloads.n + 1`, [fileId, today(), who])));
  const published = (id) =>
    one(`SELECT m.*, f.id AS fid, f.sha256, f.sha1, f.size_bytes, f.pages, f.object_key FROM manuals m JOIN manual_files f ON f.id = m.file_id WHERE m.id = $1 AND m.status = 'published' AND f.status = 'published'`, [id]);
  const urlFor = (m, inline = false) => storage().getUrl(m.object_key, { fileName: libraryName(m), inline, expires: DOWNLOAD_SECONDS });

  member.post("/repository/files/:id/url", async (c) => {
    const install = c.get("install");
    storage();
    const who = `install:${install.id}`;
    if (!allow(`repo-url:${install.id}`, LIMITS.installUrlsPerHour)) throw fail(429, "Too many downloads in the last hour. The queue carries on later.");
    if ((await dayCount(who)) >= LIMITS.installUrlsPerDay) throw fail(429, "This install has downloaded as much as it may today. The queue carries on tomorrow.");
    const m = await published(c.req.param("id"));
    if (!m) throw fail(404, "That manual isn't in the repository (it may have been removed).");
    await count(m.fid, [who]);
    const u = urlFor(m);
    return c.json({ url: u.url, expiresAt: u.expiresAt, sha256: m.sha256, sizeBytes: Number(m.size_bytes) });
  });

  // ----- the free side: the logged-in /account "Manuals" page (design 0.1) -----

  const ipWho = (c) => `ip:${crypto.createHash("sha256").update(clientIp(c)).digest("hex").slice(0, 16)}`;
  const verifiedAccount = async (c) => {
    const a = await requireAccount(c);
    if (!a.verified_at) throw fail(403, "Confirm your email address first: open the link we sent you.");
    return a;
  };

  acct.get("/manuals", async (c) => {
    const a = await verifiedAccount(c);
    const words = String(c.req.query("q") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const params = [];
    const where = [`m.status = 'published'`, `f.status = 'published'`];
    for (const w of words) {
      params.push(`%${w.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(lower(m.brand) LIKE $${params.length} OR lower(m.models) LIKE $${params.length} OR lower(m.title) LIKE $${params.length} OR lower(m.doc_type) LIKE $${params.length} OR lower(coalesce(m.category, '')) LIKE $${params.length})`);
    }
    const dt = DOC_TYPES.find((d) => d.toLowerCase() === String(c.req.query("docType") ?? "").toLowerCase());
    if (dt) where.push(`m.doc_type = $${params.push(dt)}`);
    const brand = str(c.req.query("brand"), 60);
    if (brand) where.push(`lower(m.brand) = $${params.push(brand.toLowerCase())}`);
    const offset = Math.max(0, Math.floor(Number(c.req.query("offset"))) || 0);
    const from = `FROM manuals m JOIN manual_files f ON f.id = m.file_id WHERE ${where.join(" AND ")}`;
    const total = Number((await one(`SELECT count(*) AS n ${from}`, params)).n);
    const { rows } = await q(`SELECT m.*, f.sha256, f.size_bytes, f.pages ${from} ORDER BY lower(m.brand), lower(m.models), m.doc_type, m.year NULLS LAST LIMIT 50 OFFSET ${offset}`, params);
    const used = await dayCount(`account:${a.id}`);
    return c.json({
      total,
      offset,
      manuals: rows.map((m) => ({ id: m.id, category: m.category, brand: m.brand, models: m.models, docType: m.doc_type, year: m.year, language: m.language, title: m.title, sizeBytes: Number(m.size_bytes), pages: m.pages, fileName: libraryName(m) })),
      downloadsToday: used,
      downloadLimit: LIMITS.webDownloadsPerDay,
    });
  });

  acct.post("/manuals/:id/url", async (c) => {
    const a = await verifiedAccount(c);
    storage();
    const [mine, ip] = [`account:${a.id}`, ipWho(c)];
    if ((await dayCount(mine)) >= LIMITS.webDownloadsPerDay || (await dayCount(ip)) >= LIMITS.webDownloadsPerDay) {
      throw fail(429, `You've downloaded ${LIMITS.webDownloadsPerDay} manuals today, the most from the website. Try again tomorrow, or use StitchBench or StitchShop for more.`);
    }
    const m = await published(c.req.param("id"));
    if (!m) throw fail(404, "That manual isn't in the library (it may have been removed).");
    await count(m.fid, [mine, ip]);
    const u = urlFor(m);
    return c.json({ url: u.url, expiresAt: u.expiresAt, fileName: libraryName(m), remaining: LIMITS.webDownloadsPerDay - (await dayCount(mine)) });
  });

  // ----- the owner's review queue (admin) -----

  const queueItem = async (f) => {
    const ups = (await q(
      `SELECT u.*, s.name AS shop_name, a.email AS account_email, i.name AS install_name FROM uploads u
       LEFT JOIN shops s ON s.id = u.shop_id LEFT JOIN accounts a ON a.id = u.account_id LEFT JOIN installs i ON i.id = u.install_id
       WHERE u.file_id = $1 ORDER BY u.created_at`,
      [f.id],
    )).rows;
    const first = ups.find((u) => u.state === "pending") ?? ups[0];
    const offered = first?.offered ?? {};
    const keys = (offered.models ?? []).map(modelKey).filter(Boolean);
    const same = offered.brand
      ? (await q(`SELECT id, brand, models, doc_type, year, status, file_id FROM manuals WHERE lower(brand) = lower($1) AND doc_type = $2 AND ($3::text[] && model_keys) AND status = 'published' LIMIT 20`, [offered.brand, offered.docType, keys])).rows
      : [];
    // Any notice that named this brand (the checklist's item 6: a work an earlier notice named is flagged).
    const named = offered.brand
      ? (await q(`SELECT id, status, received_at FROM takedown_notices WHERE kind = 'notice' AND status IN ('actioned', 'countered', 'restored', 'lawsuit') AND position(lower($1) in lower(coalesce(work, '') || ' ' || coalesce(locations, ''))) > 0 LIMIT 10`, [offered.brand])).rows
      : [];
    return {
      fileId: f.id,
      earlierNotices: named.map((n) => ({ id: n.id, status: n.status, receivedAt: n.received_at })),
      sha256: f.sha256,
      sizeBytes: Number(f.size_bytes),
      pages: f.pages,
      createdAt: f.created_at,
      offered,
      composedName: offered.brand ? libraryName({ brand: offered.brand, models: (offered.models ?? []).join(", "), doc_type: offered.docType, year: offered.year }) : null,
      originalName: first?.original_name ?? null,
      checks: f.checks,
      // The distribution-markings flag (design 0.2), for the owner's eye: "flagged" with the page and the words around.
      markings: f.checks?.markings ?? { status: "not-checked", reason: "not checked for markings" },
      offers: ups.map((u) => ({ uploadId: u.id, state: u.state, byName: u.by_name, shop: u.shop_name, install: u.install_name, account: u.account_email, statementVersion: u.statement_version, statementAt: u.statement_at, createdAt: u.created_at })),
      otherFiles: same,
    };
  };

  admin.get("/repository", async (c) => {
    const files = (await q(`SELECT * FROM manual_files WHERE status = 'pending' ORDER BY created_at LIMIT 200`)).rows;
    const counts = (await one(`SELECT (SELECT count(*) FROM manual_files WHERE status = 'pending')::int AS waiting, (SELECT count(*) FROM manuals WHERE status = 'published')::int AS published, (SELECT count(*) FROM manuals WHERE status = 'removed')::int AS removed, (SELECT count(*) FROM blocked_hashes WHERE lifted_at IS NULL)::int AS blocked`));
    return c.json({ uploadsOn: uploadsOn(), storage: Boolean(r2), maxMb: Math.round(maxBytes() / MB), ...counts, waiting: await Promise.all(files.map(queueItem)) });
  });

  admin.get("/repository/files/:id/preview", async (c) => {
    const f = await one(`SELECT * FROM manual_files WHERE id = $1 AND status IN ('pending', 'published')`, [c.req.param("id")]);
    if (!f) throw fail(404, "No such file.");
    const u = storage().getUrl(f.object_key, { fileName: `${f.sha256.slice(0, 12)}.pdf`, inline: true, expires: DOWNLOAD_SECONDS });
    return c.json({ url: u.url, expiresAt: u.expiresAt });
  });

  admin.post("/repository/files/:id/approve", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const out = await tx(async (client) => {
      const f = (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
      if (!f) throw fail(404, "No such file.");
      if (f.status !== "pending") throw fail(409, "That file isn't waiting for review.");
      const first = (await client.query(`SELECT * FROM uploads WHERE file_id = $1 AND state = 'pending' ORDER BY created_at LIMIT 1`, [f.id])).rows[0];
      const m = cleanOffer({ ...(first?.offered ?? {}), ...(body.offered ?? body) });
      const id = newId();
      await client.query(
        `INSERT INTO manuals (id, category, brand, models, model_keys, doc_type, year, language, title, file_id, origin, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'user', 'published')`,
        [id, m.category, m.brand, m.models.join(", "), [...new Set(m.models.map(modelKey).filter((k) => k.length >= 2))], m.docType, m.year, m.language, m.title, f.id],
      );
      await client.query(`UPDATE manual_files SET status = 'published', manual_id = $2, updated_at = now() WHERE id = $1`, [f.id, id]);
      await client.query(`UPDATE uploads SET state = 'approved', manual_id = $2, updated_at = now() WHERE file_id = $1 AND state = 'pending'`, [f.id, id]);
      await client.query(`UPDATE uploads SET manual_id = $2 WHERE file_id = $1 AND state = 'duplicate'`, [f.id, id]);
      return { manualId: id, fileName: libraryName({ ...m, doc_type: m.docType, models: m.models.join(", ") }) };
    });
    return c.json({ ok: true, ...out });
  });

  admin.post("/repository/files/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reason = str(body.reason, 300);
    if (!reason) throw fail(400, "Give a reason: the person who offered the file sees it.");
    const f = await tx(async (client) => {
      const row = (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
      if (!row) throw fail(404, "No such file.");
      if (row.status !== "pending") throw fail(409, "That file isn't waiting for review.");
      await client.query(`UPDATE uploads SET state = 'rejected', reason = $2, updated_at = now() WHERE file_id = $1 AND state IN ('pending', 'duplicate')`, [row.id, reason]);
      if (body.blockHash === true) await client.query(`INSERT INTO blocked_hashes (sha256, why, file_id) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO UPDATE SET why = EXCLUDED.why, lifted_at = NULL`, [row.sha256, `rejected: ${reason}`, row.id]);
      await client.query(`DELETE FROM manual_files WHERE id = $1`, [row.id]);
      return row;
    });
    await storage().remove(f.object_key).catch((e) => console.error("repository: deleting a rejected file:", e.message));
    return c.json({ ok: true });
  });

  // A published manual taken down by the owner (withdrawn, or replaced by a better scan). The bytes go to retired/, so a
  // re-offer of the same file can bring them back; copyright removals (held/, strikes, the block) come with the takedown package.
  admin.post("/repository/manuals/:id/remove", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const why = ["withdrawn", "replaced"].includes(body.why) ? body.why : "withdrawn";
    const out = await tx(async (client) => {
      const m = (await client.query(`SELECT * FROM manuals WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
      if (!m) throw fail(404, "No such manual.");
      if (m.status === "removed") throw fail(409, "That manual is removed already.");
      const f = m.file_id ? (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [m.file_id])).rows[0] : null;
      await client.query(`UPDATE manuals SET status = 'removed', why = $2, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [m.id, why]);
      await client.query(`UPDATE uploads SET state = 'removed', updated_at = now() WHERE manual_id = $1 AND state = 'approved'`, [m.id]);
      let moved = null;
      if (f) {
        const to = `retired/${f.sha256}.pdf`;
        await storage().copy(f.object_key, to, { disposition: "attachment" });
        await client.query(`UPDATE manual_files SET status = 'retired', object_key = $2, updated_at = now() WHERE id = $1`, [f.id, to]);
        moved = f.object_key;
      }
      return moved;
    });
    if (out) await r2.remove(out).catch(() => {});
    return c.json({ ok: true });
  });

  admin.get("/repository/manuals", async (c) => {
    const word = `%${String(c.req.query("q") ?? "").toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    const { rows } = await q(
      `SELECT m.id, m.brand, m.models, m.doc_type, m.year, m.status, m.why, m.updated_at, f.sha256, f.size_bytes,
         (SELECT coalesce(sum(n), 0)::int FROM repo_downloads d WHERE d.file_id = f.id) AS downloads
       FROM manuals m LEFT JOIN manual_files f ON f.id = m.file_id
       WHERE lower(m.brand || ' ' || m.models || ' ' || m.title) LIKE $1 ORDER BY m.updated_at DESC LIMIT 200`,
      [word],
    );
    return c.json({ manuals: rows });
  });

  admin.get("/repository/blocked", async (c) => c.json({ blocked: (await q(`SELECT * FROM blocked_hashes ORDER BY created_at DESC LIMIT 500`)).rows }));
  admin.post("/repository/blocked", async (c) => {
    const body = await c.req.json();
    const sha = String(body.sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw fail(400, "Send the file's sha256 (64 hex digits).");
    await q(`INSERT INTO blocked_hashes (sha256, why) VALUES ($1, $2) ON CONFLICT (sha256) DO UPDATE SET why = EXCLUDED.why, lifted_at = NULL`, [sha, str(body.why, 300) ?? "blocked by the hub admin"]);
    return c.json({ ok: true });
  });
  admin.delete("/repository/blocked/:sha", async (c) => {
    const r = await q(`UPDATE blocked_hashes SET lifted_at = now() WHERE sha256 = $1 AND lifted_at IS NULL`, [c.req.param("sha").toLowerCase()]);
    if (!r.rowCount) throw fail(404, "That hash isn't blocked.");
    return c.json({ ok: true });
  });

  // Uploading ended (or given back) for an account, or for an install (a new account made to dodge it).
  for (const [route, table] of [["accounts", "accounts"], ["installs", "installs"]]) {
    admin.post(`/repository/${route}/:id/uploads`, async (c) => {
      const body = await c.req.json();
      const r = await q(`UPDATE ${table} SET repo_uploads_off = $2 WHERE id = $1`, [c.req.param("id"), body.off !== false]);
      if (!r.rowCount) throw fail(404, "No such record.");
      if (table === "accounts" && body.off !== false) {
        // Its waiting offers are rejected (design 4.2); published files stay for the owner to look at again.
        await q(`UPDATE uploads SET state = 'rejected', reason = 'Uploading ended for this account.', updated_at = now() WHERE account_id = $1 AND state = 'pending'`, [c.req.param("id")]);
        // The files themselves stay in the queue until the owner decides (another account may have offered the same bytes).
      }
      return c.json({ ok: true });
    });
  }

  // Slots nobody finished, and the old ones in the table: a day later they are history.
  const sweep = () =>
    q(`UPDATE uploads SET state = 'refused', reason = 'The upload was never finished.', updated_at = now() WHERE state IN ('slot', 'sent') AND created_at < now() - interval '1 day'`).catch((e) => console.error("repository sweep:", e.message));
  setInterval(sweep, 3600_000).unref();
}
