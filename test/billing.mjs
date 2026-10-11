// Checks billing since every shop is free (11 Oct 2026; StitchBench docs/plans/free-software-design.md, package 1):
// starts a hub of its own on a free port against a scratch database, with the Stripe mock (test/stripe-mock.mjs) standing
// in for Stripe and a throwaway Ed25519 key standing in for hub1, and checks what a 1.7.x program reads in every claim
// answer: standing comped ("Free, with every add-on.") and two keys that never run out, plan c through 2099-12-31 from
// yesterday (so live in every time zone), one for the program ("base", login plan Shop) and one for the five add-ons,
// verified with the program's own logic (license.ts, copied), taken by its own filters (hub-standing.ts) and never named
// for removal. So for a brand-new shop, an old trial shop, a waived (partnered) shop and a "both" one, a shop the admin
// lapsed before, and a shop whose subscription made in Stripe fails, runs out of grace, is refunded, charged back, loses
// its dispute and ends (the webhook still keeps its books, for hosting billing); no comp and no "Lapse now" (refused)
// changes a key or revokes one. Selling plans, Switch, the add-ons and extra stores is parked (refused before Stripe;
// /account offers none); the Assistant is still sold, and its key goes beside the forever ones. Also the webhook's own
// checks (a replay, a bad signature, a forged object), the export, a hub with billing closed (the keys are signed all the
// same) and a price id given to two products. The plan billing this test walked until 11 Oct (trials, Solo and Shop,
// founding shops, the waiver's rule, refunds and disputes lapsing a shop) is parked with that code: hosting billing
// (package 4) rewrites it on the same webhook. Each run makes a fresh database beside the one named and drops it at the end.
// usage: DATABASE_URL=postgresql://... (any database on a server where the role may create databases) node test/billing.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { startStripeMock } from "./stripe-mock.mjs";

const BASE_DB = process.env.DATABASE_URL;
assert.ok(BASE_DB, "set DATABASE_URL to a database on a server where the role may create databases (the test makes a fresh one beside it)");
const ADMIN = process.env.ADMIN_TOKEN ?? "billing-test-admin-token";
const JOIN = "join-billing-test";
const RUN = Date.now().toString(36);
// A fresh database for this run, dropped at the end.
const FRESH_DB = `stitchhub_billing_${RUN}`;
const DB = (() => {
  const u = new URL(BASE_DB);
  u.pathname = `/${FRESH_DB}`;
  return u.toString();
})();
{
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  await c.query(`CREATE DATABASE ${FRESH_DB}`);
  await c.end();
}
const ROOT = path.resolve(import.meta.dirname, "..");
const WEBHOOK_SECRET = "whsec_billingtest1234567890";
// Every price the hub knows, set as on a hub that sold them: the plans, the Assistant, the five add-ons, the bundle and
// extra stores. Only the Assistant is sold.
const MONTHLY = { vac: 1000, appliance: 500, scheduling: 1500, marketing: 1000, maker: 1000, bundle: 3000, store: 2500 };
const PRICES = {
  soloMonthly: `price_solom_${RUN}`,
  soloYearly: `price_soloy_${RUN}`,
  shopMonthly: `price_shopm_${RUN}`,
  shopYearly: `price_shopy_${RUN}`,
  aMonthly: `price_am_${RUN}`,
  aYearly: `price_ay_${RUN}`,
  aTopup: `price_at_${RUN}`,
};
for (const k of Object.keys(MONTHLY)) {
  PRICES[`${k}m`] = `price_${k}m_${RUN}`;
  PRICES[`${k}y`] = `price_${k}y_${RUN}`;
}
const CATALOG = [
  [PRICES.soloMonthly, "month", 2500],
  [PRICES.soloYearly, "year", 25000],
  [PRICES.shopMonthly, "month", 4500],
  [PRICES.shopYearly, "year", 45000],
  [PRICES.aMonthly, "month", 1500],
  [PRICES.aYearly, "year", 15000],
  [PRICES.aTopup, "once", 1000],
  ...Object.entries(MONTHLY).flatMap(([k, c]) => [
    [PRICES[`${k}m`], "month", c],
    [PRICES[`${k}y`], "year", c * 10],
  ]),
].map(([id, interval, amount]) => ({ id, interval, amount }));
const ADDON_ENV = Object.fromEntries(Object.keys(MONTHLY).flatMap((k) => [[`STRIPE_PRICE_${k.toUpperCase()}_MONTHLY`, PRICES[`${k}m`]], [`STRIPE_PRICE_${k.toUpperCase()}_YEARLY`, PRICES[`${k}y`]]]));

// ----- the program's side of a key: verifyLicense from StitchBench's src/lib/license.ts, as written there -----
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s) => typeof s === "string" && YMD.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
function verifyLicense(text, keys) {
  const m = /^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/.exec(String(text ?? "").replace(/\s+/g, ""));
  if (!m) return { ok: false, reason: "not a key" };
  const bytes = Buffer.from(m[1], "base64url");
  let p;
  try {
    p = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (!p || typeof p !== "object") return { ok: false, reason: "damaged" };
  if (p.v !== 1) return { ok: false, reason: "newer" };
  const pk = typeof p.k === "string" && Object.hasOwn(keys, p.k) ? keys[p.k] : undefined;
  if (!pk) return { ok: false, reason: "newer (unknown kid)" };
  let good = false;
  try {
    good = crypto.verify(null, bytes, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.x }, format: "jwk" }), Buffer.from(m[2], "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad signature" };
  const shapeOk =
    typeof p.id === "string" && /^[0-9A-Z]{6,20}$/.test(p.id) && typeof p.s === "string" && p.s.length > 0 && p.s.length <= 64 &&
    typeof p.n === "string" && Array.isArray(p.m) && p.m.length > 0 && p.m.every((x) => typeof x === "string") &&
    typeof p.p === "string" && /^[a-z]{1,8}$/.test(p.p) && validYmd(p.f) && validYmd(p.u) && p.u >= p.f &&
    Number.isInteger(p.g) && p.g >= 0 && p.g <= 90 && typeof p.t === "string" && !Number.isNaN(Date.parse(p.t));
  if (!shapeOk) return { ok: false, reason: "bad shape" };
  return { ok: true, payload: p, scope: pk.scope, kid: p.k };
}
// The add-on modules a 1.7.x program takes keys for (hub-standing.ts ADDON_MODULES), and how many module keys it takes.
const ADDON_MODULES = ["assistant", "vac", "appliance", "scheduling", "marketing", "maker"];
const PROGRAM_TAKES = 8;
const FIVE = ["vac", "appliance", "scheduling", "marketing", "maker"];
const NO_END = "2099-12-31";
// What a claim answer holds: what 1.7.x programs read, and nothing taken away.
const CLAIM_FIELDS = ["account", "founding", "interval", "key", "lastDay", "listings", "message", "moduleKeys", "ok", "plan", "revokeKeyIds", "shop", "standing", "terms"];

// ----- a throwaway hub1 -----
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const HUB1_X = publicKey.export({ format: "jwk" }).x;
const PUBLIC_KEYS = { hub1: { x: HUB1_X, scope: "hub" } };
const HUB_LICENSE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }), "utf8").toString("base64");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const mock = await startStripeMock({ port: 0, webhookUrl: `${HUB}/v1/stripe`, webhookSecret: WEBHOOK_SECRET, catalog: CATALOG });

// ----- the hub under test -----
const ENV = {
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
  MAIL_DEV_LOG: "true", // every email goes to the hub's log; the test reads links from there
  HUB_NAME: "Billing Test Hub",
  HUB_LICENSE_KID: "hub1",
  HUB_LICENSE_KEY,
  STRIPE_API_BASE: mock.url,
  STRIPE_SECRET_KEY: "sk_test_billingmock12345678",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SOLO_MONTHLY: PRICES.soloMonthly,
  STRIPE_PRICE_SOLO_YEARLY: PRICES.soloYearly,
  STRIPE_PRICE_SHOP_MONTHLY: PRICES.shopMonthly,
  STRIPE_PRICE_SHOP_YEARLY: PRICES.shopYearly,
  STRIPE_PRICE_ASSISTANT_MONTHLY: PRICES.aMonthly,
  STRIPE_PRICE_ASSISTANT_YEARLY: PRICES.aYearly,
  STRIPE_PRICE_ASSISTANT_TOPUP: PRICES.aTopup,
  ...ADDON_ENV,
};
let hub = null;
let hubLog = "";
async function startHub(env) {
  hub = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const h = hub;
  h.stdout.on("data", (d) => (hubLog += d));
  h.stderr.on("data", (d) => (hubLog += d));
  for (let i = 0; ; i++) {
    if (h.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopHub = () =>
  new Promise((r) => {
    if (!hub || hub.exitCode !== null) return r();
    hub.once("exit", r);
    hub.kill();
  });
const db = new pg.Pool({ connectionString: DB, max: 2 });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await db.end().catch(() => {});
  await stopHub();
  await mock.close();
  const c = new pg.Client({ connectionString: BASE_DB });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${FRESH_DB} WITH (FORCE)`);
  await c.end();
};
process.on("exit", () => hub?.kill());
await startHub(ENV);

// ----- helpers -----
async function call(p, { key, method = "GET", json, jar, headers = {} } = {}) {
  const r = await fetch(HUB + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar?.cookie ? { Cookie: jar.cookie } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  if (jar) for (const sc of r.headers.getSetCookie()) {
    const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
    jar.cookie = attrs.some((a) => /^max-age=0$/i.test(a)) ? "" : pair;
  }
  return r;
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
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const browser = () => ({ cookie: "" });
const page = (jar, p, json, extra = {}) => call(`/account/api${p}`, { jar, json, ...extra });
const adminCall = (p, json, method) => call(`/v1/admin${p}`, { key: ADMIN, json, method });
/** Waits for the webhooks of the Stripe calls the hub made (a cancellation) and checks every webhook was taken. */
const settle = async (what) => {
  await mock.settle();
  const bad = mock.webhooks.filter((w) => w.status !== 200);
  assert.deepEqual(bad, [], `${what}: a webhook wasn't taken`);
};
const mockPost = async (p, json = {}) => {
  const out = await fetch(mock.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }).then((r) => r.json());
  await settle(p);
  return out;
};
const mockApi = async (p, form) => {
  const out = await fetch(mock.url + p, { method: "POST", headers: { Authorization: "Bearer sk_test_billingmock12345678", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }).then((r) => r.json());
  await settle(p);
  return out;
};
const day = (d) => new Date(d).toISOString().slice(0, 10);
const plusDays = (n, from = Date.now()) => day(from + n * 86400_000);
const claim = (key, body) => ok(call("/v1/shops/claim", { key, json: body }));
const standing = (key, ref) => ok(call(`/v1/shops/${ref}/standing`, { key }));
/** The newest link of a kind in the hub's log (MAIL_DEV_LOG prints every email). */
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const allDelivered = (r, what) => {
  assert.ok(r.delivered?.length, `${what}: no webhooks went out`);
  for (const d of r.delivered) assert.equal(d.status, 200, `${what}: webhook ${d.type} answered ${d.status} ${d.body ?? d.error ?? ""}`);
};
const signWebhook = (body, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
};
const postWebhook = (ev, secret = WEBHOOK_SECRET) => {
  const body = JSON.stringify(ev);
  return fetch(`${HUB}/v1/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signWebhook(body, secret) }, body });
};

/** A key verified as the program verifies it: with hub1, for this company. Its payload. */
function verified(text, ref, what) {
  const v = verifyLicense(text, PUBLIC_KEYS);
  assert.ok(v.ok, `${what}: the key doesn't verify (${v.reason})`);
  assert.deepEqual([v.kid, v.scope, v.payload.s], ["hub1", "hub", ref], `${what}: a hub1 key naming the program's company id (shop_ref)`);
  return v.payload;
}

/**
 * A claim or standing answer as a 1.7.x program takes it (hub-standing.ts applyStanding): free, the program's own key
 * ("base", the login plan Shop) and the five add-ons' key (among the module keys it takes: no "base", at most eight), both
 * plan c through 2099-12-31 with 14 days' grace, starting the day before they were signed (the last midnight on Earth,
 * UTC-12, is noon UTC: the key has started everywhere), neither named for removal. Answers the two payloads.
 */
function checkFree(a, ref, what) {
  assert.deepEqual([a.standing, a.lastDay, a.message, a.plan, a.interval, a.founding], ["comped", null, "Free, with every add-on.", "shop", null, false], `${what}: the standing`);
  const base = verified(a.key, ref, `${what}: the program's key`);
  assert.deepEqual([base.m, base.p, base.u, base.g, base.l, base.fs], [["base"], "c", NO_END, 14, "shop", undefined], `${what}: the program's key never runs out`);
  const taken = a.moduleKeys
    .slice(0, PROGRAM_TAKES)
    .map((k) => verifyLicense(k, PUBLIC_KEYS))
    .filter((v) => v.ok && v.payload.s === ref && !v.payload.m.includes("base") && v.payload.m.some((m) => ADDON_MODULES.includes(m)));
  const five = taken.filter((v) => v.payload.m.join() === FIVE.join());
  assert.equal(five.length, 1, `${what}: one key for the five add-ons among the module keys the program takes`);
  const addons = five[0].payload;
  assert.deepEqual([addons.p, addons.u, addons.g, addons.l], ["c", NO_END, 14, undefined], `${what}: the add-ons' key never runs out`);
  for (const p of [base, addons]) {
    assert.equal(p.f, day(Date.parse(p.t) - 86400_000), `${what}: a key starts the day before it was signed`);
    assert.ok(Date.parse(`${p.f}T12:00:00Z`) <= Date.now(), `${what}: and has started in every time zone`);
    assert.ok(!a.revokeKeyIds.includes(p.id), `${what}: a forever key is never named for removal`);
  }
  return { base, addons };
}

/**
 * A key as hub1 signed it before 11 Oct (license.mjs signKey), written down as the hub wrote it: the trial's, a cut one
 * ("Lapse now"), a waived one. Newer than any other the shop has, as the one its program held.
 */
async function oldKey(shopId, ref, { m = ["base"], p, f, u, g = 14, l = "shop", revoked = false }) {
  const id = crypto.randomBytes(4).toString("hex").toUpperCase();
  const payload = { v: 1, k: "hub1", id, s: ref, n: ref, m, p, f, u, g, t: new Date(Date.now() - 86400_000).toISOString(), ...(l ? { l } : {}) };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const key = `SB1.${bytes.toString("base64url")}.${crypto.sign(null, bytes, privateKey).toString("base64url")}`;
  await db.query(
    `INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key, tier, founding, revoked_at) VALUES ($1, $2, 'hub1', $3, $4, $5, $6, $7, $8, $9, false, $10)`,
    [id, shopId, p, m, f, u, g, key, l, revoked ? new Date() : null],
  );
  return payload;
}

try {
  assert.match(hubLog, /signing as kid hub1 \(public x /, "the hub says which key it signs with");
  assert.ok(hubLog.includes(HUB1_X), "the public x printed is the one for license-keys.ts");

  // ----- 1. A brand-new shop: free, with keys that never run out for the program and the five add-ons. -----
  const keyA = await register("Billing Test Shop A");
  const claimA = await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopA = claimA.shop.id;
  assert.deepEqual(Object.keys(claimA).sort(), CLAIM_FIELDS, "the answer's shape is what 1.7.x reads");
  const freeA = checkFree(claimA, "shopA", "a brand-new shop");
  assert.deepEqual([claimA.revokeKeyIds, claimA.moduleKeys.length, freeA.base.n], [[], 1, "A Repair"]);
  const againA = await standing(keyA, "shopA");
  assert.deepEqual([againA.key, againA.moduleKeys], [claimA.key, claimA.moduleKeys], "asked again: the same keys, nothing new signed");
  const issuedA = (await db.query(`SELECT plan, modules, last_day::text AS last_day, revoked_at FROM license_issues WHERE shop_id = $1 ORDER BY modules`, [shopA])).rows;
  assert.deepEqual(issuedA.map((r) => [r.plan, r.modules.join(), r.last_day, r.revoked_at]), [["c", "base", NO_END, null], ["c", FIVE.join(), NO_END, null]], "two keys written down");
  assert.equal((await db.query(`SELECT comp_until FROM shops WHERE id = $1`, [shopA])).rows[0].comp_until, null, "nothing written on the shop: its comp stays the admin's own");
  console.log("a brand-new shop: ok");

  // ----- 2. The account page offers no plan, Switch or add-on, and those routes refuse before anything reaches Stripe;
  // the Assistant is still sold, and its key goes beside the forever ones. -----
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await ok(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: emailA, termsVersion: "2026-10-02" } }));
  const a = browser();
  await ok(await page(a, "/set-password", { token: linkToken("set-password"), password: "Good-password-1" }));
  let me = await ok(await page(a, "/me"));
  const rowA = me.shops[0];
  assert.deepEqual([rowA.standing, rowA.message, rowA.source, rowA.lastDay, rowA.canSubscribe, rowA.canSwitch, rowA.firstChargeOn], ["comped", "Free, with every add-on.", "free", null, false, false, null]);
  assert.deepEqual(rowA.addons.on, FIVE, "every shop has the five add-ons");
  assert.ok(Object.values(rowA.addons.items).every((x) => x.canAdd === false), "no add-on is offered");
  assert.deepEqual([me.billing.open, me.billing.prices, me.billing.addonPrices], [true, null, null], "no plan or add-on price is shown");
  assert.deepEqual(me.billing.assistantPrices, { monthly: "$15 a month", yearly: "$150 a year", topup: "$10", topUpCalls: 300 }, "the Assistant is still sold");
  assert.equal(rowA.assistant.canAdd, true);
  const b = browser();
  await ok(await page(b, "/signup", { email: `owner-b-${RUN}@stitchhub.test`, password: "Good-password-2", acceptTerms: true }));
  await ok(await page(b, "/verify", { token: linkToken("verify") }));
  const sessionsBefore = mock.sessions.size;
  const customersBefore = mock.customers.size;
  for (const [who, p, body] of [
    [a, "/checkout", { plan: "solo", interval: "monthly", acceptTerms: true }],
    [a, "/checkout", { plan: "shop", interval: "yearly" }],
    [a, "/switch", { plan: "shop" }],
    [a, "/addons/checkout", { addon: "bundle", interval: "monthly", acceptTerms: true }],
    [a, "/addons/checkout", { addon: "maker", interval: "yearly" }],
    [b, "/checkout", { plan: "solo", interval: "monthly" }],
    [browser(), "/addons/checkout", { addon: "vac", interval: "monthly" }],
  ]) {
    const refused = await status(await page(who, `/shops/${shopA}${p}`, body), 410, `${p} ${JSON.stringify(body)}`);
    assert.equal(refused.error, "StitchBench and StitchShop are free for every shop, with every add-on: there's nothing to subscribe to.");
  }
  assert.deepEqual([mock.sessions.size, mock.customers.size], [sessionsBefore, customersBefore], "nothing reached Stripe");
  const asstCo = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly", acceptTerms: true }));
  assert.equal(mock.sessions.get(asstCo.sessionId).line_items.data[0].price.id, PRICES.aMonthly);
  const asstPaid = await mockPost(`/__pay/${asstCo.sessionId}`);
  allDelivered(asstPaid, "the Assistant paid");
  let st = await standing(keyA, "shopA");
  let free = checkFree(st, "shopA", "with the Assistant");
  assert.deepEqual([free.base.id, free.addons.id], [freeA.base.id, freeA.addons.id], "the same forever keys");
  const asstKey = verified(st.moduleKeys[0], "shopA", "the Assistant's key");
  assert.deepEqual([st.moduleKeys.length, asstKey.m, asstKey.p, asstKey.u], [2, ["assistant"], "m", day(asstPaid.subscription.current_period_end * 1000)], "the Assistant's own key, then the add-ons'");
  const portal = await ok(await page(a, `/shops/${shopA}/portal`, {}));
  assert.ok(portal.url.startsWith(`${mock.url}/portal/cus_`), "Manage billing, for the Assistant");
  console.log("nothing to subscribe to, the Assistant still sold: ok");

  // ----- 3. An old trial shop (as a 1.7.x install that joined before holds it: a trial key run out, billing open). -----
  const keyT = await register("Billing Test Old Trial");
  const shopT = (await claim(keyT, { shopRef: "shopT", shopName: "T Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true })).shop.id;
  await db.query(`UPDATE shops SET created_at = now() - interval '45 days' WHERE id = $1`, [shopT]);
  await db.query(`DELETE FROM license_issues WHERE shop_id = $1`, [shopT]);
  const trialKey = await oldKey(shopT, "shopT", { p: "t", f: plusDays(-45), u: plusDays(-15) });
  const claimT = await claim(keyT, { shopRef: "shopT", shopName: "T Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const freeT = checkFree(claimT, "shopT", "an old trial shop");
  assert.notEqual(freeT.base.id, trialKey.id, "a new key replaces the trial's");
  console.log("an old trial shop: ok");

  // ----- 4. A waived shop, a "both" shop beside it, and the partnership ending: the waiver's rule isn't asked. -----
  const keyR = await register("Billing Test Repair R");
  const keyS = await register("Billing Test Quilts S");
  const shopR = (await claim(keyR, { shopRef: "shopR", shopName: "R Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true })).shop.id;
  const shopS = (await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop", version: "1.0.0", sole: true })).shop.id;
  const shopU = (await claim(keyS, { shopRef: "shopU", shopName: "U Both", kind: "both", program: "StitchShop", version: "1.0.0" })).shop.id;
  // R paid (a subscription row, as the webhook wrote it), S held a waived key: as it stood before 11 Oct.
  await db.query(`INSERT INTO subscriptions (shop_id, stripe_subscription_id, plan, tier, status, current_period_end) VALUES ($1, $2, 'm', 'shop', 'active', now() + interval '20 days')`, [shopR, `sub_row_${RUN}`]);
  const inv = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair" } }));
  const red = await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv.code, shopRef: "shopS", shopName: "S Quilts" } }));
  const inv2 = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair" } }));
  await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv2.code, shopRef: "shopU", shopName: "U Both" } }));
  // An old partnership with no repair lately: under the rule it would be in its grace (a waiver_grace row written).
  await db.query(`UPDATE partner_links SET created_at = now() - interval '200 days'`);
  await db.query(`DELETE FROM license_issues WHERE shop_id = ANY($1)`, [[shopS, shopU]]);
  await db.query(`UPDATE shops SET created_at = now() - interval '200 days' WHERE id = ANY($1)`, [[shopS, shopU]]);
  const waivedKey = await oldKey(shopS, "shopS", { p: "w", f: plusDays(-3), u: plusDays(31) });
  const freeS = checkFree(await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop", version: "1.0.0", sole: true }), "shopS", "a waived shop");
  assert.notEqual(freeS.base.id, waivedKey.id);
  checkFree(await claim(keyS, { shopRef: "shopU", shopName: "U Both", kind: "both", program: "StitchShop", version: "1.0.0" }), "shopU", "a both shop partnered the same way");
  checkFree(await standing(keyR, "shopR"), "shopR", "the repair partner");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM waiver_grace`)).rows[0].n, 0, "the waiver's rule isn't asked: no grace is written");
  await ok(await call(`/v1/partners/links/${red.link.id}/end`, { key: keyR, json: { shopRef: "shopR" } }));
  free = checkFree(await standing(keyS, "shopS"), "shopS", "the partnership ended");
  assert.deepEqual([free.base.id, free.addons.id], [freeS.base.id, freeS.addons.id], "nothing changes");
  console.log("a waived shop, a both shop, the partnership ended: ok");

  // ----- 5. A shop the admin lapsed before 11 Oct: its "Lapse now" mark, a cut key and its trial key revoked. -----
  const keyL = await register("Billing Test Lapsed L");
  const shopL = (await claim(keyL, { shopRef: "shopL", shopName: "L Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true })).shop.id;
  await db.query(`DELETE FROM license_issues WHERE shop_id = $1`, [shopL]);
  await db.query(`UPDATE shops SET lapsed_at = now() - interval '3 days', created_at = now() - interval '20 days' WHERE id = $1`, [shopL]);
  const revokedTrial = await oldKey(shopL, "shopL", { p: "t", f: plusDays(-20), u: plusDays(10), revoked: true });
  const cut = await oldKey(shopL, "shopL", { p: "t", f: plusDays(-4), u: plusDays(-4), g: 0 });
  const claimL = await claim(keyL, { shopRef: "shopL", shopName: "L Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const freeL = checkFree(claimL, "shopL", "a shop lapsed by the admin before");
  assert.notEqual(freeL.base.id, cut.id);
  assert.deepEqual(claimL.revokeKeyIds, [revokedTrial.id], "only the key revoked then is named for removal");
  console.log("a shop lapsed before: ok");

  // ----- 6. No webhook can lapse a shop. A's base subscription, made in Stripe (none can be bought on the hub), fails,
  // runs out of grace, is refunded, charged back, loses its dispute, ends; the bundle's and the Assistant's are refunded.
  // The webhook still keeps its books (hosting billing builds on them); the standing and the forever keys never change. -----
  const customerA = mock.sessions.get(asstCo.sessionId).customer;
  const madeInStripe = async (price, meta = {}) => {
    const form = { mode: "subscription", customer: customerA, "line_items[0][price]": price, "line_items[0][quantity]": "1", success_url: `${HUB}/account/shops`, cancel_url: `${HUB}/account/shops` };
    for (const [k, v] of Object.entries({ hub_shop_id: shopA, ...meta })) {
      form[`metadata[${k}]`] = v;
      form[`subscription_data[metadata][${k}]`] = v;
    }
    const session = await mockApi("/v1/checkout/sessions", form);
    const paid = await mockPost(`/__pay/${session.id}`);
    allDelivered(paid, `a subscription made in Stripe (${price})`);
    return paid;
  };
  const subRow = async () => (await db.query(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  const stillFree = async (what) => {
    const answer = await standing(keyA, "shopA");
    const f = checkFree(answer, "shopA", what);
    assert.deepEqual([f.base.id, f.addons.id], [freeA.base.id, freeA.addons.id], `${what}: the same keys`);
    return answer;
  };
  const base1 = await madeInStripe(PRICES.soloMonthly);
  assert.deepEqual([(await subRow()).stripe_subscription_id, (await subRow()).status, (await subRow()).tier], [base1.subscription.id, "active", "solo"], "the webhook writes it down");
  await stillFree("a Solo subscription running");
  allDelivered(await mockPost(`/__subscriptions/${base1.subscription.id}/renew`, { paid: false }), "a failed payment");
  assert.equal((await subRow()).status, "past_due");
  await stillFree("a failed payment");
  const past = Math.floor(Date.now() / 1000) - 15 * 86400;
  allDelivered(await mockPost(`/__subscriptions/${base1.subscription.id}`, { current_period_end: past, current_period_start: past - 30 * 86400 }), "the grace over");
  await stillFree("past its grace");
  const renewed = await mockPost(`/__subscriptions/${base1.subscription.id}/renew`, { paid: true });
  allDelivered(renewed, "paid again");
  assert.equal((await mockApi("/v1/refunds", { charge: renewed.invoice.charge })).object, "refund");
  assert.ok((await subRow()).unpaid_since, "a refund takes the period back");
  assert.equal(mock.subscriptions.get(base1.subscription.id).status, "canceled", "and, in full, cancels the subscription in Stripe");
  await stillFree("a full refund");
  const base2 = await madeInStripe(PRICES.shopYearly);
  const dp = await mockPost(`/__charges/${base2.invoice.charge}/dispute`);
  allDelivered(dp, "a chargeback");
  assert.ok((await subRow()).disputed_at, "a chargeback is written down");
  await stillFree("a chargeback");
  allDelivered(await mockPost(`/__disputes/${dp.dispute.id}/close`, { status: "lost" }), "the dispute lost");
  assert.equal(mock.subscriptions.get(base2.subscription.id).status, "canceled", "a lost chargeback cancels the subscription");
  await stillFree("a lost dispute");
  const base3 = await madeInStripe(PRICES.soloMonthly);
  allDelivered(await mockPost(`/__subscriptions/${base3.subscription.id}/cancel`, { at_period_end: false }), "cancelled");
  allDelivered(await mockPost(`/__subscriptions/${base3.subscription.id}`, { current_period_end: Math.floor(Date.now() / 1000) - 86400 }), "its period over");
  await stillFree("a subscription that ended");
  // The bundle's own subscription (made in Stripe) refunded in full: written down and cancelled; the add-ons' key stays.
  const bundle = await madeInStripe(PRICES.bundlem, { hub_product: "addon", hub_addon: "bundle" });
  assert.equal((await db.query(`SELECT status FROM addon_subscriptions WHERE shop_id = $1 AND product = 'bundle'`, [shopA])).rows[0].status, "active");
  await mockApi("/v1/refunds", { charge: bundle.invoice.charge });
  assert.ok((await db.query(`SELECT unpaid_since FROM addon_subscriptions WHERE shop_id = $1 AND product = 'bundle'`, [shopA])).rows[0].unpaid_since);
  await stillFree("the bundle refunded");
  // The Assistant refunded: its own key is taken back as before, and only it.
  await mockApi("/v1/refunds", { charge: asstPaid.invoice.charge });
  st = await stillFree("the Assistant refunded");
  assert.equal(st.moduleKeys.length, 1, "the add-ons' key alone");
  assert.ok(st.revokeKeyIds.includes(asstKey.id), "the Assistant's key is named for removal");
  const plans = (await db.query(`SELECT DISTINCT plan, array_to_string(modules, ',') AS modules FROM license_issues WHERE shop_id = $1 ORDER BY 1, 2`, [shopA])).rows;
  assert.deepEqual(plans.map((r) => `${r.plan} ${r.modules}`), ["c base", `c ${FIVE.join()}`, "m assistant"], "nothing but the forever keys and the Assistant's is ever signed");
  console.log("no webhook lapses a shop: ok");

  // ----- 7. No admin path does either: "Lapse now" is refused, "Undo lapse" clears an old mark, a comp changes no key. -----
  const lapse = await status(await adminCall(`/shops/${shopA}/lapse`, {}), 410, "Lapse now");
  assert.equal(lapse.error, "Lapse now is parked: every shop is free, with every add-on, for good.");
  await status(await adminCall(`/shops/${shopA}/lapse`, { lapsed: true }), 410, "Lapse now, said outright");
  assert.equal((await db.query(`SELECT lapsed_at FROM shops WHERE id = $1`, [shopA])).rows[0].lapsed_at, null, "nothing written");
  await stillFree("after Lapse now");
  const undo = await ok(await adminCall(`/shops/${shopL}/lapse`, { lapsed: false }));
  assert.deepEqual([undo.shop.lapsedAt, undo.shop.standing], [null, "comped"], "Undo lapse clears the mark made before");
  free = checkFree(await standing(keyL, "shopL"), "shopL", "after Undo lapse");
  assert.deepEqual([free.base.id, free.addons.id], [freeL.base.id, freeL.addons.id]);
  for (const body of [{ until: "forever", note: "founding member", addons: true }, { until: plusDays(10) }, { until: plusDays(-2), addons: true }, { until: "" }, { until: "forever", addons: false }]) {
    await ok(await adminCall(`/shops/${shopA}/comp`, body));
    await stillFree(`comp ${JSON.stringify(body)}`);
  }
  let list = await ok(await adminCall("/accounts"));
  const adminA = list.shops.find((s) => s.id === shopA);
  assert.deepEqual([adminA.standing, adminA.source, adminA.message, adminA.compUntil?.slice(0, 4), adminA.lapsedAt], ["comped", "free", "Free, with every add-on.", "2099", null], "the admin page: free, and the comp it set (backup space of its own)");
  assert.deepEqual(adminA.addons.on, FIVE);
  assert.ok(list.shops.every((s) => s.standing === "comped"), "every shop on the admin page is free");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE last_day = $1 AND revoked_at IS NOT NULL`, [NO_END])).rows[0].n, 0, "no forever key was ever revoked");
  console.log("no admin path lapses a shop: ok");

  // ----- 8. The webhook's own checks: a replay is a 200 and changes nothing; a bad signature is 400; a forged object fails. -----
  const paidEvent = mock.events.find((e) => e.type === "invoice.paid");
  const replay = await mockPost(`/__replay/${paidEvent.id}`);
  assert.match(replay.delivered[0].body, /"replay":true/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stripe_events WHERE id = ANY($1)`, [mock.events.map((e) => e.id)])).rows[0].n, mock.events.length, "every event handled once");
  assert.equal((await postWebhook(paidEvent, "whsec_wrong_secret_000000")).status, 400, "bad signature");
  assert.equal((await fetch(`${HUB}/v1/stripe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(paidEvent) })).status, 400, "no signature");
  assert.equal((await postWebhook({ id: `evt_${RUN}x`, type: "customer.updated", data: { object: { id: "cus_whatever" } } })).status, 200, "an event the hub doesn't act on");
  const forged = await postWebhook({ id: `evt_${RUN}forged`, type: "customer.subscription.updated", data: { object: { id: "sub_forged000000", status: "active", metadata: { hub_shop_id: shopA }, current_period_end: 4102444800 } } });
  assert.equal(forged.status, 502, "a subscription Stripe doesn't have can't change anything");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stripe_events WHERE id = $1`, [`evt_${RUN}forged`])).rows[0].n, 0, "an event that failed isn't marked handled");
  console.log("webhooks: ok");

  // ----- 9. The export carries the keys and the billing tables. -----
  const gz = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  const rows = zlib.gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.t === "license_issue" && r.key_id === freeA.base.id && r.plan === "c" && r.tier === "shop" && r.revoked_at === null));
  assert.ok(rows.some((r) => r.t === "license_issue" && r.key_id === freeA.addons.id && r.modules.join() === FIVE.join() && r.revoked_at === null));
  assert.ok(rows.some((r) => r.t === "subscription" && r.shop_id === shopA && r.stripe_subscription_id === base3.subscription.id));
  assert.ok(rows.some((r) => r.t === "stripe_event" && r.id === paidEvent.id));
  assert.ok(!JSON.stringify(rows).includes("sk_test_billingmock"), "no Stripe key in the export");
  console.log("export: ok");

  // ----- 10. Billing closed (no Stripe variables): the keys are signed all the same; nothing is sold, not even the Assistant. -----
  await stopHub();
  const closed = Object.fromEntries(Object.entries(ENV).filter(([name]) => !/^STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PRICE_)/.test(name)));
  await startHub(closed);
  const keyC = await register("Billing Test Shop C");
  checkFree(await claim(keyC, { shopRef: "shopC", shopName: "C Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true }), "shopC", "a new shop with billing closed");
  await stillFree("billing closed");
  free = checkFree(await standing(keyT, "shopT"), "shopT", "the old trial shop with billing closed");
  assert.deepEqual([free.base.id, free.addons.id], [freeT.base.id, freeT.addons.id]);
  me = await ok(await page(a, "/me"));
  assert.deepEqual([me.billing.open, me.shops[0].standing, me.shops[0].canSubscribe, me.shops[0].assistant.canAdd], [false, "comped", false, false]);
  list = await ok(await adminCall("/accounts"));
  assert.match(list.billing.problem, /STRIPE_SECRET_KEY isn't set/);
  await status(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }), 410, "plans parked, closed or not");
  await status(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }), 503, "the Assistant with billing closed");
  console.log("billing closed: ok");

  // ----- 11. A price id given to two products: Stripe stays closed and the admin page says why. -----
  await stopHub();
  await startHub({ ...ENV, STRIPE_PRICE_VAC_MONTHLY: PRICES.soloMonthly });
  list = await ok(await adminCall("/accounts"));
  assert.match(list.billing.problem, new RegExp(`${PRICES.soloMonthly} is in the plans and STRIPE_PRICE_VAC_MONTHLY`));
  await stillFree("Stripe misconfigured");
  console.log("overlapping price ids: ok");

  // Clean up: accounts go, test installs are blocked.
  for (const x of list.accounts.filter((x) => x.email.endsWith(`-${RUN}@stitchhub.test`))) await ok(await adminCall(`/accounts/${x.id}`, undefined, "DELETE"));
  const installs = (await ok(await call("/v1/admin/summary", { key: ADMIN }))).installs;
  for (const i of installs.filter((x) => /^Billing Test /.test(x.name) && !x.blocked)) await ok(await adminCall(`/installs/${i.id}/block`, { blocked: true }));
  assert.ok(!/\bshk_|sk_test_billingmock|whsec_billingtest/.test(hubLog), "the hub's log holds no install key, Stripe key or webhook secret");
  assert.ok(!hubLog.includes(HUB_LICENSE_KEY.slice(0, 40)), "the hub's log never shows the signing key");
  console.log("all billing checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
