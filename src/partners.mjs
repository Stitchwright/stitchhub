// Partner links: a private channel between a repair shop and a sewing / quilt shop that works with it (takes machines
// in for repair, orders parts and notions, holds the repair shop's stock on consignment). One side makes an invite code
// and hands it over in person; the other side redeems it. After that each side sends messages that only the other side
// receives. The hub doesn't read them: machine intake, repair status, orders, consignment sales and statements are all
// just typed JSON to it. A sewing shop that isn't a community member joins with the invite alone and can then use the
// partner routes and nothing else.
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q, tx, feedLimit } from "./db.mjs";

const SIDES = new Set(["repair", "retail"]);
const TYPE = /^[a-z]{2,20}(\.[a-z]{2,20})?$/;
const MAX_MESSAGE = 4 * 1024 * 1024; // intake photos travel inside the message, already shrunk by the app
const MAX_HOUR_BYTES = 256 * 1024 * 1024; // what one shop may send in an hour, all its links together
const MAX_INSTALL_HOUR_BYTES = 1024 * 1024 * 1024; // and one install, all its shops together (a hosted install has many)
const MAX_LINK_HOUR_BYTES = 128 * 1024 * 1024; // and one side of one link (about 35 intakes with photos)
const MAX_STORED = 2 * 1024 * 1024 * 1024; // what one install may have on the hub at once (a busy year of intakes with photos is under 1 GB)
const MAX_LINK_STORED = 512 * 1024 * 1024; // what one side of one link may have on the hub at once
const MAX_PAGE_BYTES = 16 * 1024 * 1024; // one answer to a message poll; the first message always fits
const MAX_MINTED = 50; // partner-only installs one member's codes may bring onto the hub, all told
// New work isn't taken on a partnership that has ended; updates, payments and terms still pass (the last statement).
const NEW_WORK = new Set(["job.new", "order.new", "consign.place", "catalog"]);
const INVITE_DAYS = 14;
const KEEP_DAYS = 365; // a message the shop it's for has had every chance to pull
const KEEP_UNPULLED_DAYS = 3 * KEEP_DAYS; // one it hasn't (that shop's install hasn't been on the hub since it was sent)
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L: the code is read out and typed at a counter

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

// Bytes sent in the last hour (per shop, per install, per link side), kept the way the per-hour request counts in
// server.mjs are. The count limit on messages alone would let one install store 12 GB an hour (3,000 messages of
// 4 MB), kept for a year. All the budgets must have room before any is charged.
const hourBytes = new Map();
function allowBytes(budgets, bytes) {
  const now = Date.now();
  const bs = budgets.map(([key, max]) => {
    let b = hourBytes.get(key);
    if (!b || now - b.since > 3600_000) hourBytes.set(key, (b = { n: 0, since: now }));
    return [b, max];
  });
  if (bs.some(([b, max]) => b.n + bytes > max)) return false;
  for (const [b] of bs) b.n += bytes;
  return true;
}

// What each install, and each side of each link, has on the hub now (about: the stored size of its messages). Read
// again every ten minutes so the sweep's deletions count; what is sent in between is added on.
const stored = new Map();
async function storedBytes(key, sql, params) {
  const s = stored.get(key);
  if (s && Date.now() - s.at < 600_000) return s;
  const r = await one(sql, params);
  const fresh = { bytes: Number(r.bytes), at: Date.now() };
  stored.set(key, fresh);
  return fresh;
}
const installStored = (installId) =>
  storedBytes(
    `i:${installId}`,
    `SELECT coalesce(sum(pg_column_size(m.data)), 0)::bigint AS bytes
     FROM partner_links l JOIN partner_messages m ON m.link_id = l.id
     WHERE (l.repair_install_id = $1 AND m.from_side = 'repair') OR (l.retail_install_id = $1 AND m.from_side = 'retail')`,
    [installId],
  );
const linkStored = (linkId, side) =>
  storedBytes(`l:${linkId}:${side}`, `SELECT coalesce(sum(pg_column_size(data)), 0)::bigint AS bytes FROM partner_messages WHERE link_id = $1 AND from_side = $2`, [linkId, side]);

// Hours that are over are forgotten (keys include shop refs, which the install chooses).
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of hourBytes) if (now - b.since > 3600_000) hourBytes.delete(k);
  for (const [k, s] of stored) if (now - s.at > 600_000) stored.delete(k);
}, 600_000).unref();

function newCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

const normCode = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function linkOut(l) {
  return {
    id: l.id,
    status: l.status,
    terms: l.terms,
    repair: { installId: l.repair_install_id, shopRef: l.repair_shop_ref, name: l.repair_name },
    retail: { installId: l.retail_install_id, shopRef: l.retail_shop_ref, name: l.retail_name },
    createdAt: l.created_at,
    endedAt: l.ended_at,
  };
}

/** Which side of the link this install's shop is on (null when it isn't on the link). */
function sideOf(link, installId, shopRef) {
  if (link.repair_install_id === installId && link.repair_shop_ref === shopRef) return "repair";
  if (link.retail_install_id === installId && link.retail_shop_ref === shopRef) return "retail";
  return null;
}

export function registerPartners({ app, member, fail, newId, allow, clientIp, sha, hubName, createInstall }) {
  // Invitations, codes and link changes are a few hundred bytes: nobody needs to send more.
  const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });
  function shopFields(body) {
    const shopRef = str(body.shopRef, 64);
    const shopName = str(body.shopName, 120);
    if (!shopRef || !shopName) throw fail(400, "Send shopRef and shopName.");
    return { shopRef, shopName };
  }

  async function redeem(client, install, code, shopRef, shopName) {
    const inv = (await client.query(`SELECT * FROM partner_invites WHERE code_hash = $1 FOR UPDATE`, [sha(normCode(code))])).rows[0];
    if (!inv) throw fail(404, "That partner code isn't right. Check it with the shop that gave it to you.");
    if (inv.used_at) throw fail(409, "That partner code was already used. Ask for a new one.");
    if (inv.expires_at < new Date()) throw fail(410, "That partner code has expired. Ask for a new one.");
    if (inv.install_id === install.id && inv.shop_ref === shopRef) throw fail(400, "That's your own partner code. Give it to the other shop.");
    const mine = inv.side === "repair" ? "retail" : "repair";
    const repair = inv.side === "repair" ? { i: inv.install_id, r: inv.shop_ref, n: inv.shop_name } : { i: install.id, r: shopRef, n: shopName };
    const retail = inv.side === "retail" ? { i: inv.install_id, r: inv.shop_ref, n: inv.shop_name } : { i: install.id, r: shopRef, n: shopName };
    // Linking the same two shops again picks up the old link instead of making a second one. Redeems for the same
    // pair take turns (a lock on the pair for this transaction): two codes for one pair entered at the same moment
    // would otherwise each find no link yet and each make one.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [[repair.i, repair.r, retail.i, retail.r].join("|")]);
    let link = (
      await client.query(
        `SELECT * FROM partner_links WHERE repair_install_id = $1 AND repair_shop_ref = $2 AND retail_install_id = $3 AND retail_shop_ref = $4`,
        [repair.i, repair.r, retail.i, retail.r],
      )
    ).rows[0];
    if (link) {
      link = (
        await client.query(
          `UPDATE partner_links SET status = 'ACTIVE', ended_at = NULL, terms = $2, repair_name = $3, retail_name = $4 WHERE id = $1 RETURNING *`,
          [link.id, inv.terms, repair.n, retail.n],
        )
      ).rows[0];
    } else {
      link = (
        await client.query(
          `INSERT INTO partner_links (id, repair_install_id, repair_shop_ref, repair_name, retail_install_id, retail_shop_ref, retail_name, terms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [newId(), repair.i, repair.r, repair.n, retail.i, retail.r, retail.n, inv.terms],
        )
      ).rows[0];
    }
    await client.query(`UPDATE partner_invites SET used_at = now(), link_id = $2 WHERE code_hash = $1`, [inv.code_hash, link.id]);
    // Both sides hear about it the same way (the inviter learns the link exists from this message).
    await client.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data) VALUES ($1, $2, 'hub', 'link.created', $3)`, [
      newId(),
      link.id,
      JSON.stringify(linkOut(link)),
    ]);
    return { link: linkOut(link), side: mine };
  }

  async function myLink(c, id, shopRef) {
    const link = await one(`SELECT * FROM partner_links WHERE id = $1`, [id]);
    const side = link && sideOf(link, c.get("install").id, shopRef);
    if (!side) throw fail(404, "No such partner link for this shop.");
    return { link, side };
  }

  // A shop makes a code to hand to the shop it wants to work with (repair shop -> sewing shop, or the other way).
  // Limits count per shop as well as per install: a hosted install serves many companies, and one mustn't use up the
  // others' (the install's own limit stays, higher, as a ceiling).
  const allowShop = (c, what, shopRef, perShop, perInstall) =>
    allow(`${what}:${c.get("install").id}:${shopRef}`, perShop) && allow(`${what}:${c.get("install").id}`, perInstall);

  member.post("/partners/invites", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
    if (!allowShop(c, "pinvite", shopRef, 30, 300)) throw fail(429, "Too many partner codes in the last hour.");
    const side = String(body.side ?? "");
    if (!SIDES.has(side)) throw fail(400, "side is repair or retail.");
    const terms = body.terms && typeof body.terms === "object" && !Array.isArray(body.terms) ? body.terms : {};
    if (JSON.stringify(terms).length > 20_000) throw fail(400, "The terms are too long.");
    const code = newCode();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400_000);
    await q(`INSERT INTO partner_invites (code_hash, install_id, shop_ref, shop_name, side, terms, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      sha(normCode(code)),
      c.get("install").id,
      shopRef,
      shopName,
      side,
      JSON.stringify(terms),
      expiresAt,
    ]);
    return c.json({ code, expiresAt, hubName });
  });

  // An install that's already on the hub redeems a code for one of its shops.
  member.post("/partners/redeem", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
    if (!allowShop(c, "predeem", shopRef, 20, 200)) throw fail(429, "Too many tries. Wait an hour.");
    return c.json(await tx((client) => redeem(client, c.get("install"), body.code, shopRef, shopName)));
  });

  // A sewing shop that isn't a community member: the partner code alone gets it an install key for the partner routes.
  app.post("/v1/partners/join", small, async (c) => {
    const ip = clientIp(c);
    if (!allow(`pjoin:${ip}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
    const inv = await one(
      `SELECT i.used_at, i.expires_at, i.install_id, coalesce(n.invited_by, n.id) AS root
       FROM partner_invites i JOIN installs n ON n.id = i.install_id WHERE i.code_hash = $1`,
      [sha(normCode(body.code))],
    );
    if (!inv || inv.used_at || inv.expires_at < new Date()) throw fail(404, "That partner code isn't right, was used already, or expired. Ask for a new one.");
    // Every partner-only install goes back to a member whose code (or whose partners' codes) brought it on. Each new
    // install has limits of its own, so without a cap one member could multiply its room on the hub.
    if (!allow(`pjoinby:${inv.root}`, 10)) throw fail(429, "That shop's partner codes brought on too many shops in the last hour. Try again later.");
    const minted = await one(`SELECT count(*)::int AS n FROM installs WHERE invited_by = $1`, [inv.root]);
    if (minted.n >= MAX_MINTED) throw fail(403, "That shop has brought as many partner shops onto the hub as it may. Ask the hub admin.");
    return c.json(
      await tx(async (client) => {
        const { id, key } = await createInstall(client, shopName, str(body.contact, 200), "partner");
        await client.query(`UPDATE installs SET invited_by = $2 WHERE id = $1`, [id, inv.root]);
        const out = await redeem(client, { id }, body.code, shopRef, shopName);
        return { installId: id, installKey: key, hubName, scope: "partner", ...out };
      }),
    );
  });

  // Every link this install's shops are on, from each shop's side.
  member.get("/partners/links", async (c) => {
    const id = c.get("install").id;
    const rows = (await q(`SELECT * FROM partner_links WHERE repair_install_id = $1 OR retail_install_id = $1 ORDER BY created_at`, [id])).rows;
    const out = [];
    for (const l of rows) {
      if (l.repair_install_id === id) out.push({ ...linkOut(l), side: "repair", shopRef: l.repair_shop_ref });
      if (l.retail_install_id === id) out.push({ ...linkOut(l), side: "retail", shopRef: l.retail_shop_ref });
    }
    return c.json(out);
  });

  // Counted as it arrives, so a body sent without a length (chunked) is held to the limit too.
  const message = bodyLimit({ maxSize: MAX_MESSAGE + 64 * 1024, onError: (c) => c.json({ error: "That message is too large (4 MB at most)." }, 413) });
  member.post("/partners/links/:id/messages", message, async (c) => {
    const installId = c.get("install").id;
    const body = await c.req.json().catch(() => ({}));
    const shopRef = str(body.shopRef, 64);
    const { link, side } = await myLink(c, c.req.param("id"), shopRef);
    // Counted per shop (a hosted install serves many), per install, and per side of the link.
    if (!allowShop(c, "pmsg", shopRef, 3000, 30000) || !allow(`pmsglink:${link.id}:${side}`, link.status === "ACTIVE" ? 1000 : 100)) {
      throw fail(429, "Too many partner messages in the last hour.");
    }
    const id = str(body.id, 64);
    const type = String(body.type ?? "");
    if (!id) throw fail(400, "Send the message's own id (so a retry isn't stored twice).");
    if (!TYPE.test(type)) throw fail(400, "type looks like job.new or order.update.");
    if (link.status !== "ACTIVE" && NEW_WORK.has(type)) throw fail(409, "That partnership has ended: it takes no new work, only updates and payments.");
    const data = JSON.stringify(body.data);
    if (data === undefined || data.length > MAX_MESSAGE) throw fail(400, "Send data (4 MB at most).");
    // Room as well as count: an hour's budget, and a ceiling on what the install and the link have on the hub
    // altogether. These answers make StitchBench try again later rather than give the message up.
    const bytes = Buffer.byteLength(data);
    const budgets = [
      [`pbytes:${installId}:${shopRef}`, MAX_HOUR_BYTES],
      [`pbytes:${installId}`, MAX_INSTALL_HOUR_BYTES],
      [`pbytes:link:${link.id}:${side}`, MAX_LINK_HOUR_BYTES],
    ];
    if (!allowBytes(budgets, bytes)) throw fail(429, "This shop has sent this partner all the hub takes in an hour. It will go through later.");
    const kept = await installStored(installId);
    const keptLink = await linkStored(link.id, side);
    if (kept.bytes + bytes > MAX_STORED || keptLink.bytes + bytes > MAX_LINK_STORED) {
      throw fail(507, "This shop's partner messages fill its room on the hub. Old ones clear after a year; ask the hub admin if you need room sooner.");
    }
    const row = await one(
      `INSERT INTO partner_messages (id, link_id, from_side, type, data, bytes) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (link_id, from_side, id) DO NOTHING RETURNING seq`,
      [id, link.id, side, type, data, bytes],
    );
    if (row) {
      kept.bytes += bytes;
      keptLink.bytes += bytes;
    }
    return c.json({ ok: true, duplicate: !row, seq: row ? String(row.seq) : null });
  });

  // Messages for this install's shops after `since`, oldest first. A hub message goes to both sides; when both shops
  // of a link live in this same install each gets its own copy.
  member.get("/partners/messages", async (c) => {
    const id = c.get("install").id;
    const since = /^\d+$/.test(c.req.query("since") ?? "") ? c.req.query("since") : "0";
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    // A page is cut by size as well as by count. Messages can be 4 MB each: a page of hundreds would be more JSON
    // than the hub can build or the shop can take in before it gives up, and it would stay stuck on that page for
    // every partner it has. Sizes are the JSON's, noted when each message came in (the stored size is compressed: a
    // 4 MB message of one letter repeated takes a few KB on disk). Older messages were measured by migration 008.
    const page = (
      await q(
        `SELECT m.seq, coalesce(m.bytes, octet_length(m.data::text)) AS bytes FROM partner_messages m JOIN partner_links l ON l.id = m.link_id
         WHERE m.seq > $2 AND m.seq <= $4 AND ((l.repair_install_id = $1 AND m.from_side <> 'repair') OR (l.retail_install_id = $1 AND m.from_side <> 'retail'))
         ORDER BY m.seq LIMIT $3`,
        [id, since, limit, (await feedLimit()).partner],
      )
    ).rows;
    let n = 0;
    for (let bytes = 0; n < page.length && (n === 0 || bytes + page[n].bytes <= MAX_PAGE_BYTES); n++) bytes += page[n].bytes;
    const seqs = page.slice(0, n).map((r) => r.seq);
    const rows = seqs.length
      ? (
          await q(
            `SELECT m.*, s.to_side, CASE s.to_side WHEN 'repair' THEN l.repair_shop_ref ELSE l.retail_shop_ref END AS to_shop_ref
             FROM partner_messages m JOIN partner_links l ON l.id = m.link_id
             CROSS JOIN (VALUES ('repair'), ('retail')) AS s(to_side)
             WHERE m.seq = ANY($2::bigint[]) AND m.from_side <> s.to_side AND (CASE s.to_side WHEN 'repair' THEN l.repair_install_id ELSE l.retail_install_id END) = $1
             ORDER BY m.seq, s.to_side`,
            [id, seqs],
          )
        ).rows
      : [];
    const next = seqs.length ? String(seqs[seqs.length - 1]) : since;
    return c.json({
      messages: rows.map((m) => ({
        seq: String(m.seq),
        id: m.id,
        linkId: m.link_id,
        fromSide: m.from_side,
        toSide: m.to_side,
        toShopRef: m.to_shop_ref,
        type: m.type,
        data: m.data,
        createdAt: m.created_at,
      })),
      next,
      more: page.length >= limit || n < page.length,
    });
  });

  // Either side can end the partnership; both keep their records, and messages can still pass for the final statement.
  member.post("/partners/links/:id/end", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { link, side } = await myLink(c, c.req.param("id"), str(body.shopRef, 64));
    const ended = await tx(async (client) => {
      const l = (await client.query(`UPDATE partner_links SET status = 'ENDED', ended_at = COALESCE(ended_at, now()) WHERE id = $1 RETURNING *`, [link.id])).rows[0];
      await client.query(`INSERT INTO partner_messages (id, link_id, from_side, type, data) VALUES ($1, $2, 'hub', 'link.ended', $3)`, [
        newId(),
        link.id,
        JSON.stringify({ ...linkOut(l), endedBy: side, note: str(body.note, 500) }),
      ]);
      return l;
    });
    return c.json(linkOut(ended));
  });

  // Old messages and spent codes go after a while. A message goes after a year only once every shop it's for has
  // been on the hub since it was sent (it pulls on every sync, so it has had it); the hub doesn't keep each shop's
  // place in the feed, so this stands in for "delivered". After three years it goes regardless.
  const sweep = () =>
    Promise.all([
      q(
        `DELETE FROM partner_messages m USING partner_links l
         WHERE l.id = m.link_id AND m.created_at < now() - make_interval(days => $1)
           AND (m.created_at < now() - make_interval(days => $2)
             OR ((m.from_side = 'repair' OR m.created_at < (SELECT last_seen_at FROM installs WHERE id = l.repair_install_id))
               AND (m.from_side = 'retail' OR m.created_at < (SELECT last_seen_at FROM installs WHERE id = l.retail_install_id))))`,
        [KEEP_DAYS, KEEP_UNPULLED_DAYS],
      ),
      q(`DELETE FROM partner_invites WHERE expires_at < now() - interval '30 days'`),
    ]).catch((e) => console.error("partner sweep:", e.message));
  setInterval(sweep, 6 * 3600_000).unref();
}
