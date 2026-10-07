// Checks a company moving from one install to another (StitchBench docs/plans/company-move-design.md section 5,
// package move-hub): starts a hub of its own on a free port against a scratch database and walks a hosted install X
// with three companies (a moves, b stays, then b moves to a program on no hub yet, c moves onto an install that claimed
// it early) and the install's legacy rows (shop_ref ''), a partner repair shop on install Y, and the install Z that a
// moves to. Covers: the move token answered once, replaced by a second, cancelled, expired, wrong, used; the rewrite of
// every table for that company only (shops, partner links, unused invites, listings, orders, ratings, notes, link and
// cross-reference revisions, parts usage merged), legacy rows and the other companies untouched; the old install told
// 410 moved at its claim and standing; the new install receiving the moved listings, notes and orders whatever its
// place in the feeds, and pulling the partner backlog once from the old install's place; a move from a program on no
// hub (an install made, its key answered once, the old scope kept); the admin's list and move by hand; the export
// carrying shop_moves (hashes only).
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/move.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "move-test-admin-token";
const JOIN = "join-move-test";
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
    HUB_NAME: "Move Test Hub",
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
const get = (p, key) => ok(call(p, { key }));
const send = (p, key, json, method = "POST") => ok(call(p, { key, method, json }));
const register = async (name) => ok(await call("/v1/register", { json: { joinKey: JOIN, name } }));
const form = (field, json) => {
  const f = new FormData();
  f.set(field, JSON.stringify(json));
  return f;
};
const listing = (key, json) => ok(call("/v1/listings", { key, method: "POST", body: form("listing", json) }));
const post = (key, json) => ok(call("/v1/posts", { key, method: "POST", body: form("post", json) }));
const ship = { shipTo: "1 Test Road, Testville TS 00000", buyerContact: { name: "Buyer", email: "buyer@example.com" } };
const ym = () => new Date().toISOString().slice(0, 7);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const claim = (key, shopRef, shopName, kind = "retail") => send("/v1/shops/claim", key, { shopRef, shopName, kind, program: "StitchShop", version: "1.7.0", sole: false });
const token = (key, shopRef) => send(`/v1/shops/${shopRef}/move-token`, key, { shopName: shopRef });
const redeem = (key, json) => call("/v1/shops/move", { key, json });

try {
  // X: a hosted install with companies a, b and c (StitchShop sewing shops), and rows of the install's own from before
  // companies had their own identity. Y: a repair shop r, partner of a and b, and a seller on the marketplace. Z: an
  // install already on the hub, where a moves to.
  const X = await register(`Hosted ${RUN}`);
  const Y = await register(`Repair ${RUN}`);
  const Z = await register(`New PC ${RUN}`);
  const W = await register(`Someone else ${RUN}`);
  const A = { shopRef: "a", shopName: "A Sewing" };
  const B = { shopRef: "b", shopName: "B Quilts" };
  const R = { shopRef: "r", shopName: "R Repair" };
  const claimA = await claim(X.installKey, "a", "A Sewing");
  await claim(X.installKey, "b", "B Quilts");
  await claim(Y.installKey, "r", "R Repair", "repair");

  // ----- a's rows (and b's, and the install's legacy ones) on X -----
  const la = await listing(X.installKey, { title: `A's feet ${RUN}`, priceCents: 1000, qty: 3, shippingCents: 0, ...A });
  const lb = await listing(X.installKey, { title: `B's batting ${RUN}`, priceCents: 500, qty: 2, shippingCents: 0, ...B });
  const lp = await listing(X.installKey, { title: `Plain belt ${RUN}`, priceCents: 300, qty: 1, shippingCents: 0 });
  const ly = await listing(Y.installKey, { title: `R's hook ${RUN}`, priceCents: 4500, qty: 2, shippingCents: 0, ...R });
  // a sells to Y, and buys from Y; both sides rate.
  const o1 = await send("/v1/orders", Y.installKey, { listingId: la.id, qty: 1, ...R, ...ship });
  await send(`/v1/orders/${o1.id}/accept`, X.installKey, { shopRef: "a", shippingCents: 0, payInstructions: "Cash" });
  await send(`/v1/orders/${o1.id}/buyer-paid`, Y.installKey, { shopRef: "r" });
  await send(`/v1/orders/${o1.id}/paid`, X.installKey, { shopRef: "a" });
  await send(`/v1/orders/${o1.id}/rate`, Y.installKey, { stars: 5, shopRef: "r" });
  await send(`/v1/orders/${o1.id}/rate`, X.installKey, { stars: 4, shopRef: "a" });
  const o2 = await send("/v1/orders", X.installKey, { listingId: ly.id, qty: 1, ...A, ...ship });
  await send(`/v1/orders/${o2.id}/accept`, Y.installKey, { shopRef: "r", shippingCents: 0, payInstructions: "Cash" });
  await send(`/v1/orders/${o2.id}/buyer-paid`, X.installKey, { shopRef: "a" });
  await send(`/v1/orders/${o2.id}/paid`, Y.installKey, { shopRef: "r" });
  await send(`/v1/orders/${o2.id}/rate`, X.installKey, { stars: 5, shopRef: "a" });
  // Notes: a's, b's and the install's.
  const note = { brand: "Brother", model: "PR-655", body: "Check the hook timing first.", authorName: "Tech" };
  const pa = await post(X.installKey, { ...note, title: `A's tip ${RUN}`, ...A });
  const pb = await post(X.installKey, { ...note, title: `B's tip ${RUN}`, ...B });
  const pp = await post(X.installKey, { ...note, title: `Plain tip ${RUN}` });
  // A manual link added by a, then changed by the install (an older program): revisions of both kinds.
  const link = await send("/v1/links", X.installKey, { brand: "Brother", models: `PR-${RUN}`, docType: "service", title: "Service manual", url: `https://example.com/${RUN}/a.pdf`, byName: "Tech A", ...A });
  await send(`/v1/links/${link.id}`, X.installKey, { ...link, url: `https://example.com/${RUN}/b.pdf`, byName: "Tech P" }, "PUT");
  const part = await send("/v1/xparts", X.installKey, { name: `Screw ${RUN}`, numbers: [{ brand: "Brother", number: `XA${RUN}` }], byName: "Tech A", ...A });
  await send(`/v1/xparts/${part.id}`, X.installKey, { ...part, name: `Screw ${RUN} M3`, byName: "Tech B", ...B }, "PUT");
  // Parts usage: a's, b's, the install's.
  const n = `U${RUN}`;
  const nk = n.toUpperCase(); // the hub's number key
  await send("/v1/usage", X.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 2, tickets: 1 }], ...A });
  await send("/v1/usage", X.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 3, tickets: 1 }], ...B });
  // The install's own count from before it reported per company (the hub drops those once a company reports, so it is
  // put in as an older hub would have kept it).
  await db.query(`INSERT INTO part_usage (install_id, shop_ref, month, number_key, number, brand, qty, tickets) VALUES ($1, '', $2, $3, $4, 'Brother', 7, 2)`, [X.installId, ym(), nk, n]);
  // Partners: r makes codes; a and b redeem one each. a also has a code of its own out, not used yet.
  const codeA = (await send("/v1/partners/invites", Y.installKey, { ...R, side: "repair", terms: { labor: "list" } })).code;
  const L1 = (await send("/v1/partners/redeem", X.installKey, { code: codeA, ...A })).link.id;
  const codeB = (await send("/v1/partners/invites", Y.installKey, { ...R, side: "repair", terms: {} })).code;
  const L2 = (await send("/v1/partners/redeem", X.installKey, { code: codeB, ...B })).link.id;
  await send("/v1/partners/invites", X.installKey, { ...A, side: "retail", terms: {} });
  const msg = (linkId, id, type = "job.update") => send(`/v1/partners/links/${linkId}/messages`, Y.installKey, { shopRef: "r", id, type, data: { at: id } });
  await msg(L1, `before-${RUN}`);
  // X pulls: its place in the partner feed when a's move file is made.
  const xFeed = await get("/v1/partners/messages?since=0", X.installKey);
  assert.ok(xFeed.messages.some((m) => m.linkId === L1 && m.id === `before-${RUN}`));
  const partnerCursor = xFeed.next;
  // Z, already on the hub, has read its feeds past everything above: an order of its own placed last, and every change.
  const o3 = await send("/v1/orders", Z.installKey, { listingId: ly.id, qty: 1, shopRef: "z", shopName: "Z Shop", ...ship });
  const zOrders = (await get("/v1/orders?since=0", Z.installKey)).next;
  assert.equal(String(zOrders), String((await one(`SELECT seq FROM orders WHERE id = $1`, [o3.id])).seq));
  const zChanges = (await get("/v1/changes?since=0&limit=2000", Z.installKey)).next;
  console.log("seeded: ok");

  // ----- the move token -----
  await status(await call("/v1/shops/a/move-token", { method: "POST", json: {} }), 401, "no key");
  const t1 = await token(X.installKey, "a");
  assert.match(t1.token, /^shm_[A-Za-z0-9_-]{43}$/);
  assert.equal(t1.shopRef, "a");
  assert.ok(Date.parse(t1.expiresAt) - Date.now() > 13.9 * 86400_000, "14 days");
  const stored = await one(`SELECT * FROM shop_moves WHERE shop_ref = 'a' AND used_at IS NULL AND cancelled_at IS NULL`);
  assert.equal(stored.from_install_id, X.installId);
  assert.notEqual(stored.token_hash, t1.token, "only the hash is kept");
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  const t2 = await token(X.installKey, "a");
  assert.notEqual(t2.token, t1.token, "each call answers a new token");
  await status(await redeem(Z.installKey, { shopRef: "a", token: t1.token }), 410, "the first token is replaced by the second");
  await status(await redeem(Z.installKey, { shopRef: "a", token: "shm_nope" }), 404, "a wrong token");
  await status(await redeem(Z.installKey, { shopRef: "b", token: t2.token }), 404, "a's token for another company");
  await status(await redeem(Z.installKey, { shopRef: "a" }), 400, "no token");
  await status(await redeem(undefined, { shopRef: "a", token: t2.token }), 400, "no key and no name");
  // Cancelled (the owner's Cancel), then a fresh one; one that ran out.
  const t3 = await token(X.installKey, "a");
  assert.equal((await send("/v1/shops/a/move-token", X.installKey, undefined, "DELETE")).cancelled, 1);
  await status(await redeem(Z.installKey, { shopRef: "a", token: t3.token }), 410, "cancelled");
  await status(await redeem(Z.installKey, { shopRef: "a", token: t2.token }), 410, "cancelled with it (t3 replaced t2)");
  const t4 = await token(X.installKey, "a");
  await db.query(`UPDATE shop_moves SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL AND cancelled_at IS NULL AND shop_ref = 'a'`);
  await status(await redeem(Z.installKey, { shopRef: "a", token: t4.token }), 410, "expired");
  // Another install can't mint a token for a company it doesn't hold (it would only get a row of its own, with nothing in it).
  const tw = await token(W.installKey, "a");
  await status(await redeem(Z.installKey, { shopRef: "a", token: tw.token }), 200, "W's own (empty) row moves to Z");
  assert.equal((await one(`SELECT count(*)::int AS n FROM shops WHERE shop_ref = 'a' AND install_id = $1`, [X.installId])).n, 1, "a on X untouched by W's token");
  await db.query(`DELETE FROM shops WHERE shop_ref = 'a' AND install_id = $1`, [Z.installId]); // W's empty row, now on Z: out of the way
  console.log("move tokens: ok");

  // ----- the move: a goes from X to Z -----
  // The Assistant's counts for a (a paid top-up's 300 among them; a call Z made for a before the move), and b's.
  await db.query(`INSERT INTO assistant_usage (install_id, shop_ref, month, calls, bonus, free_reads) VALUES ($1, 'a', '2026-10', 4, 300, 2), ($1, 'b', '2026-10', 9, 0, 0), ($2, 'a', '2026-10', 1, 0, 0)`, [X.installId, Z.installId]);
  await db.query(`INSERT INTO assistant_shops (install_id, shop_ref, tz, comp_until) VALUES ($1, 'a', 'America/Chicago', '2026-12-31')`, [X.installId]);
  await db.query(`INSERT INTO assistant_calls (id, install_id, shop_ref, feature, class) VALUES ($1, $2, 'a', 'draft_work_done', 'draft')`, [`call${RUN}`, X.installId]);
  const t = await token(X.installKey, "a");
  // a message for a after its move file was made (before the move), and one for b
  await msg(L1, `after-${RUN}`);
  await msg(L2, `for-b-${RUN}`);
  const moved = await ok(redeem(Z.installKey, { shopRef: "a", token: t.token, shopName: "A Sewing", kind: "retail", program: "StitchShop", version: "1.8.0" }));
  assert.equal(moved.ok, true);
  assert.equal(moved.shop.id, claimA.shop.id, "the same hub shop, with its account and standing");
  assert.equal(moved.shop.version, "1.8.0");
  assert.equal(moved.standing, "waived", "a sewing shop partnered with a repair shop in good standing, as before the move");
  assert.equal(moved.installKey, undefined, "an install with a key gets no other");
  assert.deepEqual(moved.partner, { shopRef: "a", links: [L1] });
  assert.ok(moved.moved.listings >= 1 && moved.moved.orders === 2 && moved.moved.posts === 1, JSON.stringify(moved.moved));

  const shopOf = async (ref) => (await one(`SELECT install_id FROM shops WHERE shop_ref = $1`, [ref])).install_id;
  // The Assistant's month moved with a (added to what Z had counted), so a top-up's refund takes its calls back from it.
  assert.deepEqual(await all(`SELECT install_id, shop_ref, calls, bonus, free_reads FROM assistant_usage WHERE month = '2026-10' ORDER BY shop_ref`), [
    { install_id: Z.installId, shop_ref: "a", calls: 5, bonus: 300, free_reads: 2 },
    { install_id: X.installId, shop_ref: "b", calls: 9, bonus: 0, free_reads: 0 },
  ]);
  assert.deepEqual(await all(`SELECT install_id, tz, comp_until::text AS comp_until FROM assistant_shops WHERE shop_ref = 'a'`), [{ install_id: Z.installId, tz: "America/Chicago", comp_until: "2026-12-31" }]);
  assert.equal((await one(`SELECT install_id FROM assistant_calls WHERE id = $1`, [`call${RUN}`])).install_id, Z.installId);
  assert.equal(await shopOf("a"), Z.installId);
  assert.equal(await shopOf("b"), X.installId);
  const listingAt = async (id) => (await one(`SELECT install_id FROM listings WHERE id = $1`, [id])).install_id;
  assert.deepEqual([await listingAt(la.id), await listingAt(lb.id), await listingAt(lp.id), await listingAt(ly.id)], [Z.installId, X.installId, X.installId, Y.installId]);
  const ord = async (id) => one(`SELECT seller_install_id, buyer_install_id FROM orders WHERE id = $1`, [id]);
  assert.deepEqual(await ord(o1.id), { seller_install_id: Z.installId, buyer_install_id: Y.installId });
  assert.deepEqual(await ord(o2.id), { seller_install_id: Y.installId, buyer_install_id: Z.installId });
  const ratings = await all(`SELECT order_id, by_role, rater_install_id, rated_install_id FROM order_ratings WHERE order_id = ANY($1) ORDER BY order_id, by_role`, [[o1.id, o2.id]]);
  for (const r of ratings) {
    const aRates = (r.order_id === o1.id && r.by_role === "seller") || (r.order_id === o2.id && r.by_role === "buyer");
    assert.equal(aRates ? r.rater_install_id : r.rated_install_id, Z.installId, `${r.order_id} ${r.by_role}: a's side moved`);
    assert.equal(aRates ? r.rated_install_id : r.rater_install_id, Y.installId, `${r.order_id} ${r.by_role}: Y's side stayed`);
  }
  assert.equal(ratings.length, 3);
  const postAt = async (id) => (await one(`SELECT install_id FROM posts WHERE id = $1`, [id])).install_id;
  assert.deepEqual([await postAt(pa.id), await postAt(pb.id), await postAt(pp.id)], [Z.installId, X.installId, X.installId]);
  const revs = await all(`SELECT shop_ref, install_id FROM link_revisions WHERE link_id = $1 ORDER BY created_at`, [link.id]);
  assert.deepEqual(revs.map((r) => [r.shop_ref, r.install_id]), [["a", Z.installId], ["", X.installId]], "a's revision moved, the legacy one stayed");
  const xrevs = await all(`SELECT shop_ref, install_id FROM xpart_revisions WHERE xpart_id = $1 ORDER BY created_at`, [part.id]);
  assert.deepEqual(xrevs.map((r) => [r.shop_ref, r.install_id]), [["a", Z.installId], ["b", X.installId]]);
  const usage = await all(`SELECT install_id, shop_ref, qty FROM part_usage WHERE number_key = $1 ORDER BY qty`, [nk]);
  assert.deepEqual(usage.map((u) => [u.install_id, u.shop_ref, u.qty]), [[Z.installId, "a", 2], [X.installId, "b", 3], [X.installId, "", 7]]);
  const links = await all(`SELECT id, retail_install_id, repair_install_id FROM partner_links WHERE id = ANY($1)`, [[L1, L2]]);
  assert.deepEqual(Object.fromEntries(links.map((l) => [l.id, [l.retail_install_id, l.repair_install_id]])), { [L1]: [Z.installId, Y.installId], [L2]: [X.installId, Y.installId] });
  const invites = await all(`SELECT install_id, used_at IS NOT NULL AS used FROM partner_invites WHERE shop_ref = 'a' ORDER BY created_at`);
  assert.deepEqual(invites.map((i) => [i.install_id, i.used]), [[Z.installId, false]], "a's unused code moved");
  assert.equal((await one(`SELECT install_id FROM partner_invites WHERE code_hash = (SELECT code_hash FROM partner_invites WHERE link_id = $1)`, [L1])).install_id, Y.installId, "the used code (r's) stays r's");
  console.log("rewrite: ok (a moved, b and the legacy rows stayed)");

  // The token works once; the same install asking again gets the same answer (a lost answer); another is refused.
  const again = await ok(redeem(Z.installKey, { shopRef: "a", token: t.token }));
  assert.equal(again.shop.id, claimA.shop.id);
  await status(await redeem(W.installKey, { shopRef: "a", token: t.token }), 409, "used");
  await status(await redeem(undefined, { shopRef: "a", token: t.token, shopName: "A Sewing" }), 409, "used, without a key");

  // ----- the old install is told -----
  const gone = await status(await call("/v1/shops/claim", { key: X.installKey, json: { shopRef: "a", shopName: "A Sewing", program: "StitchShop", sole: false } }), 410, "claim from the old install");
  assert.deepEqual([gone.moved, gone.to], [true, `New PC ${RUN}`]);
  assert.ok(Date.parse(gone.at) <= Date.now() && Date.now() - Date.parse(gone.at) < 60_000);
  assert.match(gone.error, new RegExp(`moved to New PC ${RUN} on \\d{4}-\\d{2}-\\d{2}`));
  assert.equal((await status(await call("/v1/shops/a/standing", { key: X.installKey }), 410, "standing from the old install")).moved, true);
  assert.equal((await status(await call("/v1/shops/a/move-token", { key: X.installKey, json: {} }), 410, "a token from the old install")).moved, true);
  assert.equal((await claim(X.installKey, "b", "B Quilts")).shop.shopRef, "b", "b on the old install carries on");
  assert.equal((await get("/v1/shops/a/standing", Z.installKey)).shop.id, claimA.shop.id, "the new install has it");
  assert.equal((await one(`SELECT count(*)::int AS n FROM shops WHERE shop_ref = 'a'`)).n, 1, "no second row made for the old install");
  console.log("old install: ok (410 moved, with where and when)");

  // ----- the new install catches up -----
  // Listings, notes and orders come again in its feeds although it had read past their first numbers.
  const zc = await get(`/v1/changes?since=${zChanges}&limit=2000`, Z.installKey);
  assert.equal(zc.listings.find((l) => l.id === la.id)?.mine, true, "a's listing, as Z's own");
  assert.ok(!zc.listings.some((l) => l.id === lb.id && l.mine), "b's isn't Z's");
  assert.equal(zc.posts.find((p) => p.id === pa.id)?.mine, true, "a's note, as Z's own");
  const zo = await get(`/v1/orders?since=${zOrders}`, Z.installKey);
  assert.deepEqual(zo.orders.map((o) => [o.id, o.role]).sort(), [[o1.id, "seller"], [o2.id, "buyer"]].sort());
  // The partner backlog: once, from X's place, a's link only.
  const backlog = await get(`/v1/partners/messages?since=${partnerCursor}&shopRef=a`, Z.installKey);
  assert.deepEqual(backlog.messages.map((m) => [m.linkId, m.id, m.toShopRef]), [[L1, `after-${RUN}`, "a"]]);
  assert.deepEqual((await get(`/v1/partners/messages?since=${backlog.next}&shopRef=a`, Z.installKey)).messages, [], "pulled once");
  assert.deepEqual((await get(`/v1/partners/messages?since=${partnerCursor}&shopRef=b`, Z.installKey)).messages, [], "b's messages aren't Z's");
  // X's feed carries b's and no more of a's.
  const xAfter = await get(`/v1/partners/messages?since=${partnerCursor}`, X.installKey);
  assert.deepEqual(xAfter.messages.map((m) => [m.linkId, m.id]), [[L2, `for-b-${RUN}`]]);
  // r's next message on the link reaches Z, not X; r sees nothing different (the link's id and names are the same).
  await msg(L1, `later-${RUN}`);
  assert.ok((await get(`/v1/partners/messages?since=${backlog.next}`, Z.installKey)).messages.some((m) => m.id === `later-${RUN}`));
  assert.ok(!(await get(`/v1/partners/messages?since=${xAfter.next}`, X.installKey)).messages.some((m) => m.id === `later-${RUN}`));
  const rLinks = await get("/v1/partners/links", Y.installKey);
  assert.ok(rLinks.some((l) => l.id === L1 && l.retail.shopRef === "a" && l.retail.name === "A Sewing"));
  // Z can send on the link as a now (a partner write from the new install), and X can't.
  await send(`/v1/partners/links/${L1}/messages`, Z.installKey, { shopRef: "a", id: `from-z-${RUN}`, type: "job.reply", data: {} });
  await status(await call(`/v1/partners/links/${L1}/messages`, { key: X.installKey, json: { shopRef: "a", id: `from-x-${RUN}`, type: "job.reply", data: {} } }), 404, "the old install can't send for a");
  console.log("catching up: ok (feeds and the partner backlog once)");

  // ----- a program on no hub yet: b moves off X to a new install of its own -----
  const tb = await token(X.installKey, "b");
  const fresh = await ok(redeem(undefined, { shopRef: "b", token: tb.token, shopName: "B Quilts", kind: "retail", program: "StitchShop", version: "1.8.0" }));
  assert.match(fresh.installKey, /^shk_/);
  assert.equal(fresh.scope, "member", "the scope X had");
  assert.equal(fresh.hubName, "Move Test Hub");
  const me = await get("/v1/me", fresh.installKey);
  assert.deepEqual([me.installId, me.name], [fresh.installId, "B Quilts"]);
  assert.equal(await shopOf("b"), fresh.installId);
  assert.equal(await listingAt(lb.id), fresh.installId);
  assert.equal(await listingAt(lp.id), X.installId, "the install's legacy listing stays");
  assert.equal(await postAt(pp.id), X.installId, "the install's legacy note stays");
  assert.deepEqual(fresh.partner.links, [L2]);
  assert.equal((await status(await call("/v1/shops/claim", { key: X.installKey, json: { shopRef: "b", shopName: "B" } }), 410, "b gone from X")).to, "B Quilts");
  console.log("move to a program on no hub: ok (an install made, its key once)");

  // ----- the new install claimed the company before the move reached the hub (its sync ran first) -----
  await claim(X.installKey, "c", "C Crafts");
  await send("/v1/usage", X.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 1, tickets: 1 }], shopRef: "c", shopName: "C Crafts" });
  const cOnX = (await get("/v1/shops/c/standing", X.installKey)).shop.id;
  const tc = await token(X.installKey, "c");
  await claim(Z.installKey, "c", "C Crafts"); // a stray row on Z, with nothing of its own
  await send("/v1/usage", Z.installKey, { month: ym(), items: [{ number: n, brand: "Brother", qty: 9, tickets: 3 }], shopRef: "c", shopName: "C Crafts" });
  const movedC = await ok(redeem(Z.installKey, { shopRef: "c", token: tc.token, shopName: "C Crafts" }));
  assert.equal(movedC.shop.id, cOnX, "the moved row is kept; the stray one went");
  assert.deepEqual((await all(`SELECT id, install_id FROM shops WHERE shop_ref = 'c'`)).map((s) => [s.id, s.install_id]), [[cOnX, Z.installId]]);
  assert.deepEqual((await all(`SELECT install_id, qty FROM part_usage WHERE shop_ref = 'c' AND number_key = $1`, [nk])).map((u) => [u.install_id, u.qty]), [[Z.installId, 9]], "usage merged, the newer report kept");
  console.log("a stray row on the new install: ok");

  // ----- the hub admin: the list, and a move by hand (a back to X) -----
  await status(await call("/v1/admin/moves", { key: "wrong" }), 401, "admin only");
  const list = await get("/v1/admin/moves", ADMIN);
  const aMove = list.moves.find((m) => m.shopRef === "a" && m.state === "moved" && !m.byAdmin && m.from.id === X.installId);
  assert.ok(aMove, "a's move is listed");
  assert.deepEqual([aMove.to.name, aMove.now.name], [`New PC ${RUN}`, `New PC ${RUN}`]);
  assert.ok(list.moves.some((m) => m.shopRef === "a" && m.state === "cancelled"));
  await status(await call(`/v1/admin/shops/${claimA.shop.id}/move`, { key: ADMIN, json: { toInstallId: Z.installId } }), 409, "already there");
  await status(await call(`/v1/admin/shops/${claimA.shop.id}/move`, { key: ADMIN, json: { toInstallId: "nope" } }), 404, "no such install");
  const byHand = await send(`/v1/admin/shops/${claimA.shop.id}/move`, ADMIN, { toInstallId: X.installId });
  assert.equal(byHand.to, `Hosted ${RUN}`);
  assert.equal(await listingAt(la.id), X.installId);
  assert.equal((await claim(X.installKey, "a", "A Sewing")).shop.id, claimA.shop.id, "back on X: X's claim works again");
  assert.equal((await status(await call("/v1/shops/a/standing", { key: Z.installKey }), 410, "Z told a moved")).to, `Hosted ${RUN}`);
  assert.ok((await get("/v1/admin/moves", ADMIN)).moves.some((m) => m.shopRef === "a" && m.byAdmin && m.state === "moved"));
  console.log("admin: ok (list, move by hand)");

  // ----- the export carries shop_moves, hashes only -----
  const exp = await call("/v1/admin/export", { key: ADMIN });
  assert.equal(exp.status, 200);
  const text = zlib.gunzipSync(Buffer.from(await exp.arrayBuffer())).toString("utf8");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  const moves = rows.filter((r) => r.t === "shop_move");
  assert.equal(moves.length, (await one(`SELECT count(*)::int AS n FROM shop_moves`)).n);
  assert.ok(moves.some((m) => m.shop_ref === "a" && m.used_at && m.to_install_id === Z.installId && m.moved?.listings >= 1));
  assert.ok(moves.every((m) => m.token_hash === null || /^[0-9a-f]{64}$/.test(m.token_hash)));
  for (const tk of [t1, t2, t3, t4, t, tb, tc]) assert.ok(!text.includes(tk.token), "no token in the clear");
  const order = rows.map((r) => r.t);
  assert.ok(order.lastIndexOf("shop") < order.indexOf("shop_move") && order.lastIndexOf("install") < order.indexOf("shop_move"), "after the shops and installs it names");
  assert.ok(!/shm_[A-Za-z0-9_-]{20}/.test(hubLog), "the hub's log holds no move tokens");
  console.log("export: ok");
  console.log("all move checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
