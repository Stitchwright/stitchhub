// Hub sync v2 (docs/hub-sync-design.md): a version handshake and a durable, acknowledged queue of messages between programs and
// services, with expiry, caps and a notice to the sender when a message gives up. Polling only; no new infrastructure.
//
//   GET    /v2/hello                         the hub's side of the handshake (public): version, min_client, types, limits
//   POST   /v2/hello   { app, version, types }   a program or service says what it understands (under its key)
//   PUT    /v2/optin   { service, enabled, maxOpen?, perMinute? }   a shop (program) takes orders from a service, or stops
//   GET    /v2/optin   ?service                  the shop's own opt-in
//   GET    /v2/shops                             a service: the shops that opted in to it
//   POST   /v2/messages  { id, type, version, conversation, seq, to, created_at, expires_at?, body, sig? }   -> 202
//   GET    /v2/messages  ?after&limit&wait       the oldest unacknowledged messages for the caller
//   POST   /v2/messages/ack { ids }              the caller applied them
//   GET    /v2/messages/status ?ids              the sender: where each of its messages is
//   Admin: POST/GET /v1/admin/service-keys, DELETE /v1/admin/service-keys/:id, PUT /v1/admin/service-keys/:id/public-key,
//          GET /v1/admin/sync/summary
//
// Every /v2 call after the hello carries X-Client: <app>/<version>; below the minimum for that app the answer is 426.
// Callers: a program (install key + X-Shop-Ref, or ?shopRef) or a service (a key the admin issued, svk_...).
// Settings (names only): SYNC_MIN_CLIENT (JSON {app: "x.y.z"}), SYNC_DEPRECATED (JSON {path prefix: "YYYY-MM-DD"}), SYNC_UPDATE_URL,
// SYNC_QUEUE_MESSAGES, SYNC_QUEUE_MB, SYNC_BODY_KB, SYNC_KEEP_DAYS, SYNC_SKEW_MIN, SYNC_SWEEP_MS.
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q, tx } from "./db.mjs";
import { TYPES, hubTypes } from "./sync-types.mjs";

const HUB_VERSION = "2.0.0";
const posNum = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
export const queueMessages = () => Math.floor(posNum(process.env.SYNC_QUEUE_MESSAGES, 1000));
export const queueBytes = () => Math.round(posNum(process.env.SYNC_QUEUE_MB, 64) * 1024 * 1024);
export const bodyBytes = () => Math.round(posNum(process.env.SYNC_BODY_KB, 256) * 1024);
export const keepDays = () => posNum(process.env.SYNC_KEEP_DAYS, 30);
const skewMs = () => posNum(process.env.SYNC_SKEW_MIN, 10) * 60_000;
const STUB_DAYS = 365;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^([a-z0-9-]{1,30})\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,30})?)$/;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

class Refusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const jsonEnv = (name) => {
  try {
    const v = JSON.parse(process.env[name] ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const versionParts = (v) => String(v).split(/[-+]/)[0].split(".").map((n) => Number(n) || 0);
/** True when version a is older than version b (x.y.z; a pre-release suffix is ignored). */
export function olderThan(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** A UUID made from a text (version 5 style): the same text, the same id. */
function uuidFrom(text) {
  const h = crypto.createHash("sha1").update(text).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const kindOf = (address) => (address === "hub" ? "hub" : address.startsWith("shop:") ? "shop" : address.startsWith("service:") ? "service" : null);

export function registerSync({ app, admin, installByKey, fail, newId, allow, clientIp }) {
  const route = (fn) => async (c) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof Refusal) return c.json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  };

  // ----- the client and its version -----
  function checkClient(c, { required }) {
    const raw = c.req.header("x-client") ?? "";
    const m = CLIENT.exec(raw.trim());
    if (!m) {
      if (required) throw new Refusal(400, "client_header", "Send X-Client: <app>/<version> (for example stitchbench/1.8.0).");
      return null;
    }
    const min = jsonEnv("SYNC_MIN_CLIENT")[m[1]];
    if (typeof min === "string" && olderThan(m[2], min)) {
      throw Object.assign(new Refusal(426, "upgrade_required", `StitchHub needs a newer ${m[1]} (${min} or later). Please update.`), { min, updateUrl: process.env.SYNC_UPDATE_URL || null });
    }
    return { app: m[1], version: m[2] };
  }
  app.use("/v2/*", async (c, next) => {
    await next();
    const dep = jsonEnv("SYNC_DEPRECATED");
    for (const [prefix, date] of Object.entries(dep)) {
      if (c.req.path.startsWith(prefix)) {
        c.res.headers.set("Deprecation", "true");
        c.res.headers.set("Sunset", new Date(`${date}T00:00:00Z`).toUTCString());
      }
    }
  });
  const upgrade426 = (c, e) => c.json({ error: e.message, code: e.code, min: e.min, update_url: e.updateUrl }, 426);
  const guarded = (fn) => route(async (c) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof Refusal && e.status === 426) return upgrade426(c, e);
      throw e;
    }
  });

  // ----- who is calling -----
  async function principalOf(c, body = null) {
    const h = c.req.header("authorization") ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!allow(`sync:ip:${clientIp(c)}`, 3000)) throw new Refusal(429, "rate_limit", "Too many requests from this address. Try again later.");
    if (key.startsWith("svk_")) {
      const row = await one(`SELECT id, name, scopes, public_key, revoked_at FROM service_keys WHERE key_hash = $1`, [sha(key)]);
      if (!row || row.revoked_at) throw new Refusal(401, "bad_key", "That service key isn't known or was revoked.");
      q(`UPDATE service_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, [row.id]).catch(() => {});
      return { kind: "service", address: `service:${row.name}`, name: row.name, scopes: row.scopes ?? [], caps: `service:${row.name}`, publicKey: row.public_key };
    }
    const inst = await installByKey(key);
    const ref = (c.req.header("x-shop-ref") ?? c.req.query("shopRef") ?? body?.shopRef ?? "").toString().trim().slice(0, 64);
    const shop = ref ? await one(`SELECT id, name FROM shops WHERE install_id = $1 AND shop_ref = $2`, [inst.id, ref]) : null;
    return { kind: "program", install: inst, shop, address: shop ? `shop:${shop.id}` : null, caps: `install:${inst.id}` };
  }
  const needShop = (p) => {
    if (!p.shop) throw new Refusal(404, "no_shop", "Name the company (X-Shop-Ref); it has to have told the hub about itself first.");
    return p;
  };
  const needScope = (p, scope) => {
    if (p.kind === "service" && !p.scopes.includes(scope)) throw new Refusal(403, "scope", `This service key may not do that (needs ${scope}).`);
  };

  // ----- what the recipient understands -----
  async function capsOf(recipient) {
    const principal = recipient.startsWith("shop:")
      ? (await one(`SELECT install_id FROM shops WHERE id = $1`, [recipient.slice(5)]).then((r) => (r ? `install:${r.install_id}` : null)))
      : recipient;
    return principal ? await one(`SELECT types FROM sync_caps WHERE principal = $1`, [principal]) : null;
  }
  const understands = (caps, type, version) => Boolean(caps && Array.isArray(caps.types?.[type]) && caps.types[type].includes(version));

  // ----- the handshake -----
  const hello = () => ({
    hub: HUB_VERSION,
    min_client: jsonEnv("SYNC_MIN_CLIENT"),
    types: hubTypes(),
    deprecated: Object.entries(jsonEnv("SYNC_DEPRECATED")).map(([route, sunset]) => ({ route, sunset })),
    limits: { body_bytes: bodyBytes(), queue_messages: queueMessages(), queue_bytes: queueBytes() },
  });
  app.get("/v2/hello", guarded(async (c) => {
    checkClient(c, { required: false });
    return c.json(hello());
  }));
  app.post("/v2/hello", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) }), guarded(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const p = await principalOf(c, body);
    const app_ = String(body.app ?? "");
    const version = String(body.version ?? "");
    if (!/^[a-z0-9-]{1,30}$/.test(app_) || !CLIENT.test(`${app_}/${version}`)) throw new Refusal(400, "bad_hello", "Send { app, version, types }: app like stitchbench, version like 1.8.0.");
    const min = jsonEnv("SYNC_MIN_CLIENT")[app_];
    if (typeof min === "string" && olderThan(version, min)) throw Object.assign(new Refusal(426, "upgrade_required", `StitchHub needs a newer ${app_} (${min} or later). Please update.`), { min, updateUrl: process.env.SYNC_UPDATE_URL || null });
    const types = {};
    if (body.types && typeof body.types === "object" && !Array.isArray(body.types)) {
      for (const [t, vs] of Object.entries(body.types).slice(0, 100)) {
        if (/^[a-z]{2,20}(\.[a-z]{2,20})?$/.test(t) && Array.isArray(vs)) types[t] = vs.filter((v) => Number.isInteger(v) && v >= 1 && v <= 99).slice(0, 10);
      }
    }
    if (p.kind === "program" && !allow(`sync:hello:${p.install.id}`, 600)) throw new Refusal(429, "rate_limit", "Too many hellos. Say hello when the program starts or reconnects, not on every call.");
    await q(
      `INSERT INTO sync_caps (principal, app, version, types, hello_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (principal) DO UPDATE SET app = EXCLUDED.app, version = EXCLUDED.version, types = EXCLUDED.types, hello_at = now()`,
      [p.caps, app_, version, JSON.stringify(types)],
    );
    const released = await releaseHeld(p);
    return c.json({ ...hello(), released });
  }));
  /** A hello may teach the hub that a recipient now understands what was held for it: those go back in the queue. */
  async function releaseHeld(p) {
    const recipients = p.kind === "service" ? [p.address] : (await q(`SELECT id FROM shops WHERE install_id = $1`, [p.install.id])).rows.map((r) => `shop:${r.id}`);
    if (!recipients.length) return 0;
    const caps = await one(`SELECT types FROM sync_caps WHERE principal = $1`, [p.caps]);
    const { rows } = await q(
      `SELECT d.delivery_seq, m.type, m.version FROM sync_deliveries d JOIN sync_messages m ON m.sender = d.sender AND m.id = d.message_id
       WHERE d.recipient = ANY($1) AND d.state = 'held_capability'`,
      [recipients],
    );
    const ready = rows.filter((r) => understands(caps, r.type, r.version)).map((r) => r.delivery_seq);
    if (ready.length) await q(`UPDATE sync_deliveries SET state = 'queued' WHERE delivery_seq = ANY($1::bigint[])`, [ready]);
    return ready.length;
  }

  // ----- shops opt in -----
  const knownService = async (name) => Boolean(await one(`SELECT 1 FROM service_keys WHERE name = $1 AND revoked_at IS NULL`, [name]));
  app.put("/v2/optin", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "Too large." }, 413) }), guarded(async (c) => {
    checkClient(c, { required: true });
    const body = await c.req.json().catch(() => ({}));
    const p = needShop(await principalOf(c, body));
    if (p.kind !== "program") throw new Refusal(403, "program_only", "A shop's program sets its own opt-in.");
    const service = String(body.service ?? "");
    if (!(await knownService(service))) throw new Refusal(404, "unknown_service", "That service isn't set up on this hub.");
    const enabled = body.enabled !== false;
    const maxOpen = Number.isInteger(body.maxOpen) ? Math.min(Math.max(body.maxOpen, 1), 10_000) : null;
    const perMinute = Number.isInteger(body.perMinute) ? Math.min(Math.max(body.perMinute, 1), 1000) : null;
    const row = (
      await q(
        `INSERT INTO shop_service_optins (shop_id, service, enabled, max_open, per_minute) VALUES ($1, $2, $3, coalesce($4, 200), coalesce($5, 50))
         ON CONFLICT (shop_id, service) DO UPDATE SET enabled = EXCLUDED.enabled, max_open = coalesce($4, shop_service_optins.max_open), per_minute = coalesce($5, shop_service_optins.per_minute), updated_at = now()
         RETURNING enabled, max_open, per_minute`,
        [p.shop.id, service, enabled, maxOpen, perMinute],
      )
    ).rows[0];
    return c.json({ service, enabled: row.enabled, maxOpen: row.max_open, perMinute: row.per_minute });
  }));
  app.get("/v2/optin", guarded(async (c) => {
    checkClient(c, { required: true });
    const p = needShop(await principalOf(c));
    if (p.kind !== "program") throw new Refusal(403, "program_only", "A shop's program reads its own opt-in.");
    const service = String(c.req.query("service") ?? "");
    const row = await one(`SELECT enabled, max_open, per_minute FROM shop_service_optins WHERE shop_id = $1 AND service = $2`, [p.shop.id, service]);
    return c.json(row ? { service, enabled: row.enabled, maxOpen: row.max_open, perMinute: row.per_minute } : { service, enabled: false });
  }));
  app.get("/v2/shops", guarded(async (c) => {
    checkClient(c, { required: true });
    const p = await principalOf(c);
    if (p.kind !== "service") throw new Refusal(403, "service_only", "Only a service lists the shops that opted in to it.");
    needScope(p, "shops:list");
    const { rows } = await q(
      `SELECT s.id, s.name FROM shop_service_optins o JOIN shops s ON s.id = o.shop_id JOIN installs i ON i.id = s.install_id
       WHERE o.service = $1 AND o.enabled AND NOT i.blocked ORDER BY s.name LIMIT 500`,
      [p.name],
    );
    const out = [];
    for (const r of rows) out.push({ id: `shop:${r.id}`, name: r.name, ready: understands(await capsOf(`shop:${r.id}`), "order.placed", 1) });
    return c.json({ shops: out });
  }));

  // ----- sending -----
  /** Who may send what to whom. Returns the opt-in row when one decides it. */
  async function mayRoute(client, sender, recipient, type) {
    const spec = TYPES[type];
    const sk = kindOf(sender);
    const rk = kindOf(recipient);
    if (!spec || (spec.from !== "any" && spec.from !== sk) || (spec.from === "any" && sk === "hub")) throw new Refusal(403, "not_allowed", `A ${sk} may not send ${type}.`);
    if (spec.to !== "any" && spec.to !== rk) throw new Refusal(403, "not_allowed", `${type} is not sent to a ${rk}.`);
    if (sk === "hub") return null;
    if (sk === "service" && rk === "shop") {
      const o = await client.query(`SELECT enabled, max_open, per_minute FROM shop_service_optins WHERE shop_id = $1 AND service = $2`, [recipient.slice(5), sender.slice(8)]);
      if (!o.rows[0]?.enabled) throw new Refusal(403, "not_opted_in", "That shop doesn't take orders from this service.");
      return o.rows[0];
    }
    if (sk === "shop" && rk === "service") {
      const o = await client.query(`SELECT 1 FROM shop_service_optins WHERE shop_id = $1 AND service = $2`, [sender.slice(5), recipient.slice(8)]);
      if (!o.rows[0]) throw new Refusal(403, "not_opted_in", "This shop hasn't opted in to that service.");
      return null;
    }
    throw new Refusal(403, "not_allowed", "That route isn't open.");
  }

  function validateEnvelope(env, p) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Refusal(400, "bad_envelope", "Send the message envelope as a JSON object.");
    if (!UUID.test(String(env.id ?? ""))) throw new Refusal(400, "bad_id", "id has to be a UUID the sender made.");
    const type = String(env.type ?? "");
    const spec = TYPES[type];
    if (!spec) throw new Refusal(400, "unknown_type", `The hub doesn't carry a message of type "${type.slice(0, 40)}".`);
    if (!Number.isInteger(env.version) || !spec.versions.includes(env.version)) throw new Refusal(400, "unknown_version", `${type} has versions ${spec.versions.join(", ")}.`);
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(String(env.conversation ?? ""))) throw new Refusal(400, "bad_conversation", "conversation is 1 to 120 letters, digits and . _ : -");
    if (!Number.isInteger(env.seq) || env.seq < 1 || env.seq > 1_000_000) throw new Refusal(400, "bad_seq", "seq counts from 1, per sender per conversation.");
    if (env.from !== undefined && env.from !== p.address) throw new Refusal(403, "bad_from", "from has to be the caller's own address.");
    const to = String(env.to ?? "");
    if (!kindOf(to) || to === "hub") throw new Refusal(400, "bad_to", "to is shop:<id> or service:<name>.");
    const created = Date.parse(String(env.created_at ?? ""));
    if (!Number.isFinite(created) || Math.abs(Date.now() - created) > skewMs()) throw new Refusal(400, "bad_time", "created_at has to be the current time (within 10 minutes), to refuse a replayed message.");
    const longest = Date.now() + spec.days * 86_400_000;
    let expires = longest;
    if (env.expires_at !== undefined) {
      const e = Date.parse(String(env.expires_at));
      if (!Number.isFinite(e) || e <= Date.now()) throw new Refusal(400, "bad_expiry", "expires_at has to be in the future.");
      expires = Math.min(e, longest);
    }
    if (typeof env.body !== "object" || env.body === null || Array.isArray(env.body)) throw new Refusal(400, "bad_body", "body is a JSON object.");
    const json = JSON.stringify(env.body);
    const bytes = Buffer.byteLength(json);
    if (bytes > bodyBytes()) throw new Refusal(413, "body_too_large", `A message body may be ${bodyBytes()} bytes at most; send files by signed address.`);
    if (env.sig !== undefined && env.sig !== null && (typeof env.sig !== "object" || JSON.stringify(env.sig).length > 2048)) throw new Refusal(400, "bad_sig", "sig is a small object.");
    return { type, spec, to, created: new Date(created), expires: new Date(expires), json, bytes };
  }

  app.post("/v2/messages", bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) }), guarded(async (c) => {
    checkClient(c, { required: true });
    const env = await c.req.json().catch(() => null);
    const p = await principalOf(c, env);
    if (p.kind === "program") needShop(p);
    if (p.kind === "service") needScope(p, "orders:send");
    const m = validateEnvelope(env, p);
    const out = await tx(async (cl) => {
      await cl.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sync:${m.to}`]);
      const recipientOk = m.to.startsWith("shop:")
        ? await cl.query(`SELECT s.id FROM shops s JOIN installs i ON i.id = s.install_id WHERE s.id = $1 AND NOT i.blocked`, [m.to.slice(5)])
        : await cl.query(`SELECT id FROM service_keys WHERE name = $1 AND revoked_at IS NULL`, [m.to.slice(8)]);
      if (!recipientOk.rows[0]) throw new Refusal(404, "unknown_recipient", "The hub doesn't know that recipient.");
      const optin = await mayRoute(cl, p.address, m.to, m.type);
      const sha256 = sha(m.json);
      const had = (await cl.query(`SELECT body_sha256, type FROM sync_messages WHERE sender = $1 AND id = $2`, [p.address, env.id])).rows[0];
      if (had) {
        if (had.body_sha256 !== sha256 || had.type !== m.type) throw new Refusal(409, "id_reused", "That id was used for a different message.");
        return { duplicate: true, state: (await cl.query(`SELECT state FROM sync_deliveries WHERE sender = $1 AND message_id = $2 AND recipient = $3`, [p.address, env.id, m.to])).rows[0]?.state ?? "queued" };
      }
      const open = (await cl.query(
        `SELECT count(*)::int AS n, coalesce(sum(m.body_bytes), 0)::bigint AS bytes FROM sync_deliveries d JOIN sync_messages m ON m.sender = d.sender AND m.id = d.message_id
         WHERE d.recipient = $1 AND d.state IN ('queued', 'held_capability', 'delivered')`,
        [m.to],
      )).rows[0];
      if (open.n >= queueMessages() || Number(open.bytes) + m.bytes > queueBytes()) throw new Refusal(429, "recipient_queue_full", "That recipient's queue is full. Try again when it has caught up; nothing was dropped.");
      const perMinute = optin?.per_minute ?? 50;
      const recent = (await cl.query(`SELECT count(*)::int AS n FROM sync_messages m JOIN sync_deliveries d ON d.sender = m.sender AND d.message_id = m.id WHERE m.sender = $1 AND d.recipient = $2 AND m.stored_at > now() - interval '1 minute'`, [p.address, m.to])).rows[0].n;
      if (recent >= perMinute) throw new Refusal(429, "rate_limit", `At most ${perMinute} messages a minute to that recipient.`);
      const taken = (await cl.query(`SELECT 1 FROM sync_messages WHERE sender = $1 AND conversation = $2 AND seq = $3`, [p.address, env.conversation, env.seq])).rows[0];
      if (taken) throw new Refusal(409, "seq_taken", "That seq is already used in this conversation by another message.");
      await cl.query(
        `INSERT INTO sync_messages (sender, id, type, version, conversation, seq, created_at, expires_at, body, body_sha256, body_bytes, sig)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.address, env.id, m.type, env.version, env.conversation, env.seq, m.created, m.expires, m.json, sha256, m.bytes, env.sig ? JSON.stringify(env.sig) : null],
      );
      const caps = await capsOf(m.to);
      const state = understands(caps, m.type, env.version) ? "queued" : "held_capability";
      await cl.query(`INSERT INTO sync_deliveries (sender, message_id, recipient, state) VALUES ($1, $2, $3, $4)`, [p.address, env.id, m.to, state]);
      return { duplicate: false, state };
    });
    return c.json({ queued: true, duplicate: out.duplicate, state: out.state }, 202);
  }));

  // ----- receiving -----
  async function drain(recipient, after, limit) {
    return tx(async (cl) => {
      const { rows } = await cl.query(
        `SELECT d.delivery_seq, d.state, m.sender, m.id, m.type, m.version, m.conversation, m.seq, m.created_at, m.expires_at, m.body, m.sig
         FROM sync_deliveries d JOIN sync_messages m ON m.sender = d.sender AND m.id = d.message_id
         WHERE d.recipient = $1 AND d.delivery_seq > $2 AND d.state IN ('queued', 'delivered')
           AND NOT EXISTS (
             SELECT 1 FROM sync_deliveries d2 JOIN sync_messages m2 ON m2.sender = d2.sender AND m2.id = d2.message_id
             WHERE d2.recipient = d.recipient AND m2.sender = m.sender AND m2.conversation = m.conversation AND m2.seq < m.seq AND d2.state IN ('queued', 'held_capability'))
         ORDER BY d.delivery_seq LIMIT $3`,
        [recipient, after, limit],
      );
      const fresh = rows.filter((r) => r.state === "queued").map((r) => r.delivery_seq);
      if (fresh.length) await cl.query(`UPDATE sync_deliveries SET state = 'delivered', delivered_at = now() WHERE delivery_seq = ANY($1::bigint[])`, [fresh]);
      return rows;
    });
  }
  app.get("/v2/messages", guarded(async (c) => {
    checkClient(c, { required: true });
    const p = await principalOf(c);
    if (p.kind === "program") needShop(p);
    const caps = await one(`SELECT 1 FROM sync_caps WHERE principal = $1`, [p.caps]);
    if (!caps) throw new Refusal(409, "hello_first", "Say hello (POST /v2/hello) before asking for messages.");
    const after = /^\d+$/.test(c.req.query("after") ?? "") ? c.req.query("after") : "0";
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const wait = Math.min(Math.max(Number(c.req.query("wait")) || 0, 0), 25);
    let rows = await drain(p.address, after, limit);
    for (let waited = 0; !rows.length && waited < wait; waited++) {
      await new Promise((r) => setTimeout(r, 1000));
      rows = await drain(p.address, after, limit);
    }
    return c.json({
      messages: rows.map((r) => ({ id: r.id, from: r.sender, to: p.address, type: r.type, version: r.version, conversation: r.conversation, seq: r.seq, created_at: r.created_at, expires_at: r.expires_at, body: r.body, sig: r.sig, delivery_seq: String(r.delivery_seq) })),
      next: rows.length ? String(rows[rows.length - 1].delivery_seq) : after,
    });
  }));
  app.post("/v2/messages/ack", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) }), guarded(async (c) => {
    checkClient(c, { required: true });
    const body = await c.req.json().catch(() => ({}));
    const p = await principalOf(c, body);
    if (p.kind === "program") needShop(p);
    const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === "string" && UUID.test(i)).slice(0, 200) : [];
    if (!ids.length) throw new Refusal(400, "bad_ids", "Send { ids: [...] }, the message ids you applied.");
    const r = await q(`UPDATE sync_deliveries SET state = 'acked', acked_at = now() WHERE recipient = $1 AND message_id = ANY($2) AND state = 'delivered'`, [p.address, ids]);
    return c.json({ acked: r.rowCount });
  }));
  app.get("/v2/messages/status", guarded(async (c) => {
    checkClient(c, { required: true });
    const p = await principalOf(c);
    if (p.kind === "program") needShop(p);
    const ids = String(c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 100);
    const { rows } = await q(`SELECT message_id, recipient, state, delivered_at, acked_at, expired_at FROM sync_deliveries WHERE sender = $1 AND message_id = ANY($2)`, [p.address, ids]);
    return c.json({ messages: rows.map((r) => ({ id: r.message_id, to: r.recipient, state: r.state, delivered_at: r.delivered_at, acked_at: r.acked_at, expired_at: r.expired_at })) });
  }));

  // ----- expiry, erasing bodies, and deleting old stubs -----
  /** Gives up on what is past its time and tells each sender; erases acked bodies after SYNC_KEEP_DAYS; deletes stubs after a year. */
  async function sweepOnce() {
    const expired = (
      await q(
        `UPDATE sync_deliveries d SET state = 'expired', expired_at = now() FROM sync_messages m
         WHERE m.sender = d.sender AND m.id = d.message_id AND m.expires_at <= now() AND d.state IN ('queued', 'delivered', 'held_capability')
         RETURNING d.sender, d.message_id, d.recipient, m.type, m.version, m.conversation`,
      )
    ).rows;
    for (const e of expired) {
      await q(`UPDATE sync_messages SET body = NULL WHERE sender = $1 AND id = $2`, [e.sender, e.message_id]);
      if (e.sender === "hub") continue;
      // Why it gave up: the recipient never said it understands this type (it needs updating), or it was just slow.
      const reason = understands(await capsOf(e.recipient), e.type, e.version) ? "expired" : "recipient_too_old";
      await tx(async (cl) => {
        await cl.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sync:hub:${e.conversation}`]);
        const body = JSON.stringify({ id: e.message_id, type: e.type, conversation: e.conversation, to: e.recipient, reason });
        const noticeId = uuidFrom(`expired:${e.sender}:${e.message_id}`); // the same notice for the same message, and an id a receiver can ack
        const seq = (await cl.query(`SELECT coalesce(max(seq), 0)::int + 1 AS n FROM sync_messages WHERE sender = 'hub' AND conversation = $1`, [e.conversation])).rows[0].n;
        const made = await cl.query(
          `INSERT INTO sync_messages (sender, id, type, version, conversation, seq, created_at, expires_at, body, body_sha256, body_bytes)
           VALUES ('hub', $1, 'message.expired', 1, $2, $3, now(), now() + interval '30 days', $4, $5, $6) ON CONFLICT (sender, id) DO NOTHING RETURNING id`,
          [noticeId, e.conversation, seq, body, sha(body), Buffer.byteLength(body)],
        );
        if (made.rowCount) {
          const state = understands(await capsOf(e.sender), "message.expired", 1) ? "queued" : "held_capability";
          await cl.query(`INSERT INTO sync_deliveries (sender, message_id, recipient, state) VALUES ('hub', $1, $2, $3)`, [noticeId, e.sender, state]);
        }
      });
    }
    await q(
      `UPDATE sync_messages m SET body = NULL FROM sync_deliveries d
       WHERE d.sender = m.sender AND d.message_id = m.id AND d.state = 'acked' AND d.acked_at < now() - make_interval(days => $1) AND m.body IS NOT NULL`,
      [keepDays()],
    );
    await q(`UPDATE sync_messages m SET body = NULL FROM sync_deliveries d WHERE d.sender = m.sender AND d.message_id = m.id AND d.state = 'expired' AND m.body IS NOT NULL`);
    await q(`DELETE FROM sync_messages WHERE stored_at < now() - make_interval(days => $1)`, [STUB_DAYS]);
    return expired.length;
  }
  const sweepMs = Math.min(posNum(process.env.SYNC_SWEEP_MS, 60_000), 2 ** 31 - 1);
  const sweepSoon = () => sweepOnce().catch((e) => console.error("sync sweep:", e.message));
  setInterval(sweepSoon, sweepMs).unref();

  // ----- the admin: service keys, and what the queue holds -----
  admin.post("/service-keys", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "");
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw fail(400, "name is lower-case letters, digits and -, for example makerfoundry.");
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s) => ["orders:send", "shops:list"].includes(s)) : ["orders:send", "shops:list"];
    if (await one(`SELECT 1 FROM service_keys WHERE name = $1`, [name])) throw fail(409, "A service with that name exists. Revoke it and pick another name, or rotate by revoking and issuing again under a new name.");
    const key = `svk_${crypto.randomBytes(32).toString("hex")}`;
    const id = newId();
    await q(`INSERT INTO service_keys (id, name, key_hash, scopes) VALUES ($1, $2, $3, $4)`, [id, name, sha(key), JSON.stringify(scopes)]);
    return c.json({ id, name, scopes, key, note: "This key is shown once. Put it in the service's secret settings." });
  });
  admin.get("/service-keys", async (c) => {
    const { rows } = await q(`SELECT id, name, scopes, (public_key IS NOT NULL) AS has_public_key, created_at, revoked_at, last_used_at FROM service_keys ORDER BY created_at`);
    return c.json({ keys: rows });
  });
  admin.delete("/service-keys/:id", async (c) => {
    const r = await q(`UPDATE service_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [c.req.param("id")]);
    return c.json({ ok: true, revoked: r.rowCount });
  });
  admin.put("/service-keys/:id/public-key", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(String(body.publicKey ?? ""), "base64"), format: "der", type: "spki" });
      if (k.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    } catch {
      throw fail(400, "publicKey is an Ed25519 public key: base64 of the SPKI DER.");
    }
    const r = await q(`UPDATE service_keys SET public_key = $2 WHERE id = $1 AND revoked_at IS NULL`, [c.req.param("id"), String(body.publicKey)]);
    if (!r.rowCount) throw fail(404, "No such service key.");
    return c.json({ ok: true });
  });
  admin.get("/sync/summary", async (c) => {
    const states = (await q(`SELECT state, count(*)::int AS n FROM sync_deliveries GROUP BY state`)).rows;
    const queues = (
      await q(
        `SELECT d.recipient, count(*)::int AS depth, min(m.stored_at) AS oldest FROM sync_deliveries d JOIN sync_messages m ON m.sender = d.sender AND m.id = d.message_id
         WHERE d.state IN ('queued', 'held_capability', 'delivered') GROUP BY d.recipient ORDER BY depth DESC LIMIT 50`,
      )
    ).rows;
    return c.json({ states: Object.fromEntries(states.map((s) => [s.state, s.n])), queues });
  });

  return { sweepOnce };
}
