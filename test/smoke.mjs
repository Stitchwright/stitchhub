// End-to-end check of a StitchHub server. Uses a throwaway member and link, and cleans up what it can.
// usage: HUB_URL=http://localhost:8080 ADMIN_TOKEN=... JOIN_KEY=... node test/smoke.mjs
import assert from "node:assert/strict";
import zlib from "node:zlib";

const HUB = (process.env.HUB_URL ?? "http://localhost:8080").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const JOIN = process.env.JOIN_KEY;
const RUN = Date.now().toString(36); // fresh URLs each run
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

// Joining needs the right key.
assert.equal((await call("/v1/register", { method: "POST", json: { joinKey: "wrong", name: "Nope" } })).status, 403);
const { installKey } = await (await ok(await call("/v1/register", { method: "POST", json: { joinKey: JOIN, name: "Smoke Test Shop" } }))).json();
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

// Changes: everything above comes back, in order, with a cursor.
let since = "0";
const seen = { links: new Map(), posts: new Map(), figures: new Set() };
for (;;) {
  const ch = await (await ok(await call(`/v1/changes?since=${since}&limit=500`, { key: installKey }))).json();
  ch.links.forEach((l) => seen.links.set(l.id, l));
  ch.posts.forEach((p) => seen.posts.set(p.id, p));
  ch.figures.forEach((f) => seen.figures.add(f));
  since = ch.next;
  if (!ch.more) break;
}
assert.equal(seen.links.get(link.id).url, `https://example.com/${RUN}/a.pdf`);
const post = seen.posts.get(postId);
assert.ok(post.mine && post.photos.length === 1 && post.photos[0].kind === "WIRING");
assert.ok(seen.figures.has(figId));
const photo = await ok(await call(`/v1/photos/${post.photos[0].id}`, { key: installKey }));
assert.equal(Buffer.from(await photo.arrayBuffer()).length, png.length);
const again = await (await ok(await call(`/v1/changes?since=${since}`, { key: installKey }))).json();
assert.equal(again.links.length + again.posts.length + again.figures.length, 0);
console.log("changes: ok");

// Admin: wrong token refused; summary, export (valid gzip), block.
assert.equal((await call("/v1/admin/summary", { key: "wrong-token" })).status, 401);
const summary = await (await ok(await call("/v1/admin/summary", { key: ADMIN }))).json();
const { installId } = await (await ok(await call("/v1/me", { key: installKey }))).json();
const me = summary.installs.find((i) => i.id === installId && !i.blocked);
assert.ok(me);
const exp = Buffer.from(await (await ok(await call("/v1/admin/export", { key: ADMIN }))).arrayBuffer());
const lines = zlib.gunzipSync(exp).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines[0].format, "stitchhub-export");
assert.ok(lines.some((l) => l.t === "photo" && l.data));
console.log(`export: ok (${lines.length} rows)`);

// Clean up: remove the note and link, block the test member (blocked installs are refused).
await ok(await call(`/v1/posts/${postId}`, { key: installKey, method: "DELETE" }));
await ok(await call(`/v1/links/${link.id}`, { key: installKey, method: "DELETE", json: { byName: "Tester", note: "smoke test" } }));
await ok(await call(`/v1/admin/installs/${me.id}/block`, { key: ADMIN, method: "POST", json: { blocked: true } }));
assert.equal((await call("/v1/me", { key: installKey })).status, 403);
console.log("all checks passed");
