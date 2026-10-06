// Cloudflare R2 (S3-compatible) without an SDK: AWS Signature Version 4 written by hand with node:crypto, for the
// manual repository (docs/plans/manual-repository-design.md in the StitchBench repo, section 2, package repo-storage).
//
//   presign({ method, key, expires, headers, query })   a presigned URL (query-string signing, payload UNSIGNED-PAYLOAD):
//        PUT for the program's upload, GET for a download (response-content-type / response-content-disposition
//        overrides ride in `query`), and HEAD, DELETE and the copy PUT for the hub's own calls. `headers` are signed
//        too: whoever uses the URL must send exactly those headers (Content-Type, Content-Length, x-amz-copy-source).
//   head(key), get(key, { range }), copy(from, to, { contentType, disposition }), remove(key), put(key, bytes, ...)
//        the hub's own calls: each signs a short-lived URL and fetches it.
//
// Endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<R2_BUCKET>/<key> (path style, region "auto", service "s3"),
// or R2_ENDPOINT for a test (the mock in test/r2-mock.mjs). Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, only in
// the hub's environment. A presigned URL is never logged.
import crypto from "node:crypto";

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const hex = (b) => b.toString("hex");
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ (and "/" kept in a path). */
export const uriEncode = (s, keepSlash = false) =>
  [...Buffer.from(String(s), "utf8")]
    .map((b) => {
      const ch = String.fromCharCode(b);
      return /[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/") ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

/** 20130524T000000Z for a date. */
export const amzDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The query string in canonical order (sorted by encoded name, then value), values encoded. `query` is [[k, v], ...]. */
export function canonicalQuery(query) {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** The signing key for a day, region and service (the four-step HMAC chain). */
export const signingKey = (secret, day, region, service) => hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");

/**
 * The signature for a request, and the pieces it was made from. `headers` is { name: value } (host included), `query`
 * the query pairs without X-Amz-Signature, `path` the unencoded path. Header values are trimmed and runs of spaces
 * folded, as the canonical form wants.
 */
export function signature({ method, path, query, headers, payloadHash = "UNSIGNED-PAYLOAD", secret, region, service, date }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [method.toUpperCase(), uriEncode(path, true), canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stamp = amzDate(date);
  const scope = `${stamp.slice(0, 8)}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256hex(canonical)].join("\n");
  return { signature: hex(hmac(signingKey(secret, stamp.slice(0, 8), region, service), toSign)), signedHeaders, scope, canonical, stamp };
}

/**
 * A presigned URL (query-string authentication) for `method` on `https://host + path`. Returns the URL string.
 * `now` is for tests. `headers` besides host are signed and must be sent by the caller.
 */
export function presignUrl({ method, origin, path, accessKeyId, secret, region = "auto", service = "s3", expires = 300, headers = {}, query = [], now = Date.now() }) {
  const u = new URL(origin);
  const all = { host: u.host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(all).sort().join(";");
  const stamp = amzDate(now);
  const q = [
    ...query,
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${stamp.slice(0, 8)}/${region}/${service}/aws4_request`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", names],
  ];
  const { signature: sig } = signature({ method, path, query: q, headers: all, secret, region, service, date: now });
  return `${u.protocol}//${u.host}${uriEncode(path, true)}?${canonicalQuery(q)}&X-Amz-Signature=${sig}`;
}

export function r2FromEnv(env = process.env) {
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  if (!bucket || !accessKeyId || !secret || !endpoint) return null;
  return new R2({ endpoint, bucket, accessKeyId, secret });
}

export class R2Error extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class R2 {
  constructor({ endpoint, bucket, accessKeyId, secret, region = "auto" }) {
    Object.assign(this, { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secret, region });
  }

  /** The presigned URL for one key. Returns { url, headers, expiresAt }: headers are what the caller must send. */
  presign(method, key, { expires = 300, headers = {}, query = [], now = Date.now() } = {}) {
    const url = presignUrl({
      method,
      origin: this.endpoint,
      path: `${new URL(this.endpoint).pathname.replace(/\/+$/, "")}/${this.bucket}/${key}`,
      accessKeyId: this.accessKeyId,
      secret: this.secret,
      region: this.region,
      expires,
      headers,
      query,
      now,
    });
    return { url, headers, expiresAt: new Date(now + expires * 1000) };
  }

  /** The program's upload: PUT, one key, a 15-minute default, Content-Type (and Content-Length when known) signed. */
  putUrl(key, { contentType = "application/pdf", size = null, expires = 900, now } = {}) {
    const headers = { "Content-Type": contentType, ...(size != null ? { "Content-Length": String(size) } : {}) };
    return this.presign("PUT", key, { expires, headers, now });
  }

  /** A download: GET, 5 minutes by default, type and disposition forced in the response. */
  getUrl(key, { fileName = null, inline = false, expires = 300, now } = {}) {
    const query = [["response-content-type", "application/pdf"]];
    if (fileName) query.push(["response-content-disposition", `${inline ? "inline" : "attachment"}; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`]);
    else if (!inline) query.push(["response-content-disposition", "attachment"]);
    return this.presign("GET", key, { expires, query, now });
  }

  async #call(method, key, { headers = {}, query = [], body, expect = [200, 204], what }) {
    const s = this.presign(method, key, { expires: 120, headers, query });
    const r = await fetch(s.url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
    if (!expect.includes(r.status)) {
      // The URL carries the signature: it is never put in a message.
      await r.arrayBuffer().catch(() => {});
      throw new R2Error(`R2 ${what ?? method} ${key} answered ${r.status}`, r.status);
    }
    return r;
  }

  /** { size, contentType, etag } or null when there is no such object. */
  async head(key) {
    const r = await this.#call("HEAD", key, { expect: [200, 404], what: "HEAD" });
    if (r.status === 404) return null;
    return { size: Number(r.headers.get("content-length")), contentType: r.headers.get("content-type"), etag: r.headers.get("etag"), disposition: r.headers.get("content-disposition") };
  }

  /** The object's bytes (or a range, "bytes=0-1023"); null for no such object. */
  async get(key, { range = null } = {}) {
    const headers = range ? { Range: range } : {};
    // A Range header isn't signed, so it is allowed to differ from the signed headers: send it beside them.
    const s = this.presign("GET", key, { expires: 120 });
    const r = await fetch(s.url, { headers, signal: AbortSignal.timeout(300_000) });
    if (r.status === 404) return null;
    if (![200, 206].includes(r.status)) {
      await r.arrayBuffer().catch(() => {});
      throw new R2Error(`R2 GET ${key} answered ${r.status}`, r.status);
    }
    return Buffer.from(await r.arrayBuffer());
  }

  /** Server-side copy; contentType and disposition replace the source's metadata when given. */
  async copy(from, to, { contentType = "application/pdf", disposition = null } = {}) {
    const headers = { "x-amz-copy-source": `/${this.bucket}/${uriEncode(from, true)}`, "x-amz-metadata-directive": "REPLACE", "Content-Type": contentType, ...(disposition ? { "Content-Disposition": disposition } : {}) };
    await this.#call("PUT", to, { headers, what: "copy" });
  }

  /** Deleting what is not there is fine (S3 answers 204 either way). */
  async remove(key) {
    await this.#call("DELETE", key, { what: "DELETE" });
  }

  /** A small direct write (tests, and the hub's own notes): the bytes with a content type. */
  async put(key, bytes, { contentType = "application/pdf" } = {}) {
    await this.#call("PUT", key, { headers: { "Content-Type": contentType }, body: bytes, what: "PUT" });
  }
}
