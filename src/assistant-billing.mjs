// Selling the Assistant (StitchBench docs/plans/ai-assistant-scope.md section 4: $15 a month or $150 a year, 300 calls a month;
// 300 more for $10). The Assistant is its OWN Stripe subscription per shop, not an item added to the base plan's:
// src/billing.mjs reads one subscription per shop (the `subscriptions` row, its price id decides the login plan, a price it
// doesn't know counts as Shop, a second Checkout cancels the older one) and an extra item would have been read as the plan,
// cancelled as "older", or lapsed by a refund of the base plan. A separate subscription keeps both standings apart: the base
// plan lapsing doesn't touch the Assistant, and cancelling the Assistant doesn't touch the program. The Assistant's table
// is `assistant_subscriptions`; the key the program holds for it is a license key for the module "assistant" (the same
// signer as the base key, written to license_issues with modules = {assistant}), sent in the claim answer as `moduleKeys`.
// A top-up is a one-time Checkout (mode payment) credited once, by the webhook, to the company's month (src/assistant.mjs
// creditTopup); the Checkout session id is the primary key of assistant_topups, so a replay credits nothing more.
//
// Variables (each a comma-separated list like the base plans': the first id is sold, the rest still count):
//   STRIPE_PRICE_ASSISTANT_MONTHLY   $15 a month, recurring monthly
//   STRIPE_PRICE_ASSISTANT_YEARLY    $150 a year, recurring yearly
//   STRIPE_PRICE_ASSISTANT_TOPUP     $10, one time (ASSISTANT_TOPUP_CALLS calls, 300 by default)
import { one, q } from "./db.mjs";
import * as stripe from "./stripe.mjs";
import { signer as hubSigner, signKey } from "./license.mjs";
import { creditTopup, TOPUP_CALLS } from "./assistant.mjs";

export const ASSISTANT_GRACE_DAYS = 14;
export const RUNNING = new Set(["trialing", "active", "past_due"]);
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);

const VARS = { monthly: "STRIPE_PRICE_ASSISTANT_MONTHLY", yearly: "STRIPE_PRICE_ASSISTANT_YEARLY", topup: "STRIPE_PRICE_ASSISTANT_TOPUP" };
const idsOf = (env) => [...new Set((process.env[env] ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/** The price new Assistant purchases get ("monthly" | "yearly" | "topup"); "" when its variable isn't set. */
export const assistantPriceFor = (kind) => idsOf(VARS[kind])[0] ?? "";
/** Every configured Assistant price id: { kind, sold }. */
export function assistantPriceBook() {
  const byId = new Map();
  for (const [kind, env] of Object.entries(VARS)) idsOf(env).forEach((id, i) => byId.has(id) || byId.set(id, { kind, sold: i === 0 }));
  return byId;
}
/** What the account page may offer: the subscription needs both prices, the top-up its own. */
export const assistantOffer = () => ({ subscribe: Boolean(assistantPriceFor("monthly") && assistantPriceFor("yearly")), topup: Boolean(assistantPriceFor("topup")) });
/** Why the Assistant can't be sold yet, for the admin page; null when it can. */
export function assistantProblem() {
  const missing = Object.entries(VARS).filter(([kind]) => !assistantPriceFor(kind)).map(([, env]) => env);
  return missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set: the Assistant can't be bought for what's missing.` : null;
}

const PRICE_DEFAULTS = { monthly: [1500, "a month"], yearly: [15000, "a year"], topup: [1000, ""] };
const PRICE_TTL_MS = 3600_000;
const priceCache = new Map();
const dollars = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)}`;

/** What each Assistant purchase costs, in words for the account page ("$15 a month"), read from Stripe (kept an hour), else the decided prices; null where the price isn't set. */
export async function assistantPriceList() {
  const out = {};
  for (const kind of Object.keys(VARS)) {
    const id = assistantPriceFor(kind);
    const [cents, per] = PRICE_DEFAULTS[kind];
    let words = `${dollars(cents)}${per ? ` ${per}` : ""}`;
    if (id && stripe.stripeConfigured()) {
      const hit = priceCache.get(id);
      if (hit && Date.now() - hit.at < PRICE_TTL_MS) words = hit.words;
      else {
        try {
          const p = await stripe.retrievePrice(id);
          if (Number.isInteger(p.unit_amount)) words = `${dollars(p.unit_amount)}${p.recurring ? ` a ${p.recurring.interval === "year" ? "year" : "month"}` : ""}`;
          priceCache.set(id, { words, at: Date.now() });
        } catch {
          /* Stripe unreachable: the decided price, asked again next time */
        }
      }
    }
    out[kind] = id ? words : null;
  }
  return { ...out, topUpCalls: TOPUP_CALLS };
}

/** A subscription Stripe sent is the Assistant's: it says so in its metadata, or its price is one of the Assistant's. */
export function isAssistantSub(s) {
  if (s?.metadata?.hub_product === "assistant") return true;
  const price = s?.items?.data?.[0]?.price;
  const id = typeof price === "string" ? price : price?.id;
  const known = id ? assistantPriceBook().get(id) : null;
  return known != null && known.kind !== "topup";
}

/**
 * Writes what Stripe says about an Assistant subscription (re-read by the caller, never the event's copy) to the shop it
 * names. A late event for an older subscription than the shop's current running one is ignored. Returns the row or null.
 */
export async function syncAssistantSub(client, s) {
  const shopId = s.metadata?.hub_shop_id;
  if (!shopId) return console.warn(`stripe: Assistant subscription ${s.id} names no hub shop; ignored`);
  const shop = (await client.query(`SELECT s.id, a.stripe_customer_id AS account_customer FROM shops s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [shopId])).rows[0];
  if (!shop) return console.warn(`stripe: Assistant subscription ${s.id} names a shop the hub doesn't have (${shopId}); ignored`);
  const customer = typeof s.customer === "string" ? s.customer : s.customer?.id;
  if (shop.account_customer && customer !== shop.account_customer) return console.warn(`stripe: Assistant subscription ${s.id} isn't the shop's account's customer; ignored`);
  const stored = (await client.query(`SELECT stripe_subscription_id, status, stripe_created FROM assistant_subscriptions WHERE shop_id = $1 FOR UPDATE`, [shopId])).rows[0];
  if (stored?.stripe_subscription_id && stored.stripe_subscription_id !== s.id) {
    const storedRuns = RUNNING.has(stored.status);
    const newer = (s.created ?? 0) > Number(stored.stripe_created ?? 0);
    // The stored one stays while it runs and the incoming one is older or not running; an ended stored one is replaced by anything running or newer.
    if (storedRuns ? !(newer && RUNNING.has(s.status)) : !(newer || RUNNING.has(s.status))) {
      return console.warn(`stripe: Assistant subscription ${s.id} (${s.status}) for shop ${shopId} ignored: the shop's is ${stored.stripe_subscription_id} (${stored.status})`);
    }
  }
  const price = s.items?.data?.[0]?.price;
  const priceId = typeof price === "string" ? price : (price?.id ?? null);
  const known = priceId ? assistantPriceBook().get(priceId) : null;
  const plan = known?.kind === "yearly" ? "y" : known?.kind === "monthly" ? "m" : price?.recurring?.interval === "year" ? "y" : "m";
  const periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000) : null;
  const row = (
    await client.query(
      `INSERT INTO assistant_subscriptions (shop_id, stripe_subscription_id, stripe_customer_id, stripe_created, plan, status, current_period_end, cancel_at_period_end, price_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (shop_id) DO UPDATE SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_created = EXCLUDED.stripe_created,
         plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, price_id = EXCLUDED.price_id, updated_at = now()
       RETURNING *`,
      [shopId, s.id, customer ?? null, s.created ?? null, plan, s.status, periodEnd, Boolean(s.cancel_at_period_end), priceId],
    )
  ).rows[0];
  if (!known) console.warn(`stripe: Assistant subscription ${s.id} is on a price the hub doesn't know (${priceId}); treated as ${plan === "y" ? "yearly" : "monthly"}. Add it to STRIPE_PRICE_ASSISTANT_MONTHLY or _YEARLY.`);
  return row;
}

/**
 * The shop's Assistant standing for the account page: "active" (paid through a day), "ending" (cancelled but paid through
 * a day), "past_due" (the last payment failed), "ended", or "none".
 */
export async function assistantStanding(shopId, t = day(new Date())) {
  const sub = await one(`SELECT * FROM assistant_subscriptions WHERE shop_id = $1`, [shopId]);
  if (!sub) return { status: "none", sub: null, paidThrough: null };
  const paidThrough = sub.current_period_end ? day(sub.current_period_end) : null;
  let status = "ended";
  if (RUNNING.has(sub.status) && paidThrough) status = sub.status === "past_due" ? "past_due" : sub.cancel_at_period_end ? "ending" : "active";
  else if (sub.status === "canceled" && paidThrough && paidThrough >= t) status = "ending";
  else if (ENDED.has(sub.status) || sub.status === "paused") status = "ended";
  else if (!paidThrough) status = "none";
  return { status, sub, paidThrough };
}

/**
 * The Assistant key the program should hold: the stored one when it still fits the subscription's paid-through day, a new
 * one signed when the day changed (a renewal), nothing new for a subscription that ended (the stored key runs out on its own
 * last day plus grace). Written to license_issues with modules = {assistant}. Returns { keys: [text] or [] }.
 */
export async function assistantKeysFor(shop) {
  const { signer } = hubSigner();
  const stored = await one(
    `SELECT key_id, last_day::text AS last_day, grace_days, key FROM license_issues WHERE shop_id = $1 AND revoked_at IS NULL AND 'assistant' = ANY(modules) ORDER BY issued_at DESC LIMIT 1`,
    [shop.id],
  );
  const st = await assistantStanding(shop.id);
  const t = day(new Date());
  const running = st.paidThrough && (st.status === "active" || st.status === "ending" || st.status === "past_due");
  if (!signer || !running) return { keys: stored?.key ? [stored.key] : [] };
  const until = st.paidThrough;
  if (stored && stored.last_day === until && stored.grace_days === ASSISTANT_GRACE_DAYS) return { keys: [stored.key] };
  const first = until < t ? until : t;
  const plan = st.sub.plan === "y" ? "y" : "m";
  // The key names the company as the program does (its own id, the shop_ref the proxy checks it against in src/assistant.mjs checkKey).
  const made = signKey(signer, { shopId: shop.shop_ref, shopName: shop.name, modules: ["assistant"], plan, firstDay: first, lastDay: until, graceDays: ASSISTANT_GRACE_DAYS });
  await q(`INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key, tier, founding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, false)`, [
    made.id,
    shop.id,
    signer.kid,
    plan,
    made.payload.m,
    first,
    until,
    ASSISTANT_GRACE_DAYS,
    made.key,
  ]);
  return { keys: [made.key] };
}

/**
 * A completed Checkout for a top-up (mode payment, paid): the company's month gets TOPUP_CALLS more, once. The session is
 * re-read from Stripe by the caller. Returns true when something was credited.
 */
export async function creditTopupSession(client, session) {
  if (session.mode !== "payment" || session.metadata?.hub_product !== "assistant_topup") return false;
  if (session.payment_status !== "paid") return console.warn(`stripe: top-up session ${session.id} isn't paid (${session.payment_status}); not credited`) ?? false;
  const shopId = session.metadata?.hub_shop_id;
  const shop = shopId ? (await client.query(`SELECT s.id, s.install_id, s.shop_ref, a.stripe_customer_id AS account_customer FROM shops s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [shopId])).rows[0] : null;
  if (!shop) return console.warn(`stripe: top-up session ${session.id} names a shop the hub doesn't have (${shopId ?? "none"}); not credited`) ?? false;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (shop.account_customer && customer !== shop.account_customer) return console.warn(`stripe: top-up session ${session.id} isn't the shop's account's customer; not credited`) ?? false;
  const run = (sql, params) => client.query(sql, params);
  // The month is worked out first so the record names it; the primary key makes a second delivery a no-op.
  const credited = await creditTopup(run, shop.install_id, shop.shop_ref, 0);
  const made = await client.query(`INSERT INTO assistant_topups (stripe_session_id, shop_id, calls, month) VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_session_id) DO NOTHING`, [session.id, shop.id, TOPUP_CALLS, credited.month]);
  if (!made.rowCount) return false;
  await creditTopup(run, shop.install_id, shop.shop_ref, TOPUP_CALLS);
  console.log(`billing: ${TOPUP_CALLS} Assistant calls added to shop ${shop.id} for ${credited.month} (session ${session.id})`);
  return true;
}
