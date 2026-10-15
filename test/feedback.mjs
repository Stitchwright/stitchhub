// Checks help, ideas, ratings and error alerts (src/feedback.mjs, migration 034): each kind, a picture (the JPEG check and
// the 1 MB limit), caps on the text, errors upserting on (install, company, fingerprint, day) and adding the count, the
// rate limits (60 items an hour per company, 200 errors a day per install), a pending and a partner-only install being
// let in, the company's name as the hub knows it, the admin list, filters, status, note and picture, the picture sweep
// 90 days after done, one install's items never answering to another's key, the owner's email (MAIL_DEV_LOG), the
// errors digest, the cap on emails to the owner (FEEDBACK_EMAIL_PER_HOUR) and a pending install's items (words only, never
// mailed one by one). Starts a hub of its own on a scratch database it creates and drops (127.0.0.1:5433,
// stitchbench/stitchbench; or DATABASE_URL to use one you made).
// usage: node test/feedback.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const ADMIN = "feedback-test-admin-token-0123456789";
const JOIN = "join-feedback-test";
const ROOT = path.resolve(import.meta.dirname, "..");

const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_feedback_${Date.now().toString(36)}`;
const DB = process.env.DATABASE_URL || `${BASE}/${dbName}`;
const admin0 = new pg.Client({ connectionString: `${BASE}/postgres` });
if (!process.env.DATABASE_URL) {
  await admin0.connect();
  await admin0.query(`CREATE DATABASE ${dbName}`);
}
const db = new pg.Pool({ connectionString: DB, max: 2 });

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
let hub = null;
let hubLog = "";
async function startHub(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Feedback Test Hub", HUB_URL: "https://hub.example.test", HUB_LICENSE_KID: "", HUB_LICENSE_KEY: "", MAIL_DEV_LOG: "true", SMTP_URL: "", FEEDBACK_EMAIL: "owner@example.test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub = { proc, url: `http://127.0.0.1:${port}` };
  proc.stdout.on("data", (d) => (hubLog += d));
  proc.stderr.on("data", (d) => (hubLog += d));
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${hub.url}/health`).then((r) => r.ok, () => false)) return;
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stop = async () => {
  if (hub && hub.proc.exitCode === null) await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  await db.end().catch(() => {});
  if (!process.env.DATABASE_URL) {
    await admin0.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin0.end().catch(() => {});
  }
};
process.on("exit", () => hub?.proc.kill());

const call = (p, { key, json, form, shop, method, headers = {} } = {}) =>
  fetch(hub.url + p, {
    method: method ?? (json !== undefined || form !== undefined ? "POST" : "GET"),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(shop ? { "X-Shop-Ref": shop } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : form,
  });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const refused = async (r, status, re, what) => {
  const body = await r.text();
  assert.equal(r.status, status, `${what}: ${r.status} ${body}`);
  if (re) assert.match(JSON.parse(body).error ?? body, re, what);
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const adminCall = (p, o = {}) => call(`/v1/admin${p}`, { ...o, key: ADMIN });
const list = async (qs = "") => ok(await adminCall(`/feedback?${qs}`));

const ctx = (extra = {}) => ({ program: "StitchBench", version: "1.8.0", path: "/jobs", role: "OWNER", desktop: true, userAgent: "Mozilla/5.0 test", screen: "1366x768", ...extra });
const sendJson = (key, shop, item) => call("/v1/feedback", { key, shop, json: item });
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
function sendForm(key, shop, item, picture, type = "image/jpeg") {
  const f = new FormData();
  f.set("item", JSON.stringify(item));
  if (picture) f.set("picture", new Blob([picture], { type }), "screen.jpg");
  return call("/v1/feedback", { key, shop, form: f });
}
const today = new Date().toISOString().slice(0, 10);
const waitFor = async (fn, what) => {
  for (let i = 0; i < 50; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never happened: ${what}\n${hubLog}`);
};

try {
  await startHub();
  const X = await register("Install X");
  const Y = await register("Install Y");
  await ok(await call("/v1/shops/claim", { key: X, shop: "s1", json: { shopRef: "s1", shopName: "Thimble Quilts", kind: "retail", program: "StitchShop", version: "1.8.0", sole: false } }));

  // ----- the three kinds, JSON and multipart -----
  const help = await ok(await sendJson(X, "s1", { kind: "help", text: "The invoice page <b>won't</b> open", replyTo: "denise@example.test", context: ctx({ shopName: "Not My Name" }) }));
  assert.equal(help.ok, true);
  assert.ok(help.id);
  const pic = jpeg();
  const idea = await ok(await sendForm(X, "s1", { kind: "idea", text: "Print the labels bigger", replyTo: "not an address", context: ctx() }, pic));
  const rating = await ok(await sendJson(X, "s1", { kind: "rating", stars: 4, quoteOk: true, context: ctx() }));
  let all = await list();
  assert.equal(all.items.length, 3);
  const byId = Object.fromEntries(all.items.map((i) => [i.id, i]));
  assert.equal(byId[help.id].shopName, "Thimble Quilts", "the name the hub knows, not the one in the context");
  assert.equal(byId[help.id].text, "The invoice page <b>won't</b> open", "kept as typed (the admin page shows it as text)");
  assert.equal(byId[help.id].replyTo, "denise@example.test");
  assert.equal(byId[help.id].context.version, "1.8.0");
  assert.equal(byId[help.id].hasPicture, false);
  assert.equal(byId[idea.id].replyTo, undefined, "a reply address that isn't one is dropped");
  assert.equal(byId[idea.id].hasPicture, true);
  assert.equal(byId[rating.id].stars, 4);
  assert.equal(byId[rating.id].quoteOk, true);
  const got = await adminCall(`/feedback/${idea.id}/picture`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), pic, "the picture comes back as sent");
  await refused(await adminCall(`/feedback/${help.id}/picture`), 404, /No picture/, "no picture on that one");
  console.log("kinds: ok");

  // ----- refusals and caps -----
  await refused(await sendJson(X, undefined, { kind: "help", text: "x", context: ctx() }), 400, /X-Shop-Ref/, "no company");
  await refused(await call("/v1/feedback", { shop: "s1", json: { kind: "help", text: "x" } }), 401, null, "no key");
  await refused(await sendJson(X, "s1", { kind: "praise", text: "x" }), 400, /kind/, "unknown kind");
  await refused(await sendJson(X, "s1", { kind: "help", text: "   " }), 400, /text/, "help needs words");
  await refused(await sendJson(X, "s1", { kind: "rating", stars: 0 }), 400, /stars/, "0 stars");
  await refused(await sendJson(X, "s1", { kind: "rating", stars: 5.5 }), 400, /stars/, "half stars");
  await refused(await sendJson(X, "s1", { kind: "error", error: {} }), 400, /message/, "an error needs a message");
  await refused(await call("/v1/feedback", { key: X, shop: "s1", form: "{}", headers: { "Content-Type": "application/json" } }), 400, null, "a body that isn't an item");
  await refused(await sendForm(X, "s1", { kind: "help", text: "x" }, Buffer.alloc(1024 * 1024 + 1, 1)), 413, /1 MB/, "a picture over 1 MB");
  await refused(await sendForm(X, "s1", { kind: "help", text: "x" }, Buffer.from("\x89PNG not a jpeg"), "image/jpeg"), 415, /JPEG/, "magic bytes wrong");
  await refused(await sendForm(X, "s1", { kind: "help", text: "x" }, jpeg(), "image/png"), 415, /JPEG/, "type wrong");
  const exact = await sendForm(X, "s1", { kind: "help", text: "a picture of exactly 1 MB", context: ctx() }, Buffer.concat([jpeg(0), Buffer.alloc(1024 * 1024 - 4, 1)]));
  assert.equal(exact.status, 200, "1 MB exactly is fine");
  const long = await ok(await sendJson(X, "s1", { kind: "help", text: "t".repeat(5000), context: ctx({ path: "p".repeat(900), userAgent: "u".repeat(900), extra: "x" }) }));
  const longRow = (await list()).items.find((i) => i.id === long.id);
  assert.equal(longRow.text.length, 4000, "text capped at 4,000");
  assert.equal(longRow.context.path.length, 300);
  assert.equal(longRow.context.userAgent.length, 300);
  assert.equal(longRow.context.extra, undefined, "unknown context fields are dropped");
  console.log("refusals and caps: ok");

  // ----- errors: one row per error per day, the count added -----
  const err = (o = {}) => ({ kind: "error", fingerprint: "fp-1", day: today, count: 1, context: ctx(), error: { message: "Cannot read x", stack: "Error: Cannot read x\n    at a (b.js:1:1)\n" + "s".repeat(9000), digest: "d1", action: "saveJob" }, ...o });
  const e1 = await ok(await sendJson(X, "s1", err({ count: 2 })));
  const e2 = await ok(await sendJson(X, "s1", err({ count: 3 })));
  assert.equal(e2.id, e1.id, "the same error is the same row");
  const e3 = await ok(await sendJson(X, "s1", err({ day: "2020-01-01" })));
  assert.notEqual(e3.id, e1.id, "another day, another row");
  const e4 = await ok(await sendJson(Y, "s1", err()));
  assert.notEqual(e4.id, e1.id, "another install, another row");
  const errs = (await list("kind=error")).items;
  assert.equal(errs.length, 3);
  const row1 = errs.find((e) => e.id === e1.id);
  assert.equal(row1.count, 5, "2 + 3");
  assert.equal(row1.error.stack.length, 8000, "stack capped at 8,000");
  assert.equal(row1.error.action, "saveJob");
  const e5 = await ok(await sendJson(X, "s1", { kind: "error", context: ctx(), error: { message: "No fingerprint", stack: "Error: x\n    at f (g.js:2:2)" } }));
  const e6 = await ok(await sendJson(X, "s1", { kind: "error", context: ctx(), error: { message: "No fingerprint", stack: "Error: x\n    at f (g.js:2:2)" } }));
  assert.equal(e5.id, e6.id, "without a fingerprint the same message and frame count as one error today");
  assert.equal((await list("kind=error")).items.find((e) => e.id === e5.id).count, 2);
  console.log("errors: ok");

  // ----- a pending install and a partner-only install may send; the answer is the same -----
  const P = await register("Install Pending");
  const R = await register("Install Partner");
  await db.query(`UPDATE installs SET scope = 'pending' WHERE name = 'Install Pending'`);
  await db.query(`UPDATE installs SET scope = 'partner' WHERE name = 'Install Partner'`);
  await ok(await sendJson(P, "p1", { kind: "idea", text: "from a pending install", context: ctx({ shopName: "Pending Quilts" }) }));
  await ok(await sendJson(R, "r1", { kind: "idea", text: "from a partner install", context: ctx() }));
  await refused(await call("/v1/links", { key: P }), 403, /Finish setting up/, "pending still can't use the rest");
  const pend = (await list("kind=idea")).items.find((i) => i.text === "from a pending install");
  assert.equal(pend.shopName, "Pending Quilts", "the name from the context when the hub doesn't know the company");
  const part = (await list("kind=idea")).items.find((i) => i.text === "from a partner install");
  assert.equal(part.shopName, "Install Partner", "else the install's name");
  // A pending install sends words, not pictures (anyone can start one): the item is kept, its picture left off. A
  // partner-only install was brought on by a member and may send both.
  const pendPic = await ok(await sendForm(P, "p1", { kind: "help", text: "pending, with a picture", context: ctx() }, jpeg()));
  const partPic = await ok(await sendForm(R, "r1", { kind: "help", text: "partner, with a picture", context: ctx() }, jpeg()));
  const helps = (await list("kind=help")).items;
  assert.equal(helps.find((i) => i.id === pendPic.id).hasPicture, false, "a pending install's picture is left off");
  assert.equal(helps.find((i) => i.id === partPic.id).hasPicture, true);
  console.log("pending and partner installs: ok");

  // ----- the admin list: filters, status, note, another install's key -----
  const shopsList = (await list()).shops;
  assert.ok(shopsList.some((s) => s.name === "Thimble Quilts"));
  const key = shopsList.find((s) => s.name === "Thimble Quilts").key;
  assert.ok((await list(`shop=${encodeURIComponent(key)}`)).items.every((i) => i.shopName === "Thimble Quilts" && i.installId));
  assert.equal((await list("kind=rating")).items.length, 1);
  const before = await list("status=new");
  assert.equal(before.counts.new, (await list()).items.length);
  await refused(await call("/v1/admin/feedback", { key: X }), 401, /admin token/, "an install key isn't the admin token");
  await refused(await call("/v1/admin/feedback"), 401, null, "no token");
  const mine = await ok(await adminCall(`/feedback/${help.id}`, { json: { status: "seen", note: "Called her back" } }));
  assert.equal(mine.status, "seen");
  assert.equal(mine.note, "Called her back");
  assert.ok(!(await list("status=new")).items.some((i) => i.id === help.id), "seen leaves New");
  assert.equal((await list("status=seen")).items[0].id, help.id);
  await refused(await adminCall(`/feedback/${help.id}`, { json: { status: "finished" } }), 400, /status/, "bad status");
  await refused(await adminCall(`/feedback/${help.id}`, { json: {} }), 400, null, "nothing to change");
  await refused(await adminCall(`/feedback/nope`, { json: { status: "done" } }), 404, null, "unknown id");
  await ok(await adminCall(`/feedback/${idea.id}`, { json: { status: "done" } }));
  assert.ok((await db.query(`SELECT done_at FROM feedback WHERE id = $1`, [idea.id])).rows[0].done_at, "done writes done_at");
  console.log("admin: ok");

  // ----- pictures go 90 days after done; the words stay -----
  await adminCall("/feedback-sweep", { json: {} });
  assert.equal((await list()).items.find((i) => i.id === idea.id).hasPicture, true, "not yet");
  await db.query(`UPDATE feedback SET done_at = now() - interval '91 days' WHERE id = $1`, [idea.id]);
  assert.equal((await ok(await adminCall("/feedback-sweep", { json: {} }))).cleared, 1);
  const after = (await list()).items.find((i) => i.id === idea.id);
  assert.equal(after.hasPicture, false);
  assert.equal(after.text, "Print the labels bigger");
  await ok(await adminCall(`/feedback/${idea.id}`, { json: { status: "new" } }));
  assert.equal((await db.query(`SELECT done_at FROM feedback WHERE id = $1`, [idea.id])).rows[0].done_at, null, "reopening clears done_at");
  console.log("picture sweep: ok");

  // ----- the owner's email: each help, idea and rating at once; errors in a digest -----
  await waitFor(() => hubLog.includes("subject: Help: Thimble Quilts – The invoice page <b>won't</b> open"), "the help email");
  await waitFor(() => hubLog.includes("subject: Idea: Thimble Quilts – Print the labels bigger"), "the idea email");
  await waitFor(() => hubLog.includes("subject: Rating: Thimble Quilts – 4 of 5 stars"), "the rating email");
  await waitFor(() => /subject: \d+ new errors? from \d+ shops?/.test(hubLog), "the errors digest");
  assert.ok(hubLog.includes("to owner@example.test"));
  assert.ok(hubLog.includes("https://hub.example.test/admin"), "a link to the admin page");
  assert.equal((hubLog.match(/subject: \d+ new errors? from/g) ?? []).length, 1, "one digest, not one per error");
  assert.ok(!hubLog.includes("from a pending install") && !hubLog.includes("pending, with a picture"), "a pending install's items aren't mailed one by one");
  assert.ok(hubLog.includes("subject: Idea: Install Partner – from a partner install"), "a partner-only install's are");
  console.log("email: ok");

  // ----- limits -----
  const Z = await register("Install Z");
  for (let i = 0; i < 60; i++) await ok(await sendJson(Z, "z1", { kind: "idea", text: `idea ${i}`, context: ctx() }));
  await refused(await sendJson(Z, "z1", { kind: "idea", text: "one too many", context: ctx() }), 429, /Too many/, "the 61st item an hour");
  await ok(await sendJson(Z, "z2", { kind: "idea", text: "another company on the install has its own 60", context: ctx() }));
  const W = await register("Install W");
  for (let i = 0; i < 200; i++) await ok(await sendJson(W, `w${i % 5}`, err({ fingerprint: `fp-${i}` })));
  await refused(await sendJson(W, "w9", err({ fingerprint: "fp-over" })), 429, /Too many errors/, "the 201st error of a day");
  await ok(await sendJson(W, "w9", { kind: "idea", text: "ideas aren't errors", context: ctx() }));
  console.log("limits: ok");

  // ----- answers to Help: the owner writes back; the program fetches them (migration 035) -----
  {
  const RA = await register("Install Reply A");
  const RB = await register("Install Reply B");
  const wordy = "The invoice page will not open. " + "x".repeat(300);
  const rh1 = (await ok(await sendJson(RA, "ra1", { kind: "help", text: wordy, replyTo: "denise@example.test", context: ctx({ program: "StitchShop" }) }))).id;
  const rh2 = (await ok(await sendJson(RA, "ra1", { kind: "idea", text: "Bigger labels", context: ctx() }))).id;
  const rh3 = (await ok(await sendJson(RA, "ra2", { kind: "help", text: "Another company on the same install", replyTo: "other@example.test", context: ctx() }))).id;
  const rh4 = (await ok(await sendJson(RB, "ra1", { kind: "help", text: "Same company ref, other install", context: ctx() }))).id;
  const rErr = (await ok(await sendJson(RA, "ra1", { kind: "error", error: { message: "boom", stack: "Error: boom\n at x" }, context: ctx() }))).id;
  const reply = (id, body) => adminCall(`/feedback/${id}`, { json: body });

  // not for errors; not empty; not too long; not an unknown item
  await refused(await reply(rErr, { reply: "We fixed it" }), 400, /error/i, "answering an error");
  await refused(await reply(rh1, { reply: "   " }), 400, /answer/i, "an empty answer");
  await refused(await reply(rh1, { reply: "y".repeat(4001) }), 400, /4000/, "an answer over 4000");
  await refused(await reply("nope", { reply: "hello" }), 404, null, "an unknown item");
  assert.equal((await list("status=new&kind=help")).items.find((i) => i.id === rh1).reply, null, "nothing saved by the refusals");
  assert.deepEqual(await ok(await call("/v1/feedback/replies", { key: RA, shop: "ra1" })), [], "no answers yet");

  // the answer is saved, marks the item done and is emailed to the reply address
  hubLog = "";
  const done = await ok(await reply(rh1, { reply: "Thanks! Please update to 1.8.1, it is fixed there." }));
  assert.equal(done.reply, "Thanks! Please update to 1.8.1, it is fixed there.");
  assert.equal(done.status, "done");
  assert.ok(done.repliedAt);
  assert.equal(done.emailed, true);
  await waitFor(() => hubLog.includes("to denise@example.test\nsubject: Your note to StitchShop"), "the answer by email");
  assert.ok(hubLog.includes("Please update to 1.8.1"), "the answer is in the email");
  assert.ok(hubLog.includes(`> ${wordy.slice(0, 200)}...`) && !hubLog.includes(wordy.slice(0, 201) + "x"), "the email quotes the first 200 characters");
  const row = (await list("status=done&kind=help")).items.find((i) => i.id === rh1);
  assert.equal(row.reply, done.reply);
  assert.ok(row.repliedAt, "the admin list has repliedAt");
  assert.equal((await list("status=new")).items.find((i) => i.id === rh2)?.reply ?? null, null, "items with no answer have reply null");

  // an item with no reply address still keeps the answer (no email)
  hubLog = "";
  const quiet = await ok(await reply(rh2, { reply: "Good idea, we will do it." }));
  assert.equal(quiet.emailed, false);
  assert.equal(quiet.status, "done");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!hubLog.includes("subject: Your note to"), "no email without a reply address");
  // answering again replaces the answer
  const again = await ok(await reply(rh2, { reply: "Done in 1.9." }));
  assert.equal(again.reply, "Done in 1.9.");
  await ok(await reply(rh3, { reply: "For the second company." }));
  await ok(await reply(rh4, { reply: "For the other install." }));

  // the program's route: its own install and company only, newest first, 200 characters of what it sent
  const mine = await ok(await call("/v1/feedback/replies", { key: RA, shop: "ra1" }));
  assert.deepEqual(mine.map((r) => r.id), [rh2, rh1], "newest first, only this company");
  assert.deepEqual(Object.keys(mine[0]).sort(), ["id", "kind", "repliedAt", "reply", "text"]);
  assert.equal(mine[1].text, wordy.slice(0, 200));
  assert.equal(mine[1].kind, "help");
  assert.equal(mine[1].reply, "Thanks! Please update to 1.8.1, it is fixed there.");
  assert.deepEqual((await ok(await call("/v1/feedback/replies", { key: RA, shop: "ra2" }))).map((r) => r.id), [rh3]);
  assert.deepEqual((await ok(await call("/v1/feedback/replies", { key: RB, shop: "ra1" }))).map((r) => r.id), [rh4], "another install's key sees its own");
  assert.deepEqual(await ok(await call("/v1/feedback/replies", { key: RB, shop: "ra2" })), []);
  // since
  const cut = mine[0].repliedAt;
  assert.deepEqual((await ok(await call(`/v1/feedback/replies?since=${encodeURIComponent(cut)}`, { key: RA, shop: "ra1" }))).map((r) => r.id), [], "since is exclusive");
  assert.deepEqual((await ok(await call(`/v1/feedback/replies?since=${encodeURIComponent(mine[1].repliedAt)}`, { key: RA, shop: "ra1" }))).map((r) => r.id), [rh2]);
  await refused(await call("/v1/feedback/replies?since=yesterday-ish", { key: RA, shop: "ra1" }), 400, /since/, "a bad since");
  // the default is 90 days back
  await db.query(`UPDATE feedback SET replied_at = now() - interval '91 days' WHERE id = $1`, [rh1]);
  assert.deepEqual((await ok(await call("/v1/feedback/replies", { key: RA, shop: "ra1" }))).map((r) => r.id), [rh2], "older than 90 days is not offered");
  assert.equal((await ok(await call("/v1/feedback/replies?since=2000-01-01T00:00:00Z", { key: RA, shop: "ra1" }))).length, 2, "since reaches further back");
  // key and company are needed
  await refused(await call("/v1/feedback/replies", { key: RA }), 400, /X-Shop-Ref/, "no company");
  await refused(await call("/v1/feedback/replies", { shop: "ra1" }), 401, null, "no key");
  // at most 50
  for (let i = 0; i < 55; i++) {
    const id = (await ok(await sendJson(RB, "many", { kind: "idea", text: `idea ${i}`, context: ctx() }))).id;
    await db.query(`UPDATE feedback SET reply = 'ok', replied_at = now() - make_interval(secs => $2) WHERE id = $1`, [id, i + 1]);
  }
  assert.equal((await ok(await call("/v1/feedback/replies", { key: RB, shop: "many" }))).length, 50, "at most 50");
  console.log("replies: ok");
  }

  // ----- the owner's mailbox: a cap for the whole hub, then one email an hour at most -----
  await capped();

  // ----- a hub with no FEEDBACK_EMAIL sends nothing -----
  await stop2();
  console.log("feedback tests passed");
} catch (e) {
  console.error(e);
  console.error(hubLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await stop();
}

// Help, ideas and ratings are mailed one by one up to FEEDBACK_EMAIL_PER_HOUR an hour for the whole hub (2 on this hub),
// then only saved, with one email at most every hour saying how many more wait; a pending install's never one by one.
async function capped() {
  await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  hubLog = "";
  await startHub({ FEEDBACK_EMAIL_PER_HOUR: "2" });
  const A = await register("Install Capped A");
  const B = await register("Install Capped B");
  const P = await register("Install Capped Pending");
  await db.query(`UPDATE installs SET scope = 'pending' WHERE name = 'Install Capped Pending'`);
  await ok(await sendJson(P, "p1", { kind: "help", text: "capped, from a pending install", context: ctx() }));
  await waitFor(() => hubLog.includes("subject: 1 more feedback item is waiting on the admin page"), "the email that items wait");
  assert.ok(hubLog.includes("this hub emails 2 an hour at most") && hubLog.includes("Read them on the admin page: https://hub.example.test/admin (Help & ideas)"));
  for (const [key, shop, text] of [[A, "a1", "capped one"], [B, "b1", "capped two"], [A, "a2", "capped three"], [B, "b2", "capped four"]]) {
    await ok(await sendJson(key, shop, { kind: "help", text, context: ctx() }));
  }
  await waitFor(() => (hubLog.match(/subject: Help: /g) ?? []).length === 2, "two items mailed");
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(
    hubLog.match(/subject: .*/g),
    ["subject: 1 more feedback item is waiting on the admin page", "subject: Help: Install Capped A – capped one", "subject: Help: Install Capped B – capped two"],
    "two mailed one by one for the whole hub, then nothing more within the hour",
  );
  assert.equal((await list("kind=help&limit=500")).items.filter((i) => /^capped/.test(i.text)).length, 5, "every item is saved");
  console.log("mail cap: ok");
}

// A restart on the same database keeps what was stored (and a hub with no FEEDBACK_EMAIL stays silent).
async function stop2() {
  await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  hubLog = "";
  await startHub({ FEEDBACK_EMAIL: "" });
  const n = (await db.query(`SELECT count(*)::int AS n FROM feedback`)).rows[0].n;
  assert.ok(n > 250, "the rows are still there after a restart");
  const key = await register("Install Quiet");
  await ok(await sendJson(key, "q1", { kind: "help", text: "no mailbox set", context: ctx() }));
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!hubLog.includes("mail (not sent"), "no email without FEEDBACK_EMAIL");
}
