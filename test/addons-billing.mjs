// Checks selling the trade add-ons and extra stores (src/addons.mjs, migration 032; the Stripe mock stands in for Stripe):
// the account page's prices (Maker Shop among them, all five for $30); a module Checkout is its own subscription and signs
// a key for its module ids, sent in moduleKeys beside the base key; a second add-on adds its own key; the bundle switch
// (the singles cancelled at once with a proration credit, their keys revoked, one key naming all five); a single add-on
// refused while the bundle runs; a full refund takes the bundle's period back (keys revoked, named for removal,
// cancelled); a chargeback on an add-on acted on once and undone when won; the admin's comp of everything; extra stores
// as a quantity on the base subscription (at Checkout, and following the stores the claim reports); a top-up refunded
// before its credit lands; and a hub without the add-on prices offers none. A fresh scratch database, dropped at the end.
// usage: node test/addons-billing.mjs   (or DATABASE_URL=postgresql://.../postgres to name the server)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { startStripeMock } from "./stripe-mock.mjs";

const BASE_DB = process.env.DATABASE_URL || "postgresql://stitchbench:stitchbench@127.0.0.1:5433/postgres";
const ADMIN = "addons-billing-test-admin-0123456789";
const JOIN = "join-addons-billing-test";
const RUN = Date.now().toString(36);
const FRESH_DB = `stitchhub_addons_${RUN}`;
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
const WEBHOOK_SECRET = "whsec_addonstest1234567890";
const MONTHLY = { vac: 1000, appliance: 500, scheduling: 1500, marketing: 1000, maker: 1000, bundle: 3000, store: 2500 };
const P = { soloMonthly: `price_solom_${RUN}`, soloYearly: `price_soloy_${RUN}`, shopMonthly: `price_shopm_${RUN}`, shopYearly: `price_shopy_${RUN}`, aMonthly: `price_am_${RUN}`, aYearly: `price_ay_${RUN}`, aTopup: `price_at_${RUN}` };
for (const k of Object.keys(MONTHLY)) {
  P[`${k}m`] = `price_${k}m_${RUN}`;
  P[`${k}y`] = `price_${k}y_${RUN}`;
}
const CATALOG = [
  [P.soloMonthly, "month", 2500],
  [P.soloYearly, "year", 25000],
  [P.shopMonthly, "month", 4500],
  [P.shopYearly, "year", 45000],
  [P.aMonthly, "month", 1500],
  [P.aYearly, "year", 15000],
  [P.aTopup, "once", 1000],
  ...Object.entries(MONTHLY).flatMap(([k, c]) => [
    [P[`${k}m`], "month", c],
    [P[`${k}y`], "year", c * 10],
  ]),
].map(([id, interval, amount]) => ({ id, interval, amount }));

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const HUB1_X = publicKey.export({ format: "jwk" }).x;
const HUB_LICENSE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }), "utf8").toString("base64");
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const stripeMock = await startStripeMock({ port: 0, webhookUrl: `${HUB}/v1/stripe`, webhookSecret: WEBHOOK_SECRET, catalog: CATALOG });

const ADDON_ENV = Object.fromEntries(Object.keys(MONTHLY).flatMap((k) => [[`STRIPE_PRICE_${k.toUpperCase()}_MONTHLY`, P[`${k}m`]], [`STRIPE_PRICE_${k.toUpperCase()}_YEARLY`, P[`${k}y`]]]));
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
  MAIL_DEV_LOG: "true",
  HUB_NAME: "Add-ons Billing Test Hub",
  HUB_LICENSE_KID: "hub1",
  HUB_LICENSE_KEY,
  STRIPE_API_BASE: stripeMock.url,
  STRIPE_SECRET_KEY: "sk_test_addonsmock12345678",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SOLO_MONTHLY: P.soloMonthly,
  STRIPE_PRICE_SOLO_YEARLY: P.soloYearly,
  STRIPE_PRICE_SHOP_MONTHLY: P.shopMonthly,
  STRIPE_PRICE_SHOP_YEARLY: P.shopYearly,
  STRIPE_PRICE_ASSISTANT_MONTHLY: P.aMonthly,
  STRIPE_PRICE_ASSISTANT_YEARLY: P.aYearly,
  STRIPE_PRICE_ASSISTANT_TOPUP: P.aTopup,
  ASSISTANT_TOPUP_CALLS: "5",
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
  await stripeMock.close();
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
const page = (jar, p, json) => call(`/account/api${p}`, { jar, json });
const settle = async (what) => {
  await stripeMock.settle();
  assert.deepEqual(stripeMock.webhooks.filter((w) => w.status !== 200), [], `${what}: a webhook wasn't taken`);
};
const mockPost = async (p, json = {}) => {
  const out = await fetch(stripeMock.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }).then((r) => r.json());
  await settle(p);
  return out;
};
const mockApi = async (p, form) => {
  const out = await fetch(stripeMock.url + p, { method: "POST", headers: { Authorization: "Bearer sk_test_addonsmock12345678", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }).then((r) => r.json());
  await settle(p);
  return out;
};
const claim = (key, body) => ok(call("/v1/shops/claim", { key, json: body }));
const standing = (key, ref) => ok(call(`/v1/shops/${ref}/standing`, { key }));
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const day = (d) => new Date(d).toISOString().slice(0, 10);
const allDelivered = (r, what) => {
  assert.ok(r.delivered?.length, `${what}: no webhooks went out`);
  for (const d of r.delivered) assert.equal(d.status, 200, `${what}: webhook ${d.type} answered ${d.status} ${d.body ?? d.error ?? ""}`);
};
function keyPayload(text, shopRef, what) {
  const m = /^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/.exec(String(text ?? ""));
  assert.ok(m, `${what}: not a key`);
  const bytes = Buffer.from(m[1], "base64url");
  const good = crypto.verify(null, bytes, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: HUB1_X }, format: "jwk" }), Buffer.from(m[2], "base64url"));
  assert.ok(good, `${what}: the signature doesn't verify`);
  const p = JSON.parse(bytes.toString("utf8"));
  assert.equal(p.s, shopRef, `${what}: the key names ${p.s}, not ${shopRef}`);
  return p;
}
const modulesOfKeys = (keys, ref) => keys.map((k) => keyPayload(k, ref, "module key").m.join("+")).sort();
const buy = async (jar, shopId, addon, interval = "monthly") => {
  const co = await ok(await page(jar, `/shops/${shopId}/addons/checkout`, { addon, interval, acceptTerms: true }));
  const paid = await mockPost(`/__pay/${co.sessionId}`);
  allDelivered(paid, `${addon} payment`);
  return { co, paid, sub: paid.subscription };
};
const FIVE = "vac+appliance+scheduling+marketing+maker"; // the key names them in this order

try {
  // ----- 1. a shop on its trial and its owner's account; the page offers every add-on, Maker Shop among them -----
  const installKey = await register("Add-ons Test Shop");
  const claimA = await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopA = claimA.shop.id;
  assert.deepEqual(claimA.moduleKeys, [], "no add-on keys before one is bought");
  await ok(await call("/v1/accounts/start", { key: installKey, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: `owner-a-${RUN}@stitchhub.test`, termsVersion: "2026-10-02" } }));
  const a = browser();
  await ok(await page(a, "/set-password", { token: linkToken("set-password"), password: "Good-password-1" }));
  const b = browser();
  await ok(await page(b, "/signup", { email: `owner-b-${RUN}@stitchhub.test`, password: "Good-password-2", acceptTerms: true }));
  await ok(await page(b, "/verify", { token: linkToken("verify") }));
  let me = await ok(await page(a, "/me"));
  const xp = me.billing.addonPrices;
  assert.deepEqual(xp.maker, { label: "Maker Shop", monthly: "$10 a month", yearly: "$100 a year" });
  assert.deepEqual(xp.bundle, { label: "All five add-ons", monthly: "$30 a month", yearly: "$300 a year" });
  assert.deepEqual([xp.vac.monthly, xp.appliance.monthly, xp.scheduling.monthly, xp.marketing.monthly], ["$10 a month", "$5 a month", "$15 a month", "$10 a month"]);
  assert.deepEqual(xp.store, { label: "Each extra store", monthly: "$25 a month", yearly: "$250 a year" });
  assert.equal(me.shops[0].addons.items.maker.canAdd, true);
  assert.equal(me.shops[0].addons.items.bundle.canAdd, true);
  assert.deepEqual(me.shops[0].addons.on, []);
  await status(await page(a, `/shops/${shopA}/addons/checkout`, { addon: "embroidery", interval: "monthly" }), 400, "an unknown add-on");
  await status(await page(a, `/shops/${shopA}/addons/checkout`, { addon: "maker", interval: "weekly" }), 400, "a bad interval");
  await status(await page(b, `/shops/${shopA}/addons/checkout`, { addon: "maker", interval: "monthly" }), 404, "another account's shop");
  console.log("prices and refusals: ok");

  // ----- 2. a module Checkout: Maker Shop monthly, its own subscription and key -----
  const maker = await buy(a, shopA, "maker");
  const session = stripeMock.sessions.get(maker.co.sessionId);
  assert.deepEqual([session.mode, session.line_items.data[0].price.id, session.metadata.hub_product, session.metadata.hub_addon], ["subscription", P.makerm, "addon", "maker"]);
  assert.equal(session.subscription_data.metadata.hub_addon, "maker", "the subscription itself names its add-on");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].n, 0, "nothing in the base plan's table");
  const row = (await db.query(`SELECT * FROM addon_subscriptions WHERE shop_id = $1`, [shopA])).rows;
  assert.deepEqual(row.map((r) => [r.product, r.stripe_subscription_id, r.plan, r.status, r.price_id]), [["maker", maker.sub.id, "m", "active", P.makerm]]);
  let st = await standing(installKey, "shopA");
  assert.equal(st.standing, "trial", "the base standing is untouched");
  assert.equal(keyPayload(st.key, "shopA", "base key").m.join(), "base");
  assert.equal(st.moduleKeys.length, 1);
  const mk = keyPayload(st.moduleKeys[0], "shopA", "Maker key");
  assert.deepEqual([mk.m, mk.p, mk.u, mk.g], [["maker"], "m", day(maker.sub.current_period_end * 1000), 14]);
  assert.deepEqual((await standing(installKey, "shopA")).moduleKeys, st.moduleKeys, "asked again: the same key");
  await status(await page(a, `/shops/${shopA}/addons/checkout`, { addon: "maker", interval: "yearly" }), 409, "already has Maker Shop");
  // A second add-on: Scheduling yearly, a second key.
  const sched = await buy(a, shopA, "scheduling", "yearly");
  st = await standing(installKey, "shopA");
  assert.deepEqual(modulesOfKeys(st.moduleKeys, "shopA"), ["maker", "scheduling"]);
  assert.equal(keyPayload(st.moduleKeys.find((k) => keyPayload(k, "shopA", "k").m[0] === "scheduling"), "shopA", "Scheduling key").p, "y");
  me = await ok(await page(a, "/me"));
  assert.deepEqual(me.shops[0].addons.on.sort(), ["maker", "scheduling"]);
  assert.equal(me.shops[0].addons.items.scheduling.status, "active");
  console.log("module checkout: ok (its own subscription, a key per add-on)");

  // ----- 3. the bundle switch: the singles cancelled with a proration credit, one key for all five -----
  const bundle = await buy(a, shopA, "bundle");
  for (const s of [maker.sub, sched.sub]) {
    const m = stripeMock.subscriptions.get(s.id);
    assert.equal(m.status, "canceled", `${s.id} is cancelled at the switch`);
    assert.equal(m.cancel_prorate, true, "with Stripe's proration (a credit for the unused days)");
  }
  assert.equal(stripeMock.subscriptions.get(bundle.sub.id).status, "active");
  st = await standing(installKey, "shopA");
  assert.deepEqual(modulesOfKeys(st.moduleKeys, "shopA"), [FIVE], "one key naming all five");
  const revokedSingles = (await db.query(`SELECT key_id FROM license_issues WHERE shop_id = $1 AND revoked_at IS NOT NULL AND (modules = '{maker}' OR modules = '{scheduling}')`, [shopA])).rows.map((r) => r.key_id);
  assert.equal(revokedSingles.length, 2, "the singles' keys are revoked");
  for (const id of revokedSingles) assert.ok(st.revokeKeyIds.includes(id), "and named for the program to drop");
  await status(await page(a, `/shops/${shopA}/addons/checkout`, { addon: "vac", interval: "monthly" }), 409, "a single add-on while the bundle runs");
  me = await ok(await page(a, "/me"));
  assert.deepEqual(me.shops[0].addons.on.sort(), FIVE.split("+").sort());
  assert.equal(me.shops[0].addons.items.vac.canAdd, false);
  console.log("bundle switch: ok");

  // ----- 4. a refund of the bundle's period: taken back, keys revoked, cancelled -----
  const bundleCharge = bundle.paid.invoice.charge;
  await mockApi("/v1/refunds", { charge: bundleCharge });
  const br = (await db.query(`SELECT * FROM addon_subscriptions WHERE shop_id = $1 AND product = 'bundle'`, [shopA])).rows[0];
  assert.ok(br.unpaid_since, "the period is taken back");
  assert.equal(br.unpaid_charge_id, bundleCharge);
  assert.equal(stripeMock.subscriptions.get(bundle.sub.id).status, "canceled", "a full refund cancels it");
  const bundleKeyId = keyPayload(st.moduleKeys[0], "shopA", "bundle key").id;
  st = await standing(installKey, "shopA");
  assert.deepEqual(st.moduleKeys, [], "no add-on keys after the refund");
  assert.ok(st.revokeKeyIds.includes(bundleKeyId), "the bundle's key is named for removal");
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops[0].addons.items.bundle.status, "ended");
  assert.equal(me.shops[0].addons.items.bundle.canAdd, true, "it can be bought again");
  console.log("refund take-back: ok");

  // ----- 5. a chargeback on an add-on: acted on once, undone when won -----
  const vac = await buy(a, shopA, "vac");
  st = await standing(installKey, "shopA");
  assert.deepEqual(modulesOfKeys(st.moduleKeys, "shopA"), ["vac"]);
  const vacKeyId = keyPayload(st.moduleKeys[0], "shopA", "vac key").id;
  const dp = (await mockPost(`/__charges/${vac.paid.invoice.charge}/dispute`, { status: "needs_response" })).dispute;
  let vr = (await db.query(`SELECT * FROM addon_subscriptions WHERE shop_id = $1 AND product = 'vac'`, [shopA])).rows[0];
  assert.ok(vr.unpaid_since, "a chargeback takes the period back");
  assert.deepEqual(vr.chargeback_dispute_ids, [dp.id], "acted on, written down");
  st = await standing(installKey, "shopA");
  assert.deepEqual(st.moduleKeys, []);
  assert.ok(st.revokeKeyIds.includes(vacKeyId));
  await mockPost(`/__disputes/${dp.id}/update`, { status: "under_review" });
  vr = (await db.query(`SELECT * FROM addon_subscriptions WHERE shop_id = $1 AND product = 'vac'`, [shopA])).rows[0];
  assert.deepEqual(vr.chargeback_dispute_ids, [dp.id], "a later event for it changes nothing more");
  await mockPost(`/__disputes/${dp.id}/close`, { status: "won" });
  vr = (await db.query(`SELECT * FROM addon_subscriptions WHERE shop_id = $1 AND product = 'vac'`, [shopA])).rows[0];
  assert.equal(vr.unpaid_since, null, "won: the period counts again");
  st = await standing(installKey, "shopA");
  assert.deepEqual(modulesOfKeys(st.moduleKeys, "shopA"), ["vac"], "a fresh key");
  assert.notEqual(keyPayload(st.moduleKeys[0], "shopA", "vac key").id, vacKeyId, "the revoked one stays revoked");
  console.log("chargeback on an add-on: ok");

  // ----- 6. the admin's comp of everything: a key for all five, plan c; taken away, revoked -----
  await ok(await call(`/v1/admin/shops/${shopA}/comp`, { key: ADMIN, json: { until: "forever", note: "test", addons: true } }));
  st = await standing(installKey, "shopA");
  const comp = st.moduleKeys.map((k) => keyPayload(k, "shopA", "comp key")).find((p) => p.p === "c");
  assert.ok(comp, "a comp key");
  assert.deepEqual([comp.m.join("+"), comp.u], ["vac+appliance+scheduling+marketing+maker", "2099-12-31"]);
  assert.equal(st.standing, "comped");
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops[0].addons.comped, true);
  await ok(await call(`/v1/admin/shops/${shopA}/comp`, { key: ADMIN, json: { until: "" } }));
  st = await standing(installKey, "shopA");
  assert.ok(st.revokeKeyIds.includes(comp.id), "the comp's add-on key is revoked when the comp goes");
  assert.ok(!st.moduleKeys.some((k) => keyPayload(k, "shopA", "k").p === "c"));
  // A comp of the program only covers no add-ons.
  await ok(await call(`/v1/admin/shops/${shopA}/comp`, { key: ADMIN, json: { until: "forever", addons: false } }));
  st = await standing(installKey, "shopA");
  assert.ok(!st.moduleKeys.some((k) => keyPayload(k, "shopA", "k").p === "c"), "program only");
  await ok(await call(`/v1/admin/shops/${shopA}/comp`, { key: ADMIN, json: { until: "" } }));
  console.log("comp of everything: ok");

  // ----- 7. extra stores: a quantity on the base subscription -----
  // A company reporting 3 stores subscribes: the Checkout has the plan and 2 extra stores.
  await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true, stores: 3 });
  assert.equal((await db.query(`SELECT stores FROM shops WHERE id = $1`, [shopA])).rows[0].stores, 3);
  const base = await ok(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly", acceptTerms: true }));
  const bs = stripeMock.sessions.get(base.sessionId);
  assert.deepEqual(bs.line_items.data.map((l) => [l.price.id, l.quantity]), [[P.soloMonthly, 1], [P.storem, 2]]);
  const basePaid = await mockPost(`/__pay/${base.sessionId}`);
  allDelivered(basePaid, "base payment");
  let sub = (await db.query(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  assert.deepEqual([sub.tier, sub.price_id, sub.store_quantity], ["solo", P.soloMonthly, 2], "the plan from the plan item; 2 stores billed");
  st = await standing(installKey, "shopA");
  assert.equal(keyPayload(st.key, "shopA", "base key").l, "solo", "the store item doesn't change the plan");
  // The program now reports 4: one more is billed; then 1: the store item goes.
  await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true, stores: 4 });
  await settle("stores 4");
  let ms = stripeMock.subscriptions.get(basePaid.subscription.id);
  assert.deepEqual(ms.items.data.map((i) => [i.price.id, i.quantity]), [[P.soloMonthly, 1], [P.storem, 3]]);
  assert.equal(ms.last_proration_behavior, "create_prorations");
  assert.equal((await db.query(`SELECT store_quantity FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].store_quantity, 3);
  await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true, stores: 1 });
  await settle("stores 1");
  ms = stripeMock.subscriptions.get(basePaid.subscription.id);
  assert.deepEqual(ms.items.data.map((i) => i.price.id), [P.soloMonthly], "no extra stores: the item goes");
  assert.equal((await db.query(`SELECT store_quantity FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].store_quantity, 0);
  // A claim that says nothing about stores leaves them as they were; 2 adds the item back.
  await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true, stores: 2 });
  await settle("stores 2");
  await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true });
  await settle("stores unsaid");
  assert.equal((await db.query(`SELECT stores FROM shops WHERE id = $1`, [shopA])).rows[0].stores, 2);
  ms = stripeMock.subscriptions.get(basePaid.subscription.id);
  assert.deepEqual(ms.items.data.map((i) => [i.price.id, i.quantity]), [[P.soloMonthly, 1], [P.storem, 1]]);
  // A renewal bills the plan and the stores.
  const renewed = await mockPost(`/__subscriptions/${basePaid.subscription.id}/renew`, { paid: true });
  assert.equal(renewed.invoice.amount_paid, 2500 + 2500, "the plan and one extra store");
  sub = (await db.query(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  assert.deepEqual([sub.tier, sub.store_quantity, sub.status], ["solo", 1, "active"]);
  // The switch to Shop moves the plan item, not the store item.
  await ok(await page(a, `/shops/${shopA}/switch`, { plan: "shop" }));
  await settle("switch");
  ms = stripeMock.subscriptions.get(basePaid.subscription.id);
  assert.deepEqual(ms.items.data.map((i) => [i.price.id, i.quantity]), [[P.shopMonthly, 1], [P.storem, 1]]);
  me = await ok(await page(a, "/me"));
  assert.deepEqual(me.shops[0].stores, { reported: 2, extra: 1, billed: 1 });
  const adminShops = await ok(await call("/v1/admin/accounts", { key: ADMIN }));
  const adm = adminShops.shops.find((s) => s.id === shopA);
  assert.deepEqual(adm.stores, { reported: 2, extra: 1, billed: 1 }, "the admin page shows the stores");
  assert.ok(adm.addons.on.includes("vac"));
  console.log("extra stores: ok");

  // ----- 8. a top-up refunded before its Checkout credit lands: held, then taken back when it does -----
  const asst = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly", acceptTerms: true }));
  await mockPost(`/__pay/${asst.sessionId}`);
  const instA = (await db.query(`SELECT install_id, shop_ref FROM shops WHERE id = $1`, [shopA])).rows[0];
  const tu = await ok(await page(a, `/shops/${shopA}/assistant/topup`, {}));
  // The mock delivers checkout.session.completed at once; to see the other order (the refund's webhook first, as when the
  // completed event failed and Stripe retries it later), the credit is taken back out of the database as if it had never
  // landed, the refund goes, and then the completed event is delivered again.
  await mockPost(`/__pay/${tu.sessionId}`);
  const tsession = stripeMock.sessions.get(tu.sessionId);
  const completedEvents = stripeMock.events.filter((e) => e.type === "checkout.session.completed" && e.data.object.id === tu.sessionId);
  await db.query(`DELETE FROM assistant_topups WHERE stripe_session_id = $1`, [tu.sessionId]);
  await db.query(`UPDATE assistant_usage SET bonus = 0 WHERE install_id = $1 AND shop_ref = $2`, [instA.install_id, instA.shop_ref]);
  await db.query(`DELETE FROM stripe_events WHERE id = $1`, [completedEvents.at(-1).id]);
  await mockApi("/v1/refunds", { charge: tsession.charge });
  const pend = (await db.query(`SELECT share FROM assistant_topup_pending WHERE stripe_payment_intent = $1`, [tsession.payment_intent])).rows[0];
  assert.equal(Number(pend.share), 1, "the refund waits for the credit");
  await mockPost(`/__replay/${completedEvents.at(-1).id}`);
  const use = (await db.query(`SELECT bonus FROM assistant_usage WHERE install_id = $1 AND shop_ref = $2 ORDER BY month DESC LIMIT 1`, [instA.install_id, instA.shop_ref])).rows[0];
  assert.equal(use.bonus, 0, "credited and taken back at once");
  assert.equal((await db.query(`SELECT calls_taken FROM assistant_topups WHERE stripe_session_id = $1`, [tu.sessionId])).rows[0].calls_taken, 5);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assistant_topup_pending`)).rows[0].n, 0, "the pending row is used up");
  console.log("a top-up refunded before its credit: ok");

  // ----- 9. a hub without the add-on prices offers none -----
  await stopHub();
  const bare = Object.fromEntries(Object.entries(ENV).filter(([k]) => !Object.hasOwn(ADDON_ENV, k)));
  await startHub(bare);
  me = await ok(await page(a, "/me"));
  assert.equal(me.billing.addonPrices, null);
  assert.equal(me.shops[0].addons.items.maker.canAdd, false);
  await status(await page(a, `/shops/${shopA}/addons/checkout`, { addon: "maker", interval: "monthly", acceptTerms: true }), 503, "not for sale");
  const adm2 = await ok(await call("/v1/admin/accounts", { key: ADMIN }));
  assert.match(adm2.billing.addonProblem, /STRIPE_PRICE_MAKER_MONTHLY/);
  console.log("prices not set: ok");
  console.log("all add-on billing checks passed");
} catch (e) {
  console.error(e);
  console.error("hub log tail:\n" + hubLog.split("\n").filter((l) => /billing|stripe|Error|error/.test(l)).slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  await stop();
}
