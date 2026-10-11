// Checks that need hubs of their own, started here on a scratch database (no other hub may be running on it):
// - Partner storage: a member and the partner-only installs its codes brought on share one room on the hub
//   (PARTNER_MEMBER_STORED_MB, 1 MB here), so minting installs doesn't multiply what a member can store.
// - Room for pictures (MEDIA_QUOTA_*: 1 MB a company, 2 MB an install, about 4 MB for the hub here): note and listing
//   photos, figures and Help pictures counted together; a removed note or listing makes room; uploads at once all get
//   through on a database pool of two connections (DB_POOL).
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
      MEDIA_QUOTA_COMPANY_MB: "1",
      MEDIA_QUOTA_INSTALL_MB: "2",
      MEDIA_QUOTA_HUB_GB: "0.004", // 4,294,967 bytes
      DB_POOL: "2", // few connections: uploads at once mustn't wait for one another's
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

  // ----- room for pictures: per company (1 MB here), per install (2 MB), for the whole hub (about 4 MB) -----
  const Q1 = await register("Limits Pictures One");
  const Q2 = await register("Limits Pictures Two");
  const Q3 = await register("Limits Pictures Three");
  const jpeg = (size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(size - 4)]);
  const form = (key, p, field, json, files, fileField, headers = {}) => {
    const f = new FormData();
    f.set(field, JSON.stringify(json));
    for (const b of files) f.append(fileField, new Blob([b], { type: "image/jpeg" }), "p.jpg");
    return fetch(hub.url + p, { method: "POST", headers: { Authorization: `Bearer ${key}`, ...headers }, body: f });
  };
  let notes = 0;
  const note = (key, shopRef, photos) =>
    form(key, "/v1/posts", "post", { brand: "Janome", model: "MC6700", title: `Room ${++notes}`, body: "The hook timing, with photos.", shopRef, shopName: `Shop ${shopRef}` }, Array.from({ length: photos }, () => jpeg(300_000)), "photo");
  const listing = (key, shopRef, photos) => form(key, "/v1/listings", "listing", { title: `Hook ${shopRef}`, priceCents: 1000, shopRef, shopName: `Shop ${shopRef}` }, Array.from({ length: photos }, () => jpeg(300_000)), "photo");
  const figure = (key, shopRef, id, size) =>
    fetch(`${hub.url}/v1/figures/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "image/jpeg", "X-Shop-Ref": shopRef }, body: jpeg(size) });
  const help = (key, shopRef, text, size) => form(key, "/v1/feedback", "item", { kind: "help", text, context: { program: "StitchBench" } }, [jpeg(size)], "picture", { "X-Shop-Ref": shopRef });
  const tooFull = async (r, re, what) => {
    const body = await r.text();
    assert.equal(r.status, 507, `${what}: ${r.status} ${body}`);
    assert.match(JSON.parse(body).error, re, what);
  };
  const companyFull = /This shop's photos on the hub have reached 1 MB\. Remove old notes or listings to make room\./;
  const installFull = /all the shops in this program have reached 2 MB/;
  const hubFull = /The hub has no room for more photos right now/;
  // One company: three notes of 300 KB fit in its 1 MB; a fourth doesn't (nothing of it is kept); words alone still go.
  const kept = [];
  for (let i = 0; i < 3; i++) kept.push((await ok(await note(Q1, "a", 1))).id);
  await tooFull(await note(Q1, "a", 1), companyFull, "a fourth note's photo");
  await ok(await note(Q1, "a", 0));
  // Another company of the same install has its own 1 MB, but the install has 2 MB for all of them.
  for (let i = 0; i < 3; i++) await ok(await note(Q1, "b", 1));
  await tooFull(await listing(Q1, "c", 1), installFull, "a third company's listing photo over the install's room");
  // A removed note takes its photos with it: room again, for the company and the install.
  await ok(await call(hub, `/v1/posts/${kept[0]}`, { key: Q1, method: "DELETE", json: { shopRef: "a" } }));
  const listed = await ok(await listing(Q1, "c", 1));
  // Figures count too; a redraw replaces the old copy. 1.8 MB is kept now: a's 600 KB, b's 900 KB, c's 300 KB.
  await tooFull(await figure(Q1, "b", "f".repeat(24), 200_000), companyFull, "a figure over its company's room");
  await ok(await figure(Q1, "f", "e".repeat(24), 150_000));
  await ok(await figure(Q1, "f", "e".repeat(24), 150_000));
  await tooFull(await figure(Q1, "f", "d".repeat(24), 200_000), installFull, "another figure over the install's room");
  // A Help picture over the room: the item is kept without it (its words are what matter); within the room, with it.
  const noRoom = await ok(await help(Q1, "b", "no room for this picture", 200_000));
  const room = await ok(await help(Q1, "h", "room for this one", 100_000));
  const fb = (await ok(await call(hub, "/v1/admin/feedback?limit=500", { key: ADMIN }))).items;
  assert.deepEqual([fb.find((i) => i.id === noRoom.id).hasPicture, fb.find((i) => i.id === room.id).hasPicture], [false, true]);
  // The whole hub: another install takes it to 3.85 MB, a third to 4.15 MB; the next photo doesn't fit (4,294,967 bytes).
  const q2Notes = [];
  for (const ref of ["x", "x", "x", "y", "y", "y"]) q2Notes.push((await ok(await note(Q2, ref, 1))).id);
  await ok(await note(Q3, "w", 1));
  await tooFull(await note(Q3, "w", 1), hubFull, "a photo past the hub's room");
  await tooFull(await listing(Q3, "v", 1), hubFull, "a listing photo past the hub's room");
  const hubHelp = await ok(await help(Q3, "w", "the hub is full", 200_000));
  assert.equal((await ok(await call(hub, "/v1/admin/feedback?limit=500", { key: ADMIN }))).items.find((i) => i.id === hubHelp.id).hasPicture, false);
  await ok(await note(Q3, "w", 0));
  assert.equal((hub.log.match(/media: the hub's pictures \(4 MB\) have reached MEDIA_QUOTA_HUB_GB \(4 MB\)/g) ?? []).length, 1, "the log says so once in the hour");
  // The admin page shows the hub's pictures against its limit.
  let summary = await ok(await call(hub, "/v1/admin/summary", { key: ADMIN }));
  assert.deepEqual(summary.media, { usedBytes: 600_000 + 900_000 + 300_000 + 150_000 + 100_000 + 1_800_000 + 300_000, limitBytes: 4_294_967 });
  // Room made anywhere is room for everyone again: a note removed on one install, a listing on another.
  await ok(await call(hub, `/v1/posts/${q2Notes[0]}`, { key: Q2, method: "DELETE", json: { shopRef: "x" } }));
  await ok(await note(Q3, "w", 1));
  await tooFull(await note(Q3, "w", 1), hubFull, "full again");
  await ok(await call(hub, `/v1/listings/${listed.id}`, { key: Q1, method: "DELETE", json: { shopRef: "c" } }));
  await ok(await note(Q3, "w", 1));
  summary = await ok(await call(hub, "/v1/admin/summary", { key: ADMIN }));
  assert.equal(summary.media.usedBytes, 4_150_000 - 300_000 + 300_000 - 300_000 + 300_000);
  // Uploads at once, just after a removal (each reads the hub's total again on its own connection, more uploads than
  // the database pool has connections): all of them get through.
  await ok(await call(hub, `/v1/posts/${q2Notes[1]}`, { key: Q2, method: "DELETE", json: { shopRef: "x" } }));
  const small = (i) => form(Q1, "/v1/posts", "post", { brand: "Janome", model: "MC6700", title: `At once ${i}`, body: "A small photo.", shopRef: `s${i}` }, [jpeg(1000)], "photo");
  const atOnce = await Promise.race([Promise.all(Array.from({ length: 24 }, (_, i) => small(i))), new Promise((r) => setTimeout(() => r(null), 20_000).unref())]);
  if (!atOnce) hubs.forEach((h) => h.proc.kill("SIGKILL")); // a hub stuck on its connections wouldn't stop otherwise
  assert.ok(atOnce, "uploads at once never finished");
  for (const r of atOnce) await ok(r);
  assert.equal((await ok(await call(hub, "/v1/admin/summary", { key: ADMIN }))).media.usedBytes, 4_150_000 - 300_000 + 24 * 1000);
  console.log("room for pictures: ok (per company, per install and for the hub; removed photos make room)");

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
