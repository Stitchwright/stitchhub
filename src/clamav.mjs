// Virus scanning with ClamAV's daemon (clamd), over its plain TCP protocol: no dependency, one connection per scan.
//   CLAMAV_HOST         the clamd service's host (on Railway: its private name, e.g. clamav.railway.internal). Unset: no scanning.
//   CLAMAV_PORT         3310 (clamd's default)
//   CLAMAV_TIMEOUT_MS   how long one scan may take (default 60000)
//   CLAMAV_REQUIRED     true (the default once CLAMAV_HOST is set): a file that could not be scanned is not taken, and the sender
//                       is asked to try again; false: it is taken and marked "not scanned" for the owner to see
// What is scanned: manual PDFs offered to the repository (src/repository.mjs) and the design files and pictures of MakerFoundry
// orders (src/sync.mjs, /v2/files/done). The protocol is INSTREAM (clamd.conf: StreamMaxLength must be at least the biggest file,
// REPO_MAX_MB, 150 by default; a file clamd refuses for size counts as "could not be scanned").
import net from "node:net";

export function clamavConfig(env = process.env) {
  const host = (env.CLAMAV_HOST ?? "").trim();
  if (!host) return null;
  const port = Number(env.CLAMAV_PORT);
  const ms = Number(env.CLAMAV_TIMEOUT_MS);
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3310,
    timeoutMs: Number.isFinite(ms) && ms >= 1000 ? Math.min(ms, 600_000) : 60_000,
    required: !/^(0|false|off|no)$/i.test((env.CLAMAV_REQUIRED ?? "").trim()),
  };
}

const CHUNK = 64 * 1024;

/** What clamd said, as a result: { ok } | { infected: "Signature.Name" } | { unavailable: "why" }. */
function parseAnswer(text) {
  const t = text.replace(/\0/g, "").trim();
  if (/^stream:\s*OK$/i.test(t)) return { ok: true };
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(t);
  // The signature's name goes into words the sender reads: letters, digits and . _ + - only.
  if (found) return { infected: found[1].replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 80) || "unknown" };
  if (/size limit exceeded/i.test(t)) return { unavailable: "the file is bigger than the scanner's StreamMaxLength" };
  return { unavailable: t ? "the scanner answered something unexpected" : "the scanner gave no answer" };
}

/** Talks to clamd: sends `request`, then `body` as INSTREAM chunks when given, and gives back everything it answered. */
function talk(cfg, request, body) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    let out = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(cfg.timeoutMs, () => finish({ error: "the scan timed out" }));
    sock.on("data", (d) => (out += d.toString("latin1")));
    // clamd may answer and close while we are still writing (a size limit): what it said is the answer.
    sock.on("error", (e) => finish(out ? { text: out } : { error: e.code ?? "the scanner could not be reached" }));
    sock.on("close", () => finish(out ? { text: out } : { error: "the scanner closed the connection" }));
    sock.on("connect", async () => {
      try {
        sock.write(request);
        if (body) {
          for (let i = 0; i < body.length && !settled; i += CHUNK) {
            const part = body.subarray(i, Math.min(i + CHUNK, body.length));
            const head = Buffer.alloc(4);
            head.writeUInt32BE(part.length);
            if (!sock.write(Buffer.concat([head, part]))) await new Promise((r) => sock.once("drain", r).once("close", r));
          }
          if (!settled) sock.write(Buffer.alloc(4)); // a zero length ends the stream
        }
      } catch {
        // the socket's own error handler answers
      }
    });
  });
}

/** Scans bytes. { skipped: true } when scanning is not set up; otherwise { ok } | { infected } | { unavailable }. */
export async function scanBuffer(bytes, cfg = clamavConfig()) {
  if (!cfg) return { skipped: true };
  const r = await talk(cfg, "zINSTREAM\0", Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return r.error ? { unavailable: r.error } : parseAnswer(r.text);
}

/** For the admin: is the scanner there, and which engine and signature database does it run? */
export async function clamavStatus(cfg = clamavConfig()) {
  if (!cfg) return { configured: false };
  const ping = await talk(cfg, "zPING\0");
  if (ping.error || !/^PONG/.test(ping.text.replace(/\0/g, "").trim())) return { configured: true, reachable: false, why: ping.error ?? "no PONG" };
  const v = await talk(cfg, "zVERSION\0");
  return { configured: true, reachable: true, required: cfg.required, version: v.error ? null : v.text.replace(/\0/g, "").trim().slice(0, 120) };
}
