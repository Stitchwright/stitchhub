// The MakerFoundry order messages (#34, docs/hub-sync-design.md, SiteSentrix/makerfoundry docs/shop-orders-contract.md): what each
// body may hold, the signature on order.placed, and the files a message points at. Pure: no database, no network. src/sync.mjs
// calls validateBody() on every message before it is queued, and what comes out of it, not what came in, is what is stored and
// handed to the recipient. So a field this module doesn't name never travels, and the customer's email and phone cannot.
//
// The rules the owner set (makerfoundry#2, hub #34):
//  - the customer's email and phone are never routed (a key that names them is refused, and so is an email address or phone
//    number typed into a note);
//  - the shipping address travels only when the order is to be shipped (fulfilment "ship"), and not for a pickup;
//  - art and mock-ups are never inside a message: they are files, fetched by short-lived signed addresses and checked by
//    size and SHA-256 (10 MB a file, previews PNG or JPEG of 2 MB at most).
import crypto from "node:crypto";

export const MAX_ART_BYTES = 10 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

export class Bad extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const bad = (code, message) => {
  throw new Bad(code, message);
};

// ----- small checkers: each returns the cleaned value or throws Bad -----
const text = (v, max, path, { min = 1, re } = {}) => {
  if (typeof v !== "string") bad("bad_field", `${path} has to be text.`);
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < min) bad("bad_field", `${path} can't be empty.`);
  if (t.length > max) bad("bad_field", `${path} is longer than ${max} characters.`);
  if (re && !re.test(t)) bad("bad_field", `${path} isn't in the form expected.`);
  return t;
};
const int = (v, lo, hi, path) => {
  if (!Number.isInteger(v) || v < lo || v > hi) bad("bad_field", `${path} has to be a whole number from ${lo} to ${hi}.`);
  return v;
};
const bool = (v, path) => {
  if (typeof v !== "boolean") bad("bad_field", `${path} has to be true or false.`);
  return v;
};
const oneOf = (v, list, path) => {
  if (!list.includes(v)) bad("bad_field", `${path} has to be one of: ${list.join(", ")}.`);
  return v;
};
const list = (v, max, path, each, min = 0) => {
  if (!Array.isArray(v)) bad("bad_field", `${path} has to be a list.`);
  if (v.length < min) bad("bad_field", `${path} needs at least ${min}.`);
  if (v.length > max) bad("bad_field", `${path} has more than ${max}.`);
  return v.map((x, i) => each(x, `${path}[${i}]`));
};
/** An object read through `shape` = { key: [required, checker(value, path)] }. Keys not in the shape are dropped and noted. */
function shaped(v, path, shape, dropped) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad("bad_field", `${path} has to be an object.`);
  const out = {};
  for (const [k, [required, check]] of Object.entries(shape)) {
    if (v[k] === undefined || v[k] === null) {
      if (required) bad("bad_field", `${path}.${k} is missing.`);
      continue;
    }
    out[k] = check(v[k], `${path}.${k}`);
  }
  for (const k of Object.keys(v)) if (!(k in shape)) dropped.push(`${path}.${k}`);
  return out;
}
const sha256 = (v, path) => (SHA.test(String(v)) ? String(v) : bad("bad_field", `${path} has to be a SHA-256 (64 hex characters).`));

// ----- contact details never travel -----
const CONTACT_KEY = /^(e-?mail|phone|tel|telephone|mobile|cell|sms|whatsapp|fax|contact|customer_?email|customer_?phone)$/i;
const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\d[\s().-]?){10,}/;
function scanKeys(v, path) {
  if (Array.isArray(v)) return v.forEach((x, i) => scanKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (CONTACT_KEY.test(k)) bad("personal_contact", `${path}.${k}: the customer's email and phone are never sent; the shop reaches the customer through the order's messages.`);
      scanKeys(x, `${path}.${k}`);
    }
  }
}
/** Free text (a note, a name): refuses an email address or a phone number in it. */
const free = (v, max, path, opts) => {
  const t = text(v, max, path, opts);
  if (EMAIL.test(t) || PHONE.test(t)) bad("personal_contact", `${path} has an email address or phone number in it; the shop reaches the customer through the order's messages.`);
  return t;
};

// ----- the bodies -----
const art = (v, path, d) => shaped(v, path, { file: [true, (x, p) => text(x, 120, p, { re: FILE_NAME })], size: [true, (x, p) => int(x, 1, MAX_ART_BYTES, p)], sha256: [true, sha256] }, d);
const preview = (v, path, d) => shaped(v, path, { size: [true, (x, p) => int(x, 1, MAX_PREVIEW_BYTES, p)], sha256: [true, sha256], type: [true, (x, p) => oneOf(x, ["image/png", "image/jpeg"], p)] }, d);
const money = (x, p) => int(x, 0, 100_000_000, p);
const METHODS = ["embroidery", "screen_print"];
const shipTo = (v, path, d) =>
  shaped(v, path, {
    name: [true, (x, p) => free(x, 120, p)], line1: [true, (x, p) => text(x, 120, p)], line2: [false, (x, p) => text(x, 120, p)], city: [true, (x, p) => text(x, 80, p)],
    region: [false, (x, p) => text(x, 40, p)], postal: [true, (x, p) => text(x, 20, p)], country: [true, (x, p) => text(x, 2, p, { re: /^[A-Z]{2}$/ })],
  }, d);

const BODIES = {
  catalog: (b, d) =>
    shaped(b, "body", {
      shop: [true, (x, p) => shaped(x, p, { name: [true, (y, q) => text(y, 120, q)], town: [false, (y, q) => text(y, 80, q)], ships: [true, bool], pickup: [true, bool] }, d)],
      products: [true, (x, p) => list(x, 200, p, (y, q) => shaped(y, q, {
        sku: [true, (z, r) => text(z, 60, r, { re: SKU })], name: [true, (z, r) => text(z, 120, r)], kind: [true, (z, r) => text(z, 30, r)],
        colours: [true, (z, r) => list(z, 50, r, (w, s) => text(w, 40, s))], sizes: [true, (z, r) => list(z, 20, r, (w, s) => text(w, 10, s))],
        methods: [true, (z, r) => list(z, 6, r, (w, s) => shaped(w, s, {
          method: [true, (u, t) => oneOf(u, METHODS, t)], placements: [true, (u, t) => list(u, 10, t, (a, c) => text(a, 40, c), 1)],
          price_breaks: [true, (u, t) => list(u, 10, t, (a, c) => shaped(a, c, { min: [true, (e, f) => int(e, 1, 100_000, f)], cents: [true, money] }, d), 1)],
          setup_cents: [true, money],
        }, d), 1)],
      }, d))],
      shipping: [true, (x, p) => shaped(x, p, { flat_cents: [true, money] }, d)],
      currency: [true, (x, p) => oneOf(x, ["usd"], p)],
    }, d),
  "order.placed": (b, d) => {
    const out = shaped(b, "body", {
      fulfilment: [true, (x, p) => oneOf(x, ["ship", "pickup"], p)],
      lines: [true, (x, p) => list(x, 50, p, (y, q) => shaped(y, q, {
        sku: [true, (z, r) => text(z, 60, r, { re: SKU })], colour: [true, (z, r) => text(z, 40, r)],
        sizes: [true, (z, r) => {
          if (typeof z !== "object" || z === null || Array.isArray(z) || Object.keys(z).length < 1 || Object.keys(z).length > 20) bad("bad_field", `${r} is { size: count } with 1 to 20 sizes.`);
          return Object.fromEntries(Object.entries(z).map(([k, n]) => [text(k, 10, `${r} size`), int(n, 1, 10_000, `${r}.${k}`)]));
        }],
        decorations: [true, (z, r) => list(z, 10, r, (w, s) => shaped(w, s, { method: [true, (u, t) => oneOf(u, METHODS, t)], placement: [true, (u, t) => text(u, 40, t)], art: [true, (u, t) => art(u, t, d)] }, d), 1)],
      }, d), 1)],
      preview: [false, (x, p) => preview(x, p, d)],
      customer: [true, (x, p) => shaped(x, p, { name: [true, (y, q) => free(y, 120, q)], ship_to: [false, (y, q) => shipTo(y, q, d)] }, d)],
      totals: [true, (x, p) => shaped(x, p, Object.fromEntries(["goods_cents", "setup_cents", "shipping_cents", "tax_cents", "paid_cents", "fee_cents", "card_fee_cents", "shop_gets_cents"].map((k) => [k, [true, money]])), d)],
      note: [false, (x, p) => free(x, 500, p)],
    }, d);
    if (out.fulfilment === "ship" && !out.customer.ship_to) bad("ship_to_missing", "An order to be shipped needs the shipping address (customer.ship_to).");
    if (out.fulfilment === "pickup" && out.customer.ship_to) bad("ship_to_not_allowed", "The shipping address goes only with an order that is to be shipped; leave it out of a pickup.");
    return out;
  },
  "order.status": (b, d) =>
    shaped(b, "body", {
      status: [true, (x, p) => oneOf(x, ["received", "proof_sent", "approved", "in_production", "ready", "shipped", "collected"], p)],
      tracking: [false, (x, p) => text(x, 80, p)], note: [false, (x, p) => free(x, 500, p)],
    }, d),
  "proof.sent": (b, d) =>
    shaped(b, "body", { proof: [true, (x, p) => int(x, 1, 1000, p)], mockup: [true, (x, p) => preview(x, p, d)], note: [false, (x, p) => free(x, 500, p)] }, d),
  "proof.answer": (b, d) =>
    shaped(b, "body", { proof: [true, (x, p) => int(x, 1, 1000, p)], answer: [true, (x, p) => oneOf(x, ["approved", "changes"], p)], note: [false, (x, p) => free(x, 500, p)] }, d),
  "order.cancel": (b, d) =>
    shaped(b, "body", { by: [true, (x, p) => oneOf(x, ["shop", "customer"], p)], why: [true, (x, p) => free(x, 500, p)] }, d),
  "message.expired": (b, d) =>
    shaped(b, "body", { id: [true, (x, p) => text(x, 80, p)], type: [true, (x, p) => text(x, 40, p)], conversation: [true, (x, p) => text(x, 120, p)], to: [false, (x, p) => text(x, 120, p)], reason: [true, (x, p) => oneOf(x, ["expired", "recipient_too_old"], p)] }, d),
};

/**
 * The body of a message, checked and cleaned. Returns { body, dropped } (dropped: the paths of fields that are not part of this
 * version and were left out) or throws Bad { code, message }. `from` is "service", "shop" or "hub".
 */
export function validateBody(type, version, body, { from } = {}) {
  const check = BODIES[type];
  if (!check || version !== 1) bad("unknown_type", `No body rules for ${type} v${version}.`);
  scanKeys(body, "body");
  const dropped = [];
  const clean = check(body, dropped);
  if (type === "order.cancel" && ((clean.by === "customer" && from !== "service") || (clean.by === "shop" && from !== "shop"))) bad("bad_field", `body.by has to say who is cancelling: "customer" comes from the service, "shop" from the shop.`);
  return { body: clean, dropped };
}

/** The files a message points at: [{ sha256, size, kind: "art" | "mockup" }]. The sender must have uploaded each one first. */
export function fileRefs(type, body) {
  if (type === "order.placed") {
    const refs = body.lines.flatMap((l) => l.decorations.map((d) => ({ sha256: d.art.sha256, size: d.art.size, kind: "art" })));
    if (body.preview) refs.push({ sha256: body.preview.sha256, size: body.preview.size, kind: "mockup", type: body.preview.type });
    return refs;
  }
  if (type === "proof.sent") return [{ sha256: body.mockup.sha256, size: body.mockup.size, kind: "mockup", type: body.mockup.type }];
  return [];
}

// ----- the signature on order.placed -----
/** The types a service must sign: a message that means money was taken. */
export const SIGNED_TYPES = new Set(["order.placed"]);

/** JSON with keys in sorted order, so the same body always gives the same text. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
/** What is signed: the sender, recipient, conversation, seq, id, type, version, the times as sent, and the hash of the canonical body. */
export function signedText(env) {
  return ["SBHUB1", env.from ?? "", env.to, env.conversation, env.seq, env.id, env.type, env.version, env.created_at, env.expires_at ?? "", crypto.createHash("sha256").update(canonical(env.body)).digest("hex")].join("\n");
}
export function verifySignature(env, publicKeyBase64) {
  try {
    const sig = env.sig?.sig;
    if (typeof sig !== "string" || env.sig?.v !== 1) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(signedText(env)), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}
/** For senders and tests: the sig object for an envelope, with an Ed25519 private key. */
export const signEnvelope = (env, privateKey) => ({ v: 1, sig: crypto.sign(null, Buffer.from(signedText(env)), privateKey).toString("base64") });
