// Marketplace: shops list parts and accessories; another shop orders. The buyer pays the seller directly (the
// seller's payment instructions are on the invoice) and the seller enters the carrier and tracking.
// Orders are private to the buyer and the seller.
import crypto from "node:crypto";
import { pool, one, tx, feedLimit } from "./db.mjs";

const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const KINDS = new Set(["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"]);
const CONDITIONS = new Set(["NEW", "USED", "REFURB"]);
const ORIGINS = new Set(["GENUINE", "COMPATIBLE", "PRINTED"]); // who made it: the machine's maker, a compatible replacement, 3D printed
const OPEN = ["REQUESTED", "ACCEPTED", "PAID"];

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const cents = (v) => (v == null || v === "" ? null : Number(v));
// The largest money amount (in cents) and quantity taken, well inside what a database int and the app's own can hold:
// a typo of $30,000,000.00 is refused with a reason, not with "something went wrong".
const MAX_CENTS = 100_000_000;
const MAX_QTY = 1_000_000;
const money = (n, cur = "USD") => `${cur === "USD" ? "$" : ""}${(n / 100).toFixed(2)}${cur === "USD" ? "" : ` ${cur}`}`;

function contact(v, withAddress) {
  if (!v || typeof v !== "object") return null;
  const out = { name: str(v.name, 120), email: str(v.email, 200), phone: str(v.phone, 60) };
  if (withAddress) out.address = str(v.address, 500);
  return out;
}

export function trackingUrl(carrier, tracking) {
  if (!carrier || !tracking) return null;
  const t = encodeURIComponent(String(tracking).replace(/\s+/g, ""));
  const c = String(carrier).toLowerCase();
  if (c.includes("usps") || c.includes("postal")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes("fedex") || c.includes("fed ex")) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${t}`;
  return null;
}

const NO_RATING = { avg: null, count: 0 };

/**
 * Who a shop is on the marketplace: its install and, on a StitchBench that holds several companies, which company
 * (shopRef, the company's id there; '' for the whole install, as installs before per-company identity sent).
 */
export const shopKey = (installId, shopRef) => `${installId}|${shopRef ?? ""}`;

// The ratings that count towards a shop's standing: the latest one from each shop that rated it (a second install
// ordering again and again adds one rating, not one per order), none from $0 orders, which cost nothing to set up, and
// none from an install the hub admin blocked (a sock puppet's ratings go with it, as its usage counts do).
// `where` filters on r.rated_install_id and r.rated_shop_ref.
const counted = (where) =>
  `SELECT DISTINCT ON (r.rated_install_id, r.rated_shop_ref, r.by_role, r.rater_install_id, r.rater_shop_ref)
     r.rated_install_id AS id, r.rated_shop_ref AS ref, r.by_role, r.stars, r.comment, r.updated_at
   FROM order_ratings r JOIN orders o ON o.id = r.order_id AND o.unit_price_cents > 0
   LEFT JOIN installs ri ON ri.id = r.rater_install_id
   WHERE NOT coalesce(ri.blocked, false) AND ${where}
   ORDER BY r.rated_install_id, r.rated_shop_ref, r.by_role, r.rater_install_id, r.rater_shop_ref, r.updated_at DESC`;

/**
 * Ratings each shop has received: as a seller (from buyers, by_role 'buyer') and as a buyer (from sellers,
 * by_role 'seller'). `shops` is [installId, shopRef] pairs. Map shopKey -> { asSeller: {avg, count}, asBuyer: {avg, count} }.
 */
export async function reputations(shops, db = pool) {
  const keys = new Map(shops.filter(([id]) => id).map(([id, ref]) => [shopKey(id, ref), [id, ref ?? ""]]));
  const out = new Map([...keys.keys()].map((k) => [k, { asSeller: NO_RATING, asBuyer: NO_RATING }]));
  if (!keys.size) return out;
  const pairs = [...keys.values()];
  const { rows } = await db.query(
    `SELECT id, ref, by_role, round(avg(stars)::numeric, 1) AS avg, count(*)::int AS n
     FROM (${counted("(r.rated_install_id, r.rated_shop_ref) IN (SELECT * FROM unnest($1::text[], $2::text[]))")}) x GROUP BY 1, 2, 3`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  for (const r of rows) {
    const rep = out.get(shopKey(r.id, r.ref));
    const v = { avg: Number(r.avg), count: r.n };
    if (r.by_role === "buyer") rep.asSeller = v;
    else rep.asBuyer = v;
  }
  return out;
}

function listingOut(l, photos, installId, rep) {
  return {
    id: l.id,
    shopName: l.shop_name,
    sellerId: l.install_id,
    // The company on the seller's install that listed it (null from installs that don't say).
    shopRef: l.shop_ref || null,
    sellerRating: rep?.asSeller ?? NO_RATING,
    mine: l.install_id === installId,
    title: l.title,
    description: l.description,
    kind: l.kind,
    condition: l.condition,
    // Null from installs that don't say who made it.
    origin: l.origin ?? null,
    brand: l.brand,
    partNumber: l.part_number,
    xpartId: l.xpart_id,
    fits: l.fits,
    priceCents: l.price_cents,
    currency: l.currency,
    qty: l.qty,
    shippingCents: l.shipping_cents,
    shippingNote: l.shipping_note,
    shipsFrom: l.ships_from,
    // A blocked seller's listings show as paused everywhere until the hub admin lifts the block.
    status: l.seller_blocked && l.status === "ACTIVE" ? "PAUSED" : l.status,
    photos: photos.map((p) => ({ id: p.id, sortOrder: p.sort_order })),
    createdAt: l.created_at,
    updatedAt: l.updated_at,
  };
}

/** Listings with their photo ids, in the same order, as `installId` sees them. */
export async function listingsByIds(ids, installId, db = pool) {
  if (!ids.length) return [];
  const rows = (await db.query(`SELECT l.*, i.blocked AS seller_blocked FROM listings l LEFT JOIN installs i ON i.id = l.install_id WHERE l.id = ANY($1)`, [ids])).rows;
  const photos = (await db.query(`SELECT id, listing_id, sort_order FROM listing_photos WHERE listing_id = ANY($1) ORDER BY sort_order`, [ids])).rows;
  const reps = await reputations(
    rows.map((l) => [l.install_id, l.shop_ref]),
    db,
  );
  const byId = new Map(
    rows.map((l) => [l.id, listingOut(l, photos.filter((p) => p.listing_id === l.id), installId, reps.get(shopKey(l.install_id, l.shop_ref)))]),
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const ratingOut = (r) => (r ? { stars: r.stars, comment: r.comment, at: r.updated_at } : null);

function orderOut(o, events, installId, ratings, reps) {
  const shipping = o.shipping_cents;
  return {
    id: o.id,
    number: o.number,
    role: o.buyer_install_id === installId ? "buyer" : "seller",
    listingId: o.listing_id,
    item: o.item,
    sellerShop: o.seller_shop,
    buyerShop: o.buyer_shop,
    // Which company on each install (null from installs that don't say).
    sellerShopRef: o.seller_shop_ref || null,
    buyerShopRef: o.buyer_shop_ref || null,
    qty: o.qty,
    unitPriceCents: o.unit_price_cents,
    shippingCents: shipping,
    totalCents: o.qty * o.unit_price_cents + (shipping ?? 0),
    currency: o.currency,
    shipTo: o.ship_to,
    buyerNote: o.buyer_note,
    buyerContact: o.buyer_contact,
    sellerContact: o.seller_contact,
    payInstructions: o.pay_instructions,
    status: o.status,
    buyerPaidNote: o.buyer_paid_note,
    paidAt: o.paid_at,
    carrier: o.carrier,
    tracking: o.tracking,
    trackingUrl: trackingUrl(o.carrier, o.tracking),
    shippedAt: o.shipped_at,
    receivedAt: o.received_at,
    cancelReason: o.cancel_reason,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    events: events.map((e) => ({ at: e.created_at, by: e.by_role, action: e.action, note: e.note })),
    // buyer = the buyer's rating of the seller; seller = the seller's rating of the buyer
    ratings: {
      buyer: ratingOut(ratings.find((r) => r.by_role === "buyer")),
      seller: ratingOut(ratings.find((r) => r.by_role === "seller")),
    },
    sellerReputation: reps.get(shopKey(o.seller_install_id, o.seller_shop_ref))?.asSeller ?? NO_RATING,
    buyerReputation: reps.get(shopKey(o.buyer_install_id, o.buyer_shop_ref))?.asBuyer ?? NO_RATING,
  };
}

async function ordersByIds(ids, installId, db = pool) {
  if (!ids.length) return [];
  const rows = (await db.query(`SELECT * FROM orders WHERE id = ANY($1)`, [ids])).rows;
  const events = (await db.query(`SELECT * FROM order_events WHERE order_id = ANY($1) ORDER BY created_at, id`, [ids])).rows;
  const ratings = (await db.query(`SELECT * FROM order_ratings WHERE order_id = ANY($1)`, [ids])).rows;
  const reps = await reputations(
    rows.flatMap((o) => [
      [o.seller_install_id, o.seller_shop_ref],
      [o.buyer_install_id, o.buyer_shop_ref],
    ]),
    db,
  );
  const byId = new Map(
    rows.map((o) => [
      o.id,
      orderOut(
        o,
        events.filter((e) => e.order_id === o.id),
        installId,
        ratings.filter((r) => r.order_id === o.id),
        reps,
      ),
    ]),
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function registerMarket({ member, fail, newId, writeLimit, notify, feedPage }) {
  // ---------- listings ----------

  function listingFields(p, partial) {
    const f = {};
    const has = (k) => !partial || Object.prototype.hasOwnProperty.call(p, k);
    if (has("title")) {
      f.title = str(p.title, 160);
      if (!f.title) throw fail(400, "Give the listing a title.");
    }
    if (has("description")) f.description = str(p.description, 4000);
    if (!partial) {
      f.kind = KINDS.has(p.kind) ? p.kind : "PART";
      f.brand = str(p.brand, 60);
      f.part_number = str(p.partNumber, 60);
      f.xpart_id = str(p.xpartId, 40);
      f.fits = str(p.fits, 500);
      f.currency = /^[A-Z]{3}$/.test(String(p.currency ?? "")) ? p.currency : "USD";
    }
    if (has("condition")) f.condition = CONDITIONS.has(p.condition) ? p.condition : partial ? undefined : "NEW";
    // An install that doesn't send it (or sends something else) leaves it unstated, which isn't the same as genuine.
    if (has("origin")) f.origin = ORIGINS.has(p.origin) ? p.origin : partial ? undefined : null;
    if (has("priceCents")) {
      const v = cents(p.priceCents);
      if (v == null || !Number.isInteger(v) || v < 0) throw fail(400, "The price is whole cents, 0 or more.");
      if (v > MAX_CENTS) throw fail(400, "That price is too high (up to $1,000,000.00).");
      f.price_cents = v;
    }
    if (has("qty")) {
      const v = !partial && (p.qty == null || p.qty === "") ? 1 : cents(p.qty);
      if (v == null || !Number.isInteger(v) || v < 0 || (!partial && v < 1)) throw fail(400, "The quantity must be a whole number (at least 1 when listing).");
      if (v > MAX_QTY) throw fail(400, "That quantity is too high (up to 1,000,000).");
      f.qty = v;
    }
    if (has("shippingCents")) {
      const v = cents(p.shippingCents);
      if (v != null && (!Number.isInteger(v) || v < 0)) throw fail(400, "Shipping is whole cents, 0 or more (leave it empty to quote per order).");
      if (v > MAX_CENTS) throw fail(400, "That shipping cost is too high (up to $1,000,000.00).");
      f.shipping_cents = v;
    }
    if (has("shippingNote")) f.shipping_note = str(p.shippingNote, 500);
    if (has("shipsFrom")) f.ships_from = str(p.shipsFrom, 120);
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    return f;
  }

  member.post("/listings", async (c) => {
    writeLimit(c);
    const form = await c.req.parseBody({ all: true });
    let p;
    try {
      p = JSON.parse(String(form.listing ?? "{}"));
    } catch {
      throw fail(400, "The listing must be JSON.");
    }
    const f = listingFields(p, false);
    const files = [form.photo ?? []].flat().filter((x) => x instanceof File);
    if (files.length > 8) throw fail(413, "Up to 8 photos per listing.");
    for (const x of files) {
      if (!IMAGE.has(x.type)) throw fail(415, "Photos must be JPEG, PNG or WebP.");
      if (x.size > 3 * 1024 * 1024) throw fail(413, "Each photo must be under 3 MB.");
    }
    const inst = c.get("install");
    // The company listing it, on a StitchBench that holds several (installs that don't say list as the install).
    const shopRef = str(p.shopRef, 64) ?? "";
    const shopName = (shopRef && str(p.shopName, 120)) || inst.name;
    // The same listing sent again after its answer was lost: the one already made, not a second.
    const clientId = str(p.clientId, 64);
    const had = clientId && (await one(`SELECT id FROM listings WHERE install_id = $1 AND client_id = $2`, [inst.id, clientId]));
    if (had) return c.json((await listingsByIds([had.id], inst.id))[0]);
    const id = newId();
    await tx(async (client) => {
      const cols = ["id", "install_id", "shop_name", "shop_ref", "client_id", ...Object.keys(f)];
      const vals = [id, inst.id, shopName, shopRef, clientId, ...Object.values(f)];
      await client.query(`INSERT INTO listings (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
      for (const [i, x] of files.entries()) {
        await client.query(`INSERT INTO listing_photos (id, listing_id, mime, data, sort_order) VALUES ($1, $2, $3, $4, $5)`, [
          newId(),
          id,
          x.type,
          Buffer.from(await x.arrayBuffer()),
          i,
        ]);
      }
    });
    notify`🛒 ${shopName} listed **${f.title}**${f.brand ? ` (${f.brand}${f.part_number ? ` ${f.part_number}` : ""})` : ""} for ${money(f.price_cents, f.currency)}${f.qty > 1 ? ` · ${f.qty} available` : ""}`;
    return c.json((await listingsByIds([id], inst.id))[0]);
  });

  async function ownListing(client, c) {
    const l = (await client.query(`SELECT * FROM listings WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
    if (!l) throw fail(404, "That listing isn't on the hub.");
    if (l.install_id !== c.get("install").id) throw fail(403, "Only the shop that listed it can change it.");
    return l;
  }

  member.put("/listings/:id", async (c) => {
    writeLimit(c);
    const p = await c.req.json();
    const f = listingFields(p, true);
    const me = c.get("install").id;
    await tx(async (client) => {
      const l = await ownListing(client, c);
      if (l.status === "REMOVED") throw fail(409, "That listing was removed.");
      // A new quantity typed over the one the seller saw: refused when orders changed it in between, or the units
      // an accept took (or a cancel put back) would be counted again.
      if (f.qty !== undefined && p.expectedQty != null && Number(p.expectedQty) !== l.qty) {
        throw fail(409, `Orders changed how many are left on this listing (now ${l.qty}) since the page was opened. Check the quantity and save again.`);
      }
      const qty = f.qty ?? l.qty;
      let status = l.status;
      if (p.status !== undefined) {
        if (!["ACTIVE", "PAUSED"].includes(p.status)) throw fail(400, "A listing can be set to ACTIVE or PAUSED.");
        status = p.status;
      }
      if (qty === 0) status = "SOLD_OUT";
      else if (status === "SOLD_OUT") status = "ACTIVE";
      f.status = status;
      const keys = Object.keys(f);
      await client.query(
        `UPDATE listings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
        [l.id, ...keys.map((k) => f[k])],
      );
    });
    return c.json((await listingsByIds([c.req.param("id")], me))[0]);
  });

  member.delete("/listings/:id", async (c) => {
    writeLimit(c);
    await tx(async (client) => {
      const l = await ownListing(client, c);
      await client.query(`UPDATE listings SET status = 'REMOVED', updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [l.id]);
      await client.query(`DELETE FROM listing_photos WHERE listing_id = $1`, [l.id]); // a removed listing can't come back: its photos go, as a removed note's do
      // Orders still waiting on the seller can't be accepted any more: the buyer hears so now, not never.
      await declineWaiting(client, `listing_id = $1`, [l.id], "The seller took the listing down.");
    });
    return c.json({ ok: true });
  });

  member.get("/listing-photos/:id", async (c) => {
    const p = await one(`SELECT mime, data FROM listing_photos WHERE id = $1`, [c.req.param("id")]);
    if (!p) throw fail(404, "No such photo.");
    return c.body(p.data, 200, { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" });
  });

  // ---------- orders ----------

  async function addEvent(client, orderId, role, action, note) {
    await client.query(`INSERT INTO order_events (id, order_id, by_role, action, note, created_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())`, [
      newId(),
      orderId,
      role,
      action,
      note ?? null,
    ]);
  }

  member.post("/orders", async (c) => {
    writeLimit(c);
    const b = await c.req.json();
    const me = c.get("install");
    const qty = Number(b.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail(400, "Order at least 1 (up to 1,000,000).");
    const shipTo = str(b.shipTo, 500);
    if (!shipTo) throw fail(400, "Give the address to ship to.");
    // The company ordering, on a StitchBench that holds several (installs that don't say order as the install).
    const buyerRef = str(b.shopRef, 64) ?? "";
    const buyerName = (buyerRef && str(b.shopName, 120)) || me.name;
    const clientId = str(b.clientId, 64);
    let id = newId();
    await tx(async (client) => {
      const l = (await client.query(`SELECT * FROM listings WHERE id = $1 FOR UPDATE`, [String(b.listingId ?? "")])).rows[0];
      // The same order sent again after its answer was lost: the one already placed, not a second.
      const had = clientId && (await client.query(`SELECT id FROM orders WHERE buyer_install_id = $1 AND client_id = $2`, [me.id, clientId])).rows[0];
      if (had) {
        id = had.id;
        return;
      }
      if (!l || l.status === "REMOVED") throw fail(404, "That listing isn't on the hub.");
      // Both sides of an order are told apart by install, so two companies on one StitchBench can't trade here.
      if (l.install_id === me.id) {
        throw fail(409, l.shop_ref && l.shop_ref !== buyerRef ? "That listing is another company's on your own StitchBench: arrange it with them directly." : "You can't order your own listing.");
      }
      if (l.status !== "ACTIVE") throw fail(409, l.status === "SOLD_OUT" ? "That listing is sold out." : "That listing is paused right now.");
      if (qty > l.qty) throw fail(409, `Only ${l.qty} left on that listing.`);
      const seller = (await client.query(`SELECT id, name, blocked FROM installs WHERE id = $1`, [l.install_id])).rows[0];
      if (!seller) throw fail(409, "The seller isn't on the hub any more.");
      if (seller.blocked) throw fail(409, "That listing is paused right now.");
      const number = `SH-${String((await client.query(`SELECT nextval('order_number_seq') AS n`)).rows[0].n).padStart(6, "0")}`;
      await client.query(
        `INSERT INTO orders (id, number, listing_id, seller_install_id, buyer_install_id, seller_shop, buyer_shop, item, qty,
           unit_price_cents, shipping_cents, currency, ship_to, buyer_note, buyer_contact, seller_shop_ref, buyer_shop_ref, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          id,
          number,
          l.id,
          seller.id,
          me.id,
          // The listing's company when it named one; otherwise the install, as before.
          l.shop_ref ? l.shop_name : seller.name,
          buyerName,
          JSON.stringify({ title: l.title, brand: l.brand, partNumber: l.part_number, condition: l.condition, origin: l.origin ?? null }),
          qty,
          l.price_cents,
          l.shipping_cents,
          l.currency,
          shipTo,
          str(b.buyerNote, 2000),
          JSON.stringify(contact(b.buyerContact, false)),
          l.shop_ref,
          buyerRef,
          clientId,
        ],
      );
      await addEvent(client, id, "buyer", "requested", str(b.buyerNote, 2000));
    });
    return c.json((await ordersByIds([id], me.id))[0]);
  });

  member.get("/orders", async (c) => {
    const me = c.get("install").id;
    const { since, limit } = feedPage(c, 500, 1000);
    const { rows } = await pool.query(
      `SELECT id, seq FROM orders WHERE (buyer_install_id = $1 OR seller_install_id = $1) AND seq > $2 AND seq <= $4 ORDER BY seq LIMIT $3`,
      [me, since, limit, (await feedLimit()).change],
    );
    return c.json({
      orders: await ordersByIds(
        rows.map((r) => r.id),
        me,
      ),
      next: rows.length ? rows[rows.length - 1].seq : since,
      more: rows.length === limit,
    });
  });

  /**
   * One step of an order. `role` is who may do it ("buyer", "seller" or "either"), `from` the statuses it can
   * happen in, and `fn` returns the columns to change and the event to record.
   */
  function step(role, from, fn) {
    return async (c) => {
      writeLimit(c);
      const me = c.get("install").id;
      const body = await c.req.json().catch(() => ({}));
      const id = c.req.param("id");
      await tx(async (client) => {
        const o = (await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!o || (o.buyer_install_id !== me && o.seller_install_id !== me)) throw fail(404, "No such order.");
        const mine = o.buyer_install_id === me ? "buyer" : "seller";
        if (role !== "either" && mine !== role) throw fail(409, role === "seller" ? "Only the seller can do that." : "Only the buyer can do that.");
        if (from && !from.includes(o.status)) throw fail(409, `This order is ${o.status.toLowerCase()}, so that can't be done now.`);
        const { set = {}, action, note } = await fn({ o, body, client, mine });
        const keys = Object.keys(set);
        await client.query(
          `UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}, `).join("")}updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
          [id, ...keys.map((k) => set[k])],
        );
        await addEvent(client, id, mine, action, note);
      });
      return c.json((await ordersByIds([id], me))[0]);
    };
  }

  async function restock(client, o) {
    if (!o.listing_id) return;
    await client.query(
      `UPDATE listings SET qty = qty + $2, status = CASE WHEN status = 'SOLD_OUT' THEN 'ACTIVE' ELSE status END,
         updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
      [o.listing_id, o.qty],
    );
  }

  member.post(
    "/orders/:id/accept",
    step("seller", ["REQUESTED"], async ({ o, body, client }) => {
      let shipping = o.shipping_cents;
      if (body.shippingCents !== undefined && body.shippingCents !== null && body.shippingCents !== "") {
        const v = Number(body.shippingCents);
        if (!Number.isInteger(v) || v < 0 || v > MAX_CENTS) throw fail(400, "Shipping is whole cents, 0 or more (up to $1,000,000.00).");
        shipping = v;
      }
      if (shipping == null) throw fail(400, "Enter the shipping cost for this order (the listing has no flat rate).");
      if (o.listing_id) {
        const l = (await client.query(`SELECT * FROM listings WHERE id = $1 FOR UPDATE`, [o.listing_id])).rows[0];
        if (!l || l.status === "REMOVED") throw fail(409, "That listing was removed.");
        if (l.qty < o.qty) throw fail(409, `Only ${l.qty} left on the listing.`);
        const left = l.qty - o.qty;
        await client.query(`UPDATE listings SET qty = $2, status = $3, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [
          l.id,
          left,
          left === 0 ? "SOLD_OUT" : l.status,
        ]);
      }
      return {
        set: {
          status: "ACCEPTED",
          shipping_cents: shipping,
          seller_contact: JSON.stringify(contact(body.sellerContact, true)),
          pay_instructions: str(body.payInstructions, 2000),
        },
        action: "accepted",
      };
    }),
  );

  member.post(
    "/orders/:id/decline",
    step("seller", ["REQUESTED"], async ({ body }) => ({ set: { status: "DECLINED", cancel_reason: str(body.reason, 1000) }, action: "declined", note: str(body.reason, 1000) })),
  );

  member.post(
    "/orders/:id/buyer-paid",
    step("buyer", ["ACCEPTED"], async ({ body }) => ({ set: { buyer_paid_note: str(body.note, 1000) ?? "payment sent" }, action: "buyer-paid", note: str(body.note, 1000) })),
  );

  member.post(
    "/orders/:id/paid",
    step("seller", ["ACCEPTED"], async () => ({ set: { status: "PAID", paid_at: new Date() }, action: "paid" })),
  );

  member.post(
    "/orders/:id/ship",
    step("seller", ["ACCEPTED", "PAID"], async ({ body }) => {
      const carrier = str(body.carrier, 60);
      const tracking = str(body.tracking, 100);
      if (!carrier || !tracking) throw fail(400, "Enter the carrier and the tracking number.");
      return { set: { status: "SHIPPED", carrier, tracking, shipped_at: new Date() }, action: "shipped", note: `${carrier} ${tracking}` };
    }),
  );

  member.post(
    "/orders/:id/received",
    step("buyer", ["SHIPPED"], async () => ({ set: { status: "RECEIVED", received_at: new Date() }, action: "received" })),
  );

  member.post(
    "/orders/:id/cancel",
    step("either", OPEN, async ({ o, body, client }) => {
      if (o.status !== "REQUESTED") await restock(client, o);
      return { set: { status: "CANCELLED", cancel_reason: str(body.reason, 1000) }, action: "cancelled", note: str(body.reason, 1000) };
    }),
  );

  member.post(
    "/orders/:id/message",
    step("either", null, async ({ body }) => {
      const text = str(body.text, 2000);
      if (!text) throw fail(400, "Write a message.");
      return { action: "message", note: text };
    }),
  );

  // ---------- ratings ----------

  // The seller rates the buyer once the order is paid; the buyer rates the seller from then on too, and whenever the
  // seller has rated them (even on an order cancelled after), so no rating goes unanswered. Rating again replaces
  // the earlier one.
  const RATE_FROM = { buyer: ["PAID", "SHIPPED", "RECEIVED"], seller: ["PAID", "SHIPPED", "RECEIVED"] };

  member.post("/orders/:id/rate", async (c) => {
    writeLimit(c);
    const me = c.get("install").id;
    const body = await c.req.json().catch(() => ({}));
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw fail(400, "Give 1 to 5 stars.");
    const comment = str(body.comment, 1000);
    const id = c.req.param("id");
    await tx(async (client) => {
      const o = (await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!o || (o.buyer_install_id !== me && o.seller_install_id !== me)) throw fail(404, "No such order.");
      const mine = o.buyer_install_id === me ? "buyer" : "seller";
      const answering = mine === "buyer" && (await client.query(`SELECT 1 FROM order_ratings WHERE order_id = $1 AND by_role = 'seller'`, [id])).rowCount > 0;
      if (!RATE_FROM[mine].includes(o.status) && !answering) {
        throw fail(409, mine === "buyer" ? "You can rate the seller once the order is paid." : "You can rate the buyer once they've paid.");
      }
      const rated = mine === "buyer" ? o.seller_install_id : o.buyer_install_id;
      const [raterRef, ratedRef] = mine === "buyer" ? [o.buyer_shop_ref, o.seller_shop_ref] : [o.seller_shop_ref, o.buyer_shop_ref];
      const standing = async () => (rated && mine === "buyer" ? (await reputations([[rated, ratedRef ?? ""]], client)).get(shopKey(rated, ratedRef)).asSeller : null);
      const was = await standing();
      await client.query(
        `INSERT INTO order_ratings (order_id, by_role, rater_install_id, rated_install_id, stars, comment, rater_shop_ref, rated_shop_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (order_id, by_role) DO UPDATE SET stars = EXCLUDED.stars, comment = EXCLUDED.comment,
           rater_install_id = EXCLUDED.rater_install_id, rated_install_id = EXCLUDED.rated_install_id,
           rater_shop_ref = EXCLUDED.rater_shop_ref, rated_shop_ref = EXCLUDED.rated_shop_ref, updated_at = now()`,
        [id, mine, me, rated, stars, comment, raterRef ?? "", ratedRef ?? ""],
      );
      await client.query(`UPDATE orders SET updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [id]);
      await addEvent(client, id, mine, "rated", `${stars} star${stars === 1 ? "" : "s"}`);
      // The seller's rating travels with its listings to every member: they go out again only when the average or the
      // count changed. Rating again with the same stars would send every listing of the seller to every member for nothing.
      if (was) {
        const now = await standing();
        if (now.avg !== was.avg || now.count !== was.count) {
          await client.query(`UPDATE listings SET seq = nextval('change_seq') WHERE install_id = $1 AND shop_ref = $2 AND status <> 'REMOVED'`, [rated, ratedRef ?? ""]);
        }
      }
    });
    return c.json((await ordersByIds([id], me))[0]);
  });

  // A shop's standing on the marketplace (?shopRef= for one company on an install that holds several). `role` in
  // recent is the rated shop's side of that order.
  member.get("/reputation/:installId", async (c) => {
    const id = c.req.param("installId");
    const ref = str(c.req.query("shopRef"), 64) ?? "";
    const inst = await one(`SELECT id FROM installs WHERE id = $1`, [id]);
    if (!inst) throw fail(404, "No such shop on the hub.");
    const rep = (await reputations([[id, ref]])).get(shopKey(id, ref));
    const { rows } = await pool.query(
      `SELECT stars, comment, by_role, updated_at FROM (${counted("r.rated_install_id = $1 AND r.rated_shop_ref = $2")}) x ORDER BY updated_at DESC LIMIT 10`,
      [id, ref],
    );
    return c.json({
      asSeller: rep.asSeller,
      asBuyer: rep.asBuyer,
      recent: rows.map((r) => ({ stars: r.stars, comment: r.comment, role: r.by_role === "buyer" ? "seller" : "buyer", at: r.updated_at })),
    });
  });

}

/**
 * A StitchBench with one company says which it is (POST /v1/shops/claim, src/accounts.mjs): what the install listed,
 * ordered, was rated for and shared before it sent a shopRef becomes that company's, so its standing carries over.
 * Doing it again changes nothing. Returns how many listings changed hands (they go out again in the feed).
 */
export async function claimListings(client, installId, shopRef) {
  const l = await client.query(`UPDATE listings SET shop_ref = $2, seq = nextval('change_seq') WHERE install_id = $1 AND shop_ref = '' AND status <> 'REMOVED'`, [installId, shopRef]);
  await client.query(`UPDATE listings SET shop_ref = $2 WHERE install_id = $1 AND shop_ref = ''`, [installId, shopRef]);
  await client.query(`UPDATE orders SET seller_shop_ref = $2 WHERE seller_install_id = $1 AND seller_shop_ref = ''`, [installId, shopRef]);
  await client.query(`UPDATE orders SET buyer_shop_ref = $2 WHERE buyer_install_id = $1 AND buyer_shop_ref = ''`, [installId, shopRef]);
  await client.query(`UPDATE order_ratings SET rated_shop_ref = $2 WHERE rated_install_id = $1 AND rated_shop_ref = ''`, [installId, shopRef]);
  await client.query(`UPDATE order_ratings SET rater_shop_ref = $2 WHERE rater_install_id = $1 AND rater_shop_ref = ''`, [installId, shopRef]);
  await client.query(`UPDATE posts SET shop_ref = $2 WHERE install_id = $1 AND shop_ref = ''`, [installId, shopRef]);
  return l.rowCount;
}

/** Orders still waiting on the seller (`where` on orders) are declined, with the reason the buyer sees. */
async function declineWaiting(client, where, params, reason) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'DECLINED', cancel_reason = $${params.length + 1}, updated_at = now(), seq = nextval('change_seq')
     WHERE status = 'REQUESTED' AND ${where} RETURNING id`,
    [...params, reason],
  );
  for (const r of rows) {
    await client.query(`INSERT INTO order_events (id, order_id, by_role, action, note, created_at) VALUES ($1, $2, 'seller', 'declined', $3, clock_timestamp())`, [
      crypto.randomUUID().replace(/-/g, "").slice(0, 24),
      r.id,
      reason,
    ]);
  }
}

/**
 * The hub admin blocked (or unblocked) an install. Its listings go out again, so every member shows them paused (or
 * for sale again), and orders waiting on it are declined: it can't see or answer them while blocked.
 */
export async function sellerBlocked(installId, blocked) {
  await tx(async (client) => {
    await client.query(`UPDATE listings SET seq = nextval('change_seq') WHERE install_id = $1 AND status <> 'REMOVED'`, [installId]);
    // Ratings it gave stop counting (or count again) for the sellers it rated: their listings carry the average.
    await client.query(
      `UPDATE listings SET seq = nextval('change_seq') WHERE status <> 'REMOVED' AND install_id <> $1 AND (install_id, shop_ref) IN (
         SELECT rated_install_id, rated_shop_ref FROM order_ratings WHERE rater_install_id = $1 AND by_role = 'buyer')`,
      [installId],
    );
    if (blocked) await declineWaiting(client, `seller_install_id = $1`, [installId], "The hub admin paused this seller.");
  });
}
