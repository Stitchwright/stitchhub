// Checks that need the hub's own database (a scratch one: it applies the migrations and writes a few rows). No hub may
// be running on it: this check takes the writer lock a hub holds.
// usage: DATABASE_URL=postgresql://... ADMIN_TOKEN=any-16-or-more-characters node test/db.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import path from "node:path";
import { pool, tx, feedLimit, startFeeds, stopFeeds, holdsWriterLock, migrate } from "../src/db.mjs";
import { TABLES } from "../src/transfer.mjs";
import { checkLink, privateAddress } from "../src/checker.mjs";

await migrate(path.join(import.meta.dirname, "..", "migrations"));

// Every column of every table a move carries is in the export (a column added by a migration and forgotten there is
// lost in a move); only the change numbers, which are carried separately, and the migration list are left out.
const cols = (await pool.query(`SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = 'public'`)).rows;
for (const spec of TABLES) {
  const have = cols.filter((r) => r.t === spec.table).map((r) => r.c);
  assert.deepEqual(spec.cols.filter((c) => !have.includes(c)), [], `${spec.table}: exported columns the table doesn't have`);
  assert.deepEqual(have.filter((c) => !spec.cols.includes(c) && c !== "seq"), [], `${spec.table}: columns the export leaves out`);
}
const carried = new Set(TABLES.map((s) => s.table));
// Left out of the export on purpose: the migration list, and feedback (README: "Feedback is not part of the hub's export
// or a company's move"). releases is here because it was not in the export when this list was made: decide if it should be.
const NOT_EXPORTED = new Set(["hub_migrations", "feedback", "releases"]);
assert.deepEqual([...new Set(cols.map((r) => r.t))].filter((t) => !carried.has(t) && !NOT_EXPORTED.has(t)), [], "tables the export leaves out");
console.log("export columns: ok");

// A feed stops below a change number a write in progress has taken, even though nothing shows it yet.
await startFeeds();
assert.ok(holdsWriterLock(), "a hub is running on this database: stop it, or give this check a scratch database of its own");
await tx(async (c) => {
  const n = BigInt((await c.query(`SELECT nextval('change_seq') AS n`)).rows[0].n);
  assert.ok(BigInt((await feedLimit()).change) < n, "a feed passed a number that is still being written");
});
console.log("feed hold: ok");

// What a probe found is dropped when the link got another address meanwhile (a member fixed it).
const id = `chk${Date.now().toString(36)}`;
await pool.query(`INSERT INTO links (id, brand, models, model_keys, title, url) VALUES ($1, 'B', 'M1', '{M1}', 't', 'not a web address')`, [id]);
const row = () => pool.query(`SELECT status, fail_count FROM links WHERE id = $1`, [id]).then((r) => r.rows[0]);
const stale = await checkLink({ id, url: "the old address", status: "unchecked", fail_count: 0 });
assert.equal(stale.dropped, true);
assert.deepEqual(await row(), { status: "unchecked", fail_count: 0 });
const fresh = await checkLink({ id, url: "not a web address", status: "unchecked", fail_count: 0 });
assert.equal(fresh.dropped, false);
assert.deepEqual(await row(), { status: "dead", fail_count: 1 });
await pool.query(`DELETE FROM links WHERE id = $1`, [id]);
console.log("link checker: ok");

// The checker knocks only on public web servers: never on an address inside a network (the hub's own, a router, a
// NAS, Railway's private network), whether the link names it, a name resolves to it, or a redirect leads there.
for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "fc00::1", "fd12::1", "fe80::1", "64:ff9b::a00:1", "2002:a00:1::1", "ff02::1", "localhost", "", "not an address"]) {
  assert.equal(privateAddress(ip), true, `${ip} is private`);
}
for (const ip of ["8.8.8.8", "93.184.216.34", "203.0.113.7", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(privateAddress(ip), false, `${ip} is public`);
{
  // A site in this process stands in for the web. Names under .test resolve through a stand-in DNS: ok.public.test to
  // a public address, inside.test to a private one, mixed.test to one of each. A connection the checker lets through
  // (only to a public address) is sent to the site; anything that reaches it with a "via" or "direct" path the checker
  // should have refused shows up in `hits`.
  const hits = [];
  const site = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const at = (p) => `http://${p}:${port}`;
    const u = new URL(req.url, "http://x");
    const send = (status, headers = {}) => res.writeHead(status, headers).end();
    switch (u.pathname) {
      case "/ok":
        return send(200);
      case "/gone":
        return send(404);
      case "/robots":
        return send(403);
      case "/nohead":
        return req.method === "HEAD" ? send(405) : send(req.headers.range ? 206 : 200);
      case "/error":
        return send(500);
      case "/moved":
        return send(301, { Location: `${at("ok.public.test")}/ok?via=moved` });
      case "/relative":
        return send(302, { Location: "/ok?via=relative" });
      case "/to-private-ip":
        return send(302, { Location: `${at("127.0.0.1")}/ok?via=private-ip` });
      case "/to-private-name":
        return send(302, { Location: `${at("inside.test")}/ok?via=private-name` });
      case "/to-ftp":
        return send(302, { Location: "ftp://ok.public.test/file" });
      case "/loop":
        return send(302, { Location: "/loop" });
      default:
        return send(404);
    }
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const port = site.address().port;
  const fakeDns = { "ok.public.test": ["203.0.113.10"], "inside.test": ["10.0.0.5"], "mixed.test": ["203.0.113.11", "192.168.0.9"] };
  const realLookup = dns.lookup;
  const realRequest = http.request;
  dns.lookup = (host, opts, cb) => {
    if (typeof opts === "function") [cb, opts] = [opts, {}];
    const list = fakeDns[host]?.map((address) => ({ address, family: 4 }));
    if (!list) return realLookup(host, opts, cb);
    if (opts?.all) process.nextTick(cb, null, list);
    else process.nextTick(cb, null, list[0].address, 4);
  };
  http.request = (url, options, cb) => {
    const lookup = options?.lookup;
    if (!lookup) return realRequest(url, options, cb);
    const toSite = (host, o, done) =>
      lookup(host, o, (err, address) => {
        if (err) return done(err);
        if (Array.isArray(address)) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      });
    return realRequest(url, { ...options, lookup: toSite }, cb);
  };
  const probe = async (url, status = "unchecked", fails = 0) => {
    const linkId = `chk${crypto.randomBytes(6).toString("hex")}`;
    await pool.query(`INSERT INTO links (id, brand, models, model_keys, title, url) VALUES ($1, 'B', 'M1', '{M1}', 't', $2)`, [linkId, url]);
    const out = await checkLink({ id: linkId, url, status, fail_count: fails });
    const r = (await pool.query(`SELECT status, fail_count, http_status, checked_at < now() - interval '6 days' AS soon FROM links WHERE id = $1`, [linkId])).rows[0];
    await pool.query(`DELETE FROM links WHERE id = $1`, [linkId]);
    return { status: out.status, result: out.result, row: [r.status, r.fail_count, r.http_status], soon: r.soon };
  };
  const pub = (p) => `http://ok.public.test:${port}${p}`;
  try {
    // What answered decides the status: ok, dead (404/410 twice), blocked (the site refuses robots), and a failure that
    // isn't final yet is tried again in a few hours (three of them make it dead).
    assert.deepEqual(await probe(pub("/ok")), { status: 200, result: "ok", row: ["ok", 0, 200], soon: false });
    assert.deepEqual(await probe(pub("/gone")), { status: 404, result: "unchecked", row: ["unchecked", 1, 404], soon: true });
    assert.deepEqual(await probe(pub("/gone"), "unchecked", 1), { status: 404, result: "dead", row: ["dead", 2, 404], soon: false });
    assert.deepEqual(await probe(pub("/robots"), "ok", 1), { status: 403, result: "blocked", row: ["blocked", 0, 403], soon: false });
    assert.deepEqual(await probe(pub("/error"), "ok", 0), { status: 500, result: "ok", row: ["ok", 1, 500], soon: true });
    assert.deepEqual(await probe(pub("/error"), "ok", 2), { status: 500, result: "dead", row: ["dead", 3, 500], soon: false });
    // A site that refuses HEAD is asked for its first kilobyte instead.
    hits.length = 0;
    assert.equal((await probe(pub("/nohead"))).result, "ok");
    assert.deepEqual(hits, ["HEAD /nohead", "GET /nohead"]);
    // Redirects are followed (to an address or a path), each hop checked like the first, five at most.
    hits.length = 0;
    assert.equal((await probe(pub("/moved"))).result, "ok");
    assert.equal((await probe(pub("/relative"))).result, "ok");
    assert.deepEqual(hits, ["HEAD /moved", "HEAD /ok?via=moved", "HEAD /relative", "HEAD /ok?via=relative"]);
    hits.length = 0;
    assert.deepEqual(await probe(pub("/loop")), { status: 0, result: "unchecked", row: ["unchecked", 1, null], soon: true });
    assert.equal(hits.length, 6, "a redirect loop is given up after five redirects");
    assert.equal((await probe(pub("/to-ftp"))).status, 0);
    // Never inside a network: named by address, by a name that resolves there (even one of several addresses), or
    // reached by a redirect.
    hits.length = 0;
    for (const url of [
      `http://127.0.0.1:${port}/ok?direct=ip`,
      `http://[::1]:${port}/ok?direct=ip6`,
      `http://localhost:${port}/ok?direct=localhost`,
      `http://inside.test:${port}/ok?direct=name`,
      `http://mixed.test:${port}/ok?direct=mixed`,
      pub("/to-private-ip"),
      pub("/to-private-name"),
    ]) {
      assert.deepEqual((await probe(url)).status, 0, `${url} was probed`);
    }
    assert.deepEqual(hits, ["HEAD /to-private-ip", "HEAD /to-private-name"], "the checker reached a private address");
  } finally {
    dns.lookup = realLookup;
    http.request = realRequest;
    site.close();
  }
}
console.log("link checker addresses and redirects: ok");

// One writer: a second hub process on the same database (a deploy that overlaps the old one, a second replica) can't
// take the writer lock while the first holds it. Until it can, its writes and feeds answer 503 and its reads go on;
// it takes over within a second or two of the first letting go.
{
  const second = await import("../src/db.mjs?second-hub");
  const restarting = (e) => e.status === 503 && /restarting/i.test(e.message);
  await second.startFeeds();
  await assert.rejects(second.feedLimit(), restarting, "a second hub served a feed");
  assert.throws(() => second.holdFeeds(), restarting, "a second hub noted a write");
  await assert.rejects(second.tx(async () => {}), restarting, "a second hub wrote in a transaction");
  await assert.rejects(second.pool.query(`UPDATE settings SET value = value WHERE false`), restarting, "a second hub wrote a statement");
  assert.equal((await second.pool.query(`SELECT 1 AS one`)).rows[0].one, 1, "a second hub's reads go on");
  assert.equal(second.pool.totalCount - second.pool.idleCount, 0, "a refused write kept a connection");
  await tx(async (c) => c.query(`SELECT nextval('change_seq')`)); // the first still writes
  await feedLimit();
  await stopFeeds(); // the first stops
  await assert.rejects(feedLimit(), restarting, "a stopped hub served a feed");
  for (let i = 0; ; i++) {
    try {
      await second.feedLimit();
      break;
    } catch (e) {
      if (!restarting(e) || i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(second.holdsWriterLock());
  await second.tx(async (c) => c.query(`SELECT nextval('change_seq')`));
  await second.stopFeeds();
  await second.pool.end();
}
console.log("one writer: ok");
await pool.end();
