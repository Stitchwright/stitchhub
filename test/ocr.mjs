// Checks OCR for the markings check (src/ocr.mjs): scanned-style PDFs (one picture per page, no text layer, made by
// test/ocr-pdf.mjs) are drawn and read, and the same marking words are found; a clean scan finds nothing; a page that
// takes too long gives "not checked: OCR timed out"; REPO_OCR=off keeps the old answer. Then end to end on a hub of its
// own (fresh database, the R2 mock): the review queue says "checking" and then the result.
// usage: DATABASE_URL=postgresql://... (a role that may create databases) node test/ocr.mjs   (takes about a minute)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { inspectPdf } from "../src/pdfcheck.mjs";
import { ocrMarkings, ocrOn, ocrStop } from "../src/ocr.mjs";
import { scannedPdf } from "./ocr-pdf.mjs";
import { startR2Mock } from "./r2-mock.mjs";

const BASE_DB = process.env.DATABASE_URL;
assert.ok(BASE_DB, "set DATABASE_URL to a database on a server where the role may create databases");
const ADMIN = "ocr-test-admin-token";
const JOIN = "join-ocr-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ===== OCR on its own =====
{
  const dealer = scannedPdf([["Brother NV1 Service Manual", "DEALER USE ONLY"], ["Threading the needle"]]);
  const look = inspectPdf(dealer, { ocr: true });
  assert.equal(look.markings.status, "checking");
  assert.deepEqual(look.markings.ocrPages, [1, 2]);
  const t = Date.now();
  const m = await ocrMarkings(dealer, look.markings.ocrPages, look.markings);
  console.log(`OCR of 2 pages (cold start included): ${Date.now() - t} ms`);
  assert.equal(m.status, "flagged");
  assert.deepEqual(m.hits.map((h) => [h.level, h.label, h.page, h.ocr]), [["strong", "dealer only", 1, true]]);
  assert.match(m.hits[0].context, /DEALER USE ONLY/);
  assert.deepEqual(m.pagesRead, [1, 2]);

  // a clean scan finds nothing and is called clean, not unchecked
  const clean = scannedPdf([["Brother NV1 Service Manual", "Threading the needle and the bobbin"]]);
  const lc = inspectPdf(clean, { ocr: true });
  const mc = await ocrMarkings(clean, lc.markings.ocrPages, lc.markings);
  assert.equal(mc.status, "clean");
  assert.deepEqual(mc.pagesRead, [1]);
  // ... unless a page the check before OCR couldn't read at all (unread) is still unread: then it isn't clean
  const mu = await ocrMarkings(clean, lc.markings.ocrPages, { ...lc.markings, unread: [2] });
  assert.equal(mu.status, "not-checked");
  assert.match(mu.reason, /page 2 couldn't be read/);

  // the last page of a long scan is read, the middle ones are not
  const long = scannedPdf([["Cover page words"], ["two"], ["three"], ["four"], ["five"], ["Restricted document", "Not for distribution"]]);
  const ll = inspectPdf(long, { ocr: true });
  assert.deepEqual(ll.markings.ocrPages, [1, 2, 3, 6]);
  const ml = await ocrMarkings(long, ll.markings.ocrPages, ll.markings);
  assert.equal(ml.status, "flagged");
  assert.ok(ml.hits.every((h) => h.page === 6));
  assert.deepEqual(ml.hits.map((h) => h.label).sort(), ["not for distribution", "restricted"]);

  // REPO_OCR=off: the old answer
  process.env.REPO_OCR = "off";
  assert.equal(ocrOn(), false);
  const offLook = inspectPdf(dealer, { ocr: ocrOn() });
  assert.equal(offLook.markings.status, "not-checked");
  assert.match(offLook.markings.reason, /scan or unreadable text/);
  delete process.env.REPO_OCR;
  assert.equal(ocrOn(), true);

  // a page that takes too long
  process.env.REPO_OCR_PAGE_MS = "1";
  const mt = await ocrMarkings(dealer, [1, 2], {});
  assert.equal(mt.status, "not-checked");
  assert.match(mt.reason, /OCR timed out on pages 1, 2/);
  delete process.env.REPO_OCR_PAGE_MS;
  // and the engine is fine again afterwards
  assert.equal((await ocrMarkings(dealer, [1], {})).status, "flagged");

  // too big a file is not read
  process.env.REPO_OCR_MAX_MB = "0.001";
  const big = await ocrMarkings(dealer, [1], {});
  assert.match(big.reason, /too large/);
  delete process.env.REPO_OCR_MAX_MB;
  await ocrStop();
  console.log("ocr: ok");
}

// ===== end to end =====
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const dbUrl = (name) => { const u = new URL(BASE_DB); u.pathname = `/${name}`; return u.toString(); };
const FRESH = `stitchhub_ocr_${RUN}`;
{
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  await c.query(`CREATE DATABASE ${FRESH}`);
  await c.end();
}
const r2 = await startR2Mock({ bucket: "stitchhub-manuals" });
const db = new pg.Pool({ connectionString: dbUrl(FRESH), max: 2 });
let hub = null;
async function startHub(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl(FRESH), ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_URL: `http://127.0.0.1:${port}`, MAIL_DEV_LOG: "true", SMTP_URL: "", R2_ENDPOINT: r2.endpoint, R2_BUCKET: r2.bucket, R2_ACCESS_KEY_ID: r2.accessKeyId, R2_SECRET_ACCESS_KEY: r2.secret, REPO_UPLOADS: "on", REPO_OCR: "", REPO_OCR_PAGE_MS: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const h = { proc, url: `http://127.0.0.1:${port}`, log: "" };
  proc.stdout.on("data", (d) => (h.log += d));
  proc.stderr.on("data", (d) => (h.log += d));
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${h.log}`);
    if (await fetch(`${h.url}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error(`the hub didn't start:\n${h.log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return h;
}
const stopHub = (h) => new Promise((r) => (h.proc.exitCode !== null ? r() : (h.proc.once("exit", r), h.proc.kill())));
process.on("exit", () => hub?.proc.kill());
const call = (p, { key, json, headers = {} } = {}) => fetch(hub.url + p, { method: json !== undefined ? "POST" : "GET", headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const offered = { category: "Sewing machine", brand: "Brother", models: ["NV1"], docType: "ServiceManual", year: 2012, language: "English", title: "Brother NV1 service manual" };
async function upload(key, ref, bytes) {
  const slot = await ok(await call("/v1/repository/uploads", { key, headers: { "X-Shop-Ref": ref }, json: { sha256: sha(bytes), sizeBytes: bytes.length, fileName: "scan.pdf", offered, statement: { version: "2026-10-draft", accepted: true }, byName: "Tess Tech" } }));
  assert.equal((await fetch(slot.putUrl, { method: "PUT", headers: slot.putHeaders, body: bytes })).status, 200);
  return ok(await call(`/v1/repository/uploads/${slot.uploadId}/sent`, { key, headers: { "X-Shop-Ref": ref }, json: {} }));
}
const markingsOf = async (bytes) => (await db.query(`SELECT checks->'markings' AS m FROM manual_files WHERE sha256 = $1`, [sha(bytes)])).rows[0].m;
async function until(bytes, want, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const m = await markingsOf(bytes);
    if (m.status === want) return m;
    if (Date.now() > end) throw new Error(`still ${m.status} after ${ms} ms:\n${hub.log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function claim(key, ref) {
  await ok(await call("/v1/shops/claim", { key, json: { shopRef: ref, shopName: `${ref} shop`, kind: "repair", program: "StitchBench", version: "1.6.1" } }));
  const shopId = (await db.query(`SELECT id FROM shops WHERE shop_ref = $1`, [ref])).rows[0].id;
  const id = `acct_${ref}_${RUN}`.slice(0, 40);
  await db.query(`INSERT INTO accounts (id, email, verified_at) VALUES ($1, $2, now())`, [id, `${ref}-${RUN}@stitchhub.test`]);
  await db.query(`UPDATE shops SET account_id = $2 WHERE id = $1`, [shopId, id]);
}

let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await ocrStop().catch(() => {});
  await db.end().catch(() => {});
  if (hub) await stopHub(hub).catch(() => {});
  await r2.close().catch(() => {});
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
  await c.end();
};
try {
  hub = await startHub();
  const key = (await ok(await call("/v1/register", { json: { joinKey: JOIN, name: "OCR Test Install" } }))).installKey;
  await claim(key, "ocr-co");

  // a scan marked dealer-only: pending at once, "checking" in the queue, then flagged
  const dealer = scannedPdf([["Brother NV1 Service Manual", "DEALER USE ONLY"], ["Page two"]]);
  assert.equal((await upload(key, "ocr-co", dealer)).state, "pending");
  let m = await markingsOf(dealer);
  assert.equal(m.status, "checking");
  const queue = await ok(await fetch(`${hub.url}/v1/admin/repository`, { headers: { Authorization: `Bearer ${ADMIN}` } }));
  assert.equal(queue.waiting[0].markings.status, "checking");
  assert.match(queue.waiting[0].markings.reason, /checking for markings/);
  m = await until(dealer, "flagged");
  assert.deepEqual(m.hits.map((h) => [h.label, h.page]), [["dealer only", 1]]);
  assert.match(m.hits[0].context, /DEALER USE ONLY/);
  console.log("hub: scan flagged after OCR: ok");

  // a clean scan
  const clean = scannedPdf([["Brother NV1 Service Manual", "Cover with nothing special"]]);
  await upload(key, "ocr-co", clean);
  m = await until(clean, "clean");
  assert.deepEqual(m.pagesRead, [1]);
  console.log("hub: clean scan: ok");

  // a restart with a file still "checking" puts it back in the queue
  const resumed = scannedPdf([["Brother NV1 Service Manual", "CONFIDENTIAL"]]);
  await stopHub(hub);
  hub = await startHub({ REPO_OCR: "off" });
  await upload(key, "ocr-co", resumed); // filed as not-checked with OCR off; put it back to "checking" as a crash would leave it
  await stopHub(hub);
  const checking = { status: "checking", reason: "x", hits: [], pagesRead: [], ocrPages: [1] };
  await db.query(`UPDATE manual_files SET checks = jsonb_set(checks, '{markings}', $2::jsonb) WHERE sha256 = $1`, [sha(resumed), JSON.stringify(checking)]);
  hub = await startHub();
  m = await until(resumed, "flagged");
  assert.equal(m.hits[0].label, "confidential");
  console.log("hub: restart resumes: ok");

  // a timeout
  await stopHub(hub);
  hub = await startHub({ REPO_OCR_PAGE_MS: "1" });
  const slow = scannedPdf([["Brother NV1 Service Manual", "Timeout page"]]);
  await upload(key, "ocr-co", slow);
  m = await until(slow, "not-checked");
  assert.match(m.reason, /OCR timed out on page 1/);
  console.log("hub: timeout: ok");

  // REPO_OCR=off: the old answer at once
  await stopHub(hub);
  hub = await startHub({ REPO_OCR: "off" });
  const off = scannedPdf([["Brother NV1 Service Manual", "DEALER USE ONLY off"]]);
  await upload(key, "ocr-co", off);
  m = await markingsOf(off);
  assert.equal(m.status, "not-checked");
  assert.match(m.reason, /scan or unreadable text/);
  console.log("hub: REPO_OCR=off: ok");
  console.log("ocr tests passed");
} finally {
  await cleanup();
}
