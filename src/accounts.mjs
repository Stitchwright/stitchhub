// Accounts on the hub: a shop owner's email and password, verified by email, with a password reset by email. An account
// owns one or more hub shops (a company on an install). The install key stays what the program uses on every request;
// the account is what a person uses on the hub's own pages (/account). Three ways in:
//   1. From the program: it posts /v1/accounts/start with its install key; the hub makes the account (unverified), ties
//      the shop to it and mails a link to set a password. An install that is on no hub yet does the same with no key
//      and gets an install key back (scope "pending" until the email is verified, then "member").
//   2. The program shows a link code (/v1/accounts/link-code); the owner signs in here and types it under "Connect a shop".
//   3. On the hub first: /account sign-up, verify by email, then connect a shop with a code.
// Standing is answered for every claimed shop (src/billing.mjs: since 11 Oct 2026 free, with every add-on, for good) with
// the keys the program should hold for it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { one, q, tx } from "./db.mjs";
import { sendMail, mailProblem } from "./mail.mjs";
import { assistantOffer, assistantPriceList, assistantStanding } from "./assistant-billing.mjs";
import { addonPriceList, addonProblem, addonsForSale, addonStandings, ADDON_IDS, extraStores, MAX_SINGLES, modulesOn, stillBilled, storesForSale } from "./addons.mjs";
import { registered as billingHooks, standingOf, claimAnswer, billingOpen, billingProblem, FOREVER, FOUNDING_LIMIT, foundingMissing, foundingUsed, PLANS_PARKED, priceList, refreshFounding, SOLO_LOGINS, trialChargeStart } from "./billing.mjs";
import { signer as hubSigner } from "./license.mjs";
import { stripeMode } from "./stripe.mjs";
import { refuseIfMoved } from "./moves.mjs";
import { hostedOffer, resetStateOf, withdrawGrants } from "./provisioning.mjs";
import { checkShown, currentVersion, isDraft, recordAcceptance, termsFor } from "./terms.mjs";
import { LOOK_CSS, header, footer } from "./look.mjs";

const SESSION_DAYS = 30;
const SET_PASSWORD_HOURS = 24; // a link to set the first password, or to verify an address
const RESET_HOURS = 1; // a forgotten password
const LINK_MINUTES = 15; // a code the program shows
const COOKIE = "hub_session";
const KINDS = new Set(["repair", "retail", "both"]);
const PROGRAMS = new Set(["StitchBench", "StitchShop"]);
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L: the code is read off one screen and typed on another
// Wrong sign-ins in an hour: per sender's address (20) and per account (10) do the limiting; everywhere together is only a
// backstop against a flood, high enough that nobody can lock every sign-in by guessing on purpose.
const WRONG_PASSWORDS = 20_000;
const WRONG_PER_ACCOUNT = 10;
// Past WRONG_PER_ACCOUNT the right password still signs in (strangers can't lock the owner out); past this, nothing does.
const WRONG_PER_ACCOUNT_HARD = 100;
// The passwords everyone tries first. Refused however long they are.
const COMMON = new Set(["123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein", "shadow", "master", "696969", "mustang", "password1", "qwerty123", "iloveyou", "sunshine", "princess", "welcome", "stitchbench", "stitchhub", "stitchshop"]);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// The hub's own address, for the links in its mail. Never taken from the request (a forged Host header would send a
// shop owner a reset link to someone else's site): HUB_URL, or Railway's public domain.
const HUB_URL = (process.env.HUB_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).trim().replace(/\/+$/, "");
const DEV_LOG = process.env.MAIL_DEV_LOG === "true" && !process.env.SMTP_URL;

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normCode = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Why accounts can't run on this hub yet (mail or its own address missing), or null. */
export function accountsProblem() {
  const mail = mailProblem();
  if (mail) return mail;
  if (!HUB_URL && !DEV_LOG) return "This hub doesn't know its own address yet: set HUB_URL (https://hub.example.com).";
  try {
    if (HUB_URL && !/^https?:$/.test(new URL(HUB_URL).protocol)) throw new Error();
  } catch {
    return "HUB_URL isn't a web address (https://hub.example.com).";
  }
  return null;
}

// ----- passwords -----

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function checkPassword(password, hash) {
  const [kind, N, r, p, salt, key] = String(hash ?? "").split("$");
  if (kind !== "scrypt" || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await new Promise((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (e, k) => (e ? reject(e) : resolve(k))),
  );
  return crypto.timingSafeEqual(got, want);
}

export function registerAccounts({ app, member, admin, fail, newId, allow, bucket, clientIp, hubName, createInstall, installByKey, claimListings, root }) {
  const emailOf = (v) => {
    const e = String(v ?? "").trim().toLowerCase();
    if (!e || e.length > 200 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) throw fail(400, "Enter an email address.");
    return e;
  };
  const passwordOf = (v, email) => {
    const p = typeof v === "string" ? v : "";
    if (p.length < 8) throw fail(400, "Use a password of 8 characters or more.");
    if (p.length > 200) throw fail(400, "That password is too long (200 characters at most).");
    if (COMMON.has(p.toLowerCase()) || p.toLowerCase() === email) throw fail(400, "That password is too easy to guess. Pick another.");
    return p;
  };
  const ready = () => {
    const problem = accountsProblem();
    if (problem) throw fail(503, problem);
  };
  const link = (page, token) => `${HUB_URL || `http://localhost:${process.env.PORT ?? 8080}`}/account/${page}?t=${token}`;

  // ----- mail -----

  async function mail(to, subject, text) {
    try {
      await sendMail({ to, subject, text, fromName: hubName });
    } catch (e) {
      console.error(e.message);
      throw fail(502, "The hub couldn't send the email just now. Try again in a little while.");
    }
  }
  const signOff = `\n\n${hubName}\n${HUB_URL}`;
  const setPasswordMail = (email, shop) =>
    mail(
      email,
      `Set your ${hubName} password`,
      `Hello,\n\n${shop.name}${shop.program ? ` (${shop.program})` : ""} asked for a ${hubName} account for ${email}. Set your password here; the link works once, for ${SET_PASSWORD_HOURS} hours:\n\n${link("set-password", shop.token)}\n\nIf you didn't ask for this, ignore this email and nothing happens.${signOff}`,
    );
  const verifyMail = (email, token) =>
    mail(
      email,
      `Confirm your email for ${hubName}`,
      `Hello,\n\nConfirm that ${email} is yours to finish your ${hubName} account; the link works once, for ${SET_PASSWORD_HOURS} hours:\n\n${link("verify", token)}\n\nIf you didn't sign up, ignore this email and nothing happens.${signOff}`,
    );
  const resetMail = (email, token) =>
    mail(
      email,
      `Reset your ${hubName} password`,
      `Hello,\n\nSomeone asked to reset the password of the ${hubName} account for ${email}. If that was you, set a new one here; the link works once, for ${RESET_HOURS} hour:\n\n${link("set-password", token)}\n\nIf it wasn't you, ignore this email: your password hasn't changed.${signOff}`,
    );

  // ----- tokens (links and codes; only the hash is kept) -----

  async function issueToken(client, kind, { accountId = null, shopId = null }, ttlMs, token = crypto.randomBytes(32).toString("base64url")) {
    // Every older one of the same kind for this account or shop is cancelled: one live link at a time.
    await client.query(`UPDATE account_tokens SET used_at = now() WHERE kind = $1 AND used_at IS NULL AND (($2::text IS NOT NULL AND account_id = $2) OR ($3::text IS NOT NULL AND shop_id = $3))`, [kind, accountId, shopId]);
    await client.query(`INSERT INTO account_tokens (token_hash, kind, account_id, shop_id, expires_at) VALUES ($1, $2, $3, $4, $5)`, [sha(token), kind, accountId, shopId, new Date(Date.now() + ttlMs)]);
    return token;
  }

  /** The row for a link or code someone followed, marked used; told apart from one that is wrong, used or expired. */
  async function takeToken(client, kind, raw, what = "link") {
    const t = (await client.query(`SELECT * FROM account_tokens WHERE token_hash = $1 AND kind = $2 FOR UPDATE`, [sha(String(raw ?? "")), kind])).rows[0];
    if (!t) throw fail(404, what === "code" ? "That code isn't right. Check it on the shop's Settings → Account page." : "That link isn't right. Ask for a new one.");
    if (t.used_at) throw fail(410, `That ${what} was already used. Ask for a new one.`);
    if (t.expires_at < new Date()) throw fail(410, `That ${what} has expired. Ask for a new one.`);
    await client.query(`UPDATE account_tokens SET used_at = now() WHERE token_hash = $1`, [t.token_hash]);
    return t;
  }

  // ----- sessions (an opaque id in an HttpOnly cookie; its hash in the table) -----

  function startSession(c, accountId) {
    const id = crypto.randomBytes(32).toString("base64url");
    setCookie(c, COOKIE, id, { httpOnly: true, secure: HUB_URL.startsWith("https://"), sameSite: "Lax", path: "/account", maxAge: SESSION_DAYS * 86400 });
    return q(`INSERT INTO sessions (id_hash, account_id, expires_at) VALUES ($1, $2, $3)`, [sha(id), accountId, new Date(Date.now() + SESSION_DAYS * 86400_000)]);
  }

  /** The signed-in account for this request, or null. */
  async function currentAccount(c) {
    const id = getCookie(c, COOKIE);
    if (!id) return null;
    const row = await one(
      `SELECT a.*, s.id_hash, s.last_seen_at AS seen FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = $1 AND s.expires_at > now() AND NOT a.disabled`,
      [sha(id)],
    );
    if (!row) return null;
    if (Date.now() - row.seen.getTime() > 300_000) q(`UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1`, [row.id_hash]).catch(() => {});
    return row;
  }

  async function requireAccount(c) {
    const a = await currentAccount(c);
    if (!a) throw fail(401, "Sign in first.");
    return a;
  }

  // The email is verified: an install that joined through this account (door 1 with no key) is a member now.
  async function verified(client, accountId) {
    await client.query(`UPDATE accounts SET verified_at = coalesce(verified_at, now()) WHERE id = $1`, [accountId]);
    await client.query(`UPDATE installs SET scope = 'member' WHERE scope = 'pending' AND id IN (SELECT install_id FROM shops WHERE account_id = $1)`, [accountId]);
  }

  // ----- shops and standing -----

  const shopOut = (s) => ({
    id: s.id,
    shopRef: s.shop_ref,
    name: s.name,
    kind: s.kind,
    program: s.program,
    version: s.version,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    ...(s.install_name !== undefined ? { installName: s.install_name } : {}),
  });

  /** A shop row with its standing today (billing.mjs): standing, lastDay, message, subscription, waivedBy. */
  async function withStanding(s) {
    const st = await standingOf(s);
    return {
      ...shopOut(s),
      standing: st.standing,
      lastDay: st.lastDay,
      message: st.message,
      plan: st.plan,
      source: st.source,
      // The real-partnership rule (billing.mjs waiverRule): the partner, its standing, repairs lately and the grace.
      waivedBy: st.waivedBy
        ? { name: st.waivedBy.shopName, partnerStanding: st.waivedBy.partner?.standing ?? null, repairs: st.waivedBy.repairs ?? 0, lastRepair: st.waivedBy.lastRepair ?? null, graceEnd: st.waivedBy.grace?.end ?? null, graceReason: st.waivedBy.grace?.reason ?? null }
        : null,
      subscription: st.subscription,
      lapsedAt: s.lapsed_at ?? null,
      // The stores the program reported, and the extra ones billed on the base subscription (each after the first).
      stores: { reported: s.stores ?? 1, extra: extraStores(s.stores), billed: (await one(`SELECT store_quantity FROM subscriptions WHERE shop_id = $1`, [s.id]))?.store_quantity ?? null },
      // A subscription started now is first charged on this day, when the trial ends (null: at once).
      firstChargeOn: trialChargeStart(s, st.subscription ? { unpaid_since: st.subscription.unpaidSince, disputed_at: st.subscription.disputedAt } : null)?.day ?? null,
    };
  }

  /**
   * What the program learns about a shop at a claim: its row, its account (if any), its standing and the key it should
   * hold (signed now when the standing calls for a new one), and the ids of keys to drop.
   */
  async function standingAnswer(shop, account) {
    const a = account === undefined && shop.account_id ? await one(`SELECT email, verified_at, terms_version FROM accounts WHERE id = $1`, [shop.account_id]) : account;
    // terms: the version in force (for the program's tick) and what the shop's account accepted (Settings → Account).
    const now = currentVersion();
    const terms = { version: now, draft: isDraft(now), accepted: a?.terms_version ?? null };
    return { shop: shopOut(shop), account: a ? { email: a.email, verified: Boolean(a.verified_at) } : null, terms, ...(await claimAnswer(shop)) };
  }

  /** The shop row for (install, shopRef): made on first sight, its name, kind, program and version kept current. */
  async function upsertShop(client, install, body) {
    const shopRef = str(body.shopRef, 64);
    if (!shopRef) throw fail(400, "Send shopRef.");
    // A company that moved to another install isn't made again on the one it left: that copy hears where it went
    // (410 { moved, to, at }; src/moves.mjs).
    if (!(await client.query(`SELECT 1 FROM shops WHERE install_id = $1 AND shop_ref = $2`, [install.id, shopRef])).rowCount) await refuseIfMoved(fail, install.id, shopRef);
    const kind = KINDS.has(body.kind) ? body.kind : null;
    const program = PROGRAMS.has(body.program) ? body.program : null;
    // Whether the program allows a password reset from the account (the Windows program's opt-in; src/provisioning.mjs).
    // An older program says nothing, and what was stored stays.
    const resetOptIn = typeof body.resetOptIn === "boolean" ? body.resetOptIn : null;
    // The stores the company has (a program with more than one store says so; an older one says nothing and what was
    // stored stays). Each store after the first is billed on the base subscription (billing.mjs syncStores).
    const stores = Number.isInteger(body.stores) && body.stores >= 1 && body.stores <= 100 ? body.stores : null;
    const r = await client.query(
      `INSERT INTO shops (id, install_id, shop_ref, name, kind, program, version, reset_opt_in, stores) VALUES ($1, $2, $3, coalesce($4, $8), coalesce($5, 'repair'), $6, $7, coalesce($9, false), coalesce($10, 1))
       ON CONFLICT (install_id, shop_ref) DO UPDATE SET name = coalesce($4, shops.name), kind = coalesce($5, shops.kind), program = coalesce($6, shops.program),
         version = coalesce($7, shops.version), reset_opt_in = coalesce($9, shops.reset_opt_in), stores = coalesce($10, shops.stores), last_seen_at = now()
       RETURNING *`,
      [newId(), install.id, shopRef, str(body.shopName, 120), kind, program, str(body.version, 40), install.name, resetOptIn, stores],
    );
    if (resetOptIn === false) await withdrawGrants(client, r.rows[0].id);
    return r.rows[0];
  }

  /** Ties a shop to an account; 409 when it belongs to another. */
  async function tieShop(client, shopId, accountId) {
    const r = await client.query(`UPDATE shops SET account_id = $2 WHERE id = $1 AND (account_id IS NULL OR account_id = $2) RETURNING *`, [shopId, accountId]);
    if (!r.rowCount) throw fail(409, "That shop is already connected to another StitchHub account.");
    return r.rows[0];
  }

  // ---------- install routes (Authorization: Bearer <install key>) ----------

  const shopsLimit = (c) => {
    if (!allow(`shops:${c.get("install").id}`, 3000)) throw fail(429, "Too many shop requests in the last hour. Try again later.");
  };

  // Every company on an install says who it is at every sync: its name, kind, program and version. On an install with
  // one company (`sole: true`, or an older program, which sent only shopRef and only for its one company), what the
  // install listed, ordered and shared before it named its company becomes that company's (market.mjs); on an install
  // with several, nothing is handed to whichever company claims first. The answer carries the standing, so the program
  // needs no second request.
  member.post("/shops/claim", async (c) => {
    shopsLimit(c);
    const body = await c.req.json().catch(() => ({}));
    const install = c.get("install");
    const sole = body.sole === true || body.program === undefined;
    const { shop, listings } = await tx(async (client) => {
      const shop = await upsertShop(client, install, body);
      return { shop, listings: sole ? await claimListings(client, install.id, shop.shop_ref) : 0 };
    });
    // The extra stores billed follow the stores reported (only when they differ from what is billed). After the answer, in
    // the background: up to three Stripe calls must not hold up a claim (the program gives up on it after 30 seconds and
    // the install's other companies wait), and a failure there never fails the claim (it is tried at the next one).
    setImmediate(() => billingHooks.syncStores(shop).catch((e) => console.error(`billing: the extra stores of shop ${shop.id}: ${e.message}`)));
    return c.json({ ok: true, listings, ...(await standingAnswer(shop)) });
  });

  member.get("/shops/:ref/standing", async (c) => {
    shopsLimit(c);
    const shop = await one(`SELECT * FROM shops WHERE install_id = $1 AND shop_ref = $2`, [c.get("install").id, c.req.param("ref")]);
    if (!shop) {
      await refuseIfMoved(fail, c.get("install").id, c.req.param("ref"));
      throw fail(404, "That shop hasn't told the hub about itself yet (it does at its next sync).");
    }
    return c.json(await standingAnswer(shop));
  });

  // Door 2: a code the program shows for one of its shops; the owner types it in under "Connect a shop" within 15 minutes.
  member.post("/accounts/link-code", async (c) => {
    ready();
    const body = await c.req.json().catch(() => ({}));
    const install = c.get("install");
    const shopRef = str(body.shopRef, 64);
    if (!shopRef) throw fail(400, "Send shopRef.");
    if (!allow(`link-code:${install.id}:${shopRef}`, 10)) throw fail(429, "Too many link codes in the last hour. Use the one you have, or wait.");
    const code = [...crypto.randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000);
    await tx(async (client) => {
      const shop = await upsertShop(client, install, body);
      if (shop.account_id) throw fail(409, "This shop is already connected to a StitchHub account.");
      await issueToken(client, "link", { shopId: shop.id }, LINK_MINUTES * 60_000, code);
    });
    return c.json({ code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt });
  });

  // Door 1: the program starts the account for its shop and the owner sets a password from the email. With the install
  // key, for an install already on the hub; without one, for an install on no hub yet: it becomes an install here with
  // scope "pending" (its own key is answered once) and a member when the email is verified. Sent again for the same
  // unfinished account, it mails the link again ("Send it again" in the program).
  app.post("/v1/accounts/start", async (c) => {
    ready();
    if (!allow(`acct-start:${clientIp(c)}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json().catch(() => ({}));
    const email = emailOf(body.email);
    const h = c.req.header("authorization") ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7) : "";
    let install = key ? await installByKey(key) : null;
    if (install && !allow(`acct-start:${install.id}`, 10)) throw fail(429, "Too many tries. Wait an hour.");
    const shopName = str(body.shopName, 120);
    if (!install && !shopName) throw fail(400, "Give your shop's name.");
    const existing = await one(`SELECT id, verified_at, password_hash FROM accounts WHERE lower(email) = $1`, [email]);
    if (existing && (existing.verified_at || existing.password_hash)) {
      throw fail(409, "That address already has a StitchHub account. Choose \"I already have an account\" and connect this shop with a link code.");
    }
    const out = await tx(async (client) => {
      let made = null;
      if (!install) {
        made = await createInstall(client, shopName, str(body.contact, 200), "pending");
        install = { id: made.id, name: shopName };
      }
      const shop = await upsertShop(client, install, body);
      let accountId = existing?.id;
      if (!accountId) {
        accountId = newId();
        await client.query(`INSERT INTO accounts (id, email) VALUES ($1, $2)`, [accountId, email]);
        // The version the owner ticked in the program, as the program named it (an older program names its own
        // constant; /account then asks for the version in force).
        await recordAcceptance(client, { accountId, version: str(body.termsVersion, 40), via: "program" });
      }
      await tieShop(client, shop.id, accountId);
      const token = await issueToken(client, "reset", { accountId }, SET_PASSWORD_HOURS * 3600_000);
      return { shop, token, made };
    });
    await setPasswordMail(email, { ...out.shop, token: out.token });
    return c.json({
      ok: true,
      account: { email, verified: false },
      shop: shopOut(out.shop),
      ...(out.made ? { installId: out.made.id, installKey: out.made.key, hubName, scope: "pending" } : {}),
    });
  });

  // ---------- the hub's own pages and their API (session cookie) ----------

  const PAGES = ["/account", "/account/verify", "/account/forgot", "/account/set-password", "/account/shops", "/account/settings", "/account/manuals", "/account/repository"];
  // The page is read at each request (easy to change in place); the hub's look, header and footer go in its placeholders.
  for (const p of PAGES)
    app.get(p, (c) =>
      c.html(
        fs
          .readFileSync(path.join(root, "public", "account.html"), "utf8")
          .replace("/*HUB_LOOK*/", () => LOOK_CSS)
          .replace("<!--HUB_HEADER-->", () => header(hubName, { active: p === "/account/manuals" ? "/account/manuals" : "/account" }))
          .replace("<!--HUB_FOOTER-->", () => footer(hubName)),
      ),
    );

  const acct = new Hono();
  acct.use("*", async (c, next) => {
    ready();
    // A change asked for by a page on another site (the browser says where from) is refused: the cookie alone isn't enough.
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin && HUB_URL && origin !== new URL(HUB_URL).origin) throw fail(403, "That request came from another site.");
    await next();
  });

  acct.get("/me", async (c) => {
    const a = await requireAccount(c);
    const shops = (await q(`SELECT s.*, i.name AS install_name FROM shops s JOIN installs i ON i.id = s.install_id WHERE s.account_id = $1 ORDER BY s.created_at`, [a.id])).rows;
    const open = billingOpen();
    // Plans, the trade add-ons and extra stores aren't offered while they are parked (billing.mjs PLANS_PARKED): every
    // shop has them free. The Assistant and Manage billing go on as before.
    const sell = open && !PLANS_PARKED;
    const founding = await refreshFounding(null, a.id);
    const resets = await resetStateOf(shops.map((s) => s.id));
    const optIn = new Map(shops.map((s) => [s.id, s.reset_opt_in === true]));
    // The Assistant is its own subscription per shop (src/assistant-billing.mjs): its standing and what the page may offer.
    const offer = assistantOffer();
    const assist = new Map(await Promise.all(shops.map(async (s) => [s.id, await assistantStanding(s.id)])));
    // The trade add-ons, each its own subscription (src/addons.mjs), and the bundle.
    const forSale = addonsForSale();
    const addonSt = new Map(await Promise.all(shops.map(async (s) => [s.id, await addonStandings(s.id)])));
    const rawShop = new Map(shops.map((r) => [r.id, r]));
    const addonsOut = (shown) => {
      const s = rawShop.get(shown.id);
      const st = addonSt.get(s.id);
      const bundleBilled = stillBilled(st.bundle.row, st.bundle);
      const singles = ADDON_IDS.filter((p) => stillBilled(st[p].row, st[p])).length;
      return {
        on: modulesOn(st, s),
        comped: Boolean(s.comp_addons && s.comp_until && s.comp_until.getTime() > Date.now()),
        items: Object.fromEntries(
          Object.entries(st).map(([p, x]) => [
            p,
            {
              status: x.status,
              paidThrough: x.paidThrough,
              plan: x.plan,
              canAdd: sell && forSale.includes(p) && !stillBilled(x.row, x) && (p === "bundle" || (!bundleBilled && singles < MAX_SINGLES)),
            },
          ]),
        ),
      };
    };
    return c.json({
      account: { id: a.id, email: a.email, verified: Boolean(a.verified_at), termsVersion: a.terms_version, createdAt: a.created_at, lastSignInAt: a.last_sign_in_at, hasBilling: Boolean(a.stripe_customer_id) },
      shops: (await Promise.all(shops.map(withStanding))).map((s) => ({
        ...s,
        canSubscribe: sell && !(s.source === "subscription" && s.standing !== "lapsed"),
        firstChargeOn: sell && !(s.source === "subscription" && s.standing !== "lapsed") ? s.firstChargeOn : null,
        // Switch to Shop / Solo: a running subscription (paid, or retrying a payment), not one that has ended.
        canSwitch: sell && s.source === "subscription" && s.standing !== "lapsed" && ["active", "trialing", "past_due"].includes(s.subscription?.status),
        canManage: open && Boolean(a.stripe_customer_id),
        assistant: {
          status: assist.get(s.id).status,
          paidThrough: assist.get(s.id).paidThrough,
          plan: assist.get(s.id).sub?.plan ?? null,
          canAdd: open && offer.subscribe && ["none", "ended"].includes(assist.get(s.id).status),
          canTopUp: open && offer.topup && ["active", "ending", "past_due"].includes(assist.get(s.id).status),
        },
        addons: addonsOut(s),
        // The program on that shop's PC allows a reset of its owner's password from here (src/provisioning.mjs).
        resetOptIn: optIn.get(s.id) ?? false,
        resetRequest: resets.get(s.id) ?? null,
      })),
      hubName,
      // What each plan costs for this account (the founding prices for a founding shop), Solo's login limit, and the
      // founding mark: while a gap runs, the day it would go.
      billing: { open, prices: sell ? await priceList(founding.founding) : null, assistantPrices: open && (offer.subscribe || offer.topup) ? await assistantPriceList() : null, addonPrices: sell && (forSale.length || storesForSale()) ? await addonPriceList() : null, soloLogins: SOLO_LOGINS, founding: { on: founding.founding, gapSince: founding.gapSince, losesOn: founding.losesOn } },
      // "Start a hosted StitchShop / StitchBench" (src/provisioning.mjs): which this hub offers, and whether it can sign resets.
      hosted: hostedOffer(),
      canSignResets: Boolean(hubSigner().signer),
      // The version in force and what this account accepted; needsAccept: "We updated our terms" (and Subscribe asks
      // for the tick).
      terms: termsFor(a),
    });
  });

  // "We updated our terms": the signed-in owner ticks the box for the version in force (the one the page showed).
  acct.post("/terms", async (c) => {
    const a = await requireAccount(c);
    if (!allow(`acct-terms:${a.id}`, 30)) throw fail(429, "Too many tries. Wait an hour.");
    const body = await c.req.json();
    if (body.acceptTerms !== true) throw fail(400, "Tick the box to accept the terms.");
    const terms = currentVersion();
    if (!terms) throw fail(404, "No terms are published on this hub yet.");
    checkShown(body, fail);
    await tx((client) => recordAcceptance(client, { accountId: a.id, version: terms, via: "account" }));
    return c.json({ ok: true, terms: termsFor({ terms_version: terms, terms_at: new Date() }) });
  });

  // Door 3: an account made here first. The password is set now; the account works once the emailed link is opened.
  acct.post("/signup", async (c) => {
    if (!allow(`acct-signup:${clientIp(c)}`, 10)) throw fail(429, "Too many sign-ups from this address. Wait an hour.");
    const body = await c.req.json();
    const email = emailOf(body.email);
    const password = passwordOf(body.password, email);
    if (body.acceptTerms !== true) throw fail(400, "Tick the box to accept the terms.");
    const terms = currentVersion();
    checkShown(body, fail);
    const hash = await hashPassword(password);
    const existing = await one(`SELECT * FROM accounts WHERE lower(email) = $1`, [email]);
    // An address that has an account already (one the program started, with no password yet, included): the password
    // sent here is never put on it, or a stranger's would work once the owner opened the link we mail. The owner is sent
    // a link to set the password instead, and the answer is the same as for a new account. An account not verified yet
    // may carry a stranger's password (its sign-up came first): that password and its confirm links go, so the owner's
    // click on a confirm mail can't make it work; only the set-password link does.
    if (existing) {
      if (existing.disabled) return c.json({ ok: true });
      let a = existing;
      if (!existing.verified_at) {
        await tx(async (client) => {
          await client.query(`UPDATE accounts SET password_hash = NULL WHERE id = $1 AND verified_at IS NULL`, [existing.id]);
          await client.query(`UPDATE account_tokens SET used_at = now() WHERE kind = 'verify' AND account_id = $1 AND used_at IS NULL`, [existing.id]);
        });
        a = { ...existing, password_hash: null };
      }
      if (allow(`acct-reset:${existing.id}`, 5)) await passwordLinkTo(a);
      return c.json({ ok: true });
    }
    const token = await tx(async (client) => {
      const id = newId();
      await client.query(`INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, $3)`, [id, email, hash]);
      await recordAcceptance(client, { accountId: id, version: terms, via: "signup" });
      return issueToken(client, "verify", { accountId: id }, SET_PASSWORD_HOURS * 3600_000);
    });
    await verifyMail(email, token);
    return c.json({ ok: true });
  });

  acct.post("/verify", async (c) => {
    const { token } = await c.req.json();
    const accountId = await tx(async (client) => {
      const t = await takeToken(client, "verify", token);
      await verified(client, t.account_id);
      return t.account_id;
    });
    await q(`UPDATE accounts SET last_sign_in_at = now() WHERE id = $1`, [accountId]);
    await startSession(c, accountId);
    return c.json({ ok: true });
  });

  // The link from the program's account start, or from "Forgot your password": sets the password, verifies the address
  // and signs out every other browser.
  acct.post("/set-password", async (c) => {
    const { token, password } = await c.req.json();
    const accountId = await tx(async (client) => {
      const t = await takeToken(client, "reset", token);
      const a = (await client.query(`SELECT email FROM accounts WHERE id = $1`, [t.account_id])).rows[0];
      const hash = await hashPassword(passwordOf(password, a.email));
      await client.query(`UPDATE accounts SET password_hash = $2, last_sign_in_at = now() WHERE id = $1`, [t.account_id, hash]);
      await client.query(`DELETE FROM sessions WHERE account_id = $1`, [t.account_id]);
      await verified(client, t.account_id);
      return t.account_id;
    });
    await startSession(c, accountId);
    return c.json({ ok: true });
  });

  acct.post("/signin", async (c) => {
    const ip = clientIp(c);
    const wrong = bucket("acct-wrong");
    if (wrong.n >= WRONG_PASSWORDS) throw fail(429, "Too many wrong passwords were tried on this hub lately. Try again in an hour.");
    const byIp = bucket(`acct-fail:${ip}`);
    if (byIp.n >= 20) throw fail(429, "Too many wrong sign-ins from this address. Wait an hour.");
    const body = await c.req.json();
    const email = emailOf(body.email);
    // Counted per address typed (an account or not, so the answer doesn't say which), apart from the sender's address.
    const byEmail = bucket(`acct-fail-email:${email}`);
    const tooMany = () => fail(429, "Too many wrong passwords for this account lately. Wait an hour, or use \"Forgot your password\".");
    if (byEmail.n >= WRONG_PER_ACCOUNT_HARD) throw tooMany();
    // Every try is counted before the awaited lookup and check (so guesses sent at once are all counted) and given back
    // when the password is right.
    const over = byEmail.n >= WRONG_PER_ACCOUNT;
    byIp.n++;
    byEmail.n++;
    if (++wrong.n === WRONG_PASSWORDS) console.warn(`accounts: ${WRONG_PASSWORDS} wrong passwords this hour; sign-in is paused until the hour is up`);
    const a = await one(`SELECT * FROM accounts WHERE lower(email) = $1`, [email]);
    if (!a?.password_hash || !(await checkPassword(String(body.password ?? ""), a.password_hash))) {
      throw over ? tooMany() : fail(401, "That email or password isn't right.");
    }
    for (const b of [byIp, byEmail, wrong]) b.n = Math.max(0, b.n - 1);
    if (a.disabled) throw fail(403, "This account is switched off. Ask the hub admin.");
    if (!a.verified_at) throw fail(403, "Confirm your email first: open the link we sent you, or ask for it again below.");
    await q(`UPDATE accounts SET last_sign_in_at = now() WHERE id = $1`, [a.id]);
    await startSession(c, a.id);
    return c.json({ ok: true });
  });

  acct.post("/signout", async (c) => {
    const id = getCookie(c, COOKIE);
    if (id) await q(`DELETE FROM sessions WHERE id_hash = $1`, [sha(id)]);
    deleteCookie(c, COOKIE, { path: "/account" });
    return c.json({ ok: true });
  });

  acct.post("/signout-all", async (c) => {
    const a = await requireAccount(c);
    await q(`DELETE FROM sessions WHERE account_id = $1`, [a.id]);
    deleteCookie(c, COOKIE, { path: "/account" });
    return c.json({ ok: true });
  });

  // Always the same answer, so nobody can tell from it which addresses have an account.
  const quiet = { ok: true, message: "If that address has an account, the email is on its way." };

  acct.post("/forgot", async (c) => {
    if (!allow(`acct-forgot:${clientIp(c)}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const email = emailOf((await c.req.json()).email);
    const a = await one(`SELECT id, disabled FROM accounts WHERE lower(email) = $1`, [email]);
    if (!a || a.disabled || !allow(`acct-reset:${a.id}`, 5)) return c.json(quiet);
    const token = await tx((client) => issueToken(client, "reset", { accountId: a.id }, RESET_HOURS * 3600_000));
    await resetMail(email, token);
    return c.json(quiet);
  });

  // The verification (or first set-password) email again, for an account that hasn't finished.
  acct.post("/resend", async (c) => {
    if (!allow(`acct-forgot:${clientIp(c)}`, 20)) throw fail(429, "Too many tries. Wait an hour.");
    const email = emailOf((await c.req.json()).email);
    const a = await one(`SELECT * FROM accounts WHERE lower(email) = $1`, [email]);
    if (!a || a.verified_at || a.disabled || !allow(`acct-reset:${a.id}`, 5)) return c.json(quiet);
    await resendTo(a);
    return c.json(quiet);
  });

  async function resendTo(a) {
    if (a.password_hash) {
      const token = await tx((client) => issueToken(client, "verify", { accountId: a.id }, SET_PASSWORD_HOURS * 3600_000));
      await verifyMail(a.email, token);
    } else {
      const shop = (await one(`SELECT * FROM shops WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [a.id])) ?? { name: "Your shop", program: null };
      const token = await tx((client) => issueToken(client, "reset", { accountId: a.id }, SET_PASSWORD_HOURS * 3600_000));
      await setPasswordMail(a.email, { ...shop, token });
    }
  }

  /** A link to set the password: the program's first set-password email for an account with none, else a reset. */
  async function passwordLinkTo(a) {
    if (!a.password_hash) return resendTo(a);
    const token = await tx((client) => issueToken(client, "reset", { accountId: a.id }, RESET_HOURS * 3600_000));
    await resetMail(a.email, token);
  }

  acct.post("/password", async (c) => {
    const a = await requireAccount(c);
    const body = await c.req.json();
    if (!(await checkPassword(String(body.current ?? ""), a.password_hash))) throw fail(401, "Your current password isn't right.");
    const hash = await hashPassword(passwordOf(body.password, a.email));
    await tx(async (client) => {
      await client.query(`UPDATE accounts SET password_hash = $2 WHERE id = $1`, [a.id, hash]);
      // Every other browser is signed out; this one stays.
      await client.query(`DELETE FROM sessions WHERE account_id = $1 AND id_hash <> $2`, [a.id, a.id_hash]);
    });
    return c.json({ ok: true });
  });

  // Door 2, the hub's side: the signed-in owner types the code the program showed.
  acct.post("/connect", async (c) => {
    const a = await requireAccount(c);
    if (!allow(`acct-connect:${a.id}`, 20)) throw fail(429, "Too many codes tried in the last hour. Wait an hour.");
    const code = normCode((await c.req.json()).code);
    if (code.length !== 10) throw fail(400, "A link code is 10 letters and digits, shown in the program under Settings → Account.");
    const shop = await tx(async (client) => {
      const t = await takeToken(client, "link", code, "code");
      return tieShop(client, t.shop_id, a.id);
    });
    return c.json({ ok: true, shop: shopOut(shop) });
  });

  // ---------- hub admin ----------

  const shopRows = (where, params) =>
    q(`SELECT s.*, i.name AS install_name, a.email AS account_email, a.stripe_customer_id FROM shops s JOIN installs i ON i.id = s.install_id LEFT JOIN accounts a ON a.id = s.account_id ${where} ORDER BY s.created_at`, params).then((r) => r.rows);
  const adminShop = async (s) => {
    const st = await addonStandings(s.id);
    return {
      ...(await withStanding(s)),
      installId: s.install_id,
      installName: s.install_name,
      accountId: s.account_id,
      accountEmail: s.account_email ?? null,
      stripeCustomerId: s.stripe_customer_id ?? null,
      compUntil: s.comp_until,
      compNote: s.comp_note,
      compAddons: Boolean(s.comp_addons),
      // The add-ons it has now, and each add-on subscription the hub holds (product, standing, paid through).
      addons: { on: modulesOn(st, s), subs: Object.entries(st).filter(([, x]) => x.row).map(([p, x]) => ({ product: p, status: x.status, paidThrough: x.paidThrough, plan: x.plan, id: x.row.stripe_subscription_id })) },
    };
  };

  admin.get("/accounts", async (c) => {
    for (const r of (await q(`SELECT id FROM accounts WHERE founding_at IS NOT NULL`)).rows) await refreshFounding(null, r.id);
    const accounts = (await q(`SELECT * FROM accounts ORDER BY created_at`)).rows;
    const shops = await Promise.all((await shopRows("", [])).map(adminShop));
    const signing = hubSigner();
    return c.json({
      problem: accountsProblem(),
      billing: {
        open: billingOpen(),
        problem: billingProblem(),
        stripeMode: stripeMode(),
        signing: signing.signer ? { kid: signing.signer.kid, x: signing.signer.x } : null,
        signingProblem: signing.problem,
        foundingMissing: foundingMissing(),
        addonProblem: addonProblem(),
      },
      foundingPlaces: { used: await foundingUsed(), limit: FOUNDING_LIMIT },
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        verified: Boolean(a.verified_at),
        hasPassword: Boolean(a.password_hash),
        disabled: a.disabled,
        termsVersion: a.terms_version,
        stripeCustomerId: a.stripe_customer_id,
        founding: { on: Boolean(a.founding_at), at: a.founding_at ?? null, gapSince: a.founding_gap_since ?? null, lostAt: a.founding_lost_at ?? null },
        createdAt: a.created_at,
        lastSignInAt: a.last_sign_in_at,
        shops: shops.filter((s) => s.accountId === a.id),
      })),
      shops,
    });
  });

  // "Free until <date>" or for good, with a note; an empty `until` takes the comp away. A comp also takes back "Lapse now".
  // Since 11 Oct 2026 every shop is free with every add-on whatever its comp, so a comp changes no key and none is revoked
  // (the forever keys must never be); it still gives a company backup space and free plate reads of its own (db.mjs
  // paysOwnWay).
  admin.post("/shops/:id/comp", async (c) => {
    const body = await c.req.json();
    let until = null;
    if (body.until === "forever") until = FOREVER;
    else if (body.until) {
      until = /^\d{4}-\d{2}-\d{2}$/.test(String(body.until)) ? new Date(`${body.until}T23:59:59Z`) : new Date(NaN);
      if (Number.isNaN(until.getTime())) throw fail(400, "Give the last free day as YYYY-MM-DD, or \"forever\".");
    }
    // { addons: true }: the comp covers the five trade add-ons too ("everything"; the Assistant has its own comp). Left out,
    // what was chosen before stays.
    const addons = typeof body.addons === "boolean" ? body.addons : null;
    const r = await q(
      `UPDATE shops SET comp_until = $2, comp_note = $3, lapsed_at = CASE WHEN $2::timestamptz IS NULL THEN lapsed_at ELSE NULL END,
         comp_addons = CASE WHEN $2::timestamptz IS NULL THEN false ELSE coalesce($4, comp_addons) END WHERE id = $1 RETURNING comp_addons`,
      [c.req.param("id"), until, until ? str(body.note, 300) : null, addons],
    );
    if (!r.rowCount) throw fail(404, "No such shop.");
    return c.json({ ok: true, shop: await adminShop((await shopRows("WHERE s.id = $1", [c.req.param("id")]))[0]) });
  });

  admin.post("/accounts/:id/resend", async (c) => {
    ready();
    const a = await one(`SELECT * FROM accounts WHERE id = $1`, [c.req.param("id")]);
    if (!a) throw fail(404, "No such account.");
    if (a.verified_at) throw fail(409, "That account is already verified.");
    await resendTo(a);
    return c.json({ ok: true });
  });

  admin.post("/accounts/:id/disable", async (c) => {
    const { disabled } = await c.req.json();
    const r = await q(`UPDATE accounts SET disabled = $2 WHERE id = $1`, [c.req.param("id"), Boolean(disabled)]);
    if (!r.rowCount) throw fail(404, "No such account.");
    if (disabled) await q(`DELETE FROM sessions WHERE account_id = $1`, [c.req.param("id")]);
    return c.json({ ok: true });
  });

  // On the owner's request: the account goes, its shops stay on the hub with no account (their listings, notes and
  // partner links are the install's and stay as they are).
  admin.delete("/accounts/:id", async (c) => {
    const r = await q(`DELETE FROM accounts WHERE id = $1`, [c.req.param("id")]);
    if (!r.rowCount) throw fail(404, "No such account.");
    return c.json({ ok: true });
  });

  // Spent links and codes, and sessions that ran out, go after a while.
  const sweep = () =>
    Promise.all([q(`DELETE FROM account_tokens WHERE expires_at < now() - interval '7 days'`), q(`DELETE FROM sessions WHERE expires_at < now()`)]).catch((e) => console.error("accounts sweep:", e.message));
  setInterval(sweep, 6 * 3600_000).unref();

  // The cookie API router is mounted by server.mjs once billing has added its routes to it (Hono copies a router's
  // routes when it is mounted, so routes added later wouldn't be served).
  return { acct, requireAccount, ready, hubUrl: HUB_URL };
}
