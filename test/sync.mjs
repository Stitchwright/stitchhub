// Checks hub sync v2 (src/sync.mjs, docs/hub-sync-design.md): a hub of its own on a free port against a scratch database.
// Covers: the handshake (public hello, minimum version and 426, the missing X-Client, Deprecation headers); service keys (issued
// once, hashed, scopes, revoked, a public key); shops opting in (not listed and refused until they do, per-shop caps); sending
// (dedupe by id, an id reused for another message, wrong direction, replay window, size, unknown type and version); receiving (the
// same message offered again until acked, the cursor, acks, the sender's status); ordering per conversation (out-of-order sends,
// conversations independent); capabilities (a message the recipient can't read is held and released by its next hello); expiry
// (message.expired back to the sender, the reason, the body erased, the longest life clamped); queue overflow (new refused, old
// kept) and the per-minute cap; a shop back after 3 days offline; retention (the body erased 30 days after the ack, the stub kept
// then deleted after a year); and the admin summary.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/sync.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { signEnvelope } from "../src/sync-orders.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "sync-test-admin-token";
const JOIN = "join-sync-test";
const ROOT = path.resolve(import.meta.dirname, "..");
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Sync Test Hub", TRUST_PROXY: "true",
    SYNC_QUEUE_MESSAGES: "6", SYNC_SWEEP_MS: "700", SYNC_BODY_KB: "2",
    SYNC_MIN_CLIENT: JSON.stringify({ stitchshop: "1.8.0" }), SYNC_DEPRECATED: JSON.stringify({ "/v2/hello": "2027-06-01" }), SYNC_UPDATE_URL: "https://stitchbench.app/download/",
  },
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
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : {} };
}
const expect = (r, status, what) => {
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const reg = async (name) => expect(await call("/v1/register", { json: { joinKey: JOIN, name } }), 200, "register");
const claim = async (key, ref, name) => expect(await call("/v1/shops/claim", { key, json: { shopRef: ref, shopName: name, kind: "retail", program: "StitchShop", version: "1.8.0", sole: false } }), 200, "claim");
const adminCall = (p, o = {}) => call(`/v1/admin${p}`, { key: ADMIN, ...o });
const uuid = () => crypto.randomUUID();
const SHOP = (key, ref) => ({ key, headers: { "X-Shop-Ref": ref, "X-Client": "stitchshop/1.8.0" } });
const SVC = (key) => ({ key, headers: { "X-Client": "makerfoundry/0.1.0" } });
const shopHello = (s, types = { "order.placed": [1], "order.status": [1], "proof.sent": [1], "order.cancel": [1], "message.expired": [1] }) => call("/v2/hello", { ...s, json: { app: "stitchshop", version: "1.8.0", types } });
const svcHello = (s) => call("/v2/hello", { ...s, json: { app: "makerfoundry", version: "0.1.0", types: { "message.expired": [1], "order.status": [1], "proof.sent": [1], "order.cancel": [1], catalog: [1] } } });
const env = (to, o = {}) => ({ id: uuid(), type: "order.placed", version: 1, conversation: "mf-1", seq: 1, to, created_at: new Date().toISOString(), body: ORDER_BODY(), ...o });
// order.placed is checked and has to be signed (#34): the bodies here are the shared valid fixture, signed with the key registered below,
// and the art it names is put in the file table directly (test/sync-orders.mjs goes through the real upload).
const ART_HASH = "a".repeat(64);
const ORDER_BODY = () => {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/sync-orders/order.placed.v1.valid.json"), "utf8"));
  delete b.preview;
  return b;
};
const SIGN = { kp: null, key: null };
const send = async (s, e) => {
  if (e.type === "order.placed" && SIGN.kp && s.key === SIGN.key && !e.sig && String(e.to).startsWith("shop:")) {
    await db.query(
      `INSERT INTO sync_files (conversation, sha256, uploader, audience, kind, size, state, expires_at) VALUES ($1, $2, 'service:makerfoundry', $3, 'art', 48210, 'ready', now() + interval '1 day')
       ON CONFLICT (conversation, sha256) DO UPDATE SET audience = EXCLUDED.audience`,
      [e.conversation, ART_HASH, e.to],
    );
    e = { ...e, sig: signEnvelope({ ...e, from: "service:makerfoundry" }, SIGN.kp.privateKey) };
  }
  return call("/v2/messages", { ...s, json: e });
};
const get = (s, q = "") => call(`/v2/messages${q}`, s);
const ack = (s, ids) => call("/v2/messages/ack", { ...s, json: { ids } });
const status = async (s, ids) => (await call(`/v2/messages/status?ids=${ids.join(",")}`, s)).body.messages;
const stateOf = async (s, id) => (await status(s, [id]))[0]?.state;

try {
  const X = await reg("Install X");
  const Y = await reg("Install Y");
  await claim(X.installKey, "a1", "Shop A");
  await claim(X.installKey, "a2", "Shop C");
  await claim(Y.installKey, "b1", "Shop B");
  const shopId = async (ref, inst) => (await db.query(`SELECT id FROM shops WHERE shop_ref = $1 AND install_id = $2`, [ref, inst])).rows[0].id;
  const [idA, idC, idB] = [await shopId("a1", X.installId), await shopId("a2", X.installId), await shopId("b1", Y.installId)];
  const A = SHOP(X.installKey, "a1");
  const C = SHOP(X.installKey, "a2");
  const B = SHOP(Y.installKey, "b1");

  // ----- the handshake and versions -----
  const h = expect(await call("/v2/hello"), 200, "public hello");
  assert.equal(h.hub, "2.0.0");
  assert.deepEqual(h.min_client, { stitchshop: "1.8.0" });
  assert.deepEqual(h.types["order.placed"], [1]);
  assert.ok(h.limits.body_bytes === 2048 && h.limits.queue_messages === 6);
  assert.equal((await call("/v2/hello")).headers.get("deprecation"), "true", "a deprecated route says so");
  assert.ok((await call("/v2/hello")).headers.get("sunset")?.includes("2027"), "and when it ends");
  const old = await call("/v2/hello", { headers: { "X-Client": "stitchshop/1.7.9" } });
  assert.equal(old.status, 426);
  assert.equal(old.body.code, "upgrade_required");
  assert.equal(old.body.min, "1.8.0");
  assert.ok(old.body.update_url.includes("stitchbench.app"));
  const oldCall = await send({ key: X.installKey, headers: { "X-Shop-Ref": "a1", "X-Client": "stitchshop/1.7.9" } }, env(`service:nobody`));
  assert.equal(oldCall.status, 426, "a program below the minimum is turned away from every call");
  assert.equal((await send({ key: X.installKey, headers: { "X-Shop-Ref": "a1" } }, env(`service:nobody`))).status, 400, "no X-Client: asked for");
  assert.equal((await call("/v2/hello", { key: X.installKey, json: { app: "stitchshop", version: "1.7.0", types: {} } })).status, 426, "a hello that says an old version is refused too");
  assert.equal((await send({ key: "nope", headers: { "X-Client": "stitchshop/1.8.0" } }, env("service:x"))).status, 401);
  console.log("  ok  the handshake: public hello, the minimum version (426 with the update address), X-Client, Deprecation and Sunset");

  // ----- service keys -----
  const made = expect(await adminCall("/service-keys", { json: { name: "makerfoundry" } }), 200, "issue key");
  assert.match(made.key, /^svk_[0-9a-f]{64}$/);
  assert.deepEqual(made.scopes.sort(), ["orders:send", "shops:list"]);
  const listed = expect(await adminCall("/service-keys"), 200, "list keys");
  assert.ok(!JSON.stringify(listed).includes(made.key) && !JSON.stringify(listed).includes("key_hash"), "the key is shown once and never listed");
  assert.equal((await db.query(`SELECT key_hash FROM service_keys WHERE id = $1`, [made.id])).rows[0].key_hash, crypto.createHash("sha256").update(made.key).digest("hex"), "only a hash is kept");
  assert.equal((await adminCall("/service-keys", { json: { name: "makerfoundry" } })).status, 409);
  assert.equal((await adminCall("/service-keys", { json: { name: "Bad Name" } })).status, 400);
  assert.equal((await call("/v1/admin/service-keys", { key: "wrong", json: { name: "zzz" } })).status, 401, "admin only");
  const MF = SVC(made.key);
  const limited = expect(await adminCall("/service-keys", { json: { name: "lister", scopes: ["shops:list"] } }), 200, "scoped key");
  assert.equal((await send(SVC(limited.key), env(`shop:${idA}`))).status, 403, "a key without orders:send can't send");
  const kp = crypto.generateKeyPairSync("ed25519");
  assert.equal((await adminCall(`/service-keys/${made.id}/public-key`, { method: "PUT", json: { publicKey: "garbage" } })).status, 400);
  expect(await adminCall(`/service-keys/${made.id}/public-key`, { method: "PUT", json: { publicKey: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") } }), 200, "public key");
  SIGN.kp = kp;
  SIGN.key = made.key;
  expect(await adminCall(`/service-keys/${limited.id}`, { method: "DELETE" }), 200, "revoke");
  assert.equal((await call("/v2/shops", SVC(limited.key))).status, 401, "a revoked key stops working");
  expect(await call("/v2/shops", MF), 200, "use the key once");
  for (let i = 0; i < 20 && !(await db.query(`SELECT last_used_at FROM service_keys WHERE id = $1`, [made.id])).rows[0].last_used_at; i++) await sleep(100);
  assert.ok((await db.query(`SELECT last_used_at FROM service_keys WHERE id = $1`, [made.id])).rows[0].last_used_at, "its last use is noted");
  console.log("  ok  service keys: issued once, hashed, scoped, revoked, a public key (Ed25519 only)");

  // ----- shops opt in -----
  assert.deepEqual(expect(await call("/v2/shops", MF), 200, "shops").shops, [], "nobody is listed until they opt in");
  assert.equal((await send(MF, env(`shop:${idA}`))).body.code, "not_opted_in", "orders to a shop that hasn't opted in are refused");
  assert.equal((await call("/v2/optin", { ...A, method: "PUT", json: { service: "nobody" } })).status, 404, "an unknown service");
  expect(await call("/v2/optin", { ...A, method: "PUT", json: { service: "makerfoundry" } }), 200, "opt in");
  expect(await call("/v2/optin", { ...B, method: "PUT", json: { service: "makerfoundry" } }), 200, "opt in B");
  expect(await call("/v2/optin", { ...C, method: "PUT", json: { service: "makerfoundry" } }), 200, "opt in C");
  const lst = expect(await call("/v2/shops", MF), 200, "shops").shops;
  assert.deepEqual(lst.map((s) => s.id).sort(), [`shop:${idA}`, `shop:${idB}`, `shop:${idC}`].sort());
  assert.ok(lst.every((s) => s.ready === false), "not ready until the shop's program has said hello");
  assert.equal(expect(await call("/v2/optin?service=makerfoundry", A), 200, "read optin").enabled, true);
  assert.equal((await call("/v2/shops", A)).status, 403, "a program can't list shops");
  console.log("  ok  opt-in: not listed and refused until a shop says so; per-shop caps; only a service lists");

  // ----- sending, holding for capabilities, receiving, acking -----
  expect(await svcHello(MF), 200, "service hello");
  const first = env(`shop:${idA}`, { conversation: "mf-A" });
  const r1 = expect(await send(MF, first), 202, "send");
  assert.equal(r1.state, "held_capability", "the shop has never said hello: held");
  assert.equal(await stateOf(MF, first.id), "held_capability", "and the sender can see it");
  assert.equal((await get(A)).status, 409, "a shop must say hello before it asks for messages");
  const hi = expect(await shopHello(A), 200, "shop hello");
  assert.equal(hi.released, 1, "the held message is released by the hello");
  assert.equal(lstReady(expect(await call("/v2/shops", MF), 200, "shops").shops, idA), true);
  function lstReady(shops, id) { return shops.find((s) => s.id === `shop:${id}`).ready; }
  const dup = expect(await send(MF, first), 202, "send again");
  assert.equal(dup.duplicate, true, "the same id twice is stored once");
  assert.equal((await send(MF, { ...first, body: { ...first.body, note: "a different order" } })).body.code, "id_reused", "an id used for a different message");
  const got = expect(await get(A), 200, "get");
  assert.equal(got.messages.length, 1);
  assert.deepEqual([got.messages[0].id, got.messages[0].from, got.messages[0].type, got.messages[0].conversation, got.messages[0].seq], [first.id, "service:makerfoundry", "order.placed", "mf-A", 1]);
  assert.equal(await stateOf(MF, first.id), "delivered", "the sender sees it was fetched");
  assert.equal(expect(await get(A), 200, "again").messages.length, 1, "not acked: offered again");
  assert.equal(expect(await get(A, `?after=${got.next}`), 200, "after the cursor").messages.length, 0, "the cursor skips what the program has");
  assert.equal(expect(await ack(A, [uuid()]), 200, "ack unknown").acked, 0);
  assert.equal(expect(await ack(A, [first.id]), 200, "ack").acked, 1);
  assert.equal(expect(await get(A), 200, "after ack").messages.length, 0);
  assert.equal(await stateOf(MF, first.id), "acked");
  assert.equal(expect(await ack(A, [first.id]), 200, "ack twice").acked, 0);
  const early = env(`shop:${idA}`, { conversation: "mf-early", seq: 1 });
  expect(await send(MF, early), 202, "send");
  assert.equal(expect(await ack(A, [early.id]), 200, "ack early").acked, 0, "a message can't be acknowledged before it was handed out");
  assert.equal(await stateOf(MF, early.id), "queued", "and it stays queued");
  const handed = expect(await get(A), 200, "get").messages;
  assert.deepEqual(handed.map((m) => m.id), [early.id]);
  assert.equal(expect(await ack(A, [early.id]), 200, "ack after").acked, 1);
  console.log("  ok  sending and receiving: held until hello, dedupe by id, offered again until acked, the cursor, the sender's status");

  // ----- ordering per conversation -----
  expect(await shopHello(B, { "order.placed": [1], "proof.answer": [1], "message.expired": [1] }), 200, "hello B");
  const order = [];
  const answer = (conversation, seq) => env(`shop:${idB}`, { type: "proof.answer", conversation, seq, body: { proof: 1, answer: "approved" } });
  expect(await send(MF, env(`shop:${idB}`, { conversation: "o-1", seq: 4 })), 202, "open the order");
  const sent = [answer("o-1", 3), answer("o-1", 1), answer("o-1", 2), env(`shop:${idB}`, { conversation: "o-2", seq: 1 })];
  for (const e of sent) expect(await send(MF, e), 202, "send");
  const seen = [];
  for (let i = 0; i < 5; i++) for (const m of expect(await get(B), 200, "get").messages) if (!seen.some((s) => s.id === m.id)) seen.push(m);
  const inConv = (c) => seen.filter((m) => m.conversation === c).map((m) => m.seq);
  assert.deepEqual(inConv("o-1"), [1, 2, 3, 4], "sent 4, 3, 1, 2: handed out 1, 2, 3, 4");
  assert.deepEqual(inConv("o-2"), [1], "another conversation isn't held up");
  assert.equal(seen[0].conversation === "o-1" && seen[0].seq === 1 || seen[0].conversation === "o-2", true, "seq 3 never comes before 1");
  expect(await ack(B, seen.map((m) => m.id)), 200, "ack all");
  order.push(...seen);
  assert.equal((await send(MF, answer("o-1", 2))).body.code, "seq_taken", "a seq already used in a conversation");
  console.log("  ok  ordering: out-of-order sends come out in seq order per conversation, conversations are independent");

  // ----- capabilities: a type the recipient can't read is held, then released -----
  const needsNew = env(`shop:${idA}`, { type: "proof.answer", conversation: "mf-A", seq: 2, body: { proof: 1, answer: "approved" } });
  expect(await send(MF, needsNew), 202, "send");
  assert.equal(await stateOf(MF, needsNew.id), "held_capability", "an old client doesn't get a type it never said it understands");
  assert.equal(expect(await get(A), 200, "get").messages.length, 0);
  assert.equal(expect(await shopHello(A, { "order.placed": [1], "proof.answer": [1], "message.expired": [1] }), 200, "new hello").released, 1);
  const newGot = expect(await get(A), 200, "get").messages;
  assert.deepEqual(newGot.map((m) => m.type), ["proof.answer"]);
  expect(await ack(A, [newGot[0].id]), 200, "ack");
  assert.equal((await send(MF, env(`shop:${idA}`, { type: "nonsense.type", conversation: "x", seq: 1 }))).body.code, "unknown_type");
  assert.equal((await send(MF, env(`shop:${idA}`, { version: 9, conversation: "x", seq: 1 }))).body.code, "unknown_version");
  console.log("  ok  capabilities: an old client holds a newer type until its next hello lists it; unknown type and version refused");

  // ----- who may send what, and the rules of an envelope -----
  assert.equal((await send(A, env(`shop:${idB}`, { type: "order.status", conversation: "z", seq: 1, body: { status: "received" } }))).status, 403, "shop to shop isn't open");
  assert.equal((await send(A, env("service:makerfoundry", { type: "order.placed", conversation: "z", seq: 1 }))).status, 403, "a shop can't send order.placed");
  assert.equal((await send(MF, env("service:makerfoundry", { conversation: "z", seq: 1 }))).status, 403, "a service to a service");
  assert.equal((await send(MF, env(`shop:${idA}`, { created_at: new Date(Date.now() - 3600_000).toISOString(), conversation: "old", seq: 1 }))).body.code, "bad_time", "a message an hour old is a replay");
  assert.equal((await send(MF, env(`shop:${idA}`, { id: "not-a-uuid", conversation: "i", seq: 1 }))).body.code, "bad_id");
  assert.equal((await send(MF, env(`shop:${idA}`, { body: { text: "x".repeat(3000) }, conversation: "big", seq: 1 }))).status, 413, "over the body limit");
  assert.equal((await send(MF, env(`shop:${idA}`, { from: "service:someone-else", conversation: "f", seq: 1 }))).body.code, "bad_from");
  assert.equal((await send(MF, env("shop:does-not-exist", { conversation: "g", seq: 1 }))).status, 404);
  const toService = env("service:makerfoundry", { type: "order.status", conversation: "mf-A", seq: 1, body: { status: "received" } });
  expect(await send(A, toService), 202, "shop to service");
  const svcGot = expect(await get(MF), 200, "service get").messages;
  assert.deepEqual(svcGot.map((m) => [m.type, m.from]), [["order.status", `shop:${idA}`]], "messages go both ways");
  expect(await ack(MF, [toService.id]), 200, "service ack");
  console.log("  ok  routing and envelope rules: direction, opt-in, replay window, id format, size, from, unknown recipient");

  // ----- expiry -----
  const soon = env(`shop:${idC}`, { conversation: "ex-1", seq: 1, expires_at: new Date(Date.now() + 1500).toISOString() });
  expect(await send(MF, soon), 202, "send soon-expiring");
  const farOff = env(`shop:${idC}`, { conversation: "ex-2", seq: 1, expires_at: new Date(Date.now() + 365 * 86400_000).toISOString() });
  expect(await send(MF, farOff), 202, "send far-off");
  const life = (await db.query(`SELECT expires_at - now() AS left FROM sync_messages WHERE id = $1`, [farOff.id])).rows[0].left;
  assert.ok(life.days <= 7, "the longest life is the type's (7 days for an order), whatever the sender asked");
  await shopHello(C);
  const heldType = env(`shop:${idC}`, { type: "proof.answer", conversation: "ex-2", seq: 2, expires_at: new Date(Date.now() + 1500).toISOString(), body: { proof: 1, answer: "approved" } });
  expect(await send(MF, heldType), 202, "send held");
  for (let i = 0; i < 40 && (await stateOf(MF, soon.id)) !== "expired"; i++) await sleep(250);
  assert.equal(await stateOf(MF, soon.id), "expired");
  assert.equal((await db.query(`SELECT body FROM sync_messages WHERE id = $1`, [soon.id])).rows[0].body, null, "the body is erased at once");
  assert.equal(expect(await get(C), 200, "get").messages.some((m) => m.id === soon.id), false, "an expired message isn't delivered");
  for (let i = 0; i < 40 && (await stateOf(MF, heldType.id)) !== "expired"; i++) await sleep(250);
  const notices = expect(await get(MF), 200, "service get").messages.filter((m) => m.type === "message.expired");
  const forSoon = notices.find((m) => m.body.id === soon.id);
  const forHeld = notices.find((m) => m.body.id === heldType.id);
  assert.ok(forSoon && forHeld, "the sender hears about both");
  assert.equal(forSoon.from, "hub");
  assert.deepEqual([forSoon.body.type, forSoon.body.conversation, forSoon.body.reason], ["order.placed", "ex-1", "expired"]);
  assert.equal(forHeld.body.reason, "recipient_too_old", "and why: the shop's program never learned that type");
  expect(await ack(MF, notices.map((m) => m.id)), 200, "ack notices");
  console.log("  ok  expiry: message.expired back to the sender with the reason, the body erased, the longest life clamped");

  // ----- overflow and the per-minute cap -----
  const queued = [];
  for (let i = 0; i < 6; i++) {
    const e = env(`shop:${idB}`, { conversation: `ov-${i}`, seq: 1 });
    expect(await send(MF, e), 202, "fill the queue");
    queued.push(e);
  }
  const over = await send(MF, env(`shop:${idB}`, { conversation: "ov-x", seq: 1 }));
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "recipient_queue_full", "a full queue refuses the new message");
  const kept = expect(await get(B), 200, "get").messages.filter((m) => m.conversation.startsWith("ov-"));
  assert.equal(kept.length, 6, "and drops nothing it already has");
  expect(await ack(B, kept.map((m) => m.id)), 200, "ack");
  expect(await send(MF, env(`shop:${idB}`, { conversation: "ov-y", seq: 1 })), 202, "room again after the acks");
  await claim(X.installKey, "a3", "Shop D");
  const idD = await shopId("a3", X.installId);
  const D = SHOP(X.installKey, "a3");
  expect(await call("/v2/optin", { ...D, method: "PUT", json: { service: "makerfoundry", perMinute: 2 } }), 200, "opt in D with a cap");
  await shopHello(D);
  for (const k of [1, 2]) expect(await send(MF, env(`shop:${idD}`, { conversation: `pm-${k}`, seq: 1 })), 202, "within the shop's per-minute cap");
  assert.equal((await send(MF, env(`shop:${idD}`, { conversation: "pm-3", seq: 1 }))).body.code, "rate_limit", "the shop's own cap (2 a minute)");
  console.log("  ok  overflow: a full queue refuses and keeps; the per-shop messages-a-minute cap");

  // ----- a shop back after 3 days offline -----
  await db.query(`DELETE FROM sync_deliveries WHERE recipient = $1`, [`shop:${idA}`]);
  const days3 = [1, 2, 3, 4, 5].map((n) => env(`shop:${idA}`, { conversation: `off-${n}`, seq: 1 }));
  for (const e of days3) expect(await send(MF, e), 202, "send while offline");
  const stale = env(`shop:${idA}`, { conversation: "off-stale", seq: 1 });
  expect(await send(MF, stale), 202, "send one that will have lapsed");
  await db.query(`UPDATE sync_messages SET stored_at = stored_at - interval '3 days', created_at = created_at - interval '3 days' WHERE id = ANY($1)`, [[...days3.map((e) => e.id), stale.id]]);
  await db.query(`UPDATE sync_messages SET expires_at = now() - interval '1 hour' WHERE id = $1`, [stale.id]);
  await db.query(`UPDATE sync_caps SET hello_at = hello_at - interval '3 days' WHERE principal = $1`, [`install:${X.installId}`]);
  await shopHello(A);
  for (let i = 0; i < 30 && (await stateOf(MF, stale.id)) !== "expired"; i++) await sleep(250);
  const back = expect(await get(A, "?limit=50"), 200, "get").messages.filter((m) => m.conversation.startsWith("off-"));
  assert.deepEqual(back.map((m) => m.conversation).sort(), days3.map((e) => e.conversation).sort(), "everything still good arrives, none of it lost; the lapsed one doesn't");
  expect(await ack(A, back.map((m) => m.id)), 200, "ack");
  assert.ok((await status(MF, days3.map((e) => e.id))).every((s) => s.state === "acked"));
  assert.equal(await stateOf(MF, stale.id), "expired", "and the sender is told about the one that lapsed");
  console.log("  ok  a shop back after 3 days offline gets everything still good, in order, and the sender hears about what lapsed");

  // ----- retention -----
  const keep = days3[0];
  await db.query(`UPDATE sync_deliveries SET acked_at = now() - interval '31 days' WHERE message_id = $1`, [keep.id]);
  const fresh = days3[1];
  for (let i = 0; i < 20 && (await db.query(`SELECT body FROM sync_messages WHERE id = $1`, [keep.id])).rows[0].body !== null; i++) await sleep(250);
  const stub = (await db.query(`SELECT * FROM sync_messages WHERE id = $1`, [keep.id])).rows[0];
  assert.equal(stub.body, null, "the body goes 30 days after the ack");
  assert.ok(stub.body_sha256 && stub.type === "order.placed" && stub.conversation && stub.body_bytes > 0, "the audit stub stays: ids, type, size, hash");
  assert.notEqual((await db.query(`SELECT body FROM sync_messages WHERE id = $1`, [fresh.id])).rows[0].body, null, "a message acked only just now keeps its body for its 30 days");
  await db.query(`UPDATE sync_messages SET stored_at = now() - interval '400 days' WHERE id = $1`, [keep.id]);
  for (let i = 0; i < 20 && (await db.query(`SELECT 1 FROM sync_messages WHERE id = $1`, [keep.id])).rowCount; i++) await sleep(250);
  assert.equal((await db.query(`SELECT 1 FROM sync_messages WHERE id = $1`, [keep.id])).rowCount, 0, "the stub is deleted after a year");
  console.log("  ok  retention: the body is erased 30 days after the ack, the stub stays, and goes after a year");

  // ----- the admin summary -----
  const sum = expect(await adminCall("/sync/summary"), 200, "summary");
  assert.ok(sum.states.acked > 0 && sum.states.expired > 0, JSON.stringify(sum));
  assert.ok(Array.isArray(sum.queues));
  console.log("  ok  the admin summary shows the queue by state and by recipient");
  console.log("sync: all ok");
} finally {
  hub.kill();
  await db.end();
}
