// Checks shop hop passports (src/hops.mjs, migration 031): starting a hop with a pinned key, invite codes (one use,
// organizer only), joining, leaving, the public sign-up (the share tick off by default, one passport per email or phone,
// the rate limit), the passport page with its QR code and printable card, signed stamps (SBHS1: the program's signing
// copied here, a wrong key, a bad signature, an unknown passport answering no_passport, the same stamp again), "all"
// and "any:N" completion, the organizer's completed list (names only for shoppers who shared) and draws, a company move
// carrying its hops, a partner-only install's access, and the export. Starts a hub of its own on a scratch database it
// creates and drops (127.0.0.1:5433, stitchbench/stitchbench; or DATABASE_URL to use one you made).
// usage: node test/hops.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { canonical, sha256hex } from "../src/partnersign.mjs";
import { stampText, verifyStamp } from "../src/hops.mjs";
import { codewords, qrModules } from "../src/qr.mjs";

const ADMIN = "hops-test-admin-token-0123456789";
const JOIN = "join-hops-test";
const ROOT = path.resolve(import.meta.dirname, "..");

const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_hops_${Date.now().toString(36)}`;
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
    env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Hops Test Hub", HUB_LICENSE_KID: "", HUB_LICENSE_KEY: "", ...env },
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

const call = (p, { key, json, method, shop, form, headers = {} } = {}) =>
  fetch(hub.url + p, {
    method: method ?? (json !== undefined || form !== undefined ? "POST" : "GET"),
    redirect: "manual",
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(shop ? { "X-Shop-Ref": shop } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(form !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : undefined,
  });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const refused = async (r, status, re, what) => {
  const body = await r.text();
  assert.equal(r.status, status, `${what}: ${r.status} ${body}`);
  assert.match(JSON.parse(body).error ?? body, re, what);
  return JSON.parse(body);
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;

// A company's partner key and the program's stamp signing (src/lib/hops/hop-math.ts signStamp).
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"), priv: privateKey };
}
const programStampString = (f) => ["SBHS1", f.hopId, f.shopRef, f.stampId, f.passport, f.at, sha256hex(canonical(f))].join("\n");
const signStamp = (k, f) => ({ v: 1, pub: k.pub, sig: crypto.sign(null, Buffer.from(programStampString(f)), k.priv).toString("base64") });
let stampN = 0;
function stamp(installKey, shopRef, k, hopId, passport, { at = new Date().toISOString(), stampId = `hs${++stampN}x`, signWith = k, fields = {} } = {}) {
  const f = { hopId, shopRef, stampId, passport, at };
  const sig = signStamp(signWith, { ...f, ...fields });
  return call(`/v1/hops/${hopId}/stamps`, { key: installKey, shop: shopRef, json: { stampId, passport, at, sig } });
}
const signUp = (slug, form, ip) => call(`/hop/${slug}`, { form, headers: ip ? { "X-Forwarded-For": ip } : {} });
const passportOf = (r) => {
  assert.equal(r.status, 303, `a sign-up goes to the passport (${r.status})`);
  const m = /^\/p\/([0-9A-Z]{8})$/.exec(r.headers.get("location"));
  assert.ok(m, `the passport address: ${r.headers.get("location")}`);
  return m[1];
};

try {
  // ----- the pure parts -----
  const k0 = keyPair();
  const f0 = { hopId: "h1", shopRef: "s1", stampId: "st1", passport: "7K2M9QXD", at: "2026-10-10T15:00:00.000Z" };
  assert.equal(stampText(f0), programStampString(f0), "the hub builds the program's SBHS1 string");
  assert.equal(verifyStamp(signStamp(k0, f0), f0), true, "a stamp the program signed checks out");
  assert.equal(verifyStamp(signStamp(k0, f0), { ...f0, passport: "7K2M9QXE" }), false, "another passport doesn't");
  assert.equal(verifyStamp({ ...signStamp(k0, f0), pub: keyPair().pub }, f0), false, "another key doesn't");
  assert.equal(codewords("HOP-7K2M-9QXD").length, 26, "a version 1-M code: 26 code words");
  assert.equal(qrModules("HOP-7K2M-9QXD").length, 21);
  assert.throws(() => codewords("hop-lower"), /holds up to 20/);
  console.log("pure parts: ok");

  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  await startHub();
  const X = await register("Organizer Install");
  const Y = await register("Member Install");
  const Z = await register("Hosted Install");
  const kO = keyPair();
  const kM = keyPair();
  const kM2 = keyPair();
  await ok(await call("/v1/shops/claim", { key: X, json: { shopRef: "org1", shopName: "Thimble Quilts", kind: "retail", program: "StitchShop", version: "1.7.0", sole: false } }));
  await ok(await call("/v1/shops/claim", { key: Y, json: { shopRef: "mem1", shopName: "Bobbin Barn", kind: "retail", program: "StitchShop", version: "1.7.0", sole: false } }));

  // ----- start, invite, join, leave -----
  await refused(await call("/v1/hops", { key: X, json: { name: "Fall Hop", startsOn: today, endsOn: later, rule: "all", publicKey: kO.pub } }), 400, /X-Shop-Ref/, "no company named");
  await refused(await call("/v1/hops", { key: X, shop: "org1", json: { name: "Fall Hop", startsOn: today, endsOn: later, rule: "all", publicKey: "nope" } }), 400, /partner key/, "no key");
  await refused(await call("/v1/hops", { key: X, shop: "org1", json: { name: "Fall Hop", startsOn: later, endsOn: today, rule: "all", publicKey: kO.pub } }), 400, /first and last day/, "dates backwards");
  await refused(await call("/v1/hops", { key: X, shop: "org1", json: { name: "Fall Hop", startsOn: today, endsOn: later, rule: "any:0", publicKey: kO.pub } }), 400, /rule/, "any:0");
  const { hop } = await ok(await call("/v1/hops", { key: X, shop: "org1", json: { name: "Fall Hop 2026", startsOn: today, endsOn: later, rule: "all", publicKey: kO.pub } }));
  assert.deepEqual([hop.name, hop.startsOn, hop.endsOn, hop.rule, hop.shops, hop.role, hop.status], ["Fall Hop 2026", today, later, "all", 1, "ORGANIZER", "JOINED"]);
  assert.match(hop.slug, /^fall-hop-2026-[a-z0-9]{4}$/);
  await refused(await call(`/v1/hops/${hop.id}/invite-code`, { key: Y, shop: "mem1", json: {} }), 404, /No such shop hop/, "a shop not in the hop makes no code");
  const { code } = await ok(await call(`/v1/hops/${hop.id}/invite-code`, { key: X, shop: "org1", json: {} }));
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  await refused(await call("/v1/hops/join", { key: X, shop: "org1", json: { code, publicKey: kO.pub } }), 400, /your own hop/, "the organizer's own code");
  const joined = await ok(await call("/v1/hops/join", { key: Y, shop: "mem1", json: { code: code.toLowerCase().replace(/-/g, " "), publicKey: kM.pub } }));
  assert.deepEqual([joined.hop.id, joined.hop.role, joined.hop.shops], [hop.id, "MEMBER", 2], "joined, typed loosely");
  await refused(await call("/v1/hops/join", { key: Z, shop: "z1", json: { code, publicKey: kM.pub } }), 409, /already used/, "a used code");
  await refused(await call(`/v1/hops/${hop.id}/invite-code`, { key: Y, shop: "mem1", json: {} }), 403, /organizer/, "a member makes no codes");
  await refused(await call(`/v1/hops/${hop.id}/completed`, { key: Y, shop: "mem1" }), 403, /organizer/, "a member doesn't see completed passports");
  const listY = await ok(await call("/v1/hops", { key: Y, shop: "mem1" }));
  assert.deepEqual(listY.hops.map((h) => [h.id, h.role, h.status, h.shops]), [[hop.id, "MEMBER", "JOINED", 2]]);
  assert.deepEqual((await ok(await call("/v1/hops", { key: Y, shop: "other" }))).hops, [], "another company on the install sees none");
  await refused(await call(`/v1/hops/${hop.id}/leave`, { key: X, shop: "org1", json: {} }), 400, /organize this hop/, "the organizer can't leave");
  // A third shop (on a hosted install) joins: the hop has three.
  const code2 = (await ok(await call(`/v1/hops/${hop.id}/invite-code`, { key: X, shop: "org1", json: {} }))).code;
  await ok(await call("/v1/hops/join", { key: Z, shop: "z1", json: { code: code2, publicKey: kM2.pub, shopName: "Zig Zag Sewing" } }));
  console.log("start, invite, join: ok");

  // ----- the public pages -----
  let r = await call(`/hop/${hop.slug}`);
  let html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Fall Hop 2026/);
  for (const n of ["Thimble Quilts", "Bobbin Barn", "Zig Zag Sewing"]) assert.ok(html.includes(n), `${n} is listed`);
  assert.match(html, /Collect stamps from all 3 shops/);
  assert.match(html, /<input type="checkbox" name="share" value="1">/, "the share tick is off by default");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await call("/hop/no-such-hop")).status, 404);
  r = await signUp(hop.slug, { name: "", email: "a@example.com" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /type your name/);
  r = await signUp(hop.slug, { name: "Ann" });
  assert.match(await r.text(), /email or a phone/);
  const ann = passportOf(await signUp(hop.slug, { name: "Ann Shopper", email: "Ann@Example.com", share: "1" }));
  const bea = passportOf(await signUp(hop.slug, { name: "Bea Private", phone: "(555) 010-2030" }));
  r = await signUp(hop.slug, { name: "Ann again", email: "ann@example.com" });
  assert.equal(r.status, 409, "one passport per email per hop");
  r = await signUp(hop.slug, { name: "Bea again", phone: "555.010.2030" });
  assert.equal(r.status, 409, "one passport per phone per hop");
  const row = (await db.query(`SELECT name, email, phone, share FROM hop_passports WHERE code = $1`, [bea])).rows[0];
  assert.deepEqual(row, { name: "Bea Private", email: null, phone: "(555) 010-2030", share: false }, "only what she typed; not shared");
  r = await call(`/p/${ann}`);
  html = await r.text();
  assert.equal(r.status, 200);
  const words = `HOP-${ann.slice(0, 4)}-${ann.slice(4)}`;
  assert.ok(html.includes(words), "the code, big");
  assert.match(html, /<svg[^>]+aria-label="QR code: HOP-/, "the QR code");
  assert.match(html, /Stamps: 0 of 3/);
  assert.match(html, /\?print=1/, "a printable card");
  html = await (await call(`/p/${ann}?print=1`)).text();
  assert.match(html, /class="card"/);
  assert.ok(html.includes(words));
  assert.equal((await call(`/p/${ann.toLowerCase()}`)).status, 200, "a code typed in lower case");
  assert.equal((await call("/p/ZZZZZZZZ")).status, 404);
  console.log("sign-up and passport pages: ok");

  // ----- stamps -----
  const at = new Date().toISOString();
  r = await stamp(X, "org1", kO, hop.id, "ZZZZZZZZ");
  const np = await refused(r, 404, /isn't in this hop/, "an unknown passport");
  assert.equal(np.code, "no_passport");
  await refused(await stamp(Y, "mem1", kM, hop.id, ann, { signWith: kO }), 403, /key this hop doesn't know/, "signed with another shop's key");
  await refused(await stamp(Y, "mem1", kM, hop.id, ann, { fields: { passport: bea } }), 403, /doesn't check out/, "a signature over another passport");
  await refused(await stamp(Y, "mem1", kM, hop.id, "abc"), 400, /8-character/, "a bad code");
  await refused(await stamp(Y, "mem1", kM, hop.id, ann, { at: "2020-01-01T00:00:00Z" }), 400, /outside it/, "a stamp years before the hop");
  await refused(await stamp(Y, "other", kM, hop.id, ann), 404, /No such shop hop/, "a company not in the hop");
  let s1 = await ok(await stamp(X, "org1", kO, hop.id, ann, { at, stampId: "st-a-org" }));
  assert.deepEqual(s1, { stampNo: 1, of: 3, complete: false, shopper: { name: "Ann Shopper", email: "ann@example.com", phone: null } }, "Ann shared: the shop gets her details");
  const again = await ok(await stamp(X, "org1", kO, hop.id, ann, { at, stampId: "st-a-org" }));
  assert.deepEqual(again, s1, "the same stamp again: the first one's numbers");
  const another = await ok(await stamp(X, "org1", kO, hop.id, ann, { stampId: "st-a-org-2" }));
  assert.equal(another.stampNo, 1, "a second stamp at the same shop is the first one");
  await refused(await stamp(Y, "mem1", kM, hop.id, bea, { stampId: "st-a-org" }), 409, /used for another stamp/, "a stamp id reused for another passport");
  s1 = await ok(await stamp(Y, "mem1", kM, hop.id, bea));
  assert.deepEqual(s1, { stampNo: 1, of: 3, complete: false, shopper: null }, "Bea didn't share: a count");
  assert.equal((await ok(await stamp(Y, "mem1", kM, hop.id, ann))).stampNo, 2);
  const done = await ok(await stamp(Z, "z1", kM2, hop.id, ann));
  assert.deepEqual([done.stampNo, done.of, done.complete], [3, 3, true], "Ann is complete");
  html = await (await call(`/p/${ann}`)).text();
  assert.match(html, /Stamps: 3 of 3 &#8212; complete!/);
  assert.ok(html.includes("Bobbin Barn"));
  console.log("stamps: ok");

  // ----- completed and draws -----
  await ok(await stamp(X, "org1", kO, hop.id, bea));
  await ok(await stamp(Z, "z1", kM2, hop.id, bea));
  let comp = await ok(await call(`/v1/hops/${hop.id}/completed`, { key: X, shop: "org1" }));
  assert.deepEqual([comp.passports, comp.stamps], [2, 6]);
  assert.deepEqual(comp.completed, [{ passport: ann, name: "Ann Shopper" }, { passport: bea, name: `Passport HOP-${bea.slice(0, 4)}-${bea.slice(4)}` }], "names only for shoppers who shared");
  assert.ok(!JSON.stringify(comp).includes("Bea Private"), "Bea's name never leaves the hub");
  const { draw } = await ok(await call(`/v1/hops/${hop.id}/draws`, { key: X, shop: "org1", json: { passport: bea, prize: "Sewing machine" } }));
  assert.deepEqual([draw.passport, draw.prize, draw.present], [bea, "Sewing machine", true]);
  const marked = await ok(await call(`/v1/hops/${hop.id}/draws/${draw.id}`, { key: X, shop: "org1", method: "PATCH", json: { present: false } }));
  assert.equal(marked.draw.present, false);
  await refused(await call(`/v1/hops/${hop.id}/draws/nope`, { key: X, shop: "org1", method: "PATCH", json: { present: false } }), 404, /No such draw/, "an unknown draw");
  await refused(await call(`/v1/hops/${hop.id}/draws`, { key: Y, shop: "mem1", json: { passport: ann, prize: "x" } }), 403, /organizer/, "a member draws nothing");
  // A shop leaving: "all" now needs the two still in; Bea's stamps from them still complete her.
  await ok(await call(`/v1/hops/${hop.id}/leave`, { key: Y, shop: "mem1", json: {} }));
  await refused(await stamp(Y, "mem1", kM, hop.id, ann), 403, /isn't taking part/, "a shop that left stamps nothing");
  comp = await ok(await call(`/v1/hops/${hop.id}/completed`, { key: X, shop: "org1" }));
  assert.equal(comp.completed.length, 2);
  assert.equal(comp.draws.length, 1);
  assert.equal((await ok(await call("/v1/hops", { key: Y, shop: "mem1" }))).hops[0].status, "LEFT");
  console.log("completed and draws: ok");

  // ----- "any:N" -----
  const { hop: h2 } = await ok(await call("/v1/hops", { key: X, shop: "org1", json: { name: "Spring Hop", startsOn: today, endsOn: later, rule: "any:2", publicKey: kO.pub } }));
  const c3 = (await ok(await call(`/v1/hops/${h2.id}/invite-code`, { key: X, shop: "org1", json: {} }))).code;
  await ok(await call("/v1/hops/join", { key: Y, shop: "mem1", json: { code: c3, publicKey: kM.pub } }));
  const cara = passportOf(await signUp(h2.slug, { name: "Cara", email: "ann@example.com" }));
  assert.equal((await ok(await stamp(Y, "mem1", kM, h2.id, cara))).of, 2);
  await refused(await stamp(Y, "mem1", kM, h2.id, ann), 404, /isn't in this hop/, "a passport of another hop");
  assert.equal((await ok(await stamp(X, "org1", kO, h2.id, cara))).complete, true, "any 2 shops");
  console.log("any:N: ok");

  // ----- a company move carries its hops -----
  const W = await register("New Install");
  const wId = (await db.query(`SELECT id FROM installs WHERE name = 'New Install'`)).rows[0].id;
  const memShop = (await db.query(`SELECT id FROM shops WHERE shop_ref = 'mem1'`)).rows[0].id;
  await ok(await call(`/v1/admin/shops/${memShop}/move`, { key: ADMIN, json: { toInstallId: wId } }));
  assert.deepEqual((await ok(await call("/v1/hops", { key: W, shop: "mem1" }))).hops.map((h) => h.id).sort(), [hop.id, h2.id].sort(), "the hops went with the company");
  assert.deepEqual((await ok(await call("/v1/hops", { key: Y, shop: "mem1" }))).hops, [], "and left the old install");
  const dora = passportOf(await signUp(h2.slug, { name: "Dora", phone: "555 123 4567" }));
  assert.equal((await ok(await stamp(W, "mem1", kM, h2.id, dora))).stampNo, 1, "stamps from the new install");
  console.log("company move: ok");

  // ----- a partner-only install (a quilt shop on a partner code) may use the hop routes -----
  const P = (await db.query(`SELECT id FROM installs WHERE name = 'Hosted Install'`)).rows[0].id;
  await db.query(`UPDATE installs SET scope = 'partner' WHERE id = $1`, [P]);
  assert.equal((await ok(await call("/v1/hops", { key: Z, shop: "z1" }))).hops.length, 1, "partner scope: hops allowed");
  await db.query(`UPDATE installs SET scope = 'member' WHERE id = $1`, [P]);
  console.log("partner-only install: ok");

  // ----- sign-ups are rate-limited per address (20 an hour) -----
  await db.query(`UPDATE hops SET ends_on = $2 WHERE id = $1`, [h2.id, later]);
  let limited = 0;
  for (let i = 0; i < 22; i++) {
    const res = await call(`/hop/${h2.slug}`, { form: { name: `N${i}`, email: `n${i}@example.com` } });
    if (res.status === 429) limited++;
  }
  assert.ok(limited >= 2, `the 21st sign-up from one address is refused (${limited})`);
  console.log("sign-up rate limit: ok");

  // ----- an ended hop takes no sign-ups -----
  await db.query(`UPDATE hops SET ends_on = '2020-01-02', starts_on = '2020-01-01' WHERE id = $1`, [hop.id]);
  html = await (await call(`/hop/${hop.slug}`)).text();
  assert.match(html, /This shop hop is over/);
  assert.ok(!html.includes("<form"), "no form on an ended hop");

  // ----- the export carries the hop tables -----
  const exp = zlib.gunzipSync(Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer())).toString();
  for (const t of ["hop", "hop_shop", "hop_invite", "hop_passport", "hop_stamp", "hop_draw"]) assert.ok(exp.includes(`"t":"${t}"`), `the export has ${t} rows`);
  console.log("export: ok");
  console.log("hops: ok");
} catch (e) {
  console.error(e);
  console.error("hub log tail:\n" + hubLog.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  await stop();
}
