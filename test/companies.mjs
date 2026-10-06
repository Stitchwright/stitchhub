// Checks that every record a company makes carries the company and shows the company's name, not the install's:
// starts a hub of its own on a free port against a scratch database and walks a hosted install that holds two
// companies (plus one that names none) through listings, orders, ratings, notes, links, parts, usage and figures.
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/companies.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "companies-test-admin-token";
const JOIN = "join-companies-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;

// ----- the hub under test -----
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATABASE_URL: DB,
    ADMIN_TOKEN: ADMIN,
    JOIN_KEY: JOIN,
    PORT: String(port),
    LINK_CHECKER: "off",
    TRUST_PROXY: "",
    RAILWAY_ENVIRONMENT_ID: "",
    USAGE_MIN_SHOPS: "1", // one install with two companies is two shops
    HUB_NAME: "Companies Test Hub",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
hub.stdout.on("data", (d) => (hubLog += d));
hub.stderr.on("data", (d) => (hubLog += d));
const db = new pg.Pool({ connectionString: DB, max: 2 });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
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
// A scratch database that was used before keeps the join key the admin page saved then (it wins over JOIN_KEY), so set ours.
await fetch(`${HUB}/v1/admin/join-key`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: JOIN }) }).then((r) => { if (!r.ok) throw new Error(`could not set the join key: ${r.status}`); });

// ----- helpers -----
async function call(p, { key, method = "GET", json, body, headers = {} } = {}) {
  return fetch(HUB + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
}
const ok = async (pending) => {
  const r = await pending;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const get = (p, key, headers) => ok(call(p, { key, headers }));
const send = (p, key, json, method = "POST", headers) => ok(call(p, { key, method, json, headers }));
const register = async (name) => ok(await call("/v1/register", { json: { joinKey: JOIN, name } }));
const form = (field, json) => {
  const f = new FormData();
  f.set(field, JSON.stringify(json));
  return f;
};
const listing = (key, json) => ok(call("/v1/listings", { key, method: "POST", body: form("listing", json) }));
const post = (key, json) => ok(call("/v1/posts", { key, method: "POST", body: form("post", json) }));
const changes = async (key) => get("/v1/changes?since=0&limit=2000", key);
const ship = { shipTo: "1 Test Road, Testville TS 00000", buyerContact: { name: "Buyer", email: "buyer@example.com" } };
const ym = () => new Date().toISOString().slice(0, 7);

try {
  // A hosted install holds companies A and B (and an older program on it names none); another install buys.
  const X = await register(`Hosted Install ${RUN}`);
  const Y = await register(`Buyer Install ${RUN}`);
  const A = { shopRef: "a", shopName: "A Company" };
  const B = { shopRef: "b", shopName: "B Company" };

  // ----- listings: a company's name, the install's when none is named, two companies kept apart -----
  const la = await listing(X.installKey, { title: `A's foot ${RUN}`, priceCents: 1000, qty: 3, shippingCents: 0, ...A });
  assert.deepEqual([la.shopName, la.shopRef, la.shopId, la.sellerId, la.mine], ["A Company", "a", null, X.installId, true]);
  const lb = await listing(X.installKey, { title: `B's bobbin ${RUN}`, priceCents: 500, qty: 2, shippingCents: 0, ...B });
  assert.deepEqual([lb.shopName, lb.shopRef], ["B Company", "b"]);
  const lp = await listing(X.installKey, { title: `Plain belt ${RUN}`, priceCents: 300, qty: 1, shippingCents: 0 });
  assert.deepEqual([lp.shopName, lp.shopRef, lp.shopId], [`Hosted Install ${RUN}`, null, null]);
  const seen = (await changes(Y.installKey)).listings;
  assert.deepEqual(
    [la.id, lb.id, lp.id].map((id) => seen.find((l) => l.id === id)).map((l) => [l.shopName, l.shopRef, l.mine]),
    [["A Company", "a", false], ["B Company", "b", false], [`Hosted Install ${RUN}`, null, false]],
  );
  console.log("listings: ok");

  // ----- the shops table: once A claims itself, its rows show its current name and its hub shop id -----
  const claim = await send("/v1/shops/claim", X.installKey, { shopRef: "a", shopName: "A Company Renamed", kind: "repair", program: "StitchBench", version: "1.7.0", sole: false });
  assert.equal(claim.listings, 0, "a claim on an install with several companies hands over nothing");
  const after = (await changes(Y.installKey)).listings;
  assert.deepEqual([after.find((l) => l.id === la.id).shopName, after.find((l) => l.id === la.id).shopId], ["A Company Renamed", claim.shop.id]);
  assert.deepEqual([after.find((l) => l.id === lb.id).shopName, after.find((l) => l.id === lb.id).shopId], ["B Company", null]);
  assert.equal(after.find((l) => l.id === lp.id).shopName, `Hosted Install ${RUN}`);
  console.log("shops join: ok");

  // ----- one company can't change another's listing with the same install key (when it says which company it is) -----
  await status(await call(`/v1/listings/${la.id}`, { key: X.installKey, method: "PUT", json: { title: "taken", shopRef: "b" } }), 403, "B edits A's listing (body)");
  await status(await call(`/v1/listings/${la.id}`, { key: X.installKey, method: "PUT", json: { title: "taken" }, headers: { "X-Shop-Ref": "b" } }), 403, "B edits A's listing (header)");
  await status(await call(`/v1/listings/${lb.id}`, { key: X.installKey, method: "DELETE", headers: { "X-Shop-Ref": "a" } }), 403, "A removes B's listing");
  await status(await call(`/v1/listings/${la.id}`, { key: Y.installKey, method: "PUT", json: { title: "taken", shopRef: "a" } }), 403, "another install, even naming the company");
  const edited = await send(`/v1/listings/${la.id}`, X.installKey, { title: `A's foot ${RUN} (edited)`, shopRef: "a" }, "PUT");
  assert.equal(edited.title, `A's foot ${RUN} (edited)`);
  // An older program names no company: the install key rules, as before.
  const old = await send(`/v1/listings/${la.id}`, X.installKey, { description: "by the install" }, "PUT");
  assert.equal(old.description, "by the install");
  // A row that names no company is the install's: any company on it may change it.
  await send(`/v1/listings/${lp.id}`, X.installKey, { description: "plain, edited by A" }, "PUT", { "X-Shop-Ref": "a" });
  console.log("listing ownership: ok");

  // ----- orders: each side under its company's name; steps and ratings keyed to the company -----
  await status(await call("/v1/orders", { key: X.installKey, json: { listingId: lb.id, qty: 1, ...A, ...ship } }), 409, "two companies on one install can't trade");
  const o = await send("/v1/orders", Y.installKey, { listingId: la.id, qty: 1, shopRef: "y1", shopName: "Y Buyer Co", ...ship });
  assert.deepEqual(
    [o.sellerShop, o.sellerShopRef, o.sellerShopId, o.buyerShop, o.buyerShopRef, o.buyerShopId, o.role],
    ["A Company Renamed", "a", claim.shop.id, "Y Buyer Co", "y1", null, "buyer"],
  );
  await status(await call(`/v1/orders/${o.id}/accept`, { key: X.installKey, json: { shopRef: "b", shippingCents: 0 } }), 403, "B accepts A's order");
  await status(await call(`/v1/orders/${o.id}/accept`, { key: X.installKey, json: { shippingCents: 0 }, headers: { "X-Shop-Ref": "b" } }), 403, "B accepts A's order (header)");
  const accepted = await send(`/v1/orders/${o.id}/accept`, X.installKey, { shopRef: "a", shippingCents: 0, payInstructions: "PayPal a@example.com" });
  assert.equal(accepted.status, "ACCEPTED");
  await status(await call(`/v1/orders/${o.id}/buyer-paid`, { key: Y.installKey, json: { shopRef: "y2" } }), 403, "another company on the buyer's install");
  assert.equal((await send(`/v1/orders/${o.id}/buyer-paid`, Y.installKey, {})).buyerPaidNote, "payment sent"); // an older program: no company named
  assert.equal((await send(`/v1/orders/${o.id}/paid`, X.installKey, {}, "POST", { "X-Shop-Ref": "a" })).status, "PAID");
  await status(await call(`/v1/orders/${o.id}/rate`, { key: Y.installKey, json: { stars: 5, shopRef: "y2" } }), 403, "another company rates");
  const rated = await send(`/v1/orders/${o.id}/rate`, Y.installKey, { stars: 5, comment: "quick", shopRef: "y1" });
  assert.deepEqual(rated.sellerReputation, { avg: 5, count: 1 });
  const sellerView = (await get("/v1/orders?since=0", X.installKey)).orders.find((x) => x.id === o.id);
  assert.deepEqual([sellerView.role, sellerView.sellerShop, sellerView.buyerShop], ["seller", "A Company Renamed", "Y Buyer Co"]);
  // The rating is A's, not the install's and not B's.
  const repA = await get(`/v1/reputation/${X.installId}?shopRef=a`, Y.installKey);
  assert.deepEqual([repA.shopName, repA.shopId, repA.shopRef, repA.asSeller], ["A Company Renamed", claim.shop.id, "a", { avg: 5, count: 1 }]);
  const repB = await get(`/v1/reputation/${X.installId}?shopRef=b`, Y.installKey);
  assert.deepEqual([repB.shopName, repB.shopId, repB.asSeller], ["B Company", null, { avg: null, count: 0 }]);
  const repX = await get(`/v1/reputation/${X.installId}`, Y.installKey);
  assert.deepEqual([repX.shopName, repX.shopRef, repX.asSeller], [`Hosted Install ${RUN}`, null, { avg: null, count: 0 }]);
  const now = (await changes(Y.installKey)).listings;
  assert.deepEqual([now.find((l) => l.id === la.id).sellerRating, now.find((l) => l.id === lb.id).sellerRating, now.find((l) => l.id === lp.id).sellerRating], [{ avg: 5, count: 1 }, { avg: null, count: 0 }, { avg: null, count: 0 }]);
  console.log("orders and ratings: ok");

  // ----- notes: the company's name (current, once claimed), the install's when none is named; removal per company -----
  const note = { brand: "Brother", model: "PR-655", title: `A's tip ${RUN}`, body: "Check the hook timing first.", authorName: "Tech A" };
  const pa = await post(X.installKey, { ...note, ...A });
  const pb = await post(X.installKey, { ...note, title: `B's tip ${RUN}`, ...B });
  const pp = await post(X.installKey, { ...note, title: `Plain tip ${RUN}` });
  const posts = (await changes(Y.installKey)).posts;
  assert.deepEqual(
    [pa.id, pb.id, pp.id].map((id) => posts.find((p) => p.id === id)).map((p) => [p.shopName, p.shopRef, p.shopId]),
    [["A Company Renamed", "a", claim.shop.id], ["B Company", "b", null], [`Hosted Install ${RUN}`, null, null]],
  );
  await status(await call(`/v1/posts/${pa.id}`, { key: X.installKey, method: "DELETE", headers: { "X-Shop-Ref": "b" } }), 403, "B removes A's note");
  await status(await call(`/v1/posts/${pa.id}`, { key: Y.installKey, method: "DELETE", json: { shopRef: "a" } }), 404, "another install");
  await send(`/v1/posts/${pa.id}`, X.installKey, { shopRef: "a" }, "DELETE");
  await send(`/v1/posts/${pb.id}`, X.installKey, undefined, "DELETE"); // an older program
  assert.deepEqual((await changes(Y.installKey)).posts.filter((p) => [pa.id, pb.id].includes(p.id)).map((p) => p.deleted), [true, true]);
  console.log("notes: ok");

  // ----- manual links: the history names the company (its current name) or the install -----
  const link = await send("/v1/links", X.installKey, { brand: "Brother", models: `PR-${RUN}`, docType: "service", title: "Service manual", url: `https://example.com/${RUN}/a.pdf`, byName: "Tech A", ...A });
  await send(`/v1/links/${link.id}`, X.installKey, { ...link, url: `https://example.com/${RUN}/b.pdf`, byName: "Tech P" }, "PUT");
  const history = await get(`/v1/links/${link.id}/history`, Y.installKey);
  assert.deepEqual(history.map((h) => [h.byShop, h.shopRef]), [[`Hosted Install ${RUN}`, null], ["A Company Renamed", "a"]]);
  console.log("links: ok");

  // ----- parts cross-reference: revisions and buying links credit the company -----
  const part = await send("/v1/xparts", X.installKey, {
    name: `Screw ${RUN}`,
    numbers: [{ brand: "Brother", number: `XA${RUN}` }],
    sources: [{ vendor: "Test Supply", url: "https://example.com/p", priceCents: 199 }],
    byName: "Tech B",
    ...B,
  });
  assert.deepEqual([part.sources[0].byShop, part.sources[0].shopRef], ["B Company", "b"]);
  const partHistory = await get(`/v1/xparts/${part.id}/history`, Y.installKey);
  assert.deepEqual(partHistory.map((h) => [h.byShop, h.shopRef]), [["B Company", "b"]]);
  const part2 = await send(`/v1/xparts/${part.id}`, X.installKey, { ...part, name: `Screw ${RUN} M3`, byName: "Tech P" }, "PUT");
  assert.equal(part2.sources[0].byShop, "B Company", "an unchanged source keeps its credit");
  assert.deepEqual((await get(`/v1/xparts/${part.id}/history`, Y.installKey)).map((h) => h.byShop), [`Hosted Install ${RUN}`, "B Company"]);
  console.log("parts: ok");

  // ----- parts usage: two companies on one install count as two shops -----
  const n = `U${RUN}`;
  await send("/v1/usage", X.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 2, tickets: 1 }], ...A });
  await send("/v1/usage", X.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 3, tickets: 1 }], ...B });
  const top = await get(`/v1/usage/top?months=1&brand=Brother`, Y.installKey);
  const used = top.items.find((i) => i.number === n);
  assert.deepEqual([top.shops, used.qty, used.shops], [2, 5, 2]);
  console.log("usage: ok");

  // ----- figures: the company that shared it is kept (X-Shop-Ref); ownership stays by install -----
  const fid = crypto.randomBytes(12).toString("hex");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const put = (key, ref) => call(`/v1/figures/${fid}`, { key, method: "PUT", body: png, headers: { "Content-Type": "image/png", ...(ref ? { "X-Shop-Ref": ref } : {}) } });
  assert.equal((await ok(await put(X.installKey, "a"))).stored, true);
  assert.deepEqual((await db.query(`SELECT install_id, shop_ref FROM figures WHERE id = $1`, [fid])).rows[0], { install_id: X.installId, shop_ref: "a" });
  assert.equal((await ok(await put(Y.installKey, "y1"))).stored, false, "another install's copy is not kept");
  assert.equal((await ok(await put(X.installKey))).stored, true, "the same install redraws it (an older program)");
  assert.equal((await db.query(`SELECT shop_ref FROM figures WHERE id = $1`, [fid])).rows[0].shop_ref, null);
  console.log("figures: ok");

  // ----- the export carries the new columns (test/db.mjs checks every column; here only that the file is made) -----
  const exp = await call("/v1/admin/export", { key: ADMIN });
  assert.equal(exp.status, 200);
  await exp.arrayBuffer();

  // tidy: the test rows stay in the scratch database, as test/accounts.mjs leaves its own
  await send(`/v1/listings/${lp.id}`, X.installKey, undefined, "DELETE");
  console.log("companies: all ok");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
