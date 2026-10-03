// A company moving from one install to another (StitchBench docs/plans/company-move-design.md section 5, package
// move-hub). The company keeps its id (shop_ref) everywhere; what changes is the install that speaks for it. So the hub
// rewrites install_id on every row keyed by that company, in one transaction, and everything follows: partner links,
// marketplace listings and orders, ratings, shared notes, link and cross-reference revisions, parts usage, unused
// partner invites, and the shop row itself with its account, subscription and keys. Partner shops are told nothing:
// their links hold a name and terms, never an address, and the hub routes by the link's install ids.
//
//   POST   /v1/shops/:ref/move-token  the install the company is on, when it makes the move file: a token, answered
//                                     once (only its hash is kept), good for 14 days and one use; a second call
//                                     replaces the first
//   DELETE /v1/shops/:ref/move-token  the owner cancelled the move: the token stops working
//   POST   /v1/shops/move             the install the company moved to, { shopRef, token, shopName, kind, program,
//                                     version }: with its install key, or without one from a program on no hub yet (the
//                                     hub makes it an install, as /v1/partners/join and /v1/accounts/start do, and
//                                     answers its key once). Answers the shop and its standing, the install's key when
//                                     one was made, and the partner links that moved (the program pulls their messages
//                                     from the old install's place in the feed: one sequence for every install).
//   GET    /v1/admin/moves, POST /v1/admin/shops/:id/move   the hub admin's list and "Move this shop" by hand
//
// The old install learns it at its next sync: its claim (or standing) for that company answers 410 { moved, to, at }.
// Legacy rows with shop_ref '' (from before each company had its own identity) belong to the install, not to a
// company, and stay where they are.
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q, tx } from "./db.mjs";
import { claimAnswer } from "./billing.mjs";

export const MOVE_DAYS = 14;
const WRONG_TOKENS = 100; // wrong move tokens from everywhere together in an hour, like wrong join keys
const KINDS = new Set(["repair", "retail", "both"]);
const PROGRAMS = new Set(["StitchBench", "StitchShop"]);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/**
 * Where a company went, for the install it left: the newest move of `shopRef` away from `installId`, while that install
 * no longer holds the company (a company that came back is its own again). { moved, to: the install it is on now, at }
 * or null.
 */
export async function movedAway(installId, shopRef) {
  if (!installId || !shopRef) return null;
  const r = await one(
    `SELECT m.used_at, i.name AS to_name FROM shop_moves m JOIN shops s ON s.id = m.shop_id JOIN installs i ON i.id = s.install_id
     WHERE m.from_install_id = $1 AND m.shop_ref = $2 AND m.used_at IS NOT NULL AND s.install_id <> $1
       AND NOT EXISTS (SELECT 1 FROM shops h WHERE h.install_id = $1 AND h.shop_ref = $2)
     ORDER BY m.used_at DESC LIMIT 1`,
    [installId, shopRef],
  );
  return r ? { moved: true, to: r.to_name, at: r.used_at } : null;
}

/** The answer the old install gets for a company that moved away: 410, in words, with { moved, to, at } beside them. */
export function movedError(fail, m) {
  const e = fail(410, `This company moved to ${m.to} on ${day(m.at)}. This copy is read-only now; delete it after 30 days.`);
  e.extra = { moved: true, to: m.to, at: m.at };
  return e;
}

/** Throws the 410 when this install no longer holds the company because it moved away; otherwise nothing. */
export async function refuseIfMoved(fail, installId, shopRef) {
  const m = await movedAway(installId, shopRef);
  if (m) throw movedError(fail, m);
}

/**
 * Every row of the company (`shop.shop_ref`) on the install it is on goes to `to`, in the caller's transaction. Rows
 * of the install's other companies, and legacy rows with shop_ref '', stay. Listings, orders and notes take a new
 * number in the change feed so the new install receives them wherever its place is (an install already on the hub has
 * read past their old numbers); parts usage merges on its key, the newer report winning. Returns the rows moved per
 * table.
 */
export async function rewriteCompany(client, shop, to) {
  const from = shop.install_id;
  const ref = shop.shop_ref;
  const n = {};
  if (from === to) return n;
  const run = async (name, sql, params = [from, ref, to]) => {
    n[name] = (n[name] ?? 0) + (await client.query(sql, params)).rowCount;
  };
  await run("shops", `UPDATE shops SET install_id = $3 WHERE install_id = $1 AND shop_ref = $2`);
  await run("partner_links", `UPDATE partner_links SET repair_install_id = $3 WHERE repair_install_id = $1 AND repair_shop_ref = $2`);
  await run("partner_links", `UPDATE partner_links SET retail_install_id = $3 WHERE retail_install_id = $1 AND retail_shop_ref = $2`);
  await run("partner_invites", `UPDATE partner_invites SET install_id = $3 WHERE install_id = $1 AND shop_ref = $2 AND used_at IS NULL`);
  await run("listings", `UPDATE listings SET install_id = $3, seq = nextval('change_seq') WHERE install_id = $1 AND shop_ref = $2`);
  await run("orders", `UPDATE orders SET seller_install_id = $3, seq = nextval('change_seq') WHERE seller_install_id = $1 AND seller_shop_ref = $2`);
  await run("orders", `UPDATE orders SET buyer_install_id = $3, seq = nextval('change_seq') WHERE buyer_install_id = $1 AND buyer_shop_ref = $2`);
  await run("order_ratings", `UPDATE order_ratings SET rater_install_id = $3 WHERE rater_install_id = $1 AND rater_shop_ref = $2`);
  await run("order_ratings", `UPDATE order_ratings SET rated_install_id = $3 WHERE rated_install_id = $1 AND rated_shop_ref = $2`);
  await run("posts", `UPDATE posts SET install_id = $3, seq = nextval('change_seq') WHERE install_id = $1 AND shop_ref = $2`);
  await run("link_revisions", `UPDATE link_revisions SET install_id = $3 WHERE install_id = $1 AND shop_ref = $2`);
  await run("xpart_revisions", `UPDATE xpart_revisions SET install_id = $3 WHERE install_id = $1 AND shop_ref = $2`);
  // Parts usage: a month the new install already reported for this company (it synced before the move) keeps the
  // newer of the two reports, which counts every ticket of the month since the company's tickets travel with it.
  await client.query(
    `INSERT INTO part_usage (install_id, shop_ref, month, number_key, number, brand, qty, tickets, updated_at)
     SELECT $3, shop_ref, month, number_key, number, brand, qty, tickets, updated_at FROM part_usage WHERE install_id = $1 AND shop_ref = $2
     ON CONFLICT (install_id, shop_ref, month, number_key) DO UPDATE
       SET number = EXCLUDED.number, brand = EXCLUDED.brand, qty = EXCLUDED.qty, tickets = EXCLUDED.tickets, updated_at = EXCLUDED.updated_at
       WHERE part_usage.updated_at < EXCLUDED.updated_at`,
    [from, ref, to],
  );
  await run("part_usage", `DELETE FROM part_usage WHERE install_id = $1 AND shop_ref = $2`, [from, ref]);
  return n;
}

/** The partner links the company is on, from its side: what the new install pulls the backlog of. */
async function partnerLinksOf(client, installId, shopRef) {
  const { rows } = await client.query(
    `SELECT id FROM partner_links WHERE (repair_install_id = $1 AND repair_shop_ref = $2) OR (retail_install_id = $1 AND retail_shop_ref = $2) ORDER BY created_at`,
    [installId, shopRef],
  );
  return rows.map((r) => r.id);
}

/**
 * A row the new install made for this company before the move reached the hub (its sync claimed the company while the
 * hub step waited) is in the way of the moved one (shops is unique per install and company). One with nothing of its
 * own (no account, no subscription) goes; one with either is for the hub admin to sort out.
 */
async function clearStray(client, fail, to, shopRef, keepId) {
  const stray = (await client.query(`SELECT s.id, s.account_id, (SELECT count(*)::int FROM subscriptions b WHERE b.shop_id = s.id) AS subs FROM shops s WHERE s.install_id = $1 AND s.shop_ref = $2 AND s.id <> $3 FOR UPDATE`, [to, shopRef, keepId])).rows[0];
  if (!stray) return;
  if (stray.account_id || stray.subs) throw fail(409, "This install already has a shop on the hub for this company, with its own account. Ask the hub admin to move it by hand.");
  await client.query(`DELETE FROM shops WHERE id = $1`, [stray.id]);
}

export function registerMoves({ app, member, admin, fail, newId, allow, bucket, clientIp, hubName, createInstall, installByKey }) {
  const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });

  const shopOut = (s) => ({ id: s.id, shopRef: s.shop_ref, name: s.name, kind: s.kind, program: s.program, version: s.version, createdAt: s.created_at, lastSeenAt: s.last_seen_at });
  /** The shop with its account and standing (and the key the program should hold), as /v1/shops/claim answers. */
  async function standingOf(shop) {
    const a = shop.account_id ? await one(`SELECT email, verified_at FROM accounts WHERE id = $1`, [shop.account_id]) : null;
    return { shop: shopOut(shop), account: a ? { email: a.email, verified: Boolean(a.verified_at) } : null, ...(await claimAnswer(shop)) };
  }

  // The install the company is on, making the move file: a token for the new install to redeem. The shop row is made
  // on the spot when the company never claimed itself (an older program's first sync).
  member.post("/shops/:ref/move-token", small, async (c) => {
    const install = c.get("install");
    const ref = str(c.req.param("ref"), 64);
    if (!ref) throw fail(400, "Send the company's id.");
    if (!allow(`move-token:${install.id}:${ref}`, 20) || !allow(`move-token:${install.id}`, 200)) throw fail(429, "Too many move tokens in the last hour. Try again later.");
    const body = await c.req.json().catch(() => ({}));
    const token = `shm_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + MOVE_DAYS * 86400_000);
    await tx(async (client) => {
      let shop = (await client.query(`SELECT * FROM shops WHERE install_id = $1 AND shop_ref = $2 FOR UPDATE`, [install.id, ref])).rows[0];
      if (!shop) {
        await refuseIfMoved(fail, install.id, ref);
        shop = (
          await client.query(
            `INSERT INTO shops (id, install_id, shop_ref, name, kind, program, version) VALUES ($1, $2, $3, coalesce($4, $7), coalesce($5, 'repair'), $6, $8)
             ON CONFLICT (install_id, shop_ref) DO UPDATE SET last_seen_at = now() RETURNING *`,
            [newId(), install.id, ref, str(body.shopName, 120), KINDS.has(body.kind) ? body.kind : null, PROGRAMS.has(body.program) ? body.program : null, install.name, str(body.version, 40)],
          )
        ).rows[0];
      }
      // One live token per company: the newest move file is the one that works.
      await client.query(`UPDATE shop_moves SET cancelled_at = now() WHERE shop_id = $1 AND used_at IS NULL AND cancelled_at IS NULL`, [shop.id]);
      await client.query(`INSERT INTO shop_moves (id, shop_id, shop_ref, token_hash, from_install_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        newId(),
        shop.id,
        ref,
        sha(token),
        install.id,
        expiresAt,
      ]);
    });
    return c.json({ token, expiresAt, shopRef: ref, hubName });
  });

  // The owner cancelled the move on the install the company is still on: no move file of before works any more.
  member.delete("/shops/:ref/move-token", async (c) => {
    const install = c.get("install");
    const r = await q(
      `UPDATE shop_moves m SET cancelled_at = now() FROM shops s
       WHERE s.id = m.shop_id AND s.install_id = $1 AND s.shop_ref = $2 AND m.from_install_id = $1 AND m.used_at IS NULL AND m.cancelled_at IS NULL`,
      [install.id, String(c.req.param("ref") ?? "")],
    );
    return c.json({ ok: true, cancelled: r.rowCount });
  });

  // The install the company moved to redeems the token from the move file.
  app.post("/v1/shops/move", small, async (c) => {
    const wrong = bucket("move-token:wrong");
    if (wrong.n >= WRONG_TOKENS) throw fail(429, "Too many wrong move tokens were tried lately. Try again in an hour.");
    const h = c.req.header("authorization") ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7) : "";
    const caller = key ? await installByKey(key) : null;
    if (!allow(caller ? `shop-move:${caller.id}` : `shop-move:${clientIp(c)}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const shopRef = str(body.shopRef, 64);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!shopRef || !token) throw fail(400, "Send shopRef and the move token from the move file.");
    const shopName = str(body.shopName, 120);
    if (!caller && !shopName) throw fail(400, "Give the company's name.");
    const out = await tx(async (client) => {
      const m = (await client.query(`SELECT * FROM shop_moves WHERE token_hash = $1 FOR UPDATE`, [sha(token)])).rows[0];
      if (!m || m.shop_ref !== shopRef) {
        wrong.n++;
        throw fail(404, "That move token isn't right for this company. Use the move file the other install made.");
      }
      let shop = (await client.query(`SELECT * FROM shops WHERE id = $1 FOR UPDATE`, [m.shop_id])).rows[0];
      // Already where it should be: an earlier try whose answer was lost on the way, the hub admin's move by hand, or a
      // company imported back into the install it left. Nothing to rewrite; the same answer again.
      if (caller && shop && shop.install_id === caller.id) {
        if (!m.used_at) await client.query(`UPDATE shop_moves SET used_at = now(), to_install_id = $2, moved = '{}' WHERE id = $1`, [m.id, caller.id]);
        return { shop, made: null, moved: m.moved ?? {}, again: true };
      }
      if (m.used_at) throw fail(409, "That move token was used already: the company moved then. If that wasn't this install, ask the hub admin.");
      if (m.cancelled_at) throw fail(410, "That move token was replaced by a newer move file, or the move was cancelled. Use the newest move file.");
      if (m.expires_at < new Date()) throw fail(410, `That move token has expired (they last ${MOVE_DAYS} days). Make a new move file on the other install, or ask the hub admin to move the company by hand.`);
      if (!shop || shop.install_id !== m.from_install_id) throw fail(409, "The company has moved since that move file was made. Make a new move file where it is now.");
      let made = null;
      let to = caller?.id;
      if (!caller) {
        // A program on no hub yet: an install of its own, with the scope the company had (a member's company stays a
        // member; a partner-only one stays partner-only; one waiting on its account's email keeps waiting).
        const scope = (await client.query(`SELECT scope FROM installs WHERE id = $1`, [m.from_install_id])).rows[0]?.scope ?? "member";
        made = { ...(await createInstall(client, shopName, str(body.contact, 200), scope)), scope };
        to = made.id;
      }
      await clearStray(client, fail, to, shopRef, shop.id);
      const moved = await rewriteCompany(client, shop, to);
      shop = (
        await client.query(
          `UPDATE shops SET name = coalesce($2, name), kind = coalesce($3, kind), program = coalesce($4, program), version = coalesce($5, version), last_seen_at = now() WHERE id = $1 RETURNING *`,
          [shop.id, shopName, KINDS.has(body.kind) ? body.kind : null, PROGRAMS.has(body.program) ? body.program : null, str(body.version, 40)],
        )
      ).rows[0];
      await client.query(`UPDATE shop_moves SET used_at = now(), to_install_id = $2, moved = $3 WHERE id = $1`, [m.id, to, JSON.stringify(moved)]);
      return { shop, made, moved, again: false };
    });
    const links = await partnerLinksOf({ query: q }, out.shop.install_id, shopRef);
    return c.json({
      ok: true,
      moved: out.moved,
      ...(await standingOf(out.shop)),
      // The partner links that moved: their messages since the old install's place in the feed (partnerCursor in the
      // move file) are pulled once with ?shopRef=, and the messages the company had already applied are skipped there.
      partner: { shopRef, links },
      hubName,
      ...(out.made ? { installId: out.made.id, installKey: out.made.key, scope: out.made.scope } : {}),
    });
  });

  // ----- hub admin -----

  admin.get("/moves", async (c) => {
    const { rows } = await q(
      `SELECT m.*, s.name AS shop_name, f.name AS from_name, t.name AS to_name, n.name AS now_name, s.install_id AS now_install_id
       FROM shop_moves m JOIN shops s ON s.id = m.shop_id JOIN installs f ON f.id = m.from_install_id
       LEFT JOIN installs t ON t.id = m.to_install_id JOIN installs n ON n.id = s.install_id
       ORDER BY m.created_at DESC LIMIT 200`,
    );
    const now = new Date();
    return c.json({
      moves: rows.map((m) => ({
        id: m.id,
        shopId: m.shop_id,
        shopRef: m.shop_ref,
        shopName: m.shop_name,
        from: { id: m.from_install_id, name: m.from_name },
        to: m.to_install_id ? { id: m.to_install_id, name: m.to_name } : null,
        now: { id: m.now_install_id, name: m.now_name },
        state: m.used_at ? "moved" : m.cancelled_at ? "cancelled" : m.expires_at < now ? "expired" : "waiting",
        byAdmin: m.by_admin,
        moved: m.moved,
        createdAt: m.created_at,
        expiresAt: m.expires_at,
        usedAt: m.used_at,
      })),
    });
  });

  // "Move this shop" by hand (design section 5, the fallback door): the company's rows go to another install already on
  // the hub, as a token would have moved them. For a move file whose token was never minted (the hub was down), or
  // expired.
  admin.post("/shops/:id/move", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const toId = str(body.toInstallId, 64);
    if (!toId) throw fail(400, "Choose the install the shop moved to.");
    const out = await tx(async (client) => {
      const shop = (await client.query(`SELECT * FROM shops WHERE id = $1 FOR UPDATE`, [c.req.param("id")])).rows[0];
      if (!shop) throw fail(404, "No such shop.");
      const target = (await client.query(`SELECT id, name, blocked FROM installs WHERE id = $1`, [toId])).rows[0];
      if (!target) throw fail(404, "No such install.");
      if (target.blocked) throw fail(409, "That install is blocked. Unblock it first.");
      if (shop.install_id === target.id) throw fail(409, "The shop is on that install already.");
      await clearStray(client, fail, target.id, shop.shop_ref, shop.id);
      const from = shop.install_id;
      const moved = await rewriteCompany(client, shop, target.id);
      await client.query(`UPDATE shop_moves SET cancelled_at = now() WHERE shop_id = $1 AND used_at IS NULL AND cancelled_at IS NULL`, [shop.id]);
      await client.query(
        `INSERT INTO shop_moves (id, shop_id, shop_ref, from_install_id, to_install_id, expires_at, used_at, by_admin, moved) VALUES ($1, $2, $3, $4, $5, now(), now(), true, $6)`,
        [newId(), shop.id, shop.shop_ref, from, target.id, JSON.stringify(moved)],
      );
      return { moved, to: target.name };
    });
    return c.json({ ok: true, ...out });
  });
}
