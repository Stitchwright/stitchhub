// Checks billing end to end: starts a hub of its own on a free port against a scratch database with the Stripe mock
// (test/stripe-mock.mjs) standing in for Stripe and a throwaway Ed25519 key standing in for hub1, then walks a shop from
// its trial through subscribe → active → past_due → lapsed → paid again, cancellation, a yearly plan, a refund and a
// chargeback (keys revoked), the waiver for a partnered retail shop and its end, comps, the admin's "Lapse now", replayed
// and badly signed webhooks, the tenant rule (one account can't subscribe another's shop), the two plans (Solo and Shop,
// Switch with proration, several prices as one plan, an unknown price counted as Shop, lapsed keeps the last plan, the
// key's l), founding shops (the admin's mark, 25 at most, founding prices, kept across a gap under 60 days and lost
// after), the export, and a hub with billing closed. Every key the hub sends is verified here with the program's own
// verify logic (license.ts, copied). Run it on a fresh database: the founding places are counted across the database.
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/billing.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { startStripeMock } from "./stripe-mock.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "billing-test-admin-token";
const JOIN = "join-billing-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const WEBHOOK_SECRET = "whsec_billingtest1234567890";
// The two plans' prices, founding or not (src/billing.mjs priceBook), an older Solo price still counted (decision 12: a
// price rise adds a new id in front) and the single price from before the plans (STRIPE_PRICE_MONTHLY: counted as Shop).
const PRICES = {
  soloMonthly: `price_solom_${RUN}`,
  soloMonthlyOld: `price_solom_old_${RUN}`,
  soloYearly: `price_soloy_${RUN}`,
  shopMonthly: `price_shopm_${RUN}`,
  shopYearly: `price_shopy_${RUN}`,
  soloMonthlyFounding: `price_solomf_${RUN}`,
  soloYearlyFounding: `price_soloyf_${RUN}`,
  shopMonthlyFounding: `price_shopmf_${RUN}`,
  shopYearlyFounding: `price_shopyf_${RUN}`,
  legacyMonthly: `price_month_${RUN}`,
  legacyYearly: `price_year_${RUN}`,
};
const CATALOG = [
  [PRICES.soloMonthly, "month", 2500],
  [PRICES.soloMonthlyOld, "month", 2000],
  [PRICES.soloYearly, "year", 25000],
  [PRICES.shopMonthly, "month", 4500],
  [PRICES.shopYearly, "year", 45000],
  [PRICES.soloMonthlyFounding, "month", 1500],
  [PRICES.soloYearlyFounding, "year", 15000],
  [PRICES.shopMonthlyFounding, "month", 3000],
  [PRICES.shopYearlyFounding, "year", 30000],
  [PRICES.legacyMonthly, "month", 2500],
  [PRICES.legacyYearly, "year", 25000],
].map(([id, interval, amount]) => ({ id, interval, amount }));

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
  MAIL_DEV_LOG: "true", // every email goes to the hub's log; the test reads links and dunning mail from there
  HUB_NAME: "Billing Test Hub",
  HUB_LICENSE_KID: "hub1",
  HUB_LICENSE_KEY,
  STRIPE_API_BASE: mock.url,
  STRIPE_SECRET_KEY: "sk_test_billingmock12345678",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SOLO_MONTHLY: `${PRICES.soloMonthly}, ${PRICES.soloMonthlyOld}`,
  STRIPE_PRICE_SOLO_YEARLY: PRICES.soloYearly,
  STRIPE_PRICE_SHOP_MONTHLY: PRICES.shopMonthly,
  STRIPE_PRICE_SHOP_YEARLY: PRICES.shopYearly,
  STRIPE_PRICE_SOLO_MONTHLY_FOUNDING: PRICES.soloMonthlyFounding,
  STRIPE_PRICE_SOLO_YEARLY_FOUNDING: PRICES.soloYearlyFounding,
  STRIPE_PRICE_SHOP_MONTHLY_FOUNDING: PRICES.shopMonthlyFounding,
  STRIPE_PRICE_SHOP_YEARLY_FOUNDING: PRICES.shopYearlyFounding,
  STRIPE_PRICE_MONTHLY: PRICES.legacyMonthly,
  STRIPE_PRICE_YEARLY: PRICES.legacyYearly,
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
const mockPost = (p, json = {}) => fetch(mock.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }).then((r) => r.json());
const mockApi = (p, form) => fetch(mock.url + p, { method: "POST", headers: { Authorization: "Bearer sk_test_billingmock12345678", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }).then((r) => r.json());
const day = (d) => new Date(d).toISOString().slice(0, 10);
const today = () => day(Date.now());
const plusDays = (n, from = Date.now()) => day(from + n * 86400_000);
const claim = (key, body) => ok(call("/v1/shops/claim", { key, json: body }));
const standing = (key, ref) => ok(call(`/v1/shops/${ref}/standing`, { key }));
/** The newest link of a kind in the hub's log (MAIL_DEV_LOG prints every email). */
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const allDelivered = (r, what) => {
  assert.ok(r.delivered?.length, `${what}: no webhooks went out`);
  for (const d of r.delivered) assert.equal(d.status, 200, `${what}: webhook ${d.type} answered ${d.status} ${d.body ?? d.error ?? ""}`);
};
/** A key as the program would take it: verified with hub1, for this shop, carrying "base". */
function checkKey(text, shopId, what) {
  const v = verifyLicense(text, PUBLIC_KEYS);
  assert.ok(v.ok, `${what}: the key doesn't verify (${v.reason})`);
  assert.equal(v.kid, "hub1");
  assert.equal(v.scope, "hub");
  assert.equal(v.payload.s, shopId, `${what}: the key is for another shop`);
  assert.deepEqual(v.payload.m, ["base"]);
  assert.match(v.payload.id, /^[0-9A-Z]{8}$/);
  return v.payload;
}
const signWebhook = (body, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
};
const postWebhook = (ev, secret = WEBHOOK_SECRET) => {
  const body = JSON.stringify(ev);
  return fetch(`${HUB}/v1/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signWebhook(body, secret) }, body });
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

try {
  assert.match(hubLog, /signing as kid hub1 \(public x /, "the hub says which key it signs with");
  assert.ok(hubLog.includes(HUB1_X), "the public x printed is the one for license-keys.ts");

  // ----- 1. A trial shop gets a trial key, verified like a pasted one; asked again, the same key. -----
  const keyA = await register("Billing Test Shop A");
  const claimA = await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopA = claimA.shop.id;
  assert.deepEqual([claimA.standing, claimA.lastDay, claimA.revokeKeyIds, claimA.plan, claimA.interval, claimA.founding], ["trial", plusDays(30), [], "shop", null, false]);
  const trialKey = checkKey(claimA.key, shopA, "trial key");
  assert.deepEqual([trialKey.p, trialKey.f, trialKey.u, trialKey.g, trialKey.n, trialKey.l], ["t", today(), plusDays(30), 14, "A Repair", "shop"]);
  const againA = await standing(keyA, "shopA");
  assert.equal(againA.key, claimA.key, "the same key is sent again, not a new one");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1`, [shopA])).rows[0].n, 1);
  console.log("trial key: ok");

  // ----- 2. Accounts: A's owner from the program (the link is read off the hub's log); B on the hub first. -----
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await ok(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: emailA, termsVersion: "2026-10-02" } }));
  const a = browser();
  await ok(await page(a, "/set-password", { token: linkToken("set-password"), password: "Good-password-1" }));
  let me = await ok(await page(a, "/me"));
  assert.equal(me.billing.open, true);
  assert.deepEqual(me.shops.map((s) => [s.name, s.standing, s.canSubscribe, s.canManage, s.subscription]), [["A Repair", "trial", true, false, null]]);
  const emailB = `owner-b-${RUN}@stitchhub.test`;
  const b = browser();
  await ok(await page(b, "/signup", { email: emailB, password: "Good-password-2", acceptTerms: true }));
  await ok(await page(b, "/verify", { token: linkToken("verify") }));
  console.log("accounts: ok");

  // ----- 3. Tenant and input: B can't subscribe A's shop or open its billing; a plan must be monthly or yearly. -----
  await status(await page(b, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }), 404, "another account's shop");
  await status(await page(b, `/shops/${shopA}/portal`, {}), 404, "another account's shop (portal)");
  await status(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "weekly" }), 400, "bad interval");
  await status(await page(browser(), `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }), 401, "signed out");
  await status(await page(a, `/shops/${shopA}/portal`, {}), 409, "no billing yet");
  console.log("tenant: ok");

  // ----- 4. Subscribe monthly: Checkout at the mock, paid, webhooks in; active with a monthly key. -----
  // A's account accepted an older terms version (from the program), so Subscribe carries the tick (test/terms.mjs).
  const co = await ok(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly", acceptTerms: true }));
  assert.ok(co.url.startsWith(`${mock.url}/pay/cs_`), co.url);
  const session = mock.sessions.get(co.sessionId);
  assert.equal(session.mode, "subscription");
  assert.equal(session.line_items.data[0].price.id, PRICES.soloMonthly);
  assert.equal(session.metadata.hub_shop_id, shopA);
  assert.equal(session.subscription_data.metadata.hub_shop_id, shopA);
  assert.equal(session.client_reference_id, shopA);
  assert.equal(mock.customers.get(session.customer).email, emailA, "one Stripe customer per account, with its email");
  assert.equal((await fetch(co.url)).status, 200, "the mock's payment page");
  const paid = await mockPost(`/__pay/${co.sessionId}`);
  allDelivered(paid, "first payment");
  const subA = paid.subscription.id;
  let st = await standing(keyA, "shopA");
  assert.equal(st.standing, "active");
  assert.equal(st.lastDay, day(paid.subscription.current_period_end * 1000));
  assert.match(st.message, /Subscribed to Solo \(monthly\), paid through/);
  assert.deepEqual([st.plan, st.interval, st.founding], ["solo", "monthly", false]);
  let k = checkKey(st.key, shopA, "monthly key");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l], ["m", today(), st.lastDay, 14, "solo"]);
  assert.notEqual(k.id, trialKey.id);
  assert.ok(daysBetween(today(), k.u) >= 28 && daysBetween(today(), k.u) <= 31, `a month ahead: ${k.u}`);
  const row = (await db.query(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  assert.deepEqual([row.stripe_subscription_id, row.plan, row.tier, row.status, row.cancel_at_period_end], [subA, "m", "solo", "active", false]);
  me = await ok(await page(a, "/me"));
  assert.deepEqual(
    [me.shops[0].standing, me.shops[0].canSubscribe, me.shops[0].canManage, me.shops[0].subscription.plan, me.shops[0].subscription.interval, me.shops[0].subscription.status, me.account.hasBilling],
    ["active", false, true, "solo", "monthly", "active", true],
  );
  await status(await page(a, `/shops/${shopA}/checkout`, { plan: "shop", interval: "yearly" }), 409, "already subscribed");
  const portal = await ok(await page(a, `/shops/${shopA}/portal`, {}));
  assert.ok(portal.url.startsWith(`${mock.url}/portal/cus_`), portal.url);
  assert.equal((await fetch(portal.url)).status, 200);
  console.log("subscribe: ok");

  // ----- 5. Webhooks: a replay is a 200 and changes nothing; a bad signature is 400; a body that isn't an event is 400. -----
  const paidEvent = mock.events.find((e) => e.type === "invoice.paid");
  const replay = await mockPost(`/__replay/${paidEvent.id}`);
  assert.equal(replay.delivered[0].status, 200);
  assert.match(replay.delivered[0].body, /"replay":true/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stripe_events WHERE id = ANY($1)`, [mock.events.map((e) => e.id)])).rows[0].n, mock.events.length, "every event handled once");
  assert.equal((await postWebhook(paidEvent, "whsec_wrong_secret_000000")).status, 400, "bad signature");
  assert.equal((await fetch(`${HUB}/v1/stripe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(paidEvent) })).status, 400, "no signature");
  assert.equal((await postWebhook({ id: `evt_${RUN}x`, type: "customer.updated", data: { object: { id: "cus_whatever" } } })).status, 200, "an event the hub doesn't act on");
  // A forged subscription event with a good signature: the hub re-reads from Stripe, which doesn't know it.
  const forged = await postWebhook({ id: `evt_${RUN}forged`, type: "customer.subscription.updated", data: { object: { id: "sub_forged000000", status: "active", metadata: { hub_shop_id: shopA }, current_period_end: 4102444800 } } });
  assert.equal(forged.status, 502, "a subscription Stripe doesn't have can't change anything");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stripe_events WHERE id = $1`, [`evt_${RUN}forged`])).rows[0].n, 0, "an event that failed isn't marked handled");
  assert.equal((await standing(keyA, "shopA")).lastDay, st.lastDay, "the forged period end didn't land");
  console.log("webhooks: ok");

  // ----- 6. A failed payment: past_due inside 14 days' grace, the key unchanged, the owner mailed; then lapsed; then paid again. -----
  // A's trial is long over (a subscription that ends inside the trial falls back to the trial).
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopA]);
  const failed = await mockPost(`/__subscriptions/${subA}/renew`, { paid: false });
  allDelivered(failed, "failed payment");
  st = await standing(keyA, "shopA");
  assert.deepEqual([st.standing, st.lastDay], ["past_due", k.u]);
  assert.match(st.message, /didn't go through/);
  assert.equal(checkKey(st.key, shopA, "past_due key").id, k.id, "the key already carries the grace: nothing new is signed");
  assert.match(hubLog, new RegExp(`to ${emailA}\\nsubject: Payment for A Repair didn't go through`), "dunning mail went to the owner");
  // The period end was 15 days ago (Stripe's retries ran out): read-only.
  const past = Math.floor(Date.now() / 1000) - 15 * 86400;
  allDelivered(await mockPost(`/__subscriptions/${subA}`, { current_period_end: past, current_period_start: past - 30 * 86400 }), "period moved back");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /never went through/);
  k = checkKey(st.key, shopA, "lapsed key");
  assert.equal(k.p, "m");
  assert.ok(k.u <= today(), `the key is over (${k.u})`);
  // Paid again: the period runs on from the old end; active with a key for it.
  const renewed = await mockPost(`/__subscriptions/${subA}/renew`, { paid: true });
  allDelivered(renewed, "paid again");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "active");
  assert.equal(st.lastDay, day(renewed.subscription.current_period_end * 1000));
  k = checkKey(st.key, shopA, "renewed key");
  assert.deepEqual([k.p, k.u], ["m", st.lastDay]);
  console.log("past_due, grace, lapsed, paid again: ok");

  // ----- 7. Cancelling: at the period end stays active till then; now, with days left, the same; past the end, lapsed. -----
  allDelivered(await mockPost(`/__subscriptions/${subA}/cancel`, { at_period_end: true }), "cancel at period end");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "active");
  assert.match(st.message, /cancelled and runs through/);
  assert.equal(checkKey(st.key, shopA, "cancelling key").id, k.id);
  allDelivered(await mockPost(`/__subscriptions/${subA}/cancel`, { at_period_end: false }), "cancelled now");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "active", "paid through the period end");
  assert.match(st.message, /was cancelled and runs through/);
  allDelivered(await mockPost(`/__subscriptions/${subA}`, { current_period_end: Math.floor(Date.now() / 1000) - 86400 }), "period over");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /subscription ended on/);
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops[0].canSubscribe, true, "a lapsed shop can subscribe again");
  console.log("cancel: ok");

  // ----- 8. A second shop, yearly; then a refund takes the period back: lapsed at once, the key named for removal. -----
  const claimA2 = await claim(keyA, { shopRef: "shopA2", shopName: "A Second Company", kind: "repair", program: "StitchBench", version: "1.7.0" });
  const shopA2 = claimA2.shop.id;
  const lc = await ok(await call("/v1/accounts/link-code", { key: keyA, json: { shopRef: "shopA2", shopName: "A Second Company", program: "StitchBench" } }));
  await ok(await page(a, "/connect", { code: lc.code }));
  const co2 = await ok(await page(a, `/shops/${shopA2}/checkout`, { plan: "shop", interval: "yearly" }));
  assert.equal(mock.sessions.get(co2.sessionId).line_items.data[0].price.id, PRICES.shopYearly);
  assert.equal(mock.sessions.get(co2.sessionId).customer, session.customer, "the account's one customer again");
  const paid2 = await mockPost(`/__pay/${co2.sessionId}`);
  allDelivered(paid2, "yearly payment");
  st = await standing(keyA, "shopA2");
  assert.equal(st.standing, "active");
  k = checkKey(st.key, shopA2, "yearly key");
  assert.deepEqual([k.p, k.l, st.plan, st.interval], ["y", "shop", "shop", "yearly"]);
  assert.ok(daysBetween(today(), k.u) >= 364 && daysBetween(today(), k.u) <= 366, `a year ahead: ${k.u}`);
  const yearlyKeyId = k.id;
  const refund = await mockApi("/v1/refunds", { charge: paid2.invoice.charge });
  assert.equal(refund.object, "refund");
  assert.equal(mock.webhooks.at(-1).status, 200, "charge.refunded was taken");
  st = await standing(keyA, "shopA2");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /refunded on/);
  assert.ok(st.revokeKeyIds.includes(yearlyKeyId), `the period's key is named for removal: ${st.revokeKeyIds}`);
  k = checkKey(st.key, shopA2, "key after a refund");
  assert.deepEqual([k.p, k.g], ["y", 0], "no grace: read-only at once");
  assert.ok(k.u < today(), `over yesterday: ${k.u}`);
  me = await ok(await page(a, "/me"));
  const a2 = me.shops.find((s) => s.id === shopA2);
  assert.deepEqual([a2.standing, a2.subscription.unpaidSince, a2.canSubscribe], ["lapsed", today(), true]);
  console.log("yearly and refund: ok");

  // ----- 9. A chargeback does the same and is flagged for the admin. -----
  const co3 = await ok(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }));
  const paid3 = await mockPost(`/__pay/${co3.sessionId}`);
  allDelivered(paid3, "subscribed again");
  assert.equal((await standing(keyA, "shopA")).standing, "active");
  const monthlyKeyId = checkKey((await standing(keyA, "shopA")).key, shopA, "new monthly key").id;
  allDelivered(await mockPost(`/__charges/${paid3.invoice.charge}/dispute`), "dispute");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /disputed with the card company/);
  assert.ok(st.revokeKeyIds.includes(monthlyKeyId));
  let list = await ok(await adminCall("/accounts"));
  assert.deepEqual([list.billing.open, list.billing.stripeMode, list.billing.signing.kid, list.billing.signing.x], [true, "test", "hub1", HUB1_X]);
  const adminA = list.shops.find((s) => s.id === shopA);
  assert.deepEqual([adminA.standing, adminA.subscription.disputedAt, adminA.stripeCustomerId], ["lapsed", today(), session.customer]);
  console.log("chargeback: ok");

  // ----- 9b. Plans: Solo and Shop; Switch with proration; several prices count as one plan; an unknown price is Shop. -----
  const keyP = await register("Billing Test Plans P");
  const claimP = await claim(keyP, { shopRef: "shopP", shopName: "P Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true });
  const shopP = claimP.shop.id;
  assert.deepEqual([claimP.standing, claimP.plan, checkKey(claimP.key, shopP, "P's trial key").l], ["trial", "shop", "shop"], "a trial is Shop: a shop tries it with its staff");
  const emailP = `owner-p-${RUN}@stitchhub.test`;
  const pj = browser();
  await ok(await page(pj, "/signup", { email: emailP, password: "Good-password-3", acceptTerms: true }));
  await ok(await page(pj, "/verify", { token: linkToken("verify") }));
  const lcP = await ok(await call("/v1/accounts/link-code", { key: keyP, json: { shopRef: "shopP", shopName: "P Repair", program: "StitchBench" } }));
  await ok(await page(pj, "/connect", { code: lcP.code }));
  me = await ok(await page(pj, "/me"));
  assert.deepEqual(me.billing.prices, { solo: { monthly: "$25 a month", yearly: "$250 a year" }, shop: { monthly: "$45 a month", yearly: "$450 a year" } }, "what each plan costs, read from Stripe");
  assert.deepEqual([me.billing.soloLogins, me.billing.founding.on], [2, false]);
  await status(await page(pj, `/shops/${shopP}/checkout`, { plan: "monthly" }), 400, "an interval alone names no plan");
  await status(await page(pj, `/shops/${shopP}/checkout`, { plan: "team", interval: "monthly" }), 400, "not a plan");
  await status(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }), 409, "nothing to switch before subscribing");
  // Solo, monthly: the first id of STRIPE_PRICE_SOLO_MONTHLY is the one sold.
  const coP = await ok(await page(pj, `/shops/${shopP}/checkout`, { plan: "solo", interval: "monthly" }));
  assert.equal(mock.sessions.get(coP.sessionId).line_items.data[0].price.id, PRICES.soloMonthly);
  const paidP = await mockPost(`/__pay/${coP.sessionId}`);
  allDelivered(paidP, "P subscribes to Solo");
  const subP = paidP.subscription.id;
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan, st.interval, st.founding], ["active", "solo", "monthly", false]);
  assert.match(st.message, /Subscribed to Solo \(monthly\), paid through/);
  k = checkKey(st.key, shopP, "Solo key");
  assert.deepEqual([k.p, k.l, k.fs], ["m", "solo", undefined]);
  assert.deepEqual(Object.values((await db.query(`SELECT tier, founding, price_id FROM subscriptions WHERE shop_id = $1`, [shopP])).rows[0]), ["solo", false, PRICES.soloMonthly]);
  me = await ok(await page(pj, "/me"));
  let rowP = me.shops.find((s) => s.id === shopP);
  assert.deepEqual([rowP.plan, rowP.canSwitch, rowP.canSubscribe, rowP.subscription.plan, rowP.subscription.interval, rowP.subscription.founding], ["solo", true, false, "solo", "monthly", false]);
  await status(await page(pj, `/shops/${shopP}/switch`, { plan: "solo" }), 409, "already on Solo");
  await status(await page(pj, `/shops/${shopP}/switch`, { plan: "team" }), 400, "not a plan to switch to");
  await status(await page(b, `/shops/${shopP}/switch`, { plan: "shop" }), 404, "another account's shop");
  // Switch to Shop: the item moves to Shop's monthly price with proration, the hub has it at once, a new key says shop.
  const sw = await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }));
  assert.deepEqual([sw.plan, sw.subscription.plan], ["shop", "shop"]);
  const mSubP = mock.subscriptions.get(subP);
  assert.deepEqual([mSubP.items.data[0].price.id, mSubP.last_proration_behavior], [PRICES.shopMonthly, "create_prorations"]);
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan, st.interval], ["active", "shop", "monthly"]);
  assert.match(st.message, /Subscribed to Shop \(monthly\)/);
  const kShop = checkKey(st.key, shopP, "Shop key");
  assert.deepEqual([kShop.p, kShop.l, kShop.u], ["m", "shop", k.u], "the same period, the other plan");
  assert.notEqual(kShop.id, k.id, "a plan switch signs a new key");
  assert.ok(mock.webhooks.filter((w) => w.type === "customer.subscription.updated").every((w) => w.status === 200), "the switch's webhook was taken");
  await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "solo" }));
  assert.equal(checkKey((await standing(keyP, "shopP")).key, shopP, "Solo again").l, "solo");
  // Several prices count as one plan (decision 12): an older Solo price further down the list is still Solo; the single
  // price from before the plans is Shop; a price the hub doesn't know is Shop (and logged), never Solo.
  allDelivered(await mockPost(`/__subscriptions/${subP}`, { price: PRICES.soloMonthlyOld }), "an older Solo price");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.plan, st.interval], ["solo", "monthly"]);
  allDelivered(await mockPost(`/__subscriptions/${subP}`, { price: PRICES.legacyMonthly }), "the single price from before the plans");
  assert.equal((await standing(keyP, "shopP")).plan, "shop", "a shop that paid the old single price keeps every login");
  allDelivered(await mockPost(`/__subscriptions/${subP}`, { price: `price_unknown_${RUN}` }), "a price the hub doesn't know");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan, st.interval], ["active", "shop", "monthly"]);
  assert.equal(checkKey(st.key, shopP, "unknown price key").l, "shop");
  assert.match(hubLog, new RegExp(`price the hub doesn't know \\(price_unknown_${RUN}\\); treated as Shop`));
  allDelivered(await mockPost(`/__subscriptions/${subP}`, { price: PRICES.soloMonthly }), "back on Solo");
  // Lapsed keeps the last plan; an ended subscription isn't switched.
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopP]);
  allDelivered(await mockPost(`/__subscriptions/${subP}/cancel`, { at_period_end: false }), "P cancelled");
  allDelivered(await mockPost(`/__subscriptions/${subP}`, { current_period_end: Math.floor(Date.now() / 1000) - 86400 }), "P's period over");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan], ["lapsed", "solo"], "lapsed keeps the last plan");
  assert.equal(checkKey(st.key, shopP, "lapsed Solo key").l, "solo");
  await status(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }), 409, "an ended subscription isn't switched");
  console.log("plans: ok");

  // ----- 9c. Founding shops: the admin's mark (25 at most), the founding prices, kept across a gap under 60 days, lost after. -----
  list = await ok(await adminCall("/accounts"));
  const accP = list.accounts.find((x) => x.email === emailP);
  const accB = list.accounts.find((x) => x.email === emailB);
  assert.deepEqual([accP.founding.on, list.foundingPlaces.limit], [false, 25]);
  let fnd = await ok(await adminCall(`/accounts/${accP.id}/founding`, { founding: true }));
  assert.equal(fnd.founding.founding, true);
  assert.ok(fnd.founding.gapSince, "P's subscription ended yesterday: the gap is written down");
  assert.equal(day(fnd.founding.gapSince), plusDays(-1));
  // Stand-in accounts take the other places; the 26th is refused.
  const fillers = [];
  for (let i = fnd.foundingPlaces.used; i < 25; i++) {
    const id = `fill${RUN}${i}`;
    fillers.push(id);
    await db.query(`INSERT INTO accounts (id, email, founding_at) VALUES ($1, $2, now())`, [id, `filler-${i}-${RUN}@stitchhub.test`]);
  }
  await status(await adminCall(`/accounts/${accB.id}/founding`, { founding: true }), 409, "the 26th founding shop");
  list = await ok(await adminCall("/accounts"));
  assert.equal(list.foundingPlaces.used, 25);
  assert.equal(list.accounts.find((x) => x.id === accB.id).founding.on, false);
  // Taking a mark off frees its place.
  fnd = await ok(await adminCall(`/accounts/${fillers[0]}/founding`, { founding: false }));
  assert.equal(fnd.foundingPlaces.used, 24);
  await status(await adminCall(`/accounts/missing${RUN}/founding`, { founding: true }), 404, "no such account");
  // Back within 60 days (59 into the gap): the founding price, yearly; the key says so.
  await db.query(`UPDATE accounts SET founding_gap_since = now() - interval '59 days' WHERE id = $1`, [accP.id]);
  me = await ok(await page(pj, "/me"));
  assert.equal(me.billing.founding.on, true);
  assert.equal(me.billing.founding.losesOn, plusDays(1));
  assert.deepEqual(me.billing.prices, { solo: { monthly: "$15 a month", yearly: "$150 a year" }, shop: { monthly: "$30 a month", yearly: "$300 a year" } }, "the founding prices");
  const coF = await ok(await page(pj, `/shops/${shopP}/checkout`, { plan: "solo", interval: "yearly" }));
  assert.equal(mock.sessions.get(coF.sessionId).line_items.data[0].price.id, PRICES.soloYearlyFounding);
  const paidF = await mockPost(`/__pay/${coF.sessionId}`);
  allDelivered(paidF, "P back on a founding price");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan, st.interval, st.founding], ["active", "solo", "yearly", true]);
  assert.match(st.message, /Subscribed to Solo \(yearly, founding price\)/);
  k = checkKey(st.key, shopP, "founding key");
  assert.deepEqual([k.p, k.l, k.fs], ["y", "solo", true]);
  assert.equal((await db.query(`SELECT founding_gap_since FROM accounts WHERE id = $1`, [accP.id])).rows[0].founding_gap_since, null, "running again: no gap");
  // A founding account switches to the founding price of the other plan.
  await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }));
  assert.equal(mock.subscriptions.get(paidF.subscription.id).items.data[0].price.id, PRICES.shopYearlyFounding);
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.plan, st.interval, st.founding], ["shop", "yearly", true]);
  // A gap over 60 days: the mark goes, and the next Checkout is at the regular price.
  allDelivered(await mockPost(`/__subscriptions/${paidF.subscription.id}/cancel`, { at_period_end: false }), "P cancels again");
  allDelivered(await mockPost(`/__subscriptions/${paidF.subscription.id}`, { current_period_end: Math.floor(Date.now() / 1000) - 61 * 86400 }), "61 days without a subscription");
  const lost = (await db.query(`SELECT founding_at, founding_gap_since, founding_lost_at FROM accounts WHERE id = $1`, [accP.id])).rows[0];
  assert.equal(lost.founding_at, null, "the founding mark went");
  assert.ok(lost.founding_lost_at && lost.founding_gap_since, "and when, and since when");
  assert.equal(day(lost.founding_gap_since), plusDays(-61));
  me = await ok(await page(pj, "/me"));
  assert.equal(me.billing.founding.on, false);
  assert.equal(me.billing.prices.solo.monthly, "$25 a month");
  const coR = await ok(await page(pj, `/shops/${shopP}/checkout`, { plan: "solo", interval: "monthly" }));
  assert.equal(mock.sessions.get(coR.sessionId).line_items.data[0].price.id, PRICES.soloMonthly, "the regular price after the mark went");
  list = await ok(await adminCall("/accounts"));
  assert.equal(list.foundingPlaces.used, 23, "a lost mark frees its place (25, one taken off, then P's lost)");
  assert.ok(list.accounts.find((x) => x.id === accP.id).founding.lostAt);
  await db.query(`DELETE FROM accounts WHERE id = ANY($1)`, [fillers]);
  console.log("founding shops: ok");

  // ----- 10. Waived: a retail shop partnered with a repair shop in good standing; "both" pays; the waiver ends. -----
  const keyR = await register("Billing Test Repair R");
  const keyS = await register("Billing Test Quilts S");
  const claimR = await claim(keyR, { shopRef: "shopR", shopName: "R Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopR = claimR.shop.id;
  const claimS = await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop", version: "1.0.0", sole: true });
  const shopS = claimS.shop.id;
  const claimT = await claim(keyS, { shopRef: "shopT", shopName: "T Both", kind: "both", program: "StitchShop", version: "1.0.0" });
  // S's and T's trials are long over, so only the partnership can keep them working.
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = ANY($1)`, [[shopS, claimT.shop.id]]);
  await db.query(`DELETE FROM license_issues WHERE shop_id = ANY($1)`, [[shopS, claimT.shop.id]]);
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "lapsed", "trial over, no partner yet");
  const inv = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair", terms: { repairCommissionPct: 15 } } }));
  const red = await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv.code, shopRef: "shopS", shopName: "S Quilts" } }));
  assert.equal(red.side, "retail");
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["waived", null]);
  assert.match(st.message, /Free while you're partnered with R Repair/);
  k = checkKey(st.key, shopS, "waived key");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l, st.plan], ["w", today(), plusDays(34), 14, "shop", "shop"], "partnered: Shop, free");
  const waivedKeyId = k.id;
  assert.equal(checkKey((await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop" })).key, shopS, "waived again").id, waivedKeyId, "one waived key a day");
  // A "both" shop partnered the same way pays: no waiver.
  const inv2 = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair" } }));
  await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv2.code, shopRef: "shopT", shopName: "T Both" } }));
  assert.equal((await standing(keyS, "shopT")).standing, "lapsed", "a both shop is a repair shop: it pays");
  // The repair shop is never waived by its partners, and a repair shop that lapses takes the waiver with it.
  assert.equal((await standing(keyR, "shopR")).standing, "trial");
  const lapsedR = await ok(await adminCall(`/shops/${shopR}/lapse`, { lapsed: true }));
  assert.equal(lapsedR.shop.standing, "lapsed");
  st = await standing(keyR, "shopR");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /hub admin ended/);
  assert.ok(st.revokeKeyIds.includes(claimR.key && checkKey(claimR.key, shopR, "R's trial key").id), "R's live trial key is revoked");
  k = checkKey(st.key, shopR, "R's cut key");
  assert.deepEqual([k.p, k.g], ["t", 0]);
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["trial", plusDays(34)], "notice: the waived key runs on, then it lapses");
  assert.match(st.message, /free use through a partner repair shop has ended/);
  assert.equal(checkKey(st.key, shopS, "S after R lapsed").id, waivedKeyId, "no new key: the one it holds runs out");
  // Undo: R is back on its trial, S is waived again.
  await ok(await adminCall(`/shops/${shopR}/lapse`, { lapsed: false }));
  assert.equal((await standing(keyR, "shopR")).standing, "trial");
  assert.equal(checkKey((await standing(keyR, "shopR")).key, shopR, "R back on trial").p, "t");
  assert.equal((await standing(keyS, "shopS")).standing, "waived");
  // The partnership ends: notice again; when the last waived key is over, lapsed, with that key left to run out.
  await ok(await call(`/v1/partners/links/${red.link.id}/end`, { key: keyR, json: { shopRef: "shopR" } }));
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "trial");
  assert.match(st.message, /Subscribe by/);
  await db.query(`UPDATE license_issues SET last_day = current_date - 1, first_day = current_date - 35 WHERE shop_id = $1 AND plan = 'w'`, [shopS]);
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "lapsed");
  assert.equal(checkKey(st.key, shopS, "S lapsed").id, waivedKeyId, "the key it holds already ends the right day: nothing new");
  console.log("waived: ok");

  // ----- 11. Comped: for good, then to a day, then taken away. -----
  await ok(await adminCall(`/shops/${shopS}/comp`, { until: "forever", note: "founding member" }));
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["comped", null]);
  k = checkKey(st.key, shopS, "comp key");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l, st.plan], ["c", today(), "2099-12-31", 14, "shop", "shop"]);
  await ok(await adminCall(`/shops/${shopS}/comp`, { until: plusDays(10) }));
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["comped", plusDays(10)]);
  k = checkKey(st.key, shopS, "dated comp key");
  assert.deepEqual([k.p, k.u], ["c", plusDays(10)]);
  await ok(await adminCall(`/shops/${shopS}/comp`, { until: "" }));
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "lapsed");
  k = checkKey(st.key, shopS, "comp taken away");
  assert.deepEqual([k.p, k.u, k.g], ["t", today(), 14], "the program held a live key: its grace runs from today");
  // "Lapse now" on a comped shop wins; a comp takes it back.
  await ok(await adminCall(`/shops/${shopS}/comp`, { until: "forever" }));
  await ok(await adminCall(`/shops/${shopS}/lapse`, {}));
  assert.equal((await standing(keyS, "shopS")).standing, "lapsed");
  await ok(await adminCall(`/shops/${shopS}/comp`, { until: "forever" }));
  assert.equal((await standing(keyS, "shopS")).standing, "comped");
  const keys = await ok(await adminCall(`/shops/${shopS}/keys`));
  assert.ok(keys.keys.length >= 4);
  assert.ok(keys.keys.some((x) => x.plan === "w" && x.revokedAt), "the waived key was revoked by Lapse now");
  console.log("comped and lapse now: ok");

  // ----- 12. The export carries the billing tables. -----
  const gz = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  const rows = zlib.gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.t === "subscription" && r.shop_id === shopA && r.stripe_subscription_id === paid3.subscription.id && r.tier === "solo" && r.price_id === PRICES.soloMonthly));
  assert.ok(rows.some((r) => r.t === "account" && r.email === emailP && r.founding_lost_at), "the founding record goes with the account");
  assert.ok(rows.some((r) => r.t === "license_issue" && r.shop_id === shopP && r.tier === "solo" && r.founding === true));
  assert.ok(rows.some((r) => r.t === "stripe_event" && r.id === paidEvent.id));
  assert.ok(rows.some((r) => r.t === "license_issue" && r.key_id === yearlyKeyId && r.revoked_at));
  assert.ok(rows.some((r) => r.t === "shop" && r.id === shopR && r.lapsed_at === null));
  assert.ok(!JSON.stringify(rows).includes("sk_test_billingmock"), "no Stripe key in the export");
  console.log("export: ok");

  // ----- 13. Billing closed (no Stripe variables): a trial that ended changes nothing, and no trial key is signed. -----
  await stopHub();
  const closed = Object.fromEntries(Object.entries(ENV).filter(([name]) => !/^STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PRICE_)/.test(name)));
  await startHub(closed);
  const keyC = await register("Billing Test Shop C");
  const claimC = await claim(keyC, { shopRef: "shopC", shopName: "C Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  assert.deepEqual([claimC.standing, claimC.key], ["trial", null], "no key while nobody can pay");
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [claimC.shop.id]);
  st = await standing(keyC, "shopC");
  assert.equal(st.standing, "trial");
  assert.match(st.message, /Subscriptions aren't open yet/);
  assert.equal(st.key, null);
  // Comps still get their key; a lapsed shop keeps the one it was sent.
  assert.equal(checkKey((await standing(keyS, "shopS")).key, shopS, "comp key with billing closed").p, "c");
  assert.equal(checkKey((await standing(keyA, "shopA2")).key, shopA2, "refunded shop with billing closed").g, 0);
  list = await ok(await adminCall("/accounts"));
  assert.equal(list.billing.open, false);
  assert.match(list.billing.problem, /STRIPE_SECRET_KEY isn't set/);
  await status(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }), 503, "subscriptions closed");
  await status(await page(a, `/shops/${shopA}/switch`, { plan: "shop" }), 503, "no switching while closed");
  console.log("billing closed: ok");

  // Clean up: accounts go, test installs are blocked.
  for (const x of list.accounts.filter((x) => [emailA, emailB, emailP].includes(x.email))) await ok(await adminCall(`/accounts/${x.id}`, undefined, "DELETE"));
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
