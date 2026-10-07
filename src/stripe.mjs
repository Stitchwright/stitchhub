// A small Stripe Billing client, a port of StitchBench's src/lib/shop/stripe.ts: plain fetch against STRIPE_API_BASE
// (api.stripe.com, or the mock in test/stripe-mock.mjs), form bodies as Stripe takes them, the API version pinned, and
// the webhook signature check. No SDK. Stripe's error words go to the log (they can name the account); callers show a
// plain line. The secret key is read from STRIPE_SECRET_KEY at each call and never logged.
import crypto from "node:crypto";

const BASE = () => (process.env.STRIPE_API_BASE?.trim() || "https://api.stripe.com").replace(/\/$/, "");
const KEY = () => (process.env.STRIPE_SECRET_KEY ?? "").trim();
const TIMEOUT_MS = 20_000;
export const API_VERSION = "2024-06-20";

export const looksLikeSecretKey = (s) => /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(s);
/** "test" | "live" from the secret key, or null when none is set: the admin page's "Open in Stripe" links need it. */
export const stripeMode = () => (/^(sk|rk)_live_/.test(KEY()) ? "live" : KEY() ? "test" : null);
export const stripeConfigured = () => looksLikeSecretKey(KEY());

/** Flattens { a: { b: [x] } } to Stripe's form keys: a[b][0]=x. */
export function formBody(obj) {
  const out = new URLSearchParams();
  const walk = (v, key) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(obj, "");
  return out.toString();
}

export class StripeError extends Error {
  constructor(message, { status = 0, code = null, type = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

async function call(method, path, body, idempotencyKey) {
  const key = KEY();
  if (!key) throw new StripeError("STRIPE_SECRET_KEY isn't set.");
  const headers = { authorization: `Bearer ${key}`, "stripe-version": API_VERSION };
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, { method, headers, body: body ? formBody(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new StripeError(`Couldn't reach Stripe (${e instanceof Error ? e.message : "network"}).`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = json?.error ?? {};
    console.error(`stripe ${method} ${path}: ${res.status} ${err.type ?? ""} ${err.code ?? ""} ${String(err.message ?? "").slice(0, 300)}`);
    throw new StripeError(err.message ?? `Stripe answered ${res.status}`, { status: res.status, code: err.code ?? null, type: err.type ?? null });
  }
  return json;
}

const enc = encodeURIComponent;

export const createCustomer = (a) => call("POST", "/v1/customers", { email: a.email, name: a.name || undefined, metadata: a.metadata });
export const retrieveCustomer = (id) => call("GET", `/v1/customers/${enc(id)}`);

/**
 * A Checkout Session that starts a subscription (Stripe's hosted page). The hub runs the trial itself, so Checkout
 * always takes a card. Automatic tax is off (the owner's decision 8). Promotion codes are allowed; comps are not codes.
 * `trialEnd` (unix seconds, at least 48 hours ahead as Stripe requires): subscribing inside the hub's trial, the
 * subscription starts on Stripe's trial (status trialing) and its first charge falls then; the card is still taken now.
 */
export const createSubscriptionCheckout = (a) =>
  call(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer: a.customer,
      line_items: [{ price: a.price, quantity: 1 }],
      success_url: a.successUrl,
      cancel_url: a.cancelUrl,
      client_reference_id: a.reference,
      metadata: a.metadata,
      subscription_data: { metadata: a.metadata, ...(a.trialEnd ? { trial_end: a.trialEnd } : {}) },
      allow_promotion_codes: true,
    },
    a.idempotencyKey,
  );
export const retrieveSession = (id) => call("GET", `/v1/checkout/sessions/${enc(id)}`);
/** The Customer Portal (change the card or plan, cancel, invoices), back to `returnUrl` afterwards. */
export const createPortalSession = (a) => call("POST", "/v1/billing/portal/sessions", { customer: a.customer, return_url: a.returnUrl });
export const retrieveSubscription = (id) => call("GET", `/v1/subscriptions/${enc(id)}`);
/** A customer's subscriptions, ended ones too (one account's customer holds every shop's). */
export const listSubscriptions = (customer) => call("GET", `/v1/subscriptions?customer=${enc(customer)}&status=all&limit=100`);
/** Cancels a subscription at once: no proration credit and no refund (Stripe's defaults for DELETE). */
export const cancelSubscription = (id) => call("DELETE", `/v1/subscriptions/${enc(id)}`);
/**
 * Moves a subscription's item to another price (Switch to Shop / Solo), with Stripe's proration. `chargeNow` (moving up to
 * Shop): the difference for the rest of the period is invoiced and charged at once (always_invoice), and the change
 * waits for that payment (pending_if_incomplete: a declined card leaves the subscription on its old price, with a
 * pending_update, until the invoice is paid). Otherwise (moving down to Solo) the difference is a credit on the next
 * invoice (create_prorations).
 */
export const switchSubscriptionPrice = (a) =>
  call(
    "POST",
    `/v1/subscriptions/${enc(a.id)}`,
    {
      items: [{ id: a.itemId, price: a.price }],
      proration_behavior: a.chargeNow ? "always_invoice" : "create_prorations",
      ...(a.chargeNow ? { payment_behavior: "pending_if_incomplete" } : {}),
    },
    a.idempotencyKey,
  );
/** A price's amount and interval (the account page shows what each plan costs). */
export const retrievePrice = (id) => call("GET", `/v1/prices/${enc(id)}`);
export const retrieveInvoice = (id) => call("GET", `/v1/invoices/${enc(id)}`);
export const retrieveCharge = (id) => call("GET", `/v1/charges/${enc(id)}`);
/** A dispute (chargeback), re-read before the hub acts on charge.dispute.closed: its status (won | lost | ...) and charge. */
export const retrieveDispute = (id) => call("GET", `/v1/disputes/${enc(id)}`);

/**
 * Checks a webhook's Stripe-Signature (t=...,v1=...: HMAC-SHA256 of "t.body" with the endpoint secret, within five
 * minutes) and parses the event. Null when it doesn't check out.
 */
export function verifyWebhook(rawBody, signature, secret, now = new Date()) {
  if (!signature || !secret) return null;
  const parts = signature.split(",").map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const v1s = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!Number.isFinite(t) || !v1s.length) return null;
  if (Math.abs(now.getTime() / 1000 - t) > 300) return null;
  const want = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const ok = v1s.some((v) => {
    const got = Buffer.from(v, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
  if (!ok) return null;
  try {
    const ev = JSON.parse(rawBody);
    return ev && typeof ev.id === "string" && typeof ev.type === "string" && ev.data?.object && typeof ev.data.object === "object" ? ev : null;
  } catch {
    return null;
  }
}

/** The header a sender puts on a webhook (the mock signs with this). */
export function signWebhook(rawBody, secret, now = new Date()) {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

/**
 * A Checkout Session for a one-time payment (a top-up of Assistant calls): one price, back to the account page after.
 * The metadata goes on the session and on its payment, so the webhook can read what was bought and for whom.
 */
export const createPaymentCheckout = (a) =>
  call(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "payment",
      customer: a.customer,
      line_items: [{ price: a.price, quantity: 1 }],
      success_url: a.successUrl,
      cancel_url: a.cancelUrl,
      client_reference_id: a.reference,
      metadata: a.metadata,
      payment_intent_data: { metadata: a.metadata },
      allow_promotion_codes: true,
    },
    a.idempotencyKey,
  );
