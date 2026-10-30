// Contract tests for contracts/ (the shared API between StitchHub, StitchBench/StitchShop and StitchFoundry):
//  1. the files agree with each other: every example passes its schema, a broken copy of each example fails it, every
//     schema keyword is one the checker supports, messages.json points at real schemas and examples;
//  2. openapi.json documents only routes that exist in this hub's code, and every schema it names exists;
//  3. the REAL hub answers match the schemas: a hub of its own on a scratch database; a listing and an order go through
//     the marketplace, and a job.new message goes through a partner link and comes back from the feed.
// A change to a response shape, a route or a schema that is not made in the contract too fails here. Bench has the
// matching test (tests/unit/contract.test.ts) against its own copy of contracts/ (version in contracts/VERSION).
// usage: DATABASE_URL=postgresql://... (a fresh scratch database) node test/contract.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { check, loadExample, loadSchema } from "../contracts/validate.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const C = path.join(ROOT, "contracts");
const names = (dir, ext = ".json") => fs.readdirSync(path.join(C, dir)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length));

// ----- 1. the files agree -----
for (const n of names("schemas")) {
  assert.ok(fs.existsSync(path.join(C, "examples", `${n}.json`)), `schema ${n} has an example`);
  assert.deepEqual(check(n, loadExample(n)), [], `the example of ${n} passes its schema`);
  const s = loadSchema(n);
  for (const r of s.required ?? []) {
    const broken = structuredClone(loadExample(n));
    delete broken[r];
    assert.ok(check(n, broken).length > 0, `${n} without "${r}" must fail`);
  }
  assert.ok(check(n, "not an object").length > 0, `${n} refuses a string`);
}
for (const n of names("examples")) assert.ok(fs.existsSync(path.join(C, "schemas", `${n}.json`)), `example ${n} has a schema`);
const messages = JSON.parse(fs.readFileSync(path.join(C, "messages.json"), "utf8")).types;
for (const [type, m] of Object.entries(messages)) {
  assert.match(type, /^[a-z]{2,20}(\.[a-z]{2,20})?$/);
  assert.ok(["repair", "retail", "either"].includes(m.from), `${type}: from`);
  assert.deepEqual(check(m.schema, loadExample(m.schema)), [], `${type} example`);
}
assert.throws(() => check({ type: "object", minProperties: 1 }, {}), /does not support/, "an unsupported keyword is not silently ignored");
assert.match(fs.readFileSync(path.join(C, "VERSION"), "utf8").trim(), /^\d+\.\d+\.\d+$/);
console.log("  ok  schemas, examples and messages.json agree; every broken example fails");

// ----- 2. the documented routes exist in this hub -----
const spec = JSON.parse(fs.readFileSync(path.join(C, "openapi.json"), "utf8"));
assert.equal(spec.info.version, fs.readFileSync(path.join(C, "VERSION"), "utf8").trim(), "openapi.json and VERSION agree");
const source = fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".mjs")).map((f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8")).join("\n");
for (const [p, ops] of Object.entries(spec.paths)) {
  const express = p.replace(/\{(\w+)\}/g, ":$1");
  assert.ok(source.includes(`"${express}"`) || source.includes(`"${express.replace(/^\/v1/, "")}"`), `route ${p} exists in the hub's code`);
  for (const [method, o] of Object.entries(ops)) {
    const text = JSON.stringify(o);
    for (const m of text.matchAll(/"\$ref":"\.\/schemas\/([\w.-]+)\.json"/g)) assert.ok(fs.existsSync(path.join(C, "schemas", `${m[1]}.json`)), `${method} ${p} names schema ${m[1]}`);
  }
}
console.log("  ok  every route openapi.json documents exists in the hub, and every schema it names exists");

// ----- 3. the real hub answers match -----
const DB = process.env.DATABASE_URL;
assert.ok(DB, "set DATABASE_URL to a scratch database");
const ADMIN = "contract-test-admin-token";
const JOIN = "join-contract-test";
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));
const port = await freePort();
const HUB = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: DB, ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Contract Test Hub", TRUST_PROXY: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
hub.stdout.on("data", (d) => (log += d));
hub.stderr.on("data", (d) => (log += d));
process.on("exit", () => hub.kill());
for (let i = 0; ; i++) {
  if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
  if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error(`the hub didn't start:\n${log}`);
  await new Promise((r) => setTimeout(r, 200));
}
const call = async (p, { key, json, form, method } = {}) => {
  const r = await fetch(HUB + p, { method: method ?? (json !== undefined || form ? "POST" : "GET"), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: form ?? (json !== undefined ? JSON.stringify(json) : undefined) });
  const body = await r.json().catch(() => ({}));
  assert.equal(r.status, 200, `${method ?? ""} ${p}: ${r.status} ${JSON.stringify(body)}`);
  return body;
};
const noErrors = (schema, value, what) => assert.deepEqual(check(schema, value), [], `${what} matches ${typeof schema === "string" ? schema : "its schema"}`);

try {
  const seller = await call("/v1/register", { json: { joinKey: JOIN, name: "Seller Install" } });
  const buyer = await call("/v1/register", { json: { joinKey: JOIN, name: "Buyer Install" } });
  const claim = { shopRef: "repair1", shopName: "Bobbin & Bolt Repairs", kind: "repair", program: "StitchBench", version: "1.0.0", sole: false };
  noErrors("shop-claim", claim, "the claim the test sends");
  await call("/v1/shops/claim", { key: seller.installKey, json: claim });
  await call("/v1/shops/claim", { key: buyer.installKey, json: { ...claim, shopRef: "retail1", shopName: "Main St Sewing", kind: "retail", program: "StitchShop" } });

  // marketplace: a listing and an order
  const form = new FormData();
  form.set("listing", JSON.stringify({ title: "Bernina hook assembly", description: "Tested", kind: "PART", condition: "USED", origin: "GENUINE", brand: "Bernina", partNumber: "HK-221", priceCents: 3500, currency: "USD", qty: 2, shippingCents: 600, shipsFrom: "Rhode Island", shopRef: "repair1", shopName: "Bobbin & Bolt Repairs" }));
  const listing = await call("/v1/listings", { key: seller.installKey, form });
  noErrors("listing", listing, "the listing the hub returns");
  const order = await call("/v1/orders", { key: buyer.installKey, json: { listingId: listing.id, qty: 1, shipTo: "12 Main St", buyerContact: { name: "Dana", email: "dana@example.test" }, shopRef: "retail1", shopName: "Main St Sewing" } });
  noErrors("order", order, "the new order");
  const accepted = await call(`/v1/orders/${order.id}/accept`, { key: seller.installKey, json: { sellerContact: { name: "Sam", email: "sam@example.test" }, payInstructions: "Zelle to sam@example.test" } });
  noErrors("order", accepted, "the accepted order");
  const shipped = await call(`/v1/orders/${order.id}/paid`, { key: seller.installKey, json: {} }).then(() => call(`/v1/orders/${order.id}/ship`, { key: seller.installKey, json: { carrier: "USPS", tracking: "9400111899223344556677" } }));
  noErrors("order", shipped, "the shipped order");
  const list = await call("/v1/orders?since=0", { key: buyer.installKey });
  assert.ok(list.orders.length >= 1);
  for (const o of list.orders) noErrors("order", o, "an order in the list");
  const changes = await call("/v1/changes?since=0", { key: buyer.installKey });
  assert.ok((changes.listings ?? []).length >= 1, "the feed carries the listing");
  for (const l of changes.listings) noErrors("listing", l, "a listing in the feed");

  // partner link and a job.new message through the feed (unsigned messages are accepted and stored unverified)
  const invite = await call("/v1/partners/invites", { key: seller.installKey, json: { shopRef: "repair1", shopName: "Bobbin & Bolt Repairs", side: "repair", terms: {} } });
  const redeemed = await call("/v1/partners/redeem", { key: buyer.installKey, json: { code: invite.code, shopRef: "retail1", shopName: "Main St Sewing" } });
  const linkId = redeemed.link.id;
  const jobNew = loadExample("job.new");
  noErrors("job.new", jobNew, "the job.new example");
  await call(`/v1/partners/links/${linkId}/messages`, { key: buyer.installKey, json: { id: "m-contract-1", shopRef: "retail1", type: "job.new", data: jobNew } });
  const feed = await call("/v1/partners/messages?since=0", { key: seller.installKey });
  const got = feed.messages.find((m) => m.id === "m-contract-1");
  assert.ok(got, "the repair shop's feed carries the job.new");
  noErrors("message-envelope", got, "the message as the feed returns it");
  assert.equal(messages[got.type].from, got.fromSide, "the sender side agrees with messages.json");
  noErrors(messages[got.type].schema, got.data, "the message data as the feed returns it");
  assert.deepEqual(got.data.id, jobNew.id, "the job id survives the trip (it is the Hub job to Bench ticket link)");
  console.log("  ok  the real hub: listing, order steps, the changes feed and a partner job.new match the schemas");
  console.log("contract: all ok");
} finally {
  hub.kill();
}
