// Checks package hosted-provisioning on the hub (StitchBench docs/plans/hub-accounts-billing-design.md 4.3.4 and 4.4):
// starts a hub of its own on a free port against a scratch database, with a mock hosted StitchShop in this process
// standing in for POST /api/platform/companies, and walks:
//   - "Start a hosted shop": offered per program, the token sent and never logged, the company tied to the account on
//     the service's install (its first claim finds it under the account), the set-password link answered once and never
//     stored or logged, one start per account per 10 minutes, the service's refusal in its words, a link to another site
//     refused, a service that isn't on this hub (made, not tied), a service that doesn't answer;
//   - a reset of the owner's password on a Windows install: offered only while the program's claim says it allows it,
//     a grant signed with the hub's key over its own context (never a license signature), for that company, install
//     and the account's email, an hour; fetched by that install only, for that company only; replaced by a newer
//     request; answered once (done); withdrawn with the opt-in; another account can't ask; the limit;
//   - the export carrying reset_grants, hosted_starts and shops.reset_opt_in.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/provisioning.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "provisioning-test-admin-token";
const JOIN = "join-provisioning-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = `ppt_${crypto.randomBytes(24).toString("base64url")}`; // PLATFORM_API_TOKEN, 36+ characters
const CONTEXT = "stitchhub-reset-grant-v1\n";

// ----- a throwaway hub signing key -----
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const HUB_LICENSE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }), "utf8").toString("base64");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));

// ----- the hosted StitchShop, mocked: POST /api/platform/companies -----
const calls = [];
const svc = { mode: "ok", installId: null, n: 0 };
const svcPort = await freePort();
const SVC = `http://127.0.0.1:${svcPort}`;
const service = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {}
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, body });
    if (req.method !== "POST" || req.url !== "/api/platform/companies") return send(404, { error: "Not found." });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "Wrong token." });
    if (svc.mode === "down") return req.socket.destroy();
    if (svc.mode === "conflict") return send(409, { error: "That email already has an account." });
    svc.n += 1;
    const shopId = `cmshop${RUN}${svc.n}`;
    const link = svc.mode === "elsewhere" ? `https://evil.example/reset?t=x${svc.n}` : `${SVC}/reset?t=setup-token-${RUN}-${svc.n}`;
    send(201, {
      shopId,
      shopName: body.shopName,
      setPasswordUrl: link,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      appUrl: SVC,
      hub: svc.mode === "nohub" || !svc.installId ? null : { url: "http://hub", installId: svc.installId },
    });
  });
});
await new Promise((r) => service.listen(svcPort, "127.0.0.1", r));

// ----- the hub under test -----
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
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
    HUB_URL: HUB,
    SMTP_URL: "",
    MAIL_FROM: "",
    MAIL_DEV_LOG: "true", // account mail goes to the hub's log; the test reads its links there
    HUB_NAME: "Provisioning Test Hub",
    HUB_LICENSE_KID: "hubt",
    HUB_LICENSE_KEY,
    PLATFORM_API_TOKEN: TOKEN,
    HOSTED_STITCHSHOP_URL: SVC,
    HOSTED_STITCHBENCH_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
hub.stdout.on("data", (d) => (hubLog += d));
hub.stderr.on("data", (d) => (hubLog += d));
const db = new pg.Pool({ connectionString: DB, max: 2 });
const stop = async () => {
  hub.kill();
  service.close();
  await db.end().catch(() => {});
};
process.on("exit", () => hub.kill());
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
  await new Promise((r) => setTimeout(r, 200));
}

// ----- helpers: an install's calls, and a browser's (a cookie jar each) -----
async function call(p, { key, method = "GET", json, jar } = {}) {
  const r = await fetch(HUB + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar?.cookie ? { Cookie: jar.cookie } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  if (jar)
    for (const sc of r.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
      jar.cookie = attrs.some((a) => /^max-age=0$/i.test(a)) ? "" : pair;
    }
  return r;
}
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const register = async (name) => ok(await call("/v1/register", { json: { joinKey: JOIN, name } }));
const page = (jar, p, json) => call(`/account/api${p}`, { jar, json });
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** An account made on the hub first (door 3), verified, signed in: its cookie jar. */
async function account(email) {
  const jar = { cookie: "" };
  await ok(await page(jar, "/signup", { email, password: "Good-password-1", acceptTerms: true }));
  for (let i = 0; i < 50 && !hubLog.includes(email); i++) await wait(50);
  await ok(await page(jar, "/verify", { token: linkToken("verify") }));
  assert.match(jar.cookie, /^hub_session=/);
  return jar;
}
/** A grant as the program reads it (src/lib/hub-reset-grants.ts verifyResetGrant), checked with the hub's public key. */
function readGrant(text) {
  const m = /^SBG1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/.exec(text);
  assert.ok(m, `not a grant: ${text}`);
  const bytes = Buffer.from(m[1], "base64url");
  const sig = Buffer.from(m[2], "base64url");
  assert.ok(crypto.verify(null, Buffer.concat([Buffer.from(CONTEXT, "utf8"), bytes]), publicKey, sig), "the grant's signature verifies over its context");
  assert.equal(crypto.verify(null, bytes, publicKey, sig), false, "and never as a license key's (bare JSON)");
  return JSON.parse(bytes.toString("utf8"));
}

try {
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  const emailB = `owner-b-${RUN}@stitchhub.test`;
  const a = await account(emailA);
  const b = await account(emailB);
  let me = await ok(await page(a, "/me"));
  assert.deepEqual(me.hosted, { StitchShop: true, StitchBench: false }, "StitchShop is offered, StitchBench isn't (no address)");
  assert.equal(me.canSignResets, true);
  console.log("offer: ok");

  // ---------- a hosted shop from the hub ----------
  const X = await register(`Hosted StitchShop ${RUN}`); // the hosted service's own install on this hub
  svc.installId = X.installId;
  await status(await page(a, "/hosted", { program: "StitchBench", shopName: "Bench", ownerName: "Ann" }), 503, "a program this hub doesn't offer");
  await status(await page(a, "/hosted", { program: "Other", shopName: "Bench", ownerName: "Ann" }), 400, "not a program");
  await status(await page(a, "/hosted", { program: "StitchShop", shopName: "", ownerName: "Ann" }), 400, "no shop name");
  await status(await page({ cookie: "" }, "/hosted", { program: "StitchShop", shopName: "S", ownerName: "Ann" }), 401, "signed out");
  assert.equal(calls.length, 0, "nothing was sent to the service yet");
  const started = await ok(await page(a, "/hosted", { program: "StitchShop", shopName: `Ann's Quilts ${RUN}`, ownerName: "Ann Owner", timeZone: "America/Chicago" }));
  assert.equal(started.program, "StitchShop");
  assert.equal(started.tied, true);
  assert.ok(started.setPasswordUrl.startsWith(`${SVC}/reset?t=`));
  assert.equal(started.appUrl, SVC);
  const sent = calls.at(-1);
  assert.equal(sent.auth, `Bearer ${TOKEN}`, "the token went in the header");
  assert.deepEqual(
    { ...sent.body, hubAccountId: typeof sent.body.hubAccountId },
    { shopName: `Ann's Quilts ${RUN}`, kind: "retail", ownerName: "Ann Owner", ownerEmail: emailA, timeZone: "America/Chicago", hubAccountId: "string" },
    "the owner's login is the account's email (decision 11), a StitchShop is a retail shop",
  );
  const row = await one(`SELECT s.*, a.email FROM shops s JOIN accounts a ON a.id = s.account_id WHERE s.shop_ref = $1`, [started.shopRef]);
  assert.ok(row, "the company is on the hub, tied to the account");
  assert.deepEqual([row.install_id, row.email, row.program, row.kind, row.reset_opt_in], [X.installId, emailA, "StitchShop", "retail", false]);
  // The service's first claim finds it under the account.
  const claimed = await ok(await call("/v1/shops/claim", { key: X.installKey, json: { shopRef: started.shopRef, shopName: `Ann's Quilts ${RUN}`, kind: "retail", program: "StitchShop", version: "x", sole: false } }));
  assert.deepEqual(claimed.account, { email: emailA, verified: true });
  assert.equal(claimed.shop.id, row.id);
  me = await ok(await page(a, "/me"));
  assert.ok(me.shops.some((s) => s.shopRef === started.shopRef && s.resetOptIn === false && s.resetRequest === null));
  const start1 = await one(`SELECT * FROM hosted_starts WHERE shop_ref = $1`, [started.shopRef]);
  assert.deepEqual([start1.program, start1.install_id, start1.shop_id, start1.error], ["StitchShop", X.installId, row.id, null]);
  assert.ok(!JSON.stringify(start1).includes("reset?t="), "the link isn't stored");
  console.log("hosted start, tied to the account, first claim finds it: ok");

  // One start per account per 10 minutes; another account isn't held up.
  await status(await page(a, "/hosted", { program: "StitchShop", shopName: "Second", ownerName: "Ann" }), 429, "a second start within 10 minutes");
  const age = () => db.query(`UPDATE hosted_starts SET created_at = now() - interval '11 minutes' WHERE account_id = (SELECT id FROM accounts WHERE email = $1)`, [emailA]);
  await age();
  // The service's refusal, in its words, written down.
  svc.mode = "conflict";
  const refused = await status(await page(a, "/hosted", { program: "StitchShop", shopName: "Taken", ownerName: "Ann" }), 409, "the service says the email has a login");
  assert.match(refused.error, /already has an account/);
  assert.ok(await one(`SELECT 1 FROM hosted_starts WHERE shop_name = 'Taken' AND error LIKE '%already has an account%'`));
  await age();
  // A link to another site is never shown.
  svc.mode = "elsewhere";
  await status(await page(a, "/hosted", { program: "StitchShop", shopName: "Elsewhere", ownerName: "Ann" }), 502, "a link to another site");
  await age();
  // A service that doesn't answer.
  svc.mode = "down";
  await status(await page(a, "/hosted", { program: "StitchShop", shopName: "Down", ownerName: "Ann" }), 502, "no answer");
  await age();
  // A service that isn't on this hub: made, not tied (the owner connects it with a link code later).
  svc.mode = "nohub";
  const loose = await ok(await page(b, "/hosted", { program: "StitchShop", shopName: "Loose", ownerName: "Bea" }));
  assert.equal(loose.tied, false);
  assert.equal(await one(`SELECT 1 FROM shops WHERE shop_ref = $1`, [loose.shopRef]), undefined);
  svc.mode = "ok";
  assert.ok(!hubLog.includes(TOKEN), "the hub's log never shows the token");
  assert.ok(!hubLog.includes("setup-token-"), "nor the owner's link");
  console.log("one a 10 minutes, refusals, other sites, no answer, not on this hub: ok");

  // ---------- a reset of the owner's password on a Windows install ----------
  const W = await register(`Windows PC ${RUN}`);
  const claimW = async (extra) => ok(await call("/v1/shops/claim", { key: W.installKey, json: { shopRef: `w${RUN}`, shopName: "Win Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true, ...extra } }));
  await claimW({ resetOptIn: false });
  const { code } = await ok(await call("/v1/accounts/link-code", { key: W.installKey, json: { shopRef: `w${RUN}`, shopName: "Win Repair" } }));
  const connected = await ok(await page(a, "/connect", { code }));
  const wid = connected.shop.id;
  await status(await page(a, `/shops/${wid}/reset-owner`, {}), 409, "not while the program doesn't allow it");
  await claimW({ resetOptIn: true });
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops.find((s) => s.id === wid).resetOptIn, true, "the account page offers it now");
  await claimW({}); // an older program says nothing: what was stored stays
  assert.equal((await one(`SELECT reset_opt_in FROM shops WHERE id = $1`, [wid])).reset_opt_in, true);
  await status(await page(b, `/shops/${wid}/reset-owner`, {}), 404, "another account can't ask");
  const asked = await ok(await page(a, `/shops/${wid}/reset-owner`, {}));
  assert.equal(asked.shopName, "Win Repair");
  let list = await ok(await call(`/v1/shops/w${RUN}/reset-grants`, { key: W.installKey }));
  assert.equal(list.grants.length, 1);
  const g1 = readGrant(list.grants[0].grant);
  assert.deepEqual([g1.v, g1.k, g1.id, g1.shopRef, g1.installId, g1.email], [1, "hubt", asked.id, `w${RUN}`, W.installId, emailA]);
  const life = Date.parse(g1.exp) - Date.parse(g1.iat);
  assert.ok(life > 59 * 60_000 && life <= 60 * 60_000, `an hour (${life} ms)`);
  assert.match(g1.nonce, /^[A-Za-z0-9_-]{24,}$/);
  await status(await call(`/v1/shops/w${RUN}/reset-grants`, { key: X.installKey }), 404, "another install can't fetch them");
  assert.deepEqual((await ok(await call(`/v1/shops/${started.shopRef}/reset-grants`, { key: X.installKey }))).grants, [], "a company that doesn't allow resets has none");
  console.log("the grant: signed over its own context, that company, that install, the account's email, an hour: ok");

  // A newer request replaces the older; the program's answer is written down once; another install can't answer.
  const asked2 = await ok(await page(a, `/shops/${wid}/reset-owner`, {}));
  list = await ok(await call(`/v1/shops/w${RUN}/reset-grants`, { key: W.installKey }));
  assert.deepEqual(list.grants.map((x) => x.id), [asked2.id], "only the newest");
  assert.equal((await one(`SELECT result FROM reset_grants WHERE id = $1`, [asked.id])).result, "replaced");
  await status(await call(`/v1/shops/w${RUN}/reset-grants/${asked2.id}/done`, { key: X.installKey, json: { result: "allowed" } }), 404, "another install can't answer");
  await ok(await call(`/v1/shops/w${RUN}/reset-grants/${asked2.id}/done`, { key: W.installKey, json: { result: "allowed" } }));
  assert.deepEqual((await ok(await call(`/v1/shops/w${RUN}/reset-grants`, { key: W.installKey }))).grants, [], "answered: gone");
  await ok(await call(`/v1/shops/w${RUN}/reset-grants/${asked2.id}/done`, { key: W.installKey, json: { result: "refused" } }));
  assert.equal((await one(`SELECT result FROM reset_grants WHERE id = $1`, [asked2.id])).result, "allowed", "the first answer stays");
  // The program answered a request the hub had replaced: what it did is the truth.
  await ok(await call(`/v1/shops/w${RUN}/reset-grants/${asked.id}/done`, { key: W.installKey, json: { result: "refused", why: "no-owner" } }));
  assert.deepEqual(await one(`SELECT result, why FROM reset_grants WHERE id = $1`, [asked.id]), { result: "refused", why: "no-owner" });
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops.find((s) => s.id === wid).resetRequest.result, "allowed");
  console.log("replaced, answered once, by that install only: ok");

  // Withdrawn with the opt-in; the limit of 3 an hour per shop.
  const asked3 = await ok(await page(a, `/shops/${wid}/reset-owner`, {}));
  await claimW({ resetOptIn: false });
  assert.deepEqual((await ok(await call(`/v1/shops/w${RUN}/reset-grants`, { key: W.installKey }))).grants, []);
  assert.equal((await one(`SELECT result FROM reset_grants WHERE id = $1`, [asked3.id])).result, "withdrawn");
  await status(await page(a, `/shops/${wid}/reset-owner`, {}), 409, "not allowed any more");
  await claimW({ resetOptIn: true });
  await status(await page(a, `/shops/${wid}/reset-owner`, {}), 429, "a fourth request in the hour");
  console.log("withdrawn with the opt-in, the limit: ok");

  // ---------- the export ----------
  const gz = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  const rows = zlib.gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.t === "reset_grant" && r.id === asked2.id && r.result === "allowed"));
  assert.ok(rows.some((r) => r.t === "hosted_start" && r.shop_ref === started.shopRef));
  assert.ok(rows.some((r) => r.t === "shop" && r.id === wid && r.reset_opt_in === true));
  assert.ok(!JSON.stringify(rows).includes("setup-token-"), "no set-password link in the export");
  console.log("export: ok");

  assert.ok(!hubLog.includes(TOKEN) && !hubLog.includes(HUB_LICENSE_KEY.slice(0, 40)), "the log holds neither the token nor the signing key");
  console.log("all provisioning checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
