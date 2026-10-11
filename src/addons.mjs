// Since 11 Oct 2026 every shop has the five add-ons free, for good (StitchBench docs/plans/free-software-design.md):
// addonKeysFor gives every shop what the admin's comp of everything gave (one key, plan c, all five, through 2099-12-31)
// and selling them is parked (billing.mjs PLANS_PARKED) until package 3 removes this file. The rest of this note is how
// they were sold:
//
// Selling the trade add-ons (StitchBench pricing-review-2026-10.md; migration 032): Vac Shop $10, Small Appliance Repair $5,
// Scheduling $15, Marketing $10 and Maker Shop $10 a month, yearly ten times monthly, or all five for $30 a month ($300 a
// year). Each add-on, and the bundle, is its own Stripe subscription per shop, the way the Assistant's is
// (src/assistant-billing.mjs says why it isn't an item on the base plan's): its own standing, its own refunds and
// chargebacks, and a license key for its module ids (the bundle's names all five), signed by the hub's signer, written to
// license_issues and sent with the Assistant's in the claim answer's `moduleKeys`. Buying the bundle cancels the shop's
// single add-on subscriptions at once with Stripe's proration (the unused days are a credit on the customer's next
// invoice); a single add-on isn't sold while the bundle runs. The hub admin's comp can cover the add-ons too ("everything":
// shops.comp_addons, through the comp's last day); the Assistant keeps its own comp.
//
// Variables (comma-separated lists like the plans': the first id is sold, the rest still count):
//   STRIPE_PRICE_VAC_MONTHLY, _YEARLY            $10 / $100
//   STRIPE_PRICE_APPLIANCE_MONTHLY, _YEARLY      $5 / $50
//   STRIPE_PRICE_SCHEDULING_MONTHLY, _YEARLY     $15 / $150
//   STRIPE_PRICE_MARKETING_MONTHLY, _YEARLY      $10 / $100
//   STRIPE_PRICE_MAKER_MONTHLY, _YEARLY          $10 / $100
//   STRIPE_PRICE_BUNDLE_MONTHLY, _YEARLY         $30 / $300 (all five)
//   STRIPE_PRICE_STORE_MONTHLY, _YEARLY          $25 / $250 for each store after the first, a quantity on the base plan
import { one, q } from "./db.mjs";
import * as stripe from "./stripe.mjs";
import { signer as hubSigner, signKey, NO_END } from "./license.mjs";

export const ADDON_IDS = ["vac", "appliance", "scheduling", "marketing", "maker"];
export const PRODUCTS = [...ADDON_IDS, "bundle"];
export const ADDON_GRACE_DAYS = 14;
export const RUNNING = new Set(["trialing", "active", "past_due"]);
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
export const LABELS = { vac: "Vac Shop", appliance: "Small Appliance Repair", scheduling: "Scheduling", marketing: "Marketing", maker: "Maker Shop", bundle: "All five add-ons" };
/** The module ids a product's key names. */
export const modulesOf = (product) => (product === "bundle" ? [...ADDON_IDS] : [product]);
// The decided prices (cents a month; a year is ten months), shown until Stripe has been asked for the real amounts.
const MONTHLY_CENTS = { vac: 1000, appliance: 500, scheduling: 1500, marketing: 1000, maker: 1000, bundle: 3000, store: 2500 };
// A shop holds at most this many single add-ons (four cost as much as the bundle or more anyway); the program takes eight
// module keys (billing.mjs MAX_MODULE_KEYS), room for the Assistant's, the singles, the bundle and the comp's.
export const MAX_SINGLES = 4;

const idsOf = (env) => [...new Set((process.env[env] ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
export const addonVar = (product, interval) => `STRIPE_PRICE_${product.toUpperCase()}_${interval === "y" ? "YEARLY" : "MONTHLY"}`;

/** The price new purchases get for a product (or "store") and interval (m | y); "" when its variable isn't set. */
export const addonPriceFor = (product, interval) => idsOf(addonVar(product, interval))[0] ?? "";
/** Every configured add-on and store price id → { product, interval, sold }. */
export function addonPriceBook() {
  const byId = new Map();
  for (const product of [...PRODUCTS, "store"]) for (const interval of ["m", "y"]) idsOf(addonVar(product, interval)).forEach((id, i) => byId.has(id) || byId.set(id, { product, interval, sold: i === 0 }));
  return byId;
}
/** The products that can be bought (both prices set). */
export const addonsForSale = () => PRODUCTS.filter((p) => addonPriceFor(p, "m") && addonPriceFor(p, "y"));
/** Extra stores can be billed (both store prices set). */
export const storesForSale = () => Boolean(addonPriceFor("store", "m") && addonPriceFor("store", "y"));
/** What's missing, for the admin page; null when everything is set. */
export function addonProblem() {
  const missing = [...PRODUCTS, "store"].flatMap((p) => ["m", "y"].filter((i) => !addonPriceFor(p, i)).map((i) => addonVar(p, i)));
  return missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set: what they price isn't sold on this hub.` : null;
}

const PRICE_TTL_MS = 3600_000;
const priceCache = new Map();
const dollars = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)}`;
async function words(id, cents, interval) {
  let w = `${dollars(cents)} a ${interval === "y" ? "year" : "month"}`;
  if (id && stripe.stripeConfigured()) {
    const hit = priceCache.get(id);
    if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.words;
    try {
      const p = await stripe.retrievePrice(id);
      if (Number.isInteger(p.unit_amount)) w = `${dollars(p.unit_amount)} a ${p.recurring?.interval === "year" ? "year" : "month"}`;
      priceCache.set(id, { words: w, at: Date.now() });
    } catch {
      /* Stripe unreachable: the decided price, asked again next time */
    }
  }
  return w;
}
/** What each add-on (and an extra store) costs, in words for the account page; a product whose prices aren't set is left out. */
export async function addonPriceList() {
  const out = {};
  for (const product of [...PRODUCTS, "store"]) {
    const m = addonPriceFor(product, "m");
    const y = addonPriceFor(product, "y");
    if (!m || !y) continue;
    out[product] = { label: product === "store" ? "Each extra store" : LABELS[product], monthly: await words(m, MONTHLY_CENTS[product], "m"), yearly: await words(y, MONTHLY_CENTS[product] * 10, "y") };
  }
  return out;
}

const priceIdOf = (item) => (typeof item?.price === "string" ? item.price : (item?.price?.id ?? null));

/** The add-on product a Stripe subscription is for (its metadata, else its price), or null when it isn't an add-on's. */
export function addonProductOf(s) {
  if (s?.metadata?.hub_product === "addon" && PRODUCTS.includes(s.metadata.hub_addon)) return s.metadata.hub_addon;
  const known = addonPriceBook().get(priceIdOf(s?.items?.data?.[0]));
  return known && known.product !== "store" ? known.product : null;
}
export const isAddonSub = (s) => addonProductOf(s) !== null;

/** Writes what Stripe says about an add-on subscription (re-read by the caller) to its shop and product. Returns the row or null. */
export async function syncAddonSub(client, s) {
  const product = addonProductOf(s);
  const shopId = s.metadata?.hub_shop_id;
  if (!product || !shopId) return console.warn(`stripe: add-on subscription ${s.id} names no hub shop or product; ignored`);
  const shop = (await client.query(`SELECT s.id, a.stripe_customer_id AS account_customer FROM shops s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [shopId])).rows[0];
  if (!shop) return console.warn(`stripe: add-on subscription ${s.id} names a shop the hub doesn't have (${shopId}); ignored`);
  const customer = typeof s.customer === "string" ? s.customer : s.customer?.id;
  if (shop.account_customer && customer !== shop.account_customer) return console.warn(`stripe: add-on subscription ${s.id} isn't the shop's account's customer; ignored`);
  const stored = (await client.query(`SELECT stripe_subscription_id, status, stripe_created FROM addon_subscriptions WHERE shop_id = $1 AND product = $2 FOR UPDATE`, [shopId, product])).rows[0];
  if (stored?.stripe_subscription_id && stored.stripe_subscription_id !== s.id) {
    const storedRuns = RUNNING.has(stored.status);
    const newer = (s.created ?? 0) > Number(stored.stripe_created ?? 0);
    if (storedRuns ? !(newer && RUNNING.has(s.status)) : !(newer || RUNNING.has(s.status))) {
      return console.warn(`stripe: ${product} subscription ${s.id} (${s.status}) for shop ${shopId} ignored: the shop's is ${stored.stripe_subscription_id} (${stored.status})`);
    }
    // The older subscription's row is replaced; its id must leave the unique column first.
  }
  const priceId = priceIdOf(s.items?.data?.[0]);
  const known = priceId ? addonPriceBook().get(priceId) : null;
  const price = s.items?.data?.[0]?.price;
  const plan = known?.interval ?? (price?.recurring?.interval === "year" ? "y" : "m");
  // Paid through the period's end; a subscription cancelled at once (the bundle switch, a refund) ended when it ended.
  let periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000) : null;
  if (s.status === "canceled" && s.ended_at && periodEnd && s.ended_at * 1000 < periodEnd.getTime()) periodEnd = new Date(s.ended_at * 1000);
  // The same Stripe subscription stored under another product (a price moved in the dashboard) is moved here.
  await client.query(`DELETE FROM addon_subscriptions WHERE stripe_subscription_id = $1 AND NOT (shop_id = $2 AND product = $3)`, [s.id, shopId, product]);
  const row = (
    await client.query(
      `INSERT INTO addon_subscriptions (shop_id, product, stripe_subscription_id, stripe_customer_id, stripe_created, plan, status, current_period_end, cancel_at_period_end, price_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (shop_id, product) DO UPDATE SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_created = EXCLUDED.stripe_created,
         plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, price_id = EXCLUDED.price_id,
         unpaid_since = CASE WHEN addon_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN addon_subscriptions.unpaid_since END,
         unpaid_charge_id = CASE WHEN addon_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN addon_subscriptions.unpaid_charge_id END,
         chargeback_dispute_ids = CASE WHEN addon_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN addon_subscriptions.chargeback_dispute_ids ELSE '{}' END, updated_at = now()
       RETURNING *`,
      [shopId, product, s.id, customer ?? null, s.created ?? null, plan, s.status, periodEnd, Boolean(s.cancel_at_period_end), priceId],
    )
  ).rows[0];
  if (!known) console.warn(`stripe: ${product} subscription ${s.id} is on a price the hub doesn't know (${priceId}); treated as ${plan === "y" ? "yearly" : "monthly"}. Add it to ${addonVar(product, plan)}.`);
  // Ended unpaid (Stripe's dunning gave up on a past_due one, or marked it unpaid): its key isn't sent again.
  if (endedUnpaid(stored, s)) {
    await revokeAddonKeys(client, shopId, product);
    console.log(`billing: ${product} subscription ${s.id} of shop ${shopId} ended unpaid (${s.status}); its keys are revoked`);
  }
  return row;
}

/** A subscription that was past_due (the same one) and now ended, or that Stripe marked unpaid: its period was never paid. */
export const endedUnpaid = (stored, s) => s.status === "unpaid" || (stored?.stripe_subscription_id === s.id && stored.status === "past_due" && (s.status === "canceled" || s.status === "incomplete_expired"));

/** One add-on row's standing, as the Assistant's: active | ending | past_due | on_hold | ended | none. */
export function addonStatus(sub, t = day(new Date())) {
  if (!sub) return { status: "none", paidThrough: null };
  const paidThrough = sub.current_period_end ? day(sub.current_period_end) : null;
  let status = "ended";
  if (sub.unpaid_since) status = RUNNING.has(sub.status) ? "on_hold" : "ended";
  else if (RUNNING.has(sub.status) && paidThrough) status = sub.status === "past_due" ? "past_due" : sub.cancel_at_period_end ? "ending" : "active";
  else if (sub.status === "canceled" && paidThrough && paidThrough >= t) status = "ending";
  else if (ENDED.has(sub.status) || sub.status === "paused") status = "ended";
  else if (!paidThrough) status = "none";
  return { status, paidThrough };
}
/** Still billed by Stripe (a new Checkout for it would bill twice). */
export const stillBilled = (row, st) => st.status === "on_hold" || st.status === "active" || st.status === "past_due" || (st.status === "ending" && RUNNING.has(row?.status));

/** Every product's standing for a shop: { vac: { status, paidThrough, plan }, ..., bundle: {...} } and the rows. */
export async function addonStandings(shopId) {
  const rows = (await q(`SELECT * FROM addon_subscriptions WHERE shop_id = $1`, [shopId])).rows;
  const byProduct = new Map(rows.map((r) => [r.product, r]));
  const out = {};
  for (const p of PRODUCTS) {
    const row = byProduct.get(p) ?? null;
    out[p] = { ...addonStatus(row), plan: row?.plan ?? null, row };
  }
  return out;
}

/** The modules a shop has from its add-ons now, for the account and admin pages: all five, for every shop. */
export function modulesOn() {
  return [...ADDON_IDS];
}

const storedKey = (shopId, modules, plans) =>
  one(
    `SELECT key_id, plan, last_day::text AS last_day, grace_days, key FROM license_issues
     WHERE shop_id = $1 AND revoked_at IS NULL AND modules = $2::text[] AND plan = ANY($3) AND last_day + grace_days >= current_date
     ORDER BY issued_at DESC LIMIT 1`,
    [shopId, modules, plans],
  );

/**
 * The add-on key the program should hold: what the admin's comp of everything signed, for every shop (plan c, all five,
 * through 2099-12-31), the stored one while it is live, else a fresh one written to license_issues. Its first day is
 * yesterday, so it has started in every time zone when it arrives. The add-on subscriptions' own keys aren't sent any
 * more: this one covers every module they name, and the program drops a stored add-on key the list leaves out.
 */
export async function addonKeysFor(shop) {
  const { signer } = hubSigner();
  const stored = await storedKey(shop.id, ADDON_IDS, ["c"]);
  if (stored && stored.last_day === NO_END) return { keys: [stored.key] };
  if (!signer) return { keys: stored ? [stored.key] : [] };
  const first = day(Date.now() - 86400_000);
  const made = signKey(signer, { shopId: shop.shop_ref, shopName: shop.name, modules: [...ADDON_IDS], plan: "c", firstDay: first, lastDay: NO_END, graceDays: ADDON_GRACE_DAYS });
  await q(`INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key, tier, founding) VALUES ($1, $2, $3, 'c', $4, $5, $6, $7, $8, NULL, false)`, [
    made.id,
    shop.id,
    signer.kid,
    made.payload.m,
    first,
    NO_END,
    ADDON_GRACE_DAYS,
    made.key,
  ]);
  return { keys: [made.key] };
}

/** A product's keys (exactly its modules, paid plans) are revoked: the program drops them at its next sync. */
export const revokeAddonKeys = (client, shopId, product) =>
  client.query(`UPDATE license_issues SET revoked_at = now() WHERE shop_id = $1 AND revoked_at IS NULL AND modules = $2::text[] AND plan IN ('m', 'y')`, [shopId, modulesOf(product)]);
/**
 * The comp's add-on keys are revoked (the comp was taken away, or no longer covers the add-ons). Never the one through
 * 2099-12-31: every shop's since 11 Oct 2026, which a 1.7.x program must never lose.
 */
export const revokeCompAddonKeys = (client, shopId) =>
  client.query(`UPDATE license_issues SET revoked_at = now() WHERE shop_id = $1 AND revoked_at IS NULL AND modules = $2::text[] AND plan = 'c' AND last_day < $3::date`, [shopId, ADDON_IDS, NO_END]);

/** The add-on row a Stripe subscription id is stored under, or null. */
export const addonRowOf = async (client, subId, lock = false) =>
  (await client.query(`SELECT * FROM addon_subscriptions WHERE stripe_subscription_id = $1${lock ? " FOR UPDATE" : ""}`, [subId])).rows[0] ?? null;

/** A refund or chargeback of an add-on period's charge: the period is taken back and its keys revoked. Null when it isn't an add-on's. */
export async function addonTookBack(client, subId, chargeId) {
  const row = (
    await client.query(
      `UPDATE addon_subscriptions SET unpaid_since = coalesce(unpaid_since, now()), unpaid_charge_id = CASE WHEN unpaid_since IS NULL THEN $2 ELSE unpaid_charge_id END, updated_at = now()
       WHERE stripe_subscription_id = $1 RETURNING shop_id, product, unpaid_charge_id`,
      [subId, chargeId],
    )
  ).rows[0];
  if (!row) return null;
  await revokeAddonKeys(client, row.shop_id, row.product);
  console.log(`billing: charge ${chargeId} of ${row.product} subscription ${subId} was taken back; shop ${row.shop_id}'s ${row.product} keys are revoked`);
  return row;
}

/** The taken-back period counts again (a later payment stands, or a chargeback was won). */
export const addonPaidAgain = (client, subId) =>
  client.query(`UPDATE addon_subscriptions SET unpaid_since = NULL, unpaid_charge_id = NULL, updated_at = now() WHERE stripe_subscription_id = $1 AND unpaid_since IS NOT NULL`, [subId]);

// ----- extra stores on the base subscription -----

/** The store item on a base subscription (a price in STRIPE_PRICE_STORE_*), or null. */
export function storeItemOf(s) {
  const book = addonPriceBook();
  return (s?.items?.data ?? []).find((it) => book.get(priceIdOf(it))?.product === "store") ?? null;
}
/** The plan item of a base subscription: the first item that isn't the store item. */
export function planItemOf(s) {
  const book = addonPriceBook();
  return (s?.items?.data ?? []).find((it) => book.get(priceIdOf(it))?.product !== "store") ?? s?.items?.data?.[0] ?? null;
}
/** The extra stores a company reports: its stores less the first, 0 to 99. */
export const extraStores = (stores) => Math.max(0, Math.min(99, (Number.isInteger(stores) ? stores : 1) - 1));
