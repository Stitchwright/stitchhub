// Sending the hub's own email (account links: set a password, verify an address, reset a password). One mailbox the
// hub admin controls, given as SMTP_URL (smtps://user:pass@host:465, or smtp://user:pass@host:587 for STARTTLS) and
// MAIL_FROM. A plain SMTP client on Node's own sockets: the hub sends a few short text messages and doesn't need a
// mail library for that. Nothing from SMTP_URL is ever logged; errors carry the server's reply words only.
// For a test hub with no mailbox, MAIL_DEV_LOG=true prints each message (links included) to the hub's log instead.
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const SMTP_URL = process.env.SMTP_URL ?? "";
const MAIL_FROM = (process.env.MAIL_FROM ?? "").trim();
const DEV_LOG = process.env.MAIL_DEV_LOG === "true";
const TIMEOUT = 20_000; // per reply from the server
const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

/** Why the hub can't send mail, or null when it can. */
export function mailProblem() {
  if (DEV_LOG && !SMTP_URL) return null;
  if (!SMTP_URL || !MAIL_FROM) return "This hub can't send email yet: SMTP_URL and MAIL_FROM aren't set.";
  try {
    const u = new URL(SMTP_URL);
    if (!/^smtps?:$/.test(u.protocol) || !u.hostname) throw new Error();
  } catch {
    return "SMTP_URL isn't a mail server address (smtps://user:pass@host:465).";
  }
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(MAIL_FROM)) return "MAIL_FROM isn't an email address.";
  return null;
}

/** RFC 2047 encoded word, so a subject or a name in any language travels as plain ASCII. */
const encodedWord = (s) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();

/** The raw message: a few ASCII headers and a base64 text body (no line of it can look like the end-of-data mark). */
function compose({ to, subject, text, fromName }) {
  const host = new URL(SMTP_URL || "smtp://localhost").hostname || "localhost";
  const body = Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${encodedWord(clean(fromName))} <${MAIL_FROM}>`,
    `To: <${to}>`,
    `Subject: ${encodedWord(clean(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

class MailError extends Error {
  constructor(stage, reply) {
    super(`mail: ${stage} failed${reply ? ` (${reply})` : ""}`);
  }
}

/** One SMTP session: reads the server's replies line by line and sends one command at a time. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.buf = "";
    this.waiting = null;
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      this.buf += d;
      this.take();
    });
    const fail = (why) => this.waiting?.reject(new MailError(this.waiting.stage, why));
    socket.on("error", (e) => fail(e.code ?? "connection error"));
    socket.on("close", () => fail("the connection closed"));
    socket.on("timeout", () => {
      fail("no answer");
      socket.destroy();
    });
    socket.setTimeout(TIMEOUT);
  }
  // A reply is complete at a line "250 ..." (a space after the code); "250-..." lines continue it.
  take() {
    if (!this.waiting) return;
    const m = /^(\d{3}) [^\n]*\n/m.exec(this.buf);
    if (!m) return;
    const end = m.index + m[0].length;
    const lines = this.buf.slice(0, end).split(/\r?\n/).filter(Boolean);
    this.buf = this.buf.slice(end);
    const w = this.waiting;
    this.waiting = null;
    w.resolve({ code: Number(m[1]), lines });
  }
  reply(stage) {
    return new Promise((resolve, reject) => {
      this.waiting = { stage, resolve, reject };
      this.take();
    });
  }
  async command(stage, line, okCodes) {
    this.socket.write(`${line}\r\n`);
    const r = await this.reply(stage);
    if (!okCodes.includes(r.code)) throw new MailError(stage, r.lines[r.lines.length - 1]?.slice(0, 160));
    return r;
  }
  /** Replace the plain socket with a TLS one over it (after STARTTLS). */
  upgrade(servername) {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners();
      const secure = tls.connect({ socket: plain, servername: net.isIP(servername) ? undefined : servername, minVersion: "TLSv1.2" }, () => {
        this.socket = secure;
        this.buf = "";
        secure.setEncoding("utf8");
        secure.on("data", (d) => {
          this.buf += d;
          this.take();
        });
        secure.on("error", (e) => this.waiting?.reject(new MailError(this.waiting.stage, e.code ?? "TLS error")));
        secure.on("close", () => this.waiting?.reject(new MailError(this.waiting.stage, "the connection closed")));
        secure.setTimeout(TIMEOUT, () => {
          this.waiting?.reject(new MailError(this.waiting.stage, "no answer"));
          secure.destroy();
        });
        resolve();
      });
      secure.once("error", (e) => reject(new MailError("STARTTLS", e.code ?? "TLS error")));
    });
  }
}

function connect(u) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const secure = u.protocol === "smtps:";
  const port = Number(u.port) || (secure ? 465 : 587);
  return new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: "TLSv1.2" }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.once("error", (e) => reject(new MailError("connecting to the mail server", e.code ?? "connection error")));
  });
}

async function deliver(to, raw) {
  const u = new URL(SMTP_URL);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const socket = await connect(u);
  const s = new Session(socket);
  try {
    const greet = await s.reply("greeting");
    if (greet.code !== 220) throw new MailError("greeting", greet.lines[0]);
    let ehlo = await s.command("EHLO", "EHLO stitchhub", [250]);
    if (u.protocol === "smtp:") {
      if (ehlo.lines.some((l) => /^250[- ]STARTTLS/i.test(l))) {
        await s.command("STARTTLS", "STARTTLS", [220]);
        await s.upgrade(host);
        ehlo = await s.command("EHLO", "EHLO stitchhub", [250]);
      } else if (!LOCAL.has(host)) {
        // A password never goes over a plain connection to a server on the internet.
        throw new MailError("STARTTLS", "the mail server doesn't offer encryption; use smtps:// or a server that does");
      }
    }
    const user = decodeURIComponent(u.username ?? "");
    const pass = decodeURIComponent(u.password ?? "");
    if (user) await s.command("signing in", `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64")}`, [235]);
    await s.command("MAIL FROM", `MAIL FROM:<${MAIL_FROM}>`, [250]);
    await s.command("RCPT TO", `RCPT TO:<${to}>`, [250, 251]);
    await s.command("DATA", "DATA", [354]);
    await s.command("sending the message", `${raw}\r\n.`, [250]);
    s.socket.write("QUIT\r\n");
  } finally {
    s.socket.end();
    s.socket.destroy();
  }
}

/**
 * Send one plain-text message. Throws a MailError whose message names the stage and the server's reply (never the
 * server, user or password). With MAIL_DEV_LOG=true and no SMTP_URL the message is printed to the hub's log instead.
 */
export async function sendMail({ to, subject, text, fromName = "StitchHub" }) {
  if (!SMTP_URL && DEV_LOG) {
    console.log(`mail (not sent, MAIL_DEV_LOG): to ${to}\nsubject: ${subject}\n${text}`);
    return;
  }
  const problem = mailProblem();
  if (problem) throw new MailError("setup", problem);
  await deliver(to, compose({ to, subject, text, fromName }));
}
