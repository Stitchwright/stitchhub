// The Terms of Service and the Privacy Policy (StitchBench docs/plans/hub-accounts-billing-design.md 4.2, package
// terms-launch; the drafts and how a version is published: StitchBench docs/legal/README.md). Each version is a pair of
// markdown files in legal/ (LEGAL_DIR for a test): terms-<version>.md and privacy-<version>.md, never edited once
// published. A version is YYYY-MM-DD, the day it comes into force (YYYY-MM-DD.2 for a second one that day), with
// "-draft" on the end while it is a draft for the lawyer: the page then says "DRAFT, not yet in force" over the text.
// The pages leave out the reviewers' notes in the files ("[LAWYER: ...]", "[OWNER: ...]") and put the owner's legal name
// (LEGAL_NAME, else the hub's name) where a draft says [OWNER LEGAL NAME].
// The version in force is TERMS_VERSION, or when that is unset the newest pair on file (drafts don't count once a
// published version exists, so a draft committed early never asks every account to accept it).
//   /terms, /privacy               the version in force
//   /terms/<v>, /privacy/<v>       any version on file (an earlier one says so and links the one in force)
//   GET /v1/terms/current          { version, draft, terms, privacy, versions }: what the programs read
// Accounts record what they accepted (accounts.terms_version and terms_at, the latest; terms_acceptances, each time):
// at sign-up on the hub, at an account started from the program, at "We updated our terms" on /account, and at every
// Checkout (src/accounts.mjs, src/billing.mjs).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { shell } from "./look.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = /^(\d{4}-\d{2}-\d{2})(?:\.(\d{1,2}))?(-draft)?$/;
const TITLES = { terms: "Terms of Service", privacy: "Privacy Policy" };

/** A version string as the files and TERMS_VERSION name them. */
export const validVersion = (v) => rank(v) !== null;
const validDay = (ymd) => !Number.isNaN(Date.parse(`${ymd}T00:00:00Z`)) && new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) === ymd;
export const isDraft = (v) => typeof v === "string" && v.endsWith("-draft");

/** The day, then the same-day number, then a draft before the version it becomes. Null for anything else. */
function rank(v) {
  const m = VERSION.exec(typeof v === "string" ? v : "");
  return m && validDay(m[1]) ? [m[1], Number(m[2] ?? 1), m[3] ? 0 : 1] : null;
}

/** -1, 0 or 1. Something that isn't a version (null, "draft", an old program's own word) is older than any version. */
export function compareVersions(a, b) {
  const x = rank(a);
  const y = rank(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ----- the files -----

let loaded = null;
function load() {
  if (loaded) return loaded;
  const dir = process.env.LEGAL_DIR?.trim() ? path.resolve(process.env.LEGAL_DIR.trim()) : path.join(ROOT, "legal");
  const files = new Map(); // version -> { terms, privacy } (paths)
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const m = /^(terms|privacy)-(.+)\.md$/.exec(name);
    if (!m || !rank(m[2])) continue;
    files.set(m[2], { ...files.get(m[2]), [m[1]]: path.join(dir, name) });
  }
  const versions = [...files].filter(([, f]) => f.terms && f.privacy).map(([v]) => v).sort(compareVersions);
  const published = versions.filter((v) => !isDraft(v));
  let current = (published.length ? published : versions).at(-1) ?? null;
  const wanted = process.env.TERMS_VERSION?.trim();
  if (wanted && versions.includes(wanted)) current = wanted;
  else if (wanted) console.error(`terms: TERMS_VERSION=${wanted} has no terms-${wanted}.md and privacy-${wanted}.md in ${dir}; showing ${current ?? "nothing"} instead`);
  if (!current) console.error(`terms: no terms-<version>.md and privacy-<version>.md pair in ${dir}: /terms and /privacy answer 404`);
  else console.log(`terms: version ${current} in force${isDraft(current) ? " (a draft, not yet in force: the pages say so)" : ""}`);
  loaded = { dir, files, versions, current, html: new Map() };
  return loaded;
}

/** The version in force (null when no pair is on file). */
export const currentVersion = () => load().current;

/** The account must tick the box again: it accepted nothing, or something older than the version in force. */
export function needsAccept(accepted) {
  const now = currentVersion();
  return Boolean(now) && compareVersions(accepted, now) < 0;
}

/**
 * A page that sent the version it showed (termsVersion) must have shown the one in force: the tick is for the text the
 * person could read. 409 when the version changed while the page was open.
 */
export function checkShown(body, fail) {
  if (body?.termsVersion !== undefined && body.termsVersion !== currentVersion()) {
    throw fail(409, "The terms were updated while this page was open. Reload the page and read the new version.");
  }
}

/** What /account/api/me and the claim answer say about the terms for one account. */
export function termsFor(account) {
  const now = currentVersion();
  return {
    current: now,
    draft: isDraft(now),
    accepted: account?.terms_version ?? null,
    acceptedAt: account?.terms_at ?? null,
    needsAccept: account ? needsAccept(account.terms_version) : false,
  };
}

/**
 * The account accepted `version` just now: the account's own columns (the latest) and a row in terms_acceptances (every
 * time). via: program (Settings → Account started it) | signup | account (the "We updated our terms" tick) | checkout.
 */
export async function recordAcceptance(client, { accountId, version, via, shopId = null, checkoutId = null }) {
  if (!version) return;
  const v = String(version).slice(0, 40);
  await client.query(`UPDATE accounts SET terms_version = $2, terms_at = now() WHERE id = $1`, [accountId, v]);
  await client.query(`INSERT INTO terms_acceptances (id, account_id, version, via, shop_id, checkout_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
    crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    accountId,
    v,
    via,
    shopId,
    checkoutId,
  ]);
}

// ----- markdown to HTML: headings, paragraphs, lists (nested by indent), quotes, tables, rules, links, bold, italic,
// code. Everything else is text, escaped. Links go only to http(s), mailto, a path on this hub or an anchor. -----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function safeHref(url) {
  const u = String(url).trim();
  if (/^https?:\/\/[^\s]+$/i.test(u) || /^mailto:[^\s]+$/i.test(u)) return u;
  if (/^\/(?![/\\])[^\s]*$/.test(u) || /^#[\w-]+$/.test(u)) return u;
  return null;
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^()\s]+)\)|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

export function inline(text) {
  let out = "";
  let at = 0;
  for (const m of String(text).matchAll(INLINE)) {
    out += esc(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined) {
      const href = safeHref(m[3]);
      if (!href) out += `${inline(m[2])} (${esc(m[3])})`;
      else if (/^https?:/i.test(href)) out += `<a href="${esc(href)}" rel="noopener noreferrer">${inline(m[2])}</a>`;
      else out += `<a href="${esc(href)}">${inline(m[2])}</a>`;
    } else if (m[4] !== undefined) out += `<strong>${inline(m[4])}</strong>`;
    else out += `<em>${inline(m[5])}</em>`;
  }
  return out + esc(text.slice(at));
}

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const QUOTE = /^ {0,3}>/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const lead = (line) => /^\s*/.exec(line)[0].length;
const isTable = (line, next) => /^\s*\|/.test(line) && next !== undefined && TABLE_RULE.test(next);
const startsBlock = (line, next) => HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTable(line, next);

/** A list starting at lines[i]: items at its indent, deeper items as a list inside the last one, indented lines as more text. */
function list(lines, i) {
  const first = ITEM.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  const text = (item, s) => {
    const last = item.parts.at(-1);
    if (last?.lines) last.lines.push(s);
    else item.parts.push({ lines: [s] });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the list carries on after it.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const m = j < lines.length && ITEM.exec(lines[j]);
      if (j < lines.length && ((m && m[1].length >= indent && (m[1].length > indent || /\d/.test(m[2]) === ordered)) || (!m && lead(lines[j]) > indent))) {
        i = j;
        continue;
      }
      break;
    }
    const m = ITEM.exec(line);
    if (m && m[1].length === indent) {
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ parts: [{ lines: [m[3]] }] });
      i++;
    } else if (m && m[1].length > indent && items.length) {
      const sub = list(lines, i);
      items.at(-1).parts.push({ html: sub.html });
      i = sub.next;
    } else if (!m && lead(line) > indent && items.length && !startsBlock(line.trimStart(), lines[i + 1])) {
      text(items.at(-1), line.trim());
      i++;
    } else break;
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const tag = ordered ? "ol" : "ul";
  const body = items.map((it) => `<li>${it.parts.map((p) => (p.html ? p.html : inline(p.lines.join(" ")))).join("")}</li>`).join("");
  return { html: `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`, next: i };
}

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function render(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const ids = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      let id = m[2].toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
      const seen = ids.get(id) ?? 0;
      ids.set(id, seen + 1);
      if (seen) id = `${id}-${seen + 1}`;
      out.push(`<h${level} id="${esc(id)}">${inline(m[2])}</h${level}>`);
      i++;
    } else if (RULE.test(line)) {
      out.push("<hr>");
      i++;
    } else if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      out.push(`<blockquote>${render(inner.join("\n"))}</blockquote>`);
    } else if (isTable(line, lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const tr = (r, tag) => `<tr>${head.map((_, k) => `<${tag}>${inline(r[k] ?? "")}</${tag}>`).join("")}</tr>`;
      out.push(`<div class="scroll"><table><thead>${tr(head, "th")}</thead><tbody>${rows.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
    } else if (ITEM.test(line)) {
      const l = list(lines, i);
      out.push(l.html);
      i = l.next;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

// ----- what the pages leave out -----
// The drafts carry questions for the lawyer, "[LAWYER: ...]", and facts or choices for the owner, "[OWNER: ...]" (or for
// both, "[OWNER/LAWYER: ...]"), many over several lines. The files keep them for the reviewers; the pages never show
// them. A note runs to its own closing bracket (brackets inside it nest), or, never closed, to the end of its paragraph.
// One in inline code (the drafts' banner names the kinds that way) is words about notes, not a note, and stays. A line
// left with nothing but a note goes too, so a note on a line of its own doesn't split a paragraph or a list.

const NOTE = /\[(?:LAWYER|OWNER)(?:\s*\/\s*(?:LAWYER|OWNER))*\s*:/g;
const BLANK_LINE = /[ \t]*(?:\n|$)/y;
const CUT = "\u0000";

/** Where a note starting at `start` ends (the index after its closing bracket, or its paragraph's end). */
function noteEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i + 1;
    else if (text[i] === "\n") {
      BLANK_LINE.lastIndex = i + 1;
      if (BLANK_LINE.test(text)) return i;
    }
  }
  return text.length;
}

/** The markdown as the pages show it: the reviewers' notes taken out, with the spaces before them. */
export function withoutNotes(md) {
  const text = String(md).replace(/\r\n?/g, "\n").replaceAll(CUT, "");
  let out = "";
  let at = 0;
  for (const m of text.matchAll(NOTE)) {
    if (m.index < at) continue; // inside a note already cut
    const line = text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index);
    if ((line.match(/`/g)?.length ?? 0) % 2) continue; // in inline code
    const from = m.index - /[ \t]*$/.exec(line)[0].length;
    out += text.slice(at, from) + CUT;
    at = noteEnd(text, m.index);
  }
  out += text.slice(at);
  return out
    .split("\n")
    .filter((l) => !l.includes(CUT) || l.replaceAll(CUT, "").trim())
    // A note that was all a bold or an italic held takes the marks with it.
    .map((l) => l.replace(/(\*\*|\*|__|_)\u0000\1/g, "").replaceAll(CUT, ""))
    .join("\n");
}

// ----- the pages -----

function pageHtml({ doc, version, current, versions, hubName, text }) {
  const other = doc === "terms" ? "privacy" : "terms";
  const title = `${TITLES[doc]} · ${hubName}`;
  const order = compareVersions(version, current);
  const notice =
    version === current
      ? ""
      : order < 0
        ? `<p class="note">This is an earlier version (${esc(version)}). The version in force now is ${esc(current)}: <a href="/${doc}">read it</a>.</p>`
        : `<p class="note">This version (${esc(version)}) isn't in force yet. The version in force now is ${esc(current)}: <a href="/${doc}">read it</a>.</p>`;
  const banner = isDraft(version)
    ? `<p class="draft" role="note"><strong>DRAFT, not yet in force.</strong> This text is a draft under review. It isn't an agreement yet and nothing in it applies until a version without this banner is published here.</p>`
    : "";
  const others = versions.filter((v) => v !== version && compareVersions(v, current) <= 0).reverse();
  const otherList = others.length ? `<p class="muted">Other versions: ${others.map((v) => `<a href="/${doc}/${esc(v)}">${esc(v)}</a>`).join(" · ")}</p>` : "";
  const body = `<p class="ver">Version ${esc(version)} · <a href="/${other}${version === current ? "" : `/${esc(version)}`}">${TITLES[other]}</a></p>
${banner}
${notice}
<article>
${text}
</article>
${otherList}`;
  return shell({ hubName, title, body, css: PAGE_CSS });
}

// The hub's look (src/look.mjs), with the legal text's own touches.
const PAGE_CSS = `
main{max-width:800px}
article{padding:12px 26px 20px}
article h1{margin-top:12px}article h2{font-size:21px;margin-top:30px}article h3{font-size:17px}
.muted,.ver{color:var(--muted);font-size:14px}
article table{font-size:14px}article td,article th{border:1px solid var(--line)}
`;

export function registerTerms({ app, hubName }) {
  load();
  // Who "we" are where the drafts leave it open ([OWNER LEGAL NAME]): LEGAL_NAME, the business's legal name, else the
  // hub's name. Put in after the markdown is rendered, so it shows exactly as typed.
  const legalName = process.env.LEGAL_NAME?.trim() || hubName;
  const notFound = (c, doc) =>
    c.html(shell({ hubName, title: `${TITLES[doc]} · ${hubName}`, css: PAGE_CSS, body: `<section><p>There's no such version of the ${esc(TITLES[doc])} on this hub.</p>
<p><a href="/${doc}">The version in force</a></p></section>` }), 404);

  function answer(c, doc, asked) {
    const t = load();
    const version = asked ?? t.current;
    const file = version && t.versions.includes(version) ? t.files.get(version)?.[doc] : null;
    if (!file) return notFound(c, doc);
    const key = `${doc}:${version}`;
    let html = t.html.get(key);
    if (!html) {
      const text = render(withoutNotes(fs.readFileSync(file, "utf8"))).replaceAll("[OWNER LEGAL NAME]", esc(legalName));
      html = pageHtml({ doc, version, current: t.current, versions: t.versions, hubName, text });
      t.html.set(key, html);
    }
    // No script runs on these pages, so none is allowed: a slip in the renderer couldn't run anything.
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    c.header("Cache-Control", "public, max-age=300");
    return c.html(html);
  }

  for (const doc of ["terms", "privacy"]) {
    app.get(`/${doc}`, (c) => answer(c, doc, null));
    app.get(`/${doc}/:version`, (c) => answer(c, doc, c.req.param("version")));
  }

  // No key needed: the programs read the version in force here, for the tick in Settings → Account.
  app.get("/v1/terms/current", (c) => {
    const t = load();
    if (!t.current) return c.json({ error: "No terms are published on this hub yet." }, 404);
    return c.json({ version: t.current, draft: isDraft(t.current), terms: `/terms/${t.current}`, privacy: `/privacy/${t.current}`, versions: t.versions.filter((v) => compareVersions(v, t.current) <= 0) });
  });
}
