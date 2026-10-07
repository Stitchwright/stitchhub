// Shop hop passports (StitchBench shop-features-round-2-design.md 4.6, the "shop-hop-program" Built note; migration
// 031). An organizing shop starts a hop (name, dates, the prize rule "all" or "any:N") and hands other shops a one-use
// invite code; each shop chooses to take part (the sharing rule) and its partner key (Ed25519) is pinned when it starts
// or joins (after a company move, at its first stamp from the new install). No shop joins after the last day. Shoppers sign up on the hub's public page /hop/<slug> (name, email or phone, and a tick to share them with
// each shop they visit, off by default) and get a passport, /p/<code>, with the code big, a QR code of it and a
// printable card. At the counter the program stamps the passport and sends the stamp here signed (SBHS1, below); the hub
// checks it against the pinned key. The organizer sees completed passports and records its draws.
//
// What a shopper typed is all the hub keeps of her, and a shop is sent her name and contact only when she ticked
// "share"; otherwise she is a passport code and a count. The organizer's list of completed passports names only those
// who shared; the rest are called by their code, which is on their passport.
//
// Shop routes are under the install key with the company in X-Shop-Ref, as the partner routes (and a partner-only
// install, a quilt shop that joined with a partner code, may use them).
import crypto from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { one, q, tx } from "./db.mjs";

const all = async (text, params) => (await q(text, params)).rows;
import { canonical, isPublicKey, sha256hex } from "./partnersign.mjs";
import { qrSvg } from "./qr.mjs";

const INVITE_DAYS = 14;
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // read out and typed at a counter: no 0/O, 1/I/L
const PASSPORT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I L O U (the program reads O as 0, I and L as 1)
const RULE = /^(all|any:(\d{1,3}))$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as YYYY-MM-DD (2026-02-30 isn't one). */
const isDay = (d) => typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
// Sign-ups that went through, per address and hour (a shop's guest Wi-Fi on hop day is one address), and per hop.
const SIGNUPS_PER_IP = 200;
const SIGNUPS_PER_HOP = 2000;

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const normCode = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const randomFrom = (alphabet, n) => [...crypto.randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
export const passportWords = (code) => `HOP-${code.slice(0, 4)}-${code.slice(4)}`;

/** The text a stamp's signature covers (the program's src/lib/hops/hop-math.ts stampString: the two must match). */
export const stampText = (f) => ["SBHS1", f.hopId, f.shopRef, f.stampId, f.passport, f.at, sha256hex(canonical(f))].join("\n");

/** True when `sig` ({ v: 1, pub, sig }) is the public key's Ed25519 signature over the stamp's fields. */
export function verifyStamp(sig, f) {
  try {
    if (!sig || sig.v !== 1 || typeof sig.pub !== "string" || typeof sig.sig !== "string" || sig.sig.length > 200) return false;
    const pub = crypto.createPublicKey({ key: Buffer.from(sig.pub, "base64"), format: "der", type: "spki" });
    const fields = { hopId: f.hopId, shopRef: f.shopRef, stampId: f.stampId, passport: f.passport, at: f.at };
    return crypto.verify(null, Buffer.from(stampText(fields)), pub, Buffer.from(sig.sig, "base64"));
  } catch {
    return false;
  }
}

/** "Stamps from all 10 shops" / "Stamps from any 6 shops". */
const ruleWords = (rule, shops) => {
  const m = /^any:(\d+)$/.exec(rule);
  return m ? `Collect stamps from any ${m[1]} of the shops` : `Collect stamps from all ${shops} shop${shops === 1 ? "" : "s"}`;
};
const needed = (rule, joined) => {
  const m = /^any:(\d+)$/.exec(rule);
  return m ? Number(m[1]) : joined;
};
const dayWords = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);

function slugOf(name) {
  const base = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "hop";
  return `${base}-${randomFrom("abcdefghjkmnpqrstuvwxyz23456789", 4)}`;
}

// ----- the public pages -----

const STYLE = `
:root{color-scheme:light}
body{margin:0;background:#fff;color:#111;font:20px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:32px;line-height:1.2;margin:8px 0 12px}
h2{font-size:24px;margin:28px 0 8px}
p,li{font-size:20px}
label{display:block;font-size:20px;font-weight:600;margin:18px 0 6px}
input[type=text],input[type=email],input[type=tel]{width:100%;box-sizing:border-box;font-size:22px;padding:12px;border:2px solid #555;border-radius:8px}
.tick{display:flex;gap:12px;align-items:flex-start;font-weight:400;margin-top:22px}
.tick input{width:28px;height:28px;flex:none;margin-top:2px}
button,.button{display:inline-block;font-size:22px;font-weight:700;padding:14px 22px;margin-top:22px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;text-decoration:none;cursor:pointer}
.note{color:#333;font-size:18px}
.error{background:#fee2e2;border:2px solid #b91c1c;color:#7f1d1d;padding:12px;border-radius:8px}
.code{font:700 40px/1.2 ui-monospace,Consolas,monospace;letter-spacing:2px;margin:12px 0}
.qr{margin:8px 0}
.stamps li{margin:4px 0}
.card{border:2px dashed #555;border-radius:12px;padding:16px;margin-top:24px;max-width:420px}
.card .code{font-size:30px}
@media print{.noprint{display:none}main{padding:0}.card{border:2px solid #000}}
`;

function page(hubName, title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(hubName)}</title><style>${STYLE}</style><body><main>${body}</main></body></html>`;
}

function secure(c) {
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

// Passport codes looked up that don't exist, per address and hour: 60, so passports can't be found by trying codes.
const MISSES = 60;
const misses = new Map();
const missCount = (ip) => {
  const m = misses.get(ip);
  return m && Date.now() - m.since <= 3600_000 ? m.n : 0;
};
function addMiss(ip) {
  const m = misses.get(ip);
  if (!m || Date.now() - m.since > 3600_000) misses.set(ip, { n: 1, since: Date.now() });
  else m.n += 1;
}
/** A look-up counted as a miss before it was made (so guesses sent at once can't all pass the check) turned out a hit. */
function unMiss(ip) {
  const m = misses.get(ip);
  if (m && m.n > 0) m.n -= 1;
}
setInterval(() => {
  for (const [k, m] of misses) if (Date.now() - m.since > 3600_000) misses.delete(k);
}, 600_000).unref();

export function registerHops({ app, member, fail, newId, allow, bucket, clientIp, sha, hubName }) {
  const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });

  // Each company has its own allowance, under the install's ceiling (a hosted install serves many companies).
  const allowShop = (c, what, shopRef, perShop, perInstall) =>
    allow(`${what}:${c.get("install").id}:${shopRef}`, perShop) && allow(`${what}:${c.get("install").id}`, perInstall);

  /** The company this request is for (X-Shop-Ref, or shopRef in the body) and its name as the hub knows it. */
  async function shopOf(c, body = {}) {
    const shopRef = str(c.req.header("x-shop-ref") ?? body.shopRef, 64);
    if (!shopRef) throw fail(400, "Send X-Shop-Ref: the company's id.");
    const known = await one(`SELECT name FROM shops WHERE install_id = $1 AND shop_ref = $2`, [c.get("install").id, shopRef]);
    return { installId: c.get("install").id, shopRef, shopName: known?.name ?? str(body.shopName, 120) ?? "A shop" };
  }

  function keyOf(body) {
    const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim().slice(0, 300) : "";
    if (!isPublicKey(publicKey)) throw fail(400, "Send the company's partner key (publicKey): an Ed25519 public key.");
    return publicKey;
  }

  async function hopOut(hop, me) {
    const n = await one(`SELECT count(*)::int AS n FROM hop_shops WHERE hop_id = $1 AND status = 'JOINED'`, [hop.id]);
    return { id: hop.id, name: hop.name, startsOn: hop.starts_on, endsOn: hop.ends_on, rule: hop.rule, shops: n.n, role: me?.role ?? null, status: me?.status ?? null, slug: hop.slug };
  }
  const HOP_COLS = `id, slug, name, starts_on::text AS starts_on, ends_on::text AS ends_on, rule, organizer_install, organizer_shop_ref, created_at, ended_at`;

  /** The hop and this company's place in it; 404 when the company isn't in it (or `organizer` and it isn't the organizer). */
  async function myHop(c, id, { organizer = false, joined = false } = {}) {
    const s = await shopOf(c);
    const hop = typeof id === "string" && id.length <= 64 ? await one(`SELECT ${HOP_COLS} FROM hops WHERE id = $1`, [id]) : null;
    const me = hop && (await one(`SELECT * FROM hop_shops WHERE hop_id = $1 AND install_id = $2 AND shop_ref = $3`, [hop.id, s.installId, s.shopRef]));
    if (!me) throw fail(404, "No such shop hop for this shop.");
    if (organizer && me.role !== "ORGANIZER") throw fail(403, "Only the hop's organizer can do that.");
    if ((joined || organizer) && me.status !== "JOINED") throw fail(403, "This shop isn't taking part in that hop any more.");
    return { hop, me, shop: s };
  }

  // A hop is over a day after its last day (time zones), or once ended_at is written; markEnded writes it then.
  const endOf = (hop) => (hop.ends_on ? Date.parse(`${hop.ends_on}T23:59:59Z`) + 86400_000 : null);
  const over = (hop) => !!hop.ended_at || (hop.ends_on != null && Date.now() > endOf(hop));
  const markEnded = (hop) => (hop.ended_at || !hop.ends_on ? null : q(`UPDATE hops SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL`, [hop.id, new Date(endOf(hop))]));

  // ----- the shops' routes -----

  member.get("/hops", async (c) => {
    const s = await shopOf(c);
    const rows = await all(
      `SELECT h.id, h.slug, h.name, h.starts_on::text AS starts_on, h.ends_on::text AS ends_on, h.rule, s.role, s.status,
         (SELECT count(*)::int FROM hop_shops j WHERE j.hop_id = h.id AND j.status = 'JOINED') AS shops
       FROM hop_shops s JOIN hops h ON h.id = s.hop_id WHERE s.install_id = $1 AND s.shop_ref = $2 ORDER BY h.created_at DESC LIMIT 200`,
      [s.installId, s.shopRef],
    );
    return c.json({ hops: rows.map((h) => ({ id: h.id, name: h.name, startsOn: h.starts_on, endsOn: h.ends_on, rule: h.rule, shops: h.shops, role: h.role, status: h.status, slug: h.slug })) });
  });

  member.post("/hops", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const s = await shopOf(c, body);
    if (!allowShop(c, "hopnew", s.shopRef, 10, 100)) throw fail(429, "Too many new hops in the last hour.");
    const name = str(body.name, 120);
    if (!name) throw fail(400, "Give the hop a name.");
    const startsOn = str(body.startsOn, 10);
    const endsOn = str(body.endsOn, 10);
    if (!isDay(startsOn) || !isDay(endsOn) || endsOn < startsOn) {
      throw fail(400, "Send the first and last day of the hop (startsOn, endsOn: YYYY-MM-DD).");
    }
    const rule = String(body.rule ?? "all");
    const m = RULE.exec(rule);
    if (!m || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 200))) throw fail(400, 'rule is "all" or "any:N" (N from 1 to 200).');
    const publicKey = keyOf(body);
    const hop = await tx(async (client) => {
      const id = newId();
      const h = (
        await client.query(
          `INSERT INTO hops (id, slug, name, starts_on, ends_on, rule, organizer_install, organizer_shop_ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${HOP_COLS}`,
          [id, slugOf(name), name, startsOn, endsOn, rule, s.installId, s.shopRef],
        )
      ).rows[0];
      await client.query(`INSERT INTO hop_shops (hop_id, install_id, shop_ref, shop_name, public_key, role) VALUES ($1, $2, $3, $4, $5, 'ORGANIZER')`, [id, s.installId, s.shopRef, s.shopName, publicKey]);
      return h;
    });
    return c.json({ hop: await hopOut(hop, { role: "ORGANIZER", status: "JOINED" }) });
  });

  member.post("/hops/join", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const s = await shopOf(c, body);
    if (!allowShop(c, "hopjoin", s.shopRef, 20, 200)) throw fail(429, "Too many tries. Wait an hour.");
    const publicKey = keyOf(body);
    const code = normCode(body.code);
    if (code.length < 6 || code.length > 40) throw fail(400, "Send the code the organizer gave you.");
    const hop = await tx(async (client) => {
      const inv = (await client.query(`SELECT * FROM hop_invites WHERE code_hash = $1 FOR UPDATE`, [sha(code)])).rows[0];
      if (!inv) throw fail(404, "That hop code isn't right. Check it with the shop that organizes the hop.");
      if (inv.used_at) throw fail(409, "That hop code was already used. Ask the organizer for a new one.");
      if (inv.expires_at < new Date()) throw fail(410, "That hop code has expired. Ask the organizer for a new one.");
      const h = (await client.query(`SELECT ${HOP_COLS} FROM hops WHERE id = $1 FOR UPDATE`, [inv.hop_id])).rows[0];
      // A shop joining after the last day would raise "all" for every passport: the hop is over (written so below).
      if (over(h)) return { ended: h };
      const had = (await client.query(`SELECT * FROM hop_shops WHERE hop_id = $1 AND shop_ref = $2`, [h.id, s.shopRef])).rows[0];
      if (had && had.install_id !== s.installId) throw fail(409, "This company is in that hop from another install already.");
      if (had?.role === "ORGANIZER") throw fail(400, "That's your own hop. Give the code to another shop.");
      if (had) {
        await client.query(`UPDATE hop_shops SET status = 'JOINED', left_at = NULL, public_key = $4, shop_name = $5 WHERE hop_id = $1 AND install_id = $2 AND shop_ref = $3`, [h.id, s.installId, s.shopRef, publicKey, s.shopName]);
      } else {
        await client.query(`INSERT INTO hop_shops (hop_id, install_id, shop_ref, shop_name, public_key, role) VALUES ($1, $2, $3, $4, $5, 'MEMBER')`, [h.id, s.installId, s.shopRef, s.shopName, publicKey]);
      }
      await client.query(`UPDATE hop_invites SET used_at = now(), used_by_install = $2, used_by_shop_ref = $3 WHERE code_hash = $1`, [inv.code_hash, s.installId, s.shopRef]);
      return h;
    });
    if (hop.ended) {
      await markEnded(hop.ended);
      throw fail(410, "That hop has ended.");
    }
    return c.json({ hop: await hopOut(hop, { role: "MEMBER", status: "JOINED" }) });
  });

  member.post("/hops/:id/invite-code", small, async (c) => {
    const { hop, shop } = await myHop(c, c.req.param("id"), { organizer: true });
    if (!allowShop(c, "hopinvite", shop.shopRef, 50, 500)) throw fail(429, "Too many hop codes in the last hour.");
    if (over(hop)) {
      await markEnded(hop);
      throw fail(410, "That hop has ended.");
    }
    const raw = randomFrom(INVITE_ALPHABET, 12);
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400_000);
    await q(`INSERT INTO hop_invites (code_hash, hop_id, expires_at) VALUES ($1, $2, $3)`, [sha(normCode(code)), hop.id, expiresAt]);
    return c.json({ code, expiresAt });
  });

  member.post("/hops/:id/leave", small, async (c) => {
    const { hop, me, shop } = await myHop(c, c.req.param("id"));
    if (me.role === "ORGANIZER") throw fail(400, "You organize this hop: the other shops and the shoppers count on it. It ends on its last day.");
    await q(`UPDATE hop_shops SET status = 'LEFT', left_at = coalesce(left_at, now()) WHERE hop_id = $1 AND install_id = $2 AND shop_ref = $3`, [hop.id, shop.installId, shop.shopRef]);
    return c.json({ ok: true });
  });

  // The organizer takes a shop out of the hop (one that joined by mistake, or after its last day): it stamps no more, and
  // "all" no longer counts it. Its stamps stay on the passports.
  member.post("/hops/:id/shops/:shopRef/remove", small, async (c) => {
    const { hop, shop } = await myHop(c, c.req.param("id"), { organizer: true });
    const ref = str(c.req.param("shopRef"), 64);
    if (ref === shop.shopRef) throw fail(400, "You organize this hop: you can't take your own shop out of it.");
    const r = await q(`UPDATE hop_shops SET status = 'LEFT', left_at = coalesce(left_at, now()) WHERE hop_id = $1 AND shop_ref = $2 AND role <> 'ORGANIZER' RETURNING shop_ref`, [hop.id, ref]);
    if (!r.rowCount) throw fail(404, "No such shop in this hop.");
    return c.json({ ok: true });
  });

  /** Stamp n of m on a passport, and whether it is complete, for the stamp `mine`. */
  async function numbers(client, hop, passportId, mine) {
    const joined = (await client.query(`SELECT shop_ref FROM hop_shops WHERE hop_id = $1 AND status = 'JOINED'`, [hop.id])).rows.map((r) => r.shop_ref);
    const of = needed(hop.rule, joined.length);
    const had = (await client.query(`SELECT id, shop_ref, at FROM hop_stamps WHERE passport_id = $1 ORDER BY at, id`, [passportId])).rows;
    // "all": a stamp from every shop taking part now; "any:N": N shops' stamps, whoever they are.
    const counts = hop.rule === "all" ? had.filter((r) => joined.includes(r.shop_ref)) : had;
    // Its place among the stamps that count, never past the number needed (a shop that left, or more shops than "any:N"
    // asks for, would make "stamp 6 of 5").
    const at = counts.findIndex((r) => r.id === mine.id) + 1 || counts.length;
    return { stampNo: of > 0 ? Math.min(at, of) : at, of, complete: of > 0 && counts.length >= of };
  }

  member.post("/hops/:id/stamps", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { hop, me, shop } = await myHop(c, c.req.param("id"), { joined: true });
    if (!allowShop(c, "hopstamp", shop.shopRef, 3000, 30000)) throw fail(429, "Too many stamps in the last hour.");
    const stampId = str(body.stampId, 64);
    if (!stampId || !/^[A-Za-z0-9_-]+$/.test(stampId)) throw fail(400, "Send the stamp's id (stampId).");
    const passport = typeof body.passport === "string" ? body.passport : "";
    if (!/^[0-9A-Z]{8}$/.test(passport)) throw fail(400, "Send the passport's 8-character code.");
    const at = typeof body.at === "string" ? body.at.slice(0, 40) : "";
    const when = Date.parse(at);
    if (Number.isNaN(when)) throw fail(400, "Send when it was stamped (at, ISO time).");
    if (when > Date.now() + 3600_000) throw fail(400, "That stamp's time is in the future. Check the computer's clock.");
    // A day either side for time zones; a stamp kept while the hub couldn't be reached may arrive any time later.
    if ((hop.starts_on && when < Date.parse(`${hop.starts_on}T00:00:00Z`) - 86400_000) || (hop.ends_on && when > Date.parse(`${hop.ends_on}T23:59:59Z`) + 86400_000)) {
      throw fail(400, `${hop.name} runs ${hop.starts_on} to ${hop.ends_on}: that stamp is outside it.`);
    }
    const sig = body.sig && typeof body.sig === "object" && !Array.isArray(body.sig) ? { v: body.sig.v, pub: String(body.sig.pub ?? "").slice(0, 300), sig: String(body.sig.sig ?? "").slice(0, 200) } : null;
    if (!sig || sig.v !== 1) throw fail(400, "Send the stamp's signature (sig).");
    // No key pinned: the company moved to this install (moves.mjs clears it; the program makes a new partner key there), and
    // the first stamp that checks out with its key pins it.
    if (me.public_key && sig.pub !== me.public_key) throw fail(403, "That stamp is signed with a key this hop doesn't know for your shop. Join the hop again with a new code.");
    if (!verifyStamp(sig, { hopId: hop.id, shopRef: shop.shopRef, stampId, passport, at })) throw fail(403, "That stamp's signature doesn't check out.");
    if (!me.public_key) {
      if (!isPublicKey(sig.pub)) throw fail(400, "Send the stamp's signature (sig).");
      await q(`UPDATE hop_shops SET public_key = $4 WHERE hop_id = $1 AND install_id = $2 AND shop_ref = $3 AND public_key IS NULL`, [hop.id, shop.installId, shop.shopRef, sig.pub]);
      const now = await one(`SELECT public_key FROM hop_shops WHERE hop_id = $1 AND install_id = $2 AND shop_ref = $3`, [hop.id, shop.installId, shop.shopRef]);
      if (now?.public_key !== sig.pub) throw fail(403, "That stamp is signed with a key this hop doesn't know for your shop. Join the hop again with a new code.");
    }
    const answer = await tx(async (client) => {
      const p = (await client.query(`SELECT * FROM hop_passports WHERE hop_id = $1 AND code = $2`, [hop.id, passport])).rows[0];
      if (!p) {
        const e = fail(404, "That passport isn't in this hop. Check the code on her passport.");
        e.extra = { code: "no_passport" };
        throw e;
      }
      // One lock per passport: two shops stamping her at once still number their stamps one after the other.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hop-passport:${p.id}`]);
      const same = (await client.query(`SELECT * FROM hop_stamps WHERE stamp_id = $1`, [stampId])).rows[0];
      if (same && (same.passport_id !== p.id || same.shop_ref !== shop.shopRef)) throw fail(409, "That stamp id was used for another stamp.");
      let mine = (await client.query(`SELECT * FROM hop_stamps WHERE hop_id = $1 AND passport_id = $2 AND shop_ref = $3`, [hop.id, p.id, shop.shopRef])).rows[0];
      if (!mine) {
        mine = (
          await client.query(`INSERT INTO hop_stamps (id, hop_id, passport_id, shop_ref, stamp_id, at, sig) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [
            newId(),
            hop.id,
            p.id,
            shop.shopRef,
            stampId,
            new Date(when),
            JSON.stringify(sig),
          ])
        ).rows[0];
      }
      const n = await numbers(client, hop, p.id, mine);
      return { ...n, shopper: p.share ? { name: p.name, email: p.email, phone: p.phone } : null };
    });
    return c.json(answer);
  });

  /** The hop's completed passports, for the organizer: named when the shopper shared, else by code. */
  async function completed(hop) {
    const joined = (await all(`SELECT shop_ref FROM hop_shops WHERE hop_id = $1 AND status = 'JOINED'`, [hop.id])).map((r) => r.shop_ref);
    const of = needed(hop.rule, joined.length);
    const rows = await all(
      `SELECT p.id, p.code, p.name, p.share, count(s.id) FILTER (WHERE $2::boolean OR s.shop_ref = ANY($3))::int AS n
       FROM hop_passports p LEFT JOIN hop_stamps s ON s.passport_id = p.id WHERE p.hop_id = $1 GROUP BY p.id ORDER BY p.created_at`,
      [hop.id, hop.rule !== "all", joined],
    );
    return rows.filter((r) => of > 0 && r.n >= of);
  }
  const shownName = (p) => (p.share ? p.name : `Passport ${passportWords(p.code)}`);
  const drawOut = (d) => ({ id: d.id, passport: d.code, name: shownName(d), prize: d.prize, present: d.present, at: d.drawn_at });

  member.get("/hops/:id/completed", async (c) => {
    const { hop } = await myHop(c, c.req.param("id"), { organizer: true });
    const done = await completed(hop);
    const counts = await one(`SELECT (SELECT count(*)::int FROM hop_passports WHERE hop_id = $1) AS passports, (SELECT count(*)::int FROM hop_stamps WHERE hop_id = $1) AS stamps`, [hop.id]);
    const draws = await all(`SELECT d.*, p.code, p.name, p.share FROM hop_draws d JOIN hop_passports p ON p.id = d.passport_id WHERE d.hop_id = $1 ORDER BY d.drawn_at`, [hop.id]);
    return c.json({ passports: counts.passports, stamps: counts.stamps, completed: done.map((p) => ({ passport: p.code, name: shownName(p) })), draws: draws.map(drawOut) });
  });

  member.post("/hops/:id/draws", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { hop, shop } = await myHop(c, c.req.param("id"), { organizer: true });
    if (!allowShop(c, "hopdraw", shop.shopRef, 200, 2000)) throw fail(429, "Too many draws in the last hour.");
    const code = normCode(body.passport);
    const prize = str(body.prize, 120) ?? "Grand prize";
    const p = (await completed(hop)).find((r) => r.code === code);
    if (!p) throw fail(400, "That passport isn't complete in this hop.");
    const d = await one(`INSERT INTO hop_draws (id, hop_id, passport_id, prize) VALUES ($1, $2, $3, $4) RETURNING *`, [newId(), hop.id, p.id, prize]);
    return c.json({ draw: drawOut({ ...d, code: p.code, name: p.name, share: p.share }) });
  });

  member.patch("/hops/:id/draws/:drawId", small, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { hop } = await myHop(c, c.req.param("id"), { organizer: true });
    if (typeof body.present !== "boolean") throw fail(400, "Send present: true or false.");
    const d = await one(`UPDATE hop_draws SET present = $3 WHERE id = $1 AND hop_id = $2 RETURNING *`, [c.req.param("drawId"), hop.id, body.present]);
    if (!d) throw fail(404, "No such draw in this hop.");
    const p = await one(`SELECT code, name, share FROM hop_passports WHERE id = $1`, [d.passport_id]);
    return c.json({ draw: drawOut({ ...d, ...p }) });
  });

  // ----- the public pages: sign up, and the passport -----

  async function hopBySlug(slug) {
    if (typeof slug !== "string" || slug.length > 64) return null;
    return one(`SELECT ${HOP_COLS} FROM hops WHERE slug = $1`, [slug]);
  }
  const shopsOf = (hopId) => all(`SELECT shop_name, shop_ref FROM hop_shops WHERE hop_id = $1 AND status = 'JOINED' ORDER BY role = 'ORGANIZER' DESC, joined_at`, [hopId]);

  function signUpPage(hop, shops, { error = null, values = {} } = {}) {
    const dates = hop.starts_on && hop.ends_on ? `${dayWords(hop.starts_on)} to ${dayWords(hop.ends_on)}` : "";
    const list = shops.map((s) => `<li>${esc(s.shop_name)}</li>`).join("");
    const form = over(hop)
      ? `<p><strong>This shop hop is over.</strong> Thank you to everyone who came.</p>`
      : `<h2>Get your passport</h2>
<p>Sign up here, then show your passport at each shop to get a stamp. It's free.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/hop/${esc(hop.slug)}">
<label for="name">Your name</label>
<input id="name" name="name" type="text" autocomplete="name" maxlength="120" required value="${esc(values.name)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="200" value="${esc(values.email)}">
<label for="phone">Or a phone number</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="40" value="${esc(values.phone)}">
<p class="note">An email or a phone number is needed, so there is one passport for each person.</p>
<label class="tick"><input type="checkbox" name="share" value="1"${values.share ? " checked" : ""}><span>Share my name, email and phone with each shop I visit on this hop.</span></label>
<p class="note">Leave this unticked and the shops only see your passport code. Prize winners are called by their passport code, so keep your passport with you.</p>
<button type="submit">Get my passport</button>
</form>`;
    return `<h1>${esc(hop.name)}</h1>
${dates ? `<p><strong>${esc(dates)}</strong></p>` : ""}
<p>${esc(ruleWords(hop.rule, shops.length))} to finish your passport.</p>
<h2>The shops</h2>
<ul>${list || "<li>Shops are joining. Check back soon.</li>"}</ul>
${form}`;
  }

  app.get("/hop/:slug", async (c) => {
    secure(c);
    const hop = await hopBySlug(c.req.param("slug"));
    if (!hop) return c.html(page(hubName, "Shop hop", `<h1>Shop hop not found</h1><p>Check the address with the shop that gave it to you.</p>`), 404);
    if (over(hop)) await markEnded(hop);
    return c.html(page(hubName, hop.name, signUpPage(hop, await shopsOf(hop.id))));
  });

  app.post("/hop/:slug", async (c) => {
    secure(c);
    const hop = await hopBySlug(c.req.param("slug"));
    if (!hop) return c.html(page(hubName, "Shop hop", `<h1>Shop hop not found</h1>`), 404);
    const shops = await shopsOf(hop.id);
    const form = await c.req.parseBody().catch(() => ({}));
    const values = { name: str(form.name, 120), email: str(form.email, 200)?.toLowerCase() ?? null, phone: str(form.phone, 40), share: form.share === "1" };
    const again = (error, status = 400) => c.html(page(hubName, hop.name, signUpPage(hop, shops, { error, values })), status);
    if (over(hop)) {
      await markEnded(hop);
      return again("This shop hop is over.", 410);
    }
    const ip = clientIp(c);
    // Only sign-ups that go through count against an address (a mistyped form doesn't use up a shop's guest Wi-Fi); tries
    // of any kind have a far looser ceiling.
    if (!allow(`hopsignuptries:${ip}`, SIGNUPS_PER_IP * 5)) return again("Too many sign-ups from here in the last hour. Please try again later.", 429);
    if (!values.name) return again("Please type your name.");
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return again("That email doesn't look right. Check it, or leave it empty and give a phone number.");
    if (values.phone && values.phone.replace(/\D/g, "").length < 7) return again("That phone number looks too short.");
    if (!values.email && !values.phone) return again("Please give an email or a phone number.");
    // Held before the awaits (sign-ups sent at once can't all pass the check), given back when it doesn't go through.
    const ipCount = bucket(`hopsignup:${ip}`);
    const hopCount = bucket(`hopsignups:${hop.id}`);
    if (ipCount.n >= SIGNUPS_PER_IP || hopCount.n >= SIGNUPS_PER_HOP) return again("Too many sign-ups from here in the last hour. Please try again later.", 429);
    ipCount.n++;
    hopCount.n++;
    const release = () => {
      ipCount.n = Math.max(0, ipCount.n - 1);
      hopCount.n = Math.max(0, hopCount.n - 1);
    };
    let code = null;
    try {
      const taken = await one(
        `SELECT 1 FROM hop_passports WHERE hop_id = $1 AND (($2::text IS NOT NULL AND lower(email) = $2) OR ($3::text IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = $3))`,
        [hop.id, values.email, values.phone ? values.phone.replace(/\D/g, "") : null],
      );
      if (taken) {
        release();
        return again("That email or phone already has a passport for this hop. Use the passport page you saved, or the printed card.", 409);
      }
      for (let i = 0; i < 5 && !code; i++) {
        const tryCode = randomFrom(PASSPORT_ALPHABET, 8);
        try {
          await q(`INSERT INTO hop_passports (id, hop_id, code, name, email, phone, share) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [newId(), hop.id, tryCode, values.name, values.email, values.phone, values.share]);
          code = tryCode;
        } catch (e) {
          if (e.code !== "23505") throw e;
          if (/email|phone/.test(e.constraint ?? "")) {
            release();
            return again("That email or phone already has a passport for this hop.", 409);
          }
        }
      }
    } catch (e) {
      release();
      throw e;
    }
    if (!code) {
      release();
      return again("Something went wrong. Please try again.", 500);
    }
    return c.redirect(`/p/${code}`, 303);
  });

  app.get("/p/:code", async (c) => {
    secure(c);
    const ip = clientIp(c);
    // As printed (HOP-XXXX-XXXX, any case) or the bare 8 characters.
    let typed = normCode(c.req.param("code"));
    if (typed.length === 11 && typed.startsWith("HOP")) typed = typed.slice(3);
    const code = typed.replace(/O/g, "0").replace(/[IL]/g, "1");
    const notFound = () => c.html(page(hubName, "Passport", `<h1>Passport not found</h1><p>Check the address. It is on your printed card too.</p>`), 404);
    if (!/^[0-9A-Z]{8}$/.test(code)) return notFound();
    // Wrong guesses are limited per address, so passports can't be found by trying codes.
    if (missCount(ip) >= MISSES) return c.html(page(hubName, "Passport", `<h1>Too many tries</h1><p>Please wait an hour.</p>`), 429);
    addMiss(ip); // counted before the look-up, given back on a hit
    const p = await one(`SELECT p.*, h.name AS hop_name, h.slug, h.rule, h.starts_on::text AS starts_on, h.ends_on::text AS ends_on, h.id AS hid FROM hop_passports p JOIN hops h ON h.id = p.hop_id WHERE p.code = $1`, [code]);
    if (!p) return notFound();
    unMiss(ip);
    const shops = await shopsOf(p.hid);
    const stamps = await all(`SELECT s.shop_ref, s.at, coalesce(j.shop_name, 'A shop') AS shop_name FROM hop_stamps s LEFT JOIN hop_shops j ON j.hop_id = s.hop_id AND j.shop_ref = s.shop_ref WHERE s.passport_id = $1 ORDER BY s.at`, [p.id]);
    const of = needed(p.rule, shops.length);
    const counted = p.rule === "all" ? stamps.filter((s) => shops.some((j) => j.shop_ref === s.shop_ref)).length : stamps.length;
    const words = passportWords(p.code);
    const qr = qrSvg(words, 240);
    // Anyone with the code sees this page (every shop that stamps her has it): her name is on it only when she chose to
    // share it with the shops anyway.
    const forWhom = p.share ? `Passport for <strong>${esc(p.name)}</strong>` : "Your shop hop passport";
    const card = `<div class="card"><p><strong>${esc(p.hop_name)}</strong></p><p>${forWhom}</p><div class="code">${esc(words)}</div><div class="qr">${qrSvg(words, 160)}</div><p class="note">Show this at each shop for your stamp.</p></div>`;
    if (c.req.query("print") === "1") return c.html(page(hubName, `${p.hop_name} passport`, `${card}<p class="noprint"><a href="/p/${esc(p.code)}">Back to the passport</a></p>`));
    const list = stamps.map((s) => `<li>&#10003; ${esc(s.shop_name)}</li>`).join("");
    const body = `<h1>${esc(p.hop_name)}</h1>
<p>${forWhom}</p>
<div class="code" aria-label="Passport code">${esc(words)}</div>
<div class="qr">${qr}</div>
<p>Show this page at each shop. They scan the square or type the code.</p>
<h2>Stamps: ${counted} of ${of}${of > 0 && counted >= of ? " &#8212; complete!" : ""}</h2>
<ul class="stamps">${list || "<li>No stamps yet.</li>"}</ul>
<p class="note">${esc(ruleWords(p.rule, shops.length))}.${p.share ? " You chose to share your name and contact with each shop you visit." : " Your name isn't shown here, and the shops see only your passport code."}</p>
<p class="noprint">Save this page (bookmark it), or <a class="button" href="/p/${esc(p.code)}?print=1">Print a card</a></p>
<p class="noprint note"><a href="/hop/${esc(p.slug)}">About this shop hop</a></p>`;
    return c.html(page(hubName, `${p.hop_name} passport`, body));
  });
}
