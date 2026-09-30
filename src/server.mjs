// StitchHub: the community server for StitchBench.
// Installs join with the community's join key and get their own key. They pull changes (manual links, tech notes,
// figure snapshots, data sets) and push what their techs share. Manual PDFs are never stored, only links to them.
import "./env.mjs"; // first: reads .env before the modules below read their variables
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { pool, q, one, tx, migrate, getSetting, setSetting, startFeeds, feedLimit, staleCursor } from "./db.mjs";
import { startChecker, privateAddress } from "./checker.mjs";
import { exportStream, importStream } from "./transfer.mjs";
import { registerParts, partsByIds, partSizes } from "./parts.mjs";
import { registerMarket, listingsByIds, sellerBlocked } from "./market.mjs";
import { registerUsage } from "./usage.mjs";
import { registerPartners } from "./partners.mjs";
import { discordBody } from "./discord.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const HUB_NAME = process.env.HUB_NAME ?? "StitchHub";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL (a PostgreSQL database).");
if (ADMIN_TOKEN.length < 16) throw new Error("Set ADMIN_TOKEN to a long random secret (16+ characters).");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const KINDS = new Set(["GOTCHA", "TIP", "FACT"]);
const PHOTO_KINDS = new Set(["CONDITION", "INSIDE", "WIRING", "PART", "AFTER"]);

/** The keys StitchBench matches machines on: each model number, upper-case letters and digits only. */
function modelKeys(models, fileName) {
  const keys = new Set();
  const add = (s) => {
    const k = String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (k.length >= 2 && k.length <= 24 && /\d/.test(k)) keys.add(k);
  };
  for (const part of String(models ?? "").split(/[,/+;()]|\band\b|\s-\s/)) {
    add(part);
    for (const w of part.match(/[A-Za-z]*\d[\w-]*/g) ?? []) add(w);
  }
  if (!keys.size && fileName) for (const w of String(fileName).split("_").slice(1, 2)) add(w);
  if (!keys.size) {
    const k = String(models ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (k.length >= 3) keys.add(k);
  }
  return [...keys];
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function validUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Not an address inside someone's own network (the link checker won't try those, and other shops can't open them). */
function publicLink(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A test hub on this PC keeps its links on localhost (HUB_ALLOW_PRIVATE_LINKS=true); never set on a real hub.
  if (process.env.HUB_ALLOW_PRIVATE_LINKS === "true") return true;

  if (net.isIP(host)) return !privateAddress(host);
  return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

// Tell the community's Discord channel (optional: admin sets a webhook URL).
// Never fails: it's called without waiting, and a database hiccup here mustn't stop the hub.
// Use it as a template tag, notify`${shop} joined`: whatever is put in ${} came from a member and is shown as typed
// (src/discord.mjs).
async function notify(parts, ...values) {
  try {
    const hook = await getSetting("discord_webhook");
    if (!hook) return;
    fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(discordBody(parts, values)) }).catch(() => {});
  } catch (e) {
    console.error("discord:", e.message);
  }
}

// A few simple limits so one install can't flood the hub.
const buckets = new Map();
function bucket(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.since > 3600_000) buckets.set(key, (b = { n: 0, since: now }));
  return b;
}
function allow(key, perHour) {
  return ++bucket(key).n <= perHour;
}
// Hours that are over are forgotten, so addresses and installs seen once don't pile up.
setInterval(() => {
  for (const [k, b] of buckets) if (Date.now() - b.since > 3600_000) buckets.delete(k);
}, 600_000).unref();

// Where a request came from, for the limits on joining. Behind a proxy (Railway, a tunnel, a reverse proxy) set
// TRUST_PROXY=true (on Railway it's the default): the proxy's own entry, the last in X-Forwarded-For, is used, since
// anything before it is whatever the client sent. Otherwise the connection's address: a client can claim any header.
const TRUST_PROXY = (process.env.TRUST_PROXY || (process.env.RAILWAY_ENVIRONMENT_ID ? "true" : "")) === "true";
function clientIp(c) {
  if (TRUST_PROXY) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].slice(0, 64);
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

// Wrong join keys from everywhere together are limited too, so guessing from many addresses stays slow. When they run
// out, joining pauses for the rest of the hour; shops already on the hub carry on.
const WRONG_JOIN_KEYS = 100;
async function checkJoinKey(joinKey) {
  const wrong = bucket("join-key:wrong");
  if (wrong.n >= WRONG_JOIN_KEYS) throw fail(429, "Too many wrong join keys were tried lately. Try again in an hour.");
  // Compared without spaces around them: StitchBench trims what a member types, and a key pasted from an email often
  // carries one (an admin-saved key may too, from before it was trimmed on saving).
  const expected = ((await getSetting("join_key")) ?? process.env.JOIN_KEY ?? "").trim();
  const given = String(joinKey ?? "").trim();
  if (!expected || !given || !same(sha(given), sha(expected))) {
    if (++wrong.n === WRONG_JOIN_KEYS) console.warn(`join: ${WRONG_JOIN_KEYS} wrong join keys this hour; joining is paused until the hour is up`);
    throw fail(403, "That join key isn't right. Ask the hub admin for the current one.");
  }
}

const app = new Hono();

app.onError((e, c) => {
  console.error(e);
  return c.json(
    { error: e.expose ? e.message : "Something went wrong on the hub.", ...(e.linkId ? { linkId: e.linkId } : {}), ...(e.partId ? { partId: e.partId } : {}) },
    e.status ?? 500,
  );
});

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

// ---------- request size ----------
// The largest body each route takes, for every route (parts, market, usage and partners too). A body sent without a
// length is counted as it arrives. Nothing is read until the route reads it, which is after the key check.
const KB = 1024;
const MB = 1024 * KB;
const ADMIN_UPLOAD = (Number(process.env.ADMIN_UPLOAD_MB) || 1024) * MB; // bulk imports, data sets, moving the hub

function maxBody(p) {
  if (p === "/v1/register" || p === "/v1/partners/join") return 16 * KB; // no key needed: a join key or code and a name
  if (p === "/v1/posts") return 12 * 3 * MB + MB; // a note with up to 12 photos of 3 MB
  if (p === "/v1/listings") return 8 * 3 * MB + MB; // a listing with up to 8 photos
  if (/^\/v1\/figures\/[^/]+$/.test(p)) return 2 * MB;
  if (/^\/v1\/partners\/links\/[^/]+\/messages$/.test(p)) return 4 * MB + 64 * KB; // intake photos travel inside
  if (/^\/v1\/xparts(\/[^/]+)?$/.test(p) || p === "/v1/usage") return 2 * MB; // a part with all its fits; a month of parts used
  if (p.startsWith("/v1/admin/")) return ADMIN_UPLOAD;
  return 64 * KB; // everything else is a small JSON body
}

app.use("*", async (c, next) => {
  const req = c.req.raw;
  if (!req.body) return next();
  const max = maxBody(c.req.path);
  const tooLarge = () => {
    c.header("Connection", "close"); // the rest of the body isn't read: the client mustn't send its next request after it
    return fail(413, `That's too large for the hub (${max >= MB ? `${Math.floor(max / MB)} MB` : `${max / KB} KB`} at most).`);
  };
  if (req.headers.has("content-length") && !req.headers.has("transfer-encoding")) {
    if (Number(req.headers.get("content-length")) > max) throw tooLarge();
    return next(); // no more than that length is read
  }
  let seen = 0;
  const counted = req.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) ctl.error(tooLarge());
        else ctl.enqueue(chunk);
      },
    }),
  );
  c.req.raw = new Request(req, { body: counted, duplex: "half" });
  await next();
});

// A body that isn't JSON, or is JSON but not an object or a list (null, a number), is the sender's mistake: 400, not a
// hub error. Routes that read it with .catch(() => ({})) carry on with nothing, as before.
app.use("*", async (c, next) => {
  const parse = c.req.json.bind(c.req);
  c.req.json = async () => {
    let body;
    try {
      body = await parse();
    } catch (e) {
      if (e.status) throw e; // too large (413), or the body stream stopped
      throw fail(400, "That isn't valid JSON.");
    }
    if (body === null || typeof body !== "object") throw fail(400, "Send a JSON object.");
    return body;
  };
  await next();
});

// ---------- public ----------

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
  const s = await one(`SELECT (SELECT count(*) FROM links WHERE NOT deleted) links, (SELECT count(*) FROM posts WHERE NOT deleted) posts,
    (SELECT count(*) FROM installs WHERE NOT blocked) installs`);
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${HUB_NAME}</title>
<body style="font:16px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>${HUB_NAME}</h1><p>The community server for StitchBench repair shops: manual links, tech notes, photos and figure snapshots.
Manuals are never stored here, only links to where they are published.</p>
<p>${s.links} manual links · ${s.posts} shared notes · ${s.installs} shops</p>
<p>To join, open StitchBench → Settings → Community hub and enter this address and the join key you were given.</p>
<p><a href="/admin">Hub admin</a></p></body>`);
});

app.get("/admin", (c) => c.html(fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8")));

// Join: the community's join key gets an install its own key (shown once).
app.post("/v1/register", async (c) => {
  if (!allow(`register:${clientIp(c)}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
  const { joinKey, name, contact } = await c.req.json();
  await checkJoinKey(joinKey);
  const shop = String(name ?? "").trim().slice(0, 120);
  if (!shop) throw fail(400, "Give your shop's name.");
  const { id, key } = await createInstall(pool, shop, String(contact ?? "").slice(0, 200) || null, "member");
  notify`👋 ${shop} joined ${HUB_NAME}.`;
  return c.json({ installId: id, installKey: key, hubName: HUB_NAME, scope: "member" });
});

/** A new install with its own key (returned once; only the hash is kept). */
async function createInstall(db, name, contact, scope) {
  const id = newId();
  const key = `shk_${crypto.randomBytes(24).toString("base64url")}`;
  await db.query(`INSERT INTO installs (id, name, contact, key_hash, scope, last_seen_at) VALUES ($1, $2, $3, $4, $5, now())`, [id, name, contact, sha(key), scope]);
  return { id, key };
}

// ---------- installs (Authorization: Bearer <install key>) ----------

const member = new Hono();
member.use("*", async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const key = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!key) throw fail(401, "Join the hub first (Settings → Community hub).");
  const inst = await one(`SELECT id, name, scope, blocked, last_seen_at FROM installs WHERE key_hash = $1`, [sha(key)]);
  if (!inst) throw fail(401, "This install isn't known to the hub. Join again with the current join key.");
  if (inst.blocked) throw fail(403, "The hub admin has blocked this install.");
  // Joined with a partner code only: the partner channel, nothing of the community's.
  if (inst.scope === "partner" && !/^\/v1\/(partners\/|me$|upgrade$)/.test(c.req.path)) throw fail(403, "This shop is connected to its partner shops only. Join the community with a join key to use this.");
  if (!inst.last_seen_at || Date.now() - inst.last_seen_at.getTime() > 300_000) q(`UPDATE installs SET last_seen_at = now() WHERE id = $1`, [inst.id]).catch(() => {});
  c.set("install", inst);
  await next();
});

// 300 changes an hour per install. A hosted StitchBench serves several companies through one install: when it says
// which company a change is for (X-Shop-Ref), each company has its own 300, so one can't use up the others', and the
// install as a whole up to 3,000.
function writeLimit(c) {
  const id = c.get("install").id;
  const shop = c.req.header("x-shop-ref")?.trim().slice(0, 64);
  if (!(shop ? allow(`write:${id}:${shop}`, 300) && allow(`writes:${id}`, 3000) : allow(`write:${id}`, 300))) {
    throw fail(429, "Too many changes in the last hour. Try again later.");
  }
}

// Parts-usage reports replace a month's counts, so sending one again changes nothing: they have their own allowance
// and don't use up the one for real changes (StitchBench sends two with every "Sync now").
function usageLimit(c) {
  if (!allow(`usage:${c.get("install").id}`, 120)) throw fail(429, "Too many parts-usage reports in the last hour. Try again later.");
}

// A hub restored from an older export: an install that had synced past it starts that feed over (staleCursor in
// db.mjs). It receives everything again, and X-Feed-Reset: 1 says so.
const FEEDS = { "/v1/changes": "change", "/v1/orders": "change", "/v1/partners/messages": "partner" };
member.use("*", async (c, next) => {
  const feed = c.req.method === "GET" && FEEDS[c.req.path];
  const since = feed && c.req.query("since");
  if (since && /^\d+$/.test(since) && (await staleCursor(feed, since))) {
    const u = new URL(c.req.url);
    u.searchParams.set("since", "0");
    c.req.raw = new Request(u, c.req.raw);
    c.header("X-Feed-Reset", "1");
  }
  await next();
});

member.get("/me", async (c) =>
  c.json({
    installId: c.get("install").id,
    name: c.get("install").name,
    scope: c.get("install").scope,
    hubName: HUB_NAME,
    discordInvite: c.get("install").scope === "member" ? await getSetting("discord_invite") : null,
  }),
);

// A shop that joined with a partner code only, now with the community's join key: same key and partner links, full member.
member.post("/upgrade", async (c) => {
  if (!allow(`upgrade:${c.get("install").id}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
  const { joinKey } = await c.req.json().catch(() => ({}));
  await checkJoinKey(joinKey);
  if (c.get("install").scope !== "member") {
    await q(`UPDATE installs SET scope = 'member' WHERE id = $1`, [c.get("install").id]);
    notify`👋 ${c.get("install").name} joined ${HUB_NAME}.`;
  }
  return c.json({ installId: c.get("install").id, hubName: HUB_NAME, scope: "member" });
});

const linkOut = (l) => ({
  id: l.id,
  category: l.category,
  brand: l.brand,
  models: l.models,
  modelKeys: l.model_keys,
  docType: l.doc_type,
  title: l.title,
  fileName: l.file_name,
  url: l.url,
  source: l.source,
  status: l.status,
  httpStatus: l.http_status,
  checkedAt: l.checked_at,
  deleted: l.deleted,
  updatedAt: l.updated_at,
});

const FEED_BYTES = 32 * MB;

/** `since` (the number from the previous answer) and `limit` (between 1 and `max`) of a feed request. */
function feedPage(c, byDefault, max) {
  const since = c.req.query("since") || "0";
  if (!/^\d{1,18}$/.test(since)) throw fail(400, "since is the number from the previous answer.");
  const asked = Math.floor(Number(c.req.query("limit")));
  return { since, limit: Math.min(max, asked >= 1 ? asked : byDefault) };
}

// Everything that changed after `since` (a number from the previous answer), oldest first.
member.get("/changes", async (c) => {
  const { since, limit } = feedPage(c, 1000, 2000);
  const { rows } = await q(
    `SELECT t, id, seq FROM (
       SELECT 'link' t, id, seq FROM links WHERE seq > $1 AND seq <= $3
       UNION ALL SELECT 'post', id, seq FROM posts WHERE seq > $1 AND seq <= $3
       UNION ALL SELECT 'figure', id, seq FROM figures WHERE seq > $1 AND seq <= $3
       UNION ALL SELECT 'xpart', id, seq FROM xparts WHERE seq > $1 AND seq <= $3
       UNION ALL SELECT 'listing', id, seq FROM listings WHERE seq > $1 AND seq <= $3
     ) x ORDER BY seq LIMIT $2`,
    [since, limit, (await feedLimit()).change],
  );
  let more = rows.length === limit;
  // A page stops short of FEED_BYTES: a run of very large parts (thousands of fits each) would otherwise make one
  // answer too big to build, and every install's sync would stop at that page for good. The first row always goes.
  const sizes = await partSizes(rows.filter((r) => r.t === "xpart").map((r) => r.id));
  let bytes = 0;
  const cut = rows.findIndex((r, i) => (bytes += r.t === "xpart" ? sizes.get(r.id) ?? 2000 : 8000) > FEED_BYTES && i > 0);
  if (cut > 0) {
    rows.length = cut;
    more = true;
  }
  const ids = (t) => rows.filter((r) => r.t === t).map((r) => r.id);
  const links = ids("link").length ? (await q(`SELECT * FROM links WHERE id = ANY($1)`, [ids("link")])).rows.map(linkOut) : [];
  let posts = [];
  if (ids("post").length) {
    const ps = (await q(`SELECT * FROM posts WHERE id = ANY($1)`, [ids("post")])).rows;
    const photos = (await q(`SELECT id, post_id, kind, caption, mime, sort_order FROM photos WHERE post_id = ANY($1) ORDER BY sort_order`, [ids("post")])).rows;
    // A removed note is only its id: what it said is gone from the hub.
    posts = ps.map((p) => p.deleted ? { id: p.id, deleted: true } : ({
      id: p.id,
      shopName: p.shop_name,
      authorName: p.author_name,
      brand: p.brand,
      model: p.model,
      modelKey: p.model_key,
      kind: p.kind,
      title: p.title,
      body: p.body,
      deleted: p.deleted,
      mine: p.install_id === c.get("install").id,
      shopRef: p.shop_ref || null,
      createdAt: p.created_at,
      photos: photos.filter((ph) => ph.post_id === p.id).map((ph) => ({ id: ph.id, kind: ph.kind, caption: ph.caption, mime: ph.mime, sortOrder: ph.sort_order })),
    }));
  }
  // A figure id that comes again means its picture changed; removedFigures are ones the hub admin took down.
  const removed = new Set(ids("figure").length ? (await q(`SELECT id FROM figures WHERE id = ANY($1) AND deleted`, [ids("figure")])).rows.map((f) => f.id) : []);
  return c.json({
    links,
    posts,
    figures: ids("figure").filter((id) => !removed.has(id)),
    removedFigures: ids("figure").filter((id) => removed.has(id)),
    xparts: await partsByIds(ids("xpart")),
    listings: await listingsByIds(ids("listing"), c.get("install").id),
    next: rows.length ? rows[rows.length - 1].seq : since,
    more,
  });
});

// ----- manual links -----

const MAX_URL = 1800; // bytes

function linkFields(body) {
  const f = {
    brand: String(body.brand ?? "").trim().slice(0, 60),
    models: String(body.models ?? "").trim().slice(0, 200),
    docType: body.docType ? String(body.docType).slice(0, 40) : null,
    title: String(body.title ?? "").trim().slice(0, 300),
    url: String(body.url ?? "").trim(),
    category: body.category ? String(body.category).slice(0, 60) : null,
    fileName: body.fileName ? String(body.fileName).slice(0, 200) : null,
  };
  if (!f.brand || !f.models) throw fail(400, "Give the brand and model(s).");
  if (!f.title) f.title = `${f.brand} ${f.models} ${f.docType ?? "manual"}`;
  if (!validUrl(f.url)) throw fail(400, "The link must start with http:// or https://");
  // The address is part of a unique index, which can't hold a very long one (a signed cloud link can be that long).
  if (Buffer.byteLength(f.url) > MAX_URL) throw fail(400, `That link is too long (${MAX_URL} characters at most). Use the plain address of the file.`);
  if (!publicLink(f.url)) throw fail(400, "That link points inside a private network. Share a link any shop can open.");
  return f;
}

async function saveRevision(client, linkId, action, f, c, note) {
  await client.query(
    `INSERT INTO link_revisions (id, link_id, action, brand, models, doc_type, title, url, by_name, by_shop, install_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [newId(), linkId, action, f.brand, f.models, f.docType, f.title, f.url, c.byName, c.get("install")?.name ?? "hub admin", c.get("install")?.id ?? null, note ?? null],
  );
}

/** 409 pointing at the link that already has this address (and file name), when there is one other than `exceptId`. */
async function checkLinkFree(db, url, fileName, exceptId) {
  const existing = (await db.query(`SELECT id, deleted FROM links WHERE url = $1 AND coalesce(file_name, '') = coalesce($2, '') AND id <> $3`, [url, fileName, exceptId ?? ""])).rows[0];
  if (!existing) return;
  const e = fail(409, existing.deleted ? "That link was removed earlier. Restore it from its history instead." : "That link is already on the hub.");
  e.linkId = existing.id;
  throw e;
}

/** Two members saving the same address at the same moment: the second one gets the same 409 as one who was a moment later. */
async function whenAddressTaken(fn, url, fileName, exceptId) {
  try {
    return await fn();
  } catch (e) {
    if (e.code === "23505" && e.constraint === "links_url_file") await checkLinkFree(pool, url, fileName, exceptId);
    throw e;
  }
}

member.post("/links", async (c) => {
  writeLimit(c);
  const body = await c.req.json();
  const f = linkFields(body);
  c.byName = String(body.byName ?? "").slice(0, 80) || null;
  await checkLinkFree(pool, f.url, f.fileName);
  const id = newId();
  await whenAddressTaken(() => tx(async (client) => {
    await client.query(
      `INSERT INTO links (id, category, brand, models, model_keys, doc_type, title, file_name, url, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, f.category, f.brand, f.models, modelKeys(f.models, f.fileName), f.docType, f.title, f.fileName, f.url, hostOf(f.url)],
    );
    await saveRevision(client, id, "added", f, c, body.note);
  }), f.url, f.fileName);
  notify`🔗 ${c.get("install").name} added a manual link: ${f.brand} ${f.models} — ${f.title}`;
  return c.json(linkOut(await one(`SELECT * FROM links WHERE id = $1`, [id])));
});

async function applyEdit(c, id, f, action, note) {
  const cur = await one(`SELECT * FROM links WHERE id = $1`, [id]);
  if (!cur) throw fail(404, "That link isn't on the hub.");
  // The address (with the file name the link ends up with) may already be another link's: a fix or a roll back onto it.
  const fileName = f.fileName ?? cur.file_name;
  await checkLinkFree(pool, f.url, fileName, id);
  await whenAddressTaken(() => tx(async (client) => {
    await client.query(
      `UPDATE links SET brand=$2, models=$3, model_keys=$4, doc_type=$5, title=$6, url=$7, source=$8, category=coalesce($9, category),
         file_name=coalesce($10, file_name), deleted=false,
         status = CASE WHEN url = $7 THEN status ELSE 'unchecked' END, checked_at = CASE WHEN url = $7 THEN checked_at ELSE NULL END,
         fail_count = CASE WHEN url = $7 THEN fail_count ELSE 0 END, updated_at = now(), seq = nextval('change_seq')
       WHERE id = $1`,
      [id, f.brand, f.models, modelKeys(f.models, f.fileName), f.docType, f.title, f.url, hostOf(f.url), f.category, f.fileName],
    );
    await saveRevision(client, id, action, f, c, note);
  }), f.url, fileName, id);
  return linkOut(await one(`SELECT * FROM links WHERE id = $1`, [id]));
}

member.put("/links/:id", async (c) => {
  writeLimit(c);
  const body = await c.req.json();
  c.byName = String(body.byName ?? "").slice(0, 80) || null;
  const link = await applyEdit(c, c.req.param("id"), linkFields(body), "edited", body.note);
  notify`✏️ ${c.get("install").name} fixed a manual link: ${link.brand} ${link.models} — ${link.title}`;
  return c.json(link);
});

member.get("/links/:id/history", async (c) => {
  const { rows } = await q(`SELECT * FROM link_revisions WHERE link_id = $1 ORDER BY created_at DESC`, [c.req.param("id")]);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      brand: r.brand,
      models: r.models,
      docType: r.doc_type,
      title: r.title,
      url: r.url,
      byName: r.by_name,
      byShop: r.by_shop,
      note: r.note,
      createdAt: r.created_at,
    })),
  );
});

member.post("/links/:id/revert", async (c) => {
  writeLimit(c);
  const { revisionId, byName } = await c.req.json();
  const r = await one(`SELECT * FROM link_revisions WHERE id = $1 AND link_id = $2`, [revisionId, c.req.param("id")]);
  if (!r) throw fail(404, "That version isn't in this link's history.");
  c.byName = String(byName ?? "").slice(0, 80) || null;
  const f = { brand: r.brand, models: r.models, docType: r.doc_type, title: r.title, url: r.url, category: null, fileName: null };
  if (!validUrl(f.url)) throw fail(409, "That version's address can't be used any more.");
  return c.json(await applyEdit(c, c.req.param("id"), f, "reverted", `back to the version from ${r.created_at.toISOString().slice(0, 10)}`));
});

async function setDeleted(c, deleted) {
  writeLimit(c);
  const body = await c.req.json().catch(() => ({}));
  const cur = await one(`SELECT * FROM links WHERE id = $1`, [c.req.param("id")]);
  if (!cur) throw fail(404, "That link isn't on the hub.");
  c.byName = String(body.byName ?? "").slice(0, 80) || null;
  await tx(async (client) => {
    await client.query(`UPDATE links SET deleted = $2, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [cur.id, deleted]);
    const f = { brand: cur.brand, models: cur.models, docType: cur.doc_type, title: cur.title, url: cur.url };
    await saveRevision(client, cur.id, deleted ? "removed" : "restored", f, c, body.note);
  });
  return c.json(linkOut(await one(`SELECT * FROM links WHERE id = $1`, [cur.id])));
}
member.delete("/links/:id", (c) => setDeleted(c, true));
member.post("/links/:id/restore", (c) => setDeleted(c, false));

// An install couldn't download it (or could): check it again soon. A link that was checked within the hour isn't
// checked again, and an install can ask for 60 an hour: otherwise one member could keep the checker on the same links
// all day, knocking on the manufacturers' sites and making every install download each link again.
member.post("/links/:id/report", async (c) => {
  if (!allow(`report:${c.get("install").id}`, 60)) throw fail(429, "Too many reports in the last hour. Try again later.");
  const id = c.req.param("id");
  if (!(await one(`SELECT 1 FROM links WHERE id = $1 AND NOT deleted`, [id]))) throw fail(404, "That link isn't on the hub.");
  await q(`UPDATE links SET checked_at = NULL WHERE id = $1 AND checked_at < now() - interval '1 hour'`, [id]);
  return c.json({ ok: true });
});

// ----- tech notes -----

member.post("/posts", async (c) => {
  writeLimit(c);
  const form = await c.req.parseBody({ all: true });
  let p;
  try {
    p = JSON.parse(String(form.post ?? "{}"));
  } catch {
    throw fail(400, "The note must be JSON.");
  }
  if (!p || typeof p !== "object") throw fail(400, "The note must be JSON.");
  const title = String(p.title ?? "").trim().slice(0, 140);
  const body = String(p.body ?? "").trim().slice(0, 5000);
  const brand = String(p.brand ?? "").trim().slice(0, 60);
  const model = String(p.model ?? "").trim().slice(0, 80);
  if (!title || !body || !brand || !model) throw fail(400, "A note needs a brand, model, title and text.");
  const kind = KINDS.has(p.kind) ? p.kind : "GOTCHA";
  const files = [form.photo ?? []].flat().filter((f) => f instanceof File).slice(0, 12);
  const meta = Array.isArray(p.photos) ? p.photos : [];
  for (const f of files) {
    if (!IMAGE.has(f.type)) throw fail(415, "Photos must be JPEG, PNG or WebP.");
    if (f.size > 3 * 1024 * 1024) throw fail(413, "Each photo must be under 3 MB.");
  }
  const id = newId();
  const inst = c.get("install");
  const clientId = p.clientId ? String(p.clientId).slice(0, 64) : null;
  // The company sharing it, on a StitchBench that holds several (installs that don't say share as the install).
  const shopRef = String(p.shopRef ?? "").trim().slice(0, 64);
  const shopName = (shopRef && String(p.shopName ?? "").trim().slice(0, 120)) || inst.name;
  if (clientId) {
    const had = await one(`SELECT id FROM posts WHERE install_id = $1 AND client_id = $2`, [inst.id, clientId]);
    if (had) return c.json({ id: had.id });
  }
  const made = await tx(async (client) => {
    const r = await client.query(
      `INSERT INTO posts (id, install_id, shop_name, author_name, brand, model, model_key, kind, title, body, client_id, shop_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (install_id, client_id) WHERE client_id IS NOT NULL DO NOTHING`,
      [id, inst.id, shopName, String(p.authorName ?? "").slice(0, 80) || null, brand, model, model.toUpperCase().replace(/[^A-Z0-9]/g, ""), kind, title, body, clientId, shopRef],
    );
    if (!r.rowCount) return false; // the same upload, made by a retry a moment ago
    for (const [i, f] of files.entries()) {
      const m = meta[i] ?? {};
      await client.query(`INSERT INTO photos (id, post_id, kind, caption, mime, data, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        newId(),
        id,
        PHOTO_KINDS.has(m.kind) ? m.kind : "INSIDE",
        m.caption ? String(m.caption).slice(0, 300) : null,
        f.type,
        Buffer.from(await f.arrayBuffer()),
        i,
      ]);
    }
    return true;
  });
  if (!made) return c.json({ id: (await one(`SELECT id FROM posts WHERE install_id = $1 AND client_id = $2`, [inst.id, clientId])).id });
  notify`🛠️ ${shopName}: **${title}** (${brand} ${model})${files.length ? ` · ${files.length} photo${files.length > 1 ? "s" : ""}` : ""}\n${body.slice(0, 400)}`;
  return c.json({ id });
});

/**
 * Removing a note (by its shop, or by the hub admin when installId is null) takes back what it said and its photos:
 * only its id stays, so installs drop their copy.
 */
async function removePost(id, installId) {
  return tx(async (client) => {
    const r = await client.query(
      `UPDATE posts SET deleted = true, title = '', body = '', author_name = NULL, updated_at = now(), seq = nextval('change_seq')
       WHERE id = $1 AND ($2::text IS NULL OR install_id = $2)`,
      [id, installId],
    );
    if (r.rowCount) await client.query(`DELETE FROM photos WHERE post_id = $1`, [id]);
    return r.rowCount;
  });
}

member.delete("/posts/:id", async (c) => {
  if (!(await removePost(c.req.param("id"), c.get("install").id))) throw fail(404, "Only the shop that shared a note can remove it.");
  return c.json({ ok: true });
});

member.get("/photos/:id", async (c) => {
  const p = await one(`SELECT ph.mime, ph.data FROM photos ph JOIN posts p ON p.id = ph.post_id WHERE ph.id = $1 AND NOT p.deleted`, [c.req.param("id")]);
  if (!p) throw fail(404, "No such photo.");
  return c.body(p.data, 200, { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" });
});

// ----- figure snapshots -----

member.get("/figures/:id", async (c) => {
  const f = await one(`SELECT mime, data FROM figures WHERE id = $1 AND NOT deleted`, [c.req.param("id")]);
  if (!f) throw fail(404, "No such figure.");
  return c.body(f.data, 200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=31536000, immutable" });
});

member.put("/figures/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{24}$/.test(id)) throw fail(400, "Bad figure id.");
  const mime = c.req.header("content-type") ?? "";
  if (!IMAGE.has(mime)) throw fail(415, "Figures must be JPEG, PNG or WebP.");
  if (!allow(`figures:${c.get("install").id}`, 3000)) throw fail(429, "Too many figures in the last hour. Try again later.");
  const data = Buffer.from(await c.req.arrayBuffer());
  if (data.length > 2 * 1024 * 1024) throw fail(413, "Figure too large.");
  // The first shop to share a figure keeps it, and can replace it (a redraw); a figure the hub admin removed can be
  // shared again by anyone. stored: false means another shop's copy is already here and this one was not kept.
  const r = await q(
    `INSERT INTO figures (id, mime, data, width, height, install_id) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, width = EXCLUDED.width, height = EXCLUDED.height,
       install_id = EXCLUDED.install_id, deleted = false, seq = nextval('change_seq')
     WHERE figures.install_id = EXCLUDED.install_id OR figures.deleted`,
    [id, mime, data, Number(c.req.query("w")) || null, Number(c.req.query("h")) || null, c.get("install").id],
  );
  return c.json({ ok: true, stored: r.rowCount > 0 });
});

// ----- data sets the admin publishes (e.g. "specs") -----

member.get("/datasets", async (c) => c.json((await q(`SELECT name, version, length(data) AS size, updated_at FROM datasets ORDER BY name`)).rows));

member.get("/datasets/:name", async (c) => {
  const d = await one(`SELECT version, data FROM datasets WHERE name = $1`, [c.req.param("name")]);
  if (!d) throw fail(404, "No such data set.");
  return c.body(d.data, 200, { "Content-Type": "application/gzip", "X-Dataset-Version": d.version });
});


// ---------- hub admin (Authorization: Bearer <ADMIN_TOKEN>) ----------

const admin = new Hono();
admin.use("*", async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  if (!h.startsWith("Bearer ") || !same(sha(h.slice(7)), sha(ADMIN_TOKEN))) throw fail(401, "Wrong admin token.");
  c.byName = "hub admin";
  await next();
});

admin.get("/summary", async (c) => {
  const counts = await one(`SELECT (SELECT count(*) FROM links WHERE NOT deleted) links, (SELECT count(*) FROM links WHERE status='dead' AND NOT deleted) dead,
    (SELECT count(*) FROM links WHERE status='ok' AND NOT deleted) ok, (SELECT count(*) FROM posts WHERE NOT deleted) posts,
    (SELECT count(*) FROM figures WHERE NOT deleted) figures, (SELECT count(*) FROM installs) installs,
    (SELECT count(*) FROM xparts WHERE NOT deleted) parts, (SELECT count(*) FROM listings WHERE status = 'ACTIVE') listings,
    (SELECT count(*) FROM orders) orders, (SELECT count(*) FROM order_ratings) ratings, (SELECT count(*) FROM part_usage) usage,
    (SELECT count(*) FROM partner_links WHERE status = 'ACTIVE') partner_links, (SELECT count(*) FROM partner_messages) partner_messages`);
  const installs = (
    await q(`SELECT id, name, contact, scope, blocked, created_at, last_seen_at,
      (SELECT count(*) FROM figures f WHERE f.install_id = installs.id AND NOT f.deleted)::int AS figures FROM installs ORDER BY created_at`)
  ).rows;
  const datasets = (await q(`SELECT name, version, length(data) AS size, updated_at FROM datasets ORDER BY name`)).rows;
  return c.json({
    hubName: HUB_NAME,
    counts,
    joinKey: ((await getSetting("join_key")) ?? process.env.JOIN_KEY ?? "").trim() || null,
    discordWebhook: Boolean(await getSetting("discord_webhook")),
    discordInvite: await getSetting("discord_invite"),
    installs,
    datasets,
  });
});

admin.put("/join-key", async (c) => {
  const { joinKey } = await c.req.json();
  const key = String(joinKey ?? "").trim();
  if (key.length < 8 || /\s/.test(key)) throw fail(400, "Use a join key of 8+ characters with no spaces in it.");
  await setSetting("join_key", key);
  return c.json({ ok: true });
});

// The community's Discord invite link (goes into member invites and shows in StitchBench as "Community chat").
admin.put("/discord-invite", async (c) => {
  const { url } = await c.req.json();
  if (url && !/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(url)) throw fail(400, "Use a Discord invite link like https://discord.gg/abc123");
  if (url) await setSetting("discord_invite", url);
  else await q(`DELETE FROM settings WHERE key = 'discord_invite'`);
  return c.json({ ok: true });
});

admin.put("/discord-webhook", async (c) => {
  const { url } = await c.req.json();
  if (url && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) throw fail(400, "That isn't a Discord webhook URL.");
  if (url) await setSetting("discord_webhook", url);
  else await q(`DELETE FROM settings WHERE key = 'discord_webhook'`);
  if (url) notify`${HUB_NAME} is connected to this channel.`;
  return c.json({ ok: true });
});

admin.post("/installs/:id/block", async (c) => {
  const { blocked } = await c.req.json();
  await q(`UPDATE installs SET blocked = $2 WHERE id = $1`, [c.req.param("id"), Boolean(blocked)]);
  await sellerBlocked(c.req.param("id"), Boolean(blocked));
  return c.json({ ok: true });
});

admin.delete("/posts/:id", async (c) => {
  await removePost(c.req.param("id"), null);
  return c.json({ ok: true });
});

// A wrong or unwanted figure snapshot, or every one a shop shared: gone from the hub, installs drop their copy, and
// any shop can share the figure again.
const REMOVE_FIGURE = `UPDATE figures SET deleted = true, data = ''::bytea, seq = nextval('change_seq') WHERE NOT deleted AND`;
admin.delete("/figures/:id", async (c) => c.json({ removed: (await q(`${REMOVE_FIGURE} id = $1`, [c.req.param("id")])).rowCount }));
admin.delete("/installs/:id/figures", async (c) => c.json({ removed: (await q(`${REMOVE_FIGURE} install_id = $1`, [c.req.param("id")])).rowCount }));

// Seed or add many links at once: a JSON array of { brand, models, docType, title, url, fileName, category, status, checked }.
admin.post("/links/import", async (c) => {
  const list = await c.req.json();
  if (!Array.isArray(list)) throw fail(400, "Send a JSON array of links.");
  let added = 0;
  let skipped = 0;
  for (const raw of list) {
    let f;
    try {
      f = linkFields(raw);
    } catch {
      skipped++;
      continue;
    }
    const id = newId();
    const status = ["ok", "dead", "blocked"].includes(raw.status) ? raw.status : "unchecked";
    const when = raw.checked ? new Date(raw.checked) : null;
    const checked = when && !Number.isNaN(when.getTime()) && when.getFullYear() >= 2000 && when <= new Date() ? when : null;
    const ins = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO links (id, category, brand, models, model_keys, doc_type, title, file_name, url, source, status, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [id, f.category, f.brand, f.models, modelKeys(f.models, f.fileName), f.docType, f.title, f.fileName, f.url, hostOf(f.url), status, checked],
      );
      if (r.rowCount) await saveRevision(client, id, "added", f, c, raw.from ? `imported from ${raw.from}` : "imported");
      return r.rowCount;
    }).catch(() => 0);
    if (ins) added++;
    else skipped++;
  }
  return c.json({ added, skipped });
});

admin.put("/datasets/:name", async (c) => {
  const version = c.req.query("version") || new Date().toISOString();
  const data = Buffer.from(await c.req.arrayBuffer());
  if (!data.length) throw fail(400, "Empty data set.");
  await q(`INSERT INTO datasets (name, version, data) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()`, [
    c.req.param("name"),
    version,
    data,
  ]);
  return c.json({ ok: true, version, size: data.length });
});

admin.get("/export", (c) =>
  c.body(exportStream(), 200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="stitchhub-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz"`,
  }),
);

admin.post("/import", async (c) => c.json(await importStream(c.req.raw.body)));

// Parts cross-reference, marketplace and parts usage (src/parts.mjs, src/market.mjs, src/usage.mjs; docs/parts-and-marketplace.md).
registerParts({ member, admin, fail, newId, writeLimit, validUrl });
registerMarket({ member, fail, newId, writeLimit, notify, feedPage });
registerUsage({ member, fail, writeLimit: usageLimit });
registerPartners({ app, member, fail, newId, allow, clientIp, sha, hubName: HUB_NAME, createInstall });

// Admin first: the member routes below would otherwise answer /v1/admin/* with their key check.
app.route("/v1/admin", admin);
app.route("/v1", member);

// ---------- start ----------

await migrate(path.join(ROOT, "migrations"));
await startFeeds();
if (!(await getSetting("join_key")) && process.env.JOIN_KEY?.trim()) await setSetting("join_key", process.env.JOIN_KEY.trim());
if (process.env.LINK_CHECKER !== "off") startChecker();
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`${HUB_NAME} listening on :${port}`));

// Something left running in the background that fails (a Discord post, a last-seen update) is logged; it mustn't stop
// the hub for everyone.
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

// A stop (a deploy, a restart): no new requests, and the ones running get a few seconds to finish, so a write that has
// taken its change number isn't cut off half way while the next hub starts.
process.on("SIGTERM", async () => {
  const drained = new Promise((r) => server.close(r));
  server.closeIdleConnections?.();
  await Promise.race([drained, new Promise((r) => setTimeout(r, 8000))]);
  await pool.end().catch(() => {});
  process.exit(0);
});
