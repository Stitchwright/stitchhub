// Most used parts: each shop sends how many of each part number it used per month (counts only), and every member
// can see the community's totals, so shops know what's worth keeping on the shelf.
import { one, q, tx } from "./db.mjs";
import { key } from "./parts.mjs";

const MAX_ITEMS = 5000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
// A part shows in the community list only when this many shops reported it, so no row is one shop's own figures
// (with two, a shop could take its own numbers off and read the other's).
const MIN_SHOPS = 3;
// The windows the list can be asked for. Coarse on purpose: with any count of months allowed, two windows a month
// apart would give one month's figures away by subtraction.
const WINDOWS = [3, 6, 12, 24];
// One shop-month counts at most this much of a part toward the totals, so one shop's slip (or mischief) can't swamp
// everyone else's real numbers.
const MAX_COUNTED = 1000;

/** "YYYY-MM" for the month `back` months before the current one (UTC). */
function monthAgo(back) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
}

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const count = (v) => Number.isInteger(v) && v >= 0 && v <= 1_000_000;

export function registerUsage({ member, fail, writeLimit }) {
  member.post("/usage", async (c) => {
    writeLimit(c);
    const body = await c.req.json().catch(() => ({}));
    const month = String(body.month ?? "");
    if (!MONTH.test(month) || month > monthAgo(0) || month < monthAgo(24)) {
      throw fail(400, "Send a month as YYYY-MM: this month or up to 24 months back.");
    }
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) throw fail(400, "Send items: [{ number, brand, qty, tickets }].");
    if (items.length > MAX_ITEMS) throw fail(400, `Send at most ${MAX_ITEMS} part numbers per month.`);
    // One row per number key; the same number sent twice (different spellings) is added up.
    const rows = new Map();
    for (const it of items) {
      const number = str(it?.number, 60);
      const k = key(number);
      const qty = it?.qty ?? 0;
      const tickets = it?.tickets ?? 0;
      if (!number || !k) throw fail(400, "Each item needs a part number.");
      if (!count(qty) || !count(tickets)) throw fail(400, "qty and tickets must be whole numbers, 0 or more.");
      const r = rows.get(k);
      if (r) {
        r.qty += qty;
        r.tickets += tickets;
        // Added up, the number still has to be a sensible count (and fit the column).
        if (!count(r.qty) || !count(r.tickets)) throw fail(400, "qty and tickets add up to more than 1,000,000 for one part number.");
      } else rows.set(k, { k, number, brand: str(it?.brand, 60), qty, tickets });
    }
    const list = [...rows.values()];
    const installId = c.get("install").id;
    await tx(async (client) => {
      await client.query(`DELETE FROM part_usage WHERE install_id = $1 AND month = $2`, [installId, month]);
      for (let i = 0; i < list.length; i += 1000) {
        const b = list.slice(i, i + 1000);
        await client.query(
          `INSERT INTO part_usage (install_id, month, number_key, number, brand, qty, tickets)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[])`,
          [installId, month, b.map((r) => r.k), b.map((r) => r.number), b.map((r) => r.brand), b.map((r) => r.qty), b.map((r) => r.tickets)],
        );
      }
    });
    return c.json({ ok: true, items: list.length });
  });

  member.get("/usage/top", async (c) => {
    // The window asked for, rounded up to the next one the list offers.
    const monthsRaw = Number(c.req.query("months") ?? 12);
    const months = Number.isFinite(monthsRaw) ? (WINDOWS.find((w) => w >= monthsRaw) ?? WINDOWS[WINDOWS.length - 1]) : 12;
    const limitRaw = Number(c.req.query("limit") ?? 200);
    const limit = Number.isInteger(limitRaw) ? Math.min(1000, Math.max(1, limitRaw)) : 200;
    const brand = str(c.req.query("brand"), 60);
    const from = monthAgo(months - 1);
    const to = monthAgo(0);
    // Blocked installs don't count. With a brand, only that brand's rows (case-insensitive) count, shops included.
    const window = `
      SELECT pu.* FROM part_usage pu JOIN installs i ON i.id = pu.install_id AND NOT i.blocked
      WHERE pu.month BETWEEN $1 AND $2 AND ($3::text IS NULL OR lower(pu.brand) = lower($3))`;
    const shops = Number((await one(`SELECT count(DISTINCT install_id) AS n FROM (${window}) u`, [from, to, brand])).n);
    // Totals stay bigint (sum of int) and are turned into numbers below: cast to int they could overflow and fail.
    // The spelling and brand shown are the ones most shops use, by shops rather than rows, so one shop sending a
    // part every month can't relabel it for everyone.
    const { rows } = await q(
      `WITH u AS (${window}),
       agg AS (
         SELECT number_key, sum(least(qty, $5::int)) AS qty, sum(least(tickets, $5::int)) AS tickets, count(DISTINCT install_id)::int AS shops
         FROM u GROUP BY number_key HAVING count(DISTINCT install_id) >= $6::int
       ),
       spelling AS (
         SELECT DISTINCT ON (number_key) number_key, number, brand
         FROM (SELECT number_key, number, brand, count(DISTINCT install_id) AS shops, count(*) AS n, sum(qty) AS q FROM u GROUP BY number_key, number, brand) s
         ORDER BY number_key, shops DESC, n DESC, q DESC, number, brand
       )
       SELECT a.number_key, s.number, s.brand, a.qty, a.tickets, a.shops, x.id AS xpart_id, x.name
       FROM agg a JOIN spelling s USING (number_key)
       LEFT JOIN LATERAL (
         SELECT xp.id, xp.name FROM xpart_numbers xn JOIN xparts xp ON xp.id = xn.xpart_id AND NOT xp.deleted
         WHERE xn.number_key = a.number_key ORDER BY xp.created_at, xp.id LIMIT 1
       ) x ON true
       ORDER BY a.shops DESC, a.qty DESC, a.number_key
       LIMIT $4`,
      [from, to, brand, limit, MAX_COUNTED, MIN_SHOPS],
    );
    return c.json({
      from,
      to,
      // Fewer than the minimum means there are no rows to go with it, and saying "1 shop" would say whose figures
      // a narrow brand filter is about.
      shops: shops >= MIN_SHOPS ? shops : 0,
      items: rows.map((r) => ({
        numberKey: r.number_key,
        number: r.number,
        brand: r.brand,
        qty: Number(r.qty),
        tickets: Number(r.tickets),
        shops: r.shops,
        xpartId: r.xpart_id ?? null,
        name: r.name ?? null,
      })),
    });
  });
}
