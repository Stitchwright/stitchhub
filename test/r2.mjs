// Checks src/r2.mjs (AWS Signature V4 for Cloudflare R2, no SDK): the examples in AWS's documentation yield their
// published signatures, and presigned PUT, HEAD, ranged GET, copy and delete work against the in-memory mock
// (test/r2-mock.mjs), which refuses an expired URL and any altered one. No database needed.
// usage: node test/r2.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { R2, presignUrl, signature, uriEncode, r2FromEnv } from "../src/r2.mjs";
import { startR2Mock } from "./r2-mock.mjs";

// ----- AWS's documented examples (Signature Version 4, Amazon S3): the signature must be theirs -----
const AK = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DAY = Date.UTC(2013, 4, 24, 0, 0, 0);
{
  // "Authenticating Requests: Using Query Parameters": GET /test.txt, 86400 seconds, us-east-1
  const url = presignUrl({ method: "GET", origin: "https://examplebucket.s3.amazonaws.com", path: "/test.txt", accessKeyId: AK, secret: SECRET, region: "us-east-1", expires: 86400, now: DAY });
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  // "Signature Calculations: Header-Based Authentication" example: GET Object with a Range
  const empty = crypto.createHash("sha256").update("").digest("hex");
  const g = signature({
    method: "GET",
    path: "/test.txt",
    query: [],
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": empty, "x-amz-date": "20130524T000000Z" },
    payloadHash: empty,
    secret: SECRET,
    region: "us-east-1",
    service: "s3",
    date: DAY,
  });
  assert.equal(g.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(g.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  // The documented PUT Object example (with a body and a storage-class header)
  const body = "Welcome to Amazon S3.";
  const p = signature({
    method: "PUT",
    path: "/test$file.text",
    query: [],
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": crypto.createHash("sha256").update(body).digest("hex"),
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash: crypto.createHash("sha256").update(body).digest("hex"),
    secret: SECRET,
    region: "us-east-1",
    service: "s3",
    date: DAY,
  });
  assert.equal(p.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.equal(uriEncode("a b/ü+~", true), "a%20b/%C3%BC%2B~");
  console.log("AWS documentation examples: ok");
}

// ----- against the mock -----
const mock = await startR2Mock({ bucket: "stitchhub-manuals" });
const r2 = new R2({ endpoint: mock.endpoint, bucket: mock.bucket, accessKeyId: mock.accessKeyId, secret: mock.secret });
const bytes = crypto.randomBytes(1000);
const reasons = () => mock.requests.map((r) => r.reason);
try {
  // The program's upload: a presigned PUT with its type and length signed.
  const slot = r2.putUrl("incoming/up1.pdf", { size: bytes.length });
  assert.ok(slot.url.startsWith(`${mock.endpoint}/stitchhub-manuals/incoming/up1.pdf?`));
  assert.deepEqual(slot.headers, { "Content-Type": "application/pdf", "Content-Length": "1000" });
  assert.ok(slot.expiresAt.getTime() - Date.now() > 14 * 60_000);
  let r = await fetch(slot.url, { method: "PUT", headers: slot.headers, body: bytes });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual(mock.objects.get("incoming/up1.pdf").bytes, bytes);

  // Sent with another content type or length than was signed: refused (the signature covers them).
  r = await fetch(slot.url, { method: "PUT", headers: { "Content-Type": "text/html", "Content-Length": "1000" }, body: bytes });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("x-error-code"), "SignatureDoesNotMatch");
  r = await fetch(slot.url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: Buffer.concat([bytes, bytes]) });
  assert.equal(r.status, 403, "a body of another length than the signed one");
  r = await fetch(slot.url, { method: "PUT", body: bytes });
  assert.equal(r.status, 403, "a signed header that wasn't sent");

  // HEAD, whole GET, ranged GET, and a download with its name forced.
  assert.deepEqual(await r2.head("incoming/up1.pdf"), { size: 1000, contentType: "application/pdf", etag: `"${crypto.createHash("md5").update(bytes).digest("hex")}"`, disposition: null });
  assert.equal(await r2.head("nothing/here.pdf"), null);
  assert.deepEqual(await r2.get("incoming/up1.pdf"), bytes);
  assert.deepEqual(await r2.get("incoming/up1.pdf", { range: "bytes=10-19" }), bytes.subarray(10, 20));
  assert.deepEqual(await r2.get("incoming/up1.pdf", { range: "bytes=-5" }), bytes.subarray(995));
  assert.deepEqual(await r2.get("incoming/up1.pdf", { range: "bytes=990-" }), bytes.subarray(990));
  assert.equal(await r2.get("nothing/here.pdf"), null);
  const dl = r2.getUrl("incoming/up1.pdf", { fileName: 'Brother_NV"1_ServiceManual_2010.pdf' });
  r = await fetch(dl.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="Brother_NV_1_ServiceManual_2010.pdf"');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  r = await fetch(r2.getUrl("incoming/up1.pdf", { fileName: "x.pdf", inline: true }).url);
  assert.equal(r.headers.get("content-disposition"), 'inline; filename="x.pdf"');

  // Copy with the metadata replaced, then delete the source (and again: deleting what isn't there is fine).
  await r2.copy("incoming/up1.pdf", "files/abc.pdf", { disposition: 'attachment; filename="Brother_X.pdf"' });
  assert.deepEqual(mock.objects.get("files/abc.pdf").bytes, bytes);
  assert.equal(mock.objects.get("files/abc.pdf").disposition, 'attachment; filename="Brother_X.pdf"');
  assert.equal((await r2.head("files/abc.pdf")).disposition, 'attachment; filename="Brother_X.pdf"');
  await r2.remove("incoming/up1.pdf");
  assert.equal(mock.objects.has("incoming/up1.pdf"), false);
  await r2.remove("incoming/up1.pdf");
  await assert.rejects(r2.copy("incoming/up1.pdf", "files/zzz.pdf"), /copy .* answered 404/);
  // A key with spaces and unicode round-trips through the signature.
  await r2.put("files/weird name ü+.pdf", bytes);
  assert.deepEqual(await r2.get("files/weird name ü+.pdf"), bytes);
  console.log("PUT, HEAD, ranged GET, copy, delete against the mock: ok");

  // ----- refused: expired, altered, another key, another method, unsigned, a wrong secret -----
  const fresh = () => r2.getUrl("files/abc.pdf");
  assert.equal((await fetch(fresh().url)).status, 200);
  const expired = r2.presign("GET", "files/abc.pdf", { expires: 60, now: mock.now() - 120_000 });
  r = await fetch(expired.url);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("x-error-code"), "AccessDenied");
  // The mock's clock moves: a good URL is good for exactly its time.
  const five = fresh();
  mock.advance(4 * 60_000);
  assert.equal((await fetch(five.url)).status, 200, "still inside its 5 minutes");
  mock.advance(2 * 60_000);
  assert.equal((await fetch(five.url)).status, 403, "past its 5 minutes");
  const future = r2.presign("GET", "files/abc.pdf", { now: mock.now() + 3600_000 });
  assert.equal((await fetch(future.url)).status, 403, "dated an hour ahead");
  const good = new URL(r2.getUrl("files/abc.pdf", { now: mock.now() }).url);
  const altered = async (change) => {
    const u = new URL(good);
    change(u);
    const x = await fetch(u);
    assert.equal(x.status, 403);
    assert.equal(x.headers.get("x-error-code"), "SignatureDoesNotMatch");
  };
  await altered((u) => (u.pathname = "/stitchhub-manuals/files/weird name ü+.pdf")); // another key
  await altered((u) => u.searchParams.set("response-content-disposition", "inline")); // a changed override
  await altered((u) => u.searchParams.append("x-extra", "1")); // an added parameter
  await altered((u) => {
    const s = u.searchParams.get("X-Amz-Signature");
    u.searchParams.set("X-Amz-Signature", (s[0] === "0" ? "1" : "0") + s.slice(1));
  }); // a flipped signature digit
  // A longer lifetime than signed can't be asked for after the fact: the signature covers it.
  await altered((u) => u.searchParams.set("X-Amz-Expires", "86400"));
  assert.equal((await fetch(good, { method: "DELETE" })).status, 403, "a GET URL used for a DELETE");
  assert.equal((await fetch(good, { method: "PUT", body: "x" })).status, 403, "a GET URL used for a PUT");
  assert.equal(mock.objects.has("files/abc.pdf"), true);
  assert.equal((await fetch(`${mock.endpoint}/stitchhub-manuals/files/abc.pdf`)).status, 403, "no signature at all");
  const wrong = new R2({ endpoint: mock.endpoint, bucket: mock.bucket, accessKeyId: mock.accessKeyId, secret: "another-secret" });
  assert.equal((await fetch(wrong.getUrl("files/abc.pdf").url)).status, 403, "signed with another secret");
  const other = new R2({ endpoint: mock.endpoint, bucket: mock.bucket, accessKeyId: "AKIAOTHER", secret: mock.secret });
  assert.equal((await fetch(other.getUrl("files/abc.pdf").url)).status, 403, "an unknown access key");
  const elsewhere = new R2({ endpoint: mock.endpoint, bucket: "another-bucket", accessKeyId: mock.accessKeyId, secret: mock.secret });
  assert.equal((await fetch(elsewhere.getUrl("files/abc.pdf").url)).status, 404, "another bucket");
  assert.ok(reasons().includes("SignatureDoesNotMatch") && reasons().includes("AccessDenied"));
  // The hub's own calls name an error without the URL (it carries the signature).
  await assert.rejects(wrong.head("files/abc.pdf"), (e) => e.status === 403 && !/X-Amz/.test(e.message));
  console.log("expired and altered URLs refused: ok");

  // ----- configuration from the environment -----
  assert.equal(r2FromEnv({}), null);
  assert.equal(r2FromEnv({ R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k" }), null);
  const cfg = r2FromEnv({ R2_ACCOUNT_ID: "acct123", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" });
  assert.ok(cfg.getUrl("files/x.pdf").url.startsWith("https://acct123.r2.cloudflarestorage.com/b/files/x.pdf?"));
  console.log("configuration: ok");
} finally {
  await mock.close();
}
console.log("r2: all ok");
