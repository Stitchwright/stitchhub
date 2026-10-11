// Checks accounts end to end: starts a hub of its own on a free port against a scratch database, with a small SMTP
// sink in this process standing in for the mailbox, and walks the three ways in (from the program, a link code, on the
// hub first), sign in, forgot and reset, claim and standing, the admin's comp, the tenant rule (one account never sees
// another's shops), the export, and the limits (the emails to set a password among them: per address, for the whole hub,
// and the shop's name in them kept to one plain line).
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/accounts.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "accounts-test-admin-token";
const JOIN = "join-accounts-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");

// ----- a mailbox: takes any message over plain SMTP and keeps it -----
const mails = [];
let setPasswordMails = 0; // every "Set your ... password" email the hub sent
let woken = () => {};
const decodeWord = (s) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b) => Buffer.from(b, "base64").toString("utf8"));
function keep(to, raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
  const text = headers["content-transfer-encoding"] === "base64" ? Buffer.from(rest.join("\r\n\r\n").replace(/\s/g, ""), "base64").toString("utf8") : rest.join("\r\n\r\n");
  mails.push({ to, subject: decodeWord(headers.subject ?? ""), from: headers.from, text, link: /https?:\/\/\S+/.exec(text)?.[0] ?? null });
  if (/^Set your .+ password$/.test(mails.at(-1).subject)) setPasswordMails++;
  woken();
}
const sink = net.createServer((sock) => {
  sock.write("220 sink ready\r\n");
  let buf = "";
  let inData = false;
  let msg = { to: null, raw: "" };
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          keep(msg.to, msg.raw);
          msg = { to: null, raw: "" };
          sock.write("250 queued\r\n");
        } else msg.raw += `${line}\r\n`;
        continue;
      }
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "EHLO") sock.write("250-sink\r\n250 AUTH PLAIN\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "RCPT") {
        msg.to = /<([^>]+)>/.exec(line)?.[1] ?? null;
        sock.write("250 ok\r\n");
      } else if (cmd === "DATA") {
        inData = true;
        sock.write("354 go ahead\r\n");
      } else if (cmd === "QUIT") {
        sock.write("221 bye\r\n");
        sock.end();
      } else sock.write("250 ok\r\n");
    }
  });
  sock.on("error", () => {});
});
/** The next message to `to`, waiting up to 5 seconds for it. */
async function mailTo(to) {
  for (let waited = 0; waited < 5000; waited += 50) {
    const i = mails.findIndex((m) => m.to === to);
    if (i >= 0) return mails.splice(i, 1)[0];
    await new Promise((r) => {
      woken = r;
      setTimeout(r, 50);
    });
  }
  throw new Error(`no email reached ${to}`);
}
const tokenOf = (m) => new URL(m.link).searchParams.get("t");

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const sinkPort = await freePort();
await new Promise((r) => sink.listen(sinkPort, "127.0.0.1", r));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;

// ----- the hub under test -----
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATABASE_URL: DB,
    ADMIN_TOKEN: ADMIN,
    JOIN_KEY: JOIN,
    PORT: String(port),
    LINK_CHECKER: "off",
    TRUST_PROXY: "true", // the limits per address see the test's addresses in X-Forwarded-For (none sent: 127.0.0.1)
    RAILWAY_ENVIRONMENT_ID: "",
    HUB_URL: HUB,
    SMTP_URL: `smtp://sink:not-a-secret@127.0.0.1:${sinkPort}`,
    MAIL_FROM: "hub@stitchhub.test",
    MAIL_DEV_LOG: "",
    HUB_NAME: "Accounts Test Hub",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
hub.stdout.on("data", (d) => (hubLog += d));
hub.stderr.on("data", (d) => (hubLog += d));
const stop = () => {
  hub.kill();
  sink.close();
};
process.on("exit", stop);
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
  await new Promise((r) => setTimeout(r, 200));
}
// A scratch database that was used before keeps the join key the admin page saved then (it wins over JOIN_KEY), so set ours.
await fetch(`${HUB}/v1/admin/join-key`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: JOIN }) }).then((r) => { if (!r.ok) throw new Error(`could not set the join key: ${r.status}`); });

// ----- helpers: an install's calls, and a browser's (a cookie jar each) -----
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
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const status = async (r, want, what) => {
  const body = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${body}`);
  return body ? JSON.parse(body) : {};
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const browser = () => ({ cookie: "" });
const page = (jar, p, json, extra = {}) => call(`/account/api${p}`, { jar, json, ...extra });
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

try {
  // The pages are served.
  for (const p of ["/account", "/account/shops", "/account/set-password", "/admin"]) assert.equal((await call(p)).status, 200, p);

  // A shop claims itself: a row and a 30-day trial, no account yet. Standing is the same answer without the claim.
  const keyA = await register("Accounts Test Shop A");
  const claimA = await ok(await call("/v1/shops/claim", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", version: "1.6.1", sole: true } }));
  assert.equal(claimA.ok, true);
  assert.equal(claimA.listings, 0);
  assert.equal(claimA.account, null);
  assert.deepEqual([claimA.standing, claimA.lastDay, claimA.key, claimA.revokeKeyIds], ["trial", plusDays(30), null, []]);
  assert.deepEqual([claimA.shop.name, claimA.shop.kind, claimA.shop.program, claimA.shop.version], ["A Repair", "repair", "StitchBench", "1.6.1"]);
  const standingA = await ok(await call("/v1/shops/shopA/standing", { key: keyA }));
  assert.equal(standingA.shop.id, claimA.shop.id);
  assert.equal(standingA.standing, "trial");
  assert.equal((await call("/v1/shops/never/standing", { key: keyA })).status, 404);
  // Claimed again with only the ref (an older program): the name stays, the shop is the same.
  const again = await ok(await call("/v1/shops/claim", { key: keyA, json: { shopRef: "shopA" } }));
  assert.equal(again.shop.id, claimA.shop.id);
  assert.equal(again.shop.name, "A Repair");
  console.log("claim and standing: ok");

  // Door 1: the program starts the account; the owner sets a password from the email.
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await status(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", email: "not an email" } }), 400, "bad email");
  const started = await ok(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", kind: "repair", program: "StitchBench", email: emailA.toUpperCase(), termsVersion: "2026-10-02" } }));
  assert.deepEqual(started.account, { email: emailA, verified: false });
  assert.equal(started.installKey, undefined, "an install with a key doesn't get another");
  const m1 = await mailTo(emailA);
  assert.match(m1.subject, /Set your Accounts Test Hub password/);
  assert.match(m1.from, /hub@stitchhub\.test/);
  assert.ok(m1.link.startsWith(`${HUB}/account/set-password?t=`), m1.link);
  assert.ok(m1.text.includes('A shop named "A Repair" (StitchBench) asked for a Accounts Test Hub account for'), m1.text);
  // A sign-up on that address (a stranger's, say) never puts its password on the account the program started: the owner
  // is mailed the set-password link instead, and the answer is the one a new account gets.
  const stranger = browser();
  assert.deepEqual(await ok(await page(stranger, "/signup", { email: emailA, password: "Stranger-password-1", acceptTerms: true })), { ok: true });
  const mS = await mailTo(emailA);
  assert.match(mS.subject, /Set your Accounts Test Hub password/);
  assert.equal(stranger.cookie, "", "no session for the stranger");
  assert.deepEqual((await ok(await call("/v1/shops/shopA/standing", { key: keyA }))).account, { email: emailA, verified: false });
  // Sent again before the owner acted: another email, the first link is cancelled.
  await ok(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", email: emailA } }));
  const m2 = await mailTo(emailA);
  assert.notEqual(tokenOf(m2), tokenOf(m1));
  const a = browser();
  await status(await page(a, "/set-password", { token: tokenOf(m1), password: "Good-password-1" }), 410, "cancelled link");
  await status(await page(a, "/set-password", { token: tokenOf(mS), password: "Good-password-1" }), 410, "the link the sign-up sent is cancelled too");
  await status(await page(a, "/set-password", { token: "nope", password: "Good-password-1" }), 404, "wrong link");
  await status(await page(a, "/set-password", { token: tokenOf(m2), password: "short" }), 400, "short password");
  await status(await page(a, "/set-password", { token: tokenOf(m2), password: "password1" }), 400, "common password");
  assert.equal(a.cookie, "", "no session before the password is set");
  await ok(await page(a, "/set-password", { token: tokenOf(m2), password: "Good-password-1" }));
  assert.match(a.cookie, /^hub_session=/);
  await status(await page(a, "/set-password", { token: tokenOf(m2), password: "Good-password-2" }), 410, "a link works once");
  let me = await ok(await page(a, "/me"));
  assert.deepEqual([me.account.email, me.account.verified, me.account.termsVersion], [emailA, true, "2026-10-02"]);
  assert.deepEqual(me.shops.map((s) => [s.name, s.installName, s.standing]), [["A Repair", "Accounts Test Shop A", "trial"]]);
  assert.deepEqual((await ok(await call("/v1/shops/shopA/standing", { key: keyA }))).account, { email: emailA, verified: true });
  // The address now has a finished account: the program is told to use a link code instead.
  await status(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA", shopName: "A Repair", email: emailA } }), 409, "start for a finished account");
  console.log("door 1 (from the program): ok");

  // Sign out, sign in wrong and right.
  await ok(await page(a, "/signout", {}));
  assert.equal(a.cookie, "");
  await status(await page(a, "/me"), 401, "signed out");
  await status(await page(a, "/signin", { email: emailA, password: "Wrong-password-1" }), 401, "wrong password");
  await status(await page(a, "/signin", { email: `nobody-${RUN}@stitchhub.test`, password: "Good-password-1" }), 401, "unknown email");
  await status(await page(a, "/signin", { email: "nope", password: "Good-password-1" }), 400, "not an email");
  await status(await page(a, "/signin", { email: emailA, password: "Good-password-1" }, { headers: { Origin: "https://evil.example" } }), 403, "cross-site");
  await ok(await page(a, "/signin", { email: emailA, password: "Good-password-1" }));
  me = await ok(await page(a, "/me"));
  assert.equal(me.account.email, emailA);
  await status(await page(browser(), "/signin", { email: emailA, password: "Stranger-password-1" }), 401, "the stranger's sign-up password was never set");
  console.log("sign in: ok");

  // Forgot: always the same answer; a link for an account that exists; the reset signs every browser out.
  const quiet = "If that address has an account, the email is on its way.";
  const b = browser();
  await ok(await page(b, "/signin", { email: emailA, password: "Good-password-1" }));
  const before = mails.length;
  assert.equal((await ok(await page(browser(), "/forgot", { email: `nobody-${RUN}@stitchhub.test` }))).message, quiet);
  assert.equal((await ok(await page(browser(), "/forgot", { email: emailA }))).message, quiet);
  const reset = await mailTo(emailA);
  assert.match(reset.subject, /Reset your Accounts Test Hub password/);
  assert.equal(mails.length, before, "no email for an address without an account");
  const c = browser();
  await ok(await page(c, "/set-password", { token: tokenOf(reset), password: "Newer-password-1" }));
  await status(await page(a, "/me"), 401, "a reset signs other browsers out");
  await status(await page(b, "/me"), 401, "a reset signs other browsers out");
  await status(await page(a, "/signin", { email: emailA, password: "Good-password-1" }), 401, "the old password is gone");
  await ok(await page(a, "/signin", { email: emailA, password: "Newer-password-1" }));
  // Changing the password while signed in keeps this browser and signs out the others.
  await status(await page(a, "/password", { current: "wrong", password: "Another-password-1" }), 401, "wrong current password");
  await ok(await page(a, "/password", { current: "Newer-password-1", password: "Another-password-1" }));
  await ok(await page(a, "/me"));
  await status(await page(c, "/me"), 401, "a password change signs other browsers out");
  console.log("forgot and reset: ok");

  // Door 2: a link code from the program, typed in by the signed-in owner.
  const keyB = await register("Accounts Test Shop B");
  const lc = await ok(await call("/v1/accounts/link-code", { key: keyB, json: { shopRef: "shopB", shopName: "B Quilts", kind: "retail", program: "StitchShop", version: "1.0.0" } }));
  assert.match(lc.code, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/, lc.code);
  await status(await page(a, "/connect", { code: "22222-33333" }), 404, "wrong code");
  await status(await page(a, "/connect", { code: "AB" }), 400, "too short");
  const connected = await ok(await page(a, "/connect", { code: lc.code.toLowerCase().replace("-", " ") }));
  assert.equal(connected.shop.name, "B Quilts");
  await status(await page(a, "/connect", { code: lc.code }), 410, "a code works once");
  me = await ok(await page(a, "/me"));
  assert.deepEqual(me.shops.map((s) => s.name), ["A Repair", "B Quilts"]);
  // The install learns it at its next sync (a claim naming the program and not `sole`: nothing re-tagged).
  const claimB = await ok(await call("/v1/shops/claim", { key: keyB, json: { shopRef: "shopB", shopName: "B Quilts", kind: "retail", program: "StitchShop", version: "1.0.1" } }));
  assert.deepEqual(claimB.account, { email: emailA, verified: true });
  assert.equal(claimB.shop.version, "1.0.1");
  await status(await call("/v1/accounts/link-code", { key: keyB, json: { shopRef: "shopB" } }), 409, "already connected");
  console.log("door 2 (link code): ok");

  // Door 3: an account made on the hub first, verified by email.
  const emailC = `owner-c-${RUN}@stitchhub.test`;
  const d = browser();
  await status(await page(d, "/signup", { email: emailC, password: "Good-password-3", acceptTerms: false }), 400, "terms not ticked");
  await status(await page(d, "/signup", { email: emailC, password: "12345678", acceptTerms: true }), 400, "common password");
  await ok(await page(d, "/signup", { email: emailC, password: "Good-password-3", acceptTerms: true }));
  const v1 = await mailTo(emailC);
  assert.ok(v1.link.startsWith(`${HUB}/account/verify?t=`), v1.link);
  await status(await page(d, "/signin", { email: emailC, password: "Good-password-3" }), 403, "not verified yet");
  assert.equal((await ok(await page(d, "/resend", { email: emailC }))).message, quiet);
  const v2 = await mailTo(emailC);
  await status(await page(d, "/verify", { token: tokenOf(v1) }), 410, "the earlier link was cancelled by the resend");
  await ok(await page(d, "/verify", { token: tokenOf(v2) }));
  me = await ok(await page(d, "/me"));
  assert.deepEqual([me.account.email, me.account.verified, me.shops], [emailC, true, []]);
  assert.equal((await ok(await page(browser(), "/resend", { email: emailC }))).message, quiet, "a verified account is answered the same and mailed nothing");
  // A sign-up on a verified account: the same answer as a new account, a link to set the password mailed, nothing changed.
  assert.deepEqual(await ok(await page(browser(), "/signup", { email: emailC, password: "Other-password-3", acceptTerms: true })), { ok: true }, "signed up twice: the same answer, so it doesn't say the address has an account");
  assert.match((await mailTo(emailC)).subject, /Reset your Accounts Test Hub password/, "the second sign-up mails a link to set the password");
  await ok(await page(browser(), "/signin", { email: emailC, password: "Good-password-3" }), "and changes no password");
  // A stranger signed up first with the owner's address: the owner's own sign-up takes the stranger's password and the
  // confirm link off the account, so the owner's click on that confirm mail can't make the stranger's password work; the
  // set-password link mailed now is the way in.
  const emailS = `owner-s-${RUN}@stitchhub.test`;
  await ok(await page(browser(), "/signup", { email: emailS, password: "Stranger-password-5", acceptTerms: true }));
  const vS = await mailTo(emailS);
  assert.deepEqual(await ok(await page(browser(), "/signup", { email: emailS, password: "Owner-password-5", acceptTerms: true })), { ok: true });
  const sS = await mailTo(emailS);
  assert.match(sS.subject, /Set your Accounts Test Hub password/);
  await status(await page(browser(), "/verify", { token: tokenOf(vS) }), 410, "the stranger's confirm link is cancelled");
  await status(await page(browser(), "/signin", { email: emailS, password: "Stranger-password-5" }), 401, "the stranger's password is gone");
  await ok(await page(browser(), "/set-password", { token: tokenOf(sS), password: "Owner-password-5" }));
  await ok(await page(browser(), "/signin", { email: emailS, password: "Owner-password-5" }));
  console.log("door 3 (on the hub first): ok");

  // Tenant: C connects a shop of its own; A never sees it, and C never sees A's.
  const lc2 = await ok(await call("/v1/accounts/link-code", { key: keyA, json: { shopRef: "shopA2", shopName: "A Second Company", program: "StitchBench" } }));
  await ok(await page(d, "/connect", { code: lc2.code }));
  assert.deepEqual((await ok(await page(d, "/me"))).shops.map((s) => s.name), ["A Second Company"]);
  assert.deepEqual((await ok(await page(a, "/me"))).shops.map((s) => s.name), ["A Repair", "B Quilts"]);
  // A shop that has an account can't be started again for another address, or connected to another account.
  await status(await call("/v1/accounts/start", { key: keyA, json: { shopRef: "shopA2", shopName: "A Second Company", email: `other-${RUN}@stitchhub.test` } }), 409, "a shop with an account");
  assert.deepEqual((await ok(await call("/v1/shops/shopA2/standing", { key: keyA }))).account, { email: emailC, verified: true });
  // Another install can't read a shop by its ref.
  await status(await call("/v1/shops/shopA/standing", { key: keyB }), 404, "another install's shop");
  console.log("tenant: ok");

  // The hub admin: accounts, shops, a comp, switching an account off, resend.
  const adminCall = (p, json, method) => call(`/v1/admin${p}`, { key: ADMIN, json, method });
  let list = await ok(await adminCall("/accounts"));
  assert.equal(list.problem, null);
  const accA = list.accounts.find((x) => x.email === emailA);
  const accC = list.accounts.find((x) => x.email === emailC);
  assert.deepEqual(accA.shops.map((s) => s.name), ["A Repair", "B Quilts"]);
  assert.deepEqual(accC.shops.map((s) => s.name), ["A Second Company"]);
  const shopA = list.shops.find((s) => s.id === claimA.shop.id);
  assert.deepEqual([shopA.installName, shopA.accountEmail, shopA.standing], ["Accounts Test Shop A", emailA, "trial"]);
  await status(await adminCall(`/shops/${shopA.id}/comp`, { until: "soon" }), 400, "bad comp date");
  await ok(await adminCall(`/shops/${shopA.id}/comp`, { until: "forever", note: "founding member" }));
  let st = await ok(await call("/v1/shops/shopA/standing", { key: keyA }));
  assert.deepEqual([st.standing, st.lastDay], ["comped", null]);
  assert.match(st.message, /compliments/);
  await ok(await adminCall(`/shops/${shopA.id}/comp`, { until: plusDays(10) }));
  st = await ok(await call("/v1/shops/shopA/standing", { key: keyA }));
  assert.deepEqual([st.standing, st.lastDay], ["comped", plusDays(10)]);
  await ok(await adminCall(`/shops/${shopA.id}/comp`, { until: "" }));
  assert.equal((await ok(await call("/v1/shops/shopA/standing", { key: keyA }))).standing, "trial");
  await status(await adminCall(`/accounts/${accC.id}/resend`, {}), 409, "resend for a verified account");
  await ok(await adminCall(`/accounts/${accC.id}/disable`, { disabled: true }));
  await status(await page(d, "/me"), 401, "switched off");
  await status(await page(d, "/signin", { email: emailC, password: "Good-password-3" }), 403, "switched off");
  await ok(await adminCall(`/accounts/${accC.id}/disable`, { disabled: false }));
  await ok(await page(d, "/signin", { email: emailC, password: "Good-password-3" }));
  console.log("admin: ok");

  // An install on no hub yet starts with an account and no key: pending until the email is confirmed, then a member.
  const emailD = `owner-d-${RUN}@stitchhub.test`;
  await status(await call("/v1/accounts/start", { json: { shopRef: "fresh", email: emailD } }), 400, "no shop name");
  const fresh = await ok(await call("/v1/accounts/start", { json: { shopRef: "fresh", shopName: "Fresh Shop", kind: "repair", program: "StitchBench", email: emailD } }));
  assert.match(fresh.installKey, /^shk_/);
  assert.equal(fresh.scope, "pending");
  assert.equal((await ok(await call("/v1/me", { key: fresh.installKey }))).scope, "pending");
  assert.equal((await call("/v1/changes?since=0", { key: fresh.installKey })).status, 403, "pending: not a member yet");
  assert.equal((await call("/v1/partners/links", { key: fresh.installKey })).status, 403);
  assert.equal((await ok(await call("/v1/shops/fresh/standing", { key: fresh.installKey }))).standing, "trial");
  const mD = await mailTo(emailD);
  const e = browser();
  await ok(await page(e, "/set-password", { token: tokenOf(mD), password: "Good-password-4" }));
  assert.equal((await ok(await call("/v1/me", { key: fresh.installKey }))).scope, "member");
  assert.equal((await call("/v1/changes?since=0", { key: fresh.installKey })).status, 200, "a member once verified");
  console.log("join by account: ok");

  // The export carries accounts, shops, tokens and sessions, with nothing in the clear.
  const gz = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  const rows = zlib.gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const acc = rows.find((r) => r.t === "account" && r.email === emailA);
  assert.ok(acc, "the account is in the export");
  assert.match(acc.password_hash, /^scrypt\$/);
  assert.ok(rows.some((r) => r.t === "shop" && r.id === claimA.shop.id));
  assert.ok(rows.some((r) => r.t === "session" && r.account_id === acc.id));
  assert.ok(rows.some((r) => r.t === "account_token" && r.account_id === acc.id));
  assert.ok(!JSON.stringify(rows).includes("Another-password-1"));
  console.log("export: ok");

  // Wrong passwords for one account stop at 10 an hour, wherever they come from, each counted before it is checked: 12 sent
  // at once get 10 "wrong" and 2 "too many". The right password still signs in (strangers can't lock the owner out);
  // other accounts sign in as before, and there is no hub-wide lock to trip.
  const burst = await Promise.all(Array.from({ length: 12 }, () => page(browser(), "/signin", { email: emailC, password: "Wrong-password-8" })));
  assert.deepEqual(burst.map((r) => r.status).sort((x, y) => x - y), [...Array(10).fill(401), 429, 429], "guesses sent at once are all counted");
  assert.match((await status(await page(browser(), "/signin", { email: emailC, password: "Wrong-password-8" }), 429, "a wrong 13th try")).error, /for this account/);
  await ok(await page(browser(), "/signin", { email: emailC, password: "Good-password-3" }), "the right password past the limit");
  await ok(await page(browser(), "/signin", { email: emailD, password: "Good-password-4" }));

  // Limits: wrong sign-ins from one address stop at 20 an hour.
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await page(browser(), "/signin", { email: emailA, password: "Wrong-password-9" })).status === 429;
  assert.ok(limited, "wrong sign-ins were not limited");
  console.log("limits: ok");

  // The email to set a password goes to whatever address a program types, under whatever shop name it sends: the name
  // is one plain line in it, and the emails are limited per address (3 a day) and for the whole hub (100 an hour). Each
  // start here comes from an address of its own, in X-Forwarded-For.
  let sender = 0;
  const from = (n) => ({ "X-Forwarded-For": `10.4.${n >> 8}.${n & 255}` });
  const startAs = (email, shopName) => call("/v1/accounts/start", { json: { shopRef: `start-${++sender}`, shopName, kind: "repair", program: "StitchBench", email }, headers: from(sender) });
  const emailE = `owner-e-${RUN}@stitchhub.test`;
  await ok(await startAs(emailE, `Evil\r\nBcc: victim@example.test\n<a href="http://evil.example/x">Click</a>\u2028www.evil.example call now ${"x".repeat(200)}`));
  const mE = await mailTo(emailE);
  assert.equal(mE.subject, "Set your Accounts Test Hub password");
  const named = /^A shop named "([^"\n]*)" \(StitchBench\) asked for a Accounts Test Hub account for /m.exec(mE.text);
  assert.ok(named, `the shop's name sits in quotes on the email's own line: ${mE.text}`);
  assert.ok(named[1].startsWith("Evil Bcc victim example. test a href http //evil. example") && named[1].length <= 60, named[1]);
  assert.ok(!/[<>@:"\r\n\u2028]|\.\p{L}/u.test(named[1]), `no markup, link, address or line of its own: ${named[1]}`);
  assert.equal(mE.text.split("\n").filter((l) => /Bcc|Click/.test(l)).length, 1, "the name added no line to the email");
  await ok(await startAs(emailE, "E Repair"));
  await mailTo(emailE);
  await ok(await startAs(emailE, "E Repair"));
  await mailTo(emailE);
  const fourth = await startAs(emailE, "E Repair");
  assert.equal(fourth.status, 429, "a fourth email to set a password to one address in a day");
  assert.match((await fourth.json()).error, /already sent 3 emails to set a password to that address today/);
  assert.equal((await startAs(emailE.replace("@", "+again@"), "E Repair")).status, 429, "the same mailbox with a +tag");
  assert.equal((await ok(await page(browser(), "/resend", { email: emailE }, { headers: from(++sender) }))).message, quiet, "Resend answers as always");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!mails.some((m) => m.to === emailE || m.to === "victim@example.test"), "and sends no fourth email");
  // The whole hub: 100 an hour, whoever they go to (the log says so once).
  let hubFull = null;
  for (let i = 0; i < 150 && !hubFull; i++) {
    const r = await startAs(`many-${i}-${RUN}@stitchhub.test`, `Many ${i}`);
    if (r.status === 429) hubFull = (await r.json()).error;
    else await ok(r);
  }
  assert.match(hubFull ?? "", /has sent a lot of account emails in the last hour/);
  assert.equal(setPasswordMails, 100, "100 emails to set a password in the hour, all told");
  assert.match(hubLog, /100 set-password emails this hour/);
  console.log("set-password emails: ok (the name one plain line, 3 a day per address, 100 an hour for the hub)");

  // Clean up: the accounts go (their shops stay); the test installs are blocked.
  for (const id of [accA.id, accC.id]) await ok(await adminCall(`/accounts/${id}`, undefined, "DELETE"));
  list = await ok(await adminCall("/accounts"));
  await ok(await adminCall(`/accounts/${list.accounts.find((x) => x.email === emailD).id}`, undefined, "DELETE"));
  assert.equal((await ok(await call("/v1/shops/shopA/standing", { key: keyA }))).account, null, "a deleted account leaves its shops with none");
  const installs = (await ok(await call("/v1/admin/summary", { key: ADMIN }))).installs;
  for (const name of ["Accounts Test Shop A", "Accounts Test Shop B", "Fresh Shop"]) {
    for (const i of installs.filter((x) => x.name === name && !x.blocked)) await ok(await adminCall(`/installs/${i.id}/block`, { blocked: true }));
  }
  assert.equal((await call("/v1/me", { key: keyA })).status, 403);
  assert.ok(!/\bshk_|not-a-secret/.test(hubLog), "the hub's log holds no keys or the mail password");
  console.log("all account checks passed");
} catch (e) {
  console.error(e);
  console.error("--- hub log ---\n" + hubLog);
  process.exitCode = 1;
} finally {
  stop();
}
