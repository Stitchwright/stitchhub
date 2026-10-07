// Hosted shops started from the hub, and password resets from the hub account to a Windows install (StitchBench
// docs/plans/hub-accounts-billing-design.md sections 4.3.4 and 4.4, package hosted-provisioning).
//
//   POST /account/api/hosted                     a verified account starts a hosted StitchShop or StitchBench: the hub
//                                                calls that service's POST /api/platform/companies (HOSTED_STITCHSHOP_URL
//                                                or HOSTED_STITCHBENCH_URL, Authorization: Bearer PLATFORM_API_TOKEN),
//                                                ties the new company to the account (the service says which install it
//                                                is on the hub; its first claim finds the company there) and answers the
//                                                owner's set-password link, shown once and never stored. One request per
//                                                account per 10 minutes.
//   POST /account/api/shops/:id/reset-owner      the account asks to reset its owner's password on a shop whose program
//                                                allows it (reset_opt_in, from the program's claim): a grant signed with
//                                                HUB_LICENSE_KEY { shopRef, installId, email, nonce, exp: 1 hour }
//   GET  /v1/shops/:ref/reset-grants             the program (install key) fetches the grants waiting for that company;
//                                                none while it doesn't allow resets
//   POST /v1/shops/:ref/reset-grants/:id/done    the program says what its window answered (allowed | refused)
//
// The program checks everything again (the signature with the compiled hub key, the company, the install, the expiry,
// its own opt-in, an owner login with that email, one use) and shows the grant only in its own window on the PC.
import crypto from "node:crypto";
import { one, q, tx } from "./db.mjs";
import { signer as hubSigner, signGrant } from "./license.mjs";
import { refuseIfMoved } from "./moves.mjs";

const GRANT_MINUTES = 60;
const HOSTED_GAP_MINUTES = 10;
const PROGRAMS = { StitchShop: { env: "HOSTED_STITCHSHOP_URL", kind: "retail" }, StitchBench: { env: "HOSTED_STITCHBENCH_URL", kind: "repair" } };
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** The hosted service for `program` ({ origin, token, kind }), or { problem } in words. Nothing here is ever logged. */
function hostedTarget(program) {
  const p = Object.hasOwn(PROGRAMS, program) ? PROGRAMS[program] : null;
  if (!p) return { problem: "Choose StitchShop or StitchBench." };
  const raw = (process.env[p.env] ?? "").trim();
  const token = (process.env.PLATFORM_API_TOKEN ?? "").trim();
  if (!raw || token.length < 32) return { problem: `This hub doesn't start hosted ${program} shops.` };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { problem: `${p.env} isn't a web address. Ask the hub admin.` };
  }
  // The token goes in a header: never over plain http to another machine, never with anything but the site's address.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.has(u.hostname))) return { problem: `${p.env} must be an https address. Ask the hub admin.` };
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { problem: `${p.env} must be the site's address only. Ask the hub admin.` };
  return { origin: u.origin, token, kind: p.kind };
}

/** Which hosted programs this hub can start, for the account page. */
export function hostedOffer() {
  return Object.fromEntries(Object.keys(PROGRAMS).map((k) => [k, !hostedTarget(k).problem]));
}

/** For /account/api/me: each shop's opt-in and its newest reset request. */
export async function resetStateOf(shopIds) {
  if (!shopIds.length) return new Map();
  const { rows } = await q(
    `SELECT DISTINCT ON (shop_id) shop_id, created_at, expires_at, used_at, result FROM reset_grants WHERE shop_id = ANY($1) ORDER BY shop_id, created_at DESC`,
    [shopIds],
  );
  return new Map(rows.map((r) => [r.shop_id, { askedAt: r.created_at, expiresAt: r.expires_at, answeredAt: r.used_at, result: r.result }]));
}

/** A program stopped allowing resets (its claim said resetOptIn: false): requests still waiting go. */
export async function withdrawGrants(client, shopId) {
  await client.query(`UPDATE reset_grants SET used_at = now(), result = 'withdrawn' WHERE shop_id = $1 AND used_at IS NULL`, [shopId]);
}

export function registerProvisioning({ member, acct, fail, newId, allow, clientIp, requireAccount }) {
  const verifiedAccount = async (c) => {
    const a = await requireAccount(c);
    if (!a.verified_at) throw fail(403, "Confirm your email first: open the link we sent you.");
    return a;
  };

  // ----- a hosted shop from the hub -----

  acct.post("/hosted", async (c) => {
    const a = await verifiedAccount(c);
    const body = await c.req.json();
    const program = String(body.program ?? "");
    const target = hostedTarget(program);
    if (target.problem) throw fail(Object.hasOwn(PROGRAMS, program) ? 503 : 400, target.problem);
    const shopName = str(body.shopName, 120);
    const ownerName = str(body.ownerName, 120);
    if (!shopName || !ownerName) throw fail(400, "Give the shop's name and your name.");
    const timeZone = str(body.timeZone, 64);
    if (!allow(`hosted-start-ip:${clientIp(c)}`, 10)) throw fail(429, "Too many tries from this address. Wait an hour.");
    const startId = newId();
    await tx(async (client) => {
      // One at a time per account: the row lock makes a second click wait, then see the first.
      await client.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [a.id]);
      const recent = (await client.query(`SELECT created_at FROM hosted_starts WHERE account_id = $1 AND created_at > now() - make_interval(mins => $2) LIMIT 1`, [a.id, HOSTED_GAP_MINUTES])).rows[0];
      if (recent) throw fail(429, `One hosted shop every ${HOSTED_GAP_MINUTES} minutes. Wait a little, then try again.`);
      await client.query(`INSERT INTO hosted_starts (id, account_id, program, shop_name, kind) VALUES ($1, $2, $3, $4, $5)`, [startId, a.id, program, shopName, target.kind]);
    });
    const failed = async (status, why, words) => {
      await q(`UPDATE hosted_starts SET error = $2 WHERE id = $1`, [startId, why.slice(0, 300)]);
      return fail(status, words);
    };
    let r;
    let answer;
    try {
      r = await fetch(`${target.origin}/api/platform/companies`, {
        method: "POST",
        redirect: "manual", // the token goes to this address and nowhere it might send us
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ shopName, kind: target.kind, ownerName, ownerEmail: a.email, timeZone, hubAccountId: a.id }),
      });
      answer = await r.json().catch(() => ({}));
    } catch {
      throw await failed(502, "no answer", `The hosted ${program} didn't answer. Try again in a few minutes.`);
    }
    if (!r.ok) {
      const why = typeof answer?.error === "string" ? answer.error.slice(0, 300) : `status ${r.status}`;
      console.error(`hosted start: the hosted ${program} answered ${r.status} for account ${a.id}`);
      if (r.status === 400 || r.status === 409) throw await failed(r.status, why, `The hosted ${program} said: ${why}`);
      throw await failed(502, why, `The hosted ${program} couldn't make the shop (${why}). Ask the hub admin.`);
    }
    const shopRef = typeof answer?.shopId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(answer.shopId) ? answer.shopId : null;
    const link = typeof answer?.setPasswordUrl === "string" && answer.setPasswordUrl.startsWith(`${target.origin}/reset?t=`) ? answer.setPasswordUrl : null;
    if (!shopRef || !link) throw await failed(502, "an answer the hub doesn't understand", `The hosted ${program} answered in a way the hub doesn't understand. Ask the hub admin.`);
    // The company on the hub, tied to this account now, when the service is an install of this hub: its first claim
    // then finds it here, under the account, and its trial starts from this moment.
    const installId = typeof answer.hub?.installId === "string" ? answer.hub.installId : null;
    const inst = installId ? await one(`SELECT id FROM installs WHERE id = $1 AND NOT blocked`, [installId]) : null;
    let shop = null;
    if (inst) {
      shop = (
        await q(
          `INSERT INTO shops (id, install_id, shop_ref, name, kind, program, account_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (install_id, shop_ref) DO UPDATE SET account_id = coalesce(shops.account_id, EXCLUDED.account_id) RETURNING *`,
          [newId(), inst.id, shopRef, shopName, target.kind, program, a.id],
        )
      ).rows[0];
    }
    await q(`UPDATE hosted_starts SET shop_ref = $2, install_id = $3, shop_id = $4 WHERE id = $1`, [startId, shopRef, inst?.id ?? null, shop?.id ?? null]);
    console.log(`hosted start: account ${a.id} started ${program} company ${shopRef}${shop ? "" : " (the service isn't on this hub: not tied to the account)"}`);
    return c.json({
      ok: true,
      program,
      shopRef,
      shopName,
      appUrl: target.origin,
      setPasswordUrl: link,
      expiresAt: typeof answer.expiresAt === "string" ? answer.expiresAt : null,
      tied: Boolean(shop && shop.account_id === a.id),
    });
  });

  // ----- a password reset on the shop PC, asked for here -----

  acct.post("/shops/:id/reset-owner", async (c) => {
    const a = await verifiedAccount(c);
    const shop = await one(`SELECT * FROM shops WHERE id = $1 AND account_id = $2`, [c.req.param("id"), a.id]);
    if (!shop) throw fail(404, "That shop isn't on your account.");
    if (!shop.reset_opt_in) {
      throw fail(409, "That shop's program doesn't allow a reset from StitchHub. The owner switches it on at the shop PC, in Settings → Account; or use Reset a password on the program's tray icon.");
    }
    const s = hubSigner();
    if (!s.signer) throw fail(503, "This hub can't sign a reset yet. On the shop PC, use Reset a password on the program's tray icon.");
    if (!allow(`reset-grant:${shop.id}`, 3) || !allow(`reset-grant-acct:${a.id}`, 10)) throw fail(429, "Too many reset requests in the last hour. Use the one you asked for, or wait.");
    const id = newId();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + GRANT_MINUTES * 60_000);
    const grant = signGrant(s.signer, { id, shopRef: shop.shop_ref, installId: shop.install_id, email: a.email, nonce, iat: now.toISOString(), exp: expiresAt.toISOString() });
    await tx(async (client) => {
      // The newest request is the one that counts.
      await client.query(`UPDATE reset_grants SET used_at = now(), result = 'replaced' WHERE shop_id = $1 AND used_at IS NULL`, [shop.id]);
      await client.query(`INSERT INTO reset_grants (id, shop_id, account_id, email, nonce, grant_text, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        id,
        shop.id,
        a.id,
        a.email,
        nonce,
        grant,
        expiresAt,
      ]);
    });
    return c.json({ ok: true, id, shopName: shop.name, expiresAt });
  });

  // ----- the program's side (install key) -----

  const shopOf = async (c) => {
    const install = c.get("install");
    const ref = String(c.req.param("ref") ?? "");
    if (!allow(`reset-grants:${install.id}`, 600)) throw fail(429, "Too many reset checks in the last hour. Try again later.");
    const shop = await one(`SELECT id, reset_opt_in FROM shops WHERE install_id = $1 AND shop_ref = $2`, [install.id, ref]);
    if (!shop) {
      await refuseIfMoved(fail, install.id, ref);
      throw fail(404, "That shop hasn't told the hub about itself yet (it does at its next sync).");
    }
    return shop;
  };

  member.get("/shops/:ref/reset-grants", async (c) => {
    const shop = await shopOf(c);
    if (!shop.reset_opt_in) return c.json({ grants: [] });
    const { rows } = await q(
      `UPDATE reset_grants SET fetched_at = now() WHERE shop_id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, grant_text, expires_at`,
      [shop.id],
    );
    return c.json({ grants: rows.map((r) => ({ id: r.id, grant: r.grant_text, expiresAt: r.expires_at })) });
  });

  member.post("/shops/:ref/reset-grants/:id/done", async (c) => {
    const shop = await shopOf(c);
    const body = await c.req.json().catch(() => ({}));
    const result = body.result === "allowed" ? "allowed" : "refused";
    // What the program did is the truth, even for a request the hub had since replaced: it answered what it had.
    const r = await q(
      `UPDATE reset_grants SET used_at = coalesce(used_at, now()), result = CASE WHEN result IN ('allowed', 'refused') THEN result ELSE $3 END, why = coalesce(why, $4)
       WHERE id = $1 AND shop_id = $2`,
      [c.req.param("id"), shop.id, result, str(body.why, 40)],
    );
    if (!r.rowCount) throw fail(404, "No such reset request for that shop.");
    return c.json({ ok: true });
  });
}
