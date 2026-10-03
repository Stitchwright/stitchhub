// A stand-in for the bits of Stripe Billing the hub uses (a subscription-aware copy of StitchBench's
// scripts/test-mail/stripe-mock.mjs). node:http only.
//
//   import { startStripeMock } from "./stripe-mock.mjs";
//   const mock = await startStripeMock({ port: 0, webhookUrl: "http://127.0.0.1:8080/v1/stripe", webhookSecret: "whsec_…",
//     catalog: [{ id: "price_solo_m", interval: "month", amount: 2500 }, { id: "price_solo_y", interval: "year", amount: 25000 }, ...] });
//   (or prices: { monthly, yearly }: two prices, $25 a month and $250 a year, as before the two plans)
//   node test/stripe-mock.mjs        // STRIPE_MOCK_PORT (3403), STRIPE_MOCK_WEBHOOK_URL, STRIPE_MOCK_WEBHOOK_SECRET, and the
//                                    // prices from the hub's own variables: STRIPE_PRICE_SOLO_MONTHLY ... _SHOP_YEARLY_FOUNDING
//                                    // (each id in a comma-separated list), or STRIPE_PRICE_MONTHLY/YEARLY
//
// Bearer auth with any sk_/rk_ key (STRIPE_MOCK_KEY to insist on one). The API: POST /v1/customers, POST
// /v1/checkout/sessions (mode=subscription; the session's url is this mock's own payment page /pay/{id}: "Pay" starts
// the subscription, pays its first invoice, posts the signed webhooks and sends the browser to success_url;
// subscription_data[trial_end], at least 48 hours ahead as Stripe requires, starts it trialing with a $0 first invoice
// and nothing charged until the trial ends), GET /v1/checkout/sessions/{id}, GET /v1/subscriptions/{id}, POST
// /v1/subscriptions/{id} (items[0][id] + items[0][price]: a plan switch; proration_behavior is kept as
// last_proration_behavior; customer.subscription.updated goes out), GET /v1/prices/{id}, GET /v1/invoices/{id} (with
// billing_reason: subscription_create for the first, subscription_cycle after), GET /v1/charges/{id}, GET
// /v1/disputes/{id}, POST /v1/billing/portal/sessions, POST /v1/refunds (amount for a partial one; charge.refunded goes
// out).
// Test hooks (no auth): POST /__pay/{sessionId}; POST /__subscriptions/{id} { status, cancel_at_period_end,
// current_period_end, price } (price: put the subscription on any price id, one the hub may not know); POST
// /__subscriptions/{id}/renew { paid: true|false } (a new invoice: paid advances the period, and ends a trial with the
// first charge; unpaid puts the subscription past_due); POST /__subscriptions/{id}/cancel { at_period_end }; POST
// /__charges/{id}/dispute (charge.dispute.created); POST /__disputes/{id}/close { status: "won" | "lost" }
// (charge.dispute.closed); POST /__replay/{eventId}; GET /__events, /__webhooks, /__state; DELETE /__state.
// Every hook waits for its webhooks to be answered and reports each delivery's status, so a test can check the hub
// right after.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
const hex = (n) => crypto.randomBytes(n).toString("hex");
const now = () => Math.floor(Date.now() / 1000);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/** Stripe's bracket form keys back into an object: a[b][0][c]=x. */
function parseForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const keys = k.replace(/\]/g, "").split("[");
    let o = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) o[key] = v;
      else {
        if (!(key in o)) o[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
        o = o[key];
      }
    });
  }
  return out;
}

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const stripeError = (res, status, message, type = "invalid_request_error") => json(res, status, { error: { message, type } });

function authOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const want = process.env.STRIPE_MOCK_KEY;
  return want ? m[1] === want : KEY.test(m[1]);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** One interval on from a unix time: a month (clamped to the shorter month) or a year. */
function addInterval(unix, interval) {
  const d = new Date(unix * 1000);
  const day = d.getUTCDate();
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, days));
  }
  return Math.floor(d.getTime() / 1000);
}

/** The prices from the hub's variables, for the mock run on its own: every STRIPE_PRICE_* id, with the decided amounts. */
function catalogFromEnv() {
  const amounts = { SOLO: 2500, SHOP: 4500, SOLO_FOUNDING: 1500, SHOP_FOUNDING: 3000 };
  const out = [];
  for (const [name, value] of Object.entries(process.env)) {
    const m = /^STRIPE_PRICE_(SOLO|SHOP)_(MONTHLY|YEARLY)(_FOUNDING)?$/.exec(name) ?? /^STRIPE_PRICE_(MONTHLY|YEARLY)$/.exec(name);
    if (!m) continue;
    const yearly = name.includes("YEARLY");
    const monthly = m[2] ? amounts[`${m[1]}${m[3] ?? ""}`] : 2500;
    for (const id of String(value).split(",").map((x) => x.trim()).filter(Boolean)) out.push({ id, interval: yearly ? "year" : "month", amount: yearly ? monthly * 10 : monthly });
  }
  return out;
}

/**
 * @param {{ port?: number; webhookUrl?: string | null; webhookSecret?: string; prices?: { monthly?: string; yearly?: string }; catalog?: { id: string; interval: "month" | "year"; amount: number }[] }} o
 */
export async function startStripeMock(o = {}) {
  const customers = new Map();
  const sessions = new Map();
  const subscriptions = new Map();
  const invoices = new Map();
  const charges = new Map();
  const refunds = [];
  const disputes = [];
  const events = [];
  const webhooks = [];
  const secret = o.webhookSecret ?? process.env.STRIPE_MOCK_WEBHOOK_SECRET ?? "whsec_mock1234567890";
  const webhookUrl = o.webhookUrl === undefined ? (process.env.STRIPE_MOCK_WEBHOOK_URL ?? null) : o.webhookUrl;
  const prices = { monthly: o.prices?.monthly ?? process.env.STRIPE_PRICE_MONTHLY ?? "price_mock_monthly", yearly: o.prices?.yearly ?? process.env.STRIPE_PRICE_YEARLY ?? "price_mock_yearly" };
  // The prices this "Stripe account" has: the catalog given, else the hub's variables, else the two of `prices`.
  const given = o.catalog ?? (o.prices ? null : catalogFromEnv());
  const catalog = new Map(
    (given?.length ? given : [{ id: prices.monthly, interval: "month", amount: 2500 }, { id: prices.yearly, interval: "year", amount: 25000 }]).map((p) => [p.id, p]),
  );
  // A price id the catalog doesn't have (put on a subscription by the test hook) is a monthly price of no amount.
  const priceOf = (id) => {
    const p = catalog.get(id);
    return { id, object: "price", active: true, recurring: { interval: p?.interval ?? "month" }, unit_amount: p?.amount ?? 0, currency: "usd" };
  };
  let port = o.port ?? Number(process.env.STRIPE_MOCK_PORT ?? 3403);

  async function deliver(ev) {
    if (!webhookUrl) return null;
    const body = JSON.stringify(ev);
    const t = now();
    const sig = `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    try {
      const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body });
      const text = await res.text();
      const entry = { id: ev.id, type: ev.type, status: res.status, body: text.slice(0, 500) };
      webhooks.push(entry);
      return entry;
    } catch (e) {
      const entry = { id: ev.id, type: ev.type, status: 0, error: e instanceof Error ? e.message : String(e) };
      webhooks.push(entry);
      return entry;
    }
  }
  /** Makes an event and posts it; answers the delivery. */
  async function emit(type, object) {
    const ev = { id: `evt_${hex(12)}`, object: "event", type, created: now(), api_version: "2024-06-20", data: { object: structuredClone(object) } };
    events.push(ev);
    return deliver(ev);
  }

  function charge(sub, inv, amount) {
    const ch = { id: `ch_${hex(12)}`, object: "charge", amount, amount_refunded: 0, refunded: false, customer: sub.customer, invoice: inv.id, payment_intent: `pi_${hex(12)}`, status: "succeeded", created: now() };
    charges.set(ch.id, ch);
    inv.charge = ch.id;
    inv.payment_intent = ch.payment_intent;
    return ch;
  }

  /** A subscription's invoice: the price's amount (0 for the first invoice of a trial: nothing is charged). */
  function invoiceFor(sub, paid, reason = "subscription_cycle", amount = sub.items.data[0].price.unit_amount) {
    const inv = {
      id: `in_${hex(12)}`,
      object: "invoice",
      customer: sub.customer,
      subscription: sub.id,
      billing_reason: reason,
      status: paid ? "paid" : "open",
      paid,
      amount_due: amount,
      amount_paid: paid ? amount : 0,
      period_start: sub.current_period_start,
      period_end: sub.current_period_end,
      charge: null,
      payment_intent: null,
      attempt_count: 1,
      created: now(),
    };
    invoices.set(inv.id, inv);
    if (paid && amount > 0) charge(sub, inv, amount);
    sub.latest_invoice = inv.id;
    return inv;
  }

  async function pay(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (s.status === "complete") return { session: s, delivered: [] };
    const price = priceOf(s.line_items.data[0].price.id);
    const start = now();
    // subscription_data[trial_end]: trialing until then, the period is the trial, the first invoice is $0.
    const trialEnd = s.subscription_data?.trial_end ? Number(s.subscription_data.trial_end) : null;
    const sub = {
      id: `sub_${hex(12)}`,
      object: "subscription",
      customer: s.customer,
      status: trialEnd ? "trialing" : "active",
      cancel_at_period_end: false,
      canceled_at: null,
      trial_start: trialEnd ? start : null,
      trial_end: trialEnd,
      current_period_start: start,
      current_period_end: trialEnd ?? addInterval(start, price.recurring.interval),
      items: { object: "list", data: [{ id: `si_${hex(8)}`, object: "subscription_item", price, quantity: 1 }] },
      metadata: s.subscription_data?.metadata ?? {},
      latest_invoice: null,
      created: start,
    };
    subscriptions.set(sub.id, sub);
    const inv = invoiceFor(sub, true, "subscription_create", trialEnd ? 0 : price.unit_amount);
    s.status = "complete";
    s.payment_status = "paid";
    s.subscription = sub.id;
    const delivered = [await emit("customer.subscription.created", sub), await emit("invoice.paid", inv), await emit("checkout.session.completed", s)];
    return { session: s, subscription: sub, invoice: inv, delivered };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    try {
      // ---- the pages a browser lands on
      let m = /^\/pay\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("No such session.");
        }
        if (req.method === "POST") {
          await pay(s.id);
          res.writeHead(303, { location: s.success_url });
          return res.end();
        }
        const price = priceOf(s.line_items.data[0].price.id);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><html><head><title>Stripe mock checkout</title></head><body style="font-family:sans-serif;max-width:480px;margin:40px auto">` +
            `<h1>Stripe mock checkout</h1><p>${escapeHtml(customers.get(s.customer)?.email ?? "")}</p><p>Subscription: $${(price.unit_amount / 100).toFixed(2)} a ${price.recurring.interval}</p>` +
            `<form method="post"><button type="submit">Subscribe</button></form><p><a href="${escapeHtml(s.cancel_url)}">Cancel</a></p></body></html>`,
        );
      }
      m = /^\/portal\/(cus_[A-Za-z0-9_]+)$/.exec(p);
      if (m) {
        const c = customers.get(m[1]);
        const subs = [...subscriptions.values()].filter((s) => s.customer === m[1]);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><html><head><title>Stripe mock portal</title></head><body style="font-family:sans-serif;max-width:480px;margin:40px auto"><h1>Stripe mock customer portal</h1><p>${escapeHtml(c?.email ?? "")}</p><ul>${subs
            .map((s) => `<li>${escapeHtml(s.id)}: ${escapeHtml(s.status)}${s.cancel_at_period_end ? " (cancels at period end)" : ""}</li>`)
            .join("")}</ul><p><a href="${escapeHtml(url.searchParams.get("return") ?? "/")}">Back</a></p></body></html>`,
        );
      }
      // ---- test hooks
      m = /^\/__pay\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "POST") {
        const r = await pay(m[1]);
        return r ? json(res, 200, r) : json(res, 404, { error: "no such session" });
      }
      m = /^\/__subscriptions\/(sub_[A-Za-z0-9_]+)(\/renew|\/cancel)?$/.exec(p);
      if (m && req.method === "POST") {
        const sub = subscriptions.get(m[1]);
        if (!sub) return json(res, 404, { error: "no such subscription" });
        const b = parseJson(await readBody(req));
        if (m[2] === "/renew") {
          const paid = b.paid !== false;
          if (paid) {
            sub.current_period_start = sub.current_period_end;
            sub.current_period_end = addInterval(sub.current_period_end, sub.items.data[0].price.recurring.interval);
            sub.status = "active";
          } else sub.status = "past_due";
          const inv = invoiceFor(sub, paid);
          const delivered = [await emit(paid ? "invoice.paid" : "invoice.payment_failed", inv), await emit("customer.subscription.updated", sub)];
          return json(res, 200, { subscription: sub, invoice: inv, delivered });
        }
        if (m[2] === "/cancel") {
          if (b.at_period_end) {
            sub.cancel_at_period_end = true;
            return json(res, 200, { subscription: sub, delivered: [await emit("customer.subscription.updated", sub)] });
          }
          sub.status = "canceled";
          sub.canceled_at = now();
          sub.cancel_at_period_end = false;
          return json(res, 200, { subscription: sub, delivered: [await emit("customer.subscription.deleted", sub)] });
        }
        for (const k of ["status", "cancel_at_period_end", "current_period_end", "current_period_start"]) if (b[k] !== undefined) sub[k] = b[k];
        if (typeof b.price === "string") sub.items.data[0].price = priceOf(b.price);
        return json(res, 200, { subscription: sub, delivered: [await emit("customer.subscription.updated", sub)] });
      }
      m = /^\/__charges\/(ch_[A-Za-z0-9_]+)\/dispute$/.exec(p);
      if (m && req.method === "POST") {
        const ch = charges.get(m[1]);
        if (!ch) return json(res, 404, { error: "no such charge" });
        const dp = { id: `dp_${hex(12)}`, object: "dispute", charge: ch.id, amount: ch.amount, currency: "usd", status: "needs_response", reason: "fraudulent", created: now() };
        disputes.push(dp);
        ch.disputed = true;
        return json(res, 200, { dispute: dp, delivered: [await emit("charge.dispute.created", dp)] });
      }
      m = /^\/__disputes\/(dp_[A-Za-z0-9_]+)\/close$/.exec(p);
      if (m && req.method === "POST") {
        const dp = disputes.find((x) => x.id === m[1]);
        if (!dp) return json(res, 404, { error: "no such dispute" });
        const b = parseJson(await readBody(req));
        dp.status = b.status === "lost" ? "lost" : "won";
        return json(res, 200, { dispute: dp, delivered: [await emit("charge.dispute.closed", dp)] });
      }
      m = /^\/__replay\/(evt_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "POST") {
        const ev = events.find((e) => e.id === m[1]);
        return ev ? json(res, 200, { delivered: [await deliver(ev)] }) : json(res, 404, { error: "no such event" });
      }
      if (p === "/__events" && req.method === "GET") return json(res, 200, events);
      if (p === "/__webhooks" && req.method === "GET") return json(res, 200, webhooks);
      if (p === "/__state" && req.method === "GET") {
        return json(res, 200, { customers: [...customers.values()], sessions: [...sessions.values()], subscriptions: [...subscriptions.values()], invoices: [...invoices.values()], charges: [...charges.values()], refunds, disputes });
      }
      if (p === "/__state" && req.method === "DELETE") {
        for (const x of [customers, sessions, subscriptions, invoices, charges]) x.clear();
        refunds.length = events.length = webhooks.length = disputes.length = 0;
        return json(res, 200, { ok: true });
      }
      // ---- the API
      if (!authOk(req)) return stripeError(res, 401, "Invalid API Key provided", "authentication_error");
      if (p === "/v1/customers" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        const c = { id: `cus_${hex(12)}`, object: "customer", email: f.email ?? null, name: f.name ?? null, metadata: f.metadata ?? {}, created: now() };
        customers.set(c.id, c);
        return json(res, 200, c);
      }
      m = /^\/v1\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return customers.has(m[1]) ? json(res, 200, customers.get(m[1])) : stripeError(res, 404, `No such customer: '${m[1]}'`);
      if (p === "/v1/checkout/sessions" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        if (f.mode !== "subscription") return stripeError(res, 400, "This mock sells subscriptions only (mode=subscription).");
        if (!f.success_url || !f.cancel_url) return stripeError(res, 400, "Missing required param: success_url / cancel_url.");
        if (!f.customer || !customers.has(f.customer)) return stripeError(res, 400, `No such customer: '${f.customer ?? ""}'`);
        const lines = Array.isArray(f.line_items) ? f.line_items : [];
        if (!lines.length || !lines[0].price) return stripeError(res, 400, "Missing required param: line_items[0][price].");
        if (!catalog.has(lines[0].price)) return stripeError(res, 400, `No such price: '${lines[0].price}'`);
        // Stripe: a Checkout subscription's trial_end has to be at least 48 hours in the future.
        const trialEnd = f.subscription_data?.trial_end;
        if (trialEnd !== undefined && !(Number.isInteger(Number(trialEnd)) && Number(trialEnd) >= now() + 48 * 3600)) {
          return stripeError(res, 400, "subscription_data[trial_end] has to be at least 48 hours in the future.");
        }
        const idem = req.headers["idempotency-key"];
        const prior = idem ? [...sessions.values()].find((s) => s.idempotency_key === idem) : null;
        if (prior) return json(res, 200, prior);
        const id = `cs_test_${hex(12)}`;
        const s = {
          id,
          object: "checkout.session",
          url: `http://127.0.0.1:${port}/pay/${id}`,
          mode: "subscription",
          status: "open",
          payment_status: "unpaid",
          customer: f.customer,
          subscription: null,
          client_reference_id: f.client_reference_id ?? null,
          metadata: f.metadata ?? {},
          subscription_data: f.subscription_data ?? {},
          allow_promotion_codes: f.allow_promotion_codes === "true",
          success_url: f.success_url,
          cancel_url: f.cancel_url,
          expires_at: now() + 86400,
          line_items: { object: "list", data: lines.map((l) => ({ price: priceOf(l.price), quantity: Number(l.quantity ?? 1) })) },
          idempotency_key: idem ?? null,
        };
        sessions.set(id, s);
        return json(res, 200, s);
      }
      m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return sessions.has(m[1]) ? json(res, 200, sessions.get(m[1])) : stripeError(res, 404, `No such checkout.session: '${m[1]}'`);
      m = /^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return subscriptions.has(m[1]) ? json(res, 200, subscriptions.get(m[1])) : stripeError(res, 404, `No such subscription: '${m[1]}'`);
      if (m && req.method === "POST") {
        // A plan switch: the named item moves to the new price; the period, status and metadata stay.
        const sub = subscriptions.get(m[1]);
        if (!sub) return stripeError(res, 404, `No such subscription: '${m[1]}'`);
        const f = parseForm(await readBody(req));
        const items = Array.isArray(f.items) ? f.items : [];
        for (const it of items) {
          const item = sub.items.data.find((x) => x.id === it.id);
          if (!item) return stripeError(res, 400, `No such subscription item: '${it.id ?? ""}'`);
          if (!it.price || !catalog.has(it.price)) return stripeError(res, 400, `No such price: '${it.price ?? ""}'`);
          item.price = priceOf(it.price);
        }
        if (f.proration_behavior) sub.last_proration_behavior = f.proration_behavior;
        await emit("customer.subscription.updated", sub);
        return json(res, 200, sub);
      }
      m = /^\/v1\/prices\/([A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return catalog.has(m[1]) ? json(res, 200, priceOf(m[1])) : stripeError(res, 404, `No such price: '${m[1]}'`);
      m = /^\/v1\/invoices\/(in_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return invoices.has(m[1]) ? json(res, 200, invoices.get(m[1])) : stripeError(res, 404, `No such invoice: '${m[1]}'`);
      m = /^\/v1\/charges\/(ch_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") return charges.has(m[1]) ? json(res, 200, charges.get(m[1])) : stripeError(res, 404, `No such charge: '${m[1]}'`);
      m = /^\/v1\/disputes\/(dp_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") {
        const dp = disputes.find((x) => x.id === m[1]);
        return dp ? json(res, 200, dp) : stripeError(res, 404, `No such dispute: '${m[1]}'`);
      }
      if (p === "/v1/billing/portal/sessions" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        if (!f.customer || !customers.has(f.customer)) return stripeError(res, 400, `No such customer: '${f.customer ?? ""}'`);
        return json(res, 200, { id: `bps_${hex(12)}`, object: "billing_portal.session", customer: f.customer, return_url: f.return_url ?? null, url: `http://127.0.0.1:${port}/portal/${f.customer}?return=${encodeURIComponent(f.return_url ?? "/")}` });
      }
      if (p === "/v1/refunds" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        const ch = f.charge ? charges.get(f.charge) : [...charges.values()].find((x) => x.payment_intent === f.payment_intent);
        if (!ch) return stripeError(res, 404, `No such charge: '${f.charge ?? f.payment_intent ?? ""}'`);
        const amount = f.amount != null ? Number(f.amount) : ch.amount - ch.amount_refunded;
        if (amount <= 0 || amount + ch.amount_refunded > ch.amount) return stripeError(res, 400, "Refund amount is greater than the unrefunded amount of the charge.");
        const r = { id: `re_${hex(12)}`, object: "refund", amount, status: "succeeded", charge: ch.id, payment_intent: ch.payment_intent, created: now() };
        refunds.push(r);
        ch.amount_refunded += amount;
        ch.refunded = ch.amount_refunded >= ch.amount;
        await emit("charge.refunded", ch);
        return json(res, 200, r);
      }
      return stripeError(res, 404, `Unrecognized request URL (${req.method}: ${p}).`);
    } catch (e) {
      return stripeError(res, 500, e instanceof Error ? e.message : String(e), "api_error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    prices,
    catalog,
    customers,
    sessions,
    subscriptions,
    invoices,
    charges,
    refunds,
    disputes,
    events,
    webhooks,
    pay,
    emit,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStripeMock()
    .then((mock) => console.log(`stripe mock on ${mock.url}${process.env.STRIPE_MOCK_WEBHOOK_URL ? ` (webhooks to ${process.env.STRIPE_MOCK_WEBHOOK_URL})` : " (no webhooks)"}; prices ${[...mock.catalog.keys()].join(", ")}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
