// End-to-end check of a StitchHub server. Uses throwaway members, links, parts and listings, and cleans up what it can.
// usage: HUB_URL=http://localhost:8080 ADMIN_TOKEN=... JOIN_KEY=... node test/smoke.mjs
// Run it against a TEST hub: a run joins about eight members (a hub allows ten joins an hour from one address, so a
// second run needs a restarted hub), leaves throwaway notes, links and parts behind, and posts about eight messages to
// the hub's Discord channel, so it refuses a hub that has a Discord webhook unless SMOKE_ALLOW_DISCORD=1.
// Also, to check moving a hub: IMPORT_HUB_URL=http://localhost:8081 IMPORT_ADMIN_TOKEN=... (a second, EMPTY test hub):
// the first hub's export is imported there and compared, and hostile import files are refused.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";

const HUB = (process.env.HUB_URL ?? "http://localhost:8080").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const JOIN = process.env.JOIN_KEY;
const RUN = Date.now().toString(36); // fresh URLs and part numbers each run
assert.ok(ADMIN && JOIN, "set ADMIN_TOKEN and JOIN_KEY");
const IMPORT_HUB = (process.env.IMPORT_HUB_URL ?? "").replace(/\/$/, "");
const IMPORT_ADMIN = process.env.IMPORT_ADMIN_TOKEN ?? ADMIN;

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

{
  const hub = await (await fetch(HUB + "/v1/admin/summary", { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.ok(!hub.discordWebhook || process.env.SMOKE_ALLOW_DISCORD === "1", "This hub posts to Discord and the check would post about eight messages there. Use a test hub, or set SMOKE_ALLOW_DISCORD=1.");
}
// A request with a length that is too large is refused before any of the body is read (the body itself isn't sent).
const refusedByLength = (path, key, length) =>
  new Promise((resolve) => {
    const u = new URL(HUB + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream", "Content-Length": length } }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on("error", () => resolve(0));
    req.write("x");
  });

// Joining needs the right key.
assert.equal((await call("/v1/register", { method: "POST", json: { joinKey: "wrong", name: "Nope" } })).status, 403);
const register = async (name) => (await (await ok(await call("/v1/register", { method: "POST", json: { joinKey: JOIN, name } }))).json()).installKey;
const installKey = await register("Smoke Test Shop");
assert.match(installKey, /^shk_/);
assert.equal((await call("/v1/changes")).status, 401);
// Input that isn't valid is the sender's mistake (400), never a hub error; a feed asked for with nonsense doesn't loop.
for (const body of ["null", "{oops"]) assert.equal((await call("/v1/register", { method: "POST", body, headers: { "Content-Type": "application/json" } })).status, 400, `register with ${body}`);
assert.equal((await call("/v1/links", { key: installKey, method: "POST", body: "{oops", headers: { "Content-Type": "application/json" } })).status, 400);
for (const since of ["abc", "-1", "99999999999999999999"]) assert.equal((await call(`/v1/changes?since=${since}`, { key: installKey })).status, 400, `since=${since}`);
assert.equal((await call("/v1/orders?since=abc", { key: installKey })).status, 400);
for (const limit of ["abc", "0", "-5"]) {
  assert.equal(typeof (await get(`/v1/changes?since=0&limit=${limit}`, installKey)).more, "boolean", `limit=${limit}`);
  assert.equal((await get(`/v1/orders?since=0&limit=${limit}`, installKey)).more, false);
}
// A join key pasted with spaces around it is the same key; one saved with a space inside is refused.
await send("/v1/admin/join-key", ADMIN, { joinKey: ` ${JOIN} ` }, "PUT");
assert.equal((await get("/v1/admin/summary", ADMIN)).joinKey, JOIN);
assert.equal((await call("/v1/admin/join-key", { key: ADMIN, method: "PUT", json: { joinKey: "has a space inside" } })).status, 400);
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
// Fixing a link onto another link's address, rolling back onto one, or a very long address: told, not a hub error.
const link2 = await send("/v1/links", installKey, { brand: "Janome", models: "MC9999", title: "Second link", url: `https://example.com/${RUN}/c.pdf` });
const clash = await call(`/v1/links/${link2.id}`, { key: installKey, method: "PUT", json: { ...link2, url: link.url } });
assert.equal(clash.status, 409);
assert.equal((await clash.json()).linkId, link.id);
await send(`/v1/links/${link2.id}`, installKey, { ...link2, url: `https://example.com/${RUN}/d.pdf` }, "PUT");
const link3 = await send("/v1/links", installKey, { brand: "Janome", models: "MC9998", title: "Took its old address", url: `https://example.com/${RUN}/c.pdf` });
const link2History = await get(`/v1/links/${link2.id}/history`, installKey);
const rollBack = await call(`/v1/links/${link2.id}/revert`, { key: installKey, method: "POST", json: { revisionId: link2History.at(-1).id } });
assert.equal(rollBack.status, 409);
assert.equal((await rollBack.json()).linkId, link3.id);
assert.equal((await call("/v1/links", { key: installKey, method: "POST", json: { brand: "Janome", models: "MC6700P", url: `https://example.com/${"a".repeat(9000)}` } })).status, 400);
// Two members adding the same address at the same moment: one wins, the others are told (409), none gets a hub error.
const raceUrl = `https://example.com/${RUN}/race.pdf`;
const race = await Promise.all(Array.from({ length: 6 }, () => call("/v1/links", { key: installKey, method: "POST", json: { brand: "Janome", models: "MRACE1", url: raceUrl } })));
assert.deepEqual(race.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
// "Check it again" is for links that exist, and an install can ask only so often.
assert.equal((await call("/v1/links/nope/report", { key: installKey, method: "POST", json: {} })).status, 404);
assert.equal((await call(`/v1/links/${link2.id}/report`, { key: installKey, method: "POST", json: {} })).status, 200);
console.log("links: ok");

// Notes with a photo.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const fd = new FormData();
fd.set("post", JSON.stringify({ brand: "Janome", model: "MC6700P", kind: "TIP", title: "Smoke test note", body: "Checks posting.", authorName: "Tester", photos: [{ kind: "WIRING", caption: "pin 1" }] }));
fd.append("photo", new Blob([png], { type: "image/png" }), "p.png");
const { id: postId } = await (await ok(await call("/v1/posts", { key: installKey, method: "POST", body: fd }))).json();
// The same note sent again after a lost answer (same clientId) is the one already made.
const retryNote = () => {
  const f = new FormData();
  f.set("post", JSON.stringify({ brand: "Janome", model: "MC6700P", title: "Retried note", body: "Sent twice.", clientId: `note-${RUN}` }));
  return call("/v1/posts", { key: installKey, method: "POST", body: f });
};
const retriedId = (await (await ok(await retryNote())).json()).id;
assert.equal((await (await ok(await retryNote())).json()).id, retriedId);
console.log("notes: ok");

// Figures.
const figId = crypto.randomBytes(12).toString("hex"); // its own each run: figures are shared and kept
await ok(await call(`/v1/figures/${figId}?w=1&h=1`, { key: installKey, method: "PUT", body: png, headers: { "Content-Type": "image/png" } }));
assert.equal((await ok(await call(`/v1/figures/${figId}`, { key: installKey }))).headers.get("content-type"), "image/png");
// The first shop to share a figure keeps it; another shop's copy is not stored.
const buyerKey = await register("Smoke Buyer Shop");
const otherFig = await (await ok(await call(`/v1/figures/${figId}?w=1&h=1`, { key: buyerKey, method: "PUT", body: png, headers: { "Content-Type": "image/png" } }))).json();
assert.equal(otherFig.stored, false);
// Bodies over a route's limit are refused (413): a join is 16 KB, a figure 2 MB, a note 37 MB, a listing 25 MB.
assert.equal((await call("/v1/register", { method: "POST", json: { joinKey: "x", name: "x".repeat(17 * 1024) } })).status, 413);
assert.equal((await call(`/v1/figures/${crypto.randomBytes(12).toString("hex")}`, { key: installKey, method: "PUT", body: Buffer.alloc(2 * 1024 * 1024 + 1), headers: { "Content-Type": "image/png" } })).status, 413);
if (HUB.startsWith("http:")) {
  assert.equal(await refusedByLength("/v1/posts", installKey, 40 * 1024 * 1024), 413);
  assert.equal(await refusedByLength("/v1/listings", installKey, 30 * 1024 * 1024), 413);
}
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
assert.equal((await call(`/v1/xparts/${part.id}`, { key: installKey, method: "PUT", json: { ...part, sources: [{ vendor: "Typo", priceCents: 3_000_000_000 }] } })).status, 400); // a price no int can hold
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
const listingForm = new FormData();
listingForm.set(
  "listing",
  JSON.stringify({ title: `Smoke bobbin case ${RUN}`, kind: "PART", condition: "USED", brand: "Brother", partNumber: nA, xpartId: part.id, priceCents: 1500, qty: 3, shippingCents: 500, shipsFrom: "Testville, TS" }),
);
listingForm.append("photo", new Blob([png], { type: "image/png" }), "l.png");
const listing = await (await ok(await call("/v1/listings", { key: installKey, method: "POST", body: listingForm }))).json();
assert.ok(listing.mine && listing.photos.length === 1 && listing.status === "ACTIVE");
for (const bad of [{ priceCents: 3_000_000_000 }, { qty: 2_000_000_000 }, { shippingCents: 3_000_000_000 }]) {
  const f = new FormData();
  f.set("listing", JSON.stringify({ title: "Too much", priceCents: 100, qty: 1, ...bad }));
  assert.equal((await call("/v1/listings", { key: installKey, method: "POST", body: f })).status, 400, JSON.stringify(bad));
}
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
// A seller's standing travels with its listings, so they go out again only when the standing changes (rating again with
// the same stars sends nothing), and ratings from an install the hub admin blocked stop counting.
{
  const feedEnd = async (key) => {
    let at = "0";
    for (;;) {
      const ch = await get(`/v1/changes?since=${at}&limit=2000`, key);
      at = ch.next;
      if (!ch.more) return at;
    }
  };
  const sellersSince = async (key, at) => (await get(`/v1/changes?since=${at}&limit=2000`, key)).listings.filter((l) => l.sellerId === sellerId);
  let at = await feedEnd(buyerKey);
  await send(`/v1/orders/${order.id}/rate`, buyerKey, { stars: 3, comment: "fine" });
  assert.deepEqual(await sellersSince(buyerKey, at), [], "the same rating again sends the seller's listings again");
  const sockKey = await register("Smoke Sock Shop");
  const lf2 = new FormData();
  lf2.set("listing", JSON.stringify({ title: `Sock target ${RUN}`, priceCents: 1000, qty: 5, shippingCents: 0 }));
  const target = await (await ok(await call("/v1/listings", { key: installKey, method: "POST", body: lf2 }))).json();
  let sock = await send("/v1/orders", sockKey, { listingId: target.id, qty: 1, ...ship });
  sock = await send(`/v1/orders/${sock.id}/accept`, installKey, { payInstructions: "x" });
  await send(`/v1/orders/${sock.id}/paid`, installKey, {});
  await send(`/v1/orders/${sock.id}/rate`, sockKey, { stars: 1 });
  at = await feedEnd(buyerKey);
  assert.deepEqual((await get(`/v1/reputation/${sellerId}`, buyerKey)).asSeller, { avg: 2, count: 2 });
  await send(`/v1/admin/installs/${(await get("/v1/me", sockKey)).installId}/block`, ADMIN, { blocked: true });
  assert.deepEqual((await get(`/v1/reputation/${sellerId}`, buyerKey)).asSeller, { avg: 3, count: 1 }, "a blocked install's rating counts");
  assert.ok((await sellersSince(buyerKey, at)).every((l) => l.sellerRating.count === 1) && (await sellersSince(buyerKey, at)).length > 0, "listings are sent again with the standing without it");
  await ok(await call(`/v1/listings/${target.id}`, { key: installKey, method: "DELETE" }));
}
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
await send("/v1/usage", thirdKey, {
  month: ym(0),
  items: [
    { number: u1, brand: UB, qty: 5, tickets: 1 },
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
assert.equal(top.shops, 3);
// Only what at least three shops used is listed (one shop's own counts are not the community's): u2 was used by one.
// A test hub for StitchBench's specs lowers the threshold (USAGE_MIN_SHOPS=1): those checks need the usual 3.
if (top.minShops === 3) {
  assert.deepEqual(
    top.items.map((i) => [i.numberKey, i.number, i.qty, i.tickets, i.shops]),
    [[nk(u1), u1, 15, 6, 3]], // one row per number: the spelling most shops used
  );
  // A window or brand with fewer than three reporting shops shows nothing, not one shop's counts (two reported this month).
  const thisMonth = await get(`/v1/usage/top?months=1&brand=${UB}`, installKey);
  assert.deepEqual([thisMonth.shops, thisMonth.items], [0, []]);
} else {
  console.log(`usage: this hub lists a part used by ${top.minShops} shop(s); the checks for the usual 3 are skipped`);
  assert.deepEqual(top.items[0].numberKey, nk(u1));
}
const brotherTop = await get("/v1/usage/top?months=12&brand=brother&limit=1000", installKey);
const screw = brotherTop.items.find((i) => i.numberKey === nk(nA));
assert.deepEqual([screw.qty, screw.shops, screw.xpartId, screw.name], [4, 3, part.id, "Smoke screw"]);
assert.equal(top.items[0].xpartId, null);
// One number sent many times in a report is added up but capped at what a count holds, not refused with a hub error.
{
  const big = Array.from({ length: 3 }, (_, i) => ({ number: `BIG${RUN}`, brand: UB, qty: 1_000_000, tickets: i }));
  for (const key of [installKey, buyerKey, thirdKey]) await send("/v1/usage", key, { month: ym(3), items: [...big, ...big, ...big] });
  const capped = (await get(`/v1/usage/top?months=12&brand=${UB}`, installKey)).items.find((i) => i.numberKey === nk(`BIG${RUN}`));
  assert.deepEqual([capped.qty, capped.shops], [3_000_000, 3]);
}
console.log("usage: ok");

// One install holding several companies: each lists, orders, is rated and reports usage under its own name.
{
  const lf = (json) => {
    const f = new FormData();
    f.set("listing", JSON.stringify(json));
    return f;
  };
  const coList = { title: `Company B foot ${RUN}`, priceCents: 700, qty: 2, shippingCents: 0, shopRef: "coB", shopName: "Company B", clientId: `cl-${RUN}` };
  const coL = await (await ok(await call("/v1/listings", { key: installKey, method: "POST", body: lf(coList) }))).json();
  assert.deepEqual([coL.shopName, coL.shopRef, coL.mine], ["Company B", "coB", true]);
  const coAgain = await (await ok(await call("/v1/listings", { key: installKey, method: "POST", body: lf(coList) }))).json();
  assert.equal(coAgain.id, coL.id); // sent again after a lost answer: the same listing
  assert.equal((await call("/v1/orders", { key: installKey, method: "POST", json: { listingId: coL.id, qty: 1, shopRef: "coA", ...ship } })).status, 409); // same install
  const coOrder = { listingId: coL.id, qty: 1, shopRef: "buyerCo", shopName: "Buyer Company", clientId: `oc-${RUN}`, ...ship };
  let co = await send("/v1/orders", buyerKey, coOrder);
  assert.deepEqual([co.sellerShop, co.sellerShopRef, co.buyerShop, co.buyerShopRef], ["Company B", "coB", "Buyer Company", "buyerCo"]);
  assert.equal((await send("/v1/orders", buyerKey, coOrder)).id, co.id);
  // A quantity typed over one an accept changed is refused.
  co = await send(`/v1/orders/${co.id}/accept`, installKey, { payInstructions: "Zelle B" });
  assert.equal((await call(`/v1/listings/${coL.id}`, { key: installKey, method: "PUT", json: { qty: 5, expectedQty: 2 } })).status, 409);
  assert.equal((await send(`/v1/listings/${coL.id}`, installKey, { qty: 5, expectedQty: 1 }, "PUT")).qty, 5);
  // The seller marks it paid and rates the buyer, then cancels: the buyer can still answer.
  co = await send(`/v1/orders/${co.id}/paid`, installKey, {});
  co = await send(`/v1/orders/${co.id}/rate`, installKey, { stars: 1, comment: "never paid" });
  co = await send(`/v1/orders/${co.id}/cancel`, installKey, { reason: "smoke" });
  co = await send(`/v1/orders/${co.id}/rate`, buyerKey, { stars: 2, comment: "marked paid without it" });
  assert.equal(co.ratings.buyer.stars, 2);
  const coRep = await get(`/v1/reputation/${sellerId}?shopRef=coB`, buyerKey);
  assert.deepEqual(coRep.asSeller, { avg: 2, count: 1 });
  assert.deepEqual((await get(`/v1/reputation/${sellerId}`, buyerKey)).asSeller, { avg: 3, count: 1 }); // the install's own, apart
  assert.deepEqual((await get(`/v1/reputation/${buyerId}?shopRef=buyerCo`, installKey)).asBuyer, { avg: 1, count: 1 });
  // Taking a listing down declines the orders still waiting on it.
  let waiting = await send("/v1/orders", buyerKey, { listingId: coL.id, qty: 1, ...ship });
  await ok(await call(`/v1/listings/${coL.id}`, { key: installKey, method: "DELETE" }));
  waiting = (await get("/v1/orders?since=0", buyerKey)).orders.find((o) => o.id === waiting.id);
  assert.equal(waiting.status, "DECLINED");
  // A blocked seller's listings show paused and take no orders; its waiting orders are declined.
  const sellerKey2 = thirdKey;
  const sellerId2 = (await get("/v1/me", sellerKey2)).installId;
  const bl = await (await ok(await call("/v1/listings", { key: sellerKey2, method: "POST", body: lf({ title: `Blocked ${RUN}`, priceCents: 100, qty: 3 }) }))).json();
  const pending = await send("/v1/orders", buyerKey, { listingId: bl.id, qty: 1, ...ship });
  await send(`/v1/admin/installs/${sellerId2}/block`, ADMIN, { blocked: true });
  assert.equal((await call("/v1/orders", { key: buyerKey, method: "POST", json: { listingId: bl.id, qty: 1, ...ship } })).status, 409);
  const fromFeed = (await get("/v1/changes?since=0&limit=2000", buyerKey)).listings.find((l) => l.id === bl.id);
  if (fromFeed) assert.equal(fromFeed.status, "PAUSED");
  assert.equal((await get("/v1/orders?since=0", buyerKey)).orders.find((o) => o.id === pending.id).status, "DECLINED");
  await send(`/v1/admin/installs/${sellerId2}/block`, ADMIN, { blocked: false });
  // Usage per company; a company that stops sharing takes its counts back.
  const uc = `UC-${RUN}`;
  await send("/v1/usage", installKey, { month: ym(0), shopRef: "coB", items: [{ number: uc, brand: UB, qty: 2, tickets: 1 }] });
  await send("/v1/usage", installKey, { month: ym(0), shopRef: "coC", items: [{ number: uc, brand: UB, qty: 3, tickets: 1 }] });
  await send("/v1/usage", buyerKey, { month: ym(0), items: [{ number: uc, brand: UB, qty: 4, tickets: 1 }] });
  await send("/v1/usage", thirdKey, { month: ym(0), items: [{ number: uc, brand: UB, qty: 1, tickets: 1 }] });
  let ucTop = (await get(`/v1/usage/top?months=1&brand=${UB}`, buyerKey)).items.find((i) => i.numberKey === nk(uc));
  assert.deepEqual([ucTop.qty, ucTop.shops], [10, 4]); // two companies on one install count as two shops
  await send("/v1/usage", installKey, { shopRef: "coC", off: true });
  ucTop = (await get(`/v1/usage/top?months=1&brand=${UB}`, buyerKey)).items.find((i) => i.numberKey === nk(uc));
  assert.deepEqual([ucTop.qty, ucTop.shops], [7, 3]);
  // A one-company install claims what it did before it said which company it is.
  const claimKey = await register("Smoke Claim Shop");
  const cl = await (await ok(await call("/v1/listings", { key: claimKey, method: "POST", body: lf({ title: `Claim ${RUN}`, priceCents: 100, qty: 1 }) }))).json();
  assert.equal(cl.shopRef, null);
  assert.equal((await send("/v1/shops/claim", claimKey, { shopRef: "only" })).listings, 1);
  assert.equal((await get("/v1/changes?since=0&limit=2000", claimKey)).listings.find((l) => l.id === cl.id)?.shopRef ?? "only", "only");
}
console.log("companies: ok");

// Cross-reference safeguards: an edit from an out-of-date copy is refused; rolling back past a merge gives the
// merged-away part back.
{
  const xa = await send("/v1/xparts", installKey, { name: "Guard A", numbers: [{ brand: "Juki", number: `GA${RUN}` }], byName: "Tester" });
  const fresh = await get(`/v1/xparts/${xa.id}`, installKey);
  assert.equal(fresh.updatedAt, xa.updatedAt);
  await send(`/v1/xparts/${xa.id}`, installKey, { ...xa, specs: "first", baseUpdatedAt: xa.updatedAt }, "PUT");
  const stale = await call(`/v1/xparts/${xa.id}`, { key: installKey, method: "PUT", json: { ...xa, specs: "second", baseUpdatedAt: xa.updatedAt } });
  assert.equal(stale.status, 409);
  const xb = await send("/v1/xparts", installKey, { name: "Guard B", numbers: [{ brand: "Juki", number: `GB${RUN}` }], fits: [{ brand: "Juki", model: "TL2010Q" }], byName: "Tester" });
  const before = (await get(`/v1/xparts/${xa.id}/history`, installKey))[0];
  await send(`/v1/xparts/${xb.id}/merge`, installKey, { intoId: xa.id, byName: "Tester" });
  const back = await send(`/v1/xparts/${xa.id}/revert`, installKey, { revisionId: before.id, byName: "Tester" });
  assert.equal(back.numbers.length, 1);
  const xbBack = await get(`/v1/xparts/${xb.id}`, installKey);
  assert.deepEqual([xbBack.deleted, xbBack.numbers.length, xbBack.fits.length], [false, 1, 1]);
}
// A part's history comes a page at a time, newest first, and says when there are older versions.
{
  let cur = await send("/v1/xparts", installKey, { name: "Paged", numbers: [{ brand: "Juki", number: `PG${RUN}` }], byName: "Tester" });
  const partId = cur.id;
  for (let i = 0; i < 52; i++) cur = await send(`/v1/xparts/${partId}`, installKey, { ...cur, specs: `edit ${i}`, baseUpdatedAt: cur.updatedAt }, "PUT");
  const r1 = await call(`/v1/xparts/${partId}/history`, { key: installKey });
  const page1 = await r1.json();
  assert.deepEqual([page1.length, r1.headers.get("x-history-more"), page1[0].snapshot.specs], [50, "1", "edit 51"]);
  const r2 = await call(`/v1/xparts/${partId}/history?before=${page1.at(-1).id}`, { key: installKey });
  const page2 = await r2.json();
  assert.deepEqual([page2.length, page2.at(-1).action, r2.headers.get("x-history-more")], [3, "added", null]);
  await ok(await call(`/v1/xparts/${partId}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
}
console.log("parts safeguards: ok");

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
assert.equal((await send("/v1/upgrade", retailKey, { joinKey: `${JOIN} ` })).scope, "member"); // a pasted trailing space is fine
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

// Moving a hub: the export imported into a second, empty test hub brings everything with the same change numbers, and
// the members' keys and notes' client ids still work; importing it again changes nothing; hostile files are refused.
if (!IMPORT_HUB) console.log("import: skipped (set IMPORT_HUB_URL to an empty test hub to check moving a hub)");
else {
  const into = (body) => fetch(IMPORT_HUB + "/v1/admin/import", { method: "POST", headers: { Authorization: `Bearer ${IMPORT_ADMIN}`, Connection: "close" }, body });
  const there = (path, key) => fetch(IMPORT_HUB + path, { headers: { Authorization: `Bearer ${key}` } });
  const first = await (await ok(await into(exp))).json();
  const counts = async (base, token) => (await (await ok(await fetch(base + "/v1/admin/summary", { headers: { Authorization: `Bearer ${token}` } }))).json()).counts;
  assert.deepEqual(await counts(IMPORT_HUB, IMPORT_ADMIN), await counts(HUB, ADMIN), "row counts after the move");
  const allChanges = async (base, key) => {
    const ids = [];
    let at = "0";
    for (;;) {
      const ch = await (await ok(await fetch(`${base}/v1/changes?since=${at}&limit=2000`, { headers: { Authorization: `Bearer ${key}` } }))).json();
      ids.push(...ch.links.map((l) => l.id), ...ch.posts.map((p) => p.id), ...ch.xparts.map((x) => x.id), ...ch.listings.map((l) => l.id));
      at = ch.next;
      if (!ch.more) return { ids: ids.sort(), next: at };
    }
  };
  assert.deepEqual(await allChanges(IMPORT_HUB, installKey), await allChanges(HUB, installKey), "the same rows, and the feed ends at the same change number");
  // The same file again replaces the same rows (into a hub in use they are numbered as new changes): nothing is added.
  assert.deepEqual(await (await ok(await into(exp))).json(), first, "importing the same file again");
  assert.deepEqual(await counts(IMPORT_HUB, IMPORT_ADMIN), await counts(HUB, ADMIN), "row counts after importing twice");
  assert.equal((await there("/v1/me", installKey)).status, 200, "a member's key from the old hub works on the new one");
  const retried = new FormData();
  retried.set("post", JSON.stringify({ brand: "Janome", model: "MC6700P", title: "Retried note", body: "Sent twice.", clientId: `note-${RUN}` }));
  const onNew = await (await ok(await fetch(IMPORT_HUB + "/v1/posts", { method: "POST", headers: { Authorization: `Bearer ${installKey}` }, body: retried }))).json();
  assert.equal(onNew.id, retriedId, "a note sent again after the move is not made a second time");
  // A gzip of a few hundred KB can hold one line of hundreds of MB, and a file from someone else isn't trusted: refused, hub up.
  const gzLines = (rows) => zlib.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  const meta = { t: "meta", format: "stitchhub-export", version: 3, changeSeq: "1", partnerSeq: "1" };
  assert.equal((await into(zlib.gzipSync(Buffer.alloc(65 * 1024 * 1024, 97)))).status, 413);
  for (const row of [
    { t: "link", id: "evil1", brand: "B", models: "M", title: "t", url: "javascript:alert(1)" },
    { t: "setting", key: "discord_webhook", value: "https://evil.example/hook" },
    { t: "figure", id: "evil2", mime: "text/html", data: "eA==" },
  ]) {
    assert.equal((await into(gzLines([meta, row]))).status, 400, JSON.stringify(row));
  }
  assert.equal((await fetch(IMPORT_HUB + "/health", { headers: { Connection: "close" } })).status, 200);
  console.log("import: ok");
}

// Clean up: remove the note, link, listing and part; block the test members (blocked installs are refused).
await ok(await call(`/v1/posts/${postId}`, { key: installKey, method: "DELETE" }));
await ok(await call(`/v1/links/${link.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
await ok(await call(`/v1/listings/${listing.id}`, { key: installKey, method: "DELETE" }));
// A removed note and a removed listing take their photos back.
assert.equal((await call(`/v1/photos/${post.photos[0].id}`, { key: buyerKey })).status, 404);
assert.equal((await call(`/v1/listing-photos/${listing.photos[0].id}`, { key: buyerKey })).status, 404);
await ok(await call(`/v1/admin/figures/${figId}`, { key: ADMIN, method: "DELETE" }));
await ok(await call(`/v1/partners/links/${sameInstall.link.id}/end`, { key: installKey, method: "POST", json: { shopRef: "shopA", note: "smoke test" } }));
await ok(await call(`/v1/xparts/${part.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
const importedPart = [...seen.xparts.values()].find((x) => x.numbers.some((n) => n.number === `IMP${RUN}`));
if (importedPart) await ok(await call(`/v1/xparts/${importedPart.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
const all = (await (await ok(await call("/v1/admin/summary", { key: ADMIN }))).json()).installs;
for (const name of ["Smoke Buyer Shop", "Smoke Third Shop", "Smoke Quilt Shop", "Smoke Claim Shop", "Smoke Sock Shop"]) {
  for (const i of all.filter((x) => x.name === name && !x.blocked)) await ok(await call(`/v1/admin/installs/${i.id}/block`, { key: ADMIN, method: "POST", json: { blocked: true } }));
}
await ok(await call(`/v1/admin/installs/${me.id}/block`, { key: ADMIN, method: "POST", json: { blocked: true } }));
assert.equal((await call("/v1/me", { key: installKey })).status, 403);
assert.equal((await call("/v1/me", { key: buyerKey })).status, 403);
console.log("all checks passed");
