// Checks the manual repository, hub side (docs/plans/manual-repository-design.md section 7, package repo-hub), end to end:
// a hub of its own on a free port against a fresh database (made and dropped here) with the R2 mock (test/r2-mock.mjs).
// Covers: the PDF check (structure, scripts, encryption, markings on the first three pages and the last), uploads off by
// default, the account rule (no, unverified, disabled, operator, stopped account; partner scope), slot -> PUT -> sent ->
// pending, wrong hash / size / not a PDF / encrypted / JavaScript refused with the object deleted, duplicates, blocked
// hashes, the 26th offer of a day (429) and the waiting limit, review (approve with corrections, reject with a reason
// and a block), the feed (named files, removals, its own cursor), download URLs only for published files, a company
// not seeing another's offers, the free Manuals page and its 25 a day, and export and import into a second hub.
// usage: DATABASE_URL=postgresql://... (a database on a server where the role may create databases) node test/repository.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { inspectPdf } from "../src/pdfcheck.mjs";
import { startR2Mock } from "./r2-mock.mjs";

const BASE_DB = process.env.DATABASE_URL;
assert.ok(BASE_DB, "set DATABASE_URL to a database on a server where the role may create databases (the test makes fresh ones beside it)");
const ADMIN = process.env.ADMIN_TOKEN ?? "repository-test-admin-token";
const JOIN = "join-repository-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ===== a PDF maker: just enough structure for the hub's reader =====
function makePdf({ pages = ["Service manual for the machine, page one"], flate = true, js = false, encrypt = false, escapedJs = false, hiddenJs = false, image = false, plain = [] } = {}) {
  const objs = [];
  const add = (n, body) => objs.push(`${n} 0 obj\n${body}\nendobj\n`);
  const stream = (dict, data) => {
    const bytes = flate ? zlib.deflateSync(Buffer.from(data, "latin1")) : Buffer.from(data, "latin1");
    return `<< ${dict}${flate ? " /Filter /FlateDecode" : ""} /Length ${bytes.length} >>\nstream\n${bytes.toString("latin1")}\nendstream`;
  };
  add(1, `<< /Type /Catalog /Pages 2 0 R${js ? " /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>" : ""}${escapedJs ? " /AA << /O << /S /J#53 /J#53 (x) >> >>" : ""} >>`);
  add(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((text, i) => {
    add(3 + 2 * i, `<< /Type /Page /Parent 2 0 R /Contents ${4 + 2 * i} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    // Strings with ( ) and escapes, a TJ array with kerning gaps, in a text object
    const body = image ? "q 100 0 0 100 0 0 cm /Im0 Do Q" : `BT /F1 12 Tf 72 700 Td [(${text.split(" ")[0]})-300(${text.split(" ").slice(1).join(" ").replace(/([()\\])/g, "\\$1")})] TJ ET`;
    add(4 + 2 * i, stream("", body));
  });
  let n = 3 + 2 * pages.length;
  if (js) add(n++, "<< /S /JavaScript /JS (this.print\\(\\)) >>");
  if (hiddenJs) {
    const inner = "<< /S /Launch /F (cmd.exe) >>";
    const head = "99 0 ";
    const bytes = zlib.deflateSync(Buffer.from(head + inner, "latin1"));
    add(n++, `<< /Type /ObjStm /N 1 /First ${head.length} /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n${bytes.toString("latin1")}\nendstream`);
  }
  for (const p of plain) add(n++, p);
  // Random binary in a stream: the names the hub refuses must not be found by chance in picture data.
  add(n++, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Length 40000 >>\nstream\n${crypto.randomBytes(40000).toString("latin1")}\nendstream`);
  return Buffer.from(`%PDF-1.7\n${objs.join("")}trailer\n<< /Root 1 0 R /Size ${n}${encrypt ? " /Encrypt 50 0 R" : ""} >>\n%%EOF\n`, "latin1");
}

// ===== the PDF check on its own =====
{
  const ok = inspectPdf(makePdf({ pages: ["Brother NV1 service manual cover page text here"] }));
  assert.equal(ok.refused, undefined);
  assert.equal(ok.pages, 1);
  assert.equal(ok.markings.status, "clean");
  assert.deepEqual(ok.markings.pagesRead, [1]);
  assert.equal(inspectPdf(makePdf({ flate: false })).markings.status, "clean");
  assert.match(inspectPdf(Buffer.from("<html>not a pdf at all</html>")).refused, /isn't a PDF/);
  assert.match(inspectPdf(makePdf({ encrypt: true })).refused, /encrypted/);
  assert.match(inspectPdf(makePdf({ js: true })).refused, /\/JavaScript/);
  assert.match(inspectPdf(makePdf({ escapedJs: true })).refused, /\/JS/, "a name written with #-escapes is found");
  assert.match(inspectPdf(makePdf({ hiddenJs: true })).refused, /\/Launch/, "a name inside an object stream is found");
  for (const bad of ["EmbeddedFile", "RichMedia", "XFA"]) assert.match(inspectPdf(makePdf({ plain: [`<< /Type /${bad} >>`] })).refused, new RegExp(bad));
  assert.equal(inspectPdf(makePdf({ plain: ["<< /Type /JSON /Subtype /Launchpad >>"] })).refused, undefined, "a longer name isn't the refused one");
  // The first three pages and the last are read for markings; the middle ones are not.
  const ten = (marks) => Array.from({ length: 10 }, (_, i) => `Page ${i + 1} ordinary words about threading ${marks[i] ?? ""}`);
  let r = inspectPdf(makePdf({ pages: ten({ 0: "CONFIDENTIAL" }) }));
  assert.equal(r.pages, 10);
  assert.equal(r.markings.status, "flagged");
  assert.deepEqual(r.markings.hits.map((h) => [h.level, h.label, h.page]), [["strong", "confidential", 1]]);
  assert.match(r.markings.hits[0].context, /CONFIDENTIAL/);
  r = inspectPdf(makePdf({ pages: ten({ 9: "Dealer use only" }) }));
  assert.deepEqual(r.markings.hits.map((h) => [h.label, h.page]), [["dealer only", 10]], "the last page");
  r = inspectPdf(makePdf({ pages: ten({ 2: "For service personnel only" }) }));
  assert.deepEqual(r.markings.hits.map((h) => [h.level, h.label, h.page]), [["medium", "service personnel only", 3]]);
  r = inspectPdf(makePdf({ pages: ten({ 4: "CONFIDENTIAL", 5: "not for distribution" }) }));
  assert.equal(r.markings.status, "clean", "pages 4 to 9 aren't read");
  assert.deepEqual(r.markings.pagesRead, [1, 2, 3, 10]);
  r = inspectPdf(makePdf({ pages: ["PROPRIETARY AND CONFIDENTIAL cover, all rights reserved here"] }));
  assert.deepEqual(r.markings.hits.map((h) => h.label).sort(), ["confidential", "proprietary"]);
  // An image-only file has no text to read: said so, not called clean.
  r = inspectPdf(makePdf({ pages: ["a", "b"], image: true }));
  assert.equal(r.markings.status, "not-checked");
  assert.match(r.markings.reason, /scan or unreadable text/);
  console.log("pdf check: ok");
}

// ===== databases and hubs =====
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const dbUrl = (name) => { const u = new URL(BASE_DB); u.pathname = `/${name}`; return u.toString(); };
const FRESH = [`stitchhub_repo_${RUN}`, `stitchhub_repo2_${RUN}`];
{
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  for (const n of FRESH) await c.query(`CREATE DATABASE ${n}`);
  await c.end();
}
const r2 = await startR2Mock({ bucket: "stitchhub-manuals" });
const db = new pg.Pool({ connectionString: dbUrl(FRESH[0]), max: 2 });
const OPERATOR_EMAIL = `operator-${RUN}@stitchhub.test`;

function startHub(database, env = {}) {
  return (async () => {
    const port = await freePort();
    const proc = spawn(process.execPath, ["src/server.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(database),
        ADMIN_TOKEN: ADMIN,
        JOIN_KEY: JOIN,
        PORT: String(port),
        LINK_CHECKER: "off",
        TRUST_PROXY: "",
        RAILWAY_ENVIRONMENT_ID: "",
        HUB_URL: `http://127.0.0.1:${port}`,
        MAIL_DEV_LOG: "true",
        SMTP_URL: "",
        HUB_NAME: "Repository Test Hub",
        R2_ENDPOINT: r2.endpoint,
        R2_BUCKET: r2.bucket,
        R2_ACCESS_KEY_ID: r2.accessKeyId,
        R2_SECRET_ACCESS_KEY: r2.secret,
        REPO_UPLOADS: "",
        REPO_OPERATOR_ACCOUNTS: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hub = { proc, url: `http://127.0.0.1:${port}`, log: "" };
    proc.stdout.on("data", (d) => (hub.log += d));
    proc.stderr.on("data", (d) => (hub.log += d));
    for (let i = 0; ; i++) {
      if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hub.log}`);
      if (await fetch(`${hub.url}/health`).then((r) => r.ok, () => false)) break;
      if (i > 300) throw new Error(`the hub didn't start:\n${hub.log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return hub;
  })();
}
const stopHub = (hub) => new Promise((r) => (hub.proc.exitCode !== null ? r() : (hub.proc.once("exit", r), hub.proc.kill())));
let hub = await startHub(FRESH[0]);
let hub2 = null;
let stopped = false;
const cleanup = async () => {
  if (stopped) return;
  stopped = true;
  await db.end().catch(() => {});
  for (const h of [hub, hub2]) if (h) await stopHub(h).catch(() => {});
  await r2.close().catch(() => {});
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  for (const n of FRESH) await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await c.end();
};
process.on("exit", () => { hub?.proc.kill(); hub2?.proc.kill(); });

// ===== helpers =====
let on = hub.url;
async function call(p, { key, method = "GET", json, headers = {}, cookie, base = on } = {}) {
  return fetch(base + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
}
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const admin = (p, json, method) => call(`/v1/admin${p}`, { key: ADMIN, json, method });
const cookies = new Map();

/** A company on the install, claimed on the hub; with `account` it belongs to a verified (or not) account and gets a browser session. */
async function company(key, ref, { account = "verified", email = `${ref}-${RUN}@stitchhub.test`, accountId } = {}) {
  await ok(await call("/v1/shops/claim", { key, json: { shopRef: ref, shopName: `${ref} shop`, kind: "repair", program: "StitchBench", version: "1.6.1" } }));
  const shopId = (await db.query(`SELECT id FROM shops WHERE shop_ref = $1`, [ref])).rows[0].id;
  if (account) {
    const id = accountId ?? `acct_${ref}_${RUN}`.slice(0, 40);
    if (!accountId) await db.query(`INSERT INTO accounts (id, email, verified_at, disabled) VALUES ($1, $2, $3, $4)`, [id, email, account === "unverified" ? null : new Date(), account === "disabled"]);
    await db.query(`UPDATE shops SET account_id = $2 WHERE id = $1`, [shopId, id]);
    const cookie = crypto.randomBytes(24).toString("base64url");
    await db.query(`INSERT INTO sessions (id_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [sha(cookie), id]);
    cookies.set(ref, `hub_session=${cookie}`);
    return { ref, id, email, shopId };
  }
  return { ref, id: null, shopId };
}

const offered = (over = {}) => ({ category: "Sewing machine", brand: "Brother", models: ["NV1"], docType: "ServiceManual", year: 2012, language: "English", title: "Brother NV1 service manual", ...over });
const statement = { version: "2026-10-draft", accepted: true };
const offer = (key, ref, bytes, over = {}, extra = {}) =>
  call("/v1/repository/uploads", { key, headers: { "X-Shop-Ref": ref }, json: { sha256: sha(bytes), sizeBytes: bytes.length, fileName: "scan.pdf", offered: offered(over), statement, byName: "Tess Tech", ...extra } });
const put = (slot, bytes) => fetch(slot.putUrl, { method: "PUT", headers: slot.putHeaders, body: bytes });
const sent = (key, ref, id) => call(`/v1/repository/uploads/${id}/sent`, { key, headers: { "X-Shop-Ref": ref }, json: {} });
/** The whole walk: offer, PUT, sent. Returns the answers. */
async function walk(key, ref, bytes, over) {
  const slot = await ok(await offer(key, ref, bytes, over));
  assert.ok(slot.uploadId, JSON.stringify(slot));
  const p = await put(slot, bytes);
  assert.equal(p.status, 200, await p.text());
  return { slot, done: await ok(await sent(key, ref, slot.uploadId)) };
}
const incoming = () => [...r2.objects.keys()].filter((k) => k.startsWith("incoming/"));

try {
  const key1 = await register("Repository Test Install 1");
  const key2 = await register("Repository Test Install 2");
  const pdfA = makePdf({ pages: ["Brother NV1 service manual cover page text here", "Page two about adjusting the needle bar height"] });

  // ----- uploads are off by default -----
  const main = await company(key1, "main");
  let off = await status(await offer(key1, "main", pdfA), 403, "uploads off");
  assert.match(off.error, /opens soon/);
  assert.equal(r2.objects.size, 0);
  assert.equal((await ok(await call("/v1/repository/changes", { key: key1 }))).manuals.length, 0, "reading the (empty) feed needs no switch");
  assert.equal((await ok(await admin("/repository"))).uploadsOn, false);
  console.log("uploads off by default: ok");

  // ----- switched on, with an operator account -----
  await stopHub(hub);
  hub = await startHub(FRESH[0], { REPO_UPLOADS: "on", REPO_OPERATOR_ACCOUNTS: OPERATOR_EMAIL });
  on = hub.url;
  assert.equal((await ok(await admin("/repository"))).uploadsOn, true);
  // The member routes need an install key; a partner-scope install is refused before the route.
  await status(await call("/v1/repository/uploads", { json: {} }), 401, "no key");
  const partnerKey = await register("Repository Partner Install");
  await db.query(`UPDATE installs SET scope = 'partner' WHERE name = 'Repository Partner Install'`);
  const partner = await company(partnerKey, "partner-co");
  await status(await offer(partnerKey, "partner-co", pdfA), 403, "partner scope");
  await status(await call("/v1/repository/changes", { key: partnerKey }), 403, "partner scope feed");
  await status(await call("/v1/repository/uploads", { key: partnerKey, headers: { "X-Shop-Ref": "partner-co" } }), 403, "partner scope list");
  // The account rule.
  await company(key1, "noacct", { account: null });
  await status(await offer(key1, "noacct", pdfA), 403, "no account");
  await company(key1, "unver", { account: "unverified" });
  assert.match((await status(await offer(key1, "unver", pdfA), 403, "unverified account")).error, /verified/);
  await company(key1, "dis", { account: "disabled" });
  await status(await offer(key1, "dis", pdfA), 403, "disabled account");
  await company(key1, "op", { email: OPERATOR_EMAIL });
  assert.match((await status(await offer(key1, "op", pdfA), 403, "operator account")).error, /hub's own account/);
  const stopped1 = await company(key1, "stopped");
  await ok(await admin(`/repository/accounts/${stopped1.id}/uploads`, { off: true }));
  assert.match((await status(await offer(key1, "stopped", pdfA), 403, "uploads ended for the account")).error, /ended for this account/);
  await ok(await admin(`/repository/accounts/${stopped1.id}/uploads`, { off: false }));
  await ok(await offer(key1, "stopped", pdfA)); // back
  await status(await offer(key1, "ghost", pdfA), 403, "a company that never claimed itself");
  await status(await call("/v1/repository/uploads", { key: key1, json: { sha256: sha(pdfA), sizeBytes: pdfA.length, offered: offered(), statement } }), 400, "no X-Shop-Ref");
  console.log("the account rule: ok");

  // ----- what an offer must say -----
  const bad = (over, extra, re) => offer(key1, "main", pdfA, over, extra).then((r) => status(r, [400, 413].includes(r.status) ? r.status : 400, JSON.stringify(over)).then((b) => assert.match(b.error, re)));
  await bad({ brand: "" }, {}, /brand/);
  await bad({ models: [] }, {}, /model/);
  await bad({ docType: "Cookbook" }, {}, /document type/);
  await bad({ category: "" }, {}, /category/);
  await bad({ year: 1800 }, {}, /year/);
  await bad({}, { statement: { version: "x", accepted: false } }, /statement/);
  await bad({}, { sha256: "abc" }, /sha256/);
  await bad({}, { sizeBytes: 151 * 1024 * 1024 }, /150 MB/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM uploads WHERE shop_ref = 'main'`)).rows[0].n, 0, "nothing recorded for a bad offer");
  console.log("offer fields: ok");

  // ----- slot -> PUT -> sent -> pending -----
  const slot = await ok(await offer(key1, "main", pdfA));
  assert.match(slot.putUrl, new RegExp(`^${r2.endpoint}/stitchhub-manuals/incoming/${slot.uploadId}\\.pdf\\?`));
  assert.deepEqual(slot.putHeaders, { "Content-Type": "application/pdf", "Content-Length": String(pdfA.length) });
  assert.ok(new Date(slot.expiresAt) - Date.now() > 14 * 60_000);
  // Sent before the file arrived: told so, and the slot stays open.
  assert.match((await status(await sent(key1, "main", slot.uploadId), 409, "sent before the PUT")).error, /hasn't arrived/);
  // A PUT of other bytes than the offer's size is refused by storage itself (the length is signed).
  assert.equal((await fetch(slot.putUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: Buffer.concat([pdfA, pdfA]) })).status, 403);
  assert.equal((await put(slot, pdfA)).status, 200);
  // Company B (another install) can't say another's offer was sent, nor see it.
  await company(key2, "other-install-co");
  await status(await sent(key2, "other-install-co", slot.uploadId), 404, "another install's offer");
  await status(await sent(key1, "unver", slot.uploadId), 404, "another company's offer");
  const done = await ok(await sent(key1, "main", slot.uploadId));
  assert.deepEqual(done, { state: "pending", reason: null });
  assert.deepEqual(await ok(await sent(key1, "main", slot.uploadId)), { state: "pending", reason: null }, "asking again changes nothing");
  assert.deepEqual(incoming(), [], "the incoming object is gone");
  const stored = r2.objects.get(`files/${sha(pdfA)}.pdf`);
  assert.deepEqual(stored.bytes, pdfA);
  assert.equal(stored.contentType, "application/pdf");
  assert.match(stored.disposition, /^attachment; filename="Brother_NV1_ServiceManual_2012\.pdf"$/);
  const file = (await db.query(`SELECT * FROM manual_files WHERE sha256 = $1`, [sha(pdfA)])).rows[0];
  assert.equal(file.status, "pending");
  assert.equal(file.pages, 2);
  assert.equal(file.sha1, crypto.createHash("sha1").update(pdfA).digest("hex"));
  assert.equal(file.checks.markings.status, "clean");
  // Pending is not published: no feed item, no download.
  assert.equal((await ok(await call("/v1/repository/changes", { key: key1 }))).manuals.length, 0);
  console.log("slot, PUT, sent, pending: ok");

  // ----- refused: wrong hash, wrong size, not a PDF, encrypted, JavaScript -----
  {
    // wrong hash: the offer names another file's hash (same length), the bytes that arrive are different
    const a = makePdf({ pages: ["Wrong hash: this is what was offered, long enough"] });
    const b = Buffer.from(a); b[b.length - 10] ^= 1;
    const s = await ok(await offer(key1, "main", a));
    assert.equal((await put(s, b)).status, 200);
    const r = await ok(await sent(key1, "main", s.uploadId));
    assert.equal(r.state, "refused");
    assert.match(r.reason, /don't match its sha256/);
    assert.deepEqual(incoming(), [], "object deleted after a wrong hash");
    // wrong size: bytes put in storage another way (as if the length weren't signed)
    const c2 = makePdf({ pages: ["Wrong size: offered one length, stored another one"] });
    const s2 = await ok(await offer(key1, "main", c2));
    r2.put(`incoming/${s2.uploadId}.pdf`, Buffer.concat([c2, Buffer.from("x")]));
    const r3 = await ok(await sent(key1, "main", s2.uploadId));
    assert.equal(r3.state, "refused");
    assert.match(r3.reason, /size/);
    assert.deepEqual(incoming(), []);
    for (const [bytes, re, what] of [
      [Buffer.from("<html><body>This is a web page, not a PDF at all, padded.</body></html>"), /isn't a PDF/, "not a pdf"],
      [makePdf({ encrypt: true }), /encrypted/, "encrypted"],
      [makePdf({ js: true }), /JavaScript/, "javascript"],
      [makePdf({ hiddenJs: true }), /Launch/, "launch in an object stream"],
    ]) {
      const w = await walk(key1, "main", bytes);
      assert.equal(w.done.state, "refused", what);
      assert.match(w.done.reason, re, what);
      assert.deepEqual(incoming(), [], `object deleted: ${what}`);
      assert.equal(r2.objects.has(`files/${sha(bytes)}.pdf`), false, `never filed: ${what}`);
    }
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM manual_files`)).rows[0].n, 1, "only the good file has a row");
  }
  console.log("refused files (hash, size, not a PDF, encrypted, scripts): ok");

  // ----- duplicates -----
  const dupA = await ok(await offer(key1, "main", pdfA));
  assert.equal(dupA.duplicate, true);
  assert.equal(dupA.id, file.id, "waiting: the file's id");
  assert.equal(dupA.uploadId, undefined, "no slot for a duplicate");
  await company(key1, "dupco");
  const dupB = await ok(await offer(key1, "dupco", pdfA, { brand: "Another" }));
  assert.equal(dupB.duplicate, true);
  console.log("duplicates: ok");

  // ----- review: the queue, approve with corrections -----
  const marked = makePdf({ pages: ["Brother PR1000 owners guide front cover text", "DEALER USE ONLY please do not copy this page around", "third page with ordinary words"] });
  const wm = await walk(key1, "main", marked, { brand: "brother", models: ["PR1000e"], docType: "OperatorManual", year: null });
  assert.equal(wm.done.state, "pending");
  let q1 = await ok(await admin("/repository"));
  assert.equal(q1.waiting.length, 2);
  const itemA = q1.waiting.find((f) => f.sha256 === sha(pdfA));
  const itemM = q1.waiting.find((f) => f.sha256 === sha(marked));
  assert.equal(itemA.markings.status, "clean");
  assert.equal(itemM.markings.status, "flagged");
  assert.deepEqual(itemM.markings.hits.map((h) => [h.level, h.label, h.page]), [["strong", "dealer only", 2]]);
  assert.match(itemM.markings.hits[0].context, /DEALER USE ONLY/);
  assert.equal(itemA.composedName, "Brother_NV1_ServiceManual_2012.pdf");
  assert.equal(itemA.offers.length, 3, "the offer and the two duplicates are listed with it");
  assert.equal(itemA.offers[0].byName, "Tess Tech");
  const prev = await ok(await admin(`/repository/files/${itemA.fileId}/preview`));
  const pr = await fetch(prev.url);
  assert.equal(pr.status, 200);
  assert.match(pr.headers.get("content-disposition"), /^inline;/);
  assert.deepEqual(Buffer.from(await pr.arrayBuffer()), pdfA);
  await status(await admin(`/repository/files/${itemA.fileId}/approve`, { offered: { brand: "" } }), 400, "approve with an empty brand");
  const approved = await ok(await admin(`/repository/files/${itemA.fileId}/approve`, { offered: { models: "NV1, NV-1800Q", year: 2013 } }));
  assert.equal(approved.fileName, "Brother_NV1_ServiceManual_2013.pdf");
  await status(await admin(`/repository/files/${itemA.fileId}/approve`, {}), 409, "approve twice");
  assert.deepEqual((await db.query(`SELECT state FROM uploads WHERE file_id = $1 ORDER BY created_at`, [itemA.fileId])).rows.map((r) => r.state), ["approved", "duplicate", "duplicate"]);

  // ----- the feed, named; downloads only for published files -----
  const feed = await ok(await call("/v1/repository/changes", { key: key2 }));
  assert.equal(feed.manuals.length, 1);
  const item = feed.manuals[0];
  assert.deepEqual(
    { ...item, seq: undefined },
    {
      id: approved.manualId, category: "Sewing machine", brand: "Brother", models: ["NV1", "NV-1800Q"], modelKeys: ["NV1", "NV1800Q"], docType: "ServiceManual", year: 2013, language: "English",
      title: "Brother NV1 service manual", fileName: "Brother_NV1_ServiceManual_2013.pdf", sizeBytes: pdfA.length, pages: 2, sha256: sha(pdfA), sha1: file.sha1, sourceUrl: null, seq: undefined,
    },
  );
  assert.equal(feed.next, item.seq);
  assert.equal(feed.more, false);
  assert.equal((await ok(await call(`/v1/repository/changes?since=${feed.next}`, { key: key2 }))).manuals.length, 0, "nothing after the cursor");
  await status(await call("/v1/repository/changes?since=abc", { key: key2 }), 400, "a bad cursor");
  const dl = await ok(await call(`/v1/repository/files/${item.id}/url`, { key: key2, json: {} }));
  assert.equal(dl.sha256, sha(pdfA));
  assert.equal(dl.sizeBytes, pdfA.length);
  assert.ok(new Date(dl.expiresAt) - Date.now() < 301_000);
  const got = await fetch(dl.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/pdf");
  assert.equal(got.headers.get("content-disposition"), 'attachment; filename="Brother_NV1_ServiceManual_2013.pdf"');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), pdfA);
  await status(await call(`/v1/repository/files/${itemM.fileId}/url`, { key: key2, json: {} }), 404, "a file waiting for review (by its file id)");
  await status(await call(`/v1/repository/files/nope/url`, { key: key2, json: {} }), 404, "no such manual");
  await status(await call(`/v1/repository/files/${item.id}/url`, { json: {} }), 401, "no key");
  await status(await call(`/v1/repository/files/${item.id}/url`, { key: partnerKey, json: {} }), 403, "partner scope");
  // The listing is the company's own: another install, or another company on the same install, sees none of main's.
  const mine = await ok(await call("/v1/repository/uploads", { key: key1, headers: { "X-Shop-Ref": "main" } }));
  assert.ok(mine.uploads.length >= 6);
  assert.deepEqual(mine.uploads.filter((u) => u.sha256 === sha(pdfA)).map((u) => [u.state, u.manualId]).sort(), [["approved", approved.manualId], ["duplicate", approved.manualId]]);
  assert.ok(mine.uploads.some((u) => u.state === "refused" && /isn't a PDF/.test(u.reason)));
  assert.deepEqual((await ok(await call("/v1/repository/uploads", { key: key2, headers: { "X-Shop-Ref": "main" } }))).uploads, [], "another install asking for main's offers");
  assert.deepEqual((await ok(await call("/v1/repository/uploads", { key: key1, headers: { "X-Shop-Ref": "unver" } }))).uploads, [], "another company on the same install");
  assert.deepEqual((await ok(await call("/v1/repository/uploads?shopRef=other-install-co", { key: key2 }))).uploads, []);
  console.log("review, feed, download URLs, own offers only: ok");

  // ----- reject: a reason, the object deleted, the hash blocked on request -----
  await status(await admin(`/repository/files/${itemM.fileId}/reject`, {}), 400, "reject without a reason");
  await ok(await admin(`/repository/files/${itemM.fileId}/reject`, { reason: "Marked dealer only", blockHash: true }));
  assert.equal(r2.objects.has(`files/${sha(marked)}.pdf`), false, "object deleted");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM manual_files WHERE sha256 = $1`, [sha(marked)])).rows[0].n, 0);
  const rej = (await ok(await call("/v1/repository/uploads", { key: key1, headers: { "X-Shop-Ref": "main" } }))).uploads.find((u) => u.sha256 === sha(marked));
  assert.deepEqual([rej.state, rej.reason], ["rejected", "Marked dealer only"]);
  const blk = await ok(await offer(key1, "main", marked));
  assert.equal(blk.blocked, true, "a blocked hash gets no slot");
  assert.equal(blk.uploadId, undefined);
  assert.equal((await ok(await admin("/repository/blocked"))).blocked.length, 1);
  await ok(await admin(`/repository/blocked/${sha(marked)}`, undefined, "DELETE"));
  assert.ok((await ok(await offer(key1, "main", marked))).uploadId, "lifted: offered again");
  // A hash blocked by hand, before any upload; a rejection without a block leaves the file offerable.
  const never = makePdf({ pages: ["Blocked in advance by the hub owner for testing"] });
  await ok(await admin("/repository/blocked", { sha256: sha(never), why: "test" }));
  assert.equal((await ok(await offer(key1, "main", never))).blocked, true);
  const w2 = await walk(key1, "main", makePdf({ pages: ["Rejected only this time, not blocked, readable text"] }));
  await ok(await admin(`/repository/files/${(await db.query(`SELECT id FROM manual_files WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`)).rows[0].id}/reject`, { reason: "Poor scan" }));
  assert.ok((await ok(await offer(key1, "main", makePdf({ pages: ["Rejected only this time, not blocked, readable text"] })))).uploadId);
  void w2;
  console.log("reject, blocked hashes: ok");

  // ----- remove, and the feed says so -----
  await ok(await admin(`/repository/manuals/${approved.manualId}/remove`, { why: "replaced" }));
  await status(await admin(`/repository/manuals/${approved.manualId}/remove`, {}), 409, "removed twice");
  const after = await ok(await call(`/v1/repository/changes?since=${feed.next}`, { key: key2 }));
  assert.deepEqual(after.manuals.map((m) => [m.id, m.removed, m.why]), [[approved.manualId, true, "replaced"]]);
  await status(await call(`/v1/repository/files/${approved.manualId}/url`, { key: key2, json: {} }), 404, "a removed manual");
  assert.equal(r2.objects.has(`files/${sha(pdfA)}.pdf`), false);
  assert.equal(r2.objects.has(`retired/${sha(pdfA)}.pdf`), true, "kept in retired/");
  // Offered again: it is not "already there", and comes back through review.
  const again = await walk(key1, "main", pdfA);
  assert.equal(again.done.state, "pending");
  assert.equal(r2.objects.has(`retired/${sha(pdfA)}.pdf`), true);
  const re = (await ok(await admin("/repository"))).waiting.find((f) => f.sha256 === sha(pdfA));
  const approved2 = await ok(await admin(`/repository/files/${re.fileId}/approve`, {}));
  assert.equal((await ok(await call("/v1/repository/changes", { key: key2 }))).manuals.filter((m) => !m.removed).length, 1);
  console.log("remove and re-offer: ok");

  // ----- limits: 25 offers a day per company (the 26th: 429), 50 waiting per account -----
  const lim = await company(key1, "lim25");
  for (let i = 0; i < 25; i++) assert.ok((await ok(await offer(key1, "lim25", crypto.randomBytes(300), {}, {}))).uploadId, `offer ${i + 1}`);
  const over = await status(await offer(key1, "lim25", crypto.randomBytes(300)), 429, "the 26th offer");
  assert.match(over.error, /25 offers/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM uploads WHERE shop_ref = 'lim25'`)).rows[0].n, 25);
  // Another company is not held up by it (and keeps its own 25).
  assert.ok((await ok(await offer(key1, "main", crypto.randomBytes(300)))).uploadId);
  // 50 waiting per account: two companies on one account make 25 each, the third's first offer is the 51st.
  const w1 = await company(key1, "w1");
  await company(key1, "w2", { accountId: w1.id });
  await company(key1, "w3", { accountId: w1.id });
  for (const ref of ["w1", "w2"]) for (let i = 0; i < 25; i++) await ok(await offer(key1, ref, crypto.randomBytes(300)));
  assert.match((await status(await offer(key1, "w3", crypto.randomBytes(300)), 429, "the 51st waiting")).error, /waiting for review/);
  // The account's own day: 100 files.
  console.log("limits: ok");

  // ----- the free side: /account/manuals -----
  assert.equal((await call("/account/manuals")).status, 200);
  await status(await call("/account/api/manuals"), 401, "no session");
  await status(await call("/account/api/manuals", { cookie: cookies.get("unver") }), 403, "unverified account");
  const list = await ok(await call("/account/api/manuals?q=brother%20nv1", { cookie: cookies.get("main") }));
  assert.equal(list.total, 1);
  assert.deepEqual(list.manuals.map((m) => [m.brand, m.models, m.docType, m.year, m.fileName]), [["Brother", "NV1", "ServiceManual", 2012, "Brother_NV1_ServiceManual_2012.pdf"]]);
  assert.equal(list.downloadLimit, 25);
  assert.equal((await ok(await call("/account/api/manuals?q=bernina", { cookie: cookies.get("main") }))).total, 0);
  assert.equal((await ok(await call("/account/api/manuals?docType=PartsList", { cookie: cookies.get("main") }))).total, 0);
  assert.equal((await ok(await call("/account/api/manuals?q=nv1&docType=ServiceManual", { cookie: cookies.get("main") }))).total, 1);
  assert.equal((await ok(await call("/account/api/manuals?q=%25", { cookie: cookies.get("main") }))).total, 0, "a percent sign is just a character");
  const wd = await ok(await call(`/account/api/manuals/${approved2.manualId}/url`, { json: {}, cookie: cookies.get("main") }));
  assert.equal(wd.remaining, 24);
  assert.deepEqual(Buffer.from(await (await fetch(wd.url)).arrayBuffer()), pdfA);
  await status(await call(`/account/api/manuals/${approved2.manualId}/url`, { json: {} }), 401, "download without a session");
  await status(await call(`/account/api/manuals/${itemM.fileId}/url`, { json: {}, cookie: cookies.get("main") }), 404, "a file not published");
  for (let i = 0; i < 24; i++) await ok(await call(`/account/api/manuals/${approved2.manualId}/url`, { json: {}, cookie: cookies.get("main") }));
  assert.match((await status(await call(`/account/api/manuals/${approved2.manualId}/url`, { json: {}, cookie: cookies.get("main") }), 429, "the 26th download")).error, /25 manuals today/);
  // The same address is counted too: another account from here is also stopped after 25 from this address.
  assert.match((await status(await call(`/account/api/manuals/${approved2.manualId}/url`, { json: {}, cookie: cookies.get("lim25") }), 429, "same address")).error, /25 manuals today/);
  assert.equal((await ok(await call("/account/api/manuals?q=nv1", { cookie: cookies.get("main") }))).downloadsToday, 25);
  assert.equal((await db.query(`SELECT coalesce(sum(n), 0)::int AS n FROM repo_downloads WHERE who LIKE 'ip:%'`)).rows[0].n, 25);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM repo_downloads WHERE who LIKE '%127.0.0.1%'`)).rows[0].n, 0, "no address is stored, only a hash");
  console.log("the Manuals page and its limit: ok");

  // ----- the export carries it, and a second hub takes it -----
  const gz = Buffer.from(await (await admin("/export")).arrayBuffer());
  const lines = zlib.gunzipSync(gz).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const count = (t) => lines.filter((l) => l.t === t).length;
  assert.equal(count("manual"), 2);
  assert.ok(count("manual_file") >= 1 && count("upload") >= 60 && count("blocked_hash") >= 2 && count("repo_download") >= 2, JSON.stringify(Object.fromEntries(["manual_file", "upload", "blocked_hash", "repo_download"].map((t) => [t, count(t)]))));
  assert.ok(lines.filter((l) => l.t === "manual").every((l) => l.seq != null), "manuals carry their change number");
  assert.equal(lines.find((l) => l.t === "account" && l.id === stopped1.id).repo_uploads_off, false);
  hub2 = await startHub(FRESH[1], { REPO_UPLOADS: "on" });
  const imp = await ok(await fetch(`${hub2.url}/v1/admin/import`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` }, body: gz }));
  assert.equal(imp.manuals, 2);
  assert.equal(imp.uploads, count("upload"));
  // The same install key, the same feed with the same numbers: nobody has to start over.
  const feed1 = await ok(await call("/v1/repository/changes", { key: key2 }));
  const feed2 = await ok(await call("/v1/repository/changes", { key: key2, base: hub2.url }));
  assert.deepEqual(feed2.manuals, feed1.manuals);
  assert.equal(feed2.next, feed1.next);
  const dl2 = await ok(await call(`/v1/repository/files/${approved2.manualId}/url`, { key: key2, json: {}, base: hub2.url }));
  assert.deepEqual(Buffer.from(await (await fetch(dl2.url)).arrayBuffer()), pdfA, "the bucket stayed, so the file is still there");
  const list1 = (await ok(await call("/v1/repository/uploads", { key: key1, headers: { "X-Shop-Ref": "main" } }))).uploads;
  const list2 = (await ok(await call("/v1/repository/uploads", { key: key1, headers: { "X-Shop-Ref": "main" }, base: hub2.url }))).uploads;
  assert.deepEqual(list2, list1, "a company's offers survive the move");
  assert.equal((await ok(await call("/v1/admin/repository/blocked", { key: ADMIN, base: hub2.url }))).blocked.length, 2, "blocked hashes too");
  // A file that lies about its key is refused, in words.
  const evil = zlib.gzipSync(Buffer.from(`${JSON.stringify({ t: "meta", format: "stitchhub-export", version: 3 })}\n${JSON.stringify({ t: "manual_file", id: "x", sha256: "a".repeat(64), size_bytes: 1, object_key: "../etc/passwd", status: "published" })}\n`));
  const refused = await fetch(`${hub2.url}/v1/admin/import`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` }, body: evil });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /object key/);
  console.log("export and import: ok");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hub.log.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  await cleanup();
}
if (!process.exitCode) console.log("repository: all ok");
