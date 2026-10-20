// A stand-in for the Foundry Account service (cloud.stitchfoundry.app, github.com/Stitchwright/StitchFoundry apps/stitchfoundry-cloud,
// docs/cloud.md) as the hub uses it: sign up, sign in, sign out and "forgot my password". node:http only; nothing touches real accounts.
// It follows the real service's rules (checked 2026-10-19): the email is trimmed and lower-cased and needs an @ and a dot after it; a
// password needs 8 characters; a second sign-up for an email is 409; five wrong passwords in a row lock that email (429); a token is
// "sfs_" and 64 hex digits; errors are { type: "error", error: { type, message } }. Test hooks (no auth): GET /__sent (reset emails the
// service would have sent), GET /__sessions (how many sessions are open: the hub must leave none), POST /__seed { email, password }
// (make an account), DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";

const MAX_WRONG = 5;
const cleanEmail = (v) => {
  const e = String(v ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".") && e.length <= 254 && !/[\s\u0000-\u001f]/.test(e) ? e : null;
};
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

export async function startFoundryMock({ port = 0, firstId = 1 } = {}) {
  const accounts = new Map(); // email -> { id, email, password, wrong }
  const sessions = new Map(); // token -> account
  const sent = [];
  let nextId = firstId;
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, type, message) => send(res, status, { type: "error", error: { type, message } });
  const open = (res, a) => {
    const token = `sfs_${crypto.randomBytes(32).toString("hex")}`;
    sessions.set(token, a);
    send(res, 200, { token, account: { id: a.id, email: a.email, credits: 100 } });
  };
  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${new URL(req.url, "http://x").pathname}`;
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = null;
    }
    if (route === "GET /__sent") return send(res, 200, sent);
    if (route === "GET /__sessions") return send(res, 200, { open: sessions.size });
    if (route === "DELETE /__state") {
      accounts.clear();
      sessions.clear();
      sent.length = 0;
      return send(res, 200, { ok: true });
    }
    if (route === "POST /__seed") {
      const email = cleanEmail(body?.email);
      const made = { id: nextId++, email, password: String(body?.password), wrong: 0 };
      accounts.set(email, made);
      return send(res, 200, { id: made.id });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return error(res, 400, "invalid_request_error", "the body is a JSON object");
    if (route === "POST /v1/signup" || route === "POST /v1/signin") {
      const email = cleanEmail(body.email);
      if (!email) return error(res, 400, "invalid_request_error", "give a real email address");
      const password = String(body.password ?? "");
      const a = accounts.get(email);
      if (route === "POST /v1/signup") {
        if (password.length < 8) return error(res, 400, "invalid_request_error", "a password needs at least 8 characters");
        if (a) return error(res, 409, "invalid_request_error", "there is already an account with that email: sign in");
        const made = { id: nextId++, email, password, wrong: 0 };
        accounts.set(email, made);
        return open(res, made);
      }
      if (a && a.wrong >= MAX_WRONG) return error(res, 429, "rate_limit_error", "too many wrong passwords: wait 15 minutes and try again");
      if (!a || a.password !== password) {
        if (a) a.wrong += 1;
        return error(res, 401, "authentication_error", "that email and password don't match");
      }
      a.wrong = 0;
      return open(res, a);
    }
    if (route === "POST /v1/password/forgot") {
      const email = cleanEmail(body.email);
      if (!email) return error(res, 400, "invalid_request_error", "give a real email address");
      if (accounts.has(email)) sent.push({ to: email });
      return send(res, 200, { sent: true, message: "If there's a Foundry account with that email, a link to reset its password is on its way. It works for an hour." });
    }
    if (route === "POST /v1/signout") {
      const t = /^Bearer (sfs_[0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      if (!t || !sessions.has(t)) return error(res, 401, "authentication_error", "your sign-in has ended: sign in again");
      sessions.delete(t);
      return send(res, 200, {});
    }
    return error(res, 404, "not_found_error", "no such route");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const bound = server.address().port;
  return { url: `http://127.0.0.1:${bound}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
