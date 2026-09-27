// Checks manual links in the background: about once a week each, a dozen a minute, gently per site.
// ok = the file answers; dead = 404/410 twice, or unreachable three times; blocked = the site refuses robots (403/429),
// so a person has to try it in a browser. Every check bumps the row so installs see the new status.
// A link is a public web address and nothing else: the checker never contacts the hub's own network (see privateAddress),
// on the first hop or after a redirect, so a member can't use it to find out what answers in there.
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { q } from "./db.mjs";

const UA = process.env.CHECKER_USER_AGENT ?? "StitchHub-LinkChecker/1.0 (community manual catalog; checks that links still work)";
const MAX_HOPS = 5; // redirects followed, each checked like the first address

// Addresses the checker must never contact: this machine, a home or office network, Railway's private services
// (*.railway.internal resolves to these), link-local, carrier NAT, and IPv4 addresses written as IPv6.
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) {
    const rest = v6.slice(7);
    if (net.isIPv4(rest)) return privateAddress(rest);
    const [h, l] = rest.split(":").map((x) => parseInt(x, 16)); // the same, written in hex
    return privateAddress(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
  }
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith("64:ff9b:") || v6.startsWith("2002:");
}

/** The public addresses a link's host resolves to; null when it's private, local, or doesn't resolve. */
async function publicAddresses(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|internal|local|home\.arpa)$/.test(host)) return null;
  if (net.isIP(host)) return privateAddress(host) ? null : [{ address: host, family: net.isIP(host) }];
  let found;
  try {
    found = await dns.lookup(host, { all: true });
  } catch {
    return null;
  }
  return found.length && !found.some((a) => privateAddress(a.address)) ? found : null;
}

// One request, connected to the addresses just checked (not to whatever the name resolves to a moment later).
function hit(u, method, addresses) {
  const lookup = (host, opts, cb) => (opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family));
  const headers = { "User-Agent": UA, Accept: "*/*", ...(method === "GET" ? { Range: "bytes=0-1023" } : {}) };
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(u, { method, headers, lookup, agent: false, signal: AbortSignal.timeout(20_000) }, (res) => {
      resolve({ status: res.statusCode, location: res.headers.location });
      res.on("error", () => {});
      res.destroy(); // only the status matters; don't download the manual
    });
    req.on("error", reject);
    req.end();
  });
}

// Follows redirects one hop at a time so every address gets the same check. 0 for anything it can't or won't reach.
async function request(url, method) {
  let u = new URL(url);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const addresses = await publicAddresses(u.hostname);
    if (!addresses) return 0;
    const r = await hit(u, method, addresses);
    if (![301, 302, 303, 307, 308].includes(r.status) || !r.location) return r.status;
    u = new URL(r.location, u); // a bad Location throws, and probe answers 0
    if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
  }
  return 0; // going round in circles
}

async function probe(url) {
  try {
    let status = await request(url, "HEAD");
    // Many sites refuse HEAD; ask for the first kilobyte instead.
    if ([400, 403, 405, 406, 501].includes(status)) status = await request(url, "GET");
    return status;
  } catch {
    return 0; // DNS failure, refused, timeout
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
  await q(
    `UPDATE links SET status = $2, http_status = $3, fail_count = $4,
       checked_at = CASE WHEN $5 THEN now() - interval '7 days' + interval '6 hours' ELSE now() END,
       seq = nextval('change_seq')
     WHERE id = $1`,
    [link.id, next, status || null, fails, soon],
  );
  return { status, result: next };
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
