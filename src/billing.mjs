// Billing on the hub (hub-accounts-billing-design.md section 3): $25 a month or $250 a year per shop through Stripe
// Billing. A shop's standing at any moment is worked out here from what the hub holds:
//   lapsed   the admin's "Lapse now"; a refund or chargeback; a subscription that ended; a trial or waiver long over
//   active   a subscription Stripe says is paid (or cancelled but paid through the period end)
//   past_due the last payment failed; 14 days' grace past the period end while Stripe retries
//   comped   the admin's "free until"
//   waived   a retail shop (StitchShop) partnered, through an ACTIVE partner link, with a repair shop in good standing
//   trial    30 days from the shop's first claim
// The program learns it from a key for the module "base" that the hub signs (src/license.mjs): the key, not the words,
// is what the program enforces. Every key issued is written down in license_issues; the current one is sent at every
// claim (so a program that lost it gets it back) and a new one is signed when the standing calls for a different plan
// or last day. Webhooks are trusted only after the object is re-read from Stripe, and each event is handled once.
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

export const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = () => day(new Date());
const earlier = (a, b) => (a < b ? a : b);

const prices = () => ({ m: (process.env.STRIPE_PRICE_MONTHLY ?? "").trim(), y: (process.env.STRIPE_PRICE_YEARLY ?? "").trim() });
const planOfPrice = (priceId) => (priceId && priceId === prices().m ? "m" : priceId && priceId === prices().y ? "y" : null);

/** Subscriptions can be sold: the Stripe key, both prices and the webhook secret are set. */
export const billingOpen = () => billingProblem() === null;
/** Why they can't, for the admin page; null when billing is open. */
export function billingProblem() {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return "STRIPE_SECRET_KEY isn't set: subscriptions aren't open, and every shop runs free (a trial that ended changes nothing).";
  if (!stripe.stripeConfigured()) return "STRIPE_SECRET_KEY doesn't look like a Stripe secret key (sk_live_… or sk_test_…).";
  if (!prices().m || !prices().y) return "STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY aren't both set (the two prices' ids from the Stripe dashboard).";
  if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()) return "STRIPE_WEBHOOK_SECRET isn't set: Stripe's webhooks would be refused, so no payment would ever count.";
  return null;
}

// ----- standing -----

const subOut = (s) =>
  s
    ? { id: s.stripe_subscription_id, plan: s.plan, status: s.status, periodEnd: s.current_period_end ? day(s.current_period_end) : null, cancelAtPeriodEnd: s.cancel_at_period_end, unpaidSince: s.unpaid_since ? day(s.unpaid_since) : null, disputedAt: s.disputed_at ? day(s.disputed_at) : null }
    : null;

/** A key that ends the program's standing at once (the admin's "Lapse now", a refund): a one-day window over yesterday, no grace. */
function cutKey(shop, plan, t) {
  const yesterday = addDays(t, -1);
  return { plan, f: yesterday, u: yesterday, g: 0, cut: true };
}

/** What a subscription row says today, or null when it says nothing yet (Checkout never finished). */
function fromSubscription(shop, sub, t) {
  const periodEnd = sub.current_period_end ? day(sub.current_period_end) : null;
  const plan = sub.plan ?? "m";
  const word = PLAN_WORDS[sub.plan] ?? "";
  if (sub.unpaid_since) {
    const d = day(sub.unpaid_since);
    return {
      standing: "lapsed",
      lastDay: d,
      message: `The payment for this shop was ${sub.disputed_at ? "disputed with the card company" : "refunded"} on ${d}, so the program is read-only. Subscribe again on your StitchHub account page to keep working.`,
      want: cutKey(shop, plan, t),
    };
  }
  switch (sub.status) {
    case "active":
    case "trialing":
      if (!periodEnd) return null;
      return {
        standing: "active",
        lastDay: periodEnd,
        message: sub.cancel_at_period_end ? `Your ${word} subscription is cancelled and runs through ${periodEnd}.` : `Subscribed (${word}), paid through ${periodEnd}.`,
        want: { plan, f: t, u: periodEnd, g: GRACE_DAYS },
      };
    case "past_due": {
      if (!periodEnd) return null;
      const graceEnd = addDays(periodEnd, GRACE_DAYS);
      if (t <= graceEnd) {
        return {
          standing: "past_due",
          lastDay: periodEnd,
          message: `The last payment didn't go through. Update your card under Manage billing by ${graceEnd}, or the program becomes read-only.`,
          want: { plan, f: t, u: periodEnd, g: GRACE_DAYS },
        };
      }
      return {
        standing: "lapsed",
        lastDay: periodEnd,
        message: `The payment for the period that ended ${periodEnd} never went through; the program has been read-only since ${addDays(graceEnd, 1)}. Update your card under Manage billing to keep working.`,
        want: { plan, f: earlier(t, periodEnd), u: periodEnd, g: GRACE_DAYS },
      };
    }
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
    case "paused":
      if (sub.status === "canceled" && periodEnd && periodEnd >= t) {
        return { standing: "active", lastDay: periodEnd, message: `Your subscription was cancelled and runs through ${periodEnd}.`, want: { plan, f: t, u: periodEnd, g: GRACE_DAYS } };
      }
      return {
        standing: "lapsed",
        lastDay: periodEnd,
        message: `Your subscription ended${periodEnd ? ` on ${periodEnd}` : ""}. Subscribe again on your StitchHub account page to keep working.`,
        want: periodEnd ? { plan, f: periodEnd, u: periodEnd, g: GRACE_DAYS } : null,
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
  const out = (fields) => ({ lastDay: null, waivedBy: null, ...fields, subscription: subOut(sub) });
  const trialLast = day(new Date(shop.created_at.getTime() + TRIAL_DAYS * 86400_000));
  const trialKey = { plan: "t", f: day(shop.created_at), u: trialLast, g: GRACE_DAYS };

  // 1. The admin ended it.
  if (shop.lapsed_at) {
    const d = day(shop.lapsed_at);
    return out({ standing: "lapsed", source: "admin", lastDay: d, message: `The hub admin ended this shop's standing on ${d}, so the program is read-only. Ask the hub admin.`, want: cutKey(shop, "t", t) });
  }
  // 2. A subscription that is paid, or in its grace.
  if (subState && subState.standing !== "lapsed") {
    const waiver = noWaiver ? null : await waiverFor(shop);
    const note = waiver ? ` You're partnered with ${waiver.shopName}, so this shop would be free without a subscription: you can cancel under Manage billing and stay free.` : "";
    return out({ ...subState, source: "subscription", message: subState.message + note, waivedBy: waiver });
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
      want: { plan: "c", f: t, u: last, g: GRACE_DAYS },
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
      want: billingOpen() ? { plan: "w", f: t, u: addDays(t, WAIVER_DAYS - 1), g: GRACE_DAYS } : null,
    });
  }
  // 5. A subscription that ended (unless the trial is still running; a refund or chargeback lapses the shop even then).
  if (subState && (trialLast < t || sub.unpaid_since)) return out({ ...subState, source: "subscription" });
  // 6. A waiver that ended while its last key still runs: notice, then lapsed (the key the program holds does the rest).
  if (!noWaiver) {
    const w = await one(`SELECT last_day::text AS last_day FROM license_issues WHERE shop_id = $1 AND plan = 'w' AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`, [shop.id]);
    if (w && w.last_day >= t && trialLast < t) {
      return out({ standing: "trial", source: "waiver-ended", lastDay: w.last_day, message: `Your free use through a partner repair shop has ended. Subscribe by ${w.last_day} to keep working.`, want: null });
    }
  }
  // 7. The trial, running or over.
  if (trialLast >= t) return out({ standing: "trial", source: "trial", lastDay: trialLast, message: `Free trial through ${trialLast}.`, want: billingOpen() ? trialKey : null });
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
    `SELECT key_id, plan, first_day::text AS first_day, last_day::text AS last_day, grace_days, key FROM license_issues WHERE shop_id = $1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`,
    [shop.id],
  );
  let want = st.want ? { ...st.want } : null;
  if (!want) return { key: stored?.key ?? null, revokeKeyIds };
  const same = () => stored && stored.plan === want.plan && stored.last_day === want.u && stored.grace_days === want.g;
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
  const made = signKey(signer, { shopId: shop.id, shopName: shop.name, plan: want.plan, firstDay: want.f, lastDay: want.u, graceDays: want.g });
  await q(`INSERT INTO license_issues (key_id, shop_id, kid, plan, modules, first_day, last_day, grace_days, key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    made.id,
    shop.id,
    signer.kid,
    want.plan,
    made.payload.m,
    want.f,
    want.u,
    want.g,
    made.key,
  ]);
  return { key: made.key, revokeKeyIds };
}

/** The standing part of a claim or standing answer: the words, the key and the revoked ids. */
export async function claimAnswer(shop) {
  const st = await standingOf(shop);
  const { key, revokeKeyIds } = await keyFor(shop, st);
  return { standing: st.standing, lastDay: st.lastDay, message: st.message, key, revokeKeyIds };
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

  // Subscribe: a Checkout Session in subscription mode for one shop, monthly or yearly, back to /account/shops after.
  acct.post("/shops/:id/checkout", async (c) => {
    ready();
    open();
    const a = await requireAccount(c);
    if (!allow(`checkout:${a.id}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const plan = body.plan === "yearly" ? "y" : body.plan === "monthly" ? "m" : null;
    if (!plan) throw fail(400, "Pick monthly or yearly.");
    const shop = await ownShop(c, a);
    const st = await standingOf(shop);
    if (st.source === "subscription" && st.standing !== "lapsed") throw fail(409, "This shop already has a subscription. Use Manage billing to change it.");
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
        price: prices()[plan],
        successUrl: `${hubUrl}/account/shops?done=1`,
        cancelUrl: `${hubUrl}/account/shops?cancelled=1`,
        reference: shop.id,
        metadata: { hub_shop_id: shop.id, hub_account_id: a.id, ...(terms ? { hub_terms_version: terms } : {}) },
        idempotencyKey: `checkout:${shop.id}:${crypto.randomBytes(8).toString("hex")}`,
      });
    } catch (e) {
      throw stripeFail(e);
    }
    await tx((client) => recordAcceptance(client, { accountId: a.id, version: terms, via: "checkout", shopId: shop.id, checkoutId: session.id ?? null }));
    return c.json({ ok: true, url: session.url, sessionId: session.id });
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
    const plan = planOfPrice(typeof price === "string" ? price : price?.id);
    const periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000) : null;
    // A new subscription for a shop replaces the row (the old one ended, or Checkout was run twice: the admin sees both in Stripe).
    await client.query(
      `INSERT INTO subscriptions (shop_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_end, cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop_id) DO UPDATE SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         unpaid_since = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.unpaid_since ELSE NULL END,
         disputed_at = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.disputed_at ELSE NULL END,
         mailed = CASE WHEN subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id THEN subscriptions.mailed ELSE '{}'::jsonb END,
         updated_at = now()`,
      [shop.id, s.id, customer ?? null, plan, s.status, periodEnd, Boolean(s.cancel_at_period_end)],
    );
    if (!plan) console.warn(`stripe: subscription ${subId} is on a price the hub doesn't know (${typeof price === "string" ? price : price?.id}); treated as monthly`);
    return { shop, sub: s, periodEnd, plan };
  }

  /** The subscription an invoice or charge belongs to (by id), or null. */
  const invoiceSub = (inv) => (typeof inv?.subscription === "string" ? inv.subscription : inv?.subscription?.id ?? null);

  /** A refund or chargeback: the period is unpaid, the shop lapses at once, its subscription keys are named for removal. */
  async function tookBack(client, chargeId, disputed) {
    const ch = await stripe.retrieveCharge(chargeId);
    const invoiceId = typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id;
    if (!invoiceId) return console.warn(`stripe: charge ${chargeId} isn't for an invoice; ignored`);
    const subId = invoiceSub(await stripe.retrieveInvoice(invoiceId));
    if (!subId) return console.warn(`stripe: invoice ${invoiceId} isn't for a subscription; ignored`);
    const row = (await client.query(`SELECT shop_id FROM subscriptions WHERE stripe_subscription_id = $1`, [subId])).rows[0];
    if (!row) return console.warn(`stripe: subscription ${subId} isn't on the hub; ignored`);
    await client.query(`UPDATE subscriptions SET unpaid_since = coalesce(unpaid_since, now()), disputed_at = CASE WHEN $2 THEN coalesce(disputed_at, now()) ELSE disputed_at END, updated_at = now() WHERE shop_id = $1`, [row.shop_id, disputed]);
    await revokeLiveKeys(client, row.shop_id, ["m", "y"]);
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
        await client.query(`UPDATE subscriptions SET unpaid_since = NULL, updated_at = now() WHERE shop_id = $1 AND stripe_subscription_id = $2`, [r.shop.id, subId]);
        await client.query(`UPDATE shops SET lapsed_at = NULL WHERE id = $1 AND lapsed_at IS NOT NULL`, [r.shop.id]);
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
      await q(`SELECT key_id, kid, plan, modules, first_day::text AS first_day, last_day::text AS last_day, grace_days, issued_at, revoked_at FROM license_issues WHERE shop_id = $1 ORDER BY issued_at DESC LIMIT 200`, [c.req.param("id")])
    ).rows;
    return c.json({ keys: rows.map((r) => ({ keyId: r.key_id, kid: r.kid, plan: r.plan, modules: r.modules, firstDay: r.first_day, lastDay: r.last_day, graceDays: r.grace_days, issuedAt: r.issued_at, revokedAt: r.revoked_at })) });
  });

  // ----- dunning mail, once per period: 7 days into grace, the day it lapses, 30 days before a yearly renewal -----

  async function dunningSweep() {
    if (!billingOpen()) return;
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
