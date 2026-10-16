// Checks program updates (src/releases.mjs, migration 035): latest picks the highest version per program by semver and
// skips withdrawn ones, 404 with none, validation of every field, a release at an https address or in storage (upload-url,
// the size check against R2, the download redirect with a 15-minute presigned URL and a file name), a withdrawn release
// no longer downloading, 503 when R2 isn't set up, and the admin routes needing the token. Starts a hub of its own on a
// scratch database it creates and drops (127.0.0.1:5433; or DATABASE_URL to use one you made) with the R2 mock.
// usage: node test/releases.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { startR2Mock } from "./r2-mock.mjs";

const ADMIN = "releases-test-admin-token-0123456789";
const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_releases_${Date.now().toString(36)}`;
const DB = process.env.DATABASE_URL || `${BASE}/${dbName}`;
const admin0 = new pg.Client({ connectionString: `${BASE}/postgres` });
if (!process.env.DATABASE_URL) {
  await admin0.connect();
  await admin0.query(`CREATE DATABASE ${dbName}`);
}

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const r2 = await startR2Mock({ bucket: "stitchhub-manuals" });
const procs = [];
let hubLog = "";
async function startHub(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: "join-releases-test", PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Releases Test Hub", HUB_URL: "https://hub.example.test", HUB_LICENSE_KID: "", HUB_LICENSE_KEY: "", MAIL_DEV_LOG: "true", SMTP_URL: "", FEEDBACK_EMAIL: "", R2_ENDPOINT: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_ACCOUNT_ID: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  proc.stdout.on("data", (d) => (hubLog += d));
  proc.stderr.on("data", (d) => (hubLog += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return { url, proc };
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stop = async () => {
  for (const p of procs) if (p.exitCode === null) await new Promise((r) => (p.once("exit", r), p.kill()));
  r2.close().catch(() => {}); // not awaited: its keep-alive sockets would hold this up
  if (!process.env.DATABASE_URL) {
    await admin0.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin0.end().catch(() => {});
  }
};
process.on("exit", () => procs.forEach((p) => p.kill()));

const SHA = "a".repeat(64);
const SIG = Buffer.alloc(64, 5).toString("base64");
const refused = async (r, status, re, what) => {
  const body = await r.text();
  assert.equal(r.status, status, `${what}: ${r.status} ${body}`);
  if (re) assert.match(JSON.parse(body).error ?? body, re, what);
};

try {
  // ----- a hub with storage -----
  const hub = await startHub({ R2_ENDPOINT: r2.endpoint, R2_BUCKET: r2.bucket, R2_ACCESS_KEY_ID: r2.accessKeyId, R2_SECRET_ACCESS_KEY: r2.secret });
  const call = (p, { key = ADMIN, json, method, redirect } = {}) =>
    fetch(hub.url + p, { method: method ?? (json !== undefined ? "POST" : "GET"), redirect, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const ok = async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  };
  const latest = (flavor) => call(`/v1/releases/latest?flavor=${flavor}`, { key: null });
  const rel = (o = {}) => ({ flavor: "stitchbench", version: "1.7.1", sha256: SHA, size: 1000, signature: SIG, notes: ["Faster invoices"], url: "https://example.test/StitchBench-Setup-1.7.1.exe", ...o });

  // none yet
  await refused(await latest("stitchbench"), 404, /No release/, "none published");
  await refused(await latest("nonsense"), 400, /flavor/, "bad flavor");
  await refused(await latest(""), 400, /flavor/, "no flavor");
  console.log("none: ok");

  // the admin routes need the token
  await refused(await call("/v1/admin/releases", { key: null }), 401, null, "list without token");
  await refused(await call("/v1/admin/releases", { json: rel(), key: "wrong" }), 401, null, "publish with a wrong token");

  // validation
  const bad = async (o, re, what) => refused(await call("/v1/admin/releases", { json: rel(o) }), 400, re, what);
  await bad({ flavor: "other" }, /flavor/, "flavor");
  await bad({ version: "1.7" }, /version/, "semver short");
  await bad({ version: "v1.7.1" }, /version/, "semver v");
  await bad({ version: "01.7.1" }, /version/, "semver leading zero");
  await bad({ sha256: "abc" }, /sha256/, "sha short");
  await bad({ sha256: "z".repeat(64) }, /sha256/, "sha not hex");
  await bad({ signature: "not base64!" }, /base64/, "signature");
  await bad({ signature: "" }, /base64/, "no signature");
  await bad({ size: 0 }, /size/, "size 0");
  await bad({ size: 600 * 1024 * 1024 + 1 }, /size/, "size over 600 MB");
  await bad({ size: 1.5 }, /size/, "size fraction");
  await bad({ notes: "one line" }, /notes/, "notes not a list");
  await bad({ notes: Array(13).fill("x") }, /notes/, "13 notes");
  await bad({ notes: ["x".repeat(201)] }, /notes/, "long note");
  await bad({ notes: [5] }, /notes/, "note not text");
  await bad({ url: "http://example.test/a.exe" }, /https/, "http url");
  await bad({ url: "not a url" }, /https/, "junk url");
  await bad({ url: undefined }, /exactly one/, "neither url nor key");
  await bad({ key: "releases/stitchbench/1.7.1/x.exe" }, /exactly one/, "both url and key");
  await bad({ url: undefined, key: "somewhere/else.exe" }, /key/, "foreign key");
  await bad({ url: undefined, key: "releases/stitchbench/1.7.1/missing.exe" }, /storage yet/, "key with nothing in storage");
  console.log("validation: ok");

  // publish at a link; a duplicate is refused
  const a = await ok(await call("/v1/admin/releases", { json: rel() }));
  assert.equal(a.url, "https://example.test/StitchBench-Setup-1.7.1.exe");
  await refused(await call("/v1/admin/releases", { json: rel() }), 409, /already published/, "same version again");
  let l = await ok(await latest("stitchbench"));
  assert.deepEqual({ version: l.version, url: l.url, sha256: l.sha256, size: l.size, signature: l.signature, notes: l.notes }, { version: "1.7.1", url: a.url, sha256: SHA, size: 1000, signature: SIG, notes: ["Faster invoices"] });
  assert.ok(!Number.isNaN(Date.parse(l.publishedAt)), "publishedAt");
  await refused(await latest("stitchshop"), 404, null, "the other program has none");

  // the highest version wins by number, not by text or date
  await ok(await call("/v1/admin/releases", { json: rel({ version: "1.10.0", url: "https://example.test/b.exe" }) }));
  await ok(await call("/v1/admin/releases", { json: rel({ version: "1.9.5", url: "https://example.test/c.exe" }) }));
  await ok(await call("/v1/admin/releases", { json: rel({ flavor: "stitchshop", version: "2.0.0", url: "https://example.test/shop.exe" }) }));
  assert.equal((await (await latest("stitchbench")).json()).version, "1.10.0");
  assert.equal((await (await latest("stitchshop")).json()).version, "2.0.0");

  // withdrawn ones are skipped
  const all = await ok(await call("/v1/admin/releases"));
  assert.equal(all.releases.length, 4);
  const top = all.releases.find((x) => x.flavor === "stitchbench" && x.version === "1.10.0");
  const w = await ok(await call(`/v1/admin/releases/${top.id}/withdraw`, { json: {} }));
  assert.ok(w.withdrawnAt);
  assert.equal((await (await latest("stitchbench")).json()).version, "1.9.5");
  assert.equal((await (await latest("stitchshop")).json()).version, "2.0.0", "withdrawing one program's release leaves the other's");
  await refused(await call("/v1/admin/releases/nope/withdraw", { json: {} }), 404, null, "withdraw unknown");
  const listed = await ok(await call("/v1/admin/releases"));
  assert.ok(listed.releases.find((x) => x.id === top.id).withdrawnAt, "the list shows withdrawn");
  console.log("latest: ok");

  // ----- a release kept on the hub -----
  await refused(await call("/v1/admin/releases/upload-url", { json: { flavor: "stitchbench", version: "1.9.5", size: 10 } }), 409, /already/, "upload-url for a published version");
  await refused(await call("/v1/admin/releases/upload-url", { json: { flavor: "stitchbench", version: "2.0", size: 10 } }), 400, /version/, "upload-url bad version");
  await refused(await call("/v1/admin/releases/upload-url", { json: { flavor: "stitchbench", version: "2.0.0", size: 600 * 1024 * 1024 + 1 } }), 400, /size/, "upload-url over the cap");
  const bytes = Buffer.from("MZ pretend installer ".repeat(100));
  const slot = await ok(await call("/v1/admin/releases/upload-url", { json: { flavor: "stitchbench", version: "1.8.0", size: bytes.length } }));
  assert.match(slot.key, /^releases\/stitchbench\/1\.8\.0\/[0-9a-f]+\.exe$/);
  // nothing uploaded yet
  await refused(await call("/v1/admin/releases", { json: rel({ version: "1.8.0", size: bytes.length, url: undefined, key: slot.key }) }), 400, /storage yet/, "not uploaded");
  const put = await fetch(slot.putUrl, { method: "PUT", headers: { ...slot.putHeaders }, body: bytes });
  assert.equal(put.status, 200, "PUT to the presigned URL");
  assert.equal(r2.objects.get(slot.key).contentType, "application/octet-stream");
  // the wrong size is refused; another version's key is refused
  await refused(await call("/v1/admin/releases", { json: rel({ version: "1.8.0", size: bytes.length + 1, url: undefined, key: slot.key }) }), 400, /bytes/, "size differs from storage");
  await refused(await call("/v1/admin/releases", { json: rel({ version: "1.8.1", size: bytes.length, url: undefined, key: slot.key }) }), 400, /key/, "key from another version");
  const b = await ok(await call("/v1/admin/releases", { json: rel({ version: "1.8.0", size: bytes.length, url: undefined, key: slot.key, notes: ["Bigger buttons"] }) }));
  assert.equal(b.url, `https://hub.example.test/v1/releases/${b.id}/download`);
  l = await ok(await latest("stitchbench"));
  assert.equal(l.version, "1.9.5", "1.9.5 is still higher than 1.8.0");
  // withdraw 1.9.5: now 1.8.0, with the hub's download address
  const c195 = listed.releases.find((x) => x.version === "1.9.5");
  await ok(await call(`/v1/admin/releases/${c195.id}/withdraw`, { json: {} }));
  l = await ok(await latest("stitchbench"));
  assert.equal(l.version, "1.8.0");
  assert.equal(l.url, `https://hub.example.test/v1/releases/${b.id}/download`);

  // the download: 302 to a presigned URL that gives the file as an attachment
  const d = await call(`/v1/releases/${b.id}/download`, { key: null, redirect: "manual" });
  assert.equal(d.status, 302);
  const loc = d.headers.get("location");
  assert.ok(loc.startsWith(r2.endpoint), "to storage");
  assert.match(new URL(loc).searchParams.get("X-Amz-Expires"), /^900$/);
  const f = await fetch(loc);
  assert.equal(f.status, 200);
  assert.match(f.headers.get("content-disposition"), /^attachment; filename="StitchBench Setup 1\.8\.0\.exe"$/);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), bytes);
  // a release at a link has no download; an unknown id neither; a withdrawn one no longer
  await refused(await call(`/v1/releases/${a.id}/download`, { key: null }), 404, null, "a link release has no hub download");
  await refused(await call("/v1/releases/nope/download", { key: null }), 404, null, "unknown id");
  await ok(await call(`/v1/admin/releases/${b.id}/withdraw`, { json: {} }));
  await refused(await call(`/v1/releases/${b.id}/download`, { key: null }), 404, null, "withdrawn download");
  console.log("download: ok");

  // the public routes are limited per address
  let limited = false;
  for (let i = 0; i < 130 && !limited; i++) limited = (await latest("stitchbench")).status === 429;
  assert.ok(limited, "GET /v1/releases/latest is rate limited");
  console.log("limits: ok");

  // ----- a hub with no storage -----
  await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  const bare = await startHub();
  const bareCall = (p, json) => fetch(bare.url + p, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify(json) });
  await refused(await bareCall("/v1/admin/releases/upload-url", { flavor: "stitchbench", version: "3.0.0", size: 10 }), 503, /storage/, "no R2 for an upload");
  await refused(await bareCall("/v1/admin/releases", rel({ version: "3.0.0", url: undefined, key: "releases/stitchbench/3.0.0/x.exe" })), 503, /storage/, "no R2 for a key");
  const linkOnly = await bareCall("/v1/admin/releases", rel({ version: "3.0.0" }));
  assert.equal(linkOnly.status, 200, "a link release needs no storage");
  console.log("no storage: ok");

  console.log("releases tests passed");
} catch (e) {
  console.error(e);
  console.error(hubLog.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  await stop();
}
process.exit(process.exitCode ?? 0); // the mock's keep-alive sockets would hold the process open
