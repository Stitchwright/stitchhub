// Checks that need hubs of their own, started here on a scratch database (no other hub may be running on it):
// - Partner storage: a member and the partner-only installs its codes brought on share one room on the hub
//   (PARTNER_MEMBER_STORED_MB, 1 MB here), so minting installs doesn't multiply what a member can store.
// - Wrong join keys: 20 an hour per address (joining and upgrading together), then 1,000 for the whole hub.
// - One writer: a second hub started on the same database (a deploy that overlaps the old one, a second replica)
//   answers /health and reads, refuses writes and feeds with 503 while the first runs, and takes over when it stops.
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/limits.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "limits-test-admin-token";
const JOIN = "join-limits-test";
const ROOT = path.resolve(import.meta.dirname, "..");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const hubs = [];
async function startHub() {
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: DB,
      ADMIN_TOKEN: ADMIN,
      JOIN_KEY: JOIN,
      PORT: String(port),
      LINK_CHECKER: "off",
      TRUST_PROXY: "true", // the limits per address see the test's addresses in X-Forwarded-For (none sent: 127.0.0.1)
      RAILWAY_ENVIRONMENT_ID: "",
      HUB_NAME: "Limits Test Hub",
      PARTNER_MEMBER_STORED_MB: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hub = { url: `http://127.0.0.1:${port}`, proc, log: "" };
  proc.stdout.on("data", (d) => (hub.log += d));
  proc.stderr.on("data", (d) => (hub.log += d));
  hubs.push(hub);
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hub.log}`);
    if (await fetch(`${hub.url}/health`).then((r) => r.ok, () => false)) return hub;
    if (i > 300) throw new Error(`the hub didn't start:\n${hub.log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopAll = () => hubs.forEach((h) => h.proc.exitCode === null && h.proc.kill());
process.on("exit", stopAll);

const call = (hub, p, { key, method, json, headers = {} } = {}) =>
  fetch(hub.url + p, {
    method: method ?? (json !== undefined ? "POST" : "GET"),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

try {
  const hub = await startHub();
  const register = async (name) => (await ok(await call(hub, "/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
  const memberKey = await register("Limits Member");
  assert.equal((await call(hub, "/v1/changes?since=0", { key: memberKey })).status, 200, "another hub is running on this database: stop it, or use a scratch database of its own");

  // ----- partner storage -----
  const otherKey = await register("Limits Other Member");
  const bringOn = async (inviterKey, shopRef, shopName) => {
    const { code } = await ok(await call(hub, "/v1/partners/invites", { key: inviterKey, json: { shopRef: "main", shopName: "Inviter", side: "repair" } }));
    return ok(await call(hub, "/v1/partners/join", { json: { code, shopRef, shopName } }));
  };
  const p1 = await bringOn(memberKey, "p1", "Brought On One");
  const p2 = await bringOn(memberKey, "p2", "Brought On Two");
  const p3 = await bringOn(otherKey, "p3", "Another Member's Partner");
  // About 440 KB a message, of data that doesn't compress (the room counts what is stored).
  let n = 0;
  const post = (key, linkId, shopRef, size = 330_000) =>
    call(hub, `/v1/partners/links/${linkId}/messages`, { key, json: { id: `m${++n}`, shopRef, type: "job.new", data: { photo: crypto.randomBytes(size).toString("base64") } } });
  assert.equal((await post(p1.installKey, p1.link.id, "p1")).status, 200);
  assert.equal((await post(p1.installKey, p1.link.id, "p1")).status, 200);
  const full = await post(p1.installKey, p1.link.id, "p1");
  assert.equal(full.status, 507, "one brought-on install stored more than the member's room");
  assert.match((await full.json()).error, /room they share/);
  // The room is the member's, shared: another install its codes brought on, and the member itself, find it full too.
  assert.equal((await post(p2.installKey, p2.link.id, "p2")).status, 507, "a second brought-on install had a room of its own");
  assert.equal((await post(memberKey, p2.link.id, "main")).status, 507, "the member had room beyond what its installs used");
  assert.equal((await post(p2.installKey, p2.link.id, "p2", 50_000)).status, 200, "what still fits goes through");
  // Another member's partners have a room of their own.
  assert.equal((await post(p3.installKey, p3.link.id, "p3")).status, 200);
  assert.equal((await post(otherKey, p3.link.id, "main")).status, 200);
  console.log("partner storage per member: ok");

  // ----- wrong join keys: per address first, then the hub's ceiling -----
  const from = (ip) => ({ "X-Forwarded-For": ip });
  const join = (ip, joinKey) => call(hub, "/v1/register", { json: { joinKey, name: "Limits Joiner" }, headers: from(ip) });
  const upgrade = (ip, key, joinKey) => call(hub, "/v1/upgrade", { key, json: { joinKey }, headers: from(ip) });
  // One address: 10 wrong keys joining (the tries an address gets there in an hour) and 10 upgrading a partner-only
  // install (as a pending install would); then even the right key from that address waits, and from another it works.
  for (let i = 0; i < 10; i++) assert.equal((await join("10.7.0.1", `wrong-${i}`)).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await upgrade("10.7.0.1", p1.installKey, `wrong-${i}`)).status, 403);
  const waits = await upgrade("10.7.0.1", p2.installKey, JOIN);
  assert.equal(waits.status, 429, "the 21st try from that address");
  assert.match((await waits.json()).error, /from this address/);
  assert.equal((await ok(await upgrade("10.7.0.2", p2.installKey, JOIN))).scope, "member", "the right key from another address");
  // Many addresses: more wrong keys than the hub-wide pause there used to be (100), and joining goes on; at 1,000 wrong
  // keys in the hour it pauses for everyone (a join key can be a phrase a person chose).
  const addr = (n) => `10.6.${n >> 8}.${n & 255}`;
  let wrong = 20;
  for (let a = 1; wrong < 120; a++, wrong += 10) {
    for (const r of await Promise.all(Array.from({ length: 10 }, (_, i) => join(addr(a), `guess-${a}-${i}`)))) assert.equal(r.status, 403);
  }
  await ok(await join("10.5.0.1", JOIN));
  for (let a = 1000; wrong < 1000; a++, wrong += 10) {
    for (const r of await Promise.all(Array.from({ length: 10 }, (_, i) => join(addr(a), `guess-${a}-${i}`)))) assert.equal(r.status, 403);
  }
  const pausedForAll = await join("10.5.0.2", JOIN);
  assert.equal(pausedForAll.status, 429, "1,000 wrong keys in the hour pause joining");
  assert.match((await pausedForAll.json()).error, /tried lately/);
  assert.match(hub.log, /1000 wrong join keys this hour/);
  console.log("wrong join keys: ok (20 an hour per address first, 1,000 for the hub)");

  // ----- one writer -----
  const second = await startHub();
  const refused = async (r, what) => {
    assert.equal(r.status, 503, `${what}: ${r.status}`);
    assert.match((await r.json()).error, /restarting/i);
  };
  assert.match(second.log, /waiting for it to stop/);
  await refused(await call(second, "/v1/changes?since=0", { key: memberKey }), "a feed from the second hub");
  await refused(await call(second, "/v1/orders?since=0", { key: memberKey }), "orders from the second hub");
  await refused(await call(second, "/v1/partners/messages?since=0", { key: p1.installKey }), "partner messages from the second hub");
  await refused(await call(second, "/v1/links", { key: memberKey, json: { brand: "Janome", models: "MC1", url: "https://example.com/limits-a.pdf" } }), "a write on the second hub");
  assert.equal((await call(second, "/v1/me", { key: memberKey })).status, 200, "reads on the second hub go on");
  assert.equal((await call(hub, "/v1/changes?since=0", { key: memberKey })).status, 200, "the first hub still serves");
  // The first stops (a deploy stopping the old process): the second takes over within a few seconds.
  const exited = new Promise((r) => hub.proc.once("exit", r));
  hub.proc.kill();
  await exited;
  for (let i = 0; ; i++) {
    const r = await call(second, "/v1/changes?since=0", { key: memberKey });
    if (r.status === 200) break;
    if (r.status !== 503 || i >= 100) throw new Error(`the second hub didn't take over: ${r.status} ${await r.text()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(second.log, /now serves the database/);
  await ok(await call(second, "/v1/links", { key: memberKey, json: { brand: "Janome", models: "MC1", url: "https://example.com/limits-b.pdf" } }));
  console.log("one writer: ok");

  for (const key of [memberKey, otherKey, p1.installKey, p2.installKey, p3.installKey]) {
    const { installId } = await ok(await call(second, "/v1/me", { key }));
    await ok(await call(second, `/v1/admin/installs/${installId}/block`, { key: ADMIN, json: { blocked: true } }));
  }
  console.log("all limit checks passed");
} catch (e) {
  console.error(e);
  for (const h of hubs) console.error(`--- hub log (${h.url}) ---\n${h.log}`);
  process.exitCode = 1;
} finally {
  stopAll();
}
