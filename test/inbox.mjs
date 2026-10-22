// Checks the StitchFoundry inbox (src/inbox.mjs, docs/plan.md "StitchFoundry inbox"): a hub of its own on a free port against a
// scratch database, the Foundry Account service stand-in (test/foundry-mock.mjs: it answers whose token this is) and an S3 stand-in
// that VERIFIES every presigned request, as test/backup.mjs does. Covers: off unless FOUNDRY_SIGNIN is on; the sender's token
// (none, malformed, unknown to the service, a Foundry Account no hub account is linked to); put (bad names, sizes, hashes and shops
// refused; a signed address for the account's own prefix), upload and done (the hub looks at the object and its size), what the
// shop sees (confirmed files only, any shop of the account, or the one it was addressed to, never another account's), get, take
// (it leaves the list and the bucket, once), retract, the limits on files and bytes, the sweep (unfinished, expired and taken
// files go from the bucket), what StitchFoundry says about a file (cleaned, unknown keys dropped), and a second account unable to
// touch the first's files.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/inbox.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { startFoundryMock } from "./foundry-mock.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "inbox-test-admin-token";
const JOIN = "join-inbox-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_ID = "TESTKEYID";
const SECRET = "test-secret-key";
const REGION = "auto";
const BUCKET = "backups";

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));

// ----- the bucket stand-in: path-style, verifies SigV4 query auth independently of src/s3.mjs -----
const store = new Map(); // key -> Buffer
const refused = [];
const failDeletes = new Set(); // keys whose DELETE the bucket answers with a 500
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function verify(req, url) {
  const q = url.searchParams;
  const sig = q.get("X-Amz-Signature");
  if (!sig) return "no signature";
  if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return "algorithm";
  const [keyId, date, region, svc, term] = (q.get("X-Amz-Credential") ?? "").split("/");
  if (keyId !== KEY_ID || region !== REGION || svc !== "s3" || term !== "aws4_request") return "credential";
  const stamp = q.get("X-Amz-Date") ?? "";
  if (!stamp.startsWith(date)) return "date";
  const issued = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
  if (Date.now() > issued + Number(q.get("X-Amz-Expires")) * 1000) return "expired";
  if (Number(q.get("X-Amz-Expires")) > 3600) return "too long";
  const params = [...q.entries()].filter(([k]) => k !== "X-Amz-Signature").sort(([a], [b]) => (a < b ? -1 : 1));
  // Every signed header is read from the request as it arrived (a PUT of another size has another content-length).
  const names = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
  if (!names.includes("host")) return "host not signed";
  if (req.method === "PUT" && !names.includes("content-length")) return "content-length not signed";
  const headerLines = names.map((n) => `${n}:${String(req.headers[n] ?? "").trim()}\n`).join("");
  const canonical = [req.method, url.pathname.split("/").map((s) => enc(decodeURIComponent(s))).join("/"), params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"), headerLines, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, `${date}/${region}/s3/aws4_request`, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
  const want = crypto.createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), region), "s3"), "aws4_request")).update(toSign).digest("hex");
  return want === sig ? null : "signature mismatch";
}
const s3port = await freePort();
const s3 = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${s3port}`);
  const bad = verify(req, url);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (bad) {
      refused.push(bad);
      res.writeHead(403).end(bad);
      return;
    }
    const key = decodeURIComponent(url.pathname).replace(`/${BUCKET}/`, "");
    if (req.method === "PUT") {
      const body = Buffer.concat(chunks);
      const sum = req.headers["x-amz-checksum-sha256"];
      if (sum && crypto.createHash("sha256").update(body).digest("base64") !== sum) {
        refused.push("checksum");
        res.writeHead(400).end("BadDigest");
        return;
      }
      store.set(key, body);
      res.writeHead(200).end();
    } else if (req.method === "GET") {
      const b = store.get(key);
      if (!b) res.writeHead(404).end();
      else res.writeHead(200, { "Content-Length": b.length }).end(b);
    } else if (req.method === "HEAD") {
      const b = store.get(key);
      if (!b) res.writeHead(404).end();
      else res.writeHead(200, { "Content-Length": b.length }).end();
    } else if (req.method === "DELETE") {
      if (failDeletes.has(key)) return res.writeHead(500).end("InternalError");
      store.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
});
await new Promise((r) => s3.listen(s3port, "127.0.0.1", r));

async function startHub(extraEnv = {}) {
  const port = await freePort();
  const hub = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: DB,
      ADMIN_TOKEN: ADMIN,
      JOIN_KEY: JOIN,
      PORT: String(port),
      LINK_CHECKER: "off", PROGRAM_FREE: "off",
      TRUST_PROXY: "true", // the limits per address see the test's addresses in X-Forwarded-For (none sent: 127.0.0.1)
      RAILWAY_ENVIRONMENT_ID: "",
      HUB_NAME: "Inbox Test Hub",
      SMTP_URL: "smtp://127.0.0.1:9", // never used: the account routes only need mail to be set up
      MAIL_FROM: "hub@example.test",
      HUB_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  hub.stdout.on("data", (d) => (log += d));
  hub.stderr.on("data", (d) => (log += d));
  for (let i = 0; ; i++) {
    if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error(`the hub didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { hub, HUB: `http://127.0.0.1:${port}` };
}

const foundry = await startFoundryMock({ port: 0, firstId: 8_000_000 + Math.floor(Math.random() * 1_000_000) });
const s3env = { BACKUP_S3_ENDPOINT: `http://127.0.0.1:${s3port}`, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: SECRET, BACKUP_S3_REGION: REGION };
// Four files and about 3 KB an account: small enough to reach. The sweep runs every 1.5 s, so a take that leaves the object to it is seen.
const limits = { INBOX_MAX_ITEMS: "4", INBOX_QUOTA_MB: "0.003", INBOX_SWEEP_MS: "1500" };
let { hub, HUB } = await startHub({ ...s3env, ...limits, FOUNDRY_SIGNIN: "on", FOUNDRY_CLOUD_URL: foundry.url });
const db = new pg.Pool({ connectionString: DB, max: 2 });
process.on("exit", () => hub.kill());

async function call(p, { key, token, method = "GET", json, base = HUB } = {}) {
  return fetch(base + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
}
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const okJson = (r, what = "request") => status(r, 200, what);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const register = async (name) => okJson(await call("/v1/register", { json: { joinKey: JOIN, name } }));
const claim = async (key, shopRef, shopName) => okJson(await call("/v1/shops/claim", { key, json: { shopRef, shopName, kind: "retail", program: "StitchShop", version: "1.7.0", sole: false } }));
const seeded = async (email) => (await (await fetch(`${foundry.url}/__seed`, { method: "POST", body: JSON.stringify({ email, password: "fire truck 1" }) })).json()).id;
const tokenOf = async (email) => (await (await fetch(`${foundry.url}/v1/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fire truck 1" }) })).json()).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await sleep(150);
  }
  assert.fail(`waited for ${what}`);
};
const put = (token, buf, extra = {}) => call("/v1/inbox/put", { token, json: { fileName: "logo.dst", size: buf.length, sha256: sha(buf), ...extra } });
/** The whole send: an address, the bytes to it, then done. */
async function send(token, buf, extra = {}) {
  const a = await okJson(await put(token, buf, extra), "put");
  assert.equal(a.method, "PUT");
  const r = await fetch(a.url, { method: "PUT", body: buf, headers: a.headers });
  assert.equal(r.status, 200, "the bucket took it");
  await okJson(await call("/v1/inbox/done", { token, json: { id: a.id } }), "done");
  return a.id;
}
const list = async (key, shopRef) => okJson(await call(`/v1/inbox/list?shopRef=${shopRef}`, { key }), `list ${shopRef}`);
const fetchUrl = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

try {
  // ----- who is who -----
  const fa = await seeded(`inbox-a-${RUN}@example.test`);
  const fb = await seeded(`inbox-b-${RUN}@example.test`);
  await seeded(`inbox-c-${RUN}@example.test`); // a Foundry Account no hub account is linked to
  const tokA = await tokenOf(`inbox-a-${RUN}@example.test`);
  const tokB = await tokenOf(`inbox-b-${RUN}@example.test`);
  const tokC = await tokenOf(`inbox-c-${RUN}@example.test`);
  const X = await register(`Hosted ${RUN}`);
  const Y = await register(`Other ${RUN}`);
  await claim(X.installKey, "a1", "A One Sewing");
  await claim(X.installKey, "a2", "A Two Quilts");
  await claim(X.installKey, "loose", "Nobody's"); // claimed, no account
  await claim(Y.installKey, "b1", "B One Repair");
  const accA = `acc_a_${RUN}`;
  const accB = `acc_b_${RUN}`;
  await db.query(`INSERT INTO accounts (id, email, foundry_id, verified_at) VALUES ($1, $2, $3, now()), ($4, $5, $6, now())`, [accA, `hub-a-${RUN}@example.test`, fa, accB, `hub-b-${RUN}@example.test`, fb]);
  const shopId = async (ref) => (await db.query(`SELECT id FROM shops WHERE shop_ref = $1 AND install_id IN (SELECT id FROM installs WHERE name = ANY($2))`, [ref, [`Hosted ${RUN}`, `Other ${RUN}`]])).rows[0].id;
  const [sA1, sA2, sB1] = [await shopId("a1"), await shopId("a2"), await shopId("b1")];
  await db.query(`UPDATE shops SET account_id = $2 WHERE id = ANY($1)`, [[sA1, sA2], accA]);
  await db.query(`UPDATE shops SET account_id = $2 WHERE id = $1`, [sB1, accB]);

  // ----- the sender's token -----
  const bytes1 = crypto.randomBytes(900);
  await status(await put(undefined, bytes1), 401, "no token");
  await status(await put("not-a-token", bytes1), 401, "a malformed token");
  await status(await put(`sfs_${"0".repeat(64)}`, bytes1), 401, "a token the service doesn't know");
  const none = await status(await put(tokC, bytes1), 404, "a Foundry Account with no hub account");
  assert.match(none.error, /No StitchHub account is linked/);
  console.log("  ok  the sender's token: none, malformed, unknown to the service and a Foundry Account no hub account is linked to are all refused");

  // ----- put, refusals -----
  await status(await call("/v1/inbox/put", { token: tokA, json: { fileName: "../etc/passwd", size: 10, sha256: sha(bytes1) } }), 400, "a path as the name");
  await status(await call("/v1/inbox/put", { token: tokA, json: { fileName: "a.dst", size: 0, sha256: sha(bytes1) } }), 400, "an empty file");
  await status(await call("/v1/inbox/put", { token: tokA, json: { fileName: "a.dst", size: 11 * 1024 * 1024, sha256: sha(bytes1) } }), 400, "over 10 MB");
  await status(await call("/v1/inbox/put", { token: tokA, json: { fileName: "a.dst", size: 10, sha256: "xyz" } }), 400, "a bad hash");
  await status(await put(tokA, bytes1, { toShopId: sB1 }), 404, "a shop of another account");
  console.log("  ok  put refuses a path as a name, an empty or over-10-MB file, a bad hash and another account's shop");

  // ----- upload, done, what the shop sees -----
  const a = await okJson(await put(tokA, bytes1, { meta: { job: "J-14", stitches: 5000, colors: 2, widthMm: 62.46, heightMm: 40, evil: "<script>", threads: ["Red 1147", 7, "White"], quantity: "24", notes: "x".repeat(900), due: "soon" } }));
  assert.equal((await list(X.installKey, "a1")).items.length, 0, "an address nobody has used is not in the inbox");
  assert.equal((await fetch(a.url, { method: "PUT", body: crypto.randomBytes(900), headers: a.headers })).status, 400, "other bytes of the same size: the store refuses them");
  assert.equal((await fetch(a.url, { method: "PUT", body: bytes1 })).status, 403, "without the checksum header the signature doesn't match");
  await status(await call("/v1/inbox/done", { token: tokA, json: { id: a.id } }), 409, "done before the upload");
  assert.equal((await fetch(a.url, { method: "PUT", body: bytes1, headers: a.headers })).status, 200);
  await okJson(await call("/v1/inbox/done", { token: tokA, json: { id: a.id } }));
  const l1 = await list(X.installKey, "a1");
  assert.equal(l1.linked, true);
  assert.equal(l1.items.length, 1);
  const it = l1.items[0];
  assert.deepEqual([it.fileName, it.size, it.sha256], ["logo.dst", 900, sha(bytes1)]);
  assert.deepEqual(it.meta, { job: "J-14", notes: "x".repeat(500), stitches: 5000, colors: 2, quantity: 24, widthMm: 62.5, heightMm: 40, threads: ["Red 1147", "7", "White"] }, "what StitchFoundry said, cleaned: unknown keys and a bad date dropped, numbers checked, long text cut");
  assert.equal((await list(X.installKey, "a2")).items.length, 1, "any other shop of the same account sees it too");
  assert.equal((await list(Y.installKey, "b1")).items.length, 0, "another account's shop does not");
  assert.deepEqual(await list(X.installKey, "loose"), { linked: false, items: [] }, "a shop with no account: nothing, and it is told");
  assert.deepEqual(refused, ["checksum", "signature mismatch"], "the bucket refused the two uploads that should be refused and nothing else");
  console.log("  ok  put, upload and done: a signed address for the account's own prefix; only confirmed files show; any shop of the account sees it, another account's does not; what StitchFoundry said is cleaned");

  // ----- addressed to one shop -----
  const bytes2 = crypto.randomBytes(500);
  const only2 = await send(tokA, bytes2, { fileName: "sleeve.dst", toShopId: sA2 });
  assert.deepEqual((await list(X.installKey, "a1")).items.map((i) => i.fileName), ["logo.dst"], "a file addressed to the other shop isn't shown to this one");
  assert.deepEqual((await list(X.installKey, "a2")).items.map((i) => i.fileName).sort(), ["logo.dst", "sleeve.dst"]);
  const shops = await okJson(await call("/v1/inbox/shops", { token: tokA }));
  assert.deepEqual(shops.shops.map((s) => s.name), ["A One Sewing", "A Two Quilts"], "the sender can see which shops it may address");
  await status(await call("/v1/inbox/get", { key: X.installKey, json: { shopRef: "a1", id: only2 } }), 404, "a1 asks for a2's file");
  console.log("  ok  a file addressed to one shop is shown to that shop only; the sender lists the account's shops");

  // ----- get and take -----
  const got = await okJson(await call("/v1/inbox/get", { key: X.installKey, json: { shopRef: "a1", id: a.id } }));
  assert.ok((await fetchUrl(got.url)).equals(bytes1), "a signed download address gives the bytes back");
  assert.equal((await fetch(got.url, { method: "PUT", body: Buffer.alloc(1) })).status, 403, "a download address can't write");
  await status(await call("/v1/inbox/get", { key: Y.installKey, json: { shopRef: "b1", id: a.id } }), 404, "another account's shop asks for the file");
  await status(await call("/v1/inbox/take", { key: Y.installKey, json: { shopRef: "b1", id: a.id } }), 404, "another account's shop takes the file");
  assert.ok(store.has(`inbox/${accA}/${a.id}`), "still there after B tried");
  await okJson(await call("/v1/inbox/take", { key: X.installKey, json: { shopRef: "a1", id: a.id } }));
  assert.equal((await list(X.installKey, "a2")).items.some((i) => i.id === a.id), false, "taken: gone from every shop's list");
  assert.equal(store.has(`inbox/${accA}/${a.id}`), false, "the object left the bucket with the take itself, not at the next sweep");
  await status(await call("/v1/inbox/take", { key: X.installKey, json: { shopRef: "a2", id: a.id } }), 404, "the second take");
  const taken = (await db.query(`SELECT taken_by_shop_id, deleted_at FROM inbox_items WHERE id = $1`, [a.id])).rows[0];
  assert.equal(taken.taken_by_shop_id, sA1);
  assert.ok(taken.deleted_at, "the row says the object is gone");
  console.log("  ok  get gives a signed download; take removes the file from every list and the bucket, once, and says which shop took it; another account's shop can neither get nor take");

  // ----- retract -----
  const toRetract = await send(tokA, crypto.randomBytes(200), { fileName: "oops.dst" });
  await okJson(await call("/v1/inbox/retract", { token: tokB, json: { id: toRetract } }));
  assert.ok(store.has(`inbox/${accA}/${toRetract}`), "another account can't retract it (and learns nothing)");
  await okJson(await call("/v1/inbox/retract", { token: tokA, json: { id: toRetract } }));
  assert.equal(store.has(`inbox/${accA}/${toRetract}`), false);
  assert.equal((await list(X.installKey, "a1")).items.some((i) => i.id === toRetract), false);
  await status(await call("/v1/inbox/retract", { token: tokA, json: { id: a.id } }), 200, "retracting something already gone is quiet");
  console.log("  ok  retract takes a file back (its owner only)");

  // ----- the limits -----
  // already waiting for account A: logo (taken), sleeve (500 B). Room for 4 files and 3,146 bytes.
  const third = await send(tokA, crypto.randomBytes(1000), { fileName: "third.dst" });
  const fourth = await send(tokA, crypto.randomBytes(1000), { fileName: "fourth.dst" });
  await status(await put(tokA, crypto.randomBytes(900)), 413, "past the bytes");
  const smallOne = await send(tokA, crypto.randomBytes(100), { fileName: "tiny.dst" });
  await status(await put(tokA, crypto.randomBytes(10)), 413, "past the files");
  await okJson(await call("/v1/inbox/take", { key: X.installKey, json: { shopRef: "a1", id: third } }));
  await send(tokA, crypto.randomBytes(10), { fileName: "after-take.dst" });
  void fourth; void smallOne;
  assert.equal((await list(Y.installKey, "b1")).items.length, 0);
  await send(tokB, crypto.randomBytes(2000), { fileName: "b-own.dst" });
  assert.equal((await list(Y.installKey, "b1")).items.length, 1, "account B has room of its own");
  console.log("  ok  the limits: four files and about 3 KB an account, freed by taking a file; each account has its own room");

  // ----- the sweep -----
  const stale = await okJson(await put(tokB, crypto.randomBytes(50), { fileName: "stale.dst" }));
  await fetch(stale.url, { method: "PUT", body: Buffer.alloc(50), headers: stale.headers }).catch(() => {});
  await db.query(`UPDATE inbox_items SET created_at = now() - interval '3 hours' WHERE id = $1`, [stale.id]);
  const old = await send(tokB, crypto.randomBytes(60), { fileName: "old.dst" });
  await db.query(`UPDATE inbox_items SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old]);
  assert.equal((await list(Y.installKey, "b1")).items.some((i) => i.id === old), false, "an expired file is not listed even before the sweep");
  await until(async () => !store.has(`inbox/${accB}/${old}`) && !store.has(`inbox/${accB}/${stale.id}`), "the sweep to remove the unfinished and the expired file");
  await until(async () => (await db.query(`SELECT count(*)::int AS n FROM inbox_items WHERE id = ANY($1) AND deleted_at IS NOT NULL`, [[old, stale.id]])).rows[0].n === 2, "both rows marked deleted");
  const fresh = (await list(Y.installKey, "b1")).items.map((i) => i.fileName);
  assert.deepEqual(fresh, ["b-own.dst"], "a fresh file stays");
  console.log("  ok  the sweep removes an unfinished upload and an expired file from the bucket and leaves a fresh one");

  // ----- the hub says nothing when it is off -----
  hub.kill();
  await new Promise((r) => hub.once("exit", r));
  ({ hub, HUB } = await startHub({ ...s3env, ...limits, FOUNDRY_SIGNIN: "off", FOUNDRY_CLOUD_URL: foundry.url }));
  await status(await put(tokA, crypto.randomBytes(10)), 404, "inbox off with FOUNDRY_SIGNIN off");
  await status(await call("/v1/inbox/list?shopRef=a1", { key: X.installKey }), 404, "list off");
  console.log("  ok  with FOUNDRY_SIGNIN off the inbox doesn't exist");
  console.log("inbox: all ok");
} finally {
  hub.kill();
  s3.close();
  await foundry.close();
  await db.end();
}
