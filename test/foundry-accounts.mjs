// Foundry Account sign-in on the hub (docs/plan.md, hub FA-1 and FA-2), against the stand-in service (test/foundry-mock.mjs) with real hubs
// started on a scratch database, once with FOUNDRY_SIGNIN=only and once with "on":
//   only:  a sign-up with no password; the emailed link confirms the address AND links a Foundry Account, once, and a wrong Foundry
//          password doesn't spend it; the hub password, set-password, verify-and-sign-in and change-password are closed; a Foundry sign-in
//          finds its account by the id (an unlinked Foundry Account, even with the owner's email, gets nothing); one Foundry Account links
//          to one hub account; a lost Foundry Account is replaced through an emailed link and not otherwise; "forgot my Foundry password";
//          the service being down; the limits; the hub keeps no Foundry session
//   on:    the hub password still works; a Foundry Account links with the old password or the signed-in session (the old password
//          counts in the same limits), and the retire script takes the hub password of linked accounts only
//   both:  the export carries foundry_id
// usage: DATABASE_URL=postgresql://... (a scratch database) node test/foundry-accounts.mjs
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { startFoundryMock } from "./foundry-mock.mjs";

const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = process.env.ADMIN_TOKEN ?? "foundry-test-admin-token";
const JOIN = "join-foundry-test";
const RUN = Date.now().toString(36);
const ROOT = path.resolve(import.meta.dirname, "..");
const FPASS = "fire truck 1";
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startFoundryMock({ port: 0, firstId: 5_000_000 + Math.floor(Math.random() * 1_000_000) });
const seeded = async (email, password = FPASS) => (await (await fetch(`${mock.url}/__seed`, { method: "POST", body: JSON.stringify({ email, password }) })).json()).id;

/** A hub of its own on a scratch database; mail is printed to its log (MAIL_DEV_LOG), where the test reads the links. */
async function startHub(mode, foundryUrl = mock.url) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", TRUST_PROXY: "true",
      RAILWAY_ENVIRONMENT_ID: "", HUB_URL: url, SMTP_URL: "", MAIL_FROM: "hub@stitchhub.test", MAIL_DEV_LOG: "true", HUB_NAME: "Foundry Test Hub",
      FOUNDRY_SIGNIN: mode, FOUNDRY_CLOUD_URL: foundryUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hub = { url, proc, log: "" };
  proc.stdout.on("data", (d) => (hub.log += d));
  proc.stderr.on("data", (d) => (hub.log += d));
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hub.log}`);
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) break;
    if (i > 300) throw new Error(`the hub didn't start:\n${hub.log}`);
    await sleep(200);
  }
  // A scratch database used before keeps the join key the admin page saved then, so set ours.
  await fetch(`${url}/v1/admin/join-key`, { method: "PUT", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: JOIN }) });
  hub.stop = async () => { proc.kill(); await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r))); };
  hub.call = async (p, { json, jar, headers = {} } = {}) => {
    const r = await fetch(url + p, {
      method: json !== undefined ? "POST" : "GET",
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar?.cookie ? { Cookie: jar.cookie } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    if (jar) for (const sc of r.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
      jar.cookie = attrs.some((a) => /^max-age=0$/i.test(a)) ? "" : pair;
    }
    return r;
  };
  hub.api = (p, json, o = {}) => hub.call(`/account/api${p}`, { json, ...o });
  hub.admin = async (p) => (await fetch(`${url}/v1/admin${p}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  /** The link in the next email to `to` (the hub prints each to its log), waiting up to 5 seconds. */
  hub.mail = async (to, from = 0) => {
    for (let i = 0; i < 100; i++) {
      const re = new RegExp(`mail \\(not sent, MAIL_DEV_LOG\\): to ${to.replace(/[.+]/g, "\\$&")}\\nsubject: ([^\\n]*)\\n([\\s\\S]*?)(?=\\nmail \\(not sent|$)`, "g");
      const all = [...hub.log.matchAll(re)];
      if (all.length > from) { const m = all[all.length - 1]; return { subject: m[1], text: m[2], link: /https?:\/\/\S+/.exec(m[2])?.[0] ?? null, count: all.length }; }
      await sleep(50);
    }
    throw new Error(`no email reached ${to}:\n${hub.log.slice(-1500)}`);
  };
  return hub;
}
const status = async (r, want, what) => {
  const text = await r.text();
  assert.equal(r.status, want, `${what}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
};
const tokenOf = (m) => new URL(m.link).searchParams.get("t");
const browser = () => ({ cookie: "" });
let steps = 0;
const ok = (what) => { steps += 1; console.log(`  ok  ${what}`); };
const accountOf = async (hub, email) => (await hub.admin("/accounts")).accounts.find((a) => a.email === email);
const foundryLink = (hub, jar, body) => hub.api("/foundry/link", body, { jar });

let hub;
try {
  // ================= only =================
  hub = await startHub("only");
  assert.deepEqual(await status(await hub.api("/mode"), 200, "mode"), { foundry: "only" });

  // A sign-up with no password: the emailed link confirms the address and links a Foundry Account.
  const emailA = `owner-a-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailA, password: "ignored-password-1", acceptTerms: true }), 200, "sign-up");
  const mA = await hub.mail(emailA);
  assert.match(mA.subject, /Confirm your email for Foundry Test Hub/);
  assert.match(mA.text, /link your Foundry Account/i);
  assert.ok(mA.link.startsWith(`${hub.url}/account/verify?t=`), mA.link);
  let acctA = await accountOf(hub, emailA);
  assert.deepEqual([acctA.hasPassword, acctA.foundryLinked, acctA.verified], [false, false, false], "no password kept, even the one sent");
  // The old ways in are closed.
  await status(await hub.api("/signin", { email: emailA, password: "ignored-password-1" }), 403, "hub password sign-in");
  await status(await hub.api("/verify", { token: tokenOf(mA) }), 403, "verify-and-sign-in");
  await status(await hub.api("/set-password", { token: tokenOf(mA), password: "Another-password-1" }), 403, "set a password");
  const stray = browser();
  await status(await hub.api("/password", { current: "x", password: "Another-password-1" }, { jar: stray }), 403, "change password");

  // Linking with the emailed link: a wrong Foundry password doesn't spend it; the right one links, confirms, and signs in.
  const A = browser();
  await status(await foundryLink(hub, A, { proof: "token", token: tokenOf(mA), foundryEmail: "denise@example.com", foundryPassword: FPASS }), 401, "no such Foundry Account");
  assert.equal(A.cookie, "", "not signed in by a refusal");
  await status(await foundryLink(hub, A, { proof: "token", token: "x".repeat(40), foundryEmail: "denise@example.com", foundryPassword: FPASS, create: true }), 404, "a link that isn't one");
  await status(await foundryLink(hub, A, { proof: "token", token: tokenOf(mA), foundryEmail: "denise@example.com", foundryPassword: "short", create: true }), 400, "a short Foundry password for a new account");
  await status(await foundryLink(hub, A, { proof: "token", token: tokenOf(mA), foundryEmail: "denise@example.com", foundryPassword: FPASS, create: true }), 200, "link by the emailed link");
  assert.match(A.cookie, /^hub_session=/);
  const meA = await status(await hub.api("/me", undefined, { jar: A }), 200, "me");
  assert.deepEqual([meA.account.foundry, meA.account.foundryMode, meA.account.verified], [true, "only", true]);
  acctA = await accountOf(hub, emailA);
  assert.deepEqual([acctA.foundryLinked, acctA.verified], [true, true]);
  await status(await foundryLink(hub, browser(), { proof: "token", token: tokenOf(mA), foundryEmail: "denise@example.com", foundryPassword: FPASS }), 410, "the link works once");
  assert.equal((await (await fetch(`${mock.url}/__sessions`)).json()).open, 0, "the hub left no Foundry session open: it keeps no token");
  ok("only: a sign-up with no password; the emailed link confirms and links once; the hub password, set-password, verify and change-password are closed; no Foundry session kept");

  // Signing in with the Foundry Account: found by the id.
  await status(await hub.api("/signout", {}, { jar: A }), 200, "sign out");
  const A2 = browser();
  await status(await hub.api("/foundry/signin", { email: " Denise@Example.com ", password: FPASS }, { jar: A2 }), 200, "Foundry sign-in");
  assert.equal((await status(await hub.api("/me", undefined, { jar: A2 }), 200, "me")).account.email, emailA);
  await status(await hub.api("/foundry/signin", { email: "denise@example.com", password: "wrong one" }, { jar: browser() }), 401, "wrong Foundry password");
  // A Foundry Account made with the owner's own address is not the owner: the id decides.
  await seeded(emailA);
  const takeover = browser();
  const nothing = await status(await hub.api("/foundry/signin", { email: emailA, password: FPASS }, { jar: takeover }), 403, "a Foundry Account that merely has the owner's email");
  assert.match(nothing.error, /isn't linked/);
  assert.equal(takeover.cookie, "");
  ok("a Foundry sign-in finds its account by the id; a wrong password and a Foundry Account made with the owner's email get nothing");

  // One Foundry Account, one hub account; and a lost one is replaced only through an emailed link.
  const emailB = `owner-b-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailB, acceptTerms: true }), 200, "second sign-up");
  const mB = await hub.mail(emailB);
  await status(await foundryLink(hub, browser(), { proof: "token", token: tokenOf(mB), foundryEmail: "denise@example.com", foundryPassword: FPASS }), 409, "the same Foundry Account for a second hub account");
  assert.equal((await accountOf(hub, emailB)).foundryLinked, false);
  await status(await foundryLink(hub, A2, { proof: "session", foundryEmail: "pat@example.com", foundryPassword: FPASS, create: true }), 409, "a different Foundry Account from a session alone");
  await hub.api("/forgot", { email: emailA });
  const mRecover = await hub.mail(emailA, 1);
  assert.match(mRecover.subject, /Link your Foundry Account to Foundry Test Hub/);
  const R = browser();
  await status(await foundryLink(hub, R, { proof: "token", token: tokenOf(mRecover), foundryEmail: "pat@example.com", foundryPassword: FPASS, create: true }), 200, "replace the lost Foundry Account by an emailed link");
  await status(await hub.api("/foundry/signin", { email: "pat@example.com", password: FPASS }, { jar: browser() }), 200, "the new one signs in");
  await status(await hub.api("/foundry/signin", { email: "denise@example.com", password: FPASS }, { jar: browser() }), 403, "the lost one no longer does");
  ok("one Foundry Account links to one hub account; replacing one needs an emailed link, not a session");

  // Two uses of one emailed link at the same moment: exactly one links (the link is taken under its own update, with the write).
  const emailF = `owner-f-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailF, acceptTerms: true }), 200, "sign-up F");
  const tokenF = tokenOf(await hub.mail(emailF));
  const race = await Promise.all(["fay@example.com", "gail@example.com"].map((e) => foundryLink(hub, browser(), { proof: "token", token: tokenF, foundryEmail: e, foundryPassword: FPASS, create: true })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 410], "one link, one use: the other is told it was used");
  assert.equal((await accountOf(hub, emailF)).foundryLinked, true);

  // The Foundry Account's own forgot-password, the service being down, and the limits.
  const quiet = await status(await hub.api("/foundry/forgot", { email: "pat@example.com" }), 200, "foundry forgot");
  const quiet2 = await status(await hub.api("/foundry/forgot", { email: "nobody@example.com" }), 200, "foundry forgot, unknown");
  assert.equal(quiet.message, quiet2.message, "the same answer whether or not there is a Foundry Account");
  assert.deepEqual((await (await fetch(`${mock.url}/__sent`)).json()).map((s) => s.to), ["pat@example.com"]);
  const dead = await startFoundryMock({ port: 0 });
  const deadUrl = dead.url;
  await dead.close();
  await hub.stop();
  hub = await startHub("only", deadUrl);
  await status(await hub.api("/foundry/signin", { email: "pat@example.com", password: FPASS }, { jar: browser() }), 503, "the service is down");
  await hub.stop();
  hub = await startHub("only");
  const xff = { "X-Forwarded-For": "203.0.113.77" };
  for (let i = 0; i < 20; i++) await hub.api("/foundry/signin", { email: `nobody${i}@example.com`, password: "wrong wrong" }, { headers: xff });
  await status(await hub.api("/foundry/signin", { email: "pat@example.com", password: FPASS }, { headers: xff }), 429, "this address has used its wrong tries");
  await status(await hub.api("/foundry/signin", { email: "pat@example.com", password: FPASS }, { headers: { "X-Forwarded-For": "203.0.113.78" }, jar: browser() }), 200, "another address is not held back");
  ok("the Foundry Account's own forgot-password answers the same either way; the service being down says so; the wrong-try limit holds per address");

  // The export carries the link.
  const exp = zlib.gunzipSync(Buffer.from(await (await fetch(`${hub.url}/v1/admin/export`, { headers: { Authorization: `Bearer ${ADMIN}` } })).arrayBuffer())).toString("utf8");
  assert.ok(exp.split("\n").some((l) => l.includes(emailA) && /"foundry_id":\d+/.test(l)), "the export has foundry_id on the account");
  ok("the export carries each account's foundry_id");
  await hub.stop();

  // ================= on =================
  hub = await startHub("on");
  assert.deepEqual(await status(await hub.api("/mode"), 200, "mode"), { foundry: "on" });
  const emailC = `owner-c-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailC, password: "Correct-horse-1", acceptTerms: true }), 200, "sign-up with a password");
  const mC = await hub.mail(emailC);
  assert.match(mC.subject, /Confirm your email/);
  const C = browser();
  await status(await hub.api("/verify", { token: tokenOf(mC) }, { jar: C }), 200, "verify signs in (on)");
  await status(await hub.api("/signin", { email: emailC, password: "Correct-horse-1" }, { jar: browser() }), 200, "the hub password still works");
  // Link with the old password as the proof: wrong first, then right.
  await status(await foundryLink(hub, browser(), { proof: "password", email: emailC, password: "wrong password", foundryEmail: "carol@example.com", foundryPassword: FPASS, create: true }), 401, "wrong old password");
  const L = browser();
  await status(await foundryLink(hub, L, { proof: "password", email: emailC, password: "Correct-horse-1", foundryEmail: "carol@example.com", foundryPassword: FPASS, create: true }), 200, "link with the old password");
  assert.deepEqual([(await accountOf(hub, emailC)).foundryLinked, (await accountOf(hub, emailC)).hasPassword], [true, true]);
  // An account whose email isn't confirmed can't use its password as proof.
  const emailD = `owner-d-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailD, password: "Correct-horse-2", acceptTerms: true }), 200, "unconfirmed sign-up");
  await status(await foundryLink(hub, browser(), { proof: "password", email: emailD, password: "Correct-horse-2", foundryEmail: "dave@example.com", foundryPassword: FPASS, create: true }), 403, "an unconfirmed account's password is no proof");
  // The signed-in session as the proof.
  const emailE = `owner-e-${RUN}@stitchhub.test`;
  await status(await hub.api("/signup", { email: emailE, password: "Correct-horse-3", acceptTerms: true }), 200, "sign-up E");
  const E = browser();
  await status(await hub.api("/verify", { token: tokenOf(await hub.mail(emailE)) }, { jar: E }), 200, "verify E");
  await status(await foundryLink(hub, browser(), { proof: "session", foundryEmail: "erin@example.com", foundryPassword: FPASS, create: true }), 401, "no session, no proof");
  await status(await foundryLink(hub, E, { proof: "session", foundryEmail: "erin@example.com", foundryPassword: FPASS, create: true }), 200, "link from the signed-in session");
  ok("on: the hub password still works; a Foundry Account links with the old password (limited like a sign-in; an unconfirmed account's is no proof) or the signed-in session");

  // The retire script: refuses unless only; takes the hub password of linked accounts only.
  const env = { ...process.env, DATABASE_URL: DB };
  const refused = spawnSync(process.execPath, ["scripts/retire-passwords.mjs"], { cwd: ROOT, env: { ...env, FOUNDRY_SIGNIN: "on" }, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /FOUNDRY_SIGNIN=only/);
  const dry = spawnSync(process.execPath, ["scripts/retire-passwords.mjs"], { cwd: ROOT, env: { ...env, FOUNDRY_SIGNIN: "only" }, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run/);
  assert.equal((await accountOf(hub, emailC)).hasPassword, true, "a dry run changes nothing");
  const done = spawnSync(process.execPath, ["scripts/retire-passwords.mjs", "--apply"], { cwd: ROOT, env: { ...env, FOUNDRY_SIGNIN: "only" }, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Retired the hub password of \d+/);
  assert.match(done.stdout, new RegExp(emailD.replace(/[.+]/g, "\\$&")), "an account with no Foundry Account yet is listed as waiting");
  assert.equal((await accountOf(hub, emailC)).hasPassword, false, "a linked account's password is gone");
  assert.equal((await accountOf(hub, emailD)).hasPassword, true, "an unlinked account keeps its password");
  await status(await hub.api("/signin", { email: emailC, password: "Correct-horse-1" }, { jar: browser() }), 401, "even in on, the retired password signs nobody in");
  await status(await hub.api("/foundry/signin", { email: "carol@example.com", password: FPASS }, { jar: browser() }), 200, "the Foundry Account does");
  ok("retire: refuses unless only; a dry run changes nothing; only linked accounts lose their passwords; unlinked ones are listed");
  console.log(`\n${steps} steps passed.`);
} finally {
  await hub?.stop().catch(() => {});
  await mock.close();
}
process.exit(0);
