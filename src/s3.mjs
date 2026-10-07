// A little S3 for the off-site backups (src/backups.mjs): SigV4 query-string presigning by hand (about the size of
// stripe.mjs: no SDK), and the two calls the hub itself makes, HEAD (is the object there, and how big) and DELETE.
// Works with Cloudflare R2 (region "auto") and any S3-compatible store, path-style: <endpoint>/<bucket>/<key>.
//   BACKUP_S3_ENDPOINT  https://<account>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET    the bucket
//   BACKUP_S3_KEY_ID, BACKUP_S3_SECRET   an access key for it
//   BACKUP_S3_REGION    "auto" for R2
import crypto from "node:crypto";

export function s3Config(env = process.env) {
  const endpoint = (env.BACKUP_S3_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const bucket = (env.BACKUP_S3_BUCKET ?? "").trim();
  const keyId = (env.BACKUP_S3_KEY_ID ?? "").trim();
  const secret = (env.BACKUP_S3_SECRET ?? "").trim();
  if (!endpoint || !bucket || !keyId || !secret) return null;
  return { endpoint, bucket, keyId, secret, region: (env.BACKUP_S3_REGION ?? "auto").trim() || "auto" };
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
// RFC 3986: what AWS signs ("/" kept in a path, escaped in a query value).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key) => key.split("/").map(enc).join("/");

/**
 * A URL good for `expires` seconds that lets whoever holds it do `method` to `key` and nothing else. The payload is not
 * signed (UNSIGNED-PAYLOAD), which is what a presigned PUT is; `headers` ({ name: value }) are signed with the host, so
 * the request must carry exactly those (a PUT's content-length: no other size goes in; x-amz-checksum-sha256: no other
 * bytes).
 */
export function presign(cfg, method, key, { expires = 900, now = new Date(), headers = {} } = {}) {
  const url = new URL(cfg.endpoint);
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261006T120000Z
  const date = stamp.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.keyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(Math.min(Math.max(1, Math.floor(expires)), 3600)),
  };
  const signed = { host: url.host };
  for (const [k, v] of Object.entries(headers)) signed[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(signed).sort();
  params["X-Amz-SignedHeaders"] = names.join(";");
  const canonicalQuery = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const path = `${url.pathname.replace(/\/+$/, "")}/${enc(cfg.bucket)}/${encPath(key)}`;
  const canonical = [method, path, canonicalQuery, names.map((n) => `${n}:${signed[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, date), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The object's size in bytes, or null when it isn't there. */
export async function headObject(cfg, key) {
  const r = await fetch(presign(cfg, "HEAD", key, { expires: 60 }), { method: "HEAD", signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`the bucket answered ${r.status}`);
  const n = Number(r.headers.get("content-length"));
  return Number.isFinite(n) ? n : null;
}

/** Deletes the object; one that is already gone is fine. */
export async function deleteObject(cfg, key) {
  const r = await fetch(presign(cfg, "DELETE", key, { expires: 60 }), { method: "DELETE", signal: AbortSignal.timeout(20_000) });
  if (!r.ok && r.status !== 404) throw new Error(`the bucket answered ${r.status}`);
}
