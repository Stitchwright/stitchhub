// Checks the Terms of Service and Privacy Policy pages and the acceptance record (src/terms.mjs; StitchBench
// docs/plans/hub-accounts-billing-design.md 4.2, package terms-launch). Starts a hub of its own on a free port against a
// scratch database, with the Stripe mock (test/stripe-mock.mjs) and a legal folder of its own (LEGAL_DIR): an older
// published version full of things that must come out escaped, the repository's drafts as a newer version, and files
// that aren't a version. Walks:
//   1. the version in force by default (the newest published one: a draft committed early doesn't count), the pages,
//      versions old and not yet in force, 404s, the markdown and its escaping, GET /v1/terms/current;
//   2. acceptance at an account started from the program, at sign-up on the hub (the tick, a page left open over a new
//      version), in the claim answer, at Checkout (no tick needed while current; the version in Stripe's metadata);
//   3. TERMS_VERSION moved to the drafts: the DRAFT banner, "We updated our terms" on /account (me.terms.needsAccept),
//      accepted there; Checkout refused without the tick and recorded with it; the export carries terms_acceptances;
//   4. a TERMS_VERSION with no files: the newest published version, and the log says why.
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/terms.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import pg from "pg";
import { startStripeMock } from "./stripe-mock.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "terms-test-admin-token";
const JOIN = "join-terms-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const WEBHOOK_SECRET = "whsec_termstest1234567890";
// The two plans' prices (src/billing.mjs priceBook): Solo and Shop, monthly and yearly.
const PRICES = { monthly: `price_month_${RUN}`, yearly: `price_year_${RUN}`, shopMonthly: `price_shopm_${RUN}`, shopYearly: `price_shopy_${RUN}` };
const CATALOG = [
  { id: PRICES.monthly, interval: "month", amount: 2500 },
  { id: PRICES.yearly, interval: "year", amount: 25000 },
  { id: PRICES.shopMonthly, interval: "month", amount: 4500 },
  { id: PRICES.shopYearly, interval: "year", amount: 45000 },
];
const OLD = "2026-09-01";
const DRAFT = "2026-10-03-draft";

// ----- a legal folder of the test's own -----
const LEGAL = fs.mkdtempSync(path.join(os.tmpdir(), "stitchhub-legal-"));
const NASTY = `# Old terms

Version: ${OLD}

<script>alert("x")</script> and <img src=x onerror=alert(1)> stay text; so does &amp; and "quotes".

## 1. Links

A [good link](https://example.com/a?b=1&c=2), a [bad link](javascript:void0), [another](javascript:alert(1)), a [data link](data:text/html,hi),
a [local one](/privacy) and an [anchor](#2-lists). Mail [us](mailto:owner@example.com). **Bold** and *italic* and
\`<code>\` and [OWNER: a note, not a link].

## 2. Lists

- one
- two, which goes on
  over a second line
  - nested <b>three</b>
- four

3. three
4. four

> A quote with **bold**.

| Col <i>A</i> | Col B |
|---|---|
| a1 | [x](https://example.com/x) |

---
`;
fs.writeFileSync(path.join(LEGAL, `terms-${OLD}.md`), NASTY);
fs.writeFileSync(path.join(LEGAL, `privacy-${OLD}.md`), `# Old privacy\n\nVersion: ${OLD}\n\nWe keep little.\n`);
fs.copyFileSync(path.join(ROOT, "legal", `terms-${DRAFT}.md`), path.join(LEGAL, `terms-${DRAFT}.md`));
fs.copyFileSync(path.join(ROOT, "legal", `privacy-${DRAFT}.md`), path.join(LEGAL, `privacy-${DRAFT}.md`));
fs.writeFileSync(path.join(LEGAL, "terms-2026-12-01-draft.md"), "# Half a pair: no privacy file, so not a version\n");
fs.writeFileSync(path.join(LEGAL, "terms-notaversion.md"), "# Not a version\n");
fs.writeFileSync(path.join(LEGAL, "README.md"), "# Not a version either\n");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const mock = await startStripeMock({ port: 0, webhookUrl: `${HUB}/v1/stripe`, webhookSecret: WEBHOOK_SECRET, catalog: CATALOG });

// ----- the hub under test -----
const ENV = {
  ...process.env,
  DATABASE_URL: DB,
  ADMIN_TOKEN: ADMIN,
  JOIN_KEY: JOIN,
  PORT: String(port),
  LINK_CHECKER: "off",
  TRUST_PROXY: "",
  RAILWAY_ENVIRONMENT_ID: "",
  HUB_URL: HUB,
  SMTP_URL: "",
  MAIL_FROM: "",
  MAIL_DEV_LOG: "true", // every email goes to the hub's log; the test reads the links from there
  HUB_NAME: "Terms Test Hub",
  HUB_LICENSE_KID: "",
  HUB_LICENSE_KEY: "",
  STRIPE_API_BASE: mock.url,
  STRIPE_SECRET_KEY: "sk_test_termsmock12345678",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_SOLO_MONTHLY: PRICES.monthly,
  STRIPE_PRICE_SOLO_YEARLY: PRICES.yearly,
  STRIPE_PRICE_SHOP_MONTHLY: PRICES.shopMonthly,
  STRIPE_PRICE_SHOP_YEARLY: PRICES.shopYearly,
  STRIPE_PRICE_MONTHLY: "",
  STRIPE_PRICE_YEARLY: "",
  LEGAL_DIR: LEGAL,
  TERMS_VERSION: "",
  SOURCE_URL: "",
  RAILWAY_GIT_COMMIT_SHA: "",
};
let hub = null;
let hubLog = "";
async function startHub(env) {
  hubLog = "";
  hub = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const h = hub;
  h.stdout.on("data", (d) => (hubLog += d));
  h.stderr.on("data", (d) => (hubLog += d));
  for (let i = 0; ; i++) {
    if (h.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopHub = () =>
  new Promise((r) => {
    if (!hub || hub.exitCode !== null) return r();
    hub.once("exit", r);
    hub.kill();
  });
const db = new pg.Pool({ connectionString: DB, max: 2 });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await db.end().catch(() => {});
  await stopHub();
  await mock.close();
  fs.rmSync(LEGAL, { recursive: true, force: true });
};
process.on("exit", () => hub?.kill());

// ----- helpers -----
async function call(p, { key, method = "GET", json, jar, headers = {} } = {}) {
  const r = await fetch(HUB + p, {
    method: json !== undefined && method === "GET" ? "POST" : method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar?.cookie ? { Cookie: jar.cookie } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  if (jar) for (const sc of r.headers.getSetCookie()) {
    const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
    jar.cookie = attrs.some((a) => /^max-age=0$/i.test(a)) ? "" : pair;
  }
  return r;
}
const ok = async (pending) => {
  const r = await pending;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body.slice(0, 300)}`);
  return body;
};
const html = async (p, want = 200) => {
  const r = await call(p);
  const body = await status(r, want, `GET ${p}`);
  return { body, r };
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const browser = () => ({ cookie: "" });
const page = (jar, p, json, extra = {}) => call(`/account/api${p}`, { jar, json, ...extra });
const claim = (key, body) => ok(call("/v1/shops/claim", { key, json: body }));
const linkToken = (kind) => [...hubLog.matchAll(new RegExp(`/account/${kind}\\?t=([A-Za-z0-9_-]+)`, "g"))].at(-1)?.[1];
const acceptances = async (email) =>
  (await db.query(`SELECT t.version, t.via, t.shop_id, t.checkout_id FROM terms_acceptances t JOIN accounts a ON a.id = t.account_id WHERE a.email = $1 ORDER BY t.created_at, t.id`, [email])).rows;
const accountRow = async (email) => (await db.query(`SELECT terms_version, terms_at FROM accounts WHERE email = $1`, [email])).rows[0];

try {
  // ----- 1. The version in force by default, the pages, the markdown and its escaping. -----
  await startHub(ENV);
  assert.match(hubLog, new RegExp(`terms: version ${OLD} in force`), "the hub says which version is in force");
  const cur = await ok(call("/v1/terms/current"));
  assert.deepEqual(cur, { version: OLD, draft: false, terms: `/terms/${OLD}`, privacy: `/privacy/${OLD}`, versions: [OLD] }, "the newest published version; a newer draft doesn't count");

  const t1 = await html("/terms");
  const csp = t1.r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/, "no script may run on the page");
  assert.ok(!/script-src/.test(csp));
  const b = t1.body;
  assert.match(b, new RegExp(`<p class="ver">Version ${OLD} · `), "the version is the first line");
  assert.ok(!b.includes("DRAFT, not yet in force"), "no draft banner on a published version");
  assert.ok(!/<script/i.test(b), "no script element");
  assert.ok(!/<img/i.test(b) && b.includes("&lt;img src=x onerror=alert(1)&gt;"), "an img tag in the text stays text");
  assert.ok(b.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"), "the script tag is shown as text");
  assert.ok(b.includes("&amp;amp;") && b.includes("&quot;quotes&quot;"));
  assert.ok(!/href="(javascript|data):/i.test(b), "no javascript: or data: link");
  assert.ok(b.includes("bad link (javascript:void0)") && b.includes("data link (data:text/html,hi)"), "a link that isn't allowed is shown as its text and address");
  assert.ok(b.includes("[another](javascript:alert(1))"), "and one that doesn't parse stays as it was written");
  assert.ok(b.includes(`<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">good link</a>`));
  assert.ok(b.includes(`<a href="/privacy">local one</a>`) && b.includes(`<a href="#2-lists">anchor</a>`) && b.includes(`<a href="mailto:owner@example.com">us</a>`));
  assert.ok(b.includes("<strong>Bold</strong>") && b.includes("<em>italic</em>") && b.includes("<code>&lt;code&gt;</code>"));
  assert.ok(b.includes("[OWNER: a note, not a link]"), "a bracketed note stays as it is");
  assert.ok(b.includes(`<h1 id="old-terms">Old terms</h1>`) && b.includes(`<h2 id="1-links">1. Links</h2>`) && b.includes(`<h2 id="2-lists">`));
  assert.ok(b.includes("<ul><li>one</li><li>two, which goes on over a second line<ul><li>nested &lt;b&gt;three&lt;/b&gt;</li></ul></li><li>four</li></ul>"), "a list with a wrapped item and a nested list");
  assert.ok(b.includes(`<ol start="3"><li>three</li><li>four</li></ol>`));
  assert.ok(b.includes("<blockquote><p>A quote with <strong>bold</strong>.</p></blockquote>"));
  assert.ok(b.includes("<th>Col &lt;i&gt;A&lt;/i&gt;</th>") && b.includes(`<td><a href="https://example.com/x" rel="noopener noreferrer">x</a></td>`), "a table, escaped");
  assert.ok(b.includes("<hr>"));
  assert.ok(!b.includes("Other versions"), "nothing earlier to list");
  const p1 = (await html("/privacy")).body;
  assert.ok(p1.includes("<h1 id=\"old-privacy\">Old privacy</h1>") && p1.includes(`<a href="/terms">Terms of Service</a>`));
  assert.ok((await html(`/privacy/${OLD}`)).body.includes("We keep little."));
  const ahead = (await html(`/terms/${DRAFT}`)).body;
  assert.ok(ahead.includes("DRAFT, not yet in force"), "the draft banner on a draft version");
  assert.ok(ahead.includes(`This version (${DRAFT}) isn't in force yet. The version in force now is ${OLD}`));
  assert.ok(ahead.includes("Terms of Service: StitchBench, StitchShop and StitchHub"), "the repository's draft renders");
  for (const p of ["/terms/2026-12-01-draft", "/terms/notaversion", "/terms/2026-13-01", "/privacy/2026-12-01-draft", "/terms/..%2F..%2Fpackage.json", "/terms/README"]) await html(p, 404);
  const home = (await html("/")).body;
  assert.ok(home.includes(`<a href="/terms">Terms</a>`) && home.includes(`<a href="/privacy">Privacy</a>`), "the hub's front page links both");
  // The code the hub runs (AGPL): the footer's Source code link and GET /source, the repository when nothing else is set.
  const SOURCE = "https://github.com/sitesentrix/stitchhub";
  assert.ok(home.includes(`<a href="${SOURCE}">Source code</a>`) && b.includes(`<a href="${SOURCE}">Source code</a>`), "every public page's footer links the source code");
  const toSource = await fetch(`${HUB}/source`, { redirect: "manual" });
  assert.deepEqual([toSource.status, toSource.headers.get("location")], [302, SOURCE], "GET /source redirects to the same address");
  const acctPage = (await html("/account")).body;
  assert.ok(acctPage.includes('id="termsPrompt"') && acctPage.includes('href="/terms"') && acctPage.includes('href="/privacy"'), "the account page links both and has the prompt");
  console.log("pages: ok");

  // ----- 2. Acceptance: from the program, at sign-up on the hub, in the claim answer, at Checkout. -----
  const keyA = await register("Terms Test Shop A");
  const shopA = (await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true })).shop.id;
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await ok(call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: emailA, termsVersion: OLD } }));
  assert.deepEqual(await acceptances(emailA), [{ version: OLD, via: "program", shop_id: null, checkout_id: null }]);
  assert.equal((await accountRow(emailA)).terms_version, OLD);
  const a = browser();
  await ok(page(a, "/set-password", { token: linkToken("set-password"), password: "Good-password-1" }));
  let me = await ok(page(a, "/me"));
  assert.deepEqual({ ...me.terms, acceptedAt: undefined }, { current: OLD, draft: false, accepted: OLD, acceptedAt: undefined, needsAccept: false });
  let claimA = await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  assert.deepEqual(claimA.terms, { version: OLD, draft: false, accepted: OLD }, "the claim answer names the version in force and the account's");
  assert.deepEqual(claimA.account, { email: emailA, verified: true }, "the account part is as before");

  // An account started by a program that named no version: nothing is recorded; /account asks.
  const keyN = await register("Terms Test Shop N");
  const emailN = `owner-n-${RUN}@stitchhub.test`;
  await ok(call("/v1/accounts/start", { key: keyN, json: { shopRef: "shopN", shopName: "N Repair", kind: "repair", program: "StitchBench", email: emailN } }));
  assert.deepEqual(await acceptances(emailN), []);
  assert.equal((await accountRow(emailN)).terms_version, null);
  const n = browser();
  await ok(page(n, "/set-password", { token: linkToken("set-password"), password: "Good-password-9" }));
  me = await ok(page(n, "/me"));
  assert.deepEqual([me.terms.accepted, me.terms.needsAccept], [null, true]);
  assert.deepEqual((await claim(keyN, { shopRef: "shopN", shopName: "N Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true })).terms, { version: OLD, draft: false, accepted: null });
  assert.equal((await claim(await register("Terms Test Shop Lone"), { shopRef: "lone", shopName: "Lone", kind: "repair", program: "StitchBench", sole: true })).terms.accepted, null, "a shop with no account");

  // On the hub first: the tick is needed, and a page left open over another version is told to reload.
  const emailB = `owner-b-${RUN}@stitchhub.test`;
  const bj = browser();
  await status(await page(bj, "/signup", { email: emailB, password: "Good-password-2", acceptTerms: false, termsVersion: OLD }), 400, "no tick");
  await status(await page(bj, "/signup", { email: emailB, password: "Good-password-2", acceptTerms: true, termsVersion: "2026-08-01" }), 409, "a page showing another version");
  assert.equal(await accountRow(emailB), undefined, "nothing made");
  await ok(page(bj, "/signup", { email: emailB, password: "Good-password-2", acceptTerms: true, termsVersion: OLD }));
  await ok(page(bj, "/verify", { token: linkToken("verify") }));
  assert.deepEqual(await acceptances(emailB), [{ version: OLD, via: "signup", shop_id: null, checkout_id: null }]);
  const emailC = `owner-c-${RUN}@stitchhub.test`;
  await ok(page(browser(), "/signup", { email: emailC, password: "Good-password-3", acceptTerms: true }));
  assert.equal((await accountRow(emailC)).terms_version, OLD, "a page that names no version gets the one in force");

  // Checkout while the account's version is current: no tick needed; the version goes with the session.
  await status(await page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly", termsVersion: "2026-08-01" }), 409, "Checkout from a page showing another version");
  const co1 = await ok(page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly", termsVersion: OLD }));
  const s1 = mock.sessions.get(co1.sessionId);
  assert.equal(s1.metadata.hub_terms_version, OLD, "the version is in the session's metadata");
  assert.equal(s1.subscription_data.metadata.hub_terms_version, OLD, "and the subscription's");
  assert.equal(s1.metadata.hub_shop_id, shopA);
  assert.deepEqual((await acceptances(emailA)).at(-1), { version: OLD, via: "checkout", shop_id: shopA, checkout_id: co1.sessionId });
  console.log("acceptance at sign-up, from the program and at Checkout: ok");

  // ----- 3. The owner moves TERMS_VERSION to the drafts: the banner, "We updated our terms", Checkout's tick. -----
  await stopHub();
  // Also: a hub running changed code names its own repository, and on Railway the commit it was deployed from is linked.
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  await startHub({ ...ENV, TERMS_VERSION: DRAFT, SOURCE_URL: "https://git.example.test/someone/hub/", RAILWAY_GIT_COMMIT_SHA: COMMIT });
  assert.deepEqual(await ok(call("/v1/terms/current")), { version: DRAFT, draft: true, terms: `/terms/${DRAFT}`, privacy: `/privacy/${DRAFT}`, versions: [OLD, DRAFT] });
  const t3 = (await html("/terms")).body;
  assert.ok(t3.includes(`<a href="https://git.example.test/someone/hub/tree/${COMMIT}">Source code</a>`), "the footer links SOURCE_URL at the deployed commit");
  assert.equal((await fetch(`${HUB}/source`, { redirect: "manual" })).headers.get("location"), `https://git.example.test/someone/hub/tree/${COMMIT}`);
  assert.ok(t3.includes(`<p class="ver">Version ${DRAFT} · `));
  assert.ok(t3.includes('<p class="draft" role="note"><strong>DRAFT, not yet in force.</strong>'), "the DRAFT banner");
  assert.ok(t3.includes("<blockquote><p><strong>DRAFT for review by a lawyer; not legal advice; not yet in force.</strong>"), "the draft's own banner is kept");
  assert.ok(t3.includes(`Other versions: <a href="/terms/${OLD}">${OLD}</a>`));
  assert.ok(!t3.includes("2026-12-01-draft"), "half a pair isn't listed");
  const p3 = (await html("/privacy")).body;
  assert.ok(p3.includes("DRAFT, not yet in force") && p3.includes("<table>") && p3.includes("Privacy Policy: StitchBench, StitchShop and StitchHub"));
  const old3 = (await html(`/terms/${OLD}`)).body;
  assert.ok(old3.includes(`This is an earlier version (${OLD}). The version in force now is ${DRAFT}: <a href="/terms">read it</a>.`));
  assert.ok(old3.includes(`<a href="/privacy/${OLD}">Privacy Policy</a>`), "an old version links the privacy policy of the same version");

  // Sessions outlive the restart; A and B are asked to accept the new version.
  me = await ok(page(a, "/me"));
  assert.deepEqual({ ...me.terms, acceptedAt: undefined }, { current: DRAFT, draft: true, accepted: OLD, acceptedAt: undefined, needsAccept: true });
  claimA = await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: true });
  assert.deepEqual(claimA.terms, { version: DRAFT, draft: true, accepted: OLD });

  // B accepts on /account.
  await status(await page(browser(), "/terms", { acceptTerms: true, termsVersion: DRAFT }), 401, "signed out");
  await status(await page(bj, "/terms", { acceptTerms: false, termsVersion: DRAFT }), 400, "no tick");
  await status(await page(bj, "/terms", { acceptTerms: true, termsVersion: OLD }), 409, "a page still showing the old version");
  assert.equal((await ok(page(bj, "/me"))).terms.needsAccept, true);
  const accepted = await ok(page(bj, "/terms", { acceptTerms: true, termsVersion: DRAFT }));
  assert.equal(accepted.terms.needsAccept, false);
  me = await ok(page(bj, "/me"));
  assert.deepEqual([me.terms.accepted, me.terms.needsAccept, me.account.termsVersion], [DRAFT, false, DRAFT]);
  assert.deepEqual((await acceptances(emailB)).map((x) => [x.version, x.via]), [[OLD, "signup"], [DRAFT, "account"]]);
  // N, who never accepted any, does so the same way.
  await ok(page(n, "/terms", { acceptTerms: true }));
  assert.deepEqual((await acceptances(emailN)).map((x) => [x.version, x.via]), [[DRAFT, "account"]]);

  // A subscribes another shop without accepting first: refused; with the tick: the account is current and it's recorded.
  await claim(keyA, { shopRef: "shopA2", shopName: "A Second", kind: "repair", program: "StitchBench", version: "1.7.0", sole: false });
  const codeA2 = (await ok(call("/v1/accounts/link-code", { key: keyA, json: { shopRef: "shopA2", shopName: "A Second", kind: "repair", program: "StitchBench" } }))).code;
  const shopA2 = (await ok(page(a, "/connect", { code: codeA2 }))).shop.id;
  const before = mock.sessions.size;
  const refused = await status(await page(a, `/shops/${shopA2}/checkout`, { plan: "solo", interval: "yearly", termsVersion: DRAFT }), 400, "Checkout without the tick");
  assert.match(refused, /Tick the box/);
  assert.equal(mock.sessions.size, before, "no Checkout Session was made");
  assert.equal((await accountRow(emailA)).terms_version, OLD);
  const co2 = await ok(page(a, `/shops/${shopA2}/checkout`, { plan: "solo", interval: "yearly", termsVersion: DRAFT, acceptTerms: true }));
  assert.equal(mock.sessions.get(co2.sessionId).metadata.hub_terms_version, DRAFT);
  assert.equal((await accountRow(emailA)).terms_version, DRAFT);
  assert.deepEqual((await acceptances(emailA)).map((x) => [x.version, x.via, x.shop_id, x.checkout_id]), [
    [OLD, "program", null, null],
    [OLD, "checkout", shopA, co1.sessionId],
    [DRAFT, "checkout", shopA2, co2.sessionId],
  ]);
  me = await ok(page(a, "/me"));
  assert.equal(me.terms.needsAccept, false, "the Checkout tick counts as accepting");
  // Current now: the next Checkout needs no tick, and is still recorded.
  const co3 = await ok(page(a, `/shops/${shopA}/checkout`, { plan: "solo", interval: "monthly" }));
  assert.deepEqual((await acceptances(emailA)).at(-1), { version: DRAFT, via: "checkout", shop_id: shopA, checkout_id: co3.sessionId });
  assert.deepEqual((await claim(keyA, { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.7.0", sole: false })).terms.accepted, DRAFT);
  console.log("updated terms, re-accept and Checkout's tick: ok");

  // The export carries every acceptance.
  const gz = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  const rows = zlib.gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const exported = rows.filter((r) => r.t === "terms_acceptance");
  assert.ok(exported.some((r) => r.via === "checkout" && r.shop_id === shopA2 && r.checkout_id === co2.sessionId && r.version === DRAFT));
  assert.ok(exported.some((r) => r.via === "account" && r.version === DRAFT));
  console.log("export: ok");

  // ----- 4. A TERMS_VERSION with no files: the newest published version, and the log says why. -----
  await stopHub();
  await startHub({ ...ENV, TERMS_VERSION: "2027-01-01" });
  assert.match(hubLog, /TERMS_VERSION=2027-01-01 has no terms-2027-01-01\.md/);
  assert.equal((await ok(call("/v1/terms/current"))).version, OLD);
  me = await ok(page(bj, "/me"));
  assert.deepEqual([me.terms.current, me.terms.accepted, me.terms.needsAccept], [OLD, DRAFT, false], "an account ahead of the version in force isn't asked");
  console.log("TERMS_VERSION without files: ok");

  // Clean up: accounts go, test installs are blocked.
  const list = await ok(call("/v1/admin/accounts", { key: ADMIN }));
  const mine = list.accounts.filter((x) => [emailA, emailB, emailC, emailN].includes(x.email)).map((x) => x.id);
  assert.equal(mine.length, 4);
  for (const id of mine) await ok(call(`/v1/admin/accounts/${id}`, { key: ADMIN, method: "DELETE" }));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM terms_acceptances WHERE account_id = ANY($1)`, [mine])).rows[0].n, 0, "an account's acceptances go with it");
  const installs = (await ok(call("/v1/admin/summary", { key: ADMIN }))).installs;
  for (const i of installs.filter((x) => /^Terms Test /.test(x.name) && !x.blocked)) await ok(call(`/v1/admin/installs/${i.id}/block`, { key: ADMIN, json: { blocked: true } }));
  assert.ok(!/sk_test_termsmock|whsec_termstest/.test(hubLog), "the hub's log holds no Stripe key or webhook secret");
  console.log("all terms checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  await stop();
}
