// Partner links: a private channel between a repair shop and a sewing / quilt shop that works with it (takes machines
// in for repair, orders parts and notions, holds the repair shop's stock on consignment). One side makes an invite code
// and hands it over in person; the other side redeems it. After that each side sends messages that only the other side
// receives. The hub doesn't read them: machine intake, repair status, orders, consignment sales and statements are all
// just typed JSON to it. A sewing shop that isn't a community member joins with the invite alone and can then use the
// partner routes and nothing else.
import crypto from "node:crypto";
import { one, q, tx } from "./db.mjs";

const SIDES = new Set(["repair", "retail"]);
const TYPE = /^[a-z]{2,20}(\.[a-z]{2,20})?$/;
const MAX_MESSAGE = 4 * 1024 * 1024; // intake photos travel inside the message, already shrunk by the app
const INVITE_DAYS = 14;
const KEEP_DAYS = 365;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L: the code is read out and typed at a counter

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

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

export function registerPartners({ app, member, fail, newId, allow, sha, hubName, createInstall }) {
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
    // Linking the same two shops again picks up the old link instead of making a second one.
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
  member.post("/partners/invites", async (c) => {
    if (!allow(`pinvite:${c.get("install").id}`, 30)) throw fail(429, "Too many partner codes in the last hour.");
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
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
  member.post("/partners/redeem", async (c) => {
    if (!allow(`predeem:${c.get("install").id}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
    return c.json(await tx((client) => redeem(client, c.get("install"), body.code, shopRef, shopName)));
  });

  // A sewing shop that isn't a community member: the partner code alone gets it an install key for the partner routes.
  app.post("/v1/partners/join", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    if (!allow(`pjoin:${ip}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const { shopRef, shopName } = shopFields(body);
    const inv = await one(`SELECT used_at, expires_at FROM partner_invites WHERE code_hash = $1`, [sha(normCode(body.code))]);
    if (!inv || inv.used_at || inv.expires_at < new Date()) throw fail(404, "That partner code isn't right, was used already, or expired. Ask for a new one.");
    return c.json(
      await tx(async (client) => {
        const { id, key } = await createInstall(client, shopName, str(body.contact, 200), "partner");
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

  member.post("/partners/links/:id/messages", async (c) => {
    if (!allow(`pmsg:${c.get("install").id}`, 3000)) throw fail(429, "Too many partner messages in the last hour.");
    if (Number(c.req.header("content-length") ?? 0) > MAX_MESSAGE) throw fail(413, "That message is too large (4 MB at most).");
    const body = await c.req.json().catch(() => ({}));
    const { link, side } = await myLink(c, c.req.param("id"), str(body.shopRef, 64));
    const id = str(body.id, 64);
    const type = String(body.type ?? "");
    if (!id) throw fail(400, "Send the message's own id (so a retry isn't stored twice).");
    if (!TYPE.test(type)) throw fail(400, "type looks like job.new or order.update.");
    if (body.data === undefined || JSON.stringify(body.data).length > MAX_MESSAGE) throw fail(400, "Send data (4 MB at most).");
    const row = await one(
      `INSERT INTO partner_messages (id, link_id, from_side, type, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (link_id, from_side, id) DO NOTHING RETURNING seq`,
      [id, link.id, side, type, JSON.stringify(body.data)],
    );
    return c.json({ ok: true, duplicate: !row, seq: row ? String(row.seq) : null });
  });

  // Messages for this install's shops after `since`, oldest first. A hub message goes to both sides; when both shops
  // of a link live in this same install each gets its own copy.
  member.get("/partners/messages", async (c) => {
    const id = c.get("install").id;
    const since = /^\d+$/.test(c.req.query("since") ?? "") ? c.req.query("since") : "0";
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    const rows = (
      await q(
        `WITH page AS (
           SELECT m.seq FROM partner_messages m JOIN partner_links l ON l.id = m.link_id
           WHERE m.seq > $2 AND ((l.repair_install_id = $1 AND m.from_side <> 'repair') OR (l.retail_install_id = $1 AND m.from_side <> 'retail'))
           ORDER BY m.seq LIMIT $3)
         SELECT m.*, s.to_side, CASE s.to_side WHEN 'repair' THEN l.repair_shop_ref ELSE l.retail_shop_ref END AS to_shop_ref
         FROM page p JOIN partner_messages m ON m.seq = p.seq JOIN partner_links l ON l.id = m.link_id
         CROSS JOIN (VALUES ('repair'), ('retail')) AS s(to_side)
         WHERE m.from_side <> s.to_side AND (CASE s.to_side WHEN 'repair' THEN l.repair_install_id ELSE l.retail_install_id END) = $1
         ORDER BY m.seq, s.to_side`,
        [id, since, limit],
      )
    ).rows;
    const next = rows.length ? String(rows[rows.length - 1].seq) : since;
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
      more: new Set(rows.map((r) => String(r.seq))).size >= limit,
    });
  });

  // Either side can end the partnership; both keep their records, and messages can still pass for the final statement.
  member.post("/partners/links/:id/end", async (c) => {
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

  // Old messages and spent codes go after a while.
  const sweep = () =>
    Promise.all([
      q(`DELETE FROM partner_messages WHERE created_at < now() - make_interval(days => $1)`, [KEEP_DAYS]),
      q(`DELETE FROM partner_invites WHERE expires_at < now() - interval '30 days'`),
    ]).catch((e) => console.error("partner sweep:", e.message));
  setInterval(sweep, 6 * 3600_000).unref();
}
