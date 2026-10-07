// Checks the manual repository's takedown process, hub side (docs/plans/manual-repository-design.md sections 1, 4.2 and 6,
// package repo-takedown), end to end: a hub of its own on a free port against a fresh database (made and dropped here)
// with the R2 mock (test/r2-mock.mjs) and MAIL_DEV_LOG standing in for the mailbox.
// Covers: business days with US federal holidays (the window across Thanksgiving, 26 Nov 2026); /copyright "not yet open"
// while the agent is unset and its details once set; an incomplete notice refused with what is missing; a complete notice
// naming a manual (by reference or file hash) -> gone from the feed (why: copyright) and the free page, the object in
// held/, the hash blocked, a strike and a mail for the uploader (a duplicate's owner told, no strike), the owner mailed;
// the same bytes refused; a notice naming nothing waiting for the owner, the review queue's flag, refused brands; a
// counter-notice (incomplete refused, complainant mailed the whole of it, the window 10 to 14 business days), restore
// refused before the window and done after it (unblocked, strike withdrawn, republished, both sides mailed) with the
// day-10 reminder; a lawsuit keeping a file down; the third strike (uploads off, waiting offers rejected, old strikes not
// counted); the form's per-address limit, honeypot and size; the owner's log (CSV, notes only appended); export and import.
// usage: DATABASE_URL=postgresql://... (a database on a server where the role may create databases) node test/takedown.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { startR2Mock } from "./r2-mock.mjs";

const BASE_DB = process.env.DATABASE_URL;
assert.ok(BASE_DB, "set DATABASE_URL to a database on a server where the role may create databases (the test makes fresh ones beside it)");
const ADMIN = process.env.ADMIN_TOKEN ?? "takedown-test-admin-token";
const JOIN = "join-takedown-test";
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

// ===== databases and hubs =====
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const dbUrl = (name) => { const u = new URL(BASE_DB); u.pathname = `/${name}`; return u.toString(); };
const FRESH = [`stitchhub_td_${RUN}`, `stitchhub_td2_${RUN}`];
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
        HUB_NAME: "Takedown Test Hub",
        R2_ENDPOINT: r2.endpoint,
        R2_BUCKET: r2.bucket,
        R2_ACCESS_KEY_ID: r2.accessKeyId,
        R2_SECRET_ACCESS_KEY: r2.secret,
        REPO_UPLOADS: "",
        REPO_OPERATOR_ACCOUNTS: "",
        COPYRIGHT_AGENT_NAME: "",
        COPYRIGHT_AGENT_ADDRESS: "",
        COPYRIGHT_AGENT_PHONE: "",
        COPYRIGHT_EMAIL: "",
        REPO_NOTICE_EMAIL: "",
        TAKEDOWN_TEST_TODAY: "",
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

// ===== helpers of this test =====
const AGENT = { COPYRIGHT_AGENT_NAME: "Test Agent (placeholder)", COPYRIGHT_AGENT_ADDRESS: "1 Placeholder Way, Nowhere, ST 00000", COPYRIGHT_EMAIL: `copyright-${RUN}@stitchhub.test` };
const OWNER_MAIL = `owner-${RUN}@stitchhub.test`;
let logs = "";
const restart = async (env) => {
  logs += hub.log;
  await stopHub(hub);
  hub = await startHub(FRESH[0], { REPO_UPLOADS: "on", REPO_NOTICE_EMAIL: OWNER_MAIL, ...AGENT, ...env });
  on = hub.url;
};
/** Every message the hubs have printed (MAIL_DEV_LOG): { to, subject, text }. */
const mails = () =>
  (logs + hub.log)
    .split("mail (not sent, MAIL_DEV_LOG): to ")
    .slice(1)
    .map((chunk) => {
      const [to, subjectLine, ...rest] = chunk.split("\n");
      return { to: to.trim(), subject: subjectLine.replace(/^subject: /, ""), text: rest.join("\n") };
    });
const mailsTo = (addr) => mails().filter((m) => m.to === addr);
let n = 0;
const uniquePdf = (label) => makePdf({ pages: [`${label} ${++n} service manual cover page text here`, "Page two about adjusting the needle bar height"] });
/** The whole way in: offer, PUT, sent, then the owner approves. */
async function publish(key, ref, bytes, over = {}) {
  const { done } = await walk(key, ref, bytes, over);
  assert.equal(done.state, "pending", JSON.stringify(done));
  const f = (await db.query(`SELECT id FROM manual_files WHERE sha256 = $1`, [sha(bytes)])).rows[0];
  const a = await ok(await admin(`/repository/files/${f.id}/approve`, {}));
  return { manualId: a.manualId, fileId: f.id, sha: sha(bytes) };
}
const feedItem = async (key, id) => (await ok(await call("/v1/repository/changes?since=0&limit=1000", { key }))).manuals.filter((m) => m.id === id).pop();
const heldKey = (h) => `held/${h}.pdf`;
const filesKey = (h) => `files/${h}.pdf`;
const notice = (over = {}) => ({
  name: "Rita Rightsholder",
  organization: "Example Sewing Co",
  address: "9 Maker Street, Anytown, ST 11111",
  phone: "+1 555 0100",
  email: `rita-${RUN}@maker.test`,
  work: "The Example NV1 service manual (2012)",
  locations: "the manual on your Manuals page",
  goodFaith: true,
  accuracy: true,
  signature: "Rita Rightsholder",
  ...over,
});
const sendNotice = (over) => call("/copyright/notice", { json: notice(over) });
const counterBody = (noticeId, over = {}) => ({ noticeId, name: "Tess Tech", address: "5 Bobbin Lane, Stitchville, ST 22222", phone: "+1 555 0199", signature: "Tess Tech", goodFaith: true, jurisdiction: true, service: true, ...over });
const acct = (ref, p, json) => call(`/account/api${p}`, { cookie: cookies.get(ref), json });
const dbNotice = async (id) => (await db.query(`SELECT * FROM takedown_notices WHERE id = $1`, [id])).rows[0];

try {
  // ===== business days and federal holidays =====
  const { addBusinessDays, businessDaysBetween, isFederalHoliday, isBusinessDay, readNotice, missingOfNotice } = await import("../src/takedown.mjs");
  assert.ok(isFederalHoliday("2026-11-26"), "Thanksgiving 2026 is the 26th");
  assert.ok(isFederalHoliday("2026-07-03"), "July 4 2026 is a Saturday: observed on the Friday");
  assert.ok(isFederalHoliday("2026-10-12") && isFederalHoliday("2026-12-25") && isFederalHoliday("2026-09-07") && isFederalHoliday("2027-01-18"));
  assert.ok(isFederalHoliday("2027-12-31"), "Jan 1 2028 is a Saturday: observed on Dec 31 2027");
  assert.ok(!isBusinessDay("2026-11-28") && !isBusinessDay("2026-11-29") && !isBusinessDay("2026-11-26") && isBusinessDay("2026-11-27"), "Black Friday is a business day");
  // Received Monday 16 Nov 2026: day 10 and day 14 with Thanksgiving skipped (without it: 30 Nov and 4 Dec).
  assert.equal(addBusinessDays("2026-11-16", 10), "2026-12-01");
  assert.equal(addBusinessDays("2026-11-16", 14), "2026-12-07");
  assert.equal(addBusinessDays("2026-11-13", 10), "2026-11-30", "from a Friday, across the weekend and the holiday");
  assert.equal(addBusinessDays("2026-11-14", 1), "2026-11-16", "from a Saturday, day 1 is Monday");
  assert.equal(addBusinessDays("2026-12-18", 10), "2027-01-05", "across Christmas, New Year's Day and the weekends");
  assert.equal(businessDaysBetween("2026-11-24", "2026-11-30"), 3);
  assert.equal(businessDaysBetween("2026-11-24", "2026-11-24"), 0);
  assert.deepEqual(missingOfNotice(readNotice(notice())), []);
  assert.equal(missingOfNotice(readNotice({})).length, 9, "every element is asked for");
  console.log("business days: ok");

  const key1 = await register("Takedown Test Install 1");
  const key2 = await register("Takedown Test Install 2");

  // ===== not yet open: the agent's details unset =====
  hub.log = "";
  await stopHub(hub);
  hub = await startHub(FRESH[0], { REPO_UPLOADS: "on", REPO_NOTICE_EMAIL: OWNER_MAIL });
  on = hub.url;
  let html = await (await call("/copyright")).text();
  assert.match(html, /Not yet open/);
  assert.doesNotMatch(html, /<form id="f"/, "no form while the agent is unset");
  const closed = await status(await sendNotice(), 503, "form while unset");
  assert.match(closed.error, /isn't open yet/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM takedown_notices`)).rows[0].n, 0);
  console.log("not yet open while unset: ok");

  // ===== the page, with the agent named =====
  await restart({ TAKEDOWN_TEST_TODAY: "2026-11-16" });
  html = await (await call("/copyright")).text();
  assert.doesNotMatch(html, /Not yet open/);
  assert.ok(html.includes(AGENT.COPYRIGHT_AGENT_NAME) && html.includes(AGENT.COPYRIGHT_AGENT_ADDRESS) && html.includes(AGENT.COPYRIGHT_EMAIL), "the designated agent is on the page");
  assert.match(html, /<form id="f"/);
  assert.match(html, /Three strikes within 12 months/);
  assert.match(html, /is one strike for that account \(however many of its files the notice names\)/, "the policy says strikes are per notice");
  assert.match(await (await call("/")).text(), /href="\/copyright"/, "linked from the home page");

  // ===== the people =====
  const up = await company(key1, "up");
  const dupCo = await company(key1, "dup");
  const other = await company(key2, "other");
  const bco = await company(key2, "bco");
  const cco = await company(key2, "cco");
  const pdfA = uniquePdf("Brother NV1");
  const A = await publish(key1, "up", pdfA);
  assert.ok((await feedItem(key2, A.manualId)).brand, "published, in the feed");
  // Another account offers the same bytes: told it is a duplicate, no new file.
  const dup = await ok(await offer(key1, "dup", pdfA));
  assert.equal(dup.duplicate, true);
  let page = await ok(await acct("other", "/manuals?q=brother"));
  assert.equal(page.total, 1);
  assert.equal(r2.objects.has(filesKey(A.sha)), true);

  // ===== an incomplete notice is refused, saying what is missing =====
  let r = await status(await sendNotice({ signature: "", goodFaith: false, phone: "" }), 400, "incomplete notice");
  assert.ok(r.missing.some((m) => /signature/.test(m)) && r.missing.some((m) => /good faith/.test(m)) && r.missing.some((m) => /telephone/.test(m)), JSON.stringify(r.missing));
  assert.match(r.error, /isn't complete/);
  assert.equal(r.missing.length, 3);
  r = await status(await sendNotice({ work: "", locations: "", accuracy: false, email: "nobody" }), 400, "more missing");
  assert.equal(r.missing.length, 4);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM takedown_notices`)).rows[0].n, 0, "nothing was stored");
  assert.equal((await feedItem(key2, A.manualId)).removed, undefined, "and nothing was removed");

  // ===== a complete notice that names the manual: removed at once =====
  const seqBefore = (await feedItem(key2, A.manualId)).seq;
  const got = await ok(await sendNotice({ locations: `Manual reference ${A.manualId} on the Manuals page` }));
  assert.match(got.message, /has been removed/);
  const NA = got.id;
  const item = await feedItem(key2, A.manualId);
  assert.deepEqual([item.removed, item.why], [true, "copyright"], "the feed tells every install it is gone, and why");
  assert.ok(BigInt(item.seq) > BigInt(seqBefore));
  assert.equal((await ok(await acct("other", "/manuals?q=brother"))).total, 0, "gone from the free page");
  await status(await call(`/v1/repository/files/${A.manualId}/url`, { key: key2, json: {} }), 404, "no download URL");
  await status(await acct("other", `/manuals/${A.manualId}/url`, {}), 404, "no web download URL");
  assert.equal(r2.objects.has(filesKey(A.sha)), false, "the object left files/");
  assert.deepEqual(Buffer.from(r2.objects.get(heldKey(A.sha)).bytes), pdfA, "and sits in held/");
  const blocked = (await ok(await admin("/repository/blocked"))).blocked.find((b) => b.sha256 === A.sha);
  assert.ok(blocked && !blocked.lifted_at && blocked.notice_id === NA, "the hash is blocked, by this notice");
  const strikeA = (await db.query(`SELECT * FROM strikes WHERE notice_id = $1`, [NA])).rows;
  assert.equal(strikeA.length, 1);
  assert.equal(strikeA[0].account_id, up.id, "a strike for the account whose upload was published");
  assert.equal(strikeA[0].withdrawn_at, null);
  const struck = mailsTo(up.email).find((m) => /removed after a copyright notice/.test(m.subject));
  assert.ok(struck, "the uploader was mailed");
  assert.match(struck.text, /strike 1/);
  assert.match(struck.text, /Example Sewing Co/, "the complainant's name or organisation");
  assert.doesNotMatch(struck.text, /Maker Street|555 0100|rita-/, "never its contact details");
  assert.match(struck.text, /\/account\/repository/, "and how to counter-notify");
  const told = mailsTo(dupCo.email).find((m) => /copyright notice/.test(m.subject));
  assert.ok(told && /does not count against your account/.test(told.text), "who offered the same bytes is told, with no strike");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM strikes WHERE account_id = $1`, [dupCo.id])).rows[0].n, 0);
  const ownerMail = mailsTo(OWNER_MAIL).find((m) => m.subject.includes(NA));
  assert.ok(ownerMail && /removed automatically/.test(ownerMail.subject), "the owner is told of each notice");
  assert.equal((await db.query(`SELECT state FROM uploads WHERE account_id = $1 AND file_id = $2 ORDER BY created_at LIMIT 1`, [up.id, A.fileId])).rows[0].state, "removed", "the offer shows as removed");
  // The same bytes can't come back.
  const again = await ok(await offer(key1, "up", pdfA));
  assert.equal(again.blocked, true);
  assert.equal(incoming().length, 0);
  console.log("a complete notice: removed, held, blocked, struck, mailed: ok");

  // ===== a notice naming nothing the hub knows waits for the owner =====
  const pdfB = uniquePdf("Pfaff 1222");
  const B = await publish(key2, "bco", pdfB, { brand: "Pfaff", models: ["1222"] });
  const waitingN = await ok(await sendNotice({ work: "The Pfaff 1222 service manual", locations: "the Pfaff 1222 service manual in the library" }));
  assert.match(waitingN.message, /act on it within one business day/);
  let list = await ok(await admin("/repository/notices?status=new"));
  const NB = list.notices.find((x) => x.id === waitingN.id);
  assert.ok(NB && NB.status === "new" && Number.isInteger(NB.ageBusinessDays) && NB.via === "form" && NB.complainant.email.includes("rita-"));
  assert.equal((await feedItem(key2, B.manualId)).removed, undefined, "still published");
  assert.ok(mailsTo(OWNER_MAIL).some((m) => m.subject.includes(waitingN.id) && /waiting for you/.test(m.subject)));
  // Admin: the review queue flags a later offer of a work a notice named.
  const pdfB2 = uniquePdf("Pfaff 1222 second scan");
  const { done: d2 } = await walk(key2, "other", pdfB2, { brand: "Pfaff", models: ["1222"] });
  assert.equal(d2.state, "pending");
  const q1 = (await ok(await admin("/repository"))).waiting.find((w) => w.offered.brand === "Pfaff");
  assert.ok(q1.earlierNotices.length === 0, "a notice not yet actioned doesn't flag");
  // No manual named: Action needs one.
  await status(await admin(`/repository/notices/${NB.id}/action`, {}), 400, "action with nothing named");
  const act = await ok(await admin(`/repository/notices/${NB.id}/action`, { manualIds: [B.manualId], refuseBrand: true }));
  assert.deepEqual(act.manuals, [B.manualId]);
  assert.equal((await feedItem(key2, B.manualId)).removed, true);
  assert.ok(r2.objects.has(heldKey(B.sha)));
  await status(await admin(`/repository/notices/${NB.id}/action`, { manualIds: [B.manualId] }), 409, "can't action twice");
  const q2 = (await ok(await admin("/repository"))).waiting.find((w) => w.offered.brand === "Pfaff");
  assert.equal(q2.earlierNotices.length, 1, "now the review queue names the earlier notice");
  // Refused brands: a maker who sent a takedown.
  assert.deepEqual((await ok(await admin("/repository/refused-brands"))).brands, ["Pfaff"]);
  const refusedOffer = await status(await offer(key2, "bco", uniquePdf("x"), { brand: "pfaff", models: ["1000"] }), 403, "refused brand");
  assert.match(refusedOffer.error, /doesn't take pfaff/i);
  await ok(await admin("/repository/refused-brands", { brand: "Pfaff", refuse: false }));
  assert.deepEqual((await ok(await admin("/repository/refused-brands"))).brands, []);
  await ok(await admin("/repository/refused-brands", { brand: "Janome", refuse: true }));
  assert.deepEqual((await ok(await admin("/repository/refused-brands"))).brands, ["Janome"]);
  await status(await offer(key2, "bco", uniquePdf("j"), { brand: "JANOME", models: ["MC9400"] }), 403, "refused brand, any case");
  await ok(await admin("/repository/refused-brands", { brand: "Janome", refuse: false }));
  console.log("a notice waiting for the owner, the review queue's flag, refused brands: ok");

  // ===== a notice naming a file by its hash; the honeypot =====
  await restart({ TAKEDOWN_TEST_TODAY: "2026-11-16" }); // the form's count of five an hour is in memory: start it again
  const pdfC = uniquePdf("Juki TL");
  const C = await publish(key2, "cco", pdfC, { brand: "Juki", models: ["TL2010Q"] });
  const byHash = await ok(await sendNotice({ locations: `file sha256 ${C.sha}` }));
  assert.match(byHash.message, /has been removed/);
  assert.equal((await feedItem(key2, C.manualId)).removed, true);
  const before = (await db.query(`SELECT count(*)::int AS n FROM takedown_notices`)).rows[0].n;
  const bot = await ok(await call("/copyright/notice", { json: { ...notice(), website: "http://spam.test" } }));
  assert.ok(bot.ok);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM takedown_notices`)).rows[0].n, before, "the honeypot stores nothing");
  const big = await call("/copyright/notice", { json: { ...notice(), work: "x".repeat(17 * 1024) } });
  assert.equal(big.status, 413, "16 KB at most");
  console.log("by hash, honeypot, size: ok");

  // ===== a counter-notice =====
  assert.equal((await ok(await acct("up", "/repository"))).strikes, 1, "A");
  const view = await ok(await acct("up", "/repository"));
  const removalA = view.removals.find((x) => x.noticeId === NA);
  assert.ok(removalA.canCounter && removalA.from === "Example Sewing Co" && /Brother/.test(removalA.what));
  assert.deepEqual((await ok(await acct("other", "/repository"))).removals, [], "another account sees none of it");
  await status(await acct("other", "/repository/counter-notice", counterBody(NA)), 404, "someone else's removal");
  let cr = await status(await acct("up", "/repository/counter-notice", counterBody(NA, { signature: "", jurisdiction: false, phone: "" })), 400, "incomplete counter-notice");
  assert.equal(cr.missing.length, 3);
  assert.ok(cr.missing.some((m) => /jurisdiction/.test(m)));
  assert.equal((await dbNotice(NA)).status, "actioned");
  const counter = await ok(await acct("up", "/repository/counter-notice", counterBody(NA)));
  assert.deepEqual([counter.restoreEarliest, counter.restoreLatest], ["2026-12-01", "2026-12-07"], "received Monday 16 Nov 2026: business days 10 and 14, Thanksgiving skipped");
  const toRita = mailsTo(`rita-${RUN}@maker.test`).find((m) => /counter-notice/.test(m.subject));
  assert.ok(toRita, "the complainant was mailed");
  assert.match(toRita.text, /Tess Tech/);
  assert.match(toRita.text, /5 Bobbin Lane/, "the whole counter-notice: address");
  assert.match(toRita.text, /555 0199/, "and telephone");
  assert.match(toRita.text, /2026-12-01/);
  assert.match(toRita.text, /2026-12-07/);
  assert.match(toRita.text, /penalty of perjury/);
  assert.ok(mailsTo(up.email).some((m) => /counter-notice was sent/.test(m.subject)));
  await status(await acct("up", "/repository/counter-notice", counterBody(NA)), 409, "a second counter-notice");
  const nA = await dbNotice(NA);
  assert.equal(nA.status, "countered");
  const rowC = (await db.query(`SELECT * FROM takedown_notices WHERE parent_id = $1 AND kind = 'counter'`, [NA])).rows;
  assert.equal(rowC.length, 1);
  assert.equal(rowC[0].account_id, up.id);
  assert.ok((await ok(await acct("up", "/repository"))).removals.find((x) => x.noticeId === NA).restoreLatest === "2026-12-07");
  // Not before the window opens (today is 16 Nov: Thanksgiving made day 10 the 1st of December).
  const tooEarly = await status(await admin(`/repository/notices/${NA}/restore`, {}), 409, "restore before the window");
  assert.match(tooEarly.error, /2026-12-01/);
  assert.equal((await feedItem(key2, A.manualId)).removed, true);
  // A complainant who sues: the file stays down.
  const lawsuitNotice = await ok(await admin("/repository/notices", { via: "post", raw: "Letter received by post.", ...notice({ locations: `reference ${C.manualId}` }) }));
  assert.equal(lawsuitNotice.status, "new");
  await ok(await admin(`/repository/notices/${lawsuitNotice.id}/note`, { text: "Called to confirm." }));
  console.log("counter-notice: ok");

  // ===== day 9 is too early; day 10 reminds and restores =====
  await restart({ TAKEDOWN_TEST_TODAY: "2026-11-30" });
  assert.match((await status(await admin(`/repository/notices/${NA}/restore`, {}), 409, "day 9")).error, /2026-12-01/, "28 and 29 Nov are the weekend, 26 Nov a holiday: 30 Nov is only day 9");
  assert.equal((await ok(await admin("/repository/notices/reminders", {}))).reminded, 0);
  await restart({ TAKEDOWN_TEST_TODAY: "2026-12-01" });
  list = await ok(await admin("/repository/notices"));
  assert.equal(list.restoreDue, 1);
  const nowA = list.notices.find((x) => x.id === NA);
  assert.ok(nowA.restoreDue && nowA.counter.complainant.name === "Tess Tech" && nowA.status === "countered");
  assert.equal((await ok(await admin("/repository/notices/reminders", {}))).reminded, 1);
  assert.equal((await ok(await admin("/repository/notices/reminders", {}))).reminded, 0, "once");
  assert.ok(mailsTo(OWNER_MAIL).some((m) => /Restore due/.test(m.subject) && m.text.includes("2026-12-07")), "the owner is reminded on day 10");
  const restored = await ok(await admin(`/repository/notices/${NA}/restore`, {}));
  assert.deepEqual(restored.restored, [A.manualId]);
  const back = await feedItem(key2, A.manualId);
  assert.ok(back.brand && !back.removed, "republished in the feed");
  assert.ok(BigInt(back.seq) > BigInt(item.seq), "with a new change number, so every install sees it");
  assert.equal((await ok(await acct("other", "/manuals?q=brother"))).total, 1, "and on the free page");
  assert.equal(r2.objects.has(heldKey(A.sha)), false);
  assert.equal(r2.objects.has(filesKey(A.sha)), true, "the object is back in files/");
  assert.ok((await ok(await call(`/v1/repository/files/${A.manualId}/url`, { key: key2, json: {} }))).url);
  assert.ok((await ok(await admin("/repository/blocked"))).blocked.find((b) => b.sha256 === A.sha).lifted_at, "unblocked");
  assert.ok((await db.query(`SELECT withdrawn_at FROM strikes WHERE notice_id = $1`, [NA])).rows[0].withdrawn_at, "the strike is withdrawn");
  assert.equal((await ok(await acct("up", "/repository"))).strikes, 0, "withdrawn");
  assert.equal((await dbNotice(NA)).status, "restored");
  assert.ok(mailsTo(up.email).some((m) => /was restored/.test(m.subject)));
  assert.ok(mailsTo(`rita-${RUN}@maker.test`).some((m) => /was restored/.test(m.subject)));
  await status(await admin(`/repository/notices/${NA}/restore`, {}), 409, "restored already");
  assert.equal((await dbNotice(NA)).notes.length >= 4, true, "the timeline grew");
  console.log("restore: ok");

  // ===== the lawsuit keeps it down =====
  // That notice names C by reference, which is removed already: nothing to remove.
  assert.match((await status(await admin(`/repository/notices/${lawsuitNotice.id}/action`, {}), 409, "nothing to remove")).error, /Nothing to remove/);
  assert.equal((await dbNotice(lawsuitNotice.id)).status, "new");
  const pdfD = uniquePdf("Bernina 330");
  const D = await publish(key1, "up", pdfD, { brand: "Bernina", models: ["330"] });
  const nD = await ok(await admin("/repository/notices", { via: "email", raw: "emailed", ...notice({ locations: `reference ${D.manualId}` }) }));
  await ok(await admin(`/repository/notices/${nD.id}/action`, {}));
  const cD = await ok(await acct("up", "/repository/counter-notice", counterBody(nD.id)));
  assert.deepEqual([cD.restoreEarliest, cD.restoreLatest], ["2026-12-15", "2026-12-21"]);
  await ok(await admin(`/repository/notices/${nD.id}/lawsuit`, { note: "Case 1:26-cv-0001" }));
  assert.match((await status(await admin(`/repository/notices/${nD.id}/restore`, {}), 409, "restore after a lawsuit")).error, /lawsuit/);
  assert.equal((await feedItem(key2, D.manualId)).removed, true);
  console.log("a lawsuit keeps the file down: ok");

  // ===== an incomplete notice logged by the owner =====
  const inc = await ok(await admin("/repository/notices", { via: "email", raw: "An emailed notice with no signature", ...notice({ signature: "", goodFaith: false, locations: `reference ${C.manualId}` }) }));
  assert.equal(inc.status, "incomplete");
  assert.equal(inc.missing.length, 2);
  assert.match((await status(await admin(`/repository/notices/${inc.id}/action`, {}), 409, "incomplete")).error, /incomplete/);
  await ok(await admin(`/repository/notices/${inc.id}/reject`, { reason: "Names nothing here: already removed." }));
  await status(await admin(`/repository/notices/${inc.id}/reject`, { reason: "again" }), 409, "reject twice");
  await status(await admin(`/repository/notices/${lawsuitNotice.id}/reject`, {}), 400, "reject needs a reason");

  // ===== the third strike =====
  const three = await company(key2, "three");
  const made = [];
  for (const [i, brand] of ["Singer", "Elna", "Viking"].entries()) made.push(await publish(key2, "three", uniquePdf(brand), { brand, models: [`M${i}00`] }));
  const waitingPdf = uniquePdf("Husqvarna waiting");
  assert.equal((await walk(key2, "three", waitingPdf, { brand: "Husqvarna", models: ["H100"] })).done.state, "pending");
  for (const [i, m] of made.entries()) {
    const logged = await ok(await admin("/repository/notices", { via: "email", raw: `notice ${i}`, ...notice({ locations: `reference ${m.manualId}` }) }));
    await ok(await admin(`/repository/notices/${logged.id}/action`, {}));
    const view3 = await ok(await acct("three", "/repository"));
    assert.equal(view3.strikes, i + 1);
    assert.equal(view3.uploadsOff, i === 2, `uploads are off only at the third strike (after ${i + 1})`);
  }
  assert.match((await status(await offer(key2, "three", uniquePdf("more")), 403, "uploads off")).error, /ended for this account/);
  assert.equal((await db.query(`SELECT state FROM uploads WHERE account_id = $1 AND state = 'rejected'`, [three.id])).rows.length, 1, "its waiting offer was rejected");
  assert.ok(mailsTo(three.email).some((m) => /Three strikes within 12 months end uploading: you can no longer/.test(m.text)));
  const strikes = (await ok(await admin("/repository/strikes"))).strikes;
  assert.equal(strikes.filter((s) => s.accountId === three.id && !s.withdrawnAt).length, 3);
  assert.ok(strikes.find((s) => s.accountId === three.id).uploadsOff);
  // A strike older than 12 months doesn't count.
  const old = strikes.find((s) => s.accountId === up.id && !s.withdrawnAt);
  await db.query(`UPDATE strikes SET created_at = now() - interval '13 months' WHERE id = $1`, [old.id]);
  assert.equal((await ok(await acct("up", "/repository"))).strikes, 0);
  console.log("third strike: uploads off, waiting offers rejected, old strikes don't count: ok");

  // ===== one strike per notice per uploader; a form notice naming more than 5 manuals waits for the owner =====
  await restart({ TAKEDOWN_TEST_TODAY: "2026-12-01" }); // the form's count of five an hour starts again
  const multi = await company(key1, "multi");
  const many = [];
  for (const [i, brand] of ["Janome", "Juki", "Babylock", "Bernina", "Necchi", "Kenmore", "Pfaff", "Riccar"].entries()) many.push(await publish(key1, "multi", uniquePdf(brand), { brand, models: [`X${i}00`] }));
  const two = await ok(await admin("/repository/notices", { via: "email", raw: "two at once", ...notice({ locations: `references ${many[0].manualId} and ${many[1].manualId}` }) }));
  assert.equal((await ok(await admin(`/repository/notices/${two.id}/action`, {}))).manuals.length, 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM strikes WHERE notice_id = $1`, [two.id])).rows[0].n, 1, "one strike for the notice, not one per manual");
  const multiView = await ok(await acct("multi", "/repository"));
  assert.equal(multiView.strikes, 1);
  assert.deepEqual(multiView.removals.map((x) => [x.noticeId, x.manuals]), [[two.id, 2]], "one row for the notice's strike");
  assert.equal(multiView.removals[0].what.split("; ").length, 2, "naming every manual of the account it removed");
  const struckTwo = mailsTo(multi.email).filter((m) => /strike 1/.test(m.text));
  assert.equal(struckTwo.length, 1, "one mail for the notice");
  assert.match(struckTwo[0].text, /Janome .*; Juki .* were removed/);
  const six = await ok(await sendNotice({ locations: many.slice(2).map((m) => `reference ${m.manualId}`).join("\n") }));
  assert.match(six.message, /will act on it within one business day/, "not removed by the form");
  for (const m of many.slice(2)) assert.equal((await feedItem(key2, m.manualId)).removed, undefined, "each of the six is still there");
  assert.equal((await dbNotice(six.id)).status, "new");
  assert.ok((await dbNotice(six.id)).notes.some((n) => /names 6 manuals or files, more than the 5/.test(n.text)), "the log says why it waits");
  assert.equal((await ok(await admin(`/repository/notices/${six.id}/action`, {}))).manuals.length, 6, "the owner's Action removes them");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM strikes WHERE notice_id = $1`, [six.id])).rows[0].n, 1);
  assert.equal((await ok(await acct("multi", "/repository"))).strikes, 2, "two notices, two strikes");
  console.log("one strike per notice; a form notice naming many waits for the owner: ok");

  // ===== the per-address limit (a fresh hub: the count is in memory) =====
  await restart({ TAKEDOWN_TEST_TODAY: "2026-12-01" });
  for (let i = 0; i < 5; i++) await status(await sendNotice({ signature: "" }), 400, `notice ${i + 1} from the address`);
  const limited = await status(await sendNotice({ signature: "" }), 429, "the sixth in the hour");
  assert.match(limited.error, /Too many/);
  await status(await sendNotice(), 429, "a complete one is limited too");
  console.log("the form's per-address limit: ok");

  // ===== the admin log: CSV, notes only appended =====
  const csv = await (await call("/v1/admin/repository/notices.csv", { key: ADMIN })).text();
  const rows = csv.trim().split("\r\n");
  assert.match(rows[0], /^id,kind,parent_id,via,status/);
  assert.ok(rows.length >= 12 && csv.includes(NA) && csv.includes("Example Sewing Co"), "every notice and counter-notice");
  assert.ok(csv.includes(",counter,"), "counter-notices too");
  const notesNow = (await dbNotice(NA)).notes;
  await ok(await admin(`/repository/notices/${NA}/note`, { text: "For the lawyer." }));
  const notesAfter = (await dbNotice(NA)).notes;
  assert.equal(notesAfter.length, notesNow.length + 1);
  assert.deepEqual(notesAfter.slice(0, notesNow.length), notesNow, "earlier entries are never changed");
  await ok(await admin(`/repository/notices/${NA}/close`, {}));
  assert.equal((await dbNotice(NA)).status, "closed");
  const withBlocked = (await ok(await admin("/repository/blocked"))).blocked;
  assert.ok(withBlocked.filter((b) => b.notice_id && !b.lifted_at).length >= 4);
  // Notices can't be reached without the admin token.
  await status(await call("/v1/admin/repository/notices"), 401, "no token");
  await status(await call("/account/api/repository"), 401, "not signed in");
  console.log("the owner's log: ok");

  // ===== the export carries notices and strikes =====
  const gz = Buffer.from(await (await admin("/export")).arrayBuffer());
  const lines = zlib.gunzipSync(gz).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const count = (t) => lines.filter((l) => l.t === t).length;
  assert.ok(count("takedown_notice") >= 11 && count("strike") >= 7, JSON.stringify({ n: count("takedown_notice"), s: count("strike") }));
  hub2 = await startHub(FRESH[1], { REPO_UPLOADS: "on" });
  const imp = await ok(await fetch(`${hub2.url}/v1/admin/import`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` }, body: gz }));
  assert.equal(imp.takedown_notices, count("takedown_notice"));
  assert.equal(imp.strikes, count("strike"));
  const moved = await ok(await call("/v1/admin/repository/notices", { key: ADMIN, base: hub2.url }));
  assert.equal(moved.notices.length, (await ok(await admin("/repository/notices"))).notices.length);
  const nAmoved = moved.notices.find((x) => x.id === NA);
  assert.deepEqual(nAmoved.notes.map((x) => x.text), (await dbNotice(NA)).notes.map((x) => x.text), "the timeline survives the move");
  assert.equal(nAmoved.restoreEarliest, "2026-12-01");
  console.log("export and import: ok");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hub.log.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  await cleanup();
}
if (!process.exitCode) console.log("takedown: all ok");
