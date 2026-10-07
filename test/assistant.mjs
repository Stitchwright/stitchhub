// Checks the Assistant proxy (src/assistant.mjs; StitchBench docs/plans/ai-assistant-scope.md 2.2): the 300-call month
// in the company's own time zone and its roll-over, the admin's top-up, free plate reads without the module, refusals
// (no key, a key for another company, without the module, ended, lapsed), one call at a time per company, refunds when
// the model never answered, model classes, and that the Anthropic key never leaves the hub (no response, no log line,
// no stored row) and no prompt text is stored. Starts hubs of its own on a scratch database it creates and drops
// (127.0.0.1:5433, stitchbench/stitchbench; or DATABASE_URL to use one you made) with the Anthropic mock.
// usage: node test/assistant.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { startAnthropicMock } from "./anthropic-mock.mjs";
import { encodeLicense } from "../src/license.mjs";
import { zoneDay, costMillicents } from "../src/assistant.mjs";

const ADMIN = "assistant-test-admin-token";
const JOIN = "join-assistant-test";
const ROOT = path.resolve(import.meta.dirname, "..");
const ANTHROPIC_KEY = "sk-ant-test-SECRETSECRET123456";
const SENTINEL = "SENTINEL-TICKET-TEXT-8472";

// ----- a scratch database -----
const BASE = "postgresql://stitchbench:stitchbench@127.0.0.1:5433";
const dbName = `hub_assistant_${Date.now().toString(36)}`;
const DB = process.env.DATABASE_URL || `${BASE}/${dbName}`;
const admin0 = new pg.Client({ connectionString: `${BASE}/postgres` });
if (!process.env.DATABASE_URL) {
  await admin0.connect();
  await admin0.query(`CREATE DATABASE ${dbName}`);
}
const db = new pg.Pool({ connectionString: DB, max: 2 });

const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const mock = await startAnthropicMock({ port: 0, key: ANTHROPIC_KEY });
let hub = null;
let hubLog = "";
async function startHub(env = {}) {
  const port = await freePort();
  hubLog = "";
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: DB,
      ADMIN_TOKEN: ADMIN,
      JOIN_KEY: JOIN,
      PORT: String(port),
      LINK_CHECKER: "off",
      TRUST_PROXY: "",
      RAILWAY_ENVIRONMENT_ID: "",
      HUB_NAME: "Assistant Test Hub",
      HUB_LICENSE_KID: "",
      HUB_LICENSE_KEY: "",
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      ANTHROPIC_API_BASE: mock.url,
      ASSISTANT_PUBLIC_KEYS: JSON.stringify({ t1: PUB_X }),
      ASSISTANT_MONTHLY_CALLS: "5",
      ASSISTANT_TOPUP_CALLS: "5",
      ASSISTANT_FREE_READS: "3",
      ASSISTANT_FREE_READS_PER_INSTALL: "5",
      ASSISTANT_FREE_DAILY: "7",
      ASSISTANT_TEST_CLOCK: "true",
      ...env,
    },
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
const stopHub = () =>
  new Promise((r) => {
    if (!hub || hub.proc.exitCode !== null) return r();
    hub.proc.once("exit", r);
    hub.proc.kill();
  });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await stopHub();
  await mock.close();
  await db.end().catch(() => {});
  if (!process.env.DATABASE_URL) {
    await admin0.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin0.end().catch(() => {});
  }
};
process.on("exit", () => hub?.proc.kill());

// ----- a signing key of the test's own (the owner's k1 in real life) -----
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PUB_X = publicKey.export({ format: "jwk" }).x;
const keyFor = (shopId, { modules = ["base", "assistant"], f = "2026-09-01", u = "2027-09-30", g = 14, kid = "t1", signWith = privateKey } = {}) =>
  encodeLicense({ v: 1, k: kid, id: crypto.randomBytes(5).toString("hex").toUpperCase(), s: shopId, n: "Test Shop", m: modules, p: "m", f, u, g, t: "2026-09-01T00:00:00Z" }, signWith);

// ----- helpers -----
const call = (p, { key, json, method, headers = {} } = {}) =>
  fetch(hub.url + p, {
    method: method ?? (json !== undefined ? "POST" : "GET"),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
const ok = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const register = async (name) => (await ok(await call("/v1/register", { json: { joinKey: JOIN, name } }))).installKey;
const installId = async (name) => (await db.query(`SELECT id FROM installs WHERE name = $1`, [name])).rows[0].id;
const NOW = "2026-10-15T18:00:00Z";
const ask = (installKey, o) =>
  call("/v1/assistant", {
    key: installKey,
    headers: { "x-test-now": o.now ?? NOW },
    json: { shopRef: o.shopRef, tz: o.tz ?? "America/Chicago", feature: o.feature ?? "draft_work_done", model: o.model ?? "draft", system: o.system ?? "You write for a sewing shop.", messages: o.messages ?? [{ role: "user", content: o.text ?? `Tidy this: ${SENTINEL}` }], maxTokens: o.maxTokens ?? 300, key: o.key, image: o.image },
  });
const refused = async (r, status, re, what) => {
  const body = await r.text();
  assert.equal(r.status, status, `${what}: ${r.status} ${body}`);
  assert.match(JSON.parse(body).error ?? body, re, what);
};
const usageRow = async (inst, shopRef, month) => (await db.query(`SELECT * FROM assistant_usage WHERE install_id = $1 AND shop_ref = $2 AND month = $3`, [inst, shopRef, month])).rows[0];

try {
  // ----- the pure parts -----
  assert.equal(zoneDay(new Date("2026-11-01T06:30:00Z"), "America/Los_Angeles"), "2026-10-31", "Los Angeles is still in October at 06:30Z on 1 Nov");
  assert.equal(zoneDay(new Date("2026-11-01T09:30:00Z"), "America/Los_Angeles"), "2026-11-01");
  assert.equal(zoneDay(new Date("2026-11-01T06:30:00Z"), "Pacific/Auckland"), "2026-11-01");
  assert.equal(zoneDay(new Date(), "Not/AZone"), null);
  assert.equal(costMillicents("claude-sonnet-5-5", { input: 900, cacheRead: 900, output: 250 }), 180 + 18 + 250, "0.45 c for a draft with a cached system prompt");
  assert.equal(costMillicents("claude-haiku-4-5-20251001", { input: 2000, output: 80 }), 200 + 40, "0.24 c for a plate read");
  assert.equal(costMillicents("claude-opus-5-5", { input: 12000, output: 400 }), 4800 + 800, "5.6 c for a manuals question");
  console.log("pure parts: ok");

  // ----- a hub with no Anthropic key refuses plainly -----
  await startHub({ ANTHROPIC_API_KEY: "" });
  const keyless = await register("Keyless Member");
  await refused(await ask(keyless, { shopRef: "shopK" }), 503, /isn't set up/, "no key on the hub");
  await stopHub();

  // ----- the real hub -----
  await startHub();
  const keyA = await register("Shop A Install");
  const keyB = await register("Shop B Install");
  const idA = await installId("Shop A Install");
  const idB = await installId("Shop B Install");
  const SA = "shopa0000000000000000001"; // company ids as the program sends them (the key's `s`)
  const SB = "shopb0000000000000000001";
  const A = keyFor(SA);

  // Without a key or a comp: only plate reads, 3 a month here.
  await refused(await ask(keyA, { shopRef: SA }), 402, /isn't turned on/, "a draft without the module");
  await refused(await ask(keyA, { shopRef: SA, key: "not a key" }), 402, /isn't turned on/, "a junk key");
  const png = { mediaType: "image/jpeg", data: Buffer.from("not really a photo").toString("base64") };
  const plate = (o = {}) => ask(keyA, { shopRef: SA, feature: "read_plate", model: "read", text: "Read the plate.", image: png, ...o });
  // A free read is for a company that claimed itself on this install, on the read model, with a photo and a short prompt.
  await refused(await plate(), 404, /hasn't told the hub/, "a free read for a company the install never claimed");
  const claim = async (installKey, shopRef) => ok(await call("/v1/shops/claim", { key: installKey, json: { shopRef, shopName: `Shop ${shopRef}`, kind: "repair", program: "StitchBench", version: "1.6.1", sole: false } }));
  await claim(keyA, SA);
  await refused(await plate({ model: "manuals", image: undefined }), 400, /free plate read is the read model/, "a free read on the manuals model");
  await refused(await plate({ image: undefined }), 400, /free plate read is the read model/, "a free read without a photo");
  await refused(await plate({ text: "x".repeat(5000) }), 400, /free plate read is the read model/, "a free read with a long text");
  await refused(await plate({ system: "y".repeat(5000) }), 400, /free plate read is the read model/, "a free read with long instructions");
  assert.equal(mock.requests.length, 0, "none of those reached the model");
  for (let i = 1; i <= 3; i++) {
    const r = await ok(await plate());
    assert.equal(r.free, true, "free read");
    assert.equal(r.freeReads, i);
    assert.equal(r.model, "claude-haiku-4-5-20251001", "the read class is Haiku");
  }
  await refused(await plate(), 402, /free plate reads/, "the 4th free read");
  const lastReq = mock.requests.at(-1);
  assert.equal(lastReq.hasImage, true, "the photo reached the model as an image block");
  assert.equal(lastReq.headers["x-api-key"], ANTHROPIC_KEY, "the hub called with its own key");
  assert.equal(mock.requests.length, 3, "the refused 4th made no model call");
  await refused(await ask(keyA, { shopRef: SA, feature: "draft_work_done", image: png }), 400, /plate, bolt-label and swatch readers/, "a photo on another feature");
  await refused(await ask(keyA, { shopRef: SA, model: "turbo" }), 400, /model must be/, "an unknown model class");
  await refused(await ask(keyA, { shopRef: SA, tz: "Mars/Base" }), 400, /time zone/, "a bad zone");
  // The install's ceiling (5 here) counts all its companies together; then the hub's daily one (7 here) counts every install.
  const SA3 = "shopa0000000000000000003";
  await claim(keyA, SA3);
  for (let i = 0; i < 2; i++) assert.equal((await ok(await plate({ shopRef: SA3 }))).free, true);
  await refused(await plate({ shopRef: SA3 }), 402, /This install's companies have used this month's 5 free plate reads/, "the install's 6th free read");
  await claim(keyB, SB);
  for (let i = 0; i < 2; i++) assert.equal((await ok(await ask(keyB, { shopRef: SB, feature: "read_plate", model: "read", text: "Read the plate.", image: png }))).free, true);
  await refused(await ask(keyB, { shopRef: SB, feature: "read_plate", model: "read", text: "Read the plate.", image: png }), 503, /paused on this hub for today/, "the hub's 8th free read today");
  console.log("free reads: ok (claimed company, read model with a photo, the install's and the hub's ceilings)");

  // Keys that don't count.
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SB) }), 402, /isn't turned on/, "another company's key");
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SA, { modules: ["base", "vac"] }) }), 402, /isn't turned on/, "a key without the Assistant");
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SA, { signWith: crypto.generateKeyPairSync("ed25519").privateKey }) }), 402, /isn't turned on/, "a key signed by a stranger");
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SA, { kid: "zz" }) }), 402, /isn't turned on/, "an unknown kid");
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SA, { f: "2026-11-01" }) }), 402, /isn't turned on/, "a key that hasn't started");
  await refused(await ask(keyA, { shopRef: SA, key: keyFor(SA, { u: "2026-09-30", g: 14 }), now: "2026-10-20T18:00:00Z" }), 402, /ended/, "a key ended past its grace (lapsed)");
  const tampered = A.replace(/^(SB1\.)([^.]+)/, (_m, a, b) => a + Buffer.from(Buffer.from(b, "base64url").toString().replace("Test Shop", "Test Shap")).toString("base64url"));
  await refused(await ask(keyA, { shopRef: SA, key: tampered }), 402, /isn't turned on/, "a changed payload");
  const grace = await ok(await ask(keyA, { shopRef: SA, key: keyFor(SA, { u: "2026-10-10", g: 14 }) }));
  assert.equal(grace.free, false, "inside the grace days the key still works");
  assert.equal(grace.calls, 1);

  // The month's 5 calls, with the paid key.
  mock.requests.length = 0;
  for (let i = 2; i <= 5; i++) {
    const r = await ok(await ask(keyA, { shopRef: SA, key: A, system: "Voice: warm and short.", text: `Draft ${i}` }));
    assert.equal(r.calls, i);
    assert.equal(r.limit, 5);
    assert.equal(r.free, false);
    assert.equal(r.model, "claude-sonnet-5-5", "draft is Sonnet 5.5");
    assert.match(r.text, /MOCK ANSWER/);
    assert.ok(r.costMillicents > 0 && r.usage.output > 0);
  }
  assert.ok(mock.requests.every((r) => r.systemCached), "the hub marks the system block for caching");
  assert.ok(mock.requests.at(-1).messages.length === 1);
  await refused(await ask(keyA, { shopRef: SA, key: A }), 402, /used this month's 5 Assistant calls/, "the 6th call");
  // A key belongs to the company that first used it: the same key copied to another install (or another company) counts for nobody else.
  await refused(await ask(keyB, { shopRef: SA, key: A }), 402, /isn't turned on/, "the company's key copied to another install");
  assert.equal((await db.query(`SELECT install_id, shop_ref FROM assistant_key_binds`)).rows.every((b) => b.install_id === idA && b.shop_ref === SA), true, "only install A's company holds a key");
  const mockCount = mock.requests.length;
  // The other company on the same install has its own 5; another install its own.
  const A2 = keyFor("shopa0000000000000000002");
  assert.equal((await ok(await ask(keyA, { shopRef: "shopa0000000000000000002", key: A2 }))).calls, 1, "a second company on the install counts on its own");
  assert.equal((await ok(await ask(keyB, { shopRef: SB, key: keyFor(SB) }))).calls, 1, "another install counts on its own");
  assert.equal((await ok(await ask(keyA, { shopRef: SA, feature: "ask_manuals", model: "manuals", key: A, now: "2026-11-02T18:00:00Z" }))).model, "claude-opus-5-5", "the manuals class is Opus 5.5 (in November's fresh month)");

  // A top-up of 5 for this month: the admin's.
  await ok(await call("/v1/admin/assistant/topup", { key: ADMIN, json: { installId: idA, shopRef: SA }, headers: { "x-test-now": NOW } }));
  assert.equal((await usageRow(idA, SA, "2026-10")).bonus, 5);
  const afterTop = await ok(await ask(keyA, { shopRef: SA, key: A }));
  assert.equal(afterTop.calls, 6);
  assert.equal(afterTop.limit, 10);
  assert.equal(afterTop.topUps, 1);
  assert.ok(mock.requests.length > mockCount);
  await refused(await call("/v1/admin/assistant/topup", { key: "wrong", json: { installId: idA, shopRef: SA } }), 401, /admin token/, "top-up needs the admin token");
  await refused(await call("/v1/admin/assistant/topup", { key: ADMIN, json: { installId: idA, shopRef: SA, calls: 0 } }), 400, /whole number/, "bad top-up");

  // The month turns in the company's own zone (the same instant is two different months).
  const edge = "2026-11-01T06:30:00Z"; // Oct 31 23:30 in Los Angeles, Nov 1 19:30 in Auckland
  const SLA = "shopla000000000000000001";
  const SNZ = "shopnz000000000000000001";
  const LA = keyFor(SLA);
  const NZ = keyFor(SNZ);
  for (let i = 1; i <= 5; i++) {
    await ok(await ask(keyB, { shopRef: SLA, tz: "America/Los_Angeles", key: LA, now: "2026-10-31T20:00:00Z" }));
    await ok(await ask(keyB, { shopRef: SNZ, tz: "Pacific/Auckland", key: NZ, now: "2026-10-31T10:00:00Z" })); // Oct 31 23:00 NZ
  }
  await refused(await ask(keyB, { shopRef: SLA, tz: "America/Los_Angeles", key: LA, now: edge }), 402, /used this month's/, "Los Angeles is still in October at the edge");
  await refused(await ask(keyB, { shopRef: SNZ, tz: "Pacific/Auckland", key: NZ, now: "2026-10-31T10:30:00Z" }), 402, /used this month's/, "Auckland, before its November");
  const nz = await ok(await ask(keyB, { shopRef: SNZ, tz: "Pacific/Auckland", key: NZ, now: edge }));
  assert.equal(nz.month, "2026-11");
  assert.equal(nz.calls, 1, "Auckland has turned over to a fresh month");
  const la = await ok(await ask(keyB, { shopRef: SLA, tz: "America/Los_Angeles", key: LA, now: "2026-11-01T09:30:00Z" }));
  assert.equal(la.month, "2026-11");
  assert.equal(la.calls, 1, "Los Angeles turned over later, in its own zone");
  assert.equal((await usageRow(idB, SLA, "2026-10")).calls, 5, "October's count is kept");

  // The usage read: what the program's Settings page shows.
  const u = await ok(await call(`/v1/assistant/usage?shopRef=${SA}&tz=America%2FChicago`, { key: keyA, headers: { "x-test-now": NOW, "x-assistant-key": A } }));
  assert.deepEqual([u.entitled, u.calls, u.limit, u.available], [true, 6, 10, true]);
  const u2 = await ok(await call(`/v1/assistant/usage?shopRef=${SA}&tz=America%2FChicago`, { key: keyA, headers: { "x-test-now": NOW } }));
  assert.equal(u2.entitled, false);
  assert.equal(u2.freeReadsLimit, 3);
  assert.equal((await call(`/v1/assistant/usage?shopRef=${SA}`)).status, 401, "no install key, no answer");

  // The admin's comp: the Assistant without a key until a day.
  const SC = "shopc0000000000000000001";
  await ok(await call("/v1/admin/assistant/comp", { key: ADMIN, json: { installId: idB, shopRef: SC, until: "2026-12-31", note: "friend" } }));
  assert.equal((await ok(await ask(keyB, { shopRef: SC }))).free, false, "comped company needs no key");
  await refused(await ask(keyB, { shopRef: SC, now: "2027-01-02T18:00:00Z" }), 402, /isn't turned on/, "after the comp");

  // One call at a time per company.
  await fetch(`${mock.url}/__next`, { method: "POST", body: JSON.stringify({ text: "slow answer", delayMs: 900 }) });
  const SD = "shopd0000000000000000001";
  const DK = keyFor(SD);
  const first = ask(keyB, { shopRef: SD, key: DK });
  await new Promise((r) => setTimeout(r, 250));
  await refused(await ask(keyB, { shopRef: SD, key: DK }), 429, /still answering/, "a second call while one runs");
  assert.equal((await first).status, 200);
  assert.equal((await ok(await ask(keyB, { shopRef: SD, key: DK }))).calls, 2, "after the first answered, the next one goes");

  // A model that fails: not counted, and no text leaks.
  const before = (await usageRow(idB, SD, "2026-10")).calls;
  await fetch(`${mock.url}/__next`, { method: "POST", body: JSON.stringify({ status: 500, body: { type: "error", error: { type: "api_error", message: `boom ${ANTHROPIC_KEY}` } } }) });
  await fetch(`${mock.url}/__next`, { method: "POST", body: JSON.stringify({ status: 500 }) });
  const failed = await ask(keyB, { shopRef: SD, key: DK });
  const failedText = await failed.text();
  assert.equal(failed.status, 502, failedText);
  assert.ok(!failedText.includes(ANTHROPIC_KEY) && !failedText.includes("boom"), "upstream's words don't reach the program");
  assert.equal((await usageRow(idB, SD, "2026-10")).calls, before, "a call the model never answered is given back");
  // One retry covers a single blip.
  await fetch(`${mock.url}/__next`, { method: "POST", body: JSON.stringify({ status: 529 }) });
  assert.equal((await ask(keyB, { shopRef: SD, key: DK })).status, 200, "one 5xx is retried");

  // Input checks.
  const big = await call("/v1/assistant", { key: keyB, json: { shopRef: SD, feature: "draft_work_done", model: "draft", messages: [{ role: "user", content: "x".repeat(300_000) }] } });
  assert.equal(big.status, 413, "over 256 KB");
  await refused(await call("/v1/assistant", { key: keyB, json: { shopRef: SD, feature: "draft_work_done", model: "draft", messages: [{ role: "assistant", content: "hi" }] } }), 400, /last message/, "last message must be the user's");
  assert.equal((await call("/v1/assistant", { json: { shopRef: SD } })).status, 401, "no install key");

  // The Anthropic key never left the hub; no text was stored; only counts and cost.
  assert.ok(!hubLog.includes(ANTHROPIC_KEY), "the hub's log never shows the Anthropic key");
  const allText = JSON.stringify([(await db.query(`SELECT * FROM assistant_calls`)).rows, (await db.query(`SELECT * FROM assistant_usage`)).rows, (await db.query(`SELECT * FROM assistant_shops`)).rows]);
  assert.ok(!allText.includes(SENTINEL), "no prompt text is kept");
  assert.ok(!allText.includes(ANTHROPIC_KEY));
  assert.ok(!allText.includes("MOCK ANSWER"), "no answer text is kept");
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assistant_calls'`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols.sort(), ["cache_tokens", "class", "cost_millicents", "created_at", "error", "feature", "free", "id", "input_tokens", "install_id", "model", "ms", "output_tokens", "shop_ref"]);
  const logged = (await db.query(`SELECT count(*)::int n, sum(cost_millicents)::int c, count(*) FILTER (WHERE error IS NOT NULL)::int e FROM assistant_calls`)).rows[0];
  assert.ok(logged.n > 20 && logged.c > 0 && logged.e >= 1, `calls are logged with tokens and cost (${JSON.stringify(logged)})`);
  assert.ok(mock.requests.every((r) => r.headers["x-api-key"] === ANTHROPIC_KEY));
  const adminView = await ok(await call("/v1/admin/assistant/usage?month=2026-10", { key: ADMIN }));
  assert.ok(adminView.rows.length >= 4 && adminView.rows[0].cost_millicents > 0, "the owner's usage list");
  // The admin page's Assistant section (public/admin.html): the usage list with limit, top-ups and comp, the recent errors,
  // and every Assistant call the page makes is a route this hub answers (so a renamed route can't break the page quietly).
  const usageNow = await ok(await call("/v1/admin/assistant/usage?month=2026-10", { key: ADMIN, headers: { "x-test-now": NOW } }));
  assert.equal(usageNow.month, "2026-10");
  assert.equal(usageNow.topUpCalls, 5);
  const rowA = usageNow.rows.find((r) => r.shop_ref === SA);
  assert.deepEqual([rowA.calls, rowA.bonus, rowA.limit, rowA.comped], [6, 5, 10, false], "limit = the month's calls plus top-ups; not comped");
  assert.ok(rowA.cost_millicents > 0 && rowA.install_name, "cost and the member's name");
  const rowC = usageNow.rows.find((r) => r.shop_ref === SC);
  assert.equal(rowC.comped, true, "a comped company is listed even with no calls this month");
  assert.equal(rowC.comp_until, "2026-12-31");
  assert.equal(rowC.comp_note, "friend");
  const lateRow = (await ok(await call("/v1/admin/assistant/usage?month=2026-10", { key: ADMIN, headers: { "x-test-now": "2027-01-02T18:00:00Z" } }))).rows.find((r) => r.shop_ref === SC);
  assert.equal(lateRow.comped, false, "after its last day the comp shows off");
  const thisMonthRows = await ok(await call("/v1/admin/assistant/usage", { key: ADMIN, headers: { "x-test-now": NOW } }));
  assert.equal(thisMonthRows.month, "2026-10", "no month = the current one");
  await refused(await call("/v1/admin/assistant/usage?month=October", { key: ADMIN }), 400, /YYYY-MM/, "a bad month");
  await refused(await call("/v1/admin/assistant/usage", { key: "wrong" }), 401, /admin token/, "usage needs the admin token");
  const errs = await ok(await call("/v1/admin/assistant/errors?limit=10", { key: ADMIN }));
  assert.ok(errs.rows.length >= 1 && errs.rows.every((r) => r.error && r.feature && r.install_name), "failed calls with what and for whom");
  assert.ok(!JSON.stringify(errs).includes(SENTINEL) && !JSON.stringify(errs).includes(ANTHROPIC_KEY), "no text and no key in the error list");
  assert.ok(errs.rows.length <= 10);
  await refused(await call("/v1/admin/assistant/errors", { key: "wrong" }), 401, /admin token/, "errors need the admin token");
  const html = await (await call("/admin")).text();
  const used = new Set([...html.matchAll(/(?:api|post)\("(\/assistant\/[a-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["/assistant/comp", "/assistant/errors", "/assistant/topup", "/assistant/usage"], "the page calls exactly these");
  for (const id of ["assistantSection", "aShops", "aErrors", "aMonth", "aForm"]) assert.ok(html.includes(`id="${id}"`), `${id} is on the page`);
  console.log("assistant admin page: ok");
  const exportBody = Buffer.from(await (await call("/v1/admin/export", { key: ADMIN })).arrayBuffer());
  assert.ok(!(await import("node:zlib")).gunzipSync(exportBody).toString().includes(ANTHROPIC_KEY), "the export never holds the Anthropic key");
  console.log("assistant proxy: ok");
} catch (e) {
  console.error(e);
  console.error("hub log tail:\n" + hubLog.split("\n").filter((l) => /assistant|listening/.test(l)).slice(-15).join("\n"));
  process.exitCode = 1;
} finally {
  await stop();
}
