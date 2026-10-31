// A stand-in for the object store the hub signs addresses for (as test/inbox.mjs and test/backup.mjs use): path style, it VERIFIES
// each presigned request's signature, signed headers and expiry independently of src/s3.mjs, and refuses an upload whose bytes
// are not the ones named in the signed x-amz-checksum-sha256 header (BadDigest), as the real store does.
//   const b = await startBucket(); b.env (the hub's BACKUP_S3_* settings), b.store (key -> Buffer), b.refused, await b.close()
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

const KEY_ID = "TESTKEYID";
const SECRET = "test-secret-key";
const REGION = "auto";
const BUCKET = "backups";
const freePort = () => new Promise((r) => net.createServer().listen(0, "127.0.0.1", function () { const p = this.address().port; this.close(() => r(p)); }));

export async function startBucket() {
  const store = new Map();
  const refused = [];
  const failDeletes = new Set();
  const s3port = await freePort();
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  function verify(req, url) {
    const q = url.searchParams;
    const sig = q.get("X-Amz-Signature");
    if (!sig) return "no signature";
    if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return "algorithm";
    const [keyId, date, region, svc, term] = (q.get("X-Amz-Credential") ?? "").split("/");
    if (keyId !== KEY_ID || region !== REGION || svc !== "s3" || term !== "aws4_request") return "credential";
    const stamp = q.get("X-Amz-Date") ?? "";
    if (!stamp.startsWith(date)) return "date";
    const issued = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    if (Date.now() > issued + Number(q.get("X-Amz-Expires")) * 1000) return "expired";
    if (Number(q.get("X-Amz-Expires")) > 3600) return "too long";
    const params = [...q.entries()].filter(([k]) => k !== "X-Amz-Signature").sort(([a], [b]) => (a < b ? -1 : 1));
    // Every signed header is read from the request as it arrived (a PUT of another size has another content-length).
    const names = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
    if (!names.includes("host")) return "host not signed";
    if (req.method === "PUT" && !names.includes("content-length")) return "content-length not signed";
    const headerLines = names.map((n) => `${n}:${String(req.headers[n] ?? "").trim()}\n`).join("");
    const canonical = [req.method, url.pathname.split("/").map((s) => enc(decodeURIComponent(s))).join("/"), params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"), headerLines, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", stamp, `${date}/${region}/s3/aws4_request`, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
    const want = crypto.createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), region), "s3"), "aws4_request")).update(toSign).digest("hex");
    return want === sig ? null : "signature mismatch";
  }
  
  const s3 = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${s3port}`);
    const bad = verify(req, url);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (bad) {
        refused.push(bad);
        res.writeHead(403).end(bad);
        return;
      }
      const key = decodeURIComponent(url.pathname).replace(`/${BUCKET}/`, "");
      if (req.method === "PUT") {
        const body = Buffer.concat(chunks);
        const sum = req.headers["x-amz-checksum-sha256"];
        if (sum && crypto.createHash("sha256").update(body).digest("base64") !== sum) {
          refused.push("checksum");
          res.writeHead(400).end("BadDigest");
          return;
        }
        store.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const b = store.get(key);
        if (!b) res.writeHead(404).end();
        else res.writeHead(200, { "Content-Length": b.length }).end(b);
      } else if (req.method === "HEAD") {
        const b = store.get(key);
        if (!b) res.writeHead(404).end();
        else res.writeHead(200, { "Content-Length": b.length }).end();
      } else if (req.method === "DELETE") {
        if (failDeletes.has(key)) return res.writeHead(500).end("InternalError");
        store.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  
  await new Promise((r) => s3.listen(s3port, "127.0.0.1", r));
  return {
    store,
    refused,
    failDeletes,
    env: { BACKUP_S3_ENDPOINT: `http://127.0.0.1:${s3port}`, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: SECRET, BACKUP_S3_REGION: REGION },
    close: () => new Promise((r) => s3.close(() => r())),
  };
}
