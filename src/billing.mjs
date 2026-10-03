// Billing on the hub (hub-accounts-billing-design.md section 3; the price list of pricing-recommendation.md section 12,
// decided 3 Oct 2026): two plans per shop through Stripe Billing, Solo (up to two people signed in, $25 a month or $250
// a year) and Shop (everyone, $45 or $450), the same features on both; the first 25 founding shops pay $15 / $30 a month
// ($150 / $300 a year) while their subscription runs without a gap over 60 days. Several Stripe prices count as one plan
// (a price rise adds new prices and the old ones keep working): each configured price id maps to a plan, an interval and
// founding or not (priceBook). A shop's standing at any moment is worked out here from what the hub holds:
//   lapsed   the admin's "Lapse now"; a refund or chargeback (a full refund of the first payment inside the trial goes
//            back to the trial instead; a chargeback the shop wins is undone); a subscription that ended; a trial or
//            waiver long over
//   active   a subscription Stripe says is paid (or cancelled but paid through the period end), or on Stripe's trial
//            (subscribed inside the hub's trial: the first charge falls when the trial ends)
//   past_due the last payment failed; 14 days' grace past the period end while Stripe retries
//   comped   the admin's "free until"
//   waived   a retail shop (StitchShop) partnered, through an ACTIVE partner link, with a repair shop in good standing
//   trial    30 days from the shop's first claim
// The program learns it from a key for the module "base" that the hub signs (src/license.mjs): the key, not the words,
// is what the program enforces. Every key issued is written down in license_issues; the current one is sent at every
// claim (so a program that lost it gets it back) and a new one is signed when the standing calls for a different plan
// or last day. Webhooks are trusted only after the object is re-read from Stripe, and each event is handled once.
// The standing also names the login plan (`plan`: solo | shop; the key carries it as `l`): a subscription's own, Shop for
// a trial, a comp and a partnered shop (so a shop can try it with its staff), and a lapsed shop keeps its last one.
import crypto from "node:crypto";
import { one, q, tx } from "./db.mjs";
import { sendMail } from "./mail.mjs";
import * as stripe from "./stripe.mjs";
import { signer as hubSigner, signKey, NO_END } from "./license.mjs";
import { checkShown, currentVersion, needsAccept, recordAcceptance } from "./terms.mjs";

export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 14;
export const WAIVER_DAYS = 35; // a waived key runs today and 34 more days, and a fresh one is signed each day the waiver holds
export const FOREVER = new Date(`${NO_END}T00:00:00Z`);
const WAIVER_GOOD = new Set(["trial", "active", "past_due", "comped"]); // the repair side's standing that waives its retail partner
const PLAN_WORDS = { m: "monthly", y: "yearly" };
const REVOKED_FOR_DAYS = 90; // how long a revoked key is still named to the program (an install that was offline)
// Stripe wants a Checkout subscription's trial_end at least 48 hours ahead; an hour more covers clocks and a slow Checkout.
const TRIAL_END_MIN_MS = 49 * 3600_000;

export const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = () => day(new Date());
const earlier = (a, b) => (a < b ? a : b);

// ----- plans and prices -----

export const TIERS = ["solo", "shop"];
export const TIER_WORDS = { solo: "Solo", shop: "Shop" };
export const SOLO_LOGINS = 2;
export const FOUNDING_LIMIT = 25;
export const FOUNDING_GAP_DAYS = 60;

/** The variable holding a plan's price ids: STRIPE_PRICE_SOLO_MONTHLY, ..., STRIPE_PRICE_SHOP_YEARLY_FOUNDING. */
export const priceVar = (tier, interval, founding) => `STRIPE_PRICE_${tier.toUpperCase()}_${interval === "y" ? "YEARLY" : "MONTHLY"}${founding ? "_FOUNDING" : ""}`;
const PRICE_VARS = TIERS.flatMap((tier) => ["m", "y"].flatMap((interval) => [false, true].map((founding) => ({ env: priceVar(tier, interval, founding), tier, interval, founding }))));
// Today's single price from before the two plans ($25, every login): still counted, as Shop, for a subscription already
// on it (never sold again; a shop that paid for every login keeps every login).
const LEGACY_VARS = [
  { env: "STRIPE_PRICE_MONTHLY", tier: "shop", interval: "m", founding: false, legacy: true },
  { env: "STRIPE_PRICE_YEARLY", tier: "shop", interval: "y", founding: false, legacy: true },
];
const idsOf = (env) => [...new Set((process.env[env] ?? "").split(",").map((s) => s.trim()).filter(Boolean))];

/**
 * Every configured price id → { tier, interval, founding, env, sold }. Each variable holds a comma-separated list: the
 * first id is the one new subscriptions get (sold), the rest are older prices that still count as that plan (a price
 * rise adds a new price in front; subscriptions on the old one keep their plan). `conflicts` names an id configured
 * as two different plans.
 */
export function priceBook() {
  const byId = new Map();
  const conflicts = [];
  for (const v of [...PRICE_VARS, ...LEGACY_VARS]) {
    idsOf(v.env).forEach((id, i) => {
      const prior = byId.get(id);
      if (!prior) return byId.set(id, { tier: v.tier, interval: v.interval, founding: v.founding, env: v.env, sold: i === 0 && !v.legacy });
      if (prior.tier !== v.tier || prior.interval !== v.interval || prior.founding !== v.founding) conflicts.push(`${id} is in both ${prior.env} and ${v.env}`);
    });
  }
  return { byId, conflicts };
}
/** The price new subscriptions get for a plan, interval (m | y) and founding or not; "" when it isn't set. */
export const priceFor = (tier, interval, founding) => idsOf(priceVar(tier, interval, founding))[0] ?? "";
/** What a price id is: { tier, interval, founding } from the configured lists, or null for an id the hub doesn't know. */
export const planOfPrice = (priceId) => (priceId ? (priceBook().byId.get(priceId) ?? null) : null);

/** Subscriptions can be sold: the Stripe key, the four plan prices and the webhook secret are set. */
export const billingOpen = () => billingProblem() === null;
/** Why they can't, for the admin page; null when billing is open. */
export function billingProblem() {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return "STRIPE_SECRET_KEY isn't set: subscriptions aren't open, and every shop runs free (a trial that ended changes nothing).";
  if (!stripe.stripeConfigured()) return "STRIPE_SECRET_KEY doesn't look like a Stripe secret key (sk_live_… or sk_test_…).";
  const missing = PRICE_VARS.filter((v) => !v.founding && !priceFor(v.tier, v.interval, false)).map((v) => v.env);
  if (missing.length) {
    const legacy = LEGACY_VARS.some((v) => idsOf(v.env).length) ? " STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY (the single price from before the two plans) still count as Shop for subscriptions already on them, but aren't sold any more." : "";
    return `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set (the Solo and Shop prices' ids from the Stripe dashboard, monthly and yearly).${legacy}`;
  }
  const { conflicts } = priceBook();
  if (conflicts.length) return `A Stripe price is configured as two plans: ${conflicts.join("; ")}. Each price id goes in one variable only.`;
  if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()) return "STRIPE_WEBHOOK_SECRET isn't set: Stripe's webhooks would be refused, so no payment would ever count.";
  return null;
}
/** The founding prices not set yet (a founding shop can't subscribe to that plan until they are), for the admin page. */
export const foundingMissing = () => PRICE_VARS.filter((v) => v.founding && !priceFor(v.tier, v.interval, true)).map((v) => v.env);

// The decided prices (pricing-recommendation.md section 12), shown until Stripe has been asked for the real amounts.
const PRICE_DEFAULTS = { solo: { m: 2500, y: 25000 }, shop: { m: 4500, y: 45000 }, soloFounding: { m: 1500, y: 15000 }, shopFounding: { m: 3000, y: 30000 } };
const PRICE_TTL_MS = 3600_000;
const priceCache = new Map(); // price id → { words, at }
const dollars = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)}`;
const priceWords = (cents, interval) => `${dollars(cents)} a ${interval === "y" ? "year" : "month"}`;

/**
 * What each plan costs, as the account page shows it: { solo: { monthly, yearly }, shop: { ... } } for founding or not.
 * The amounts are read from Stripe (each sold price, kept an hour), falling back to the decided price list.
 */
export async function priceList(founding) {
  const out = {};
  for (const tier of TIERS) {
    out[tier] = {};
    for (const interval of ["m", "y"]) {
      const id = priceFor(tier, interval, founding);
      const fallback = PRICE_DEFAULTS[founding ? `${tier}Founding` : tier][interval];
      let words = priceWords(fallback, interval);
      if (id && stripe.stripeConfigured()) {
        const hit = priceCache.get(id);
        if (hit && Date.now() - hit.at < PRICE_TTL_MS) words = hit.words;
        else {
          try {
            const p = await stripe.retrievePrice(id);
            if (Number.isInteger(p.unit_amount)) words = priceWords(p.unit_amount, p.recurring?.interval === "year" ? "y" : "m");
            priceCache.set(id, { words, at: Date.now() });
          } catch {
            /* Stripe unreachable: the decided price, and asked again next time */
          }
        }
      }
      out[tier][interval === "y" ? "yearly" : "monthly"] = id ? words : null;
    }
  }
  return out;
}

// ----- the trial at Checkout -----

/** The moment a shop's own trial ends: 30 days after its first claim (the key's last day is the day it falls on). */
const trialEndMs = (shop) => shop.created_at.getTime() + TRIAL_DAYS * 86400_000;

/**
 * When a subscription started now would first be charged, if not at once: subscribing inside the trial, the
 * subscription runs on Stripe's trial until the hub's trial ends, so the shop keeps its free days and shows as
 * subscribed. { unix, day }, or null (charged at once): less than about 48 hours of the trial left (Stripe's minimum), the
 * trial over, a shop the admin lapsed, or one whose last payment was charged back (it pays before it is back).
 */
export function trialChargeStart(shop, sub = null) {
  if (shop.lapsed_at || (sub?.disputed_at && sub?.unpaid_since)) return null;
  const end = trialEndMs(shop);
  if (end - Date.now() <= TRIAL_END_MIN_MS) return null;
  return { unix: Math.floor(end / 1000), day: day(new Date(end)) };
}

// ----- founding shops -----

const RUNNING = new Set(["active", "trialing", "past_due"]);

/**
 * Brings an account's founding mark up to date (in `client`'s transaction, or on its own): while any of its shops'
 * subscriptions runs (paid, retrying a payment, or cancelled but paid through a day still ahead) there is no gap; when
 * none does, the gap started when the last one stopped (its period end, or the day a payment was taken back), and once
 * it passes 60 days the mark goes (founding_lost_at). An account that never subscribed has no gap. Returns the
 * account's founding state: { founding, at, gapSince, lostAt, losesOn }.
 */
export async function refreshFounding(client, accountId) {
  const run = (sql, params) => (client ? client.query(sql, params) : q(sql, params));
  const a = (await run(`SELECT founding_at, founding_gap_since, founding_lost_at FROM accounts WHERE id = $1`, [accountId])).rows[0];
  if (!a) return { founding: false, at: null, gapSince: null, lostAt: null, losesOn: null };
  const state = (x) => ({
    founding: Boolean(x.founding_at),
    at: x.founding_at ?? null,
    gapSince: x.founding_gap_since ?? null,
    lostAt: x.founding_lost_at ?? null,
    losesOn: x.founding_at && x.founding_gap_since ? addDays(day(x.founding_gap_since), FOUNDING_GAP_DAYS) : null,
  });
  if (!a.founding_at) return state(a);
  const subs = (
    await run(`SELECT sub.status, sub.current_period_end, sub.unpaid_since FROM subscriptions sub JOIN shops s ON s.id = sub.shop_id WHERE s.account_id = $1 AND sub.stripe_subscription_id IS NOT NULL`, [accountId])
  ).rows;
  if (!subs.length) return state(a);
  const now = new Date();
  const running = subs.some((s) => !s.unpaid_since && (RUNNING.has(s.status) || (s.current_period_end && s.current_period_end > now)));
  if (running) {
    if (!a.founding_gap_since) return state(a);
    const r = (await run(`UPDATE accounts SET founding_gap_since = NULL WHERE id = $1 RETURNING founding_at, founding_gap_since, founding_lost_at`, [accountId])).rows[0];
    return state(r);
  }
  const ends = subs.map((s) => s.unpaid_since ?? s.current_period_end).filter(Boolean).map((d) => Math.min(d.getTime(), now.getTime()));
  const since = a.founding_gap_since ?? new Date(ends.length ? Math.max(...ends) : now.getTime());
  const lose = now.getTime() - since.getTime() > FOUNDING_GAP_DAYS * 86400_000;
  if (!lose && a.founding_gap_since) return state(a);
  const r = (
    await run(
      `UPDATE accounts SET founding_gap_since = $2, founding_at = CASE WHEN $3 THEN NULL ELSE founding_at END, founding_lost_at = CASE WHEN $3 THEN now() ELSE founding_lost_at END
       WHERE id = $1 RETURNING founding_at, founding_gap_since, founding_lost_at`,
      [accountId, since, lose],
    )
  ).rows[0];
  if (lose) console.log(`billing: account ${accountId} is no longer a founding shop (no subscription since ${day(since)}, over ${FOUNDING_GAP_DAYS} days)`);
  return state(r);
}

/** How many founding places are taken (accounts marked now), of FOUNDING_LIMIT. */
export const foundingUsed = async (client) => Number((await (client ? client.query.bind(client) : q)(`SELECT count(*)::int AS n FROM accounts WHERE founding_at IS NOT NULL`)).rows[0].n);

// ----- standing -----

const subTier = (s) => (TIERS.includes(s?.tier) ? s.tier : "shop");
const subOut = (s) =>
  s
    ? {
        id: s.stripe_subscription_id,
        plan: subTier(s),
        interval: PLAN_WORDS[s.plan] ?? null,
        founding: Boolean(s.founding),
        priceId: s.price_id ?? null,
        status: s.status,
        periodEnd: s.current_period_end ? day(s.current_period_end) : null,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        unpaidSince: s.unpaid_since ? day(s.unpaid_since) : null,
        disputedAt: s.disputed_at ? day(s.disputed_at) : null,
        // Subscribed inside the trial: Stripe's trial ends, and the first charge falls, on this day.
        trialEnd: s.status === "trialing" && s.current_period_end ? day(s.current_period_end) : null,
      }
    : null;

/** "Solo (monthly, founding price)": the plan as the standing's words name it. */
const planPhrase = (sub) => `${TIER_WORDS[subTier(sub)]} (${[PLAN_WORDS[sub.plan], sub.founding ? "founding price" : null].filter(Boolean).join(", ") || "monthly"})`;

/** A key that ends the program's standing at once (the admin's "Lapse now", a refund): a one-day window over yesterday, no grace. */
function cutKey(shop, plan, t, tier = "shop", founding = false) {
  const yesterday = addDays(t, -1);
  return { plan, f: yesterday, u: yesterday, g: 0, cut: true, tier, founding };
}

/** What a subscription row says today, or null when it says nothing yet (Checkout never finished). */
function fromSubscription(shop, sub, t) {
  const periodEnd = sub.current_period_end ? day(sub.current_period_end) : null;
  const plan = sub.plan ?? "m";
  const words = planPhrase(sub);
  // The login plan rides on every key a subscription calls for, a lapsed one too (it keeps its last plan).
  const tier = subTier(sub);
  const founding = Boolean(sub.founding);
  const key = (f, u, g = GRACE_DAYS) => ({ plan, f, u, g, tier, founding });
  if (sub.unpaid_since) {
    const d = day(sub.unpaid_since);
    return {
      standing: "lapsed",
      lastDay: d,
      message: `The payment for this shop was ${sub.disputed_at ? "disputed with the card company" : "refunded"} on ${d}, so the program is read-only. Subscribe again on your StitchHub account page to keep working.`,
      want: cutKey(shop, plan, t, tier, founding),
    };
  }
  switch (sub.status) {
    case "active":
    case "trialing":
      if (!periodEnd) return null;
      // trialing: subscribed inside the hub's trial; Stripe's trial ends with it and the first charge falls then.
      return {
        standing: "active",
        lastDay: periodEnd,
        message:
          sub.status === "trialing"
            ? sub.cancel_at_period_end
              ? `Your ${words} subscription is cancelled: the free trial runs through ${periodEnd} and nothing will be charged.`
              : `Subscribed to ${words}. The free trial runs through ${periodEnd}; the first charge is on ${periodEnd}.`
            : sub.cancel_at_period_end
              ? `Your ${words} subscription is cancelled and runs through ${periodEnd}.`
              : `Subscribed to ${words}, paid through ${periodEnd}.`,
        want: key(t, periodEnd),
      };
    case "past_due": {
      if (!periodEnd) return null;
      const graceEnd = addDays(periodEnd, GRACE_DAYS);
      if (t <= graceEnd) {
        return {
          standing: "past_due",
          lastDay: periodEnd,
          message: `The last payment for ${words} didn't go through. Update your card under Manage billing by ${graceEnd}, or the program becomes read-only.`,
          want: key(t, periodEnd),
        };
      }
      return {
        standing: "lapsed",
        lastDay: periodEnd,
        message: `The payment for the period that ended ${periodEnd} never went through; the program has been read-only since ${addDays(graceEnd, 1)}. Update your card under Manage billing to keep working.`,
        want: key(earlier(t, periodEnd), periodEnd),
      };
    }
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
    case "paused":
      if (sub.status === "canceled" && periodEnd && periodEnd >= t) {
        return { standing: "active", lastDay: periodEnd, message: `Your ${words} subscription was cancelled and runs through ${periodEnd}.`, want: key(t, periodEnd) };
      }
      return {
        standing: "lapsed",
        lastDay: periodEnd,
        message: `Your ${words} subscription ended${periodEnd ? ` on ${periodEnd}` : ""}. Subscribe again on your StitchHub account page to keep working.`,
        want: periodEnd ? key(periodEnd, periodEnd) : null,
      };
    default:
      return null; // incomplete: Checkout wasn't finished
  }
}

/** The repair shop whose ACTIVE partner link waives this retail shop, or null. "both" shops pay, so only kind retail. */
async function waiverFor(shop) {
  if (shop.kind !== "retail") return null;
  const rows = (
    await q(
      `SELECT l.id AS link_id, rs.* FROM partner_links l JOIN shops rs ON rs.install_id = l.repair_install_id AND rs.shop_ref = l.repair_shop_ref
       WHERE l.status = 'ACTIVE' AND l.retail_install_id = $1 AND l.retail_shop_ref = $2 ORDER BY l.created_at`,
      [shop.install_id, shop.shop_ref],
    )
  ).rows;
  for (const rs of rows) {
    const st = await standingOf(rs, { noWaiver: true });
    if (WAIVER_GOOD.has(st.standing)) return { shopName: rs.name, shopId: rs.id, linkId: rs.link_id };
  }
  return null;
}

/**
 * Where a shop stands today. `want` is the key the program should hold for it (null: leave what it has), `source` says
 * which rule decided, `subscription` is the row as the account page shows it, `waivedBy` the repair shop (waived, or a
 * subscriber who could cancel and stay free).
 */
export async function standingOf(shop, { noWaiver = false } = {}) {
  const t = today();
  const sub = await one(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shop.id]);
  const subState = sub ? fromSubscription(shop, sub, t) : null;
  // The login plan: Shop unless a subscription's own words say otherwise (set below for those); a lapsed shop keeps
  // its last plan, which is its subscription's when it ever had one.
  const lastTier = sub?.stripe_subscription_id ? subTier(sub) : "shop";
  const lastFounding = sub?.stripe_subscription_id ? Boolean(sub.founding) : false;
  const out = (fields) => ({ lastDay: null, waivedBy: null, plan: "shop", interval: null, founding: false, ...fields, subscription: subOut(sub) });
  const fromSub = (fields) => out({ ...fields, plan: subTier(sub), interval: PLAN_WORDS[sub.plan] ?? null, founding: Boolean(sub.founding) });
  const trialLast = day(new Date(trialEndMs(shop)));
  const trialKey = { plan: "t", f: day(shop.created_at), u: trialLast, g: GRACE_DAYS, tier: "shop" };
  // The whole first payment was refunded while the trial still ran (and not charged back): the subscription is set aside
  // and the shop is back on its trial through the trial's original last day, then a trial that ended.
  const trialRefund = Boolean(sub?.unpaid_since && sub.refunded_in_trial && !sub.disputed_at);

  // 1. The admin ended it.
  if (shop.lapsed_at) {
    const d = day(shop.lapsed_at);
    return out({
      standing: "lapsed",
      source: "admin",
      lastDay: d,
      plan: lastTier,
      founding: lastFounding,
      message: `The hub admin ended this shop's standing on ${d}, so the program is read-only. Ask the hub admin.`,
      want: cutKey(shop, "t", t, lastTier, lastFounding),
    });
  }
  // 2. A subscription that is paid, or in its grace.
  if (subState && subState.standing !== "lapsed") {
    const waiver = noWaiver ? null : await waiverFor(shop);
    const note = waiver ? ` You're partnered with ${waiver.shopName}, so this shop would be free without a subscription: you can cancel under Manage billing and stay free.` : "";
    return fromSub({ ...subState, source: "subscription", message: subState.message + note, waivedBy: waiver });
  }
  // 3. The admin's comp.
  if (shop.comp_until && shop.comp_until.getTime() > Date.now()) {
    const forever = shop.comp_until.getTime() >= FOREVER.getTime();
    const last = forever ? NO_END : day(shop.comp_until);
    return out({
      standing: "comped",
      source: "comp",
      lastDay: forever ? null : last,
      message: forever ? "Free, with the hub admin's compliments." : `Free through ${last}, with the hub admin's compliments.`,
      want: { plan: "c", f: t, u: last, g: GRACE_DAYS, tier: "shop" },
    });
  }
  // 4. Free while partnered: a retail shop whose repair shop is in good standing.
  const waiver = noWaiver ? null : await waiverFor(shop);
  if (waiver) {
    return out({
      standing: "waived",
      source: "waiver",
      waivedBy: waiver,
      message: `Free while you're partnered with ${waiver.shopName}.`,
      want: billingOpen() ? { plan: "w", f: t, u: addDays(t, WAIVER_DAYS - 1), g: GRACE_DAYS, tier: "shop" } : null,
    });
  }
  // 5. A subscription that ended (unless the trial is still running; a refund or chargeback lapses the shop even then,
  // except a full refund of the first payment inside the trial, which goes back to the trial).
  if (subState && !trialRefund && (trialLast < t || sub.unpaid_since)) return fromSub({ ...subState, source: "subscription" });
  // 6. A waiver that ended while its last key still runs: notice, then lapsed (the key the program holds does the rest).
  if (!noWaiver) {
    const w = await one(`SELECT last_day::text AS last_day FROM license_issues WHERE shop_id = $1 AND plan = 'w' AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`, [shop.id]);
    if (w && w.last_day >= t && trialLast < t) {
      return out({ standing: "trial", source: "waiver-ended", lastDay: w.last_day, message: `Your free use through a partner repair shop has ended. Subscribe by ${w.last_day} to keep working.`, want: null });
    }
  }
  // 7. The trial, running or over.
  if (trialLast >= t) {
    const message = trialRefund
      ? `The payment for this shop was refunded on ${day(sub.unpaid_since)}, so it's back on its free trial through ${trialLast}. Subscribe on your StitchHub account page to keep working after that.`
      : `Free trial through ${trialLast}.`;
    return out({ standing: "trial", source: "trial", lastDay: trialLast, message, want: billingOpen() ? trialKey : null });
  }
  if (!billingOpen()) {
    // Nobody can pay yet, so nothing lapses for want of payment: the words say so and no key is signed.
    return out({ standing: "trial", source: "trial", lastDay: trialLast, message: `The free trial ended on ${trialLast}. Subscriptions aren't open yet, so nothing changes until they are.`, want: null });
  }
  return out({ standing: "lapsed", source: "trial", lastDay: trialLast, message: `The free trial ended on ${trialLast}, so the program is read-only. Subscribe on your StitchHub account page to keep working.`, want: trialKey });
}

// ----- keys -----

const keyEnd = (last, grace) => addDays(last, grace);

/**
 * The key the program should hold for this standing: the stored one when it still fits, else a fresh one, written to
 * license_issues. Also the ids of keys revoked lately (a refund, a chargeback, "Lapse now"), for the program to drop.
 */
export async function keyFor(shop, st) {
  const t = today();
  const revokeKeyIds = (await q(`SELECT key_id FROM license_issues WHERE shop_id = $1 AND revoked_at > now() - make_interval(days => $2) ORDER BY revoked_at`, [shop.id, REVOKED_FOR_DAYS])).rows.map((r) => r.key_id);
  const { signer } = hubSigner();
  if (!signer) return { key: null, revokeKeyIds };
  const stored = await one(
    `SELECT key_id, plan, tier, founding, first_day::text AS first_day, last_day::text AS last_day, grace_days, key FROM license_issues WHERE shop_id = $1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`,
    [shop.id],
  );
  let want = st.want ? { ...st.want } : null;
  if (!want) return { key: stored?.key ?? null, revokeKeyIds };
  // The login plan is part of the key: a switch between Solo and Shop (same period) signs a new one.
  const same = () =>
    stored && stored.plan === want.plan && stored.last_day === want.u && stored.grace_days === want.g && (stored.tier ?? null) === (want.tier ?? null) && Boolean(stored.founding) === Boolean(want.founding);
  let keep;
  if (want.cut) {
    keep = Boolean(stored) && stored.plan === want.plan && keyEnd(stored.last_day, stored.grace_days) < t; // already cut short
  } else if (st.standing === "lapsed") {
    if (stored && stored.last_day < t) {
      // The program's key is past its last day (over, or in its grace): it is on its way out and is never cut shorter.
      keep = keyEnd(stored.last_day, stored.grace_days) >= keyEnd(want.u, want.g);
    } else {
      // As far as the program knows it holds a live key (a comp taken away, a waiver gone), or none at all (billing just
      // opened): its standing ended today, and the grace runs from today.
      want = { ...want, f: earlier(want.f, t), u: t };
      keep = same();
    }
  } else keep = same();
  if (keep) return { key: stored.key, revokeKeyIds };
  const made = signKey(signer, { shopId: shop.id, shopName: shop.name, plan: want.plan, firstDay: want.f, lastDay: want.u, graceDays: want.g, tier: want.tier ?? null, founding: Boolean(want.founding) });
  await q(`INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key, tier, founding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
    made.id,
    shop.id,
    signer.kid,
    want.plan,
    made.payload.m,
    want.f,
    want.u,
    want.g,
    made.key,
    want.tier ?? null,
    Boolean(want.founding),
  ]);
  return { key: made.key, revokeKeyIds };
}

/**
 * The standing part of a claim or standing answer: the words, the login plan (solo | shop; with the interval and founding
 * for a subscription), the key (which carries the plan as `l`: the program limits logins from the key alone) and the
 * revoked ids.
 */
export async function claimAnswer(shop) {
  const st = await standingOf(shop);
  const { key, revokeKeyIds } = await keyFor(shop, st);
  return { standing: st.standing, lastDay: st.lastDay, message: st.message, plan: st.plan, interval: st.interval, founding: st.founding, key, revokeKeyIds };
}

/** Every live key of a shop is revoked (the program is told to drop them at its next sync). */
export async function revokeLiveKeys(client, shopId, plans = null) {
  await client.query(
    `UPDATE license_issues SET revoked_at = now() WHERE shop_id = $1 AND revoked_at IS NULL AND last_day + grace_days >= current_date AND ($2::text[] IS NULL OR plan = ANY($2))`,
    [shopId, plans],
  );
}

// ----- routes -----

export function registerBilling({ app, acct, admin, fail, allow, clientIp, hubName, hubUrl, requireAccount, ready }) {
  const { signer, problem: signingProblem } = hubSigner();
  if (signer) console.log(`license keys: signing as kid ${signer.kid} (public x ${signer.x}; must match license-keys.ts in both programs)`);
  else console.log(`license keys: ${signingProblem}`);
  if (billingOpen() && !signer) console.error("STRIPE_SECRET_KEY is set but no signing key is: shops can pay and still get no key.");

  const stripeFail = (e) => {
    if (e instanceof stripe.StripeError) return fail(502, e.status === 401 ? "The hub's Stripe key was refused. Ask the hub admin." : `The card processor refused the request${e.code ? ` (${e.code})` : ""}. Try again in a minute.`);
    return e;
  };
  const open = () => {
    if (!billingOpen()) throw fail(503, "Subscriptions aren't open yet. Every shop is free while the hub is in its community period.");
  };

  async function customerFor(a) {
    if (a.stripe_customer_id) return a.stripe_customer_id;
    const made = await stripe.createCustomer({ email: a.email, metadata: { hub_account_id: a.id } });
    const r = await one(`UPDATE accounts SET stripe_customer_id = coalesce(stripe_customer_id, $2) WHERE id = $1 RETURNING stripe_customer_id`, [a.id, made.id]);
    return r.stripe_customer_id;
  }

  async function ownShop(c, a) {
    const shop = await one(`SELECT * FROM shops WHERE id = $1 AND account_id = $2`, [c.req.param("id"), a.id]);
    if (!shop) throw fail(404, "That shop isn't connected to your account.");
    return shop;
  }

  const intervalOf = (v) => (v === "yearly" ? "y" : v === "monthly" ? "m" : null);
  const foundingPriceMissing = (tier, interval) =>
    fail(503, `The founding price for ${TIER_WORDS[tier]}, ${PLAN_WORDS[interval]}, isn't set up on this hub yet (${priceVar(tier, interval, true)}). Ask the hub admin.`);

  // Subscribe: a Checkout Session in subscription mode for one shop, Solo or Shop, monthly or yearly, back to
  // /account/shops after. A founding account (the admin's mark, kept while its subscriptions run without a gap over 60
  // days) gets the founding price of the plan it picks; nobody else can.
  acct.post("/shops/:id/checkout", async (c) => {
    ready();
    open();
    const a = await requireAccount(c);
    if (!allow(`checkout:${a.id}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const tier = TIERS.includes(body.plan) ? body.plan : null;
    const interval = intervalOf(body.interval);
    if (!tier || !interval) throw fail(400, "Pick Solo or Shop, monthly or yearly.");
    const shop = await ownShop(c, a);
    const st = await standingOf(shop);
    if (st.source === "subscription" && st.standing !== "lapsed") throw fail(409, "This shop already has a subscription. Use Switch or Manage billing to change it.");
    const { founding } = await refreshFounding(null, a.id);
    const price = priceFor(tier, interval, founding);
    if (!price) throw foundingPriceMissing(tier, interval);
    // Inside the trial (more than about 48 hours of it left), the subscription starts on Stripe's trial ending when the
    // hub's does: nothing is charged until then, and the shop shows as subscribed meanwhile.
    const trial = trialChargeStart(shop, await one(`SELECT unpaid_since, disputed_at FROM subscriptions WHERE shop_id = $1`, [shop.id]));
    // Subscribing is agreeing to the terms (Terms, section 2): the version in force is written down with each Checkout,
    // on the account and in terms_acceptances, and goes to Stripe with the subscription's metadata. An account that
    // accepted an older version, or none, ticks the box on the page first.
    const terms = currentVersion();
    checkShown(body, fail);
    if (needsAccept(a.terms_version) && body.acceptTerms !== true) throw fail(400, "Tick the box to accept the updated terms and privacy policy first.");
    let session;
    try {
      const customer = await customerFor(a);
      session = await stripe.createSubscriptionCheckout({
        customer,
        price,
        successUrl: `${hubUrl}/account/shops?done=1`,
        cancelUrl: `${hubUrl}/account/shops?cancelled=1`,
        reference: shop.id,
        trialEnd: trial?.unix ?? null,
        metadata: { hub_shop_id: shop.id, hub_account_id: a.id, ...(terms ? { hub_terms_version: terms } : {}) },
        idempotencyKey: `checkout:${shop.id}:${crypto.randomBytes(8).toString("hex")}`,
      });
    } catch (e) {
      throw stripeFail(e);
    }
    await tx((client) => recordAcceptance(client, { accountId: a.id, version: terms, via: "checkout", shopId: shop.id, checkoutId: session.id ?? null }));
    return c.json({ ok: true, url: session.url, sessionId: session.id, firstChargeOn: trial?.day ?? null });
  });

  // "Switch to Shop" / "Switch to Solo": the subscription item moves to the other plan's price, same interval (the
  // founding price for a founding account), with Stripe's proration: the difference for the rest of the period goes on
  // the next invoice. The hub re-reads the subscription and writes it at once (the webhook that follows changes nothing
  // more), so the next sync brings the program a key for the new plan.
  acct.post("/shops/:id/switch", async (c) => {
    ready();
    open();
    const a = await requireAccount(c);
    if (!allow(`switch:${a.id}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const tier = TIERS.includes(body.plan) ? body.plan : null;
    if (!tier) throw fail(400, "Pick Solo or Shop.");
    const shop = await ownShop(c, a);
    const sub = await one(`SELECT * FROM subscriptions WHERE shop_id = $1`, [shop.id]);
    const st = await standingOf(shop);
    if (!sub?.stripe_subscription_id || st.source !== "subscription" || st.standing === "lapsed" || !RUNNING.has(sub.status)) {
      throw fail(409, "This shop has no running subscription to switch. Subscribe to the plan you want instead.");
    }
    if (subTier(sub) === tier) throw fail(409, `This shop is already on ${TIER_WORDS[tier]}.`);
    let updated;
    try {
      const s = await stripe.retrieveSubscription(sub.stripe_subscription_id);
      const item = s.items?.data?.[0];
      if (!item?.id) throw fail(502, "Stripe didn't name the subscription's item. Use Manage billing instead.");
      const itemPrice = typeof item.price === "string" ? { id: item.price } : (item.price ?? {});
      const interval = planOfPrice(itemPrice.id)?.interval ?? (itemPrice.recurring?.interval === "year" ? "y" : "m");
      const { founding } = await refreshFounding(null, a.id);
      const price = priceFor(tier, interval, founding);
      if (!price) throw foundingPriceMissing(tier, interval);
      updated = await stripe.switchSubscriptionPrice({ id: s.id, itemId: item.id, price, idempotencyKey: `switch:${shop.id}:${crypto.randomBytes(8).toString("hex")}` });
      await tx((client) => syncSubscription(client, s.id));
    } catch (e) {
      throw stripeFail(e);
    }
    console.log(`billing: shop ${shop.id} switched to ${tier} (subscription ${updated?.id ?? sub.stripe_subscription_id})`);
    return c.json({ ok: true, plan: tier, ...(await standingOf(shop).then((x) => ({ standing: x.standing, message: x.message, subscription: x.subscription }))) });
  });

  // Manage billing: the Customer Portal (change the card or plan, cancel, invoices). Per account; reached from a shop row.
  acct.post("/shops/:id/portal", async (c) => {
    ready();
    open();
    const a = await requireAccount(c);
    if (!allow(`portal:${a.id}`, 30)) throw fail(429, "Too many tries. Wait an hour.");
    await ownShop(c, a);
    if (!a.stripe_customer_id) throw fail(409, "There's no billing to manage yet: this account hasn't subscribed.");
    try {
      const session = await stripe.createPortalSession({ customer: a.stripe_customer_id, returnUrl: `${hubUrl}/account/shops` });
      return c.json({ ok: true, url: session.url });
    } catch (e) {
      throw stripeFail(e);
    }
  });

  // ----- webhooks -----

  /** Write what Stripe says about a subscription (re-read, never from the event's copy) to the shop it names. */
  async function syncSubscription(client, subId) {
    const s = await stripe.retrieveSubscription(subId);
    const shopId = s.metadata?.hub_shop_id;
    if (!shopId) return console.warn(`stripe: subscription ${subId} names no hub shop; ignored`);
    const shop = (await client.query(`SELECT s.*, a.stripe_customer_id AS account_customer FROM shops s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [shopId])).rows[0];
    if (!shop) return console.warn(`stripe: subscription ${subId} names a shop the hub doesn't have (${shopId}); ignored`);
    const customer = typeof s.customer === "string" ? s.customer : s.customer?.id;
    if (shop.account_customer && customer !== shop.account_customer) return console.warn(`stripe: subscription ${subId} isn't the shop's account's customer; ignored`);
    const price = s.items?.data?.[0]?.price;
    const priceId = typeof price === "string" ? price : (price?.id ?? null);
    // The plan from the price. A price the hub doesn't know (one made in the dashboard and not added to the variables)
    // counts as Shop, so a paying shop is never held to two logins by a missing variable; the interval is Stripe's own.
    const known = planOfPrice(priceId);
    const plan = known?.interval ?? (price?.recurring?.interval === "year" ? "y" : price?.recurring?.interval === "month" ? "m" : null);
    const tier = known?.tier ?? "shop";
    const founding = known?.founding ?? false;
    const periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000) : null;
    // A new subscription for a shop replaces the row (the old one ended, or Checkout was run twice: the admin sees both in Stripe).
    await client.query(
      `INSERT INTO subscriptions (shop_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_end, cancel_at_period_end, tier, founding, price_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (shop_id) DO UPDATE SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         tier = EXCLUDED.tier, founding = EXCLUDED.founding, price_id = EXCLUDED.price_id,
         unpaid_since = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.unpaid_since ELSE NULL END,
         disputed_at = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.disputed_at ELSE NULL END,
         unpaid_charge_id = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.unpaid_charge_id ELSE NULL END,
         refunded_in_trial = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.refunded_in_trial ELSE false END,
         mailed = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.mailed ELSE '{}'::jsonb END,
         updated_at = now()`,
      [shop.id, s.id, customer ?? null, plan, s.status, periodEnd, Boolean(s.cancel_at_period_end), tier, founding, priceId],
    );
    if (!known) console.warn(`stripe: subscription ${subId} is on a price the hub doesn't know (${priceId}); treated as Shop${plan ? "" : ", monthly"}. Add it to the STRIPE_PRICE_* variable it belongs to.`);
    // A founding account's gap starts when its last subscription stops, and ends when one runs again.
    if (shop.account_id) await refreshFounding(client, shop.account_id);
    return { shop, sub: s, periodEnd, plan };
  }

  /** The subscription an invoice or charge belongs to (by id), or null. */
  const invoiceSub = (inv) => (typeof inv?.subscription === "string" ? inv.subscription : inv?.subscription?.id ?? null);

  /** A charge as Stripe has it, with its invoice and the subscription that invoice is for; null (logged) when it isn't one. */
  async function chargeOfSubscription(chargeId) {
    const ch = await stripe.retrieveCharge(chargeId);
    const invoiceId = typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id;
    if (!invoiceId) {
      console.warn(`stripe: charge ${chargeId} isn't for an invoice; ignored`);
      return null;
    }
    const inv = await stripe.retrieveInvoice(invoiceId);
    const subId = invoiceSub(inv);
    if (!subId) {
      console.warn(`stripe: invoice ${invoiceId} isn't for a subscription; ignored`);
      return null;
    }
    return { ch, inv, subId };
  }

  /**
   * A refund or chargeback: the period is unpaid, the shop lapses at once, its subscription keys are named for removal.
   * A full refund of the subscription's first payment, made while the shop's trial still runs, sends the shop back to its
   * trial instead (standingOf: refunded_in_trial); a partial refund, a later payment or a chargeback lapses it.
   */
  async function tookBack(client, chargeId, disputed) {
    const found = await chargeOfSubscription(chargeId);
    if (!found) return;
    const { ch, inv, subId } = found;
    const row = (await client.query(`SELECT sub.shop_id, s.account_id, s.created_at FROM subscriptions sub JOIN shops s ON s.id = sub.shop_id WHERE sub.stripe_subscription_id = $1`, [subId])).rows[0];
    if (!row) return console.warn(`stripe: subscription ${subId} isn't on the hub; ignored`);
    const full = ch.refunded === true || (Number.isInteger(ch.amount) && ch.amount > 0 && ch.amount_refunded >= ch.amount);
    const trialEnd = trialEndMs(row);
    const inTrial = !disputed && full && inv.billing_reason === "subscription_create" && Date.now() < trialEnd && (!ch.created || ch.created * 1000 < trialEnd);
    // The first charge taken back is the one named (a won chargeback restores the period only when it was this charge);
    // a refund of that same charge decides whether the shop is back on its trial (the rest of a partial refund, say).
    await client.query(
      `UPDATE subscriptions SET unpaid_since = coalesce(unpaid_since, now()),
         unpaid_charge_id = CASE WHEN unpaid_since IS NULL THEN $3 ELSE unpaid_charge_id END,
         refunded_in_trial = CASE WHEN unpaid_since IS NULL OR unpaid_charge_id = $3 THEN $4 ELSE refunded_in_trial END,
         disputed_at = CASE WHEN $2 THEN coalesce(disputed_at, now()) ELSE disputed_at END, updated_at = now()
       WHERE shop_id = $1`,
      [row.shop_id, disputed, ch.id ?? chargeId, inTrial],
    );
    await revokeLiveKeys(client, row.shop_id, ["m", "y"]);
    if (inTrial) console.log(`billing: the first payment of subscription ${subId} was refunded inside the trial; shop ${row.shop_id} is back on its trial`);
    if (row.account_id) await refreshFounding(client, row.account_id);
  }

  /**
   * A chargeback the shop won (charge.dispute.closed, status won): what charge.dispute.created took away comes back. The
   * period counts again (unless a refund also took it back), the subscription is re-read from Stripe, a founding mark the
   * dispute's gap cost is given back while a place is free, and the next claim signs a fresh key (the revoked ones stay
   * revoked). Logged.
   */
  async function disputeWon(client, dp) {
    const chargeId = typeof dp.charge === "string" ? dp.charge : dp.charge?.id;
    if (!chargeId) return console.warn(`stripe: dispute ${dp.id} names no charge; ignored`);
    const found = await chargeOfSubscription(chargeId);
    if (!found) return;
    const { ch, subId } = found;
    const row = (await client.query(`SELECT sub.*, s.account_id FROM subscriptions sub JOIN shops s ON s.id = sub.shop_id WHERE sub.stripe_subscription_id = $1 FOR UPDATE OF sub`, [subId])).rows[0];
    if (!row) return console.warn(`stripe: dispute ${dp.id} was won, but subscription ${subId} isn't on the hub (the shop has subscribed again since); nothing to restore`);
    if (!row.disputed_at) return console.log(`billing: dispute ${dp.id} on charge ${chargeId} was won; shop ${row.shop_id} had nothing taken away by it`);
    if ((row.unpaid_charge_id && row.unpaid_charge_id !== chargeId) || ch.amount_refunded > 0) {
      return console.warn(`billing: dispute ${dp.id} on charge ${chargeId} was won, but shop ${row.shop_id}'s period was also taken back by a refund${row.unpaid_charge_id && row.unpaid_charge_id !== chargeId ? ` (charge ${row.unpaid_charge_id})` : ""}; left as it is`);
    }
    await client.query(`UPDATE subscriptions SET unpaid_since = NULL, unpaid_charge_id = NULL, refunded_in_trial = false, disputed_at = NULL, updated_at = now() WHERE shop_id = $1`, [row.shop_id]);
    let foundingBack = "";
    if (row.account_id) {
      // The dispute's gap may have cost the account its founding mark (disputes take weeks; the mark goes after 60 days).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('stitchhub:founding'))`);
      const acc = (await client.query(`SELECT founding_at, founding_gap_since, founding_lost_at FROM accounts WHERE id = $1 FOR UPDATE`, [row.account_id])).rows[0];
      const sinceDispute = (d) => d && d.getTime() >= row.disputed_at.getTime() - 60_000;
      if (acc && !acc.founding_at && sinceDispute(acc.founding_lost_at) && sinceDispute(acc.founding_gap_since)) {
        if ((await foundingUsed(client)) < FOUNDING_LIMIT) {
          await client.query(`UPDATE accounts SET founding_at = now(), founding_gap_since = NULL, founding_lost_at = NULL WHERE id = $1`, [row.account_id]);
          foundingBack = "; the founding mark the dispute cost is back";
        } else {
          foundingBack = `; the founding mark the dispute cost isn't given back: all ${FOUNDING_LIMIT} places are taken (the admin decides)`;
        }
      }
    }
    await syncSubscription(client, subId); // the subscription as Stripe has it now (it may have ended meanwhile)
    console.log(`billing: dispute ${dp.id} on charge ${chargeId} was won; shop ${row.shop_id}'s subscription ${subId} counts again${foundingBack}`);
  }

  async function mailAccount(shopId, kind, periodKey, subject, text) {
    const r = await one(
      `SELECT a.email, s.name, sub.mailed FROM shops s JOIN accounts a ON a.id = s.account_id JOIN subscriptions sub ON sub.shop_id = s.id WHERE s.id = $1 AND a.verified_at IS NOT NULL AND NOT a.disabled`,
      [shopId],
    );
    if (!r || r.mailed?.[kind] === periodKey) return;
    const marked = await q(`UPDATE subscriptions SET mailed = mailed || $2::jsonb WHERE shop_id = $1 AND coalesce(mailed->>$3, '') <> $4`, [shopId, JSON.stringify({ [kind]: periodKey }), kind, periodKey]);
    if (!marked.rowCount) return;
    const named = (s) => s.replace(/\{shop\}/g, r.name);
    try {
      await sendMail({ to: r.email, subject: named(subject), text: `Hello,\n\n${named(text)}\n\n${hubName}\n${hubUrl}`, fromName: hubName });
    } catch (e) {
      console.error(`billing mail (${kind}) to the owner of ${shopId}: ${e.message}`);
    }
  }
  const billingPage = `${hubUrl}/account/shops`;

  /** Handles one event; `mails` collects what to send once the transaction has committed. */
  async function handle(client, ev, mails) {
    const o = ev.data.object;
    switch (ev.type) {
      case "checkout.session.completed": {
        const s = await stripe.retrieveSession(o.id);
        const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        if (s.mode === "subscription" && subId) await syncSubscription(client, subId);
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(client, o.id);
        return;
      case "invoice.paid": {
        const inv = await stripe.retrieveInvoice(o.id);
        const subId = invoiceSub(inv);
        if (!subId) return;
        const r = await syncSubscription(client, subId);
        if (!r) return;
        // Paid: a period that was taken back, or ended by the admin, is good again.
        await client.query(`UPDATE subscriptions SET unpaid_since = NULL, unpaid_charge_id = NULL, refunded_in_trial = false, updated_at = now() WHERE shop_id = $1 AND stripe_subscription_id = $2`, [r.shop.id, subId]);
        await client.query(`UPDATE shops SET lapsed_at = NULL WHERE id = $1 AND lapsed_at IS NOT NULL`, [r.shop.id]);
        if (r.shop.account_id) await refreshFounding(client, r.shop.account_id);
        return;
      }
      case "invoice.payment_failed": {
        const inv = await stripe.retrieveInvoice(o.id);
        const subId = invoiceSub(inv);
        if (!subId) return;
        const r = await syncSubscription(client, subId);
        if (!r || !r.periodEnd) return;
        const periodEnd = day(r.periodEnd);
        mails.push(() =>
          mailAccount(
            r.shop.id,
            "failed",
            periodEnd,
            `Payment for {shop} didn't go through`,
            `The payment for {shop}'s ${hubName} subscription didn't go through. Stripe will try again over the next days. To update your card, open Manage billing on your account page:\n\n${billingPage}\n\nIf it isn't paid by ${addDays(periodEnd, GRACE_DAYS)}, the program becomes read-only until it is: you can still look at everything, finish open work and take payments.`,
          ),
        );
        return;
      }
      case "charge.refunded":
        await tookBack(client, o.id, false);
        return;
      case "charge.dispute.created":
        await tookBack(client, typeof o.charge === "string" ? o.charge : o.charge?.id, true);
        return;
      case "charge.dispute.closed": {
        // Re-read: only a dispute Stripe says was won undoes anything (lost, or an inquiry closed: what it did stands).
        const dp = await stripe.retrieveDispute(o.id);
        if (dp.status === "won") await disputeWon(client, dp);
        else console.log(`billing: dispute ${dp.id} closed (${dp.status}); nothing changes`);
        return;
      }
      default:
        return; // an event the hub doesn't act on (invoice.created, customer.updated, ...)
    }
  }

  // Stripe's webhook: the signature first, then the event is handled once (its id is written in the same transaction,
  // so a failure is retried by Stripe and a replay is a 200 that does nothing). The event's own copy of the object is
  // never trusted: each handler re-reads from Stripe by id.
  app.post("/v1/stripe", async (c) => {
    const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    if (!secret) throw fail(503, "STRIPE_WEBHOOK_SECRET isn't set on this hub.");
    if (!allow(`stripe-webhook:${clientIp(c)}`, 3000)) throw fail(429, "Too many webhooks.");
    const raw = await c.req.text();
    const ev = stripe.verifyWebhook(raw, c.req.header("stripe-signature"), secret);
    if (!ev) throw fail(400, "The webhook signature doesn't check out.");
    const mails = [];
    let done;
    try {
      done = await tx(async (client) => {
        const r = await client.query(`INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [String(ev.id).slice(0, 100), String(ev.type).slice(0, 100)]);
        if (!r.rowCount) return false;
        await handle(client, ev, mails);
        return true;
      });
    } catch (e) {
      // The object couldn't be re-read from Stripe (or isn't there): not handled, so Stripe sends the event again.
      if (e instanceof stripe.StripeError) throw fail(502, `The hub couldn't read the event's object from Stripe (${e.status || "no answer"}).`);
      throw e;
    }
    for (const send of mails) await send();
    return c.json({ ok: true, ...(done ? {} : { replay: true }) });
  });

  // ----- admin -----

  // "Lapse now": the shop's standing ends at this moment, whatever else holds, and its live keys are revoked; the program
  // is read-only from its next sync. { lapsed: false } takes it back; a comp or a payment does too.
  admin.post("/shops/:id/lapse", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const lapsed = body.lapsed !== false;
    const shop = await tx(async (client) => {
      const r = await client.query(`UPDATE shops SET lapsed_at = CASE WHEN $2 THEN coalesce(lapsed_at, now()) ELSE NULL END WHERE id = $1 RETURNING *`, [c.req.param("id"), lapsed]);
      if (!r.rowCount) throw fail(404, "No such shop.");
      if (lapsed) await revokeLiveKeys(client, r.rows[0].id);
      return r.rows[0];
    });
    return c.json({ ok: true, shop: { id: shop.id, lapsedAt: shop.lapsed_at, ...(await standingOf(shop)) } });
  });

  // The keys a shop was issued (the kid retirement allow list is made from these).
  admin.get("/shops/:id/keys", async (c) => {
    const rows = (
      await q(
        `SELECT key_id, kid, plan, tier, founding, modules, first_day::text AS first_day, last_day::text AS last_day, grace_days, issued_at, revoked_at FROM license_issues WHERE shop_id = $1 ORDER BY issued_at DESC LIMIT 200`,
        [c.req.param("id")],
      )
    ).rows;
    return c.json({
      keys: rows.map((r) => ({ keyId: r.key_id, kid: r.kid, plan: r.plan, tier: r.tier, founding: r.founding, modules: r.modules, firstDay: r.first_day, lastDay: r.last_day, graceDays: r.grace_days, issuedAt: r.issued_at, revokedAt: r.revoked_at })),
    });
  });

  // "Founding shop": the account gets the founding prices when it subscribes or switches (25 accounts at most; the
  // 26th is refused). The mark stays while the account's subscriptions run without a gap over 60 days. { founding: false }
  // takes it off (a subscription already on a founding price keeps it in Stripe until it is changed there).
  admin.post("/accounts/:id/founding", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const on = body.founding !== false;
    const out = await tx(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('stitchhub:founding'))`);
      const a = (await client.query(`SELECT id, founding_at FROM accounts WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
      if (!a) throw fail(404, "No such account.");
      if (on && !a.founding_at) {
        const used = await foundingUsed(client);
        if (used >= FOUNDING_LIMIT) throw fail(409, `All ${FOUNDING_LIMIT} founding places are taken. Take the mark off another account first.`);
        await client.query(`UPDATE accounts SET founding_at = now(), founding_gap_since = NULL, founding_lost_at = NULL WHERE id = $1`, [a.id]);
      } else if (!on && a.founding_at) {
        await client.query(`UPDATE accounts SET founding_at = NULL, founding_gap_since = NULL WHERE id = $1`, [a.id]);
      }
      return { founding: await refreshFounding(client, a.id), used: await foundingUsed(client) };
    });
    return c.json({ ok: true, founding: out.founding, foundingPlaces: { used: out.used, limit: FOUNDING_LIMIT } });
  });

  // ----- dunning mail, once per period: 7 days into grace, the day it lapses, 30 days before a yearly renewal -----

  async function dunningSweep() {
    if (!billingOpen()) return;
    // Founding marks: a gap that started without a webhook (a period that simply ran out) is written down, and a gap
    // over 60 days takes the mark off.
    for (const r of (await q(`SELECT id FROM accounts WHERE founding_at IS NOT NULL`)).rows) await refreshFounding(null, r.id);
    const rows = (
      await q(
        `SELECT sub.shop_id, sub.plan, sub.status, sub.current_period_end, sub.cancel_at_period_end FROM subscriptions sub JOIN shops s ON s.id = sub.shop_id JOIN accounts a ON a.id = s.account_id
         WHERE a.verified_at IS NOT NULL AND NOT a.disabled AND sub.unpaid_since IS NULL AND sub.current_period_end IS NOT NULL
           AND (sub.status = 'past_due' OR (sub.plan = 'y' AND sub.status = 'active' AND NOT sub.cancel_at_period_end AND sub.current_period_end < now() + interval '30 days'))`,
      )
    ).rows;
    const t = today();
    for (const r of rows) {
      const periodEnd = day(r.current_period_end);
      if (r.status === "past_due") {
        if (t >= addDays(periodEnd, 7)) {
          await mailAccount(r.shop_id, "grace7", periodEnd, `{shop}: a week left to update your card`, `The payment for {shop}'s ${hubName} subscription still hasn't gone through. Update your card under Manage billing by ${addDays(periodEnd, GRACE_DAYS)}, or the program becomes read-only:\n\n${billingPage}`);
        }
        if (t > addDays(periodEnd, GRACE_DAYS)) {
          await mailAccount(r.shop_id, "lapsed", periodEnd, `{shop} is read-only until its subscription is paid`, `The payment for {shop}'s ${hubName} subscription didn't go through in time, so the program is read-only: you can still look at everything, export it, finish open work and take payments. Update your card under Manage billing and it comes back at the next sync:\n\n${billingPage}`);
        }
      } else {
        await mailAccount(r.shop_id, "renew", periodEnd, `{shop}'s yearly subscription renews on ${periodEnd}`, `{shop}'s yearly ${hubName} subscription renews on ${periodEnd} and the card on file will be charged then. To change the card or the plan, or to cancel, open Manage billing on your account page:\n\n${billingPage}`);
      }
    }
  }
  const sweep = () => dunningSweep().catch((e) => console.error("billing sweep:", e.message));
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, 3600_000).unref();
}
