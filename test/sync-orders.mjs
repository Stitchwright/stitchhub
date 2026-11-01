// Checks the MakerFoundry order messages over hub sync v2 (#34: src/sync-orders.mjs, src/sync.mjs, docs/hub-sync-design.md).
// Part 1 is pure and runs the shared fixtures (test/fixtures/sync-orders: a valid body per type and a list of refused ones, the
// files MakerFoundry and StitchShop test against). Part 2 runs a hub of its own against a scratch database and a bucket stand-in:
// shops opt in (not listed or sent to until they do, per-shop open-order cap), the signed order.placed (unsigned, tampered and
// wrong-key refused), customer email/phone and an address on a pickup never routed, files by short-lived signed addresses
// (size, SHA-256, who may fetch, a stranger and a wrong size refused), status/proof/cancel only on a real order, an order that
// expires, duplicate and out-of-order delivery, an old client that doesn't know the newer type, and a full queue.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/sync-orders.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { Bad, signEnvelope, validateBody, verifySignature } from "../src/sync-orders.mjs";
import { startBucket } from "./bucket-mock.mjs";

const FIX = path.join(import.meta.dirname, "fixtures", "sync-orders");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));

// ----- part 1: the shared fixtures -----
for (const type of ["catalog", "order.placed", "order.status", "proof.sent", "proof.answer", "order.cancel", "message.expired"]) {
  const body = fixture(`${type}.v1.valid.json`);
  const from = type === "order.status" || type === "proof.sent" ? "shop" : type === "message.expired" ? "hub" : type === "order.cancel" ? "shop" : "service";
  const out = validateBody(type, 1, body, { from });
  assert.deepEqual(out.dropped, [], `${type}: nothing dropped from the valid fixture`);
  assert.deepEqual(out.body, body, `${type}: a valid body comes out unchanged`);
}
// Variants that must also pass: a taxed order (the tax is outside the shop's share, the postcode is `postcode`, an empty line2) and an empty tracking.
for (const [file, type, from] of [["order.placed.v1.taxed.valid.json", "order.placed", "service"], ["order.status.v1.empty-tracking.valid.json", "order.status", "shop"]]) {
  const body = fixture(file);
  const out = validateBody(type, 1, body, { from });
  assert.deepEqual(out.dropped, [], `${file}: nothing dropped`);
  assert.deepEqual(out.body, body, `${file}: comes out unchanged`);
}
{
  const t = fixture("order.placed.v1.taxed.valid.json").totals;
  assert.equal(t.shop_gets_cents, t.paid_cents - t.tax_cents - t.fee_cents - t.card_fee_cents, "a taxed order's earnings exclude the tax");
}
for (const f of fixture("invalid.json")) {
  try {
    validateBody(f.type, 1, f.body, { from: f.from });
    assert.fail(`${f.name}: should have been refused`);
  } catch (e) {
    assert.ok(e instanceof Bad, `${f.name}: ${e.message}`);
    assert.equal(e.code, f.code, `${f.name}: ${e.code} ${e.message}`);
  }
}
{
  const u = fixture("unknown-fields.v1.json");
  const out = validateBody(u.type, 1, u.body, { from: "shop" });
  assert.deepEqual(out.dropped, u.dropped);
  assert.equal(out.body.internal_cost, undefined, "a field outside the version never travels");
}
assert.throws(() => validateBody("order.placed", 2, {}, { from: "service" }), (e) => e.code === "unknown_type");
console.log("  ok  fixtures: every valid body passes unchanged, every invalid one is refused with its code, unknown fields are dropped");

// ----- part 2: a hub -----
const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "orders-test-admin-token";
const JOIN = "join-orders-test";
const ROOT = path.resolve(import.meta.dirname, "..");
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = await startBucket();
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, ...bucket.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Orders Test Hub", TRUST_PROXY: "true", SYNC_SWEEP_MS: "600", SYNC_QUEUE_MESSAGES: "8" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
hub.stdout.on("data", (d) => (log += d));
hub.stderr.on("data", (d) => (log += d));
process.on("exit", () => hub.kill());
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${log}`);
  await sleep(200);
}
const db = new pg.Pool({ connectionString: DB, max: 2 });
async function call(p, { key, method, json, headers = {} } = {}) {
  const r = await fetch(HUB + p, { method: method ?? (json !== undefined ? "POST" : "GET"), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const expect = (r, status, what) => {
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const refused = (r, status, code, what) => {
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, code, `${what}: ${JSON.stringify(r.body)}`);
};
const reg = async (name) => expect(await call("/v1/register", { json: { joinKey: JOIN, name } }), 200, "register");
const claim = async (key, ref, name) => expect(await call("/v1/shops/claim", { key, json: { shopRef: ref, shopName: name, kind: "retail", program: "StitchShop", version: "1.8.0", sole: false } }), 200, "claim");
const uuid = () => crypto.randomUUID();
const SHOP = (key, ref) => ({ key, headers: { "X-Shop-Ref": ref, "X-Client": "stitchshop/1.8.0" } });
const SVC = (key) => ({ key, headers: { "X-Client": "makerfoundry/0.1.0" } });
const ALL = { "order.placed": [1], "order.status": [1], "proof.sent": [1], "proof.answer": [1], "order.cancel": [1], "message.expired": [1], catalog: [1] };
const shopHello = (s, types = ALL) => call("/v2/hello", { ...s, json: { app: "stitchshop", version: "1.8.0", types } });
const svcHello = (s) => call("/v2/hello", { ...s, json: { app: "makerfoundry", version: "0.1.0", types: ALL } });
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519").privateKey;
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");

try {
  const X = await reg("Install X");
  const Y = await reg("Install Y");
  await claim(X.installKey, "a1", "Shop A");
  await claim(Y.installKey, "b1", "Shop B");
  await claim(Y.installKey, "b2", "Shop D");
  const shopId = async (ref, inst) => (await db.query(`SELECT id FROM shops WHERE shop_ref = $1 AND install_id = $2`, [ref, inst])).rows[0].id;
  const idA = await shopId("a1", X.installId);
  const idB = await shopId("b1", Y.installId);
  const idD = await shopId("b2", Y.installId);
  const A = SHOP(X.installKey, "a1");
  const B = SHOP(Y.installKey, "b1");
  const D = SHOP(Y.installKey, "b2");
  const issued = expect(await call("/v1/admin/service-keys", { key: ADMIN, json: { name: "makerfoundry" } }), 200, "service key");
  const M = SVC(issued.key);
  for (const s of [A, B, D]) expect(await shopHello(s), 200, "shop hello");
  expect(await svcHello(M), 200, "service hello");

  const placed = (to, conversation, o = {}) => {
    const body = o.body ?? fixture("order.placed.v1.valid.json");
    const e = { id: uuid(), type: "order.placed", version: 1, conversation, seq: 1, to, created_at: new Date().toISOString(), body, ...o.env };
    if (o.sign !== false) e.sig = signEnvelope({ ...e, from: "service:makerfoundry" }, o.key ?? privateKey);
    return e;
  };
  const send = (s, e) => call("/v2/messages", { ...s, json: e });
  const get = (s, q = "") => call(`/v2/messages${q}`, s);
  const ack = (s, ids) => call("/v2/messages/ack", { ...s, json: { ids } });

  // ----- the signing key, and a shop that has not opted in -----
  const keyId = (await call("/v1/admin/service-keys", { key: ADMIN })).body.keys[0].id;
  refused(await send(M, placed(`shop:${idA}`, "o-1")), 403, "unsigned", "no public key registered yet");
  expect(await call(`/v1/admin/service-keys/${keyId}/public-key`, { key: ADMIN, method: "PUT", json: { publicKey: spki } }), 200, "register public key");
  assert.equal(expect(await call("/v2/hello"), 200, "hello").keys["service:makerfoundry"], spki, "hello publishes the service's key");
  assert.equal((await call("/v2/shops", M)).body.shops?.length ?? 0, 0, "a shop that hasn't opted in isn't listed");
  refused(await send(M, placed(`shop:${idA}`, "o-1")), 403, "not_opted_in", "not opted in");
  expect(await call("/v2/optin", { ...A, method: "PUT", json: { service: "makerfoundry", maxOpen: 2 } }), 200, "A opts in with a cap of 2");
  expect(await call("/v2/optin", { ...B, method: "PUT", json: { service: "makerfoundry" } }), 200, "B opts in");
  assert.deepEqual((await call("/v2/shops", M)).body.shops.map((s) => s.id).sort(), [`shop:${idA}`, `shop:${idB}`].sort(), "opted-in shops are listed, D is not");
  console.log("  ok  a shop takes no orders until it opts in; the list shows only opted-in shops");

  // ----- files: put, upload to the bucket, done, get -----
  const art = Buffer.from("fake embroidery file ".repeat(100));
  const artHash = sha256(art);
  const fixtureBody = (conv) => {
    const b = fixture("order.placed.v1.valid.json");
    b.lines[0].decorations[0].art = { file: "logo.dst", size: art.length, sha256: artHash };
    delete b.preview;
    return b;
  };
  const put = (s, json) => call("/v2/files/put", { ...s, json });
  const upload = async (r, bytes) => {
    try {
      return (await fetch(r.url, { method: "PUT", headers: r.headers, body: bytes })).status;
    } catch {
      return 0; // the client itself refuses a body that isn't the signed content-length
    }
  };
  // the message cannot point at a file that isn't there
  refused(await send(M, placed(`shop:${idA}`, "o-1", { body: fixtureBody("o-1") })), 400, "file_not_ready", "no file yet");
  refused(await put(M, { conversation: "o-1", sha256: artHash, size: 11 * 1024 * 1024, kind: "art", to: `shop:${idA}` }), 413, "file_too_large", "art over 10 MB");
  refused(await put(M, { conversation: "o-1", sha256: artHash, size: 10, kind: "art", to: `shop:${idD}` }), 403, "not_opted_in", "file for a shop that hasn't opted in");
  const up = expect(await put(M, { conversation: "o-1", sha256: artHash, size: art.length, kind: "art", to: `shop:${idA}` }), 200, "put");
  assert.equal(up.ready, false);
  assert.ok(up.expires_in <= 900 && up.url.includes("X-Amz-Signature"), "a short-lived signed address");
  assert.notEqual(await upload(up, Buffer.from("different bytes entirely")), 200, "bytes of another length than announced don't go in");
  assert.equal(await upload(up, Buffer.alloc(art.length, 7)), 400, "the right length but other bytes: the bucket checks the signed SHA-256 (BadDigest)");
  assert.equal(await upload(up, art), 200, "the right bytes go in");
  refused(await send(M, placed(`shop:${idA}`, "o-1", { body: fixtureBody("o-1") })), 400, "file_not_ready", "uploaded but not confirmed");
  expect(await call("/v2/files/done", { ...M, json: { conversation: "o-1", sha256: artHash } }), 200, "done");
  assert.equal(expect(await put(M, { conversation: "o-1", sha256: artHash, size: art.length, kind: "art", to: `shop:${idA}` }), 200, "put again").ready, true, "the same file again is already there");
  console.log("  ok  files: size limit, signed length and SHA-256 enforced by the bucket, confirmed once, then ready");

  // ----- the signed order.placed and the privacy rules -----
  const orderMsg = (to, conv, o = {}) => placed(to, conv, { body: fixtureBody(conv), ...o });
  refused(await send(M, orderMsg(`shop:${idA}`, "o-1", { sign: false })), 403, "bad_signature", "unsigned (no sig at all)");
  refused(await send(M, orderMsg(`shop:${idA}`, "o-1", { key: otherKey })), 403, "bad_signature", "signed with another key");
  const tampered = orderMsg(`shop:${idA}`, "o-1");
  tampered.body.note = "changed after it was signed"; // still a valid body, so it is the signature that refuses it
  refused(await send(M, tampered), 403, "bad_signature", "body changed after signing");
  const leaky = fixtureBody("o-1");
  leaky.customer.email = "pat@example.com";
  refused(await send(M, orderMsg(`shop:${idA}`, "o-1", { body: leaky })), 400, "personal_contact", "customer email");
  const pickup = fixtureBody("o-1");
  pickup.fulfilment = "pickup";
  refused(await send(M, orderMsg(`shop:${idA}`, "o-1", { body: pickup })), 400, "ship_to_not_allowed", "address on a pickup");
  const extra = fixtureBody("o-1");
  extra.internal_margin = 5;
  refused(await send(M, orderMsg(`shop:${idA}`, "o-1", { body: extra })), 400, "not_normalized", "a signed message with a field outside the version");
  const first = orderMsg(`shop:${idA}`, "o-1");
  const r1 = expect(await send(M, first), 202, "order.placed");
  assert.equal(r1.state, "queued");
  assert.equal(expect(await send(M, first), 202, "same id again").duplicate, true, "duplicate delivery from the sender is stored once");
  console.log("  ok  order.placed: unsigned, wrong-key and tampered refused; no contact details; no address on a pickup; duplicate send stored once");

  // the shop gets exactly what was signed, and the hub's registered key verifies it
  const got = expect(await get(A), 200, "shop reads");
  assert.equal(got.messages.length, 1);
  const m = got.messages[0];
  assert.deepEqual(m.body, first.body, "the shop gets the body as signed");
  assert.equal(m.from, "service:makerfoundry");
  assert.ok(!JSON.stringify(m.body).includes("pat@example.com") && !/"(email|phone)"/.test(JSON.stringify(m.body)), "no customer email or phone anywhere");
  const again = expect(await get(A), 200, "shop reads again");
  assert.equal(again.messages.length, 1, "offered again until acked (at least once)");
  const fileGot = expect(await call("/v2/files/get", { ...A, json: { conversation: "o-1", sha256: artHash } }), 200, "shop fetches the art");
  const fetched = Buffer.from(await (await fetch(fileGot.url)).arrayBuffer());
  assert.equal(sha256(fetched), artHash, "the bytes the shop downloads are the bytes announced");
  assert.ok(fileGot.expires_in <= 600);
  refused(await call("/v2/files/get", { ...B, json: { conversation: "o-1", sha256: artHash } }), 404, "no_such_file", "another shop can't fetch it");
  refused(await call("/v2/files/get", { ...D, json: { conversation: "o-1", sha256: artHash } }), 404, "no_such_file", "a shop that is not in the conversation");
  expect(await ack(A, [m.id]), 200, "ack");
  assert.equal(expect(await get(A), 200, "after ack").messages.length, 0);
  console.log("  ok  the shop gets the body as signed, art by a signed address (bytes match), strangers get nothing");

  // ----- a wrong-size upload is caught by done -----
  const art2 = Buffer.from("second file");
  const h2 = sha256(art2);
  const up2 = expect(await put(M, { conversation: "o-2", sha256: h2, size: art2.length + 5, kind: "art", to: `shop:${idA}` }), 200, "put 2");
  bucket.store.set(`sync/${sha256("o-2").slice(0, 32)}/${h2}`, art2); // the bytes in the bucket are not the size announced
  refused(await call("/v2/files/done", { ...M, json: { conversation: "o-2", sha256: h2 } }), 400, "size_mismatch", "size differs from the announcement");
  assert.equal(bucket.store.has(`sync/${sha256("o-2").slice(0, 32)}/${h2}`), false, "the wrong file is removed from the bucket");
  assert.equal(up2.ready, false);
  console.log("  ok  a file whose size isn't the one announced is refused at done and removed");

  // ----- mock-ups: shop to service, only on a real order -----
  const mock = Buffer.from("PNG-ish bytes");
  const mh = sha256(mock);
  refused(await put(A, { conversation: "nope", sha256: mh, size: mock.length, kind: "mockup", type: "image/png" }), 404, "no_such_order", "mock-up for an order that doesn't exist");
  refused(await put(A, { conversation: "o-1", sha256: mh, size: mock.length, kind: "mockup", type: "image/gif" }), 400, "bad_field", "gif mock-up");
  refused(await put(A, { conversation: "o-1", sha256: mh, size: 3 * 1024 * 1024, kind: "mockup", type: "image/png" }), 413, "file_too_large", "mock-up over 2 MB");
  const mu = expect(await put(A, { conversation: "o-1", sha256: mh, size: mock.length, kind: "mockup", type: "image/png" }), 200, "mock-up put");
  assert.equal(await upload(mu, mock), 200);
  expect(await call("/v2/files/done", { ...A, json: { conversation: "o-1", sha256: mh } }), 200, "mock-up done");
  const proof = (conv, o = {}) => ({ id: uuid(), type: "proof.sent", version: 1, conversation: conv, seq: 1, to: "service:makerfoundry", created_at: new Date().toISOString(), body: { proof: 1, mockup: { size: mock.length, sha256: mh, type: "image/png" } }, ...o });
  expect(await send(A, proof("o-1")), 202, "proof.sent");
  refused(await send(B, proof("o-1")), 409, "no_such_order", "another shop can't speak in A's order");
  const status = (conv, st, seq, s = "ready") => ({ id: uuid(), type: "order.status", version: 1, conversation: conv, seq, to: "service:makerfoundry", created_at: new Date().toISOString(), body: { status: st } });
  refused(await send(A, status("not-an-order", "ready", 1)), 409, "no_such_order", "status for an order that doesn't exist");
  const sv = expect(await get(M), 200, "service reads");
  assert.deepEqual(sv.messages.map((x) => x.type), ["proof.sent"]);
  expect(await ack(M, sv.messages.map((x) => x.id)), 200, "service acks");
  const ans = { id: uuid(), type: "proof.answer", version: 1, conversation: "o-1", seq: 2, to: `shop:${idA}`, created_at: new Date().toISOString(), body: { proof: 1, answer: "approved" } };
  expect(await send(M, ans), 202, "proof.answer");
  console.log("  ok  proofs: mock-up limits, only on a real order of that shop, answer comes back");

  // ----- out-of-order delivery: the later message waits while the earlier one is still waiting -----
  const drainAck = async (s) => {
    const ms = expect(await get(s), 200, "drain").messages;
    if (ms.length) expect(await ack(s, ms.map((x) => x.id)), 200, "ack all");
    return ms;
  };
  await drainAck(A);
  await drainAck(M);
  const s4 = status("o-1", "approved", 4);
  const s5 = status("o-1", "in_production", 5);
  expect(await send(A, s5), 202, "seq 5 first");
  expect(await send(A, s4), 202, "seq 4 after");
  const r45 = expect(await get(M), 200, "service reads").messages;
  assert.deepEqual(r45.map((x) => x.seq), [4], "seq 5 is held back until seq 4 has been handed over");
  const r45b = expect(await get(M), 200, "service reads again").messages;
  assert.deepEqual(r45b.map((x) => x.seq).sort(), [4, 5], "then both (the receiver applies them by seq), offered again until acked");
  expect(await ack(M, r45b.map((x) => x.id)), 200, "ack");
  console.log("  ok  out-of-order delivery: the later message waits for the earlier one; duplicates are offered again until acked");

  // ----- open orders per shop (A takes 2): a third is refused until one finishes -----
  const place = async (conv, id, o = {}) => {
    const bytes = Buffer.from(`art for ${conv}`);
    const h = sha256(bytes);
    const body = fixtureBody(conv);
    body.lines[0].decorations[0].art = { file: "logo.dst", size: bytes.length, sha256: h };
    const u = expect(await put(M, { conversation: conv, sha256: h, size: bytes.length, kind: "art", to: `shop:${id}` }), 200, `put ${conv}`);
    if (!u.ready) {
      assert.equal(await upload(u, bytes), 200);
      expect(await call("/v2/files/done", { ...M, json: { conversation: conv, sha256: h } }), 200, `done ${conv}`);
    }
    return send(M, placed(`shop:${id}`, conv, { body, ...o }));
  };
  expect(await place("o-3", idA), 202, "second open order");
  refused(await place("o-4", idA), 429, "shop_order_cap", "third open order");
  assert.equal((await db.query(`SELECT 1 FROM sync_orders WHERE conversation = 'o-4'`)).rowCount, 0, "a refused order opens nothing");
  expect(await send(A, status("o-1", "shipped", 6)), 202, "o-1 ships and closes");
  expect(await place("o-4", idA), 202, "now the third fits");
  expect(await send(A, status("o-1", "collected", 7)), 202, "a finished order still takes a late message (it just no longer counts as open)");
  const cancel = { id: uuid(), type: "order.cancel", version: 1, conversation: "o-3", seq: 2, to: `shop:${idA}`, created_at: new Date().toISOString(), body: { by: "customer", why: "Changed my mind." } };
  expect(await send(M, cancel), 202, "customer cancel from the service");
  refused(await send(A, { ...cancel, id: uuid(), to: "service:makerfoundry", seq: 3, body: { by: "customer", why: "x" } }), 400, "bad_field", "the shop can't cancel as the customer");
  assert.equal((await db.query(`SELECT state, why_closed FROM sync_orders WHERE conversation = 'o-3'`)).rows[0].why_closed, "cancelled");
  console.log("  ok  per-shop cap of open orders, freed by shipping or cancelling; a finished order's late messages are accepted");
  await drainAck(A);
  await drainAck(M);

  // ----- an order that expires: the service is told, the shop never gets it -----
  expect(await call("/v2/optin", { ...B, method: "PUT", json: { service: "makerfoundry", enabled: true } }), 200, "B");
  const expSoon = new Date(Date.now() + 1500).toISOString();
  expect((await place("o-exp", idB, { env: { expires_at: expSoon } })), 202, "short-lived order");
  let notice;
  for (let i = 0; i < 30 && !notice; i++) {
    await sleep(300);
    notice = (await get(M)).body.messages.find((x) => x.type === "message.expired");
  }
  assert.ok(notice, "the service hears the order lapsed");
  const nb = notice.body;
  assert.equal(nb.type, "order.placed");
  assert.equal(nb.conversation, "o-exp");
  assert.equal(nb.reason, "expired");
  assert.equal(expect(await get(B), 200, "B reads").messages.filter((x) => x.type === "order.placed").length, 0, "the lapsed order is never handed to the shop");
  refused(await send(B, status("o-exp", "ready", 1)), 409, "no_such_order", "a lapsed order takes no status");
  console.log("  ok  an expired order: the service gets message.expired, the shop gets nothing, the order closes");

  // ----- an older client that doesn't know the newer type: held, then released by its next hello -----
  expect(await call("/v2/optin", { ...D, method: "PUT", json: { service: "makerfoundry" } }), 200, "D opts in");
  expect(await shopHello(D, { "message.expired": [1] }), 200, "old hello");
  const held = expect(await place("o-old", idD), 202, "order to an old client");
  assert.equal(held.state, "held_capability", "queued but held until the client can read it");
  assert.equal(expect(await get(D), 200, "old client reads").messages.length, 0, "an old client is never handed what it can't read");
  const rel = expect(await shopHello(D), 200, "updated hello");
  assert.equal(rel.released, 1, "its next hello releases it");
  assert.equal(expect(await get(D), 200, "reads").messages.length, 1);
  refused(await send(M, { id: uuid(), type: "order.refund", version: 1, conversation: "o-old", seq: 9, to: `shop:${idD}`, created_at: new Date().toISOString(), body: {} }), 400, "unknown_type", "a type the hub doesn't carry");
  console.log("  ok  an old client getting a newer type: held, not delivered, released by its next hello; unknown types refused");
  await drainAck(D);

  // ----- a full queue: new refused, nothing already queued is dropped -----
  const queued = [];
  for (let i = 0; ; i++) {
    const r = await place(`o-full-${i}`, idD);
    if (r.status === 429) {
      assert.equal(r.body.code, "recipient_queue_full");
      break;
    }
    expect(r, 202, `fill ${i}`);
    queued.push(`o-full-${i}`);
    assert.ok(i < 20, "the queue never filled");
  }
  assert.ok(queued.length >= 5, "several fit before it filled");
  assert.equal((await db.query(`SELECT 1 FROM sync_deliveries d JOIN sync_messages m ON m.sender = d.sender AND m.id = d.message_id WHERE d.recipient = $1 AND m.conversation = ANY($2) AND d.state = 'queued'`, [`shop:${idD}`, queued])).rowCount, queued.length, "nothing queued was dropped");
  assert.equal((await db.query(`SELECT 1 FROM sync_orders WHERE conversation = $1`, [`o-full-${queued.length}`])).rowCount, 0, "the refused order did not open");
  const back = await drainAck(D);
  assert.equal(back.length, queued.length, "the shop catches up with every one");
  expect(await place("o-after-full", idD), 202, "and the queue takes more once it caught up");
  console.log("  ok  a full queue refuses new orders, loses none, and takes more once the shop has caught up");

  // ----- the customer's own picture comes with an order (order.placed.preview): the service uploads it as a mock-up, the shop fetches it -----
  const pic = Buffer.from("customer preview picture bytes");
  const picHash = sha256(pic);
  const withPic = fixtureBody("o-pic");
  withPic.preview = { size: pic.length, sha256: picHash, type: "image/png" };
  const artPic = Buffer.from(`art for o-pic`);
  withPic.lines[0].decorations[0].art = { file: "logo.dst", size: artPic.length, sha256: sha256(artPic) };
  for (const [bytes, kind, type] of [[artPic, "art", undefined], [pic, "mockup", "image/png"]]) {
    const u = expect(await put(M, { conversation: "o-pic", sha256: sha256(bytes), size: bytes.length, kind, to: `shop:${idB}`, ...(type ? { type } : {}) }), 200, `put ${kind}`);
    assert.equal(await upload(u, bytes), 200);
    expect(await call("/v2/files/done", { ...M, json: { conversation: "o-pic", sha256: sha256(bytes) } }), 200, `done ${kind}`);
  }
  expect(await send(M, placed(`shop:${idB}`, "o-pic", { body: withPic })), 202, "an order with a preview picture is accepted");
  const gotPic = expect(await call("/v2/files/get", { ...B, json: { conversation: "o-pic", sha256: picHash } }), 200, "the shop fetches the preview");
  assert.equal(sha256(Buffer.from(await (await fetch(gotPic.url)).arrayBuffer())), picHash, "the picture the shop gets is the picture the service uploaded");
  refused(await put(B, { conversation: "o-pic", sha256: sha256(artPic), size: artPic.length, kind: "art" }), 400, "bad_field", "a shop still can't upload art");
  console.log("  ok  the customer's preview picture travels with an order: the service uploads it, the shop fetches it");

  // ----- shipping by the piece, the pick-up address, and sales tax that is the marketplace's (decided 2026-10-31) -----
  const catalogMsg = { id: uuid(), type: "catalog", version: 1, conversation: "catalog", seq: 1, to: "service:makerfoundry", created_at: new Date().toISOString(), body: fixture("catalog.v1.valid.json") };
  expect(await send(A, catalogMsg), 202, "the full catalogue goes through");
  const heard = expect(await get(M), 200, "service reads the catalogue").messages.find((x) => x.id === catalogMsg.id);
  assert.deepEqual(heard?.body, catalogMsg.body, "the catalogue is passed on unchanged: shipping by the piece, the pick-up address, the account, the garment price");
  expect(await ack(M, [catalogMsg.id]), 200, "ack");
  const taxed = fixture("order.placed.v1.taxed.valid.json");
  const art4 = Buffer.from("taxed order art");
  const h4 = sha256(art4);
  taxed.lines[0].decorations[0].art = { file: "logo.dst", size: art4.length, sha256: h4 };
  delete taxed.preview;
  const u4 = expect(await put(M, { conversation: "o-tax", sha256: h4, size: art4.length, kind: "art", to: `shop:${idD}` }), 200, "put taxed art");
  assert.equal(await upload(u4, art4), 200);
  expect(await call("/v2/files/done", { ...M, json: { conversation: "o-tax", sha256: h4 } }), 200, "done taxed art");
  // Sent as MakerFoundry writes it: created_at to the second ("...:39Z") and no expires_at.
  const secondsOnly = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const taxedMsg = placed(`shop:${idD}`, "o-tax", { body: taxed, env: { created_at: secondsOnly } });
  assert.equal(taxedMsg.expires_at, undefined);
  expect(await send(M, taxedMsg), 202, "a taxed order is signed and delivered");
  const gotTaxed = expect(await get(D), 200, "shop reads the taxed order").messages.find((x) => x.id === taxedMsg.id);
  assert.deepEqual(gotTaxed?.body, taxed, "delivered exactly as signed: the tax outside the shop's share, the postcode as sent");
  assert.equal(gotTaxed.created_at, secondsOnly, "created_at is delivered byte for byte, not as the hub would write it");
  assert.equal(gotTaxed.expires_at, null, "no expires_at was sent, so none is delivered (the signature covers its absence)");
  assert.ok(Date.parse(gotTaxed.hub_expires_at) > Date.now(), "when the hub gives up on it is said apart");
  const published = expect(await call("/v2/hello"), 200, "hello").keys["service:makerfoundry"];
  assert.equal(verifySignature(gotTaxed, published), true, "the shop can check the delivered order with the published key");
  assert.equal(typeof heard.expires_at, "string", "an unsigned message still comes with the hub's expiry");
  assert.equal(gotTaxed.body.totals.shop_gets_cents, 21131, "$259.52 paid, $16.03 tax, $24.35 and $7.83 in fees: the shop gets $211.31");
  const wrong = JSON.parse(JSON.stringify(taxed));
  wrong.totals.shop_gets_cents = 25952 - 2435 - 783; // earnings that count the tax as the shop's
  refused(await send(M, placed(`shop:${idD}`, "o-tax2", { body: wrong })), 400, "totals_dont_add_up", "earnings that include the tax");
  console.log("  ok  shipping by the piece and the pick-up address pass through; a taxed order is delivered as signed and one that counts the tax as earnings is refused");

  // ----- files are cleaned up: expired ones leave the bucket, one the bucket won't delete stays listed -----
  const keyOf = (conv, h) => `sync/${sha256(conv).slice(0, 32)}/${h}`;
  const gone = keyOf("o-1", mh);
  assert.ok(bucket.store.has(gone));
  bucket.failDeletes.add(gone);
  await db.query(`UPDATE sync_files SET expires_at = now() - interval '1 minute' WHERE conversation = 'o-1' AND sha256 = $1`, [mh]);
  await sleep(2000);
  assert.ok(bucket.store.has(gone), "a delete that failed leaves the file");
  assert.equal((await db.query(`SELECT 1 FROM sync_files WHERE conversation = 'o-1' AND sha256 = $1`, [mh])).rowCount, 1, "and keeps it listed to try again");
  bucket.failDeletes.delete(gone);
  for (let i = 0; i < 20 && bucket.store.has(gone); i++) await sleep(300);
  assert.equal(bucket.store.has(gone), false, "next pass it is deleted");
  assert.equal((await db.query(`SELECT 1 FROM sync_files WHERE conversation = 'o-1' AND sha256 = $1`, [mh])).rowCount, 0);
  refused(await call("/v2/files/get", { ...M, json: { conversation: "o-1", sha256: mh } }), 404, "no_such_file", "an expired file can't be fetched");
  console.log("  ok  expired files leave the bucket; a failed delete is retried, not forgotten");

  // ----- nobody's customer details are anywhere in the hub's tables -----
  const all = JSON.stringify((await db.query(`SELECT body FROM sync_messages WHERE body IS NOT NULL`)).rows);
  assert.ok(!/pat@example\.com|555-0100/.test(all), "no email or phone stored");
  const rows = (await db.query(`SELECT * FROM sync_orders`)).rows;
  assert.ok(rows.every((r) => !JSON.stringify(r).includes("Pat Lee")), "the order table holds ids only");
  console.log("sync-orders: all ok");
} finally {
  hub.kill();
  await db.end();
  await bucket.close();
}
