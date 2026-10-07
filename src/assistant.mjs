// The Assistant proxy (StitchBench docs/plans/ai-assistant-scope.md section 2.2). The Anthropic key (ANTHROPIC_API_KEY)
// lives here and nowhere else: programs send a request naming a model class, the hub maps it to a model id, calls the
// Messages API, counts the call against the company's month and returns the text. It keeps tokens and cost, never the
// prompt or the answer. A company is `(install, shopRef)`; its month turns in the time zone the program names.
//
// Who may call: a program holding a valid `assistant` license key for this company (the key text travels with each
// request and is checked against ASSISTANT_PUBLIC_KEYS and the hub's own signing key), or one the admin comped. Without
// either, only the plate reader works, 20 times a month. 300 calls a month per company; the admin adds top-ups of 300.
import crypto from "node:crypto";
import { one, q, tx } from "./db.mjs";
import { signer } from "./license.mjs";

export const MONTHLY_CALLS = Math.max(1, Math.floor(Number(process.env.ASSISTANT_MONTHLY_CALLS)) || 300);
export const TOPUP_CALLS = Math.max(1, Math.floor(Number(process.env.ASSISTANT_TOPUP_CALLS)) || 300);
const FREE_READS = Math.max(0, Math.floor(Number(process.env.ASSISTANT_FREE_READS ?? 20)));
const HOURLY = Math.max(1, Math.floor(Number(process.env.ASSISTANT_HOURLY_CALLS)) || 60);

/** The model each class of work uses; the owner moves every shop to a newer model by changing a variable. */
const CLASSES = {
  draft: { env: "ASSISTANT_MODEL_DRAFT", fallback: "claude-sonnet-5-5", maxTokens: 1500, timeoutMs: 30_000 },
  suggest: { env: "ASSISTANT_MODEL_SUGGEST", fallback: "claude-sonnet-5-5", maxTokens: 2000, timeoutMs: 30_000 },
  read: { env: "ASSISTANT_MODEL_READ", fallback: "claude-haiku-4-5-20251001", maxTokens: 600, timeoutMs: 30_000 },
  manuals: { env: "ASSISTANT_MODEL_MANUALS", fallback: "claude-opus-5-5", maxTokens: 2500, timeoutMs: 60_000 },
};
const modelFor = (cls) => (process.env[CLASSES[cls].env] ?? "").trim() || CLASSES[cls].fallback;

// Dollars per million tokens: input, cache read, output (a 5-minute cache write is 1.25 x input). Unknown ids cost as Sonnet.
const PRICES = {
  "claude-haiku-4-5-20251001": [1, 0.1, 5],
  "claude-sonnet-5-5": [2, 0.2, 10],
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-fable-5-1": [10, 0.25, 50],
};
/** Thousandths of a cent: tokens x dollars per million x 100,000 / 1,000,000. */
export function costMillicents(model, { input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  const [i, cr, o] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return Math.round((input * i + cacheWrite * i * 1.25 + cacheRead * cr + output * o) / 10);
}

const MESSAGES_URL = () => `${(process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
const anthropicKey = () => (process.env.ANTHROPIC_API_KEY ?? "").trim();

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** The day (YYYY-MM-DD) and month (YYYY-MM) at `at` in a zone; null for a zone Intl doesn't know. */
export function zoneDay(at, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}

/**
 * Adds `calls` to the company's month (the month in the zone it last sent, UTC before its first call): the admin's top-up
 * and a paid top-up Checkout (src/assistant-billing.mjs) both land here. `run` is a query function (`q`, or a transaction
 * client's query) so a webhook's credit is written in the same transaction as the event that caused it.
 */
export async function creditTopup(run, installId, shopRef, calls, now = new Date()) {
  const shop = (await run(`SELECT tz FROM assistant_shops WHERE install_id = $1 AND shop_ref = $2`, [installId, shopRef])).rows[0];
  const month = zoneDay(now, shop?.tz ?? "UTC").slice(0, 7);
  const row = (
    await run(
      `INSERT INTO assistant_usage (install_id, shop_ref, month, bonus) VALUES ($1, $2, $3, $4)
       ON CONFLICT (install_id, shop_ref, month) DO UPDATE SET bonus = assistant_usage.bonus + EXCLUDED.bonus, updated_at = now() RETURNING calls, bonus`,
      [installId, shopRef, month, calls],
    )
  ).rows[0];
  return { month, calls: row.calls, limit: MONTHLY_CALLS + row.bonus };
}

// ----- license keys -----
let keyMemo;
function publicKeys() {
  if (keyMemo) return keyMemo;
  const out = new Map();
  try {
    for (const [kid, x] of Object.entries(JSON.parse(process.env.ASSISTANT_PUBLIC_KEYS || "{}"))) out.set(kid, typeof x === "string" ? x : x?.x);
  } catch {
    console.error("ASSISTANT_PUBLIC_KEYS isn't JSON like {\"k1\":\"<x>\"}: no emailed key is accepted.");
  }
  const s = signer().signer;
  if (s) out.set(s.kid, s.x);
  return (keyMemo = out);
}
/** Test hook: the key list is read once. */
export const forgetKeys = () => (keyMemo = undefined);

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** { ok, why } for a key text offered by company `shopRef`: genuine, for this company, naming the assistant, in its window (grace included). */
export function checkKey(text, shopRef, today) {
  const m = /^SB1\.([A-Za-z0-9_-]{20,3000})\.([A-Za-z0-9_-]{86})$/.exec(String(text ?? "").replace(/\s+/g, ""));
  if (!m) return { ok: false, why: "no key" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, why: "damaged key" };
  }
  const x = publicKeys().get(payload?.k);
  if (!x) return { ok: false, why: "unknown key" };
  try {
    const pub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    if (!crypto.verify(null, Buffer.from(m[1], "base64url"), pub, Buffer.from(m[2], "base64url"))) return { ok: false, why: "damaged key" };
  } catch {
    return { ok: false, why: "damaged key" };
  }
  if (payload.s !== shopRef) return { ok: false, why: "key for another company" };
  if (!Array.isArray(payload.m) || !payload.m.includes("assistant")) return { ok: false, why: "key without the Assistant" };
  if (typeof payload.f !== "string" || typeof payload.u !== "string") return { ok: false, why: "damaged key" };
  if (today < payload.f) return { ok: false, why: "starts later" };
  if (today > addDays(payload.u, Math.max(0, Math.min(60, Number(payload.g) || 0)))) return { ok: false, why: "ended" };
  return { ok: true, payload };
}

// ----- request checks -----
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_FEATURES = new Set(["read_plate", "read_label", "tag_fabric"]);
const MAX_SYSTEM = 40_000;
const MAX_TEXT = 120_000;
const MAX_IMAGE = 220_000; // base64 characters: the program shrinks a plate photo to about 150 KB

function clean(body, fail) {
  const cls = String(body.model ?? "");
  if (!Object.hasOwn(CLASSES, cls)) throw fail(400, "model must be draft, suggest, read or manuals.");
  const feature = str(body.feature, 40);
  if (!feature || !/^[a-z_]+$/.test(feature)) throw fail(400, "Send a feature name.");
  const shopRef = str(body.shopRef, 64);
  if (!shopRef) throw fail(400, "Send shopRef: the company this is for.");
  const tz = str(body.tz, 64) ?? "UTC";
  if (!zoneDay(new Date(), tz)) throw fail(400, "tz isn't a time zone name.");
  const system = typeof body.system === "string" ? body.system : "";
  if (system.length > MAX_SYSTEM) throw fail(400, "The instructions are too long.");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 12) throw fail(400, "Send 1 to 12 messages.");
  const messages = body.messages.map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_TEXT) throw fail(400, "Each message needs a role (user or assistant) and text.");
    return { role: m.role, content: m.content };
  });
  if (messages[messages.length - 1].role !== "user") throw fail(400, "The last message must be the user's.");
  const cap = CLASSES[cls].maxTokens;
  const maxTokens = Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, cap) : Math.min(1000, cap);
  let image = null;
  if (body.image != null) {
    if (!PHOTO_FEATURES.has(feature) || (cls !== "read" && cls !== "suggest")) throw fail(400, "Only the plate, bolt-label and swatch readers take a photo.");
    if (!IMAGE_TYPES.has(body.image?.mediaType) || typeof body.image.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(body.image.data) || body.image.data.length > MAX_IMAGE) throw fail(400, "Send the photo as a JPEG, PNG or WebP of at most about 150 KB.");
    image = { mediaType: body.image.mediaType, data: body.image.data };
  }
  return { cls, feature, shopRef, tz, system, messages, maxTokens, image, key: typeof body.key === "string" ? body.key.slice(0, 4000) : "" };
}

export function registerAssistant({ member, admin, fail, allow, newId }) {
  const busy = new Set();

  // Tests move the clock with a header, only on a hub started with ASSISTANT_TEST_CLOCK=true.
  const testClock = process.env.ASSISTANT_TEST_CLOCK === "true";
  const nowOf = (c) => {
    const t = testClock ? Date.parse(c.req.header("x-test-now") ?? "") : NaN;
    return Number.isNaN(t) ? new Date() : new Date(t);
  };

  // The month's position for the company: what the Settings page shows.
  async function position(installId, shopRef, tz, key, now = new Date()) {
    const today = zoneDay(now, tz);
    const month = today.slice(0, 7);
    const shop = await one(`SELECT comp_until::text AS comp_until FROM assistant_shops WHERE install_id = $1 AND shop_ref = $2`, [installId, shopRef]);
    const comp = Boolean(shop?.comp_until && shop.comp_until >= today);
    const k = key ? checkKey(key, shopRef, today) : { ok: false, why: "no key" };
    const row = await one(`SELECT calls, bonus, free_reads FROM assistant_usage WHERE install_id = $1 AND shop_ref = $2 AND month = $3`, [installId, shopRef, month]);
    return { month, today, entitled: comp || k.ok, why: comp ? null : k.ok ? null : k.why, calls: row?.calls ?? 0, bonus: row?.bonus ?? 0, freeReads: row?.free_reads ?? 0 };
  }
  const out = (p) => ({ month: p.month, entitled: p.entitled, calls: p.calls, limit: MONTHLY_CALLS + p.bonus, topUps: p.bonus / TOPUP_CALLS, freeReads: p.freeReads, freeReadsLimit: FREE_READS, reason: p.why });

  member.get("/assistant/usage", async (c) => {
    const shopRef = str(c.req.query("shopRef"), 64);
    const tz = str(c.req.query("tz"), 64) ?? "UTC";
    if (!shopRef || !zoneDay(new Date(), tz)) throw fail(400, "Send shopRef and a time zone.");
    return c.json({ ...out(await position(c.get("install").id, shopRef, tz, c.req.header("x-assistant-key") ?? "", nowOf(c))), available: Boolean(anthropicKey()) });
  });

  member.post("/assistant", async (c) => {
    const installId = c.get("install").id;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw fail(400, "Send JSON.");
    const r = clean(body, fail);
    if (!anthropicKey()) throw fail(503, "The Assistant isn't set up on this hub yet.");
    if (!allow(`assistant:${installId}:${r.shopRef}`, HOURLY)) throw fail(429, `Too many Assistant calls in the last hour (${HOURLY}). Try again later.`);
    const lock = `${installId}:${r.shopRef}`;
    if (busy.has(lock)) throw fail(429, "The Assistant is still answering this company's last question.");

    const at = nowOf(c);
    const p = await position(installId, r.shopRef, r.tz, r.key, at);
    // Entitled: the paid allowance. Otherwise only the plate reader, 20 a month.
    const free = !p.entitled;
    if (free && r.feature !== "read_plate") {
      throw fail(402, p.why === "ended" ? "The Assistant subscription for this company has ended. Renew it in Settings → Modules." : "The Assistant isn't turned on for this company. An owner can add it in Settings → Modules.");
    }
    await q(
      `INSERT INTO assistant_shops (install_id, shop_ref, tz) VALUES ($1, $2, $3) ON CONFLICT (install_id, shop_ref) DO UPDATE SET tz = EXCLUDED.tz, updated_at = now()`,
      [installId, r.shopRef, r.tz],
    );
    // Count the call before making it, so two at once can't both take the last one. Refunded below if the model never answered.
    const column = free ? "free_reads" : "calls";
    const limit = free ? FREE_READS : null;
    const reserved = await one(
      `INSERT INTO assistant_usage (install_id, shop_ref, month, ${column}) VALUES ($1, $2, $3, 1)
       ON CONFLICT (install_id, shop_ref, month) DO UPDATE SET ${column} = assistant_usage.${column} + 1, updated_at = now()
       WHERE assistant_usage.${column} < ${free ? "$4" : "$4 + assistant_usage.bonus"} RETURNING ${column} AS n`,
      [installId, r.shopRef, p.month, free ? limit : MONTHLY_CALLS],
    );
    if (!reserved) {
      throw fail(402, free ? `You've used this month's ${FREE_READS} free plate reads. The Assistant module adds more.` : `You've used this month's ${MONTHLY_CALLS + p.bonus} Assistant calls. They start again with next month, or an owner can add ${TOPUP_CALLS} more.`);
    }
    const refund = () => q(`UPDATE assistant_usage SET ${column} = greatest(0, ${column} - 1) WHERE install_id = $1 AND shop_ref = $2 AND month = $3`, [installId, r.shopRef, p.month]).catch(() => {});

    busy.add(lock);
    const started = Date.now();
    const model = modelFor(r.cls);
    let result = null;
    let error = null;
    let status = 502;
    try {
      const messages = r.messages.map((m, i) =>
        i === r.messages.length - 1 && r.image
          ? { role: "user", content: [{ type: "image", source: { type: "base64", media_type: r.image.mediaType, data: r.image.data } }, { type: "text", text: m.content }] }
          : m,
      );
      const payload = { model, max_tokens: r.maxTokens, messages };
      if (r.system) payload.system = [{ type: "text", text: r.system, cache_control: { type: "ephemeral" } }];
      const call = async () => {
        const res = await fetch(MESSAGES_URL(), {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": anthropicKey(), "anthropic-version": "2023-06-01" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(CLASSES[r.cls].timeoutMs),
        });
        return res;
      };
      let res = await call().catch((e) => ({ networkError: e }));
      if (res.networkError || res.status === 429 || res.status >= 500) {
        await new Promise((ok) => setTimeout(ok, 400));
        res = await call().catch((e) => ({ networkError: e }));
      }
      if (res.networkError) {
        error = res.networkError?.name === "TimeoutError" ? "timeout" : "unreachable";
        status = 504;
      } else if (!res.ok) {
        error = `anthropic ${res.status}`;
        status = res.status === 429 ? 503 : 502;
      } else {
        result = await res.json().catch(() => null);
        if (!result || !Array.isArray(result.content)) {
          error = "bad answer";
          result = null;
        }
      }
    } finally {
      busy.delete(lock);
    }
    const ms = Date.now() - started;
    const usage = result?.usage ?? {};
    const tokens = { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
    const cost = result ? costMillicents(model, tokens) : 0;
    await tx(async (client) => {
      await client.query(
        `INSERT INTO assistant_calls (id, install_id, shop_ref, feature, class, model, free, input_tokens, cache_tokens, output_tokens, cost_millicents, ms, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [newId(), installId, r.shopRef, r.feature, r.cls, model, free, tokens.input, tokens.cacheRead + tokens.cacheWrite, tokens.output, cost, ms, error],
      );
      if (result) {
        await client.query(
          `UPDATE assistant_usage SET input_tokens = input_tokens + $4, output_tokens = output_tokens + $5, cost_millicents = cost_millicents + $6 WHERE install_id = $1 AND shop_ref = $2 AND month = $3`,
          [installId, r.shopRef, p.month, tokens.input + tokens.cacheRead + tokens.cacheWrite, tokens.output, cost],
        );
      }
    }).catch((e) => console.error("assistant log:", e.message));
    if (!result) {
      console.error(`assistant: ${r.feature} for ${r.shopRef} failed (${error})`);
      await refund();
      throw fail(status, error === "timeout" ? "The Assistant took too long to answer. Try again." : "The Assistant couldn't answer just now. Try again in a minute.");
    }
    const text = result.content.filter((b) => b?.type === "text").map((b) => b.text).join("");
    const now = await position(installId, r.shopRef, r.tz, r.key, at);
    return c.json({
      text,
      stopReason: result.stop_reason ?? null,
      usage: { input: tokens.input, cacheRead: tokens.cacheRead, output: tokens.output },
      costMillicents: cost,
      model,
      free,
      ...out(now),
    });
  });

  // ----- the owner's view and top-ups -----
  // The owner's view (public/admin.html, Assistant): every company with usage in the month (default: this month in UTC) or a comp,
  // with its limit (300 + top-ups), what it cost, and its comp. Counts and money only: the hub keeps no text.
  admin.get("/assistant/usage", async (c) => {
    const month = String(c.req.query("month") ?? "").trim() || nowOf(c).toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw fail(400, "month is YYYY-MM.");
    const rows = (
      await q(
        `WITH pairs AS (
           SELECT install_id, shop_ref FROM assistant_usage WHERE month = $1
           UNION SELECT install_id, shop_ref FROM assistant_shops WHERE comp_until IS NOT NULL
         )
         SELECT p.install_id, i.name AS install_name, p.shop_ref, s.name AS shop_name, $1::text AS month,
                COALESCE(u.calls, 0) AS calls, COALESCE(u.bonus, 0) AS bonus, COALESCE(u.free_reads, 0) AS free_reads,
                COALESCE(u.input_tokens, 0) AS input_tokens, COALESCE(u.output_tokens, 0) AS output_tokens, COALESCE(u.cost_millicents, 0) AS cost_millicents,
                a.comp_until::text AS comp_until, a.comp_note, COALESCE(a.tz, 'UTC') AS tz
         FROM pairs p
         JOIN installs i ON i.id = p.install_id
         LEFT JOIN shops s ON s.install_id = p.install_id AND s.shop_ref = p.shop_ref
         LEFT JOIN assistant_usage u ON u.install_id = p.install_id AND u.shop_ref = p.shop_ref AND u.month = $1
         LEFT JOIN assistant_shops a ON a.install_id = p.install_id AND a.shop_ref = p.shop_ref
         ORDER BY COALESCE(u.cost_millicents, 0) DESC, s.name NULLS LAST, p.shop_ref LIMIT 500`,
        [month],
      )
    ).rows;
    const at = nowOf(c);
    return c.json({
      monthlyCalls: MONTHLY_CALLS,
      topUpCalls: TOPUP_CALLS,
      month,
      rows: rows.map((r) => ({ ...r, limit: MONTHLY_CALLS + r.bonus, comped: Boolean(r.comp_until && r.comp_until >= zoneDay(at, r.tz)) })),
    });
  });

  // The latest failed calls (a refusal, the model's 5xx, a timeout): what went wrong and for whom, never any text.
  admin.get("/assistant/errors", async (c) => {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(c.req.query("limit"))) || 50));
    const rows = (
      await q(
        `SELECT k.id, k.install_id, i.name AS install_name, k.shop_ref, s.name AS shop_name, k.feature, k.class, k.model, k.error, k.ms, k.created_at
         FROM assistant_calls k JOIN installs i ON i.id = k.install_id LEFT JOIN shops s ON s.install_id = k.install_id AND s.shop_ref = k.shop_ref
         WHERE k.error IS NOT NULL ORDER BY k.created_at DESC LIMIT $1`,
        [limit],
      )
    ).rows;
    return c.json({ rows });
  });

  // Another 300 calls for this month (the month in the company's zone as last seen). `calls` overrides the amount.
  admin.post("/assistant/topup", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const installId = str(b.installId, 64);
    const shopRef = str(b.shopRef, 64);
    if (!installId || !shopRef) throw fail(400, "Send installId and shopRef.");
    const calls = b.calls === undefined ? TOPUP_CALLS : b.calls;
    if (!Number.isInteger(calls) || calls < 1 || calls > 5000) throw fail(400, "calls is a whole number from 1 to 5000.");
    const inst = await one(`SELECT id FROM installs WHERE id = $1`, [installId]);
    if (!inst) throw fail(404, "No such install.");
    const r = await creditTopup(q, installId, shopRef, calls, nowOf(c));
    return c.json({ ok: true, ...r });
  });

  // "Assistant free until <day>" (the admin's comp: the Assistant without a key); an empty `until` takes it away.
  admin.post("/assistant/comp", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const installId = str(b.installId, 64);
    const shopRef = str(b.shopRef, 64);
    if (!installId || !shopRef) throw fail(400, "Send installId and shopRef.");
    const until = b.until ? String(b.until) : null;
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw fail(400, "Give the last free day as YYYY-MM-DD.");
    if (!(await one(`SELECT id FROM installs WHERE id = $1`, [installId]))) throw fail(404, "No such install.");
    await q(
      `INSERT INTO assistant_shops (install_id, shop_ref, comp_until, comp_note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (install_id, shop_ref) DO UPDATE SET comp_until = EXCLUDED.comp_until, comp_note = EXCLUDED.comp_note, updated_at = now()`,
      [installId, shopRef, until, until ? str(b.note, 300) : null],
    );
    return c.json({ ok: true });
  });
}
