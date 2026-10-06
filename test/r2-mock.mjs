// A stand-in for the bits of Cloudflare R2 / S3 the hub uses, in memory (as stripe-mock.mjs is for Stripe). node:http only.
//
//   import { startR2Mock } from "./r2-mock.mjs";
//   const r2 = await startR2Mock({ port: 0, bucket: "stitchhub-manuals", accessKeyId: "AKIATEST", secret: "..." });
//   r2.endpoint            "http://127.0.0.1:PORT"  (the hub's R2_ENDPOINT)
//   r2.objects             Map key -> { bytes, contentType, disposition, etag, modified }
//   r2.put(key, bytes, contentType)  write an object as the program's PUT would have
//   r2.now()  the mock's clock (a URL signed with now: r2.now() is good by it)
//   r2.advance(ms)         moves the mock's clock forward (a presigned URL's expiry is checked against it)
//   r2.requests            [{ method, key, status, reason }] in order
//   await r2.close()
//
// Path style (/<bucket>/<key>). Every request must be a presigned URL: X-Amz-Algorithm AWS4-HMAC-SHA256, the credential's
// access key, region "auto", service "s3", X-Amz-Date and X-Amz-Expires (a URL is good from its date for that long and
// refused after, or when its date is more than 15 minutes ahead), every header named in X-Amz-SignedHeaders present and
// signed with its actual value, and a signature that is the one recomputed here (src/r2.mjs's signature(), which
// test/r2.mjs checks against AWS's published example). Anything altered (the path, the query, a header, the method)
// gives SignatureDoesNotMatch. Operations: PUT (the body stored; Content-Type and Content-Disposition kept), PUT with
// x-amz-copy-source (CopyObject; x-amz-metadata-directive REPLACE takes the request's type and disposition), HEAD, GET
// (Range: bytes=a-b, a-, -n; the response-content-type and response-content-disposition overrides honoured), DELETE
// (204 whether or not it existed). Errors are S3's XML with S3's codes and statuses.
import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { signature } from "../src/r2.mjs";

const xml = (code, message) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

export async function startR2Mock({ port = 0, bucket = "stitchhub-manuals", accessKeyId = "AKIAMOCKR2TEST", secret = "mock-r2-secret-access-key-not-real" } = {}) {
  let offset = 0;
  const clock = () => Date.now() + offset;
  const objects = new Map();
  const requests = [];

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(Buffer.alloc(0)));
    });
  }

  /** null when the URL is good, else [status, code, message]. */
  function check(req, url) {
    const raw = url.search.slice(1);
    const pairs = raw
      ? raw.split("&").map((p) => {
          const i = p.indexOf("=");
          return [decodeURIComponent(p.slice(0, i < 0 ? p.length : i)), decodeURIComponent(i < 0 ? "" : p.slice(i + 1))];
        })
      : [];
    const get = (k) => pairs.find(([n]) => n === k)?.[1];
    if (get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" || !get("X-Amz-Signature")) return [403, "AccessDenied", "Request is not signed (a presigned URL is needed)."];
    const [ak, day, region, service, term] = String(get("X-Amz-Credential") ?? "").split("/");
    if (ak !== accessKeyId) return [403, "InvalidAccessKeyId", "The access key is not known."];
    if (region !== "auto" || service !== "s3" || term !== "aws4_request") return [403, "AuthorizationQueryParametersError", "Wrong credential scope."];
    const stamp = get("X-Amz-Date") ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(stamp) || stamp.slice(0, 8) !== day) return [400, "AuthorizationQueryParametersError", "Bad X-Amz-Date."];
    const expires = Number(get("X-Amz-Expires"));
    if (!Number.isInteger(expires) || expires < 1 || expires > 604800) return [400, "AuthorizationQueryParametersError", "X-Amz-Expires must be between 1 and 604800."];
    const at = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    if (at - clock() > 15 * 60_000) return [403, "AccessDenied", "Request is not valid yet."];
    if (clock() > at + expires * 1000) return [403, "AccessDenied", "Request has expired."];
    const signed = String(get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
    if (!signed.includes("host")) return [403, "AccessDenied", "host must be signed."];
    const headers = {};
    for (const h of signed) {
      const v = req.headers[h];
      if (v === undefined) return [403, "SignatureDoesNotMatch", `The signed header ${h} was not sent.`];
      headers[h] = Array.isArray(v) ? v.join(",") : v;
    }
    const query = pairs.filter(([n]) => n !== "X-Amz-Signature");
    const path = decodeURIComponent(url.pathname);
    const { signature: want } = signature({ method: req.method, path, query, headers, secret, region, service, date: at });
    const given = Buffer.from(get("X-Amz-Signature"));
    const exact = Buffer.from(want);
    if (given.length !== exact.length || !crypto.timingSafeEqual(given, exact)) return [403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided."];
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const record = { method: req.method, key: null, status: 0, reason: null };
    requests.push(record);
    const send = (status, body = "", headers = {}) => {
      record.status = status;
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const error = ([status, code, message]) => {
      record.reason = code;
      send(status, xml(code, message), { "Content-Type": "application/xml", "x-error-code": code });
    };
    try {
      const body = await readBody(req);
      const prefix = `/${bucket}/`;
      if (!url.pathname.startsWith(prefix)) return error([404, "NoSuchBucket", "The specified bucket does not exist."]);
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      record.key = key;
      const bad = check(req, url);
      if (bad) return error(bad);
      const stored = objects.get(key);
      if (req.method === "PUT") {
        const source = req.headers["x-amz-copy-source"];
        if (source) {
          const from = decodeURIComponent(String(source)).replace(/^\//, "");
          if (!from.startsWith(`${bucket}/`)) return error([404, "NoSuchBucket", "The copy source's bucket does not exist."]);
          const src = objects.get(from.slice(bucket.length + 1));
          if (!src) return error([404, "NoSuchKey", "The specified key does not exist."]);
          const replace = String(req.headers["x-amz-metadata-directive"] ?? "COPY").toUpperCase() === "REPLACE";
          objects.set(key, {
            bytes: src.bytes,
            contentType: replace ? (req.headers["content-type"] ?? "binary/octet-stream") : src.contentType,
            disposition: replace ? (req.headers["content-disposition"] ?? null) : src.disposition,
            etag: src.etag,
            modified: new Date(clock()),
          });
          return send(200, `<?xml version="1.0"?><CopyObjectResult><ETag>"${src.etag}"</ETag></CopyObjectResult>`, { "Content-Type": "application/xml" });
        }
        const etag = crypto.createHash("md5").update(body).digest("hex");
        objects.set(key, { bytes: body, contentType: req.headers["content-type"] ?? "binary/octet-stream", disposition: req.headers["content-disposition"] ?? null, etag, modified: new Date(clock()) });
        return send(200, "", { ETag: `"${etag}"` });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return send(204);
      }
      if (req.method === "HEAD" || req.method === "GET") {
        if (!stored) return error([404, "NoSuchKey", "The specified key does not exist."]);
        const type = url.searchParams.get("response-content-type") ?? stored.contentType;
        const disposition = url.searchParams.get("response-content-disposition") ?? stored.disposition;
        const meta = { "Content-Type": type, ...(disposition ? { "Content-Disposition": disposition } : {}), ETag: `"${stored.etag}"`, "Last-Modified": stored.modified.toUTCString(), "Accept-Ranges": "bytes" };
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (range && req.method === "GET") {
          const size = stored.bytes.length;
          let [from, to] = [range[1] === "" ? NaN : Number(range[1]), range[2] === "" ? NaN : Number(range[2])];
          if (Number.isNaN(from)) {
            from = Math.max(0, size - to);
            to = size - 1;
          } else if (Number.isNaN(to) || to >= size) to = size - 1;
          if (from >= size || from > to) return send(416, xml("InvalidRange", "The requested range is not satisfiable"), { "Content-Type": "application/xml", "Content-Range": `bytes */${size}` });
          return send(206, stored.bytes.subarray(from, to + 1), { ...meta, "Content-Range": `bytes ${from}-${to}/${size}`, "Content-Length": String(to - from + 1) });
        }
        if (req.method === "HEAD") {
          record.status = 200;
          res.writeHead(200, { ...meta, "Content-Length": String(stored.bytes.length) });
          return res.end();
        }
        return send(200, stored.bytes, { ...meta, "Content-Length": String(stored.bytes.length) });
      }
      return error([405, "MethodNotAllowed", "The specified method is not allowed against this resource."]);
    } catch (e) {
      record.reason = e.message;
      send(500, xml("InternalError", e.message), { "Content-Type": "application/xml" });
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secret,
    objects,
    requests,
    put(key, bytes, contentType = "application/pdf") {
      objects.set(key, { bytes: Buffer.from(bytes), contentType, disposition: null, etag: crypto.createHash("md5").update(bytes).digest("hex"), modified: new Date(clock()) });
    },
    now: clock,
    advance(ms) {
      offset += ms;
    },
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

// On its own: a mock for a local test hub (R2_ENDPOINT=http://127.0.0.1:3404, the same R2_* names as the mock prints).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startR2Mock({ port: Number(process.env.R2_MOCK_PORT) || 3404 });
  console.log(`R2 mock on ${mock.endpoint}\nR2_ENDPOINT=${mock.endpoint}\nR2_BUCKET=${mock.bucket}\nR2_ACCESS_KEY_ID=${mock.accessKeyId}\nR2_SECRET_ACCESS_KEY=${mock.secret}`);
}
