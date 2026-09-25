// StitchHub: the community server for StitchBench.
// Installs join with the community's join key and get their own key. They pull changes (manual links, tech notes,
// figure snapshots, data sets) and push what their techs share. Manual PDFs are never stored, only links to them.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { pool, q, one, tx, migrate, getSetting, setSetting } from "./db.mjs";
import { startChecker } from "./checker.mjs";
import { exportStream, importStream } from "./transfer.mjs";
import { registerParts, partsByIds } from "./parts.mjs";
import { registerMarket, listingsByIds } from "./market.mjs";
import { registerUsage } from "./usage.mjs";
import { registerPartners } from "./partners.mjs";

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

// Tell the community's Discord channel (optional: admin sets a webhook URL).
async function notify(text) {
  const hook = await getSetting("discord_webhook");
  if (!hook) return;
  fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) }).catch(() => {});
}

// A few simple limits so one install can't flood the hub.
const buckets = new Map();
function allow(key, perHour) {
  const now = Date.now();
  const b = buckets.get(key) ?? { n: 0, since: now };
  if (now - b.since > 3600_000) {
    b.n = 0;
    b.since = now;
  }
  b.n += 1;
  buckets.set(key, b);
  return b.n <= perHour;
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
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (!allow(`register:${ip}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
  const { joinKey, name, contact } = await c.req.json();
  const expected = (await getSetting("join_key")) ?? process.env.JOIN_KEY ?? "";
  if (!expected || !joinKey || !same(sha(String(joinKey)), sha(expected))) throw fail(403, "That join key isn't right. Ask the hub admin for the current one.");
  const shop = String(name ?? "").trim().slice(0, 120);
  if (!shop) throw fail(400, "Give your shop's name.");
  const { id, key } = await createInstall(pool, shop, String(contact ?? "").slice(0, 200) || null, "member");
  notify(`👋 ${shop} joined ${HUB_NAME}.`);
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

function writeLimit(c) {
  if (!allow(`write:${c.get("install").id}`, 300)) throw fail(429, "Too many changes in the last hour. Try again later.");
}

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
  const expected = (await getSetting("join_key")) ?? process.env.JOIN_KEY ?? "";
  if (!expected || !joinKey || !same(sha(String(joinKey)), sha(expected))) throw fail(403, "That join key isn't right. Ask the hub admin for the current one.");
  if (c.get("install").scope !== "member") {
    await q(`UPDATE installs SET scope = 'member' WHERE id = $1`, [c.get("install").id]);
    notify(`👋 ${c.get("install").name} joined ${HUB_NAME}.`);
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

// Everything that changed after `since` (a number from the previous answer), oldest first.
member.get("/changes", async (c) => {
  const since = BigInt(c.req.query("since") || "0");
  const limit = Math.min(2000, Number(c.req.query("limit") || 1000));
  const { rows } = await q(
    `SELECT t, id, seq FROM (
       SELECT 'link' t, id, seq FROM links WHERE seq > $1
       UNION ALL SELECT 'post', id, seq FROM posts WHERE seq > $1
       UNION ALL SELECT 'figure', id, seq FROM figures WHERE seq > $1
       UNION ALL SELECT 'xpart', id, seq FROM xparts WHERE seq > $1
       UNION ALL SELECT 'listing', id, seq FROM listings WHERE seq > $1
     ) x ORDER BY seq LIMIT $2`,
    [since.toString(), limit],
  );
  const ids = (t) => rows.filter((r) => r.t === t).map((r) => r.id);
  const links = ids("link").length ? (await q(`SELECT * FROM links WHERE id = ANY($1)`, [ids("link")])).rows.map(linkOut) : [];
  let posts = [];
  if (ids("post").length) {
    const ps = (await q(`SELECT * FROM posts WHERE id = ANY($1)`, [ids("post")])).rows;
    const photos = (await q(`SELECT id, post_id, kind, caption, mime, sort_order FROM photos WHERE post_id = ANY($1) ORDER BY sort_order`, [ids("post")])).rows;
    posts = ps.map((p) => ({
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
      createdAt: p.created_at,
      photos: photos.filter((ph) => ph.post_id === p.id).map((ph) => ({ id: ph.id, kind: ph.kind, caption: ph.caption, mime: ph.mime, sortOrder: ph.sort_order })),
    }));
  }
  return c.json({
    links,
    posts,
    figures: ids("figure"),
    xparts: await partsByIds(ids("xpart")),
    listings: await listingsByIds(ids("listing"), c.get("install").id),
    next: rows.length ? rows[rows.length - 1].seq : since.toString(),
    more: rows.length === limit,
  });
});

// ----- manual links -----

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
  return f;
}

async function saveRevision(client, linkId, action, f, c, note) {
  await client.query(
    `INSERT INTO link_revisions (id, link_id, action, brand, models, doc_type, title, url, by_name, by_shop, install_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [newId(), linkId, action, f.brand, f.models, f.docType, f.title, f.url, c.byName, c.get("install")?.name ?? "hub admin", c.get("install")?.id ?? null, note ?? null],
  );
}

member.post("/links", async (c) => {
  writeLimit(c);
  const body = await c.req.json();
  const f = linkFields(body);
  c.byName = String(body.byName ?? "").slice(0, 80) || null;
  const existing = await one(`SELECT id, deleted FROM links WHERE url = $1 AND coalesce(file_name, '') = coalesce($2, '')`, [f.url, f.fileName]);
  if (existing) {
    const e = fail(409, existing.deleted ? "That link was removed earlier. Restore it from its history instead." : "That link is already on the hub.");
    e.linkId = existing.id;
    throw e;
  }
  const id = newId();
  await tx(async (client) => {
    await client.query(
      `INSERT INTO links (id, category, brand, models, model_keys, doc_type, title, file_name, url, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, f.category, f.brand, f.models, modelKeys(f.models, f.fileName), f.docType, f.title, f.fileName, f.url, hostOf(f.url)],
    );
    await saveRevision(client, id, "added", f, c, body.note);
  });
  notify(`🔗 ${c.get("install").name} added a manual link: ${f.brand} ${f.models} — ${f.title}`);
  return c.json(linkOut(await one(`SELECT * FROM links WHERE id = $1`, [id])));
});

async function applyEdit(c, id, f, action, note) {
  const cur = await one(`SELECT * FROM links WHERE id = $1`, [id]);
  if (!cur) throw fail(404, "That link isn't on the hub.");
  await tx(async (client) => {
    await client.query(
      `UPDATE links SET brand=$2, models=$3, model_keys=$4, doc_type=$5, title=$6, url=$7, source=$8, category=coalesce($9, category),
         file_name=coalesce($10, file_name), deleted=false,
         status = CASE WHEN url = $7 THEN status ELSE 'unchecked' END, checked_at = CASE WHEN url = $7 THEN checked_at ELSE NULL END,
         fail_count = CASE WHEN url = $7 THEN fail_count ELSE 0 END, updated_at = now(), seq = nextval('change_seq')
       WHERE id = $1`,
      [id, f.brand, f.models, modelKeys(f.models, f.fileName), f.docType, f.title, f.url, hostOf(f.url), f.category, f.fileName],
    );
    await saveRevision(client, id, action, f, c, note);
  });
  return linkOut(await one(`SELECT * FROM links WHERE id = $1`, [id]));
}

member.put("/links/:id", async (c) => {
  writeLimit(c);
  const body = await c.req.json();
  c.byName = String(body.byName ?? "").slice(0, 80) || null;
  const link = await applyEdit(c, c.req.param("id"), linkFields(body), "edited", body.note);
  notify(`✏️ ${c.get("install").name} fixed a manual link: ${link.brand} ${link.models} — ${link.title}`);
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

// An install couldn't download it (or could): check it again soon.
member.post("/links/:id/report", async (c) => {
  await q(`UPDATE links SET checked_at = NULL WHERE id = $1`, [c.req.param("id")]);
  return c.json({ ok: true });
});

// ----- tech notes -----

member.post("/posts", async (c) => {
  writeLimit(c);
  const form = await c.req.parseBody({ all: true });
  const p = JSON.parse(String(form.post ?? "{}"));
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
  await tx(async (client) => {
    await client.query(
      `INSERT INTO posts (id, install_id, shop_name, author_name, brand, model, model_key, kind, title, body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, inst.id, inst.name, String(p.authorName ?? "").slice(0, 80) || null, brand, model, model.toUpperCase().replace(/[^A-Z0-9]/g, ""), kind, title, body],
    );
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
  });
  notify(`🛠️ ${inst.name}: **${title}** (${brand} ${model})${files.length ? ` · ${files.length} photo${files.length > 1 ? "s" : ""}` : ""}\n${body.slice(0, 400)}`);
  return c.json({ id });
});

member.delete("/posts/:id", async (c) => {
  const r = await q(`UPDATE posts SET deleted = true, updated_at = now(), seq = nextval('change_seq') WHERE id = $1 AND install_id = $2`, [
    c.req.param("id"),
    c.get("install").id,
  ]);
  if (!r.rowCount) throw fail(404, "Only the shop that shared a note can remove it.");
  return c.json({ ok: true });
});

member.get("/photos/:id", async (c) => {
  const p = await one(`SELECT mime, data FROM photos WHERE id = $1`, [c.req.param("id")]);
  if (!p) throw fail(404, "No such photo.");
  return c.body(p.data, 200, { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" });
});

// ----- figure snapshots -----

member.get("/figures/:id", async (c) => {
  const f = await one(`SELECT mime, data FROM figures WHERE id = $1`, [c.req.param("id")]);
  if (!f) throw fail(404, "No such figure.");
  return c.body(f.data, 200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=31536000, immutable" });
});

member.put("/figures/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{24}$/.test(id)) throw fail(400, "Bad figure id.");
  const mime = c.req.header("content-type") ?? "";
  if (!IMAGE.has(mime)) throw fail(415, "Figures must be JPEG, PNG or WebP.");
  const data = Buffer.from(await c.req.arrayBuffer());
  if (data.length > 2 * 1024 * 1024) throw fail(413, "Figure too large.");
  await q(`INSERT INTO figures (id, mime, data, width, height, install_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [
    id,
    mime,
    data,
    Number(c.req.query("w")) || null,
    Number(c.req.query("h")) || null,
    c.get("install").id,
  ]);
  return c.json({ ok: true });
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
    (SELECT count(*) FROM figures) figures, (SELECT count(*) FROM installs) installs,
    (SELECT count(*) FROM xparts WHERE NOT deleted) parts, (SELECT count(*) FROM listings WHERE status = 'ACTIVE') listings,
    (SELECT count(*) FROM orders) orders, (SELECT count(*) FROM order_ratings) ratings, (SELECT count(*) FROM part_usage) usage,
    (SELECT count(*) FROM partner_links WHERE status = 'ACTIVE') partner_links, (SELECT count(*) FROM partner_messages) partner_messages`);
  const installs = (await q(`SELECT id, name, contact, scope, blocked, created_at, last_seen_at FROM installs ORDER BY created_at`)).rows;
  const datasets = (await q(`SELECT name, version, length(data) AS size, updated_at FROM datasets ORDER BY name`)).rows;
  return c.json({
    hubName: HUB_NAME,
    counts,
    joinKey: (await getSetting("join_key")) ?? process.env.JOIN_KEY ?? null,
    discordWebhook: Boolean(await getSetting("discord_webhook")),
    discordInvite: await getSetting("discord_invite"),
    installs,
    datasets,
  });
});

admin.put("/join-key", async (c) => {
  const { joinKey } = await c.req.json();
  if (!joinKey || String(joinKey).length < 8) throw fail(400, "Use a join key of 8+ characters.");
  await setSetting("join_key", String(joinKey));
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
  if (url) notify(`${HUB_NAME} is connected to this channel.`);
  return c.json({ ok: true });
});

admin.post("/installs/:id/block", async (c) => {
  const { blocked } = await c.req.json();
  await q(`UPDATE installs SET blocked = $2 WHERE id = $1`, [c.req.param("id"), Boolean(blocked)]);
  return c.json({ ok: true });
});

admin.delete("/posts/:id", async (c) => {
  await q(`UPDATE posts SET deleted = true, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [c.req.param("id")]);
  return c.json({ ok: true });
});

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
registerMarket({ member, fail, newId, writeLimit, notify });
registerUsage({ member, fail, writeLimit });
registerPartners({ app, member, fail, newId, allow, sha, hubName: HUB_NAME, createInstall });

// Admin first: the member routes below would otherwise answer /v1/admin/* with their key check.
app.route("/v1/admin", admin);
app.route("/v1", member);

// ---------- start ----------

await migrate(path.join(ROOT, "migrations"));
if (!(await getSetting("join_key")) && process.env.JOIN_KEY) await setSetting("join_key", process.env.JOIN_KEY);
if (process.env.LINK_CHECKER !== "off") startChecker();
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`${HUB_NAME} listening on :${port}`));

process.on("SIGTERM", async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
