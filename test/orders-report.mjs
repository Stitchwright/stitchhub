// Checks the parts-orders report (src/orders-report.mjs, GET /v1/admin/orders/summary): the arithmetic on its own (months, the median,
// the fee figures, an empty window) and then through a hub of its own on a scratch database with orders across months, statuses and
// currencies: sums in integer cents per currency, paid orders counted in the month they were paid, an order cancelled after PAID shown
// apart, an order never paid left out of the sums, an excluded install left out, an empty month of zeros, a wrong or missing admin token refused.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/orders-report.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { lastMonths, median, summarize } from "../src/orders-report.mjs";

// ----- the arithmetic -----
assert.deepEqual(lastMonths(3, new Date("2026-01-15T00:00:00Z")), ["2025-11", "2025-12", "2026-01"], "months cross a year end");
assert.equal(median([]), 0);
assert.equal(median([5]), 5);
assert.equal(median([1, 2, 4, 9]), 3, "an even count: the floor of the middle two's mean, in whole cents");
const empty = summarize([], 2, new Date("2026-03-10T00:00:00Z"));
assert.deepEqual(empty.currencies, ["USD"]);
assert.deepEqual(empty.byMonth.map((m) => [m.month, m.currencies.USD.completed, m.currencies.USD.goodsCents, m.currencies.USD.medianOrderCents]), [["2026-02", 0, 0, 0], ["2026-03", 0, 0, 0]], "an empty month shows zeros");
const one = summarize([{ status: "PAID", currency: "USD", qty: 3, unitPriceCents: 3333, shippingCents: null, createdAt: "2026-03-01T00:00:00Z", paidAt: "2026-03-02T00:00:00Z", sellerKey: "a", buyerKey: "b" }], 1, new Date("2026-03-10T00:00:00Z"));
assert.deepEqual(one.totals.USD.ifThereHadBeenAFee, { pct3: 299, pct4: 399, pct5: 499 }, "9,999 cents of goods: 3% is 299.97, rounded down");
console.log("  ok  months, median, fee figures rounded down, an empty window of zeros");

// ----- through a hub -----
const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "orders-report-admin-token";
const JOIN = "join-orders-report";
const ROOT = path.resolve(import.meta.dirname, "..");
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Orders Report Hub" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
hub.stdout.on("data", (d) => (log += d));
hub.stderr.on("data", (d) => (log += d));
process.on("exit", () => hub.kill());
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${log}`);
  await new Promise((r) => setTimeout(r, 200));
}
const db = new pg.Pool({ connectionString: DB, max: 2 });
const get = (p, token = ADMIN) => fetch(HUB + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const register = async (name) => (await (await fetch(`${HUB}/v1/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinKey: JOIN, name }) })).json());

try {
  const X = await register("Seller X");
  const Y = await register("Buyer Y");
  const T = await register("Test shop T");
  const now = new Date();
  const at = (monthsBack, day = 5) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, day, 12));
  let n = 0;
  const order = (o) => {
    n += 1;
    return db.query(
      `INSERT INTO orders (id, number, seller_install_id, buyer_install_id, seller_shop, buyer_shop, seller_shop_ref, buyer_shop_ref, item, qty, unit_price_cents, shipping_cents, currency, status, paid_at, created_at)
       VALUES ($1, $2, $3, $4, 's', 'b', $5, $6, '{}', $7, $8, $9, $10, $11, $12, $13)`,
      [`ord${n}`, `SH-R${n}`, o.seller ?? X.installId, o.buyer ?? Y.installId, o.sref ?? "s1", o.bref ?? "b1", o.qty ?? 1, o.unit ?? 1000, o.ship ?? null, o.cur ?? "USD", o.status, o.paid ?? null, o.created ?? o.paid ?? at(0)],
    );
  };
  // this month: two completed (one with shipping), one declined, one never paid and cancelled, one cancelled after it was paid
  await order({ status: "PAID", qty: 2, unit: 1500, ship: 500, paid: at(0, 2) }); // goods 3000, total 3500
  await order({ status: "RECEIVED", qty: 1, unit: 9000, ship: 0, paid: at(0, 3), sref: "s2", bref: "b2" }); // 9000
  await order({ status: "DECLINED", created: at(0, 4) });
  await order({ status: "CANCELLED", created: at(0, 4) });
  await order({ status: "CANCELLED", qty: 1, unit: 7777, paid: at(0, 6) }); // paid, then cancelled: not completed
  await order({ status: "REQUESTED", created: at(0, 7) });
  await order({ status: "ACCEPTED", created: at(0, 8) }); // accepted, never paid: in no sum
  // two months back: one shipped, in another currency, and one paid then in a month outside the window
  await order({ status: "SHIPPED", qty: 4, unit: 250, ship: 100, cur: "CAD", paid: at(2) }); // goods 1000
  await order({ status: "PAID", qty: 1, unit: 123456, paid: at(20), created: at(20) }); // outside 12 months
  // created last month, paid this month: counted as requested last month and completed this one
  await order({ status: "PAID", qty: 1, unit: 100, paid: at(0, 9), created: at(1, 28) });
  // a test install's order, left out when named
  await order({ status: "PAID", qty: 1, unit: 50000, paid: at(0, 10), seller: T.installId });

  assert.equal((await get("/v1/admin/orders/summary", null)).status, 401, "no token");
  assert.equal((await get("/v1/admin/orders/summary", "wrong")).status, 401, "a wrong token");
  assert.equal((await get("/v1/admin/orders/summary?months=0")).status, 400);
  assert.equal((await get("/v1/admin/orders/summary?months=abc")).status, 400);

  const r = await (await get(`/v1/admin/orders/summary?months=12&excludeInstalls=${T.installId}`)).json();
  assert.equal(r.months.length, 12);
  assert.deepEqual(r.currencies, ["CAD", "USD"]);
  const m0 = r.byMonth.at(-1).currencies;
  assert.equal(m0.USD.completed, 3, "paid and received count, the order cancelled after PAID does not, the excluded install's does not");
  assert.deepEqual([m0.USD.goodsCents, m0.USD.shippingCents, m0.USD.totalCents], [3000 + 9000 + 100, 500, 3000 + 500 + 9000 + 100]);
  assert.deepEqual([m0.USD.medianOrderCents, m0.USD.largestOrderCents], [3500, 9000]);
  assert.deepEqual([m0.USD.sellers, m0.USD.buyers], [2, 2], "distinct companies (an install and its shop id): s1 and s2 sold, b1 and b2 bought");
  assert.equal(m0.USD.cancelledAfterPaid, 1);
  assert.equal(m0.USD.declined, 1);
  assert.equal(m0.USD.cancelled, 1, "cancelled before it was paid");
  assert.equal(m0.USD.requested, 7, "everything created this month, but not the one created last month nor the excluded one");
  assert.deepEqual(m0.USD.ifThereHadBeenAFee, { pct3: Math.floor(12100 * 0.03), pct4: 484, pct5: 605 });
  const m1 = r.byMonth.at(-2).currencies;
  assert.deepEqual([m1.USD.requested, m1.USD.completed, m1.USD.goodsCents], [1, 0, 0], "created last month, paid this month: requested then, completed now");
  const m2 = r.byMonth.at(-3).currencies;
  assert.deepEqual([m2.CAD.completed, m2.CAD.goodsCents, m2.CAD.shippingCents, m2.CAD.totalCents, m2.USD.completed], [1, 1000, 100, 1100, 0], "a currency is kept apart, and the other shows zeros");
  assert.equal(r.byMonth[0].currencies.USD.completed, 0, "an empty month shows zeros");
  assert.equal(r.totals.USD.goodsCents, 12100, "the order paid 20 months ago is outside the window");
  const all = JSON.stringify(r);
  for (const bad of ["Seller X", "Buyer Y", "s1", "b1", X.installId]) assert.ok(!all.includes(bad), `the report carries no ${bad}`);
  const withT = await (await get("/v1/admin/orders/summary?months=12")).json();
  assert.equal(withT.byMonth.at(-1).currencies.USD.completed, 4, "without the exclusion the test install's order counts");
  console.log("  ok  through the hub: sums per month and currency, paid-month counting, cancelled-after-paid apart, the window, exclusion, no names, admin only");
  console.log("orders-report: all ok");
} finally {
  hub.kill();
  await db.end();
}
