// Checks selling the Assistant (src/assistant-billing.mjs; the Stripe mock stands in for Stripe, the Anthropic mock for the
// model): the account page offers "Add the Assistant" and, once it is on, "Buy 300 more"; the Assistant is its own
// subscription (the shop's base standing, free since 11 Oct 2026, its key and the five add-ons' key are untouched, and a
// base subscription afterwards, made in Stripe now that plans aren't sold, doesn't cancel it); paying signs a key for the
// module "assistant" for the company's own id (the proxy accepts it) and the claim answer carries it as moduleKeys, before
// the add-ons' key; a renewal signs the next one; a cancelled subscription is paid through its day and an ended one gets no
// new key; the 300-call allowance runs out (402) and a paid top-up Checkout, credited by the webhook once (a replayed event
// adds nothing), gives 300 more that month, and one refunded before its credit lands is taken back when it does; a top-up
// needs the Assistant; keys owed (past_due keeps the paid period's key, a key run out isn't sent, ended unpaid is
// revoked); another account can't buy for this shop; a hub without the Assistant prices refuses and offers nothing.
// Fresh scratch database, dropped at the end.
// usage: DATABASE_URL=postgresql://... node test/assistant-billing.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { startStripeMock } from "./stripe-mock.mjs";
import { startAnthropicMock } from "./anthropic-mock.mjs";

const BASE_DB = process.env.DATABASE_URL || "postgresql://stitchbench:stitchbench@127.0.0.1:5433/postgres";
const ADMIN = "assistant-billing-test-admin";
const JOIN = "join-assistant-billing-test";
const RUN = Date.now().toString(36);
const FRESH_DB = `stitchhub_asstbill_${RUN}`;
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
const WEBHOOK_SECRET = "whsec_asstbilltest1234567890";
const ANTHROPIC_KEY = "sk-ant-test-ASSTBILLSECRET1234";
const P = {
  soloMonthly: `price_solom_${RUN}`,
  soloYearly: `price_soloy_${RUN}`,
  shopMonthly: `price_shopm_${RUN}`,
  shopYearly: `price_shopy_${RUN}`,
  aMonthly: `price_am_${RUN}`,
  aYearly: `price_ay_${RUN}`,
  aTopup: `price_at_${RUN}`,
};
const CATALOG = [
  [P.soloMonthly, "month", 2500],
  [P.soloYearly, "year", 25000],
  [P.shopMonthly, "month", 4500],
  [P.shopYearly, "year", 45000],
  [P.aMonthly, "month", 1500],
  [P.aYearly, "year", 15000],
  [P.aTopup, "once", 1000],
].map(([id, interval, amount]) => ({ id, interval, amount }));

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const HUB1_X = publicKey.export({ format: "jwk" }).x;
const HUB_LICENSE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }), "utf8").toString("base64");
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const stripeMock = await startStripeMock({ port: 0, webhookUrl: `${HUB}/v1/stripe`, webhookSecret: WEBHOOK_SECRET, catalog: CATALOG });
const anthropic = await startAnthropicMock({ port: 0, key: ANTHROPIC_KEY });

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
  HUB_NAME: "Assistant Billing Test Hub",
  HUB_LICENSE_KID: "hub1",
  HUB_LICENSE_KEY,
  STRIPE_API_BASE: stripeMock.url,
  STRIPE_SECRET_KEY: "sk_test_asstbillmock12345678",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SOLO_MONTHLY: P.soloMonthly,
  STRIPE_PRICE_SOLO_YEARLY: P.soloYearly,
  STRIPE_PRICE_SHOP_MONTHLY: P.shopMonthly,
  STRIPE_PRICE_SHOP_YEARLY: P.shopYearly,
  STRIPE_PRICE_ASSISTANT_MONTHLY: P.aMonthly,
  STRIPE_PRICE_ASSISTANT_YEARLY: P.aYearly,
  STRIPE_PRICE_ASSISTANT_TOPUP: P.aTopup,
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  ANTHROPIC_API_BASE: anthropic.url,
  ASSISTANT_MONTHLY_CALLS: "5",
  ASSISTANT_TOPUP_CALLS: "5",
  ASSISTANT_PUBLIC_KEYS: "",
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
  await anthropic.close();
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
const claim = (key, body) => ok(call("/v1/shops/claim", { key, json: body }));
const standing = (key, ref) => ok(call(`/v1/shops/${ref}/standing`, { key }));
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const day = (d) => new Date(d).toISOString().slice(0, 10);
const today = () => day(Date.now());
const plusDays = (n, from = Date.now()) => day(from + n * 86400_000);
const allDelivered = (r, what) => {
  assert.ok(r.delivered?.length, `${what}: no webhooks went out`);
  for (const d of r.delivered) assert.equal(d.status, 200, `${what}: webhook ${d.type} answered ${d.status} ${d.body ?? d.error ?? ""}`);
};
/** A key as the program takes it: verified against the hub's public key, for this company's own id. */
function keyPayload(text, shopRef, what) {
  const m = /^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/.exec(String(text ?? ""));
  assert.ok(m, `${what}: not a key`);
  const bytes = Buffer.from(m[1], "base64url");
  const good = crypto.verify(null, bytes, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: HUB1_X }, format: "jwk" }), Buffer.from(m[2], "base64url"));
  assert.ok(good, `${what}: the signature doesn't verify`);
  const p = JSON.parse(bytes.toString("utf8"));
  assert.equal(p.s, shopRef, `${what}: the key names ${p.s}, not the company ${shopRef}`);
  return p;
}
const ask = (installKey, shopRef, key, n = 1) =>
  call("/v1/assistant", { key: installKey, json: { shopRef, tz: "UTC", feature: "draft_work_done", model: "draft", system: "You write for a sewing shop.", messages: [{ role: "user", content: `Tidy this ${n}` }], maxTokens: 100, key } });
const mockApi = async (p, form) => {
  const out = await fetch(stripeMock.url + p, { method: "POST", headers: { Authorization: "Bearer sk_test_asstbillmock12345678", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }).then((r) => r.json());
  await settle(p);
  return out;
};
const usage = async (inst, ref) => (await db.query(`SELECT calls, bonus FROM assistant_usage WHERE install_id = $1 AND shop_ref = $2 ORDER BY month DESC LIMIT 1`, [inst, ref])).rows[0];

try {
  // ----- 1. a shop on its trial, its owner's account; the page offers the Assistant, no top-up yet -----
  const installKey = await register("Assistant Billing Test Shop");
  const claimA = await claim(installKey, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  const shopA = claimA.shop.id;
  // Every shop has the five add-ons' key (src/addons.mjs, since 11 Oct 2026); no Assistant key before it is bought.
  assert.equal(claimA.moduleKeys.length, 1);
  const addonsKey = claimA.moduleKeys[0];
  const fiveKey = keyPayload(addonsKey, "shopA", "the add-ons' key");
  assert.deepEqual([fiveKey.m, fiveKey.p, fiveKey.u], [["vac", "appliance", "scheduling", "marketing", "maker"], "c", "2099-12-31"], "no Assistant key before it is bought");
  const instId = (await db.query(`SELECT id FROM installs WHERE name = $1`, ["Assistant Billing Test Shop"])).rows[0].id;
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await ok(await call("/v1/accounts/start", { key: installKey, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: emailA, termsVersion: "2026-10-02" } }));
  const a = browser();
  await ok(await page(a, "/set-password", { token: linkToken("set-password"), password: "Good-password-1" }));
  const emailB = `owner-b-${RUN}@stitchhub.test`;
  const b = browser();
  await ok(await page(b, "/signup", { email: emailB, password: "Good-password-2", acceptTerms: true }));
  await ok(await page(b, "/verify", { token: linkToken("verify") }));
  let me = await ok(await page(a, "/me"));
  assert.deepEqual(me.billing.assistantPrices, { monthly: "$15 a month", yearly: "$150 a year", topup: "$10", topUpCalls: 5 });
  assert.deepEqual(me.shops[0].assistant, { status: "none", paidThrough: null, plan: null, canAdd: true, canTopUp: false });
  console.log("account page offers the Assistant: ok");

  // ----- 2. refusals: another account, a bad interval, a top-up without the Assistant, signed out -----
  await status(await page(b, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }), 404, "another account's shop");
  await status(await page(b, `/shops/${shopA}/assistant/topup`, {}), 404, "another account's shop (top-up)");
  await status(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "weekly" }), 400, "bad interval");
  await status(await page(browser(), `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }), 401, "signed out");
  await status(await page(a, `/shops/${shopA}/assistant/topup`, {}), 409, "no Assistant yet");
  console.log("refusals: ok");

  // ----- 3. add the Assistant monthly: its own subscription, a key for the module, the base standing untouched -----
  const co = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly", acceptTerms: true }));
  const session = stripeMock.sessions.get(co.sessionId);
  assert.equal(session.mode, "subscription");
  assert.equal(session.line_items.data[0].price.id, P.aMonthly);
  assert.equal(session.metadata.hub_product, "assistant");
  assert.equal(session.subscription_data.metadata.hub_product, "assistant", "the subscription itself says it is the Assistant's");
  assert.equal(session.subscription_data.trial_end, undefined, "no Stripe trial: the Assistant is charged when bought");
  const paid = await mockPost(`/__pay/${co.sessionId}`);
  allDelivered(paid, "Assistant payment");
  const sub = paid.subscription;
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].n, 0, "nothing in the base plan's table");
  const row = (await db.query(`SELECT * FROM assistant_subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  assert.deepEqual([row.stripe_subscription_id, row.plan, row.status, row.price_id], [sub.id, "m", "active", P.aMonthly]);
  let st = await standing(installKey, "shopA");
  assert.equal(st.standing, "comped", "the base standing is free, as every shop's");
  assert.equal(keyPayload(st.key, "shopA", "base key").m.join(), "base", "the base key is the base key (both keys name the company's own id, shop_ref, since hub-accounts)");
  assert.equal(st.moduleKeys.length, 2);
  assert.equal(st.moduleKeys[1], addonsKey, "the Assistant's key first, then the add-ons' (the same one as before)");
  const firstKey = st.moduleKeys[0];
  const ak = keyPayload(firstKey, "shopA", "Assistant key");
  assert.deepEqual(ak.m, ["assistant"]);
  assert.equal(ak.u, day(sub.current_period_end * 1000), "paid through the period's end");
  assert.equal(ak.g, 14);
  assert.deepEqual((await standing(installKey, "shopA")).moduleKeys, st.moduleKeys, "asked again: the same keys");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1 AND 'assistant' = ANY(modules)`, [shopA])).rows[0].n, 1);
  me = await ok(await page(a, "/me"));
  assert.deepEqual(me.shops[0].assistant, { status: "active", paidThrough: ak.u, plan: "m", canAdd: false, canTopUp: true });
  await status(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "yearly" }), 409, "already has it");
  console.log("add the Assistant: ok");

  // ----- 4. the proxy takes that key: 5 calls a month in this test, the 6th is refused -----
  for (let i = 1; i <= 5; i++) await ok(await ask(installKey, "shopA", st.moduleKeys[0], i));
  let r = await ask(installKey, "shopA", st.moduleKeys[0], 6);
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /used this month's 5/);
  assert.deepEqual(await usage(instId, "shopA"), { calls: 5, bonus: 0 });
  console.log("the key works at the proxy and the month runs out: ok");
  // The key copied to another install, for a company of the same id there, gives it nothing: the hub's key is on record
  // for this install's company only.
  const otherKey = await register("Assistant Billing Copy Install");
  await claim(otherKey, { shopRef: "shopA", shopName: "Copy", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  r = await ask(otherKey, "shopA", st.moduleKeys[0], 1);
  assert.equal(r.status, 402, "a copied key");
  assert.match((await r.json()).error, /isn't turned on/);
  console.log("a copied key: ok");

  // ----- 5. buy 300 more: a payment Checkout, credited once by the webhook -----
  const tu = await ok(await page(a, `/shops/${shopA}/assistant/topup`, {}));
  const ts = stripeMock.sessions.get(tu.sessionId);
  assert.equal(ts.mode, "payment");
  assert.equal(ts.line_items.data[0].price.id, P.aTopup);
  assert.deepEqual([ts.metadata.hub_product, ts.metadata.hub_shop_id], ["assistant_topup", shopA]);
  assert.deepEqual(await usage(instId, "shopA"), { calls: 5, bonus: 0 }, "nothing credited before it is paid");
  const topPaid = await mockPost(`/__pay/${tu.sessionId}`);
  allDelivered(topPaid, "top-up payment");
  assert.deepEqual(await usage(instId, "shopA"), { calls: 5, bonus: 5 }, "credited to the company's month");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assistant_topups WHERE shop_id = $1`, [shopA])).rows[0].n, 1);
  await ok(await ask(installKey, "shopA", st.moduleKeys[0], 6));
  // The same event again (Stripe retries) and the same session paid again change nothing.
  const completed = stripeMock.events.filter((e) => e.type === "checkout.session.completed" && e.data.object.id === tu.sessionId).at(-1);
  const replay = await mockPost(`/__replay/${completed.id}`);
  assert.ok(JSON.stringify(replay).length > 0);
  await mockPost(`/__pay/${tu.sessionId}`);
  assert.deepEqual(await usage(instId, "shopA"), { calls: 6, bonus: 5 }, "still one top-up");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assistant_topups WHERE shop_id = $1`, [shopA])).rows[0].n, 1);
  // A late event naming a top-up session that isn't paid credits nothing.
  const unpaid = await ok(await page(a, `/shops/${shopA}/assistant/topup`, {}));
  const late = { id: `evt_late_${RUN}`, type: "checkout.session.completed", data: { object: { id: unpaid.sessionId } } };
  const body = JSON.stringify(late);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")}`;
  await status(await fetch(`${HUB}/v1/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": sig }, body }), 200, "late event");
  assert.deepEqual(await usage(instId, "shopA"), { calls: 6, bonus: 5 }, "an unpaid session is not credited");
  // A refunded top-up takes its calls back: half the money, half the calls (rounded up); the rest, the rest.
  const topCharge = stripeMock.sessions.get(tu.sessionId).charge;
  assert.equal((await mockApi("/v1/refunds", { charge: topCharge, amount: "500" })).object, "refund");
  assert.deepEqual(await usage(instId, "shopA"), { calls: 6, bonus: 2 }, "half refunded: 3 of the 5 calls taken back");
  assert.equal((await mockApi("/v1/refunds", { charge: topCharge })).object, "refund");
  assert.deepEqual(await usage(instId, "shopA"), { calls: 6, bonus: 0 }, "refunded in full: all 5 taken back");
  assert.equal((await db.query(`SELECT calls_taken FROM assistant_topups WHERE stripe_session_id = $1`, [tu.sessionId])).rows[0].calls_taken, 5);
  assert.equal((await ask(installKey, "shopA", st.moduleKeys[0], 7)).status, 402, "the month is used up again");
  console.log("top-up: ok (credited once, taken back on a refund)");

  // ----- 5b. a top-up refunded before its Checkout credit lands: held, then taken back when it does -----
  // The mock delivers checkout.session.completed at once; to see the other order (the refund's webhook first, as when the
  // completed event failed and Stripe retries it later), the credit is taken back out of the database as if it had never
  // landed, the refund goes, and then the completed event is delivered again.
  const tu2 = await ok(await page(a, `/shops/${shopA}/assistant/topup`, {}));
  await mockPost(`/__pay/${tu2.sessionId}`);
  const ts2 = stripeMock.sessions.get(tu2.sessionId);
  const completed2 = stripeMock.events.filter((e) => e.type === "checkout.session.completed" && e.data.object.id === tu2.sessionId).at(-1);
  await db.query(`DELETE FROM assistant_topups WHERE stripe_session_id = $1`, [tu2.sessionId]);
  await db.query(`UPDATE assistant_usage SET bonus = 0 WHERE install_id = $1 AND shop_ref = $2`, [instId, "shopA"]);
  await db.query(`DELETE FROM stripe_events WHERE id = $1`, [completed2.id]);
  await mockApi("/v1/refunds", { charge: ts2.charge });
  const pend = (await db.query(`SELECT share FROM assistant_topup_pending WHERE stripe_payment_intent = $1`, [ts2.payment_intent])).rows[0];
  assert.equal(Number(pend.share), 1, "the refund waits for the credit");
  await mockPost(`/__replay/${completed2.id}`);
  assert.equal((await usage(instId, "shopA")).bonus, 0, "credited and taken back at once");
  assert.equal((await db.query(`SELECT calls_taken FROM assistant_topups WHERE stripe_session_id = $1`, [tu2.sessionId])).rows[0].calls_taken, 5);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assistant_topup_pending`)).rows[0].n, 0, "the pending row is used up");
  // A refunded charge with no invoice that isn't a top-up's (its payment says nothing of one) isn't held as one.
  const bareCharge = (await mockPost("/__charges", { amount: 700 })).charge;
  await mockApi("/v1/refunds", { charge: bareCharge.id });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assistant_topup_pending`)).rows[0].n, 0, "another app's refund isn't parked as a top-up");
  console.log("a top-up refunded before its credit: ok");

  // ----- 6. a base subscription afterwards (made in Stripe: plans aren't sold on the hub since 11 Oct 2026): its own row,
  // the standing and keys as they were; the Assistant is not cancelled as "older" -----
  const baseSession = await mockApi("/v1/checkout/sessions", {
    mode: "subscription",
    customer: session.customer,
    "line_items[0][price]": P.soloMonthly,
    success_url: `${HUB}/account/shops`,
    cancel_url: `${HUB}/account/shops`,
    "metadata[hub_shop_id]": shopA,
    "subscription_data[metadata][hub_shop_id]": shopA,
  });
  allDelivered(await mockPost(`/__pay/${baseSession.id}`), "base payment");
  const assistantSub = stripeMock.subscriptions.get(sub.id);
  assert.notEqual(assistantSub.status, "canceled", "the Assistant subscription survives a base Checkout");
  st = await standing(installKey, "shopA");
  assert.equal(st.standing, "comped", "still free: a subscription changes nothing");
  assert.equal(keyPayload(st.key, "shopA", "base key after paying").m.join(), "base");
  assert.deepEqual(st.moduleKeys, [firstKey, addonsKey], "the Assistant key is unchanged");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].n, 1);
  assert.equal((await db.query(`SELECT status FROM assistant_subscriptions WHERE shop_id = $1`, [shopA])).rows[0].status, "active");
  console.log("base plan beside the Assistant: ok");

  // ----- 7. a renewal signs the next key; cancelling at period end is paid through; an ended one gets no new key -----
  await mockPost(`/__subscriptions/${sub.id}/renew`, { paid: true });
  st = await standing(installKey, "shopA");
  const renewed = keyPayload(st.moduleKeys[0], "shopA", "renewed key");
  assert.ok(renewed.u > ak.u, `the renewed key runs to ${renewed.u}, past ${ak.u}`);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1 AND 'assistant' = ANY(modules)`, [shopA])).rows[0].n, 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1 AND 'base' = ANY(modules) AND revoked_at IS NULL`, [shopA])).rows[0].n >= 1, true);
  await mockPost(`/__subscriptions/${sub.id}/cancel`, { at_period_end: true });
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops[0].assistant.status, "ending");
  assert.deepEqual([me.shops[0].assistant.canAdd, me.shops[0].assistant.canTopUp], [false, true], "cancelled but paid through: top-ups still add to what it paid for");
  assert.equal((await standing(installKey, "shopA")).moduleKeys[0], st.moduleKeys[0], "the key stays");
  await mockPost(`/__subscriptions/${sub.id}`, { status: "canceled", current_period_end: Math.floor(Date.now() / 1000) - 3 * 86400 });
  me = await ok(await page(a, "/me"));
  assert.deepEqual([me.shops[0].assistant.status, me.shops[0].assistant.canAdd, me.shops[0].assistant.canTopUp], ["ended", true, false]);
  const before = (await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1 AND 'assistant' = ANY(modules)`, [shopA])).rows[0].n;
  assert.equal((await standing(installKey, "shopA")).moduleKeys[0], st.moduleKeys[0], "an ended subscription is sent the key it had, which runs out on its own");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM license_issues WHERE shop_id = $1 AND 'assistant' = ANY(modules)`, [shopA])).rows[0].n, before, "no new key for an ended subscription");
  console.log("renewal, cancellation, end: ok");

  // ----- 8. buying again after the end: yearly, a new subscription replaces the ended one -----
  const again = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "yearly" }));
  assert.equal(stripeMock.sessions.get(again.sessionId).line_items.data[0].price.id, P.aYearly);
  const paidY = await mockPost(`/__pay/${again.sessionId}`);
  allDelivered(paidY, "yearly Assistant");
  me = await ok(await page(a, "/me"));
  assert.deepEqual([me.shops[0].assistant.status, me.shops[0].assistant.plan], ["active", "y"]);
  assert.equal((await db.query(`SELECT stripe_subscription_id FROM assistant_subscriptions WHERE shop_id = $1`, [shopA])).rows[0].stripe_subscription_id, paidY.subscription.id);
  st = await standing(installKey, "shopA");
  assert.equal(keyPayload(st.moduleKeys[0], "shopA", "yearly key").p, "y");
  console.log("buy again, yearly: ok");

  // ----- 8b. the Assistant's own payment refunded in full: its keys revoked, the subscription cancelled, no new key -----
  const yearlyKey = keyPayload(st.moduleKeys[0], "shopA", "yearly key");
  await db.query(`UPDATE assistant_usage SET calls = 0`);
  assert.equal((await ask(installKey, "shopA", st.moduleKeys[0], 1)).status, 200, "the yearly key works before the refund");
  assert.equal((await mockApi("/v1/refunds", { charge: paidY.invoice.charge })).object, "refund");
  assert.equal(stripeMock.subscriptions.get(paidY.subscription.id).status, "canceled", "a full refund cancels the Assistant's subscription in Stripe");
  assert.ok((await db.query(`SELECT unpaid_since FROM assistant_subscriptions WHERE shop_id = $1`, [shopA])).rows[0].unpaid_since, "the period is taken back");
  r = await ask(installKey, "shopA", st.moduleKeys[0], 2);
  assert.equal(r.status, 402, "the refunded key is refused at the proxy at once");
  st = await standing(installKey, "shopA");
  assert.deepEqual(st.moduleKeys, [addonsKey], "no Assistant key after the refund: the add-ons' alone");
  assert.ok(st.revokeKeyIds.includes(yearlyKey.id), "the refunded key is named for removal");
  me = await ok(await page(a, "/me"));
  assert.equal(me.shops[0].assistant.status, "ended");
  console.log("Assistant refund: ok");

  // ----- 8c. two Checkouts paid: the older Assistant subscription is cancelled (never the base plan's) -----
  const baseSubId = (await db.query(`SELECT stripe_subscription_id FROM subscriptions WHERE shop_id = $1`, [shopA])).rows[0].stripe_subscription_id;
  const co1 = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }));
  const co2 = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }));
  const sub1 = (await mockPost(`/__pay/${co1.sessionId}`)).subscription.id;
  const sub2 = (await mockPost(`/__pay/${co2.sessionId}`)).subscription.id;
  assert.equal(stripeMock.subscriptions.get(sub1).status, "canceled", "the older Assistant subscription is cancelled, so it can't bill again");
  assert.equal(stripeMock.subscriptions.get(baseSubId).status, "active", "the base plan's is left alone");
  const aRow = async () => (await db.query(`SELECT stripe_subscription_id, unpaid_since, chargeback_dispute_ids FROM assistant_subscriptions WHERE shop_id = $1`, [shopA])).rows[0];
  assert.equal((await aRow()).stripe_subscription_id, sub2);
  console.log("a second Checkout cancels the older Assistant subscription: ok");

  // ----- 8d. monthly to yearly in the Customer Portal: its subscription_update invoice paid for a new year, so refunding it
  // takes the period back; a partial refund leaves the subscription running, so the Assistant is on hold, not "ended" -----
  const item2 = stripeMock.subscriptions.get(sub2).items.data[0].id;
  await mockApi(`/v1/subscriptions/${sub2}`, { "items[0][id]": item2, "items[0][price]": P.aYearly, proration_behavior: "always_invoice" });
  const yearUp = [...stripeMock.invoices.values()].filter((i) => i.subscription === sub2 && i.billing_reason === "subscription_update").at(-1);
  assert.ok(yearUp?.charge, "the switch charged for the new year");
  assert.equal((await mockApi("/v1/refunds", { charge: yearUp.charge, amount: "100" })).object, "refund");
  assert.ok((await aRow()).unpaid_since, "refunding the switch to yearly takes the period back");
  assert.equal(stripeMock.subscriptions.get(sub2).status, "active", "a partial refund leaves the subscription running");
  me = await ok(await page(a, "/me"));
  assert.deepEqual([me.shops[0].assistant.status, me.shops[0].assistant.canAdd, me.shops[0].assistant.canTopUp], ["on_hold", false, false]);
  assert.match((await status(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }), 409, "no second subscription while one is on hold")).error, /on hold/);
  const renew1 = await mockPost(`/__subscriptions/${sub2}/renew`, { paid: true });
  assert.equal((await aRow()).unpaid_since, null, "a later period's payment makes it good");
  console.log("a refunded switch to yearly, on hold: ok");

  // ----- 8e. a chargeback on the Assistant is acted on once: a later update for it doesn't take back a period paid since -----
  const dp = (await mockPost(`/__charges/${renew1.invoice.charge}/dispute`, { status: "needs_response" })).dispute;
  let ar = await aRow();
  assert.ok(ar.unpaid_since, "the chargeback takes the period back");
  assert.deepEqual(ar.chargeback_dispute_ids, [dp.id], "and is written down as acted on");
  await mockPost(`/__subscriptions/${sub2}/renew`, { paid: true });
  assert.equal((await aRow()).unpaid_since, null, "paid again");
  await mockPost(`/__disputes/${dp.id}/update`, { status: "under_review" });
  assert.equal((await aRow()).unpaid_since, null, "the dispute's update takes nothing back again");
  await mockPost(`/__disputes/${dp.id}/close`, { status: "lost" });
  ar = await aRow();
  assert.equal(ar.unpaid_since, null, "nor does its loss");
  assert.equal(stripeMock.subscriptions.get(sub2).status, "canceled", "lost: the subscription is cancelled");
  console.log("an Assistant chargeback acted on once: ok");

  // ----- 8f. keys owed: past_due keeps the paid period's key (Stripe has moved the period on to the unpaid one, so nothing
  // new is signed), a key run out isn't sent, and one that ends unpaid has its key revoked -----
  const assistantOf = (keys) => keys.map((k) => keyPayload(k, "shopA", "module key")).find((x) => x.m.includes("assistant"));
  const co4 = await ok(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }));
  const paid4 = await mockPost(`/__pay/${co4.sessionId}`);
  allDelivered(paid4, "the Assistant again");
  const owed = assistantOf((await standing(installKey, "shopA")).moduleKeys);
  await mockPost(`/__subscriptions/${paid4.subscription.id}`, { status: "past_due", current_period_end: stripeMock.subscriptions.get(paid4.subscription.id).current_period_end + 30 * 86400 });
  st = await standing(installKey, "shopA");
  assert.deepEqual([assistantOf(st.moduleKeys)?.id, assistantOf(st.moduleKeys)?.u], [owed.id, owed.u], "past_due: the paid period's key, none for the unpaid one");
  // A key that ran out isn't sent (an Assistant key of 2020 stored as the newest, its subscription past_due).
  const oldPayload = { v: 1, k: "hub1", id: "OLDKEY2020", s: "shopA", n: "A Repair", m: ["assistant"], p: "m", f: "2020-01-01", u: "2020-01-31", g: 14, t: new Date().toISOString() };
  const oldBytes = Buffer.from(JSON.stringify(oldPayload), "utf8");
  const oldKey = `SB1.${oldBytes.toString("base64url")}.${crypto.sign(null, oldBytes, privateKey).toString("base64url")}`;
  await db.query(`INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key, tier, founding) VALUES ($1, $2, 'hub1', 'm', '{assistant}', '2020-01-01', '2020-01-31', 14, $3, NULL, false)`, [oldPayload.id, shopA, oldKey]);
  st = await standing(installKey, "shopA");
  assert.deepEqual(st.moduleKeys, [addonsKey], "a key past its grace isn't sent");
  await db.query(`DELETE FROM license_issues WHERE key_id = $1`, [oldPayload.id]);
  // Ended unpaid (dunning gave up): its key is revoked and not sent again.
  await mockPost(`/__subscriptions/${paid4.subscription.id}/cancel`, {});
  st = await standing(installKey, "shopA");
  assert.deepEqual(st.moduleKeys, [addonsKey], "no key for a subscription that ended unpaid");
  assert.ok(st.revokeKeyIds.includes(owed.id), "and it is named for removal");
  console.log("keys owed: ok");

  // ----- 9. a hub without the Assistant prices -----
  await stopHub();
  const closed = Object.fromEntries(Object.entries(ENV).filter(([name]) => !/^STRIPE_PRICE_ASSISTANT_/.test(name)));
  await startHub(closed);
  me = await ok(await page(a, "/me"));
  assert.equal(me.billing.assistantPrices, null);
  assert.equal(me.shops[0].assistant.canAdd, false);
  assert.equal(me.shops[0].assistant.canTopUp, false);
  await status(await page(a, `/shops/${shopA}/assistant/checkout`, { interval: "monthly" }), 503, "not for sale");
  await status(await page(a, `/shops/${shopA}/assistant/topup`, {}), 503, "extra calls not for sale");
  console.log("prices not set: ok");

  assert.ok(!/\bshk_|sk_test_asstbillmock|whsec_asstbilltest|SECRETSECRET|ASSTBILLSECRET/.test(hubLog), "the hub's log holds no install key, Stripe key, webhook secret or Anthropic key");
  console.log("all Assistant billing checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
