// Checks partner messages signed end to end on the hub's side: starts a hub of its own on a free port against a scratch
// database and walks two companies (each with an Ed25519 key, as the programs make them) through a signed invite and
// redeem, signed messages the hub verifies and marks, the refusals (a changed payload, a wrong key, a bad proof, an
// unsigned message once a key is on file, one side posting for the other) and a partnership made without keys (an older
// program: unsigned messages are stored unverified; the first valid signature puts a key on file).
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/partner-signing.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { fingerprint, inviteText, messageText, redeemText } from "../src/partnersign.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "signing-test-admin-token";
const JOIN = "join-signing-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Signing Test Hub" },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
hub.stdout.on("data", (d) => (hubLog += d));
hub.stderr.on("data", (d) => (hubLog += d));
const db = new pg.Pool({ connectionString: DB, max: 2 });
const stop = async () => {
  await db.end().catch(() => {});
  hub.kill();
};
process.on("exit", () => hub.kill());
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
  await new Promise((r) => setTimeout(r, 200));
}
await fetch(`${HUB}/v1/admin/join-key`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: JOIN }) }).then((r) => {
  if (!r.ok) throw new Error(`could not set the join key: ${r.status}`);
});

async function call(p, { key, method = "GET", json } = {}) {
  return fetch(HUB + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
}
const ok = async (pending) => {
  const r = await pending;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const refused = async (pending, want, what) => {
  const r = await pending;
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const register = async (name) => (await ok(call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;

// ----- a company's key, the way the programs make and use it -----
const newKey = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"), priv: privateKey };
};
const signText = (k, text) => crypto.sign(null, Buffer.from(text), k.priv).toString("base64");
let seqN = Date.now();
const signed = (k, linkId, fromSide, type, id, data, over = {}) => {
  const env = { seq: String(++seqN), ts: new Date().toISOString() };
  return { v: 1, pub: k.pub, ...env, sig: signText(k, messageText({ linkId, fromSide, type, id, data, ...env })), ...over };
};
const invite = (k, side, shopRef, shopName, terms = {}) => {
  const issuedAt = new Date().toISOString();
  return { shopRef, shopName, side, terms, publicKey: k.pub, proof: { issuedAt, sig: signText(k, inviteText({ pub: k.pub, side, shopRef, terms, issuedAt })) } };
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const redeem = (k, code, _side, shopRef, shopName) => {
  const issuedAt = new Date().toISOString();
  return { code, shopRef, shopName, publicKey: k.pub, proof: { issuedAt, sig: signText(k, redeemText({ codeHash: sha(code.replace(/-/g, "")), shopRef, issuedAt })) } };
};
const post = (key, link, body) => call(`/v1/partners/links/${link}/messages`, { key, json: body });
const feed = async (key) => (await ok(call("/v1/partners/messages?since=0&limit=500", { key }))).messages;

try {
  const keyR = await register(`Signing Repair ${RUN}`);
  const keyQ = await register(`Signing Quilts ${RUN}`);
  const R = newKey();
  const Q = newKey();
  const Z = newKey(); // somebody else's key

  // ----- the invite and the redeem carry keys, each proved -----
  const bad = invite(R, "repair", "r1", "Repair One");
  bad.proof.sig = signText(Z, "something else");
  await refused(call("/v1/partners/invites", { key: keyR, json: bad }), 400, "an invite whose signature isn't the key's");
  await refused(call("/v1/partners/invites", { key: keyR, json: { ...invite(R, "repair", "r1", "Repair One"), publicKey: "not a key" } }), 400, "a key that isn't one");
  const wrongSide = invite(R, "repair", "r1", "Repair One");
  await refused(call("/v1/partners/invites", { key: keyR, json: { ...wrongSide, side: "retail" } }), 400, "an invite signed for another side");
  const inv = await ok(call("/v1/partners/invites", { key: keyR, json: invite(R, "repair", "r1", "Repair One", { repairCommissionPct: 15 }) }));
  assert.equal(inv.fingerprint, fingerprint(R.pub), "the answer names the inviter's fingerprint");
  const wrongProof = redeem(Q, inv.code, "retail", "q1", "Quilts One");
  wrongProof.proof.sig = signText(Z, "x");
  await refused(call("/v1/partners/redeem", { key: keyQ, json: wrongProof }), 400, "a redeem whose proof isn't the key's");
  // (the invite is still usable: a refused redeem didn't use it)
  const red = await ok(call("/v1/partners/redeem", { key: keyQ, json: redeem(Q, inv.code, "retail", "q1", "Quilts One") }));
  const link = red.link.id;
  assert.equal(red.link.repair.publicKey, R.pub, "the redeemer is told the inviter's key");
  assert.equal(red.link.retail.publicKey, Q.pub, "and the link holds its own");
  assert.ok(red.link.repair.proof?.sig && red.link.retail.proof?.sig, "with the proofs");
  const created = (await feed(keyR)).find((m) => m.type === "link.created");
  assert.equal(created.data.retail.publicKey, Q.pub, "the inviter learns the redeemer's key in link.created");
  console.log("invite and redeem: ok");

  // ----- signed messages are verified, stored with their signature, and passed on -----
  const d1 = { id: "job1", brand: "Bernina" };
  await ok(post(keyQ, link, { id: "m1", shopRef: "q1", type: "job.new", data: d1, sig: signed(Q, link, "retail", "job.new", "m1", d1) }));
  const row = (await db.query(`SELECT verified, sig FROM partner_messages WHERE link_id = $1 AND id = 'm1'`, [link])).rows[0];
  assert.equal(row.verified, true);
  assert.equal(row.sig.pub, Q.pub);
  const got = (await feed(keyR)).find((m) => m.id === "m1");
  assert.equal(got.sig.sig, row.sig.sig, "the receiving program gets the signature to check itself");
  // key order in the data doesn't matter (jsonb reorders)
  const d2 = { z: 1, a: { y: [1, 2], b: "x" } };
  await ok(post(keyQ, link, { id: "m2", shopRef: "q1", type: "job.reply", data: { a: { b: "x", y: [1, 2] }, z: 1 }, sig: signed(Q, link, "retail", "job.reply", "m2", d2) }));
  console.log("signed messages: ok");

  // ----- the refusals -----
  const d3 = { id: "job3" };
  await refused(post(keyQ, link, { id: "m3", shopRef: "q1", type: "job.new", data: { id: "job3-changed" }, sig: signed(Q, link, "retail", "job.new", "m3", d3) }), 400, "a changed payload");
  await refused(post(keyQ, link, { id: "m4", shopRef: "q1", type: "job.cancel", data: d3, sig: signed(Q, link, "retail", "job.new", "m4", d3) }), 400, "a changed type");
  await refused(post(keyQ, link, { id: "m5", shopRef: "q1", type: "job.new", data: d3, sig: signed(Q, link, "retail", "job.new", "m5-other", d3) }), 400, "a changed id (a replay under a new id)");
  await refused(post(keyQ, link, { id: "m6", shopRef: "q1", type: "job.new", data: d3, sig: signed(Z, link, "retail", "job.new", "m6", d3) }), 400, "a key the partnership doesn't know for this shop");
  await refused(post(keyQ, link, { id: "m7", shopRef: "q1", type: "job.new", data: d3 }), 400, "unsigned once a key is on file");
  await refused(post(keyQ, link, { id: "m8", shopRef: "q1", type: "job.new", data: d3, sig: signed(R, link, "retail", "job.new", "m8", d3) }), 400, "the other company's key can't sign for this one");
  // R signs as retail (a forged side) but posts as itself: the hub takes the side from who posts
  await refused(post(keyR, link, { id: "m9", shopRef: "r1", type: "job.update", data: d3, sig: signed(R, link, "retail", "job.update", "m9", d3) }), 400, "signed as the other side");
  await refused(post(keyR, link, { id: "m10", shopRef: "r1", type: "job.update", data: d3, sig: signed(Q, link, "repair", "job.update", "m10", d3) }), 400, "signed with the partner's key");
  await refused(post(keyQ, link, { id: "m11", shopRef: "q1", type: "job.new", data: d3, sig: { v: 1, pub: Q.pub, seq: "x", ts: "now", sig: "y" } }), 400, "a malformed signature");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM partner_messages WHERE link_id = $1 AND from_side <> 'hub'`, [link])).rows[0].n, 2, "none of those was stored");
  // R's messages are verified too, and a message of the right link can't be signed for another link
  const d4 = { id: "job1", status: "ON_BENCH" };
  await ok(post(keyR, link, { id: "u1", shopRef: "r1", type: "job.update", data: d4, sig: signed(R, link, "repair", "job.update", "u1", d4) }));
  await refused(post(keyR, link, { id: "u2", shopRef: "r1", type: "job.update", data: d4, sig: signed(R, "another-link", "repair", "job.update", "u2", d4) }), 400, "signed for another link");
  console.log("refusals: ok");

  // ----- a partnership made without keys (an older program): stored unverified; the first valid signature pins a key -----
  const keyO = await register(`Signing Old ${RUN}`);
  const oldInv = await ok(call("/v1/partners/invites", { key: keyO, json: { shopRef: "o1", shopName: "Old Repair", side: "repair" } }));
  assert.equal(oldInv.fingerprint, null);
  const oldRed = await ok(call("/v1/partners/redeem", { key: keyQ, json: { code: oldInv.code, shopRef: "q2", shopName: "Quilts Two" } }));
  const oldLink = oldRed.link.id;
  assert.equal(oldRed.link.repair.publicKey, null);
  await ok(post(keyQ, oldLink, { id: "o1", shopRef: "q2", type: "job.new", data: { id: "j" } }));
  assert.equal((await db.query(`SELECT verified FROM partner_messages WHERE link_id = $1 AND id = 'o1'`, [oldLink])).rows[0].verified, false, "unsigned: stored, not verified");
  await ok(post(keyO, oldLink, { id: "o2", shopRef: "o1", type: "job.update", data: { id: "j" } }));
  const Q2 = newKey();
  const d5 = { id: "j2" };
  await ok(post(keyQ, oldLink, { id: "o3", shopRef: "q2", type: "job.new", data: d5, sig: signed(Q2, oldLink, "retail", "job.new", "o3", d5) }));
  const pinned = (await db.query(`SELECT retail_key, repair_key FROM partner_links WHERE id = $1`, [oldLink])).rows[0];
  assert.equal(pinned.retail_key, Q2.pub, "the first valid signature puts the sender's key on file");
  assert.equal(pinned.repair_key, null, "the other side stays as it was");
  await refused(post(keyQ, oldLink, { id: "o4", shopRef: "q2", type: "job.new", data: { id: "j3" } }), 400, "unsigned after that");
  await refused(post(keyQ, oldLink, { id: "o5", shopRef: "q2", type: "job.new", data: d5, sig: signed(Q, oldLink, "retail", "job.new", "o5", d5) }), 400, "another key after that");
  // a new code for the same pair is how a company's new key is trusted
  const reInv = await ok(call("/v1/partners/invites", { key: keyO, json: invite(R, "repair", "o1", "Old Repair") }));
  const reRed = await ok(call("/v1/partners/redeem", { key: keyQ, json: redeem(Q, reInv.code, "retail", "q2", "Quilts Two") }));
  assert.equal(reRed.link.id, oldLink, "the same pair keeps its link");
  assert.deepEqual([reRed.link.repair.publicKey, reRed.link.retail.publicKey], [R.pub, Q.pub], "with the new keys");
  await ok(post(keyQ, oldLink, { id: "o6", shopRef: "q2", type: "job.new", data: d5, sig: signed(Q, oldLink, "retail", "job.new", "o6", d5) }));
  console.log("older program and a new code: ok");

  // ----- the export carries the new columns -----
  const exp = await call("/v1/admin/export", { key: ADMIN });
  assert.equal(exp.status, 200);
  const text = zlib.gunzipSync(Buffer.from(await exp.arrayBuffer())).toString("utf8");
  assert.ok(text.includes('"verified":true') && text.includes(R.pub), "export has signatures, verified and keys");
  // A hub moved whole: import the export into a second, empty hub (a database of its own beside this one) and the keys,
  // proofs, signatures and verified marks arrive as they were.
  const base = new URL(DB);
  const other = `${base.pathname.slice(1)}_import`;
  const adminDb = new pg.Client({ connectionString: Object.assign(new URL(DB), { pathname: "/postgres" }).toString() });
  await adminDb.connect();
  await adminDb.query(`DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`);
  await adminDb.query(`CREATE DATABASE "${other}"`);
  const port2 = await freePort();
  const hub2 = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: Object.assign(new URL(DB), { pathname: `/${other}` }).toString(), ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port2), LINK_CHECKER: "off", PROGRAM_FREE: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`http://127.0.0.1:${port2}/health`).then((r) => r.ok, () => false)) break;
      if (i > 300) throw new Error("the second hub didn't start");
      await new Promise((r) => setTimeout(r, 200));
    }
    const exp2 = await call("/v1/admin/export", { key: ADMIN });
    const into = await fetch(`http://127.0.0.1:${port2}/v1/admin/import`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, Connection: "close" }, body: Buffer.from(await exp2.arrayBuffer()) });
    assert.equal(into.status, 200, await into.text());
    const db2 = new pg.Pool({ connectionString: Object.assign(new URL(DB), { pathname: `/${other}` }).toString(), max: 1 });
    const shape = async (pool) => ({
      links: (await pool.query(`SELECT id, repair_key, retail_key, repair_proof, retail_proof FROM partner_links ORDER BY id`)).rows,
      messages: (await pool.query(`SELECT link_id, from_side, id, verified, sig FROM partner_messages ORDER BY link_id, from_side, id`)).rows,
      invites: (await pool.query(`SELECT code_hash, pub_key, invite_sig FROM partner_invites ORDER BY code_hash`)).rows,
    });
    assert.deepEqual(await shape(db2), await shape(db), "keys, proofs, signatures and verified marks survive moving the hub");
    await db2.end();
  } finally {
    hub2.kill();
    await new Promise((r) => setTimeout(r, 500));
    await adminDb.query(`DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`).catch(() => {});
    await adminDb.end();
  }
  console.log("export and import: ok");
  console.log("partner signing: all ok");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
