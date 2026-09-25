// Checks manual links in the background: about once a week each, a dozen a minute, gently per site.
// ok = the file answers; dead = 404/410 twice, or unreachable three times; blocked = the site refuses robots (403/429),
// so a person has to try it in a browser. Every check bumps the row so installs see the new status.
import { q } from "./db.mjs";

const UA = process.env.CHECKER_USER_AGENT ?? "StitchHub-LinkChecker/1.0 (community manual catalog; checks that links still work)";

async function probe(url) {
  const base = { redirect: "follow", headers: { "User-Agent": UA, Accept: "*/*" } };
  try {
    let r = await fetch(url, { ...base, method: "HEAD", signal: AbortSignal.timeout(20_000) });
    if ([400, 403, 405, 406, 501].includes(r.status)) {
      // Many sites refuse HEAD; ask for the first kilobyte instead.
      r = await fetch(url, { ...base, method: "GET", headers: { ...base.headers, Range: "bytes=0-1023" }, signal: AbortSignal.timeout(20_000) });
      await r.body?.cancel().catch(() => {});
    }
    return r.status;
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
