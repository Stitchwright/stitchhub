// Checks the off-site backup storage (StitchBench docs/plans/later-round-1-design.md 1.5 and 1.6, package offsite-hub): a hub of
// its own on a free port against a scratch database, and a small S3 stand-in that VERIFIES every presigned request (SigV4 query
// authentication, worked out again here from what arrived, so a wrong signature, a wrong method, a wrong key or an expired
// address is refused as a real bucket would). Covers: put (a signed address for the company's own prefix only; bad names,
// sizes and hashes refused), upload and done (the hub looks at the object and its size), list (only what was confirmed),
// get, delete (gone from the bucket and the list), the quota (pictures wait, the company file still goes), a second company
// and a second install unable to touch the first's objects, the 410 for a company that moved away, a missing bucket setup
// answered in words, and the restore code: minted from the account, listing and fetching with no install key, wrong,
// expired and replaced codes refused, then the move that follows carries the store to the new install.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/backup.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "backup-test-admin-token";
const JOIN = "join-backup-test";
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
  const canonical = [req.method, url.pathname.split("/").map((s) => enc(decodeURIComponent(s))).join("/"), params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"), `host:${req.headers.host}\n`, q.get("X-Amz-SignedHeaders"), "UNSIGNED-PAYLOAD"].join("\n");
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
      store.set(key, Buffer.concat(chunks));
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
      store.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
});
await new Promise((r) => s3.listen(s3port, "127.0.0.1", r));

// ----- the hub under test -----
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
      LINK_CHECKER: "off",
      TRUST_PROXY: "",
      RAILWAY_ENVIRONMENT_ID: "",
      HUB_NAME: "Backup Test Hub",
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
const s3env = { BACKUP_S3_ENDPOINT: `http://127.0.0.1:${s3port}`, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: SECRET, BACKUP_S3_REGION: REGION };
let { hub, HUB } = await startHub({ ...s3env, BACKUP_QUOTA_GB: "0.00001" }); // about 10 KB: small enough to reach
const db = new pg.Pool({ connectionString: DB, max: 2 });
process.on("exit", () => hub.kill());

async function call(p, { key, method = "GET", json, headers = {}, base = HUB } = {}) {
  return fetch(base + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
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
const put = (key, shopRef, name, buf) => call("/v1/backup/put", { key, json: { shopRef, name, size: buf.length, sha256: sha(buf) } });
/** The whole upload dance: an address, the bytes to it, then done. */
async function upload(key, shopRef, name, buf) {
  const a = await okJson(await put(key, shopRef, name, buf), `put ${name}`);
  assert.equal(a.method, "PUT");
  const r = await fetch(a.url, { method: "PUT", body: buf });
  assert.equal(r.status, 200, "the bucket took it");
  await okJson(await call("/v1/backup/done", { key, json: { shopRef, name } }), `done ${name}`);
}
const fetchUrl = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

try {
  const X = await register(`Hosted ${RUN}`);
  const Y = await register(`Other ${RUN}`);
  await claim(X.installKey, "a", "A Sewing");
  await claim(X.installKey, "b", "B Quilts");
  await claim(Y.installKey, "y", "Y Repair");
  const shopA = (await db.query(`SELECT id FROM shops WHERE shop_ref = 'a' AND install_id = (SELECT id FROM installs WHERE name = $1)`, [`Hosted ${RUN}`])).rows[0].id;

  // ----- put, upload, done, list, get -----
  const data1 = crypto.randomBytes(2000);
  await upload(X.installKey, "a", "data/2026-10-06-020000.sbob", data1);
  assert.ok(store.get(`${shopA}/data/2026-10-06-020000.sbob`)?.equals(data1), "the object is in the bucket under the company's own prefix");
  const list = await okJson(await call("/v1/backup/list?shopRef=a", { key: X.installKey }));
  assert.deepEqual(list.objects.map((o) => [o.name, o.kind, o.size, o.sha256]), [["data/2026-10-06-020000.sbob", "data", 2000, sha(data1)]]);
  assert.equal(list.usedBytes, 2000);
  assert.ok(list.quotaBytes > 0);
  const got = await okJson(await call("/v1/backup/get", { key: X.installKey, json: { shopRef: "a", name: "data/2026-10-06-020000.sbob" } }));
  assert.ok((await fetchUrl(got.url)).equals(data1), "a signed download address gives the bytes back");
  assert.ok(refused.length === 0, `the bucket refused nothing it should have taken: ${refused}`);
  console.log("  ok  put, upload, done, list and get: signed addresses the bucket accepts, under the company's own prefix");

  // ----- the bucket refuses anything not signed for it -----
  const a1 = await okJson(await put(X.installKey, "a", "photo/MachinePhoto/p1-aaaaaaaaaaaaaaaa", Buffer.alloc(100)));
  assert.equal((await fetch(a1.url, { method: "GET" })).status, 403, "an upload address can't be used to read");
  assert.equal((await fetch(a1.url.replace(`${shopA}/`, `${shopA}x/`), { method: "PUT", body: Buffer.alloc(100) })).status, 403, "or for another key");
  assert.equal((await fetch(got.url, { method: "PUT", body: Buffer.alloc(1) })).status, 403, "a download address can't write");
  assert.equal((await fetch(got.url.replace("X-Amz-Expires=900", "X-Amz-Expires=3000"))).status, 403, "changing the lifetime breaks the signature");
  console.log("  ok  a presigned address works for its method and key only");

  // ----- done checks the object is there, at its size -----
  await status(await call("/v1/backup/done", { key: X.installKey, json: { shopRef: "a", name: "photo/MachinePhoto/p1-aaaaaaaaaaaaaaaa" } }), 409, "done before the upload");
  await fetch(a1.url, { method: "PUT", body: Buffer.alloc(77) }); // the wrong size
  await status(await call("/v1/backup/done", { key: X.installKey, json: { shopRef: "a", name: "photo/MachinePhoto/p1-aaaaaaaaaaaaaaaa" } }), 409, "done at the wrong size");
  assert.ok(!(await okJson(await call("/v1/backup/list?shopRef=a", { key: X.installKey }))).objects.some((o) => o.name.startsWith("photo/")), "an unconfirmed object isn't listed");
  await fetch(a1.url, { method: "PUT", body: Buffer.alloc(100) });
  await okJson(await call("/v1/backup/done", { key: X.installKey, json: { shopRef: "a", name: "photo/MachinePhoto/p1-aaaaaaaaaaaaaaaa" } }));
  console.log("  ok  done looks at the object: missing or the wrong size is refused, and it isn't listed until it is right");

  // ----- bad requests -----
  for (const name of ["data/../x", "x/y", "data/", "photo//a", `data/${"a".repeat(300)}`, "data/a b"]) await status(await put(X.installKey, "a", name, Buffer.alloc(1)), 400, `name ${name}`);
  await status(await call("/v1/backup/put", { key: X.installKey, json: { shopRef: "a", name: "data/x", size: -1, sha256: sha("x") } }), 400, "negative size");
  await status(await call("/v1/backup/put", { key: X.installKey, json: { shopRef: "a", name: "data/x", size: 1, sha256: "nope" } }), 400, "bad hash");
  await status(await call("/v1/backup/put", { key: X.installKey, json: { name: "data/x", size: 1, sha256: sha("x") } }), 400, "no company");
  await status(await call("/v1/backup/put", { json: { shopRef: "a", name: "data/x", size: 1, sha256: sha("x") } }), 401, "no install key");
  console.log("  ok  bad names, sizes, hashes, a missing company or key are refused");

  // ----- the quota: pictures wait, the company file still goes -----
  const big = crypto.randomBytes(9000);
  await status(await put(X.installKey, "a", "photo/MachinePhoto/p2-bbbbbbbbbbbbbbbb", big), 413, "a picture over the space");
  await upload(X.installKey, "a", "data/2026-10-07-020000.sbob", big); // the company file still goes (up to a fifth over)
  await status(await put(X.installKey, "a", "data/2026-10-08-020000.sbob", crypto.randomBytes(20000)), 413, "far over");
  // company b has its own space
  await upload(X.installKey, "b", "photo/MachinePhoto/p3-cccccccccccccccc", big);
  console.log("  ok  over the space new pictures wait and the company file still goes; each company has its own space");

  // ----- isolation: a second company, a second install -----
  await status(await call("/v1/backup/get", { key: X.installKey, json: { shopRef: "b", name: "data/2026-10-06-020000.sbob" } }), 404, "B asking for A's file name");
  await status(await call("/v1/backup/get", { key: Y.installKey, json: { shopRef: "a", name: "data/2026-10-06-020000.sbob" } }), 404, "another install naming A's shop");
  await status(await call("/v1/backup/get", { key: Y.installKey, json: { shopRef: "y", name: "data/2026-10-06-020000.sbob" } }), 404, "Y asking for the same name");
  assert.deepEqual((await okJson(await call("/v1/backup/list?shopRef=y", { key: Y.installKey }))).objects, [], "Y lists nothing of A's");
  assert.equal((await okJson(await call("/v1/backup/list?shopRef=b", { key: X.installKey }))).objects.length, 1);
  await okJson(await call("/v1/backup/delete", { key: Y.installKey, json: { shopRef: "y", name: "data/2026-10-06-020000.sbob" } })); // deleted 0
  assert.ok(store.has(`${shopA}/data/2026-10-06-020000.sbob`), "another company's delete touched nothing");
  console.log("  ok  another company on the install, and another install, can't list, fetch or delete the first's objects");

  // ----- delete -----
  const del = await okJson(await call("/v1/backup/delete", { key: X.installKey, json: { shopRef: "a", name: "data/2026-10-07-020000.sbob" } }));
  assert.equal(del.deleted, 1);
  assert.ok(!store.has(`${shopA}/data/2026-10-07-020000.sbob`), "gone from the bucket");
  assert.ok(!(await okJson(await call("/v1/backup/list?shopRef=a", { key: X.installKey }))).objects.some((o) => o.name === "data/2026-10-07-020000.sbob"));
  await status(await call("/v1/backup/get", { key: X.installKey, json: { shopRef: "a", name: "data/2026-10-07-020000.sbob" } }), 404, "get after delete");
  console.log("  ok  delete removes the object from the bucket and the list");

  // ----- the restore code -----
  const acctRow = (await db.query(`INSERT INTO accounts (id, email, verified_at) VALUES ($1, $2, now()) RETURNING id`, [`acc${RUN}`, `owner-${RUN}@example.test`])).rows[0];
  await db.query(`UPDATE shops SET account_id = $1 WHERE id = $2`, [acctRow.id, shopA]);
  const session = crypto.randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (id_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [sha(session), acctRow.id]);
  const cookie = { Cookie: `hub_session=${session}` };
  await status(await call(`/account/api/shops/${shopA}/restore-code`, { method: "POST", json: {} }), 401, "no session");
  const other = (await db.query(`SELECT id FROM shops WHERE shop_ref = 'b' LIMIT 1`)).rows[0].id;
  await status(await call(`/account/api/shops/${other}/restore-code`, { method: "POST", json: {}, headers: cookie }), 404, "a shop that isn't the account's");
  const code1 = await okJson(await call(`/account/api/shops/${shopA}/restore-code`, { method: "POST", json: {}, headers: cookie }));
  assert.match(code1.code, /^shr_/);
  assert.equal(code1.shopRef, "a");
  const hours = (new Date(code1.expiresAt).getTime() - Date.now()) / 3600_000;
  assert.ok(hours > 23 && hours <= 24, "good for 24 hours");
  const rl = await okJson(await call("/v1/backup/restore/list", { json: { code: code1.code } }), "restore list");
  assert.equal(rl.shop.shopRef, "a");
  assert.deepEqual(rl.objects.map((o) => o.name).sort(), ["data/2026-10-06-020000.sbob", "photo/MachinePhoto/p1-aaaaaaaaaaaaaaaa"]);
  const rg = await okJson(await call("/v1/backup/restore/get", { json: { code: code1.code, name: "data/2026-10-06-020000.sbob" } }));
  assert.ok((await fetchUrl(rg.url)).equals(data1), "a new install with the code can fetch the file");
  await status(await call("/v1/backup/restore/get", { json: { code: code1.code, name: "data/nope" } }), 404, "an object that isn't there");
  await status(await call("/v1/backup/restore/list", { json: { code: "shr_wrong" } }), 403, "a wrong code");
  await status(await call("/v1/backup/restore/list", { json: {} }), 403, "no code");
  // a newer code replaces the older
  const code2 = await okJson(await call(`/account/api/shops/${shopA}/restore-code`, { method: "POST", json: {}, headers: cookie }));
  await status(await call("/v1/backup/restore/list", { json: { code: code1.code } }), 403, "the replaced code");
  // expired
  await db.query(`UPDATE shop_moves SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha(code2.code)]);
  await status(await call("/v1/backup/restore/list", { json: { code: code2.code } }), 403, "an expired code");
  const code3 = await okJson(await call(`/account/api/shops/${shopA}/restore-code`, { method: "POST", json: {}, headers: cookie }));
  console.log("  ok  the restore code: minted from the account for its own shop, 24 hours, lists and fetches with no install key; wrong, replaced and expired codes refused");

  // ----- the move the code starts: the new install holds the company and its store follows -----
  const Z = await register(`New PC ${RUN}`);
  const moved = await okJson(await call("/v1/shops/move", { key: Z.installKey, json: { shopRef: "a", token: code3.code, shopName: "A Sewing", kind: "retail", program: "StitchShop", version: "1.7.0" } }), "move");
  assert.ok(moved.shop, "the move went through with the restore code");
  const zl = await okJson(await call("/v1/backup/list?shopRef=a", { key: Z.installKey }));
  assert.equal(zl.objects.length, 2, "the new install sees the company's whole store");
  await status(await call("/v1/backup/list?shopRef=a", { key: X.installKey }), 410, "the old install is told the company moved");
  await status(await call("/v1/backup/restore/list", { json: { code: code3.code } }), 403, "a used code");
  const again = await okJson(await call("/v1/backup/get", { key: Z.installKey, json: { shopRef: "a", name: "data/2026-10-06-020000.sbob" } }));
  assert.ok((await fetchUrl(again.url)).equals(data1), "and can fetch it");
  console.log("  ok  redeeming the code moves the company; its backups follow it to the new install; the old one is told");

  // ----- the bucket not set up -----
  hub.kill();
  ({ hub, HUB } = await startHub({ BACKUP_S3_ENDPOINT: "" }));
  const none = await status(await call("/v1/backup/get", { key: Z.installKey, json: { shopRef: "a", name: "data/2026-10-06-020000.sbob" } }), 503, "no bucket");
  assert.match(none.error, /isn't set up on this hub yet/);
  console.log("  ok  a hub with no bucket says so in words");
  console.log("\nbackup test: all passed");
} finally {
  hub.kill();
  s3.close();
  await db.end().catch(() => {});
}
