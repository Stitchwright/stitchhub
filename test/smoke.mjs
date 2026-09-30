// End-to-end check of a StitchHub server. Uses throwaway members, links, parts and listings, and cleans up what it can.
// usage: HUB_URL=http://localhost:8080 ADMIN_TOKEN=... JOIN_KEY=... node test/smoke.mjs
import assert from "node:assert/strict";
import zlib from "node:zlib";

const HUB = (process.env.HUB_URL ?? "http://localhost:8080").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const JOIN = process.env.JOIN_KEY;
const RUN = Date.now().toString(36); // fresh URLs and part numbers each run
assert.ok(ADMIN && JOIN, "set ADMIN_TOKEN and JOIN_KEY");

async function call(path, { key, method = "GET", json, body, headers = {} } = {}) {
  const r = await fetch(HUB + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  return r;
}
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
};
const get = async (path, key) => (await ok(await call(path, { key }))).json();
const send = async (path, key, json, method = "POST") => (await ok(await call(path, { key, method, json }))).json();

// Joining needs the right key.
assert.equal((await call("/v1/register", { method: "POST", json: { joinKey: "wrong", name: "Nope" } })).status, 403);
const register = async (name) => (await (await ok(await call("/v1/register", { method: "POST", json: { joinKey: JOIN, name } }))).json()).installKey;
const installKey = await register("Smoke Test Shop");
assert.match(installKey, /^shk_/);
assert.equal((await call("/v1/changes")).status, 401);
console.log("join: ok");

// Links: add, edit, history, revert, remove, restore.
const link = await (await ok(await call("/v1/links", { key: installKey, method: "POST", json: { brand: "Janome", models: "MC6700P", docType: "ServiceManual", title: "Smoke test link", url: `https://example.com/${RUN}/a.pdf`, byName: "Tester" } }))).json();
assert.deepEqual(link.modelKeys, ["MC6700P"]);
const edited = await (await ok(await call(`/v1/links/${link.id}`, { key: installKey, method: "PUT", json: { ...link, url: `https://example.com/${RUN}/b.pdf`, byName: "Tester", note: "moved" } }))).json();
assert.equal(edited.url, `https://example.com/${RUN}/b.pdf`);
assert.equal(edited.status, "unchecked");
const history = await (await ok(await call(`/v1/links/${link.id}/history`, { key: installKey }))).json();
assert.deepEqual(history.map((h) => h.action), ["edited", "added"]);
const reverted = await (await ok(await call(`/v1/links/${link.id}/revert`, { key: installKey, method: "POST", json: { revisionId: history[1].id, byName: "Tester" } }))).json();
assert.equal(reverted.url, `https://example.com/${RUN}/a.pdf`);
await ok(await call(`/v1/links/${link.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester" } }));
const restored = await (await ok(await call(`/v1/links/${link.id}/restore`, { key: installKey, method: "POST", json: {} }))).json();
assert.equal(restored.deleted, false);
assert.equal((await call("/v1/links", { key: installKey, method: "POST", json: { brand: "X", models: "1", url: "ftp://nope" } })).status, 400);
const dup = await call("/v1/links", { key: installKey, method: "POST", json: { brand: "Janome", models: "MC6700P", url: `https://example.com/${RUN}/a.pdf` } });
assert.equal(dup.status, 409);
assert.equal((await dup.json()).linkId, link.id);
console.log("links: ok");

// Notes with a photo.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const fd = new FormData();
fd.set("post", JSON.stringify({ brand: "Janome", model: "MC6700P", kind: "TIP", title: "Smoke test note", body: "Checks posting.", authorName: "Tester", photos: [{ kind: "WIRING", caption: "pin 1" }] }));
fd.append("photo", new Blob([png], { type: "image/png" }), "p.png");
const { id: postId } = await (await ok(await call("/v1/posts", { key: installKey, method: "POST", body: fd }))).json();
console.log("notes: ok");

// Figures.
const figId = "0123456789abcdef01234567";
await ok(await call(`/v1/figures/${figId}?w=1&h=1`, { key: installKey, method: "PUT", body: png, headers: { "Content-Type": "image/png" } }));
assert.equal((await ok(await call(`/v1/figures/${figId}`, { key: installKey }))).headers.get("content-type"), "image/png");
console.log("figures: ok");

// Parts cross-reference: add, duplicate number refused, edit, history, revert, merge.
const nA = `XA${RUN}1`;
const part = await send("/v1/xparts", installKey, {
  name: "Smoke screw",
  kind: "PART",
  category: "Screw",
  specs: "M3 x 6 mm",
  numbers: [
    { brand: "Brother", number: nA },
    { brand: "Baby Lock", number: `BL-${RUN}` },
  ],
  fits: [{ brand: "Brother", model: "PR-655", evidence: "tested" }],
  sources: [{ vendor: "Test Supply", url: "https://example.com/p", priceCents: 199 }],
  byName: "Tester",
});
assert.equal(part.numbers.length, 2);
assert.equal(part.fits[0].modelKey, "PR655");
assert.equal(part.sources[0].byShop, "Smoke Test Shop");
const dupPart = await call("/v1/xparts", { key: installKey, method: "POST", json: { name: "Same", numbers: [{ brand: "brother", number: nA.toLowerCase().replace(/^xa/, "xa-") }] } });
assert.equal(dupPart.status, 409);
assert.equal((await dupPart.json()).partId, part.id);
const partEdited = await send(
  `/v1/xparts/${part.id}`,
  installKey,
  { ...part, name: "Smoke screw M3x6", fits: [...part.fits, { brand: "Baby Lock", model: "BMP9" }], byName: "Tester", note: "fits the BMP9 too" },
  "PUT",
);
assert.equal(partEdited.name, "Smoke screw M3x6");
assert.equal(partEdited.fits.length, 2);
assert.equal(partEdited.fits.find((f) => f.modelKey === "BMP9").evidence, "tested");
assert.equal(partEdited.sources[0].id, part.sources[0].id); // unchanged source keeps its id
const partHistory = await get(`/v1/xparts/${part.id}/history`, installKey);
assert.deepEqual(partHistory.map((h) => h.action), ["edited", "added"]);
assert.equal(partHistory[1].snapshot.name, "Smoke screw");
const partReverted = await send(`/v1/xparts/${part.id}/revert`, installKey, { revisionId: partHistory[1].id, byName: "Tester" });
assert.equal(partReverted.name, "Smoke screw");
assert.equal(partReverted.fits.length, 1);
const other = await send("/v1/xparts", installKey, { name: "Same screw, Singer number", numbers: [{ brand: "Singer", number: `S${RUN}` }], fits: [{ brand: "Singer", model: "4423" }], byName: "Tester" });
const mergedPart = await send(`/v1/xparts/${other.id}/merge`, installKey, { intoId: part.id, byName: "Tester" });
assert.equal(mergedPart.numbers.length, 3);
assert.ok(mergedPart.fits.some((f) => f.modelKey === "4423"));
assert.equal((await get(`/v1/xparts/${other.id}/history`, installKey))[0].action, "merged");
console.log("parts: ok");

// Admin bulk import: a new part, and an entry whose number is already on the hub (merged into that part).
const imported = await send("/v1/admin/xparts/import", ADMIN, [
  { name: "Imported part", numbers: [{ brand: "Janome", number: `IMP${RUN}` }], fits: [{ brand: "Janome", model: "MC6700P" }] },
  { numbers: [{ brand: "Brother", number: nA }], fits: [{ brand: "Brother", model: "PR1050X" }] },
  { name: "nothing to add" },
]);
assert.deepEqual(imported, { added: 1, merged: 1, skipped: 1 });
console.log("parts import: ok");

// Bulk "where to buy" (supplier scan): attach, update on re-import, nothing new on an identical re-import.
const srcUrl = `https://example.com/${RUN}/src`;
const scan = (priceCents) => [
  { number: nA.toLowerCase(), brand: "Brother", vendor: "Smoke Supply", url: srcUrl, priceCents },
  { number: `NOPE${RUN}`, vendor: "Nowhere", url: "https://example.com/none" },
  { number: nA, vendor: "Bad link", url: "ftp://example.com/x" },
];
assert.deepEqual(await send("/v1/admin/xparts/sources/import", ADMIN, scan(199)), { attached: 1, updated: 0, unmatched: 2, unchanged: 0 });
assert.deepEqual(await send("/v1/admin/xparts/sources/import", ADMIN, scan(249)), { attached: 0, updated: 1, unmatched: 2, unchanged: 0 });
assert.deepEqual(await send("/v1/admin/xparts/sources/import", ADMIN, scan(249)), { attached: 0, updated: 0, unmatched: 2, unchanged: 1 });
// By the Baby Lock number, with no brand: same part, same link, so still one copy.
assert.deepEqual(await send("/v1/admin/xparts/sources/import", ADMIN, [{ number: `BL-${RUN}`, vendor: "Smoke Supply", url: srcUrl, priceCents: 249, note: "in stock" }]), {
  attached: 0,
  updated: 1,
  unmatched: 0,
  unchanged: 0,
});
const [scanned] = (await get(`/v1/xparts/${part.id}/history`, installKey)).slice(0, 1);
assert.equal(scanned.action, "sources");
const scannedSources = scanned.snapshot.sources.filter((s) => s.url === srcUrl);
assert.equal(scannedSources.length, 1);
assert.deepEqual([scannedSources[0].priceCents, scannedSources[0].note, scannedSources[0].byShop], [249, "in stock", "StitchHub scan"]);
console.log("sources import: ok");

// Marketplace: list with a photo, update, and a second shop's view.
const buyerKey = await register("Smoke Buyer Shop");
const listingForm = new FormData();
listingForm.set(
  "listing",
  JSON.stringify({ title: `Smoke bobbin case ${RUN}`, kind: "PART", condition: "USED", brand: "Brother", partNumber: nA, xpartId: part.id, priceCents: 1500, qty: 3, shippingCents: 500, shipsFrom: "Testville, TS" }),
);
listingForm.append("photo", new Blob([png], { type: "image/png" }), "l.png");
const listing = await (await ok(await call("/v1/listings", { key: installKey, method: "POST", body: listingForm }))).json();
assert.ok(listing.mine && listing.photos.length === 1 && listing.status === "ACTIVE");
const repriced = await send(`/v1/listings/${listing.id}`, installKey, { priceCents: 1400 }, "PUT");
assert.equal(repriced.priceCents, 1400);
assert.equal((await call(`/v1/listings/${listing.id}`, { key: buyerKey, method: "PUT", json: { priceCents: 1 } })).status, 403);
assert.equal((await ok(await call(`/v1/listing-photos/${listing.photos[0].id}`, { key: buyerKey }))).headers.get("content-type"), "image/png");
console.log("listings: ok");

// Orders: request, accept (stock goes down), paid, shipped with tracking, received.
const ship = { shipTo: "Smoke Buyer Shop, 1 Test Road, Testville TS 00000", buyerContact: { name: "Buyer", email: "buyer@example.com" } };
assert.equal((await call("/v1/orders", { key: installKey, method: "POST", json: { listingId: listing.id, qty: 1, ...ship } })).status, 409); // own listing
assert.equal((await call("/v1/orders", { key: buyerKey, method: "POST", json: { listingId: listing.id, qty: 9, ...ship } })).status, 409); // more than listed
let order = await send("/v1/orders", buyerKey, { listingId: listing.id, qty: 2, buyerNote: "for a PR655", ...ship });
assert.equal(order.status, "REQUESTED");
assert.equal(order.role, "buyer");
assert.equal(order.totalCents, 2 * 1400 + 500);
assert.match(order.number, /^SH-\d{6}$/);
assert.equal((await call(`/v1/orders/${order.id}/accept`, { key: buyerKey, method: "POST", json: {} })).status, 409); // wrong role
order = await send(`/v1/orders/${order.id}/accept`, installKey, {
  sellerContact: { name: "Smoke Test Shop", address: "2 Test St, Testville", email: "seller@example.com" },
  payInstructions: "PayPal seller@example.com",
});
assert.equal(order.status, "ACCEPTED");
assert.equal(order.role, "seller");
assert.equal((await call(`/v1/orders/${order.id}/rate`, { key: installKey, method: "POST", json: { stars: 4 } })).status, 409); // seller: not paid yet
assert.equal((await call(`/v1/orders/${order.id}/rate`, { key: buyerKey, method: "POST", json: { stars: 5 } })).status, 409); // buyer: not shipped yet
assert.equal((await send(`/v1/listings/${listing.id}`, installKey, {}, "PUT")).qty, 1);
order = await send(`/v1/orders/${order.id}/buyer-paid`, buyerKey, { note: "sent by PayPal" });
assert.equal(order.buyerPaidNote, "sent by PayPal");
assert.equal((await call(`/v1/orders/${order.id}/received`, { key: buyerKey, method: "POST", json: {} })).status, 409); // not shipped yet
order = await send(`/v1/orders/${order.id}/paid`, installKey, {});
assert.equal(order.status, "PAID");
assert.equal((await call(`/v1/orders/${order.id}/rate`, { key: installKey, method: "POST", json: { stars: 9 } })).status, 400);
order = await send(`/v1/orders/${order.id}/rate`, installKey, { stars: 4, comment: "paid quickly" }); // the seller rates the buyer
assert.deepEqual([order.ratings.seller.stars, order.ratings.seller.comment, order.ratings.buyer], [4, "paid quickly", null]);
assert.deepEqual(order.buyerReputation, { avg: 4, count: 1 });
order = await send(`/v1/orders/${order.id}/ship`, installKey, { carrier: "USPS", tracking: "9400 1000 0000 0000 0000 00" });
assert.equal(order.status, "SHIPPED");
assert.match(order.trackingUrl, /usps\.com.*9400100000000000000000/);
await send(`/v1/orders/${order.id}/message`, buyerKey, { text: "Thanks!" });
order = await send(`/v1/orders/${order.id}/received`, buyerKey, {});
assert.equal(order.status, "RECEIVED");
assert.deepEqual(order.events.map((e) => e.action), ["requested", "accepted", "buyer-paid", "paid", "rated", "shipped", "message", "received"]);

// Ratings: the buyer rates the seller (again replaces it); reputations add up.
order = await send(`/v1/orders/${order.id}/rate`, buyerKey, { stars: 5, comment: "fast shipping" });
assert.equal(order.ratings.buyer.stars, 5);
order = await send(`/v1/orders/${order.id}/rate`, buyerKey, { stars: 3, comment: "fine" });
assert.deepEqual([order.ratings.buyer.stars, order.ratings.buyer.comment, order.ratings.seller.stars], [3, "fine", 4]);
assert.deepEqual(order.sellerReputation, { avg: 3, count: 1 });
assert.equal(order.events.filter((e) => e.action === "rated").length, 3);
const sellerId = (await get("/v1/me", installKey)).installId;
const buyerId = (await get("/v1/me", buyerKey)).installId;
const rep = await get(`/v1/reputation/${sellerId}`, buyerKey);
assert.deepEqual(rep.asSeller, { avg: 3, count: 1 });
assert.deepEqual(rep.asBuyer, { avg: null, count: 0 });
assert.deepEqual(
  rep.recent.map((r) => [r.stars, r.comment, r.role]),
  [[3, "fine", "seller"]],
);
assert.deepEqual((await get(`/v1/reputation/${buyerId}`, installKey)).asBuyer, { avg: 4, count: 1 });
assert.equal((await call("/v1/reputation/nope", { key: buyerKey })).status, 404);
console.log("ratings: ok");

// A cancelled order puts the stock back (the last one sells out the listing first).
let second = await send("/v1/orders", buyerKey, { listingId: listing.id, qty: 1, ...ship });
second = await send(`/v1/orders/${second.id}/accept`, installKey, { payInstructions: "Zelle" });
let listingNow = await send(`/v1/listings/${listing.id}`, installKey, {}, "PUT");
assert.equal(listingNow.qty, 0);
assert.equal(listingNow.status, "SOLD_OUT");
assert.equal((await call("/v1/orders", { key: buyerKey, method: "POST", json: { listingId: listing.id, qty: 1, ...ship } })).status, 409); // sold out
second = await send(`/v1/orders/${second.id}/cancel`, buyerKey, { reason: "found one locally" });
assert.equal(second.status, "CANCELLED");
listingNow = await send(`/v1/listings/${listing.id}`, installKey, {}, "PUT");
assert.equal(listingNow.qty, 1);
assert.equal(listingNow.status, "ACTIVE");

// Orders are private: a third shop can't see or touch them.
const thirdKey = await register("Smoke Third Shop");
const third = await send("/v1/orders", thirdKey, { listingId: listing.id, qty: 1, ...ship });
const buyerOrders = (await get("/v1/orders?since=0", buyerKey)).orders.map((o) => o.id);
assert.ok(buyerOrders.includes(order.id) && buyerOrders.includes(second.id) && !buyerOrders.includes(third.id));
assert.equal((await call(`/v1/orders/${third.id}/cancel`, { key: buyerKey, method: "POST", json: {} })).status, 404);
const sellerOrders = await get("/v1/orders?since=0", installKey);
assert.ok([order.id, second.id, third.id].every((id) => sellerOrders.orders.some((o) => o.id === id)));
assert.equal((await get(`/v1/orders?since=${sellerOrders.next}`, installKey)).orders.length, 0);
await send(`/v1/orders/${third.id}/decline`, installKey, { reason: "smoke test" });
console.log("orders: ok");

// Parts usage: two shops send monthly counts; re-sending a month replaces it; the top list adds them up.
const ym = (back) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const nk = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const UB = `SmokeBrand${RUN}`;
const u1 = `U1-${RUN}`;
const u2 = `U2-${RUN}`;
assert.deepEqual(await send("/v1/usage", installKey, { month: ym(0), items: [{ number: u1, brand: UB, qty: 99, tickets: 9 }] }), { ok: true, items: 1 });
assert.deepEqual(
  await send("/v1/usage", installKey, {
    month: ym(0),
    items: [
      { number: u1, brand: UB, qty: 4, tickets: 3 },
      { number: nA, brand: "Brother", qty: 2, tickets: 2 },
    ],
  }),
  { ok: true, items: 2 },
); // replaces the 99
await send("/v1/usage", installKey, { month: ym(1), items: [{ number: u2, brand: UB, qty: 1, tickets: 1 }] });
await send("/v1/usage", buyerKey, {
  month: ym(2),
  items: [
    { number: u1.toLowerCase(), brand: UB.toLowerCase(), qty: 6, tickets: 2 },
    { number: nA, brand: "Brother", qty: 1, tickets: 1 },
  ],
});
for (const month of ["2026-13", "last month", ym(-1), ym(25)]) {
  assert.equal((await call("/v1/usage", { key: installKey, method: "POST", json: { month, items: [] } })).status, 400, `month ${month}`);
}
assert.equal((await call("/v1/usage", { key: installKey, method: "POST", json: { month: ym(0), items: [{ number: u1, qty: -1 }] } })).status, 400);
const top = await get(`/v1/usage/top?months=12&brand=${UB.toUpperCase()}`, buyerKey);
assert.equal(top.to, ym(0));
assert.equal(top.from, ym(11));
assert.equal(top.shops, 2);
assert.deepEqual(
  top.items.map((i) => [i.numberKey, i.number, i.qty, i.tickets, i.shops]),
  [
    [nk(u1), u1.toLowerCase(), 10, 5, 2], // one row per spelling: the one with more used wins
    [nk(u2), u2, 1, 1, 1],
  ],
);
const thisMonth = await get(`/v1/usage/top?months=1&brand=${UB}`, installKey);
assert.deepEqual(
  thisMonth.items.map((i) => [i.numberKey, i.qty, i.shops]),
  [[nk(u1), 4, 1]],
);
const brotherTop = await get("/v1/usage/top?months=12&brand=brother&limit=1000", installKey);
const screw = brotherTop.items.find((i) => i.numberKey === nk(nA));
assert.deepEqual([screw.qty, screw.shops, screw.xpartId, screw.name], [3, 2, part.id, "Smoke screw"]);
assert.equal(top.items[0].xpartId, null);
console.log("usage: ok");

// Changes: everything above comes back, in order, with a cursor (orders never do).
let since = "0";
const seen = { links: new Map(), posts: new Map(), figures: new Set(), xparts: new Map(), listings: new Map() };
for (;;) {
  const ch = await (await ok(await call(`/v1/changes?since=${since}&limit=500`, { key: installKey }))).json();
  ch.links.forEach((l) => seen.links.set(l.id, l));
  ch.posts.forEach((p) => seen.posts.set(p.id, p));
  ch.figures.forEach((f) => seen.figures.add(f));
  ch.xparts.forEach((x) => seen.xparts.set(x.id, x));
  ch.listings.forEach((x) => seen.listings.set(x.id, x));
  assert.equal(ch.orders, undefined);
  since = ch.next;
  if (!ch.more) break;
}
assert.equal(seen.links.get(link.id).url, `https://example.com/${RUN}/a.pdf`);
const post = seen.posts.get(postId);
assert.ok(post.mine && post.photos.length === 1 && post.photos[0].kind === "WIRING");
assert.ok(seen.figures.has(figId));
assert.equal(seen.xparts.get(part.id).numbers.length, 3);
assert.ok(seen.xparts.get(part.id).fits.some((f) => f.modelKey === "PR1050X")); // from the import
assert.equal(seen.xparts.get(other.id).deleted, true);
assert.equal(seen.listings.get(listing.id).mine, true);
assert.equal(seen.listings.get(listing.id).sellerId, sellerId);
assert.deepEqual(seen.listings.get(listing.id).sellerRating, { avg: 3, count: 1 });
const photo = await ok(await call(`/v1/photos/${post.photos[0].id}`, { key: installKey }));
assert.equal(Buffer.from(await photo.arrayBuffer()).length, png.length);
const again = await (await ok(await call(`/v1/changes?since=${since}`, { key: installKey }))).json();
assert.equal(again.links.length + again.posts.length + again.figures.length + again.xparts.length + again.listings.length, 0);
const buyerView = await get(`/v1/changes?since=${Number(since) - 50 > 0 ? Number(since) - 50 : 0}&limit=2000`, buyerKey);
const seenByBuyer = buyerView.listings.find((l) => l.id === listing.id);
if (seenByBuyer) assert.equal(seenByBuyer.mine, false);
console.log("changes: ok");

// Partner links: a repair shop's code gets a sewing shop (not a community member) onto the partner channel only.
const pInv = await send("/v1/partners/invites", installKey, { shopRef: "shopA", shopName: "Smoke Repair", side: "repair", terms: { repairCommissionPct: 15 } });
assert.match(pInv.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
assert.equal((await call("/v1/partners/join", { method: "POST", json: { code: "AAAA-BBBB-CCCC", shopRef: "x", shopName: "Nope" } })).status, 404);
const pJoined = await send("/v1/partners/join", undefined, { code: pInv.code.toLowerCase().replace(/-/g, " "), shopRef: "retail1", shopName: "Smoke Quilt Shop" });
assert.equal(pJoined.scope, "partner");
assert.equal(pJoined.side, "retail");
assert.equal(pJoined.link.terms.repairCommissionPct, 15);
const retailKey = pJoined.installKey;
assert.equal((await call("/v1/changes", { key: retailKey })).status, 403, "partner-only installs can't read the community");
assert.equal((await get("/v1/me", retailKey)).scope, "partner");
assert.equal((await call("/v1/partners/join", { method: "POST", json: { code: pInv.code, shopRef: "y", shopName: "Again" } })).status, 404, "a code works once");
const L = pJoined.link.id;
const repairCursor0 = (await get("/v1/partners/messages?since=0&limit=500", installKey)).messages.filter((m) => m.linkId !== L).at(-1)?.seq ?? "0";
await send(`/v1/partners/links/${L}/messages`, retailKey, { id: "m1", shopRef: "retail1", type: "job.new", data: { tag: "101" } });
assert.equal((await send(`/v1/partners/links/${L}/messages`, retailKey, { id: "m1", shopRef: "retail1", type: "job.new", data: { tag: "101" } })).duplicate, true);
assert.equal((await call(`/v1/partners/links/${L}/messages`, { key: retailKey, method: "POST", json: { id: "m2", shopRef: "wrong", type: "job.new", data: {} } })).status, 404);
assert.equal((await call(`/v1/partners/links/${L}/messages`, { key: buyerKey, method: "POST", json: { id: "m3", shopRef: "retail1", type: "job.new", data: {} } })).status, 404, "outsiders can't post");
assert.equal((await call(`/v1/partners/links/${L}/messages`, { key: retailKey, method: "POST", json: { id: "m4", shopRef: "retail1", type: "Bad Type", data: {} } })).status, 400);
const repairIn = (await get(`/v1/partners/messages?since=${repairCursor0}`, installKey)).messages.filter((m) => m.linkId === L);
assert.deepEqual(repairIn.map((m) => m.type), ["link.created", "job.new"]);
assert.equal(repairIn[1].toShopRef, "shopA");
assert.equal(repairIn[1].fromSide, "retail");
await send(`/v1/partners/links/${L}/messages`, installKey, { id: "r1", shopRef: "shopA", type: "job.update", data: { tag: "101", status: "ON_BENCH" } });
const retailIn = await get("/v1/partners/messages?since=0", retailKey);
assert.deepEqual(retailIn.messages.map((m) => m.type), ["link.created", "job.update"], "a side never gets its own messages back");
assert.equal((await get(`/v1/partners/messages?since=${retailIn.next}`, retailKey)).messages.length, 0);
assert.equal((await call("/v1/partners/messages?since=0", { key: buyerKey })).status, 200);
assert.equal((await get("/v1/partners/messages?since=0", buyerKey)).messages.filter((m) => m.linkId === L).length, 0, "other members see nothing");
const pLinks = await get("/v1/partners/links", retailKey);
assert.equal(pLinks.length, 1);
assert.equal(pLinks[0].side, "retail");
assert.equal(pLinks[0].repair.name, "Smoke Repair");
// Both shops in one install (a hosted install with several companies): each gets its own copy of hub messages.
const inv2 = await send("/v1/partners/invites", installKey, { shopRef: "shopA", shopName: "Smoke Repair", side: "repair" });
assert.equal((await call("/v1/partners/redeem", { key: installKey, method: "POST", json: { code: inv2.code, shopRef: "shopA", shopName: "Smoke Repair" } })).status, 400);
const beforeSame = (await get(`/v1/partners/messages?since=${repairCursor0}&limit=500`, installKey)).next;
const sameInstall = await send("/v1/partners/redeem", installKey, { code: inv2.code, shopRef: "shopB", shopName: "Smoke Hosted Quilt" });
const both = (await get(`/v1/partners/messages?since=${beforeSame}`, installKey)).messages.filter((m) => m.linkId === sameInstall.link.id);
assert.deepEqual(both.map((m) => `${m.type}>${m.toShopRef}`).sort(), ["link.created>shopA", "link.created>shopB"]);
await send(`/v1/partners/links/${sameInstall.link.id}/messages`, installKey, { id: "h1", shopRef: "shopB", type: "order.new", data: { lines: [] } });
const toA = (await get(`/v1/partners/messages?since=${both.at(-1).seq}`, installKey)).messages;
assert.deepEqual(toA.map((m) => `${m.type}>${m.toShopRef}`), ["order.new>shopA"]);
// Big messages: a page of the feed is cut by size (by the JSON's size, not the compressed size on disk), so a shop
// never asks for more than it can take in, and the cursor always moves on.
const big = "a".repeat(4 * 1024 * 1024 - 1000);
for (let i = 0; i < 5; i++) await send(`/v1/partners/links/${sameInstall.link.id}/messages`, installKey, { id: `big${i}`, shopRef: "shopB", type: "job.new", data: { big } });
const bigPage = await get(`/v1/partners/messages?since=${toA.at(-1).seq}&limit=200`, installKey);
assert.ok(bigPage.messages.length >= 1 && bigPage.messages.length < 5, `a page of big messages is cut short (${bigPage.messages.length})`);
assert.equal(bigPage.more, true);
const bigRest = await get(`/v1/partners/messages?since=${bigPage.next}&limit=200`, installKey);
assert.ok(bigRest.messages.length >= 1 && BigInt(bigRest.next) > BigInt(bigPage.next), "the next page moves on");
// Ending: both sides hear it.
await send(`/v1/partners/links/${L}/end`, installKey, { shopRef: "shopA", note: "smoke test" });
const endMsg = (await get(`/v1/partners/messages?since=${retailIn.next}`, retailKey)).messages;
assert.equal(endMsg[0].type, "link.ended");
assert.equal(endMsg[0].data.endedBy, "repair");
assert.equal((await get("/v1/partners/links", retailKey))[0].status, "ENDED");
// An ended partnership takes no new work, only updates, payments and terms (the last statement).
assert.equal((await call(`/v1/partners/links/${L}/messages`, { key: retailKey, method: "POST", json: { id: "late1", shopRef: "retail1", type: "job.new", data: {} } })).status, 409);
assert.equal((await call(`/v1/partners/links/${L}/messages`, { key: retailKey, method: "POST", json: { id: "late2", shopRef: "retail1", type: "settle.paid", data: { netCents: 1 } } })).status, 200);
// The sewing shop later joins the community with the join key: same key, now a full member.
assert.equal((await call("/v1/upgrade", { key: retailKey, method: "POST", json: { joinKey: "wrong" } })).status, 403);
assert.equal((await send("/v1/upgrade", retailKey, { joinKey: JOIN })).scope, "member");
assert.equal((await call("/v1/changes?since=0&limit=1", { key: retailKey })).status, 200);
console.log("partners: ok");

// Admin: wrong token refused; summary, export (valid gzip, new tables included), block.
assert.equal((await call("/v1/admin/summary", { key: "wrong-token" })).status, 401);
const summary = await (await ok(await call("/v1/admin/summary", { key: ADMIN }))).json();
const { installId } = await (await ok(await call("/v1/me", { key: installKey }))).json();
const me = summary.installs.find((i) => i.id === installId && !i.blocked);
assert.ok(me);
const exp = Buffer.from(await (await ok(await call("/v1/admin/export", { key: ADMIN }))).arrayBuffer());
const lines = zlib.gunzipSync(exp).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines[0].format, "stitchhub-export");
assert.ok(lines.some((l) => l.t === "photo" && l.data));
for (const t of ["xpart", "xpart_number", "xpart_fit", "xpart_source", "xpart_revision", "listing", "listing_photo", "order", "order_event", "order_rating", "usage", "partner_link", "partner_message"]) {
  assert.ok(lines.some((l) => l.t === t), `export has ${t}`);
}
assert.ok(lines.some((l) => l.t === "xpart_revision" && l.snapshot?.id === part.id));
console.log(`export: ok (${lines.length} rows)`);

// Clean up: remove the note, link, listing and part; block the test members (blocked installs are refused).
await ok(await call(`/v1/posts/${postId}`, { key: installKey, method: "DELETE" }));
await ok(await call(`/v1/links/${link.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
await ok(await call(`/v1/listings/${listing.id}`, { key: installKey, method: "DELETE" }));
await ok(await call(`/v1/xparts/${part.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
const importedPart = [...seen.xparts.values()].find((x) => x.numbers.some((n) => n.number === `IMP${RUN}`));
if (importedPart) await ok(await call(`/v1/xparts/${importedPart.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
const all = (await (await ok(await call("/v1/admin/summary", { key: ADMIN }))).json()).installs;
for (const name of ["Smoke Buyer Shop", "Smoke Third Shop", "Smoke Quilt Shop"]) {
  for (const i of all.filter((x) => x.name === name && !x.blocked)) await ok(await call(`/v1/admin/installs/${i.id}/block`, { key: ADMIN, method: "POST", json: { blocked: true } }));
}
await ok(await call(`/v1/admin/installs/${me.id}/block`, { key: ADMIN, method: "POST", json: { blocked: true } }));
assert.equal((await call("/v1/me", { key: installKey })).status, 403);
assert.equal((await call("/v1/me", { key: buyerKey })).status, 403);
console.log("all checks passed");
