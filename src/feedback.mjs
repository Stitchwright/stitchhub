// Help, ideas, ratings and error alerts from the programs (StitchBench docs/plans/help-feedback-design.md, section 4;
// migration 034). A shop taps "Ask for help" in StitchBench or StitchShop, or the program records an error it hit, and
// the item comes here under the install key with the company in X-Shop-Ref. The owner reads them on the admin page
// ("Help & ideas") and, when FEEDBACK_EMAIL is set, gets an email: one at once for each help, idea or rating, and a
// digest at most every hour for errors. A pending install (an account started, not yet confirmed) may send too.
//
// Everything the program sends is capped and stored as data; nothing here is ever rendered as HTML (the admin page
// uses textContent, the email is plain text). A picture is optional, a JPEG of at most 1 MB, and is cleared 90 days
// after the owner marks the item done. Feedback is not part of the hub's export or of a company's move.
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q } from "./db.mjs";
import { sendMail } from "./mail.mjs";

const KINDS = new Set(["help", "idea", "rating", "error"]);
const STATUSES = new Set(["new", "seen", "done"]);
const MAX_PICTURE = 1024 * 1024;
const PER_COMPANY_HOUR = 60; // items (any kind) an hour for one company, and ten times that for an install (a hosted program serves many)
const ERRORS_PER_DAY = 200; // error posts a day for one install (over: 429; the program keeps them and tries later)
const PICTURE_DAYS = 90;
const DIGEST_MS = 3600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => {
  const s = String(v ?? "").replace(/\u0000/g, "").trim();
  return s ? s.slice(0, max) : null;
};
const emailOk = (e) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e ?? "");
const isDay = (d) => typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// Errors posted today, per install (the hourly allowance in server.mjs is too short for "200 a day").
const errorDays = new Map();
function errorAllowed(installId) {
  const today = new Date().toISOString().slice(0, 10);
  for (const [k, v] of errorDays) if (v.day !== today) errorDays.delete(k);
  const e = errorDays.get(installId) ?? { day: today, n: 0 };
  errorDays.set(installId, e);
  return ++e.n <= ERRORS_PER_DAY;
}

/** The item as it is kept: only the known fields, each capped. Throws a message the sender can act on. */
function cleanItem(raw, fail) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail(400, "Send the item as a JSON object.");
  const kind = String(raw.kind ?? "");
  if (!KINDS.has(kind)) throw fail(400, "kind is help, idea, rating or error.");
  const item = { kind };
  const text = str(raw.text, 4000);
  if (text) item.text = text;
  if ((kind === "help" || kind === "idea") && !text) throw fail(400, "Tell us what happened or what you'd like (text).");
  if (kind === "rating") {
    const stars = Number(raw.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw fail(400, "stars is a whole number from 1 to 5.");
    item.stars = stars;
    item.quoteOk = raw.quoteOk === true;
  }
  const replyTo = str(raw.replyTo, 200);
  if (replyTo && emailOk(replyTo)) item.replyTo = replyTo;
  const c = raw.context && typeof raw.context === "object" && !Array.isArray(raw.context) ? raw.context : {};
  item.context = {
    program: str(c.program, 40),
    version: str(c.version, 40),
    path: str(c.path, 300),
    role: str(c.role, 40),
    desktop: typeof c.desktop === "boolean" ? c.desktop : str(c.desktop, 20),
    userAgent: str(c.userAgent, 300),
    screen: str(c.screen, 40),
  };
  const shopName = str(c.shopName ?? raw.shopName, 120);
  if (kind === "error") {
    const e = raw.error && typeof raw.error === "object" && !Array.isArray(raw.error) ? raw.error : {};
    const message = str(e.message, 1000);
    if (!message) throw fail(400, "An error needs error.message.");
    item.error = { message, stack: str(e.stack, 8000), digest: str(e.digest, 100), action: str(e.action, 200) };
    // The program names the error (a fingerprint) and its day; without them the same message and top frame are one error today.
    item.fingerprint = str(raw.fingerprint, 64) ?? crypto.createHash("sha256").update(`${message}\n${String(e.stack ?? "").split("\n")[1] ?? ""}`).digest("hex").slice(0, 32);
    item.day = isDay(raw.day) ? raw.day : new Date().toISOString().slice(0, 10);
    const n = Math.floor(Number(raw.count));
    item.count = Number.isFinite(n) ? Math.min(Math.max(n, 1), 100000) : 1;
  }
  return { item, shopName };
}

export function registerFeedback({ member, admin, fail, newId, allow, hubName, hubUrl }) {
  // Room for a picture of 1 MB and the item (server.mjs caps the request at 1 MB + 128 KB; a JSON body is small).
  const limit = bodyLimit({ maxSize: MAX_PICTURE + 128 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });

  // ----- email to the owner -----

  const ownerEmail = () => {
    const to = (process.env.FEEDBACK_EMAIL ?? "").trim();
    return emailOk(to) ? to : null;
  };
  const adminLink = () => `${hubUrl || ""}/admin`;
  const tell = (subject, text) => {
    const to = ownerEmail();
    if (to) sendMail({ to, subject, text, fromName: hubName }).catch((e) => console.error("feedback mail:", e.message));
  };
  const LABEL = { help: "Help", idea: "Idea", rating: "Rating" };

  function mailItem(item, shopName, id, hasPicture) {
    const first = (item.text ?? (item.stars ? `${item.stars} of 5 stars` : "")).replace(/\s+/g, " ").slice(0, 60);
    const x = item.context;
    tell(
      `${LABEL[item.kind]}: ${shopName} – ${first}`,
      [
        `${LABEL[item.kind]} from ${shopName}`,
        item.stars ? `Stars: ${item.stars} of 5${item.quoteOk ? " (may be quoted with the shop's name)" : ""}` : null,
        item.replyTo ? `Reply to: ${item.replyTo}` : "No reply address.",
        `Program: ${x.program ?? "?"} ${x.version ?? ""}   Page: ${x.path ?? "?"}   Role: ${x.role ?? "?"}`,
        hasPicture ? "A picture of the screen is on the admin page." : null,
        "",
        item.text ?? "",
        "",
        `Read it and mark it done: ${adminLink()} (Help & ideas, item ${id})`,
      ].filter((l) => l !== null).join("\n"),
    );
  }

  // New errors wait here and go in one email at most every hour ("3 new errors from 2 shops").
  let waiting = [];
  let lastDigest = 0;
  let digestTimer = null;
  function digest() {
    digestTimer = null;
    const list = waiting;
    waiting = [];
    if (!list.length) return;
    lastDigest = Date.now();
    const shops = new Set(list.map((e) => e.shop));
    tell(
      `${list.length} new error${list.length === 1 ? "" : "s"} from ${shops.size} shop${shops.size === 1 ? "" : "s"}`,
      [...list.slice(0, 30).map((e) => `${e.shop}: ${e.message}`), list.length > 30 ? `... and ${list.length - 30} more` : null, "", `Details: ${adminLink()} (Help & ideas, kind Error)`].filter((l) => l !== null).join("\n"),
    );
  }
  function queueError(shop, message) {
    if (!ownerEmail()) return;
    waiting.push({ shop, message: message.slice(0, 160) });
    if (digestTimer) return;
    digestTimer = setTimeout(digest, Math.max(0, lastDigest + DIGEST_MS - Date.now()));
    digestTimer.unref();
  }

  // ----- the programs' route -----

  member.post("/feedback", limit, async (c) => {
    const inst = c.get("install");
    const shopRef = str(c.req.header("x-shop-ref"), 64);
    if (!shopRef) throw fail(400, "Send X-Shop-Ref: the company's id.");
    if (!(allow(`feedback:${inst.id}:${shopRef}`, PER_COMPANY_HOUR) && allow(`feedbacks:${inst.id}`, PER_COMPANY_HOUR * 10))) {
      throw fail(429, "Too many items in the last hour. The program will try again later.");
    }

    let raw;
    let picture = null;
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      try {
        raw = JSON.parse(String(form.item ?? ""));
      } catch {
        throw fail(400, "The item must be JSON.");
      }
      if (form.picture instanceof File && form.picture.size > 0) {
        if (form.picture.size > MAX_PICTURE) throw fail(413, "The picture must be under 1 MB.");
        picture = Buffer.from(await form.picture.arrayBuffer());
        if (form.picture.type !== "image/jpeg" || !isJpeg(picture)) throw fail(415, "The picture must be a JPEG.");
      }
    } else {
      raw = await c.req.json();
    }
    const { item, shopName: told } = cleanItem(raw, fail);
    if (item.kind === "error" && !errorAllowed(inst.id)) throw fail(429, "Too many errors today. The program will try again later.");

    // The company's name as the hub knows it from this install, else what the program said.
    const known = await one(`SELECT name FROM shops WHERE install_id = $1 AND shop_ref = $2`, [inst.id, shopRef]);
    const shopName = known?.name ?? told ?? inst.name ?? "A shop";
    const { fingerprint = null, day = null, count = 1, ...body } = item;
    const id = newId();

    if (item.kind === "error") {
      // The same error on the same day is one row; the sent count is added.
      const r = await one(
        `INSERT INTO feedback (id, install_id, shop_ref, shop_name, kind, body, picture, fingerprint, day, count)
         VALUES ($1,$2,$3,$4,'error',$5,$6,$7,$8,$9)
         ON CONFLICT (install_id, shop_ref, fingerprint, day) WHERE kind = 'error'
         DO UPDATE SET count = LEAST(feedback.count + EXCLUDED.count, 10000000), last_at = now(), body = EXCLUDED.body, shop_name = EXCLUDED.shop_name,
           picture = COALESCE(EXCLUDED.picture, feedback.picture)
         RETURNING id, (xmax = 0) AS inserted`,
        [id, inst.id, shopRef, shopName, body, picture, fingerprint, day, count],
      );
      if (r.inserted) queueError(shopName, body.error.message);
      return c.json({ ok: true, id: r.id });
    }
    await q(`INSERT INTO feedback (id, install_id, shop_ref, shop_name, kind, body, picture) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, inst.id, shopRef, shopName, item.kind, body, picture]);
    mailItem(item, shopName, id, Boolean(picture));
    return c.json({ ok: true, id });
  });

  // ----- the owner's admin routes -----

  const out = (r) => ({
    id: r.id,
    installId: r.install_id,
    shopRef: r.shop_ref,
    shopName: r.shop_name,
    kind: r.kind,
    ...r.body,
    count: r.count,
    day: r.day,
    createdAt: r.created_at,
    lastAt: r.last_at,
    status: r.status,
    note: r.owner_note,
    hasPicture: r.has_picture,
  });

  admin.get("/feedback", async (c) => {
    const status = c.req.query("status");
    const kind = c.req.query("kind");
    const shop = c.req.query("shop"); // install id + "/" + shop ref, as the shops list below gives it
    const n = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
    const where = [];
    const params = [];
    const add = (sql, v) => (params.push(v), where.push(sql.replace("?", `$${params.length}`)));
    if (STATUSES.has(status)) add("status = ?", status);
    if (KINDS.has(kind)) add("kind = ?", kind);
    if (shop?.includes("/")) {
      const [i, ...rest] = shop.split("/");
      add("install_id = ?", i);
      add("shop_ref = ?", rest.join("/"));
    }
    const rows = (
      await q(
        `SELECT id, install_id, shop_ref, shop_name, kind, body, count, day, created_at, last_at, status, owner_note, (picture IS NOT NULL) AS has_picture
         FROM feedback ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_at DESC LIMIT ${n + 1}`,
        params,
      )
    ).rows;
    const shops = (await q(`SELECT DISTINCT ON (install_id, shop_ref) install_id, shop_ref, shop_name FROM feedback ORDER BY install_id, shop_ref, last_at DESC LIMIT 500`)).rows;
    const counts = Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM feedback GROUP BY status`)).rows.map((r) => [r.status, r.n]));
    return c.json({
      items: rows.slice(0, n).map(out),
      more: rows.length > n,
      counts: { new: counts.new ?? 0, seen: counts.seen ?? 0, done: counts.done ?? 0 },
      shops: shops.map((s) => ({ key: `${s.install_id}/${s.shop_ref}`, name: s.shop_name })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  admin.post("/feedback/:id", async (c) => {
    const body = await c.req.json();
    const sets = [];
    const params = [c.req.param("id")];
    if (body.status !== undefined) {
      if (!STATUSES.has(body.status)) throw fail(400, "status is new, seen or done.");
      params.push(body.status);
      sets.push(`status = $${params.length}`, `done_at = ${body.status === "done" ? "COALESCE(done_at, now())" : "NULL"}`);
    }
    if (body.note !== undefined) {
      params.push(str(body.note, 4000));
      sets.push(`owner_note = $${params.length}`);
    }
    if (!sets.length) throw fail(400, "Send a status or a note.");
    const r = await one(
      `UPDATE feedback SET ${sets.join(", ")} WHERE id = $1 RETURNING id, install_id, shop_ref, shop_name, kind, body, count, day, created_at, last_at, status, owner_note, (picture IS NOT NULL) AS has_picture`,
      params,
    );
    if (!r) throw fail(404, "No such item.");
    return c.json(out(r));
  });

  admin.get("/feedback/:id/picture", async (c) => {
    const r = await one(`SELECT picture FROM feedback WHERE id = $1`, [c.req.param("id")]);
    if (!r?.picture) throw fail(404, "No picture for that item.");
    return c.body(r.picture, 200, { "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" });
  });

  // Pictures go 90 days after the owner marks an item done; the words stay.
  async function sweep() {
    const r = await q(`UPDATE feedback SET picture = NULL WHERE picture IS NOT NULL AND done_at < now() - make_interval(days => $1)`, [PICTURE_DAYS]);
    return r.rowCount;
  }
  setInterval(() => sweep().catch((e) => console.error("feedback sweep:", e.message)), 6 * 3600_000).unref();
  admin.post("/feedback-sweep", async (c) => c.json({ ok: true, cleared: await sweep() }));
}
