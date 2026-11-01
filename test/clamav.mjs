// The ClamAV client (src/clamav.mjs) against a stand-in clamd (test/fake-clamd.mjs): a clean file, an infected one (the EICAR test
// string), a file bigger than one chunk, a scanner that is down, one that never answers, one that answers nonsense, one that refuses
// for size, the status call, and the configuration. No database needed.
// usage: node test/clamav.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { clamavConfig, clamavStatus, scanBuffer } from "../src/clamav.mjs";
import { EICAR, startFakeClamd } from "./fake-clamd.mjs";

const ok = (what) => console.log(`  ok  ${what}`);

// ----- configuration -----
assert.equal(clamavConfig({}), null, "no host: off");
assert.equal(clamavConfig({ CLAMAV_HOST: "  " }), null);
assert.deepEqual(clamavConfig({ CLAMAV_HOST: "clamav.internal" }), { host: "clamav.internal", port: 3310, timeoutMs: 60_000, required: true });
assert.equal(clamavConfig({ CLAMAV_HOST: "h", CLAMAV_PORT: "99999" }).port, 3310, "a bad port falls back");
assert.equal(clamavConfig({ CLAMAV_HOST: "h", CLAMAV_REQUIRED: "false" }).required, false);
assert.equal(clamavConfig({ CLAMAV_HOST: "h", CLAMAV_TIMEOUT_MS: "5" }).timeoutMs, 60_000, "a silly timeout falls back");
assert.deepEqual(await scanBuffer(Buffer.from("x"), null), { skipped: true }, "off: skipped, no connection");
ok("configuration: off without a host, defaults, bad values fall back");

const clamd = await startFakeClamd();
const cfg = { host: "127.0.0.1", port: clamd.port, timeoutMs: 3000, required: true };
try {
  assert.deepEqual(await scanBuffer(Buffer.from("just a PDF-ish file"), cfg), { ok: true });
  ok("a clean file is ok");

  assert.deepEqual(await scanBuffer(Buffer.concat([Buffer.from("%PDF-1.4\n"), EICAR]), cfg), { infected: "Eicar-Test-Signature" });
  ok("the EICAR test string is reported by name");

  const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const before = clamd.seen.bytes;
  assert.deepEqual(await scanBuffer(big, cfg), { ok: true });
  assert.equal(clamd.seen.bytes - before, big.length, "every byte reached the scanner, in several chunks");
  const bigBad = Buffer.concat([crypto.randomBytes(300_000), EICAR, crypto.randomBytes(300_000)]);
  assert.deepEqual(await scanBuffer(bigBad, cfg), { infected: "Eicar-Test-Signature" }, "found in the middle of a multi-chunk file");
  ok("a file over many chunks is sent whole and still caught");

  assert.deepEqual(await scanBuffer(Buffer.alloc(0), cfg), { ok: true });
  ok("an empty file is ok");

  const small = await startFakeClamd({ limit: 100_000 });
  const r = await scanBuffer(crypto.randomBytes(400_000), { ...cfg, port: small.port });
  assert.match(r.unavailable, /StreamMaxLength/, "a size refusal is 'could not scan', with the setting to change");
  await small.close();
  ok("clamd's size limit is reported as not scanned, naming StreamMaxLength");

  clamd.knobs.mode = "garbage";
  assert.match((await scanBuffer(Buffer.from("x"), cfg)).unavailable, /unexpected/);
  clamd.knobs.mode = "silent";
  const t0 = Date.now();
  assert.match((await scanBuffer(Buffer.from("x"), { ...cfg, timeoutMs: 1000 })).unavailable, /timed out/);
  assert.ok(Date.now() - t0 < 4000, "gives up at the timeout");
  clamd.knobs.mode = "normal";
  ok("nonsense and silence are 'could not scan', not a pass");

  const st = await clamavStatus(cfg);
  assert.equal(st.reachable, true);
  assert.match(st.version, /^ClamAV 1\.4\.0-test/);
  assert.equal(st.required, true);
  assert.deepEqual(await clamavStatus(null), { configured: false });
  ok("status: PONG and the engine's version");
} finally {
  await clamd.close();
}

const dead = { host: "127.0.0.1", port: clamd.port, timeoutMs: 2000, required: true };
assert.ok((await scanBuffer(Buffer.from("x"), dead)).unavailable, "a scanner that is down is 'could not scan'");
const down = await clamavStatus(dead);
assert.equal(down.configured, true);
assert.equal(down.reachable, false);
ok("a scanner that is down is 'could not scan' and the status says unreachable");

console.log("clamav: all ok");
