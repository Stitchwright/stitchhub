// Parts orders by month, for the hub admin (GET /v1/admin/orders/summary): how much the marketplace sells, so the owner can see
// whether a fee on parts sales would be worth it (docs/parts-and-marketplace.md). Built only from the orders the hub already keeps.
// Counts and sums, never a shop's name, contact, address or item. Money is integer cents, each currency apart, no conversion.
//
// Which month an order belongs to:
//  - completed (PAID, SHIPPED or RECEIVED): the UTC month it was paid (orders.paid_at); an order never paid is left out;
//  - cancelledAfterPaid: paid and then cancelled, in the month it was paid, shown apart and not counted as completed;
//  - requested, cancelled, declined: the UTC month the order was created (most were never paid, so they have no other date).
//    `cancelled` here means cancelled before it was paid.
// The "if there had been a fee" figures are plain percentages of goodsCents, rounded down to the cent; they are not a promise,
// and Stripe's own card fee would be paid on top by the buyer.

export const FEE_PERCENTS = [3, 4, 5];
const COMPLETED = new Set(["PAID", "SHIPPED", "RECEIVED"]);

const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** The last `n` UTC calendar months up to and including `now`'s, oldest first, as "YYYY-MM". */
export function lastMonths(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

/** The middle of the sorted amounts; for an even count, the whole-cent floor of the two middle ones' mean. */
export function median(sorted) {
  if (!sorted.length) return 0;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.floor((sorted[m - 1] + sorted[m]) / 2);
}

const fees = (goods) => Object.fromEntries(FEE_PERCENTS.map((p) => [`pct${p}`, Math.floor((goods * p) / 100)]));

/**
 * rows: [{ status, currency, qty, unitPriceCents, shippingCents, createdAt, paidAt, sellerKey, buyerKey }] (any order, any date).
 * Returns { months, currencies, byMonth: [{ month, currencies: { USD: {...} } }], totals: { USD: {...} } }.
 */
export function summarize(rows, months, now = new Date()) {
  const keys = lastMonths(months, now);
  const inWindow = new Set(keys);
  const cur = new Set();
  const acc = new Map(); // `${month}|${currency}` -> accumulator
  const slot = (month, currency) => {
    const k = `${month}|${currency}`;
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { requested: 0, completed: 0, cancelled: 0, declined: 0, cancelledAfterPaid: 0, goods: 0, shipping: 0, total: 0, amounts: [], sellers: new Set(), buyers: new Set() }));
    return a;
  };
  for (const r of rows) {
    const currency = String(r.currency || "USD");
    const created = r.createdAt ? monthKey(new Date(r.createdAt)) : null;
    const paid = r.paidAt ? monthKey(new Date(r.paidAt)) : null;
    if (created && inWindow.has(created)) {
      cur.add(currency);
      const a = slot(created, currency);
      a.requested += 1;
      if (r.status === "DECLINED") a.declined += 1;
      if (r.status === "CANCELLED" && !r.paidAt) a.cancelled += 1;
    }
    if (paid && inWindow.has(paid)) {
      if (COMPLETED.has(r.status)) {
        cur.add(currency);
        const a = slot(paid, currency);
        const goods = r.qty * r.unitPriceCents;
        const shipping = r.shippingCents ?? 0;
        a.completed += 1;
        a.goods += goods;
        a.shipping += shipping;
        a.total += goods + shipping;
        a.amounts.push(goods + shipping);
        a.sellers.add(r.sellerKey);
        a.buyers.add(r.buyerKey);
      } else if (r.status === "CANCELLED") {
        cur.add(currency);
        slot(paid, currency).cancelledAfterPaid += 1;
      }
    }
  }
  const currencies = cur.size ? [...cur].sort() : ["USD"]; // an empty window still shows its zeros
  const shape = (a) => {
    const sorted = [...a.amounts].sort((x, y) => x - y);
    return {
      requested: a.requested, completed: a.completed, cancelled: a.cancelled, declined: a.declined, cancelledAfterPaid: a.cancelledAfterPaid,
      goodsCents: a.goods, shippingCents: a.shipping, totalCents: a.total,
      medianOrderCents: median(sorted), largestOrderCents: sorted.length ? sorted[sorted.length - 1] : 0,
      sellers: a.sellers.size, buyers: a.buyers.size,
      ifThereHadBeenAFee: fees(a.goods),
    };
  };
  const byMonth = keys.map((month) => ({ month, currencies: Object.fromEntries(currencies.map((c) => [c, shape(acc.get(`${month}|${c}`) ?? slot(month, c))])) }));
  const totals = {};
  for (const c of currencies) {
    const t = { requested: 0, completed: 0, cancelled: 0, declined: 0, cancelledAfterPaid: 0, goods: 0, shipping: 0, total: 0, amounts: [], sellers: new Set(), buyers: new Set() };
    for (const m of keys) {
      const a = acc.get(`${m}|${c}`);
      if (!a) continue;
      for (const f of ["requested", "completed", "cancelled", "declined", "cancelledAfterPaid", "goods", "shipping", "total"]) t[f] += a[f];
      t.amounts.push(...a.amounts);
      a.sellers.forEach((s) => t.sellers.add(s));
      a.buyers.forEach((s) => t.buyers.add(s));
    }
    totals[c] = shape(t);
  }
  return { months: keys, currencies, feePercents: FEE_PERCENTS, note: "ifThereHadBeenAFee is a percentage of goodsCents, rounded down to the cent: what a fee would have brought in, not a promise. Stripe's card fee would be paid on top by the buyer.", byMonth, totals };
}
