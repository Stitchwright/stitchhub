// Takedowns, counter-notices and strikes for the manual repository (docs/plans/manual-repository-design.md in the
// StitchBench repo, sections 1, 4.2 and 6; package repo-takedown). The process of 17 U.S.C. 512(c) and (g) as the design
// states it; a lawyer reviews it before the repository opens (the design's L-questions).
//
// Public:   GET /copyright (the designated agent, the policy, the notice form), POST /copyright/notice (16 KB, 5 an hour
//           per address, a honeypot field). Unset COPYRIGHT_AGENT_NAME / COPYRIGHT_AGENT_ADDRESS / COPYRIGHT_EMAIL: the page
//           says the process isn't open yet and the form refuses.
// Account:  GET /account/api/repository (what was removed for this account, the strikes, whether uploading is on),
//           POST /account/api/repository/counter-notice.
// Admin:    /v1/admin/repository/notices (list, log, action, reject, restore, lawsuit, close, note, reminders, CSV),
//           /strikes (list, withdraw), /refused-brands. (The blocked hashes are in src/repository.mjs.)
//
// A complete notice that names a manual (its id, or the sha256 of the file) is acted on at once; one that doesn't is
// waiting for the owner, who matches the manual and presses Action. Acting: the manual leaves the feed and the free page
// (status removed, why copyright), the object moves to held/, the hash is blocked, the account whose upload was published
// gets a strike and an email, anyone else who offered the same bytes is told (no strike). Three strikes in 12 months
// end that account's uploading. A counter-notice from the uploader sets the restore window: business days 10 to 14
// (weekends and US federal holidays skipped), the complainant is sent a copy, the owner is reminded on day 10 and
// presses Restore unless the complainant says it has sued.
//
// Environment: COPYRIGHT_AGENT_NAME, COPYRIGHT_AGENT_ADDRESS, COPYRIGHT_EMAIL (the designated agent, as registered with
// the Copyright Office; COPYRIGHT_AGENT_PHONE is shown when set), REPO_NOTICE_EMAIL (where new notices and reminders go;
// defaults to COPYRIGHT_EMAIL).
import { one, q, tx, getSetting, setSetting } from "./db.mjs";
import { r2FromEnv } from "./r2.mjs";
import { sendMail } from "./mail.mjs";
import { libraryName } from "./repository.mjs";

// ===== business days =====
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);
const nthWeekday = (y, m, wd, n) => 1 + ((wd - new Date(Date.UTC(y, m, 1)).getUTCDay() + 7) % 7) + (n - 1) * 7;
const lastMonday = (y, m) => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() + 6) % 7);
};
/** A fixed-date holiday as the federal government observes it: a Saturday on the Friday before, a Sunday on the Monday after. */
const observed = (y, m, d) => {
  const t = new Date(Date.UTC(y, m, d));
  const dow = t.getUTCDay();
  return iso(new Date(Date.UTC(y, m, d + (dow === 6 ? -1 : dow === 0 ? 1 : 0))));
};
const holidayCache = new Map();
/** The dates in year y that are US federal holidays (as observed; New Year's Day of the next year when it is observed on Dec 31). */
function holidaysOf(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const day = (m, d) => iso(new Date(Date.UTC(y, m, d)));
  const set = new Set([
    observed(y, 0, 1), day(0, nthWeekday(y, 0, 1, 3)), day(1, nthWeekday(y, 1, 1, 3)), day(4, lastMonday(y, 4)), observed(y, 5, 19), observed(y, 6, 4),
    day(8, nthWeekday(y, 8, 1, 1)), day(9, nthWeekday(y, 9, 1, 2)), observed(y, 10, 11), day(10, nthWeekday(y, 10, 4, 4)), observed(y, 11, 25),
  ]);
  set.add(observed(y + 1, 0, 1)); // Jan 1 on a Saturday is observed on Dec 31
  holidayCache.set(y, set);
  return set;
}
export const isFederalHoliday = (s) => holidaysOf(Number(s.slice(0, 4))).has(s);
export const isBusinessDay = (s) => {
  const dow = utc(s).getUTCDay();
  return dow !== 0 && dow !== 6 && !isFederalHoliday(s);
};
/** The business day n business days after the date (day 1 is the next business day). */
export function addBusinessDays(s, n) {
  const d = utc(s);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(iso(d))) n--;
  }
  return iso(d);
}
/** How many business days after `from` the date `to` is (0 on the same day). */
export function businessDaysBetween(from, to) {
  let n = 0;
  const d = utc(from);
  const end = utc(to);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(iso(d))) n++;
  }
  return n;
}

// ===== what a notice says =====
const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
// TAKEDOWN_TEST_TODAY (YYYY-MM-DD) pins "today" for test/takedown.mjs, so the window across Thanksgiving can be checked; never set it on a real hub.
const today = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.TAKEDOWN_TEST_TODAY ?? "") ? process.env.TAKEDOWN_TEST_TODAY : new Date().toISOString().slice(0, 10));
const emailOk = (e) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const sha256re = /\b[0-9a-f]{64}\b/gi;
const idre = /\b[0-9a-f]{24}\b/gi;

/** The fields of a notice (the form's, or the owner's when logging one), tidied. */
export function readNotice(b) {
  b = b && typeof b === "object" ? b : {};
  return {
    complainant: { name: str(b.name, 200), organization: str(b.organization, 200), address: str(b.address, 600), phone: str(b.phone, 60), email: str(b.email, 200) },
    work: str(b.work, 2000),
    locations: str(b.locations, 4000),
    statements: { goodFaith: b.goodFaith === true, accuracy: b.accuracy === true },
    signature: str(b.signature, 200),
  };
}
/** What a notice lacks of the six elements of 512(c)(3)(A), in words (empty: complete). */
export function missingOfNotice(n) {
  const m = [];
  if (!n.signature) m.push("your signature (type your full name)");
  if (!n.work) m.push("the copyrighted work you say was infringed");
  if (!n.locations) m.push("the material you want removed and where it is (the manual's reference, its title, or the file's sha256)");
  if (!n.complainant.name) m.push("your name");
  if (!n.complainant.address) m.push("your postal address");
  if (!n.complainant.phone) m.push("your telephone number");
  if (!emailOk(n.complainant.email)) m.push("your email address");
  if (!n.statements.goodFaith) m.push("the statement that you believe in good faith that the use is not authorized by the copyright owner, its agent or the law");
  if (!n.statements.accuracy) m.push("the statement, under penalty of perjury, that the information is accurate and that you are the owner of the right or authorized to act for the owner");
  return m;
}
/** A counter-notice (512(g)(3)): the uploader's. */
export function readCounter(b) {
  b = b && typeof b === "object" ? b : {};
  return {
    name: str(b.name, 200),
    address: str(b.address, 600),
    phone: str(b.phone, 60),
    signature: str(b.signature, 200),
    statements: { goodFaith: b.goodFaith === true, jurisdiction: b.jurisdiction === true, service: b.service === true },
  };
}
export function missingOfCounter(c) {
  const m = [];
  if (!c.signature) m.push("your signature (type your full name)");
  if (!c.name) m.push("your name");
  if (!c.address) m.push("your postal address");
  if (!c.phone) m.push("your telephone number");
  if (!c.statements.goodFaith) m.push("the statement, under penalty of perjury, that you believe in good faith the file was removed by mistake or misidentification");
  if (!c.statements.jurisdiction) m.push("your consent to the jurisdiction of the federal court for your address (or, outside the United States, any judicial district where the hub can be found)");
  if (!c.statements.service) m.push("your agreement to accept service of process from the person who sent the notice");
  return m;
}

const csvCell = (v) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : Array.isArray(v) ? (v.every((x) => typeof x === "string") ? v.join(" ") : JSON.stringify(v)) : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const agentFromEnv = (env = process.env) => {
  const [name, address, email] = ["COPYRIGHT_AGENT_NAME", "COPYRIGHT_AGENT_ADDRESS", "COPYRIGHT_EMAIL"].map((k) => (env[k] ?? "").trim());
  return name && address && email ? { name, address, email, phone: (env.COPYRIGHT_AGENT_PHONE ?? "").trim() || null } : null;
};

export function registerTakedown({ app, admin, acct, fail, newId, allow, clientIp, requireAccount, hubName = "StitchHub", hubUrl = "" }) {
  const r2 = r2FromEnv();
  const storage = () => {
    if (!r2) throw fail(503, "The hub's file storage isn't set up yet.");
    return r2;
  };
  const withExtra = (status, message, extra) => Object.assign(fail(status, message), { extra });
  const agent = () => agentFromEnv();
  const ownerEmail = () => (process.env.REPO_NOTICE_EMAIL ?? "").trim() || (process.env.COPYRIGHT_EMAIL ?? "").trim();
  const accountUrl = () => `${hubUrl || ""}/account/repository`;

  /** Mail that fails is logged and carried on from: a removal or restore is never undone by a mailbox. */
  async function notify(to, subject, text) {
    if (!to) return false;
    try {
      await sendMail({ to, subject, text, fromName: hubName });
      return true;
    } catch (e) {
      console.error("takedown mail:", e.message);
      return false;
    }
  }
  const addNote = (id, by, text, client) =>
    (client ?? { query: q }).query(`UPDATE takedown_notices SET notes = notes || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify([{ at: new Date().toISOString(), by, text }])]);

  // ----- refused brands (a maker who sent a takedown) -----
  const refused = async () => {
    try {
      return JSON.parse((await getSetting("repo_refused_brands")) ?? "[]").map(String);
    } catch {
      return [];
    }
  };
  async function setRefusal(brand, on) {
    const list = await refused();
    const has = list.findIndex((b) => b.toLowerCase() === brand.toLowerCase());
    if (on && has < 0) list.push(brand);
    if (!on && has >= 0) list.splice(has, 1);
    await setSetting("repo_refused_brands", JSON.stringify(list));
    return list;
  }

  // ----- finding what a notice names -----
  /** Manual ids and file hashes mentioned in the notice's text, matched to what the hub holds. */
  async function matchText(text) {
    const ids = [...new Set(String(text ?? "").match(idre)?.map((s) => s.toLowerCase()) ?? [])];
    const shas = [...new Set(String(text ?? "").match(sha256re)?.map((s) => s.toLowerCase()) ?? [])];
    const manualIds = new Set();
    const fileIds = new Set();
    if (ids.length) for (const m of (await q(`SELECT id FROM manuals WHERE id = ANY($1)`, [ids])).rows) manualIds.add(m.id);
    if (shas.length) {
      for (const f of (await q(`SELECT id, manual_id FROM manual_files WHERE sha256 = ANY($1)`, [shas])).rows) {
        if (f.manual_id) manualIds.add(f.manual_id);
        else fileIds.add(f.id);
      }
    }
    return { manualIds: [...manualIds], fileIds: [...fileIds] };
  }

  const strikeWindow = `created_at > now() - interval '12 months' AND withdrawn_at IS NULL`;

  /**
   * Remove what a notice names. Per manual: out of the feed and the free page, object to held/, hash blocked, the uploader's
   * strike (and the third strike ends that account's uploading), others who offered the same bytes noted. A waiting file
   * (not published yet) is held and blocked with no strike. Mail goes out after the commit.
   */
  async function remove(notice, { manualIds = [], fileIds = [], by }) {
    const s = storage();
    const mails = [];
    const oldKeys = [];
    const done = { manuals: [], files: [], skipped: [] };
    await tx(async (client) => {
      const hold = async (f, why) => {
        const key = `held/${f.sha256}.pdf`;
        await s.copy(f.object_key, key, { disposition: "attachment" });
        await client.query(`UPDATE manual_files SET status = 'held', object_key = $2, updated_at = now() WHERE id = $1`, [f.id, key]);
        if (f.object_key !== key) oldKeys.push(f.object_key);
        await client.query(
          `INSERT INTO blocked_hashes (sha256, why, notice_id, file_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (sha256) DO UPDATE SET why = EXCLUDED.why, notice_id = EXCLUDED.notice_id, file_id = EXCLUDED.file_id, lifted_at = NULL`,
          [f.sha256, why, notice.id, f.id],
        );
      };
      const reasonText = `copyright notice ${notice.id}`;
      for (const id of new Set(manualIds)) {
        const m = (await client.query(`SELECT * FROM manuals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!m) { done.skipped.push(`${id}: no such manual`); continue; }
        const f = m.file_id ? (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [m.file_id])).rows[0] : null;
        if (m.status === "removed") {
          // Withdrawn earlier by the owner: the bytes in retired/ are held and blocked now too (no strike: nothing was published).
          if (f?.status === "retired") { await hold(f, reasonText); done.files.push(f.id); } else done.skipped.push(`${id}: removed already`);
          continue;
        }
        await client.query(`UPDATE manuals SET status = 'removed', why = 'copyright', updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [m.id]);
        done.manuals.push(m.id);
        if (!f) continue;
        done.files.push(f.id);
        await hold(f, reasonText);
        const ups = (await client.query(`SELECT * FROM uploads WHERE manual_id = $1 OR file_id = $2 ORDER BY created_at`, [m.id, f.id])).rows;
        const owner = ups.find((u) => u.state === "approved");
        await client.query(`UPDATE uploads SET state = 'removed', reason = 'Removed on a copyright notice.', updated_at = now() WHERE id = ANY($1) AND state = 'approved'`, [ups.filter((u) => u.state === "approved").map((u) => u.id)]);
        const what = `${m.brand} ${m.models} ${m.doc_type}${m.year ? " " + m.year : ""}`;
        const seen = new Set();
        if (owner?.account_id) {
          seen.add(owner.account_id);
          await client.query(`INSERT INTO strikes (id, account_id, install_id, shop_id, notice_id, file_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (notice_id, file_id) DO NOTHING`, [newId(), owner.account_id, owner.install_id, owner.shop_id, notice.id, f.id]);
          const count = Number((await client.query(`SELECT count(*) AS n FROM strikes WHERE account_id = $1 AND ${strikeWindow}`, [owner.account_id])).rows[0].n);
          let ended = false;
          if (count >= 3) {
            const r = await client.query(`UPDATE accounts SET repo_uploads_off = true WHERE id = $1 AND NOT repo_uploads_off RETURNING id`, [owner.account_id]);
            ended = r.rowCount > 0;
            await client.query(`UPDATE uploads SET state = 'rejected', reason = 'Uploading ended for this account.', updated_at = now() WHERE account_id = $1 AND state = 'pending'`, [owner.account_id]);
          }
          const acc = (await client.query(`SELECT email FROM accounts WHERE id = $1`, [owner.account_id])).rows[0];
          mails.push({ kind: "struck", to: acc?.email, what, count, ended, noticeId: notice.id });
        }
        for (const u of ups) {
          if (!u.account_id || seen.has(u.account_id) || u.state === "refused" || u.state === "rejected") continue;
          seen.add(u.account_id);
          const acc = (await client.query(`SELECT email FROM accounts WHERE id = $1`, [u.account_id])).rows[0];
          mails.push({ kind: "told", to: acc?.email, what, noticeId: notice.id });
        }
      }
      for (const id of new Set(fileIds)) {
        const f = (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!f) { done.skipped.push(`${id}: no such file`); continue; }
        if (f.status === "held") { done.skipped.push(`${id}: held already`); continue; }
        await hold(f, reasonText);
        await client.query(`UPDATE uploads SET state = 'rejected', reason = 'Removed on a copyright notice.', updated_at = now() WHERE file_id = $1 AND state IN ('pending', 'duplicate')`, [f.id]);
        done.files.push(f.id);
      }
      if (!done.manuals.length && !done.files.length) throw fail(409, `Nothing to remove: ${done.skipped.join("; ") || "no manual or file named"}.`);
      await client.query(
        `UPDATE takedown_notices SET status = 'actioned', actioned_at = now(), manual_ids = (SELECT array(SELECT DISTINCT unnest(manual_ids || $2::text[]))), file_ids = (SELECT array(SELECT DISTINCT unnest(file_ids || $3::text[]))), updated_at = now() WHERE id = $1`,
        [notice.id, done.manuals, done.files],
      );
      await addNote(notice.id, by, `Actioned: removed ${done.manuals.length} manual${done.manuals.length === 1 ? "" : "s"}${done.files.length > done.manuals.length ? ` and ${done.files.length - done.manuals.length} waiting file(s)` : ""}${done.skipped.length ? `; skipped: ${done.skipped.join("; ")}` : ""}.`, client);
    });
    for (const k of oldKeys) await s.remove(k).catch((e) => console.error("takedown: deleting a moved object:", e.message));
    const from = notice.complainant?.organization || notice.complainant?.name || "a rights holder";
    for (const m of mails) {
      if (m.kind === "struck") {
        await notify(
          m.to,
          `A manual you offered was removed after a copyright notice`,
          `${m.what} was removed from the ${hubName} manual repository after a copyright notice from ${from} (reference ${m.noticeId}).\n\n` +
            `This is strike ${m.count} on your account. ${m.ended ? "Three strikes within 12 months end uploading: you can no longer offer manuals to the repository, and your waiting offers were rejected.\n\n" : "Three strikes within 12 months end uploading.\n\n"}` +
            `If you believe the file was removed by mistake or misidentification, you can send a counter-notice (the form is at ${accountUrl()}). It goes, with your name, address and telephone number, to the person who sent the notice. If they don't tell us within 10 to 14 business days that they have gone to court, the file is restored and the strike withdrawn. Knowingly false notices and counter-notices make the sender liable for damages (17 U.S.C. 512(f)).`,
        );
      } else {
        await notify(m.to, `A manual you offered was removed after a copyright notice`, `${m.what}, a file you also offered, was removed from the ${hubName} manual repository after a copyright notice from ${from} (reference ${m.noticeId}). This does not count against your account.`);
      }
    }
    return done;
  }

  /** Restore what a notice removed (after its counter-notice window): back in the feed, the hash free, the strike withdrawn. */
  async function restore(notice, by) {
    const s = storage();
    const oldKeys = [];
    const mails = [];
    const restored = [];
    await tx(async (client) => {
      for (const id of notice.manual_ids) {
        const m = (await client.query(`SELECT * FROM manuals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!m || m.status !== "removed") continue;
        const other = Number((await client.query(`SELECT count(*) AS n FROM takedown_notices WHERE kind = 'notice' AND id <> $1 AND status IN ('actioned', 'countered', 'lawsuit') AND $2 = ANY(manual_ids)`, [notice.id, id])).rows[0].n);
        if (other) { await addNote(notice.id, by, `Not restored: ${id} is named by another notice still open.`, client); continue; }
        const f = m.file_id ? (await client.query(`SELECT * FROM manual_files WHERE id = $1 FOR UPDATE`, [m.file_id])).rows[0] : null;
        if (f && f.status === "held") {
          const key = `files/${f.sha256}.pdf`;
          await s.copy(f.object_key, key, { disposition: `attachment; filename="${libraryName(m)}"` });
          oldKeys.push(f.object_key);
          await client.query(`UPDATE manual_files SET status = 'published', object_key = $2, updated_at = now() WHERE id = $1`, [f.id, key]);
          await client.query(`UPDATE blocked_hashes SET lifted_at = now() WHERE sha256 = $1 AND lifted_at IS NULL`, [f.sha256]);
          await client.query(`UPDATE strikes SET withdrawn_at = now() WHERE notice_id = $1 AND file_id = $2 AND withdrawn_at IS NULL`, [notice.id, f.id]);
          await client.query(`UPDATE uploads SET state = 'approved', reason = NULL, updated_at = now() WHERE (manual_id = $1 OR file_id = $2) AND state = 'removed'`, [m.id, f.id]);
        }
        await client.query(`UPDATE manuals SET status = 'published', why = NULL, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [m.id]);
        restored.push(m.id);
        const struck = (await client.query(`SELECT a.email FROM strikes st JOIN accounts a ON a.id = st.account_id WHERE st.notice_id = $1 AND st.file_id = $2`, [notice.id, f?.id])).rows[0];
        if (struck) mails.push({ to: struck.email, what: `${m.brand} ${m.models} ${m.doc_type}` });
      }
      if (!restored.length) throw fail(409, "Nothing was restored (the manuals aren't removed, or another open notice names them).");
      await client.query(`UPDATE takedown_notices SET status = 'restored', restored_at = now(), updated_at = now() WHERE id = $1`, [notice.id]);
      await addNote(notice.id, by, `Restored ${restored.length} manual${restored.length === 1 ? "" : "s"}.`, client);
    });
    for (const k of oldKeys) await s.remove(k).catch((e) => console.error("takedown: deleting a moved object:", e.message));
    for (const m of mails) await notify(m.to, `Your manual was restored`, `${m.what} is back in the ${hubName} manual repository, and the strike for it is withdrawn.`);
    await notify(notice.complainant?.email, `${hubName}: the manual named in your notice was restored`, `The 10 to 14 business days after the counter-notice have passed and we have not heard that you filed an action in court, so the material named in your notice (reference ${notice.id}) was restored (17 U.S.C. 512(g)(2)(C)).`);
    return restored;
  }

  // ----- the public side: /copyright -----

  const page = () => {
    const a = agent();
    const open = Boolean(a);
    const row = (label, value) => (value ? `<tr><th>${label}</th><td>${esc(value)}</td></tr>` : "");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Copyright - ${esc(hubName)}</title>
<style>
:root{--bg:#f4f2ee;--card:#fff;--ink:#1c2430;--muted:#5b6573;--line:#ddd8cf;--accent:#1f3a5f;--bad:#b3261e;--ok:#1e7a3c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15181d;--card:#1e232a;--ink:#e8ebef;--muted:#a3acb8;--line:#333a44;--accent:#8fb3e0;--bad:#ff8a80;--ok:#7dd3a0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:0 0 10px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}.muted{color:var(--muted)}
label{display:block;margin:10px 0 2px;color:var(--muted);font-size:13px}input,textarea,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);width:100%}
textarea{min-height:80px}button{background:var(--accent);color:#fff;border-color:var(--accent);cursor:pointer;margin-top:12px;width:auto}
.check{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.check input{width:auto;margin-top:4px}.check label{margin:0;color:var(--ink);font-size:15px}
th{text-align:left;padding:2px 12px 2px 0;vertical-align:top;color:var(--muted);font-weight:normal}a{color:var(--accent)}.hp{position:absolute;left:-9999px;height:0;overflow:hidden}
.bad{color:var(--bad)}.ok{color:var(--ok)}
</style></head><body><main>
<h1>Copyright</h1><p class="muted">${esc(hubName)} keeps a library of manuals that members choose to offer. We respond to notices of claimed infringement under 17 U.S.C. 512.</p>
<section><h2>Our designated agent</h2>${
      open
        ? `<table>${row("Name", a.name)}${row("Address", a.address)}${row("Email", a.email)}${row("Telephone", a.phone)}</table>`
        : `<p><strong>Not yet open.</strong> The manual repository isn't open yet, and the designated agent for copyright notices hasn't been named. Nothing here can be sent until it is.</p>`
    }</section>
<section><h2>Sending a notice</h2><p>A notice that a manual here infringes your copyright needs: your signature; the work you say is infringed; the material and where it is (the manual's reference from the Manuals page, its title, or the file's sha256); your name, address, telephone number and email; a statement that you believe in good faith the use isn't authorized by the copyright owner, its agent or the law; and a statement, under penalty of perjury, that the information is accurate and that you own the right or may act for its owner. A notice missing any of these can't be acted on, and the form tells you which. Anyone who knowingly misrepresents that material infringes, or was removed by mistake, is liable for damages (17 U.S.C. 512(f)).</p>
<p class="muted">You can also send the same by email to ${open ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : "the copyright address (not yet open)"}. The uploader is told who sent the notice (your name or organisation, not your contact details) and may answer with a counter-notice, which is sent to you in full, address and telephone number included.</p></section>
${
  open
    ? `<section><h2>Notice form</h2><form id="f" autocomplete="off">
<label for="name">Your name</label><input id="name" name="name" maxlength="200" required>
<label for="organization">Organisation (if you act for one)</label><input id="organization" name="organization" maxlength="200">
<label for="address">Postal address</label><textarea id="address" name="address" maxlength="600" required></textarea>
<label for="phone">Telephone</label><input id="phone" name="phone" maxlength="60" required>
<label for="email">Email</label><input id="email" name="email" type="email" maxlength="200" required>
<label for="work">The copyrighted work</label><textarea id="work" name="work" maxlength="2000" required></textarea>
<label for="locations">The material and where it is</label><textarea id="locations" name="locations" maxlength="4000" required></textarea>
<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1"></div>
<div class="check"><input type="checkbox" id="goodFaith"><label for="goodFaith">I have a good-faith belief that use of the material in the way complained of is not authorized by the copyright owner, its agent or the law.</label></div>
<div class="check"><input type="checkbox" id="accuracy"><label for="accuracy">The information in this notice is accurate, and under penalty of perjury I am the owner of an exclusive right that is allegedly infringed or am authorized to act on the owner's behalf.</label></div>
<label for="signature">Signature (type your full name)</label><input id="signature" name="signature" maxlength="200" required>
<button>Send the notice</button></form><p id="msg" role="status"></p></section>
<script>
const $=(i)=>document.getElementById(i);
$("f").onsubmit=async(e)=>{e.preventDefault();const b=e.target.querySelector("button");b.disabled=true;const m=$("msg");m.className="";m.textContent="";
const body={};for(const k of ["name","organization","address","phone","email","work","locations","website","signature"])body[k]=$(k).value;body.goodFaith=$("goodFaith").checked;body.accuracy=$("accuracy").checked;
try{const r=await fetch("/copyright/notice",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
if(!r.ok){m.className="bad";m.textContent=j.error||r.statusText;if(j.missing){const ul=document.createElement("ul");for(const x of j.missing){const li=document.createElement("li");li.textContent=x;ul.append(li)}m.append(ul)}}
else{m.className="ok";m.textContent=j.message;e.target.reset()}}catch(err){m.className="bad";m.textContent="The hub couldn't be reached. Try again."}b.disabled=false};
</script>`
    : ""
}
<section><h2>Counter-notices</h2><p>If a file you offered was removed on a notice and you believe that was a mistake or a misidentification, sign in and send a counter-notice from your account's repository page. It needs your signature, name, address and telephone number; a statement under penalty of perjury that you believe the file was removed by mistake or misidentification; and your consent to the jurisdiction of the federal court for your address and acceptance of service from the person who sent the notice. We send the whole counter-notice to that person. Unless they tell us within 10 to 14 business days (weekends and US federal holidays don't count) that they have gone to court, the file is restored.</p></section>
<section><h2>Repeat infringers</h2><p>Each file removed on a notice is a strike for the account that offered it, withdrawn if the file is restored after a counter-notice. Three strikes within 12 months end that account's uploading to the repository (a new account made to get round this is refused), its waiting offers are rejected and its other files are looked at again. In a flagrant case uploading can end sooner.</p></section>
<section><h2>What review checks</h2><p>Every file offered is looked at before it appears: that it is a manual, readable and whole; that its brand, models, document type and year are right; that nothing private is in it; that the automatic checks passed (no scripts or encryption); that it isn't a duplicate of a better file; that it isn't a work an earlier notice named; and that it isn't marked confidential, dealer-only or not for distribution. This screens files; it doesn't decide who owns the rights to them.</p></section>
<p class="muted"><a href="/">Home</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></main></body></html>`;
  };
  app.get("/copyright", (c) => c.html(page()));

  app.post("/copyright/notice", async (c) => {
    if (!agent()) throw fail(503, "The copyright process isn't open yet: the designated agent hasn't been named.");
    if (!allow(`notice:${clientIp(c)}`, 5)) throw fail(429, "Too many notices from this address in the last hour. Try again later, or write to the copyright address.");
    const body = await c.req.json();
    const thanks = "Thank you. We have your notice.";
    if (str(body.website, 200)) return c.json({ ok: true, message: thanks }); // the honeypot: a person never fills it
    const n = readNotice(body);
    const missing = missingOfNotice(n);
    if (missing.length) throw withExtra(400, `The notice isn't complete. It is missing: ${missing.join("; ")}.`, { missing });
    const id = newId();
    await q(`INSERT INTO takedown_notices (id, kind, via, status, complainant, work, locations, statements, signature) VALUES ($1, 'notice', 'form', 'new', $2, $3, $4, $5, $6)`, [id, JSON.stringify(n.complainant), n.work, n.locations, JSON.stringify(n.statements), n.signature]);
    await addNote(id, "hub", "Received through the form.");
    let actioned = false;
    try {
      const hit = await matchText(`${n.locations}\n${n.work}`);
      if (hit.manualIds.length || hit.fileIds.length) {
        await remove({ id, complainant: n.complainant }, { ...hit, by: "hub (the notice named it)" });
        actioned = true;
      }
    } catch (e) {
      console.error("takedown: acting on a notice:", e.message);
      await addNote(id, "hub", `Not actioned automatically: ${e.message}`);
    }
    await notify(ownerEmail(), `Copyright notice ${id}${actioned ? " (removed automatically)" : " (waiting for you)"}`, `A notice came in through the form from ${n.complainant.name}${n.complainant.organization ? ` (${n.complainant.organization})` : ""}.\nWork: ${n.work}\nMaterial: ${n.locations}\n\n${actioned ? "It named a manual here and the manual was removed." : "It didn't name a manual the hub could match. Open the admin page's Notices section and press Action."}\nBusiness days to act within: 1.`);
    return c.json({ ok: true, id, message: actioned ? "Thank you. The material you named has been removed, and the person who offered it has been told." : "Thank you. We have your notice and will act on it within one business day." });
  });

  // ----- the uploader's side -----

  const verified = async (c) => {
    const a = await requireAccount(c);
    if (!a.verified_at) throw fail(403, "Confirm your email address first: open the link we sent you.");
    return a;
  };

  acct.get("/repository", async (c) => {
    const a = await verified(c);
    const rows = (
      await q(
        `SELECT st.id AS strike_id, st.created_at AS struck_at, st.withdrawn_at, st.file_id, n.id AS notice_id, n.status, n.complainant, n.actioned_at, n.restore_earliest, n.restore_latest, n.countered_at, n.restored_at,
                m.id AS manual_id, m.brand, m.models, m.doc_type, m.year, m.title
         FROM strikes st JOIN takedown_notices n ON n.id = st.notice_id LEFT JOIN manual_files f ON f.id = st.file_id LEFT JOIN manuals m ON m.id = f.manual_id
         WHERE st.account_id = $1 ORDER BY st.created_at DESC LIMIT 200`,
        [a.id],
      )
    ).rows;
    const active = Number((await one(`SELECT count(*) AS n FROM strikes WHERE account_id = $1 AND ${strikeWindow}`, [a.id])).n);
    return c.json({
      uploadsOff: Boolean(a.repo_uploads_off),
      strikes: active,
      removals: rows.map((r) => ({
        noticeId: r.notice_id,
        what: r.title || `${r.brand ?? ""} ${r.models ?? ""} ${r.doc_type ?? ""}`.trim(),
        from: r.complainant?.organization || r.complainant?.name || "a rights holder",
        removedAt: r.actioned_at,
        status: r.status,
        struckAt: r.struck_at,
        strikeWithdrawn: Boolean(r.withdrawn_at),
        canCounter: r.status === "actioned",
        counteredAt: r.countered_at,
        restoreEarliest: r.restore_earliest,
        restoreLatest: r.restore_latest,
        restoredAt: r.restored_at,
      })),
    });
  });

  acct.post("/repository/counter-notice", async (c) => {
    const a = await verified(c);
    if (!allow(`counter:${a.id}`, 10)) throw fail(429, "Too many tries in the last hour. Try again later.");
    const body = await c.req.json();
    const noticeId = str(body.noticeId, 64);
    const st = noticeId ? await one(`SELECT * FROM strikes WHERE account_id = $1 AND notice_id = $2 LIMIT 1`, [a.id, noticeId]) : null;
    if (!st) throw fail(404, "No removal on your account has that reference.");
    const counter = readCounter(body);
    const missing = missingOfCounter(counter);
    if (missing.length) throw withExtra(400, `The counter-notice isn't complete. It is missing: ${missing.join("; ")}.`, { missing });
    const day = today();
    const earliest = addBusinessDays(day, 10);
    const latest = addBusinessDays(day, 14);
    // Taken for this call only: a second counter-notice for the same removal finds it no longer 'actioned'.
    const took = await one(`UPDATE takedown_notices SET status = 'countered', countered_at = now(), restore_earliest = $2, restore_latest = $3, updated_at = now() WHERE id = $1 AND kind = 'notice' AND status = 'actioned' RETURNING *`, [noticeId, earliest, latest]);
    if (!took) throw fail(409, "That removal can't take a counter-notice now (one was sent already, or the matter is closed).");
    const files = (await q(`SELECT m.brand, m.models, m.doc_type, m.year FROM manuals m WHERE m.id = ANY($1)`, [took.manual_ids])).rows;
    const what = files.map((m) => `${m.brand} ${m.models} ${m.doc_type}${m.year ? " " + m.year : ""}`).join("; ") || "the file you removed";
    const cid = newId();
    await q(`INSERT INTO takedown_notices (id, kind, parent_id, via, status, complainant, locations, statements, signature, account_id, countered_at) VALUES ($1, 'counter', $2, 'form', 'received', $3, $4, $5, $6, $7, now())`, [cid, noticeId, JSON.stringify({ name: counter.name, address: counter.address, phone: counter.phone, email: a.email }), `Removed from the repository: ${what}`, JSON.stringify(counter.statements), counter.signature, a.id]);
    await addNote(noticeId, "hub", `Counter-notice ${cid} received from the uploader. Restore window: business days 10 to 14, ${earliest} to ${latest}.`);
    await notify(
      took.complainant?.email,
      `${hubName}: a counter-notice answers your copyright notice ${noticeId}`,
      `The person who offered the material named in your notice sent this counter-notice (17 U.S.C. 512(g)).\n\nMaterial: ${what}\nName: ${counter.name}\nAddress: ${counter.address}\nTelephone: ${counter.phone}\nEmail: ${a.email}\nSignature: ${counter.signature}\n\nUnder penalty of perjury, they state a good-faith belief that the material was removed by mistake or misidentification. They consent to the jurisdiction of the federal court for their address and accept service of process from you.\n\n` +
        `Unless you tell us that you have filed an action seeking a court order to restrain them from infringing, we will restore the material between business day 10 and business day 14 after today: not before ${earliest}, and by ${latest} (weekends and US federal holidays aren't counted). To tell us, write to ${agent()?.email ?? "the copyright address"}, quoting reference ${noticeId}, with the court and case number.`,
    );
    await notify(a.email, `Your counter-notice was sent`, `Your counter-notice for ${what} was sent to the person who gave notice, with your name, address and telephone number. Unless they tell us within 10 to 14 business days (from ${earliest} to ${latest}) that they have gone to court, the file will be restored and the strike withdrawn.`);
    await notify(ownerEmail(), `Counter-notice for copyright notice ${noticeId}`, `The uploader answered notice ${noticeId}. The restore window is ${earliest} to ${latest}. You are reminded on ${earliest}.`);
    return c.json({ ok: true, counterId: cid, restoreEarliest: earliest, restoreLatest: latest });
  });

  // ----- the owner's side -----

  const noticeOut = async (n) => {
    const counter = n.kind === "notice" && ["countered", "restored", "lawsuit", "closed"].includes(n.status) ? await one(`SELECT * FROM takedown_notices WHERE parent_id = $1 AND kind = 'counter' ORDER BY received_at DESC LIMIT 1`, [n.id]) : null;
    const manuals = n.manual_ids.length ? (await q(`SELECT id, brand, models, doc_type, year, status FROM manuals WHERE id = ANY($1)`, [n.manual_ids])).rows : [];
    const day = today();
    const received = n.received_at.toISOString().slice(0, 10);
    return {
      id: n.id,
      kind: n.kind,
      parentId: n.parent_id,
      via: n.via,
      status: n.status,
      missing: n.missing,
      complainant: n.complainant,
      work: n.work,
      locations: n.locations,
      statements: n.statements,
      signature: n.signature,
      raw: n.raw_text,
      reason: n.reason,
      manuals,
      receivedAt: n.received_at,
      ageBusinessDays: businessDaysBetween(received, day),
      actionedAt: n.actioned_at,
      counteredAt: n.countered_at,
      restoreEarliest: n.restore_earliest,
      restoreLatest: n.restore_latest,
      restoreDue: n.status === "countered" && n.restore_earliest <= day,
      restoredAt: n.restored_at,
      closedAt: n.closed_at,
      counter: counter ? { id: counter.id, complainant: counter.complainant, statements: counter.statements, signature: counter.signature, receivedAt: counter.received_at } : null,
      notes: n.notes,
    };
  };
  const getNotice = async (id) => {
    const n = await one(`SELECT * FROM takedown_notices WHERE id = $1 AND kind = 'notice'`, [id]);
    if (!n) throw fail(404, "No such notice.");
    return n;
  };

  admin.get("/repository/notices", async (c) => {
    const status = str(c.req.query("status"), 20);
    const { rows } = await q(`SELECT * FROM takedown_notices WHERE kind = 'notice' ${status ? "AND status = $1" : ""} ORDER BY received_at DESC LIMIT 500`, status ? [status] : []);
    const day = today();
    return c.json({ agent: agent() ? { ...agent() } : null, notices: await Promise.all(rows.map(noticeOut)), refusedBrands: await refused(), restoreDue: rows.filter((n) => n.status === "countered" && n.restore_earliest <= day).length });
  });

  admin.get("/repository/notices.csv", async (c) => {
    const { rows } = await q(`SELECT * FROM takedown_notices ORDER BY received_at`);
    const cols = ["id", "kind", "parent_id", "via", "status", "missing", "complainant", "work", "locations", "statements", "signature", "raw_text", "manual_ids", "file_ids", "account_id", "reason", "received_at", "actioned_at", "countered_at", "restore_earliest", "restore_latest", "reminded_at", "restored_at", "closed_at", "notes"];
    const text = [cols.join(","), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(","))].join("\r\n");
    return c.body(text, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="copyright-notices.csv"' });
  });

  // "Log a notice": one that came by email or post, pasted in.
  admin.post("/repository/notices", async (c) => {
    const body = await c.req.json();
    const via = body.via === "post" ? "post" : "email";
    const raw = str(body.raw, 20000);
    const n = readNotice(body);
    if (!raw && !n.work && !n.locations) throw fail(400, "Paste the notice (raw) or fill its fields.");
    const missing = missingOfNotice(n);
    const id = newId();
    await q(`INSERT INTO takedown_notices (id, kind, via, status, missing, complainant, work, locations, statements, signature, raw_text) VALUES ($1, 'notice', $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, via, missing.length ? "incomplete" : "new", missing, JSON.stringify(n.complainant), n.work, n.locations, JSON.stringify(n.statements), n.signature, raw]);
    await addNote(id, "hub admin", `Logged from ${via}.`);
    return c.json({ ok: true, id, status: missing.length ? "incomplete" : "new", missing });
  });

  admin.post("/repository/notices/:id/action", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const n = await getNotice(c.req.param("id"));
    if (!["new", "incomplete"].includes(n.status)) throw fail(409, `That notice is ${n.status}: it can't be actioned.`);
    if (n.status === "incomplete" && body.substantial !== true) throw fail(409, `That notice is incomplete (${n.missing.join("; ")}). Ask the sender for what is missing, or press Action again saying it substantially complies.`);
    let manualIds = (Array.isArray(body.manualIds) ? body.manualIds : []).map(String);
    let fileIds = [];
    if (!manualIds.length) ({ manualIds, fileIds } = await matchText(`${n.locations ?? ""}\n${n.work ?? ""}\n${n.raw_text ?? ""}`));
    if (!manualIds.length && !fileIds.length) throw fail(400, "Name the manuals to remove (manualIds): the notice's text didn't give a reference or hash the hub knows.");
    const done = await remove(n, { manualIds, fileIds, by: "hub admin" });
    if (body.refuseBrand === true) {
      const brands = (await q(`SELECT DISTINCT brand FROM manuals WHERE id = ANY($1)`, [done.manuals])).rows.map((r) => r.brand);
      for (const b of brands) await setRefusal(b, true);
      await addNote(n.id, "hub admin", `Refusing later offers for: ${brands.join(", ")}.`);
    }
    return c.json({ ok: true, ...done });
  });

  admin.post("/repository/notices/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reason = str(body.reason, 500);
    if (!reason) throw fail(400, "Give a reason (it is kept in the log).");
    const n = await getNotice(c.req.param("id"));
    if (!["new", "incomplete"].includes(n.status)) throw fail(409, `That notice is ${n.status}.`);
    await q(`UPDATE takedown_notices SET status = 'rejected', reason = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [n.id, reason]);
    await addNote(n.id, "hub admin", `Rejected: ${reason}`);
    return c.json({ ok: true });
  });

  admin.post("/repository/notices/:id/restore", async (c) => {
    const n = await getNotice(c.req.param("id"));
    if (n.status === "lawsuit") throw fail(409, "The complainant has said it filed a lawsuit: the file stays down.");
    if (n.status !== "countered") throw fail(409, n.status === "actioned" ? "No counter-notice has been sent for this notice." : `That notice is ${n.status}.`);
    if (n.restore_earliest > today()) throw fail(409, `The window opens on ${n.restore_earliest} (business day 10 after the counter-notice). It closes on ${n.restore_latest}.`);
    const restored = await restore(n, "hub admin");
    return c.json({ ok: true, restored });
  });

  admin.post("/repository/notices/:id/lawsuit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const n = await getNotice(c.req.param("id"));
    if (!["actioned", "countered"].includes(n.status)) throw fail(409, `That notice is ${n.status}.`);
    await q(`UPDATE takedown_notices SET status = 'lawsuit', updated_at = now() WHERE id = $1`, [n.id]);
    await addNote(n.id, "hub admin", `The complainant says it filed suit; the file stays down.${str(body.note, 500) ? ` ${str(body.note, 500)}` : ""}`);
    return c.json({ ok: true });
  });

  admin.post("/repository/notices/:id/close", async (c) => {
    const n = await getNotice(c.req.param("id"));
    if (["new", "incomplete"].includes(n.status)) throw fail(409, "Action or reject it first.");
    await q(`UPDATE takedown_notices SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`, [n.id]);
    await addNote(n.id, "hub admin", "Closed.");
    return c.json({ ok: true });
  });

  admin.post("/repository/notices/:id/note", async (c) => {
    const body = await c.req.json();
    const text = str(body.text, 2000);
    if (!text) throw fail(400, "Write the note.");
    const n = await one(`SELECT id FROM takedown_notices WHERE id = $1`, [c.req.param("id")]);
    if (!n) throw fail(404, "No such notice.");
    await addNote(n.id, "hub admin", text);
    return c.json({ ok: true });
  });

  // The day-10 reminder: run by the hourly sweep, or at once from here.
  async function remind() {
    const due = (await q(`SELECT id, restore_earliest, restore_latest FROM takedown_notices WHERE kind = 'notice' AND status = 'countered' AND reminded_at IS NULL AND restore_earliest <= $1`, [today()])).rows;
    for (const n of due) {
      const took = await q(`UPDATE takedown_notices SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL`, [n.id]);
      if (!took.rowCount) continue;
      await addNote(n.id, "hub", "Reminder sent: the restore window is open.");
      await notify(ownerEmail(), `Restore due: copyright notice ${n.id}`, `Business day 10 after the counter-notice has come (${n.restore_earliest}). Unless the complainant has said it filed in court, press Restore in the admin page's Notices section by ${n.restore_latest}.`);
    }
    return due.length;
  }
  admin.post("/repository/notices/reminders", async (c) => c.json({ ok: true, reminded: await remind() }));
  setInterval(() => remind().catch((e) => console.error("takedown reminders:", e.message)), 3600_000).unref();

  admin.get("/repository/strikes", async (c) => {
    const { rows } = await q(`SELECT st.*, a.email AS account_email, a.repo_uploads_off, s.name AS shop_name, i.name AS install_name FROM strikes st LEFT JOIN accounts a ON a.id = st.account_id LEFT JOIN shops s ON s.id = st.shop_id LEFT JOIN installs i ON i.id = st.install_id ORDER BY st.created_at DESC LIMIT 500`);
    return c.json({ strikes: rows.map((r) => ({ id: r.id, accountId: r.account_id, account: r.account_email, uploadsOff: r.repo_uploads_off, shop: r.shop_name, install: r.install_name, noticeId: r.notice_id, fileId: r.file_id, createdAt: r.created_at, withdrawnAt: r.withdrawn_at })) });
  });
  admin.post("/repository/strikes/:id/withdraw", async (c) => {
    const r = await q(`UPDATE strikes SET withdrawn_at = now() WHERE id = $1 AND withdrawn_at IS NULL RETURNING notice_id`, [c.req.param("id")]);
    if (!r.rowCount) throw fail(404, "No such strike, or it is withdrawn already.");
    await addNote(r.rows[0].notice_id, "hub admin", `Strike ${c.req.param("id")} withdrawn by hand.`);
    return c.json({ ok: true });
  });

  admin.get("/repository/refused-brands", async (c) => c.json({ brands: await refused() }));
  admin.post("/repository/refused-brands", async (c) => {
    const body = await c.req.json();
    const brand = str(body.brand, 60);
    if (!brand) throw fail(400, "Name the brand.");
    return c.json({ ok: true, brands: await setRefusal(brand, body.refuse !== false) });
  });
}
