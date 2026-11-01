// A stand-in for clamd that speaks its null-terminated command protocol (zPING, zVERSION, zINSTREAM) and calls a stream
// infected when it holds the EICAR antivirus test string (the industry's harmless test file, written out below in pieces).
import net from "node:net";

export const EICAR = Buffer.from(["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "!$H+H*"].join(""), "latin1");

export function startFakeClamd({ limit = 25 * 1024 * 1024 } = {}) {
  const seen = { scans: 0, bytes: 0, pings: 0 };
  const knobs = { mode: "normal" }; // normal | silent (accepts and never answers) | garbage
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let streaming = false;
    let total = 0;
    const parts = [];
    sock.on("error", () => {});
    sock.on("data", (d) => {
      if (knobs.mode === "silent") return;
      buf = Buffer.concat([buf, d]);
      if (!streaming) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const cmd = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (cmd === "zPING") {
          seen.pings++;
          return void sock.end("PONG\0");
        }
        if (cmd === "zVERSION") return void sock.end("ClamAV 1.4.0-test/1/Mon Nov  1 00:00:00 2026\0");
        if (cmd !== "zINSTREAM") return void sock.end("UNKNOWN COMMAND\0");
        streaming = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          seen.scans++;
          seen.bytes += total;
          if (knobs.mode === "garbage") return void sock.end("what is this\0");
          const body = Buffer.concat(parts);
          return void sock.end(body.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
        }
        if (buf.length < 4 + n) return;
        parts.push(buf.subarray(4, 4 + n));
        total += n;
        buf = buf.subarray(4 + n);
        if (total > limit) return void sock.end("INSTREAM size limit exceeded. ERROR\0");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, seen, knobs, close: () => new Promise((r) => server.close(r)) })));
}
