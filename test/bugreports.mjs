// Checks bug reports filed as GitHub issues (src/bugreports.mjs, and kind "bug" in src/feedback.mjs): the public
// POST /v1/bug-report (no key) for the open-source programs, with a mock of the GitHub API standing in for GitHub; the
// token sent, the repository each program goes to, the labels, what typed text can and can't do inside the issue
// (code fences only, no mentions), the limit per address, the bot trap, GitHub failing, a hub with no token; and the
// install-key route, where StitchBench sends kind "bug", gets the issue's address back and the admin page links to it,
// while the shop's name and reply address stay on the hub. Starts a hub of its own on a scratch database it creates and
// drops (127.0.0.1:5433, stitchbench/stitchbench; or DATABASE_URL to use one you made).
// usage: node test/bugreports.mjs
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const ADMIN = "bugreports-test-admin-token-0123456789";
const JOIN = "join-bugreports-test";
const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_bugs_${Date.now().toString(36)}`;
const DB = process.env.DATABASE_URL || `${BASE}/${dbName}`;
const admin0 = new pg.Client({ connectionString: `${BASE}/postgres` });
if (!process.env.DATABASE_URL) {
  await admin0.connect();
  await admin0.query(`CREATE DATABASE ${dbName}`);
}

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));

// ----- a mock of GitHub's "create an issue" -----
const filed = [];
let githubStatus = 201;
const github = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(req.url);
    if (req.method !== "POST" || !m) return res.writeHead(404).end();
    if (githubStatus !== 201) return res.writeHead(githubStatus, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "secret detail" }));
    const issue = { repo: m[1], auth: req.headers.authorization, ...JSON.parse(body) };
    filed.push(issue);
    res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ number: filed.length, html_url: `https://github.com/${m[1]}/issues/${filed.length}` }));
  });
});
await new Promise((r) => github.listen(0, "127.0.0.1", r));
const githubUrl = `http://127.0.0.1:${github.address().port}`;

let hub = null;
let hubLog = "";
async function startHub(env = {}) {
  if (hub && hub.proc.exitCode === null) await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  hubLog = "";
  const port = await freePort();
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", TRUST_PROXY: "", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Bug Test Hub", HUB_URL: "https://hub.example.test", HUB_LICENSE_KID: "", HUB_LICENSE_KEY: "", MAIL_DEV_LOG: "true", SMTP_URL: "", FEEDBACK_EMAIL: "", GITHUB_API_URL: githubUrl, GITHUB_ISSUES_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub = { proc, url: `http://127.0.0.1:${port}` };
  proc.stdout.on("data", (d) => (hubLog += d));
  proc.stderr.on("data", (d) => (hubLog += d));
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the hub stopped:\n${hubLog}`);
    if (await fetch(`${hub.url}/health`).then((r) => r.ok, () => false)) return;
    if (i > 300) throw new Error(`the hub didn't start:\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stop = async () => {
  if (hub && hub.proc.exitCode === null) await new Promise((r) => (hub.proc.once("exit", r), hub.proc.kill()));
  github.close();
  if (!process.env.DATABASE_URL) {
    await admin0.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin0.end().catch(() => {});
  }
};
process.on("exit", () => hub?.proc.kill());

const call = (p, { key, json, shop, headers = {} } = {}) =>
  fetch(hub.url + p, {
    method: json !== undefined ? "POST" : "GET",
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(shop ? { "X-Shop-Ref": shop } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const refused = async (r, status, re, what) => {
  const body = await r.text();
  assert.equal(r.status, status, `${what}: ${r.status} ${body}`);
  if (re) assert.match(JSON.parse(body).error ?? body, re, what);
};

try {
  // ----- a hub with no token says so, and files nothing -----
  await startHub();
  await refused(await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "It crashed" } }), 503, /aren't switched on/, "no token");
  assert.equal(filed.length, 0);
  console.log("no token: ok");

  // ----- the public route -----
  await startHub({ GITHUB_ISSUES_TOKEN: "ghp_test_token" });
  const evil = "Crash @octocat\n```\nclose me ![x](http://evil.test/p.png) [click](http://evil.test)\n`````\n@everyone";
  const a = await ok(await call("/v1/bug-report", { json: { program: "StitchFoundry", version: "0.3.1", title: "Satin   column\ncrashes", what: evil, steps: "1. Draw\n2. Satin", system: "macOS 15 | arm64", log: "thread main panicked" } }));
  assert.equal(a.ok, true);
  assert.equal(a.url, "https://github.com/Stitchwright/StitchFoundry/issues/1");
  const i1 = filed[0];
  assert.equal(i1.repo, "Stitchwright/StitchFoundry");
  assert.equal(i1.auth, "Bearer ghp_test_token", "the token is the hub's, sent to GitHub only");
  assert.equal(i1.title, "[StitchFoundry] Satin column crashes", "one line, program first");
  assert.deepEqual(i1.labels, ["bug", "from-app"]);
  assert.match(i1.body, /untrusted text typed by that person/);
  assert.match(i1.body, /### Steps to reproduce\n`{3}text\n1\. Draw/);
  assert.match(i1.body, /Program: StitchFoundry 0\.3\.1\. Source: bug report form\./);
  // The text is inside a fence longer than the longest run of backticks typed, so it can't close it.
  const fenceOpen = /### What happened\n(`+)text\n/.exec(i1.body);
  assert.ok(fenceOpen && fenceOpen[1].length >= 6, "the fence is longer than the five backticks typed");
  assert.ok(i1.body.includes(`\n${fenceOpen[1]}\n`), "and it is closed with the same length");
  assert.ok(i1.body.indexOf("@everyone") > i1.body.indexOf(fenceOpen[0]) && i1.body.indexOf("@everyone") < i1.body.lastIndexOf(fenceOpen[1]), "the mention is inside the fence");

  const b = await ok(await call("/v1/bug-report", { json: { program: "lightfoundry", what: "Frame goes the wrong way" } }));
  assert.equal(b.url, "https://github.com/Stitchwright/lightfoundry/issues/2");
  assert.equal(filed[1].title, "[LightFoundry] Frame goes the wrong way", "the title comes from the text when none is sent");

  githubStatus = 500;
  await refused(await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "x y z" } }), 502, /GitHub didn't take the report/, "GitHub failing");
  githubStatus = 201;
  const failBody = await (await call("/v1/bug-report", { json: { program: "nope", what: "x" } })).json().catch(() => ({}));
  assert.match(failBody.error ?? "", /program is/, "an unknown program");
  await refused(await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "   " } }), 400, /what happened/, "empty text");
  // Five from this address in the hour; the sixth waits (the refused ones counted too).
  await refused(await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "again" } }), 429, /Too many/, "the limit per address");
  assert.equal(filed.length, 2, "nothing was filed by the refused or failed ones");
  console.log("public route: ok");

  // ----- the bot trap, and a body that is too large -----
  await startHub({ GITHUB_ISSUES_TOKEN: "ghp_test_token" });
  const trap = await ok(await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "buy now", website: "http://spam.test" } }));
  assert.equal(trap.ok, true);
  assert.equal(filed.length, 2, "a filled-in trap field files nothing");
  const big = await call("/v1/bug-report", { json: { program: "stitchfoundry", what: "x".repeat(20_000) } });
  assert.equal(big.status, 413, "over 16 KB is refused");
  const page = await call("/report-a-bug");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>Report a bug<\/h1>/);
  assert.match(html, /href="\/report-a-bug">Report a bug<\/a>/, "the footer links to the page");
  console.log("bot trap, size and page: ok");

  // ----- StitchBench's route, under the install key -----
  const key = (await ok(await call("/v1/register", { json: { joinKey: JOIN, name: "Install X" } }))).installKey;
  await ok(await call("/v1/shops/claim", { key, shop: "s1", json: { shopRef: "s1", shopName: "Thimble Quilts", kind: "retail", program: "StitchBench", version: "1.8.0", sole: false } }));
  const ctx = { program: "StitchBench", version: "1.8.0", path: "/jobs", role: "OWNER", desktop: true, userAgent: "Mozilla/5.0 test", screen: "1366x768" };
  const before = filed.length;
  const help = await ok(await call("/v1/feedback", { key, shop: "s1", json: { kind: "help", text: "Not a bug report", context: ctx } }));
  assert.equal(help.issueUrl, undefined);
  assert.equal(filed.length, before, "help is not filed on GitHub");
  const bug = await ok(await call("/v1/feedback", { key, shop: "s1", json: { kind: "bug", text: "Invoice total is wrong", steps: "Add a part, apply a discount", replyTo: "denise@example.test", context: ctx } }));
  assert.equal(bug.issueUrl, `https://github.com/Stitchwright/stitchbench/issues/${before + 1}`);
  const i = filed[before];
  assert.equal(i.title, "[StitchBench] Invoice total is wrong");
  assert.match(i.body, /Add a part, apply a discount/);
  assert.match(i.body, new RegExp(`hub item ${bug.id}`));
  assert.ok(!/Thimble Quilts|denise@example\.test/.test(i.body), "the shop's name and reply address stay on the hub");
  const items = (await ok(await call("/v1/admin/feedback?kind=bug", { key: ADMIN }))).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].githubUrl, bug.issueUrl, "the admin page links to the issue");
  assert.equal(items[0].shopName, "Thimble Quilts");
  console.log("install route: ok");

  console.log("bug reports: all ok");
} finally {
  await stop();
}
