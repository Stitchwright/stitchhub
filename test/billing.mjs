// Checks billing end to end: starts a hub of its own on a free port against a scratch database with the Stripe mock
// (test/stripe-mock.mjs) standing in for Stripe and a throwaway Ed25519 key standing in for hub1, then walks a shop from
// its trial through subscribe → active → past_due → lapsed → paid again, cancellation, a yearly plan, a refund and a
// chargeback (keys revoked), the waiver for a partnered retail shop and its end, comps, the admin's "Lapse now", replayed
// and badly signed webhooks, the tenant rule (one account can't subscribe another's shop), the two plans (Solo and Shop,
// Switch with proration, several prices as one plan, an unknown price counted as Shop, lapsed keeps the last plan, the
// key's l), founding shops (the admin's mark, 25 at most, founding prices, kept across a gap under 60 days and lost
// after), the trial's edges (subscribing inside the trial is charged when it ends, Stripe's 48 hours, a full refund of
// the first payment inside the trial goes back to the trial, a won chargeback is undone with the founding mark its gap
// cost, a card-company inquiry only flags the shop until it closes or escalates), a full refund or a lost chargeback
// cancelling the subscription, a switch up to Shop charged now (and waiting for a declined card), two subscriptions for
// one shop (the old one's late events ignored, the old one cancelled when the new Checkout completes), late invoice.paid
// and dispute events that change nothing, the export, and a hub with billing closed. Every key the hub sends is verified here with the program's own
// verify logic (license.ts, copied). Each run makes a fresh database beside the one named (the founding places are
// counted across a database, so a reused one fails) and drops it at the end.
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
/** Waits for the webhooks of the Stripe calls the hub made (a cancellation, a switch) and checks every webhook was taken. */
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
/** A webhook as Stripe would send it late (a new event id, the object by id only): the hub re-reads the object. */
let lateEvents = 0;
const lateEvent = (type, id) => ({ id: `evt_late_${RUN}_${++lateEvents}`, type, data: { object: { id } } });
const day = (d) => new Date(d).toISOString().slice(0, 10);
const today = () => day(Date.now());
const plusDays = (n, from = Date.now()) => day(from + n * 86400_000);
/** Hub shop id -> the program's company id (shop_ref): keys name the program's id, which is what the program checks. */
const REF_OF = new Map();
const claim = async (key, body) => {
  const r = await ok(call("/v1/shops/claim", { key, json: body }));
  if (r?.shop?.id && body?.shopRef) REF_OF.set(r.shop.id, body.shopRef);
  return r;
};
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
  assert.equal(v.payload.s, REF_OF.get(shopId) ?? shopId, `${what}: the key must name the program's company id (shop_ref)`);
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
/** The first day of the calendar quarter `back` quarters before the one holding ymd (as src/billing.mjs quarterStart). */
const quarterStart = (ymd, back = 0) => {
  const idx = Number(ymd.slice(0, 4)) * 4 + Math.floor((Number(ymd.slice(5, 7)) - 1) / 3) - back;
  return `${Math.floor(idx / 4)}-${String((idx % 4) * 3 + 1).padStart(2, "0")}-01`;
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
  // A's trial is long over, so it is charged at once (subscribing inside the trial is section 9d; a subscription that
  // ends inside the trial falls back to the trial).
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopA]);
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
  // Its trial is over: charged at once, and the refund lapses it (a refund inside the trial is section 9d).
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopA2]);
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
  assert.equal(mock.subscriptions.get(paid2.subscription.id).status, "canceled", "a full refund cancels the subscription in Stripe, so it can't charge again");
  assert.match(hubLog, new RegExp(`subscription ${paid2.subscription.id} is cancelled in Stripe \\(charge ${paid2.invoice.charge} was refunded in full\\)`));
  // A late invoice.paid for the refunded period doesn't make it good again.
  assert.equal((await postWebhook(lateEvent("invoice.paid", paid2.invoice.id))).status, 200);
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
  const dpA = await mockPost(`/__charges/${paid3.invoice.charge}/dispute`);
  allDelivered(dpA, "dispute");
  assert.equal((await postWebhook(lateEvent("invoice.paid", paid3.invoice.id))).status, 200, "a late invoice.paid for the disputed period");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /disputed with the card company/);
  assert.ok(st.revokeKeyIds.includes(monthlyKeyId));
  assert.equal(mock.subscriptions.get(paid3.subscription.id).status, "active", "an open chargeback doesn't cancel the subscription (it may be won)");
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
  // P's trial is over: charged at once (subscribing inside the trial is section 9d).
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopP]);
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
  // Switch to Shop: the item moves to Shop's monthly price and the difference is charged now (always_invoice, the change
  // waiting for that payment); paid at once, the hub has it at once and a new key says shop.
  const sw = await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }));
  await settle("switch to Shop");
  assert.deepEqual([sw.pending, sw.plan, sw.subscription.plan], [false, "shop", "shop"]);
  const mSubP = mock.subscriptions.get(subP);
  assert.deepEqual([mSubP.items.data[0].price.id, mSubP.last_proration_behavior, mSubP.last_payment_behavior], [PRICES.shopMonthly, "always_invoice", "pending_if_incomplete"]);
  const upInvoice = [...mock.invoices.values()].filter((i) => i.subscription === subP && i.billing_reason === "subscription_update").at(-1);
  assert.deepEqual([upInvoice?.amount_paid, Boolean(upInvoice?.charge)], [2000, true], "the difference is charged now");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan, st.interval], ["active", "shop", "monthly"]);
  assert.match(st.message, /Subscribed to Shop \(monthly\)/);
  const kShop = checkKey(st.key, shopP, "Shop key");
  assert.deepEqual([kShop.p, kShop.l, kShop.u], ["m", "shop", k.u], "the same period, the other plan");
  assert.notEqual(kShop.id, k.id, "a plan switch signs a new key");
  assert.ok(mock.webhooks.filter((w) => w.type === "customer.subscription.updated").every((w) => w.status === 200), "the switch's webhook was taken");
  // A full refund of the switch's difference (not a period's charge) leaves the period and the subscription alone.
  assert.equal((await mockApi("/v1/refunds", { charge: upInvoice.charge })).object, "refund");
  assert.equal(mock.subscriptions.get(subP).status, "active", "refunding a plan switch's difference doesn't cancel the subscription");
  assert.equal((await standing(keyP, "shopP")).standing, "active", "nor take the period back");
  assert.match(hubLog, new RegExp(`charge ${upInvoice.charge} .*subscription_update.* the period stands`));
  const swDown = await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "solo" }));
  await settle("switch to Solo");
  assert.deepEqual([swDown.pending, swDown.plan], [false, "solo"]);
  assert.deepEqual([mSubP.last_proration_behavior, mSubP.last_payment_behavior], ["create_prorations", null], "down to Solo: a credit on the next invoice");
  assert.equal([...mock.invoices.values()].filter((i) => i.subscription === subP && i.billing_reason === "subscription_update").length, 1, "nothing charged moving down");
  assert.equal(checkKey((await standing(keyP, "shopP")).key, shopP, "Solo again").l, "solo");
  // The card declined for the difference: Stripe keeps the subscription on Solo (a pending update) and so does the hub;
  // no Shop key and no dunning mail until it's paid, then Shop.
  await mockPost(`/__customers/${mSubP.customer}/decline_next`);
  const swDeclined = await ok(await page(pj, `/shops/${shopP}/switch`, { plan: "shop" }));
  await settle("a declined switch");
  assert.deepEqual([swDeclined.pending, swDeclined.plan], [true, "solo"]);
  assert.equal(swDeclined.message, "The card was declined for the difference, so P Repair stays on Solo for now. It moves to Shop as soon as that payment goes through: update the card under Manage billing.");
  assert.ok(mSubP.pending_update, "Stripe holds the change until the difference is paid");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.standing, st.plan], ["active", "solo"]);
  assert.equal(checkKey(st.key, shopP, "still Solo").l, "solo", "no Shop key before the difference is paid");
  assert.ok(!/subject: Payment for P Repair didn't go through/.test(hubLog), "a declined switch isn't a failed renewal: no dunning mail");
  const openUp = [...mock.invoices.values()].filter((i) => i.subscription === subP && !i.paid).at(-1);
  allDelivered(await mockPost(`/__invoices/${openUp.id}/pay`), "the difference paid");
  st = await standing(keyP, "shopP");
  assert.deepEqual([st.plan, checkKey(st.key, shopP, "Shop once paid").l], ["shop", "shop"]);
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
  await settle("founding switch to Shop");
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

  // ----- 9d. Inside the trial: subscribing charges nothing until the trial ends (Stripe's trial_end, 48 hours ahead at
  // least); a full refund of the first payment inside the trial goes back to the trial; a won chargeback is undone. -----
  // B is a founding shop (the places are free again), so the won chargeback can give back the mark its gap cost.
  fnd = await ok(await adminCall(`/accounts/${accB.id}/founding`, { founding: true }));
  assert.equal(fnd.founding.founding, true);
  const connectTo = async (jar, key, shopRef, shopName) => {
    const lc = await ok(await call("/v1/accounts/link-code", { key, json: { shopRef, shopName, program: "StitchBench" } }));
    await ok(await page(jar, "/connect", { code: lc.code }));
  };
  const keyE = await register("Billing Test Trial E");
  const claimE = await claim(keyE, { shopRef: "shopE", shopName: "E Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true });
  const shopE = claimE.shop.id;
  await connectTo(b, keyE, "shopE", "E Repair");
  const createdE = (await db.query(`SELECT created_at FROM shops WHERE id = $1`, [shopE])).rows[0].created_at;
  const trialEndE = Math.floor((createdE.getTime() + 30 * 86400_000) / 1000);
  const trialLastE = day(trialEndE * 1000);
  assert.equal(trialLastE, plusDays(30));
  me = await ok(await page(b, "/me"));
  assert.equal(me.shops.find((s) => s.id === shopE).firstChargeOn, trialLastE, "the account page says when a subscription would first be charged");
  // Case 1: subscribed inside the trial, Stripe's trial ends when the hub's does: nothing is charged now.
  const coE = await ok(await page(b, `/shops/${shopE}/checkout`, { plan: "solo", interval: "monthly" }));
  assert.equal(coE.firstChargeOn, trialLastE);
  const sessE = mock.sessions.get(coE.sessionId);
  assert.equal(Number(sessE.subscription_data.trial_end), trialEndE, "trial_end is the trial's end, as a Unix time");
  assert.equal(sessE.line_items.data[0].price.id, PRICES.soloMonthlyFounding);
  const paidE = await mockPost(`/__pay/${coE.sessionId}`);
  allDelivered(paidE, "subscribed inside the trial");
  const subE = paidE.subscription.id;
  assert.deepEqual([paidE.subscription.status, paidE.subscription.current_period_end, paidE.invoice.amount_paid, paidE.invoice.charge], ["trialing", trialEndE, 0, null], "nothing charged until the trial ends");
  st = await standing(keyE, "shopE");
  assert.deepEqual([st.standing, st.lastDay, st.plan, st.interval, st.founding], ["active", trialLastE, "solo", "monthly", true], "trialing counts as subscribed: full use");
  assert.equal(st.message, `Subscribed to Solo (monthly, founding price). The free trial runs through ${trialLastE}; the first charge is on ${trialLastE}.`);
  k = checkKey(st.key, shopE, "trialing key");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l], ["m", today(), trialLastE, 14, "solo"]);
  me = await ok(await page(b, "/me"));
  const rowE = me.shops.find((s) => s.id === shopE);
  assert.deepEqual(
    [rowE.standing, rowE.subscription.status, rowE.subscription.trialEnd, rowE.canSubscribe, rowE.canSwitch, rowE.firstChargeOn],
    ["active", "trialing", trialLastE, false, true, null],
  );
  assert.equal((await db.query(`SELECT status FROM subscriptions WHERE shop_id = $1`, [shopE])).rows[0].status, "trialing");
  // The trial ends: Stripe charges the first month, and the period runs on from the trial's end.
  const firstE = await mockPost(`/__subscriptions/${subE}/renew`, { paid: true });
  allDelivered(firstE, "the first charge, at the trial's end");
  assert.deepEqual([firstE.invoice.amount_paid, firstE.invoice.billing_reason, Boolean(firstE.invoice.charge)], [1500, "subscription_cycle", true]);
  st = await standing(keyE, "shopE");
  assert.deepEqual([st.standing, st.lastDay], ["active", day(firstE.subscription.current_period_end * 1000)]);
  assert.match(st.message, /^Subscribed to Solo \(monthly, founding price\), paid through/);
  const paidKeyE = checkKey(st.key, shopE, "E's paid key");
  // Stripe's 48 hours: with a day of its trial left, Checkout has no trial_end and the shop is charged at once.
  const claimF = await claim(keyE, { shopRef: "shopF", shopName: "F Repair", kind: "repair", program: "StitchBench", version: "1.8.0" });
  const shopF = claimF.shop.id;
  await connectTo(b, keyE, "shopF", "F Repair");
  await db.query(`UPDATE shops SET created_at = now() - interval '29 days' WHERE id = $1`, [shopF]);
  const trialLastF = plusDays(1);
  me = await ok(await page(b, "/me"));
  assert.equal(me.shops.find((s) => s.id === shopF).firstChargeOn, null, "under 48 hours of trial left: charged at once");
  const coF2 = await ok(await page(b, `/shops/${shopF}/checkout`, { plan: "shop", interval: "monthly" }));
  assert.equal(coF2.firstChargeOn, null);
  assert.equal(mock.sessions.get(coF2.sessionId).subscription_data.trial_end, undefined, "no trial_end under 48 hours");
  const paidF2 = await mockPost(`/__pay/${coF2.sessionId}`);
  allDelivered(paidF2, "F subscribes with a day of its trial left");
  assert.deepEqual([paidF2.subscription.status, paidF2.invoice.amount_paid, paidF2.invoice.billing_reason], ["active", 3000, "subscription_create"]);
  st = await standing(keyE, "shopF");
  const paidKeyF = checkKey(st.key, shopF, "F's paid key");
  assert.deepEqual([st.standing, paidKeyF.p], ["active", "m"]);
  // Case 2: a partial refund lapses the shop, as before ...
  assert.equal((await mockApi("/v1/refunds", { charge: paidF2.invoice.charge, amount: "1000" })).object, "refund");
  assert.equal(mock.subscriptions.get(paidF2.subscription.id).status, "active", "a partial refund doesn't cancel the subscription");
  st = await standing(keyE, "shopF");
  assert.equal(st.standing, "lapsed", "a partial refund lapses the shop");
  assert.match(st.message, /refunded on/);
  // ... and once the whole first payment is refunded while the trial still runs, the shop is back on its trial until the
  // trial's original end; the paid period's key is named for removal and the trial key comes back.
  assert.equal((await mockApi("/v1/refunds", { charge: paidF2.invoice.charge })).object, "refund");
  assert.equal(mock.subscriptions.get(paidF2.subscription.id).status, "canceled", "refunded in full: cancelled in Stripe");
  st = await standing(keyE, "shopF");
  assert.deepEqual([st.standing, st.lastDay, st.plan], ["trial", trialLastF, "shop"]);
  assert.equal(st.message, `The payment for this shop was refunded on ${today()}, so it's back on its free trial through ${trialLastF}. Subscribe on your StitchHub account page to keep working after that.`);
  assert.ok(st.revokeKeyIds.includes(paidKeyF.id), "the refunded period's key is named for removal");
  k = checkKey(st.key, shopF, "F back on its trial");
  assert.deepEqual([k.p, k.u, k.g, k.l], ["t", trialLastF, 14, "shop"]);
  me = await ok(await page(b, "/me"));
  const rowF = me.shops.find((s) => s.id === shopF);
  assert.deepEqual([rowF.standing, rowF.source, rowF.canSubscribe, rowF.subscription.unpaidSince], ["trial", "trial", true, today()]);
  assert.match(hubLog, new RegExp(`the first payment of subscription ${paidF2.subscription.id} was refunded inside the trial`));
  // Past the trial's original end, it is a trial that ended (with the trial key's grace), not a refund's cut.
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopF]);
  st = await standing(keyE, "shopF");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /^The free trial ended on/);
  k = checkKey(st.key, shopF, "F's trial over");
  assert.deepEqual([k.p, k.g], ["t", 14]);
  // Case 3: a chargeback lapses E at once ...
  const dpE = await mockPost(`/__charges/${firstE.invoice.charge}/dispute`);
  allDelivered(dpE, "E's chargeback");
  st = await standing(keyE, "shopE");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /disputed with the card company/);
  assert.ok(st.revokeKeyIds.includes(paidKeyE.id));
  // ... and disputes take weeks: 61 days on, the gap has cost B its founding mark.
  await db.query(`UPDATE subscriptions SET unpaid_since = now() - interval '61 days', disputed_at = now() - interval '61 days' WHERE shop_id = $1`, [shopE]);
  await db.query(`UPDATE accounts SET founding_gap_since = now() - interval '61 days' WHERE id = $1`, [accB.id]);
  me = await ok(await page(b, "/me"));
  assert.equal(me.billing.founding.on, false, "the gap passed 60 days: the founding mark went");
  // A lost dispute: A's chargeback (section 9) stands, and its subscription is cancelled in Stripe.
  allDelivered(await mockPost(`/__disputes/${dpA.dispute.id}/close`, { status: "lost" }), "A's dispute lost");
  st = await standing(keyA, "shopA");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /disputed with the card company/);
  assert.match(hubLog, new RegExp(`dispute ${dpA.dispute.id} on charge ${paid3.invoice.charge} was lost; the chargeback stands`));
  assert.equal(mock.subscriptions.get(paid3.subscription.id).status, "canceled", "a lost chargeback cancels the subscription");
  // A late update for it (status lost) changes nothing more.
  assert.equal((await postWebhook(lateEvent("charge.dispute.updated", dpA.dispute.id))).status, 200);
  assert.equal((await standing(keyA, "shopA")).standing, "lapsed");
  // Won: the period counts again with a fresh key, the founding mark is back, the admin's flag is gone; logged.
  const wonE = await mockPost(`/__disputes/${dpE.dispute.id}/close`, { status: "won" });
  allDelivered(wonE, "E's dispute won");
  st = await standing(keyE, "shopE");
  assert.deepEqual([st.standing, st.lastDay, st.plan, st.founding], ["active", day(firstE.subscription.current_period_end * 1000), "solo", true]);
  assert.match(st.message, /^Subscribed to Solo \(monthly, founding price\), paid through/);
  k = checkKey(st.key, shopE, "E's key after the won dispute");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l, k.fs], ["m", today(), st.lastDay, 14, "solo", true]);
  assert.notEqual(k.id, paidKeyE.id, "a fresh key: the revoked one stays revoked");
  assert.ok(!st.revokeKeyIds.includes(k.id));
  assert.match(hubLog, new RegExp(`dispute ${dpE.dispute.id} on charge ${firstE.invoice.charge} was won; shop ${shopE}'s subscription ${subE} counts again; the founding mark the dispute cost is back`));
  me = await ok(await page(b, "/me"));
  assert.equal(me.billing.founding.on, true, "the founding mark is back");
  list = await ok(await adminCall("/accounts"));
  const adminE = list.shops.find((s) => s.id === shopE);
  assert.deepEqual([adminE.standing, adminE.subscription.disputedAt, adminE.subscription.unpaidSince], ["active", null, null]);
  const closedEv = mock.events.filter((e) => e.type === "charge.dispute.closed").at(-1);
  assert.match((await mockPost(`/__replay/${closedEv.id}`)).delivered[0].body, /"replay":true/, "a replayed close does nothing");
  // A late charge.dispute.created for the dispute E won (Stripe's status: won) changes nothing.
  assert.equal((await postWebhook(lateEvent("charge.dispute.created", dpE.dispute.id))).status, 200);
  assert.equal((await standing(keyE, "shopE")).standing, "active", "a late event for a won dispute doesn't lapse the shop");
  assert.match(hubLog, new RegExp(`dispute ${dpE.dispute.id} \\(charge.dispute.created\\) is won already; nothing changes`));
  // Card-company inquiries (warning_*: no money taken yet) don't lock a paying shop: recorded, shown to the admin, logged.
  // Two can be open at once (two charges), and the first one escalating still counts.
  const renew2E = await mockPost(`/__subscriptions/${subE}/renew`, { paid: true });
  allDelivered(renew2E, "E's next month");
  const inqE = await mockPost(`/__charges/${renew2E.invoice.charge}/dispute`, { status: "warning_needs_response" });
  allDelivered(inqE, "an inquiry opens");
  const renew3E = await mockPost(`/__subscriptions/${subE}/renew`, { paid: true });
  allDelivered(renew3E, "E's month after");
  st = await standing(keyE, "shopE");
  const keyE3 = checkKey(st.key, shopE, "E's key for the month after");
  const inq2E = await mockPost(`/__charges/${renew3E.invoice.charge}/dispute`, { status: "warning_needs_response" });
  allDelivered(inq2E, "a second inquiry opens");
  st = await standing(keyE, "shopE");
  assert.deepEqual([st.standing, st.lastDay], ["active", day(renew3E.subscription.current_period_end * 1000)], "inquiries: full use");
  assert.equal(checkKey(st.key, shopE, "E's key during the inquiries").id, keyE3.id, "the same key, nothing revoked");
  assert.ok(!st.revokeKeyIds.includes(keyE3.id));
  list = await ok(await adminCall("/accounts"));
  let subAdminE = list.shops.find((s) => s.id === shopE).subscription;
  assert.deepEqual([subAdminE.inquiryAt, subAdminE.inquiries, subAdminE.disputedAt, subAdminE.unpaidSince], [today(), 2, null, null], "the admin sees both inquiries");
  assert.match(hubLog, new RegExp(`card-company inquiry ${inqE.dispute.id} on charge ${renew2E.invoice.charge} \\(warning_needs_response\\) for shop ${shopE}: recorded for the admin`));
  // The first, under review, then escalated into a chargeback (charge.dispute.updated, needs_response): read-only at once.
  allDelivered(await mockPost(`/__disputes/${inqE.dispute.id}/update`, { status: "warning_under_review" }), "the first inquiry under review");
  assert.equal((await standing(keyE, "shopE")).standing, "active", "still an inquiry: full use");
  allDelivered(await mockPost(`/__disputes/${inqE.dispute.id}/update`, { status: "needs_response" }), "the first inquiry escalates");
  st = await standing(keyE, "shopE");
  assert.equal(st.standing, "lapsed", "escalated into a chargeback: read-only at once");
  assert.match(st.message, /disputed with the card company/);
  assert.ok(st.revokeKeyIds.includes(keyE3.id), "the period's key is named for removal");
  assert.match(hubLog, new RegExp(`dispute ${inqE.dispute.id} on charge ${renew2E.invoice.charge} escalated from an inquiry \\(needs_response\\); shop ${shopE} is read-only`));
  list = await ok(await adminCall("/accounts"));
  subAdminE = list.shops.find((s) => s.id === shopE).subscription;
  assert.deepEqual([subAdminE.inquiryAt, subAdminE.inquiries, subAdminE.disputedAt, subAdminE.unpaidSince], [today(), 1, today(), today()], "a chargeback, and the second inquiry still open");
  // The second closes without a chargeback (warning_closed): no inquiry left; nothing was taken, so nothing to restore.
  allDelivered(await mockPost(`/__disputes/${inq2E.dispute.id}/close`, { status: "warning_closed" }), "the second inquiry closes");
  list = await ok(await adminCall("/accounts"));
  subAdminE = list.shops.find((s) => s.id === shopE).subscription;
  assert.deepEqual([subAdminE.inquiryAt, subAdminE.inquiries], [null, 0], "the inquiry flag is cleared");
  assert.match(hubLog, new RegExp(`inquiry ${inq2E.dispute.id} on charge ${renew3E.invoice.charge} closed without a chargeback`));
  // A late invoice.paid for the disputed month changes nothing; a newer payment that stands makes it good again; a later
  // update to that chargeback (evidence under review) changes nothing more.
  assert.equal((await postWebhook(lateEvent("invoice.paid", renew2E.invoice.id))).status, 200);
  assert.equal((await standing(keyE, "shopE")).standing, "lapsed", "a late invoice.paid for the disputed month");
  const renew4E = await mockPost(`/__subscriptions/${subE}/renew`, { paid: true });
  allDelivered(renew4E, "E pays again");
  assert.equal((await standing(keyE, "shopE")).standing, "active");
  allDelivered(await mockPost(`/__disputes/${inqE.dispute.id}/update`, { status: "under_review" }), "the chargeback under review");
  assert.equal((await standing(keyE, "shopE")).standing, "active", "an update to a chargeback already handled doesn't lapse the shop again");
  // A dispute the hub never saw open, already lost: read-only, and the subscription is cancelled in Stripe.
  const lostE = await mockPost(`/__charges/${renew4E.invoice.charge}/dispute`, { status: "lost" });
  allDelivered(lostE, "a dispute already lost");
  st = await standing(keyE, "shopE");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /disputed with the card company/);
  assert.equal(mock.subscriptions.get(subE).status, "canceled");
  console.log("the trial's edges (subscribe inside it, a refund inside it, a won chargeback, inquiries): ok");

  // ----- 9e. Two subscriptions for one shop: past_due, lapsed after its grace, subscribed again. Completing the new
  // Checkout cancels the old one in Stripe, and the old one's late events (its update, payments, cancellation) are
  // ignored: the shop stays on the new one. -----
  const keyG = await register("Billing Test Twice G");
  const claimG = await claim(keyG, { shopRef: "shopG", shopName: "G Repair", kind: "repair", program: "StitchBench", version: "1.8.0", sole: true });
  const shopG = claimG.shop.id;
  await connectTo(b, keyG, "shopG", "G Repair");
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [shopG]);
  const coG1 = await ok(await page(b, `/shops/${shopG}/checkout`, { plan: "shop", interval: "monthly" }));
  const paidG1 = await mockPost(`/__pay/${coG1.sessionId}`);
  allDelivered(paidG1, "G's first subscription");
  const subG1 = paidG1.subscription.id;
  allDelivered(await mockPost(`/__subscriptions/${subG1}/renew`, { paid: false }), "G's payment fails");
  const pastG = Math.floor(Date.now() / 1000) - 15 * 86400;
  allDelivered(await mockPost(`/__subscriptions/${subG1}`, { current_period_end: pastG, current_period_start: pastG - 30 * 86400 }), "G's grace runs out");
  assert.equal((await standing(keyG, "shopG")).standing, "lapsed");
  assert.equal(mock.subscriptions.get(subG1).status, "past_due", "Stripe may still retry the old one");
  const coG2 = await ok(await page(b, `/shops/${shopG}/checkout`, { plan: "shop", interval: "monthly" }));
  const paidG2 = await mockPost(`/__pay/${coG2.sessionId}`);
  allDelivered(paidG2, "G subscribes again");
  const subG2 = paidG2.subscription.id;
  assert.equal(mock.subscriptions.get(subG1).status, "canceled", "the new Checkout cancels the old subscription in Stripe");
  assert.match(hubLog, new RegExp(`older subscription ${subG1} \\(past_due\\) is cancelled in Stripe`));
  const lastG = day(paidG2.subscription.current_period_end * 1000);
  st = await standing(keyG, "shopG");
  assert.deepEqual([st.standing, st.lastDay], ["active", lastG]);
  const keyG2 = checkKey(st.key, shopG, "G's new key").id;
  allDelivered(await mockPost(`/__subscriptions/${subG1}`, { status: "past_due" }), "the old subscription's late update");
  allDelivered(await mockPost(`/__subscriptions/${subG1}/renew`, { paid: false }), "the old subscription's failed payment");
  allDelivered(await mockPost(`/__subscriptions/${subG1}/renew`, { paid: true }), "the old subscription's payment");
  allDelivered(await mockPost(`/__subscriptions/${subG1}/cancel`, { at_period_end: false }), "the old subscription's cancellation");
  st = await standing(keyG, "shopG");
  assert.deepEqual([st.standing, st.lastDay, checkKey(st.key, shopG, "G's key after the old events").id], ["active", lastG, keyG2], "the shop stays on its new subscription");
  assert.equal((await db.query(`SELECT stripe_subscription_id FROM subscriptions WHERE shop_id = $1`, [shopG])).rows[0].stripe_subscription_id, subG2);
  assert.match(hubLog, new RegExp(`subscription ${subG1} \\(\\w+\\) for shop ${shopG} ignored: the shop's subscription is ${subG2} \\(active\\)`));
  console.log("two subscriptions for one shop: ok");

  // ----- 10. Waived: a retail shop partnered with a repair shop in good standing; "both" pays; the waiver ends. -----
  // The real-partnership rule (owner, 5 Oct 2026): the repair partner must be a paying subscriber (here: a subscription
  // row, as the webhook writes it) and a repair must have passed in the last quarter or this one (a new link is fine for 90 days).
  const subscribeRow = (shopId, status = "active", extra = "") =>
    db.query(
      `INSERT INTO subscriptions (shop_id, stripe_subscription_id, plan, tier, status, current_period_end) VALUES ($1, $2, 'm', 'shop', $3, now() + interval '20 days')
       ON CONFLICT (shop_id) DO UPDATE SET status = excluded.status, current_period_end = excluded.current_period_end ${extra}`,
      [shopId, `sub_row_${shopId}`, status],
    );
  const keyR = await register("Billing Test Repair R");
  const keyS = await register("Billing Test Quilts S");
  const claimR = await claim(keyR, { shopRef: "shopR", shopName: "R Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopR = claimR.shop.id;
  const claimS = await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop", version: "1.0.0", sole: true });
  const shopS = claimS.shop.id;
  const claimT = await claim(keyS, { shopRef: "shopT", shopName: "T Both", kind: "both", program: "StitchShop", version: "1.0.0" });
  await subscribeRow(shopR);
  // S's and T's trials are long over, so only the partnership can keep them working.
  await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = ANY($1)`, [[shopS, claimT.shop.id]]);
  await db.query(`DELETE FROM license_issues WHERE shop_id = ANY($1)`, [[shopS, claimT.shop.id]]);
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "lapsed", "trial over, no partner yet");
  const inv = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair", terms: { repairCommissionPct: 15 } } }));
  const red = await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv.code, shopRef: "shopS", shopName: "S Quilts" } }));
  assert.equal(red.side, "retail");
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["waived", null], "a new partnership with a paying partner: waived at once, no grace");
  assert.match(st.message, /Free while you're partnered with R Repair/);
  k = checkKey(st.key, shopS, "waived key");
  assert.deepEqual([k.p, k.f, k.u, k.g, k.l, st.plan], ["w", today(), plusDays(34), 14, "shop", "shop"], "partnered: Shop, free");
  const waivedKeyId = k.id;
  assert.equal(checkKey((await claim(keyS, { shopRef: "shopS", shopName: "S Quilts", kind: "retail", program: "StitchShop" })).key, shopS, "waived again").id, waivedKeyId, "one waived key a day");
  // A "both" shop partnered the same way pays: no waiver.
  const inv2 = await ok(await call("/v1/partners/invites", { key: keyR, json: { shopRef: "shopR", shopName: "R Repair", side: "repair" } }));
  await ok(await call("/v1/partners/redeem", { key: keyS, json: { code: inv2.code, shopRef: "shopT", shopName: "T Both" } }));
  assert.equal((await standing(keyS, "shopT")).standing, "lapsed", "a both shop is a repair shop: it pays");
  // The repair shop is never waived by its partners, and a repair shop that lapses puts the waiver in its grace.
  assert.equal((await standing(keyR, "shopR")).standing, "active");
  const lapsedR = await ok(await adminCall(`/shops/${shopR}/lapse`, { lapsed: true }));
  assert.equal(lapsedR.shop.standing, "lapsed");
  st = await standing(keyR, "shopR");
  assert.equal(st.standing, "lapsed");
  assert.match(st.message, /hub admin ended/);
  assert.ok(st.revokeKeyIds.includes(claimR.key && checkKey(claimR.key, shopR, "R's trial key").id), "R's live trial key is revoked");
  k = checkKey(st.key, shopR, "R's cut key");
  assert.deepEqual([k.p, k.g], ["t", 0]);
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["waived", plusDays(30)], "the partner stopped paying: a 30-day grace, still waived");
  assert.match(st.message, /Your free StitchShop comes with your repair partnership with R Repair\. Subscribe to keep going after \d{4}-\d\d-\d\d; nothing is locked or lost\./);
  k = checkKey(st.key, shopS, "S key in grace");
  assert.deepEqual([k.p, k.u], ["w", plusDays(30)], "the waived key never runs past the grace");
  const graceKeyId = k.id;
  assert.equal(checkKey((await standing(keyS, "shopS")).key, shopS, "grace again").id, graceKeyId, "one key for the whole grace");
  // Undo: R is back to a paying subscriber, S is waived again and the grace is cleared.
  await ok(await adminCall(`/shops/${shopR}/lapse`, { lapsed: false }));
  assert.equal((await standing(keyR, "shopR")).standing, "active");
  st = await standing(keyS, "shopS");
  assert.deepEqual([st.standing, st.lastDay], ["waived", null]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM waiver_grace WHERE link_id = $1`, [red.link.id])).rows[0].n, 0, "the grace is cleared the day the rule holds");
  // The partnership ends: notice again; when the last waived key is over, lapsed, with that key left to run out.
  await ok(await call(`/v1/partners/links/${red.link.id}/end`, { key: keyR, json: { shopRef: "shopR" } }));
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "trial");
  assert.match(st.message, /Subscribe by/);
  await db.query(`UPDATE license_issues SET last_day = current_date - 1, first_day = current_date - 35 WHERE shop_id = $1 AND plan = 'w'`, [shopS]);
  st = await standing(keyS, "shopS");
  assert.equal(st.standing, "lapsed");
  const lastW = (await db.query(`SELECT key_id FROM license_issues WHERE shop_id = $1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`, [shopS])).rows[0].key_id;
  assert.equal(checkKey(st.key, shopS, "S lapsed").id, lastW, "the key it holds already ends the right day: nothing new");
  console.log("waived: ok");

  // ----- 10b. The real-partnership rule: paid partner + a repair in the quarter; grace and fallback for each break. -----
  const quarterBefore = (n) => `${new Date(Date.parse(`${quarterStart(today(), n)}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10)}`; // the day before the quarter n back began
  // One repair install and one quilt install hold every pair (registering is rate limited); each pair has its own shop refs.
  const kr = await register("Rule Repair Install");
  const ks = await register("Rule Quilts Install");
  let pairN = 0;
  const pair = async (name, { trialOver = true } = {}) => {
    const n = ++pairN;
    const cr = await claim(kr, { shopRef: `r${n}`, shopName: `${name} Repair`, kind: "repair", program: "StitchBench", version: "1.7.0" });
    const cs = await claim(ks, { shopRef: `s${n}`, shopName: `${name} Quilts`, kind: "retail", program: "StitchShop", version: "1.0.0" });
    if (trialOver) {
      await db.query(`UPDATE shops SET created_at = now() - interval '40 days' WHERE id = $1`, [cs.shop.id]);
      await db.query(`DELETE FROM license_issues WHERE shop_id = $1`, [cs.shop.id]);
    }
    const i = await ok(await call("/v1/partners/invites", { key: kr, json: { shopRef: `r${n}`, shopName: `${name} Repair`, side: "repair" } }));
    const rd = await ok(await call("/v1/partners/redeem", { key: ks, json: { code: i.code, shopRef: `s${n}`, shopName: `${name} Quilts` } }));
    // An old partnership, so its first-quarter ease is over and only the rule itself decides.
    await db.query(`UPDATE partner_links SET created_at = now() - interval '200 days' WHERE id = $1`, [rd.link.id]);
    return { ref: `s${n}`, shopR: cr.shop.id, shopS: cs.shop.id, link: rd.link.id };
  };
  let msgN = 0;
  const repairPassed = (link, when = "now()") =>
    db.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes, created_at) VALUES ($1, $2, 'retail', 'job.new', $3, 10, ${when})`, [`m${RUN}${++msgN}`, link, { id: `job${RUN}${msgN}` }]);
  const graceRow = async (link) => (await db.query(`SELECT since::text AS since, reason FROM waiver_grace WHERE link_id = $1`, [link])).rows[0];
  // 31 days on: the grace row is that old and the waived keys signed in it (which end with it) are over.
  const endGrace = async (link) => {
    await db.query(`UPDATE waiver_grace SET since = current_date - 31 WHERE link_id = $1`, [link]);
    await db.query(`UPDATE license_issues SET last_day = current_date - 1, first_day = current_date - 35 WHERE plan = 'w' AND shop_id IN (SELECT s.id FROM partner_links l JOIN shops s ON s.install_id = l.retail_install_id AND s.shop_ref = l.retail_shop_ref WHERE l.id = $1)`, [link]);
  };

  // (a) Partner paid (trialing with a card counts) and a repair this quarter: waived, no grace; the admin sees why.
  const pa = await pair("PA");
  await subscribeRow(pa.shopR, "trialing");
  await repairPassed(pa.link);
  st = await standing(ks, pa.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", null], "partner paid + a repair: waived");
  assert.equal(await graceRow(pa.link), undefined);
  const listed = (await ok(await adminCall("/accounts"))).shops.find((s) => s.id === pa.shopS);
  assert.deepEqual([listed.waivedBy.name, listed.waivedBy.partnerStanding, listed.waivedBy.repairs, listed.waivedBy.lastRepair, listed.waivedBy.graceEnd], ["PA Repair", "active", 1, today(), null], "the admin sees the partner, its standing, the last repair, no grace");
  // A repair only in the quarter before last doesn't count; one in the last quarter does.
  const pq = await pair("PQ");
  await subscribeRow(pq.shopR);
  await repairPassed(pq.link, `'${quarterBefore(1)}'::date`); // the day before last quarter began: too old
  assert.equal((await standing(ks, pq.ref)).lastDay, plusDays(30), "a repair older than last quarter: grace");
  await repairPassed(pq.link, `'${quarterStart(today(), 1)}'::date`); // the first day of last quarter: counts
  st = await standing(ks, pq.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", null], "a repair in the last quarter counts");
  assert.equal(await graceRow(pq.link), undefined, "and the grace it started is cleared");

  // (b) The partner lapses (a subscription that ended): grace with the notice, then the shop's normal standing: lapsed
  // here (its trial was used up).
  const pb = await pair("PB");
  await subscribeRow(pb.shopR);
  await repairPassed(pb.link);
  assert.equal((await standing(ks, pb.ref)).standing, "waived");
  await db.query(`UPDATE subscriptions SET status = 'canceled', current_period_end = now() - interval '2 days' WHERE shop_id = $1`, [pb.shopR]);
  st = await standing(ks, pb.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", plusDays(30)], "partner lapsed: grace");
  assert.equal((await graceRow(pb.link)).reason, "partner");
  assert.match(st.message, new RegExp(`Subscribe to keep going after ${plusDays(30)}; nothing is locked or lost`));
  assert.equal(checkKey(st.key, pb.shopS, "PB grace key").u, plusDays(30));
  assert.equal((await adminCall("/accounts").then(ok)).shops.find((s) => s.id === pb.shopS).waivedBy.graceEnd, plusDays(30), "the admin sees the grace end");
  await endGrace(pb.link); // 31 days on
  st = await standing(ks, pb.ref);
  assert.equal(st.standing, "lapsed", "after the grace: the normal lapse rules (read-only, nothing deleted)");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM shops WHERE id = $1`, [pb.shopS])).rows[0].n, 1);
  // The same fall back for a quilt shop whose trial is unused: back to its trial.
  const pt = await pair("PT", { trialOver: false });
  await repairPassed(pt.link); // partner only on its own trial: not a payer
  st = await standing(ks, pt.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", plusDays(30)], "a partner on a free trial is not paid: grace from the first day");
  assert.equal((await graceRow(pt.link)).reason, "partner");
  await endGrace(pt.link);
  st = await standing(ks, pt.ref);
  assert.equal(st.standing, "trial", "an unused trial is what it falls back to");
  assert.match(st.message, /Free trial through/);

  // (c) No repair for a quarter: grace, then fallback; (d) activity resumes inside the grace: stays waived.
  const pc = await pair("PC");
  await subscribeRow(pc.shopR);
  st = await standing(ks, pc.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", plusDays(30)], "no repair in the quarter: grace");
  assert.equal((await graceRow(pc.link)).reason, "activity");
  assert.match(st.message, /No repair has passed between you in the last quarter/);
  await repairPassed(pc.link); // (d)
  st = await standing(ks, pc.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", null], "a repair inside the grace keeps the waiver");
  assert.equal(await graceRow(pc.link), undefined);
  const pd = await pair("PD");
  await subscribeRow(pd.shopR);
  await standing(ks, pd.ref);
  await endGrace(pd.link);
  assert.equal((await standing(ks, pd.ref)).standing, "lapsed", "no repair and the grace over: lapsed, never deleted");
  // After the fall back, the partner paying and a repair passing don't undo what the program already holds, but the next
  // claim finds the rule holding again: waived once more (the waiver is a rule, not a one-way door).
  await repairPassed(pd.link);
  assert.equal((await standing(ks, pd.ref)).standing, "waived", "the rule holding again waives it again");

  // (e) A brand new partnership is waived at once even with no repair yet and a partner that pays.
  const pn = await pair("PN");
  await subscribeRow(pn.shopR);
  await db.query(`UPDATE partner_links SET created_at = now() - interval '10 days' WHERE id = $1`, [pn.link]);
  assert.deepEqual([(await standing(ks, pn.ref)).standing, (await standing(ks, pn.ref)).lastDay], ["waived", null], "first quarter: no repair needed yet");

  // (f) Add-ons are never waived: every key the hub signs for a waived shop is for "base" alone.
  const mods = (await db.query(`SELECT DISTINCT modules FROM license_issues WHERE shop_id = ANY($1)`, [[pa.shopS, pb.shopS, pc.shopS, pd.shopS, pn.shopS, shopS]])).rows.map((r) => r.modules.join(","));
  assert.deepEqual(mods, ["base"], "the waiver covers the base plan only; add-ons stay paid");
  // (g) Both shops on signed messages (each has a key on the link): the quilt shop's own messages prove nothing, so only
  // what the repair shop signed and the hub verified counts. A pair with a side still on an older program counts as before.
  const ky = await pair("PG");
  await subscribeRow(ky.shopR);
  await db.query(`UPDATE partner_links SET repair_key = 'k-repair', retail_key = 'k-retail' WHERE id = $1`, [ky.link]);
  await repairPassed(ky.link); // a retail job.new, unverified
  await db.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes, sig, verified) VALUES ($1, $2, 'retail', 'pickup.done', '{"side":"retail"}', 10, '{}', true)`, [`g${RUN}1`, ky.link]);
  await db.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes, sig, verified) VALUES ($1, $2, 'retail', 'job.new', '{"id":"x"}', 10, '{}', true)`, [`g${RUN}2`, ky.link]);
  await db.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes, verified) VALUES ($1, $2, 'repair', 'job.update', '{"id":"y"}', 10, false)`, [`g${RUN}3`, ky.link]);
  st = await standing(ks, ky.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", plusDays(30)], "keyed pair: the quilt shop's messages and an unverified one don't count: grace");
  assert.equal((await graceRow(ky.link)).reason, "activity");
  await db.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes, sig, verified) VALUES ($1, $2, 'repair', 'job.update', '{"id":"y"}', 10, '{}', true)`, [`g${RUN}4`, ky.link]);
  st = await standing(ks, ky.ref);
  assert.deepEqual([st.standing, st.lastDay], ["waived", null], "a verified job.update from the repair shop counts");
  assert.equal(await graceRow(ky.link), undefined);
  const kz = await pair("PZ"); // one side without a key: the plain job.new still counts
  await subscribeRow(kz.shopR);
  await db.query(`UPDATE partner_links SET repair_key = 'k-repair' WHERE id = $1`, [kz.link]);
  await repairPassed(kz.link);
  assert.deepEqual([(await standing(ks, kz.ref)).standing, (await standing(ks, kz.ref)).lastDay], ["waived", null], "a side on an older program: counted as before");
  console.log("partnership rule: ok");

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
