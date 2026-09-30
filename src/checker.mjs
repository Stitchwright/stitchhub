// Checks manual links in the background: about once a week each, a dozen a minute, gently per site.
// ok = the file answers; dead = 404/410 twice, or unreachable three times; blocked = the site refuses robots (403/429),
// so a person has to try it in a browser. Every check bumps the row so installs see the new status.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { q } from "./db.mjs";

const UA = process.env.CHECKER_USER_AGENT ?? "StitchHub-LinkChecker/1.0 (community manual catalog; checks that links still work)";

// Only public web servers are checked. Any member can add a link and every member sees what the check answered, so
// otherwise a link could make the hub knock on machines in its own network (the router, a NAS, other services on
// Railway's private network) and report back what answered. The address is checked where the connection is made, so
// a name can't pass the check and then resolve somewhere private, and again after every redirect.
const blocked = new net.BlockList();
for (const [a, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) blocked.addSubnet(a, bits, "ipv4"); // also catches IPv4-mapped IPv6 (::ffff:10.0.0.1)
for (const [a, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64: an IPv4 address inside
  ["2002::", 16], // 6to4: an IPv4 address inside
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blocked.addSubnet(a, bits, "ipv6");

/** True for anything that isn't a public internet address (or isn't an address at all). */
export function privateAddress(ip) {
  const type = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return !type || blocked.check(ip, type);
}

/** Resolves a name for the connection itself and refuses it if any address it has is private. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) return callback(err);
    if (!list.length || list.some((a) => privateAddress(a.address))) return callback(Object.assign(new Error("private address"), { code: "EPRIVATE" }));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** One request's status (and where a redirect points), without reading the body. */
function ask(u, method, headers) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && privateAddress(host)) return reject(new Error("private address"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers, lookup: publicLookup, signal: AbortSignal.timeout(20_000) }, (res) => {
      res.destroy();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Follows up to 5 redirects, each one checked like the first address. */
async function request(url, method, headers) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
    const r = await ask(u, method, headers);
    if (r.status < 300 || r.status >= 400 || !r.location) return r.status;
    u = new URL(r.location, u);
  }
  return 0;
}

async function probe(url) {
  const headers = { "User-Agent": UA, Accept: "*/*" };
  try {
    let status = await request(url, "HEAD", headers);
    // Many sites refuse HEAD; ask for the first kilobyte instead.
    if ([400, 403, 405, 406, 501].includes(status)) status = await request(url, "GET", { ...headers, Range: "bytes=0-1023" });
    return status;
  } catch {
    return 0; // DNS failure, refused, timeout, or not a public address
  }
}

function classify(status) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 404 || status === 410) return "dead";
  if ([401, 403, 429].includes(status)) return "blocked";
  return "error";
}

export async function checkLink(link) {
  let host;
  try {
    host = new URL(link.url).host;
  } catch {
    host = null;
  }
  const status = host ? await probe(link.url) : 0;
  const cls = host ? classify(status) : "dead";
  let next = link.status;
  let fails = link.fail_count ?? 0;
  if (cls === "ok" || cls === "blocked") {
    next = cls;
    fails = 0;
  } else {
    fails += 1;
    if ((cls === "dead" && fails >= 2) || fails >= 3 || !host) next = "dead";
  }
  // A failure that isn't final yet is tried again in a few hours rather than next week.
  const soon = next !== "dead" && cls !== "ok" && cls !== "blocked";
  // A probe can take a minute. If a member fixed the link in that time (it has another address now, and was queued
  // for a fresh check), what this probe found is about the old address: dropped, not stamped on the fixed link.
  const { rowCount } = await q(
    `UPDATE links SET status = $2, http_status = $3, fail_count = $4,
       checked_at = CASE WHEN $5 THEN now() - interval '7 days' + interval '6 hours' ELSE now() END,
       seq = nextval('change_seq')
     WHERE id = $1 AND url = $6 AND NOT deleted`,
    [link.id, next, status || null, fails, soon, link.url],
  );
  return { status, result: next, dropped: !rowCount };
}

export function startChecker({ everyMs = 60_000, batch = 12 } = {}) {
  let busy = false;
  const lastHit = new Map();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await q(
        `SELECT id, url, status, fail_count FROM links
         WHERE NOT deleted AND (checked_at IS NULL OR checked_at < now() - interval '7 days')
         ORDER BY checked_at NULLS FIRST LIMIT $1`,
        [batch],
      );
      for (const link of rows) {
        let host = "";
        try {
          host = new URL(link.url).host;
        } catch {
          /* checkLink marks it dead */
        }
        const wait = (lastHit.get(host) ?? 0) + 3000 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await checkLink(link);
        lastHit.set(host, Date.now());
      }
    } catch (e) {
      console.error("link checker:", e.message);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 10_000);
  return setInterval(tick, everyMs);
}
