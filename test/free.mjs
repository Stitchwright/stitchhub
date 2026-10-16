// Checks the free program (src/free.mjs): with PROGRAM_FREE unset every shop's standing is "comped" with a program key that
// runs to 2099 (plan c, for the base module) and a key for every add-on (plan c, through 2099), the standing answer says so,
// subscriptions are closed (billing.open is false), "Lapse now" still ends a shop, and with PROGRAM_FREE=off a new shop is
// on its trial again. Starts hubs of its own on a scratch database it creates and drops (127.0.0.1:5433,
// stitchbench/stitchbench; or DATABASE_URL to use one you made) with a throwaway Ed25519 key standing in for hub1.
// usage: node test/free.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const ADMIN = "free-test-admin-token-0123456789";
const JOIN = "join-free-test";
const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_free_${Date.now().toString(36)}`;
const DB = process.env.DATABASE_URL || `${BASE}/${dbName}`;
const admin0 = new pg.Client({ connectionString: `${BASE}/postgres` });
if (!process.env.DATABASE_URL) {
  await admin0.connect();
  await admin0.query(`CREATE DATABASE ${dbName}`);
}
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const HUB_LICENSE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }), "utf8").toString("base64");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
let hub = null;
let hubLog = "";
async function startHub(env = {}) {
  if (hub && hub.proc.exitCode === null) await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  hubLog = "";
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Free Test Hub", HUB_URL: "https://hub.example.test", HUB_LICENSE_KID: "hub1", HUB_LICENSE_KEY, MAIL_DEV_LOG: "true", SMTP_URL: "", STRIPE_SECRET_KEY: "", PROGRAM_FREE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub = { proc, url: `http://127.0.0.1:${port}` };
  proc.stdout.on("data", (d) => (hubLog += d));
  proc.stderr.on("data", (d) => (hubLog += d));
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${hub.url}/health`).then((r) => r.ok, () => false)) return;
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stop = async () => {
  if (hub && hub.proc.exitCode === null) await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  if (!process.env.DATABASE_URL) {
    await admin0.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin0.end().catch(() => {});
  }
};
process.on("exit", () => hub?.proc.kill());

const call = (p, { key, json } = {}) =>
  fetch(hub.url + p, { method: json !== undefined ? "POST" : "GET", headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const payloadOf = (key) => JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const claim = async (key, ref, name) => ok(await call("/v1/shops/claim", { key, json: { shopRef: ref, shopName: name, kind: "repair", program: "StitchBench", version: "1.8.0", sole: true } }));

try {
  // ----- free by default -----
  await startHub();
  const key = await register("Install F");
  const a = await claim(key, "free1", "Free Repair");
  assert.equal(a.standing, "comped");
  assert.match(a.message, /free/i);
  assert.equal(a.lastDay, null, "no end");
  const p = payloadOf(a.key);
  assert.deepEqual([p.p, p.u, p.m], ["c", "2099-12-31", ["base"]], "the program key: comped, to 2099, the base module");
  const mod = a.moduleKeys.map(payloadOf);
  assert.equal(mod.length, 1, "one key for the add-ons");
  assert.deepEqual([...mod[0].m].sort(), ["appliance", "maker", "marketing", "scheduling", "vac"], "every add-on");
  assert.deepEqual([mod[0].p, mod[0].u], ["c", "2099-12-31"]);
  const again = await ok(await call("/v1/shops/free1/standing", { key }));
  assert.equal(again.key, a.key, "the same key again, not a new one");
  const accts = await ok(await call("/v1/admin/accounts", { key: ADMIN }));
  assert.equal(accts.billing.open, false, "subscriptions are closed");
  assert.match(accts.billing.problem, /free/i);
  console.log("free by default: ok");

  // ----- "Lapse now" still ends a shop -----
  const shopId = a.shop.id;
  await ok(await call(`/v1/admin/shops/${shopId}/lapse`, { key: ADMIN, json: {} }));
  const lapsed = await ok(await call("/v1/shops/free1/standing", { key }));
  assert.equal(lapsed.standing, "lapsed", "the admin's lapse is for abuse and still holds");
  console.log("lapse now: ok");

  // ----- PROGRAM_FREE=off brings the trial back -----
  await startHub({ PROGRAM_FREE: "off" });
  const key2 = await register("Install P");
  const b = await claim(key2, "paid1", "Paid Repair");
  assert.equal(b.standing, "trial", "the trial is back");
  assert.equal(b.key, null, "and, with no Stripe set, no key is signed (as before the programs were free)");
  console.log("PROGRAM_FREE=off: ok");
  console.log("free program: all ok");
} finally {
  await stop();
}
