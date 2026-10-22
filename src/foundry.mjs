// The Foundry Account service (cloud.stitchfoundry.app; code and docs in github.com/Stitchwright/StitchFoundry, apps/stitchfoundry-cloud
// and docs/cloud.md) as the hub uses it: one login for all SiteSentrix software (docs/plan.md FA-1 and FA-2).
//
// The hub signs in to the service only to learn WHO the person is (the account's lasting id) and then ends that session at once. It
// never keeps the service's session token: the hub makes no AI requests and spends no credits, so there is nothing a token would be
// for here, and nothing worth stealing in its database. Who a hub account is comes from the id, never from the email: the service
// doesn't verify email at sign-up yet, so anyone can make a Foundry Account for someone else's address.
//
//   FOUNDRY_SIGNIN  unset or "off"  accounts work exactly as before
//                   "on"            the Foundry Account beside the hub's own email and password; both work
//                   "only"          the hub password no longer signs anyone in and none is asked for or set; an emailed link proves the
//                                   address and links the Foundry Account (src/accounts.mjs)
//   FOUNDRY_CLOUD_URL  the service's address (https, or http for this computer); default https://cloud.stitchfoundry.app

const DEFAULT_URL = "https://cloud.stitchfoundry.app";
const QUICK_MS = 15_000;
const MAX_ANSWER = 2_000_000;

export function foundryMode() {
  const v = (process.env.FOUNDRY_SIGNIN ?? "").trim().toLowerCase();
  return v === "on" || v === "only" ? v : "off";
}

/** The service's address under the same rule as the programs': https, or http for this computer; nothing else in it. */
export function cloudUrl() {
  const raw = (process.env.FOUNDRY_CLOUD_URL ?? "").trim() || DEFAULT_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("FOUNDRY_CLOUD_URL isn't a web address.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("FOUNDRY_CLOUD_URL starts with https://");
  if (u.username || u.password || u.search || u.hash) throw new Error("FOUNDRY_CLOUD_URL has something in it that doesn't belong.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The service said no, or couldn't be reached. status is 0 when there was no answer. kind: offline | wrong | wait | refused | not-open | broken. */
export class FoundryError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = "FoundryError";
    this.status = status;
    this.kind = kind;
  }
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function failure(status, body) {
  // The service's own sentence ({ type: "error", error: { type, message } }), cut short and started with a capital.
  const raw = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "";
  const said = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
  if (status === 401) return new FoundryError(said || "That Foundry Account email and password don't match.", status, "wrong");
  if (status === 429) return new FoundryError(said || "Too many tries. Wait a little and try again.", status, "wait");
  if (status === 503) return new FoundryError(said || "That isn't open on the Foundry Account service yet.", status, "not-open");
  if (status === 400 || status === 404 || status === 409) return new FoundryError(said || "The Foundry Account service didn't accept that.", status, "refused");
  return new FoundryError("The Foundry Account service had a problem. Try again in a minute.", status, "broken");
}

async function call(method, path, { token, body, ms = QUICK_MS, base = cloudUrl(), fetchImpl = fetch } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  let text;
  try {
    res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(ms) });
    text = await res.text();
  } catch {
    throw new FoundryError("The hub can't reach the Foundry Account service just now. Check back in a minute.", 0, "offline");
  }
  if (text.length > MAX_ANSWER) throw new FoundryError("The Foundry Account service answered more than the hub will read.", res.status, "broken");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status >= 300 && res.status < 400) throw new FoundryError("The Foundry Account service moved. Tell the hub admin.", res.status, "broken");
  if (!res.ok) throw failure(res.status, json);
  return json;
}

function sessionOf(json) {
  if (!isRecord(json) || typeof json.token !== "string" || !/^sfs_[0-9a-f]{64}$/.test(json.token) || !isRecord(json.account) || !Number.isSafeInteger(json.account.id) || json.account.id < 1) {
    throw new FoundryError("The Foundry Account service answered something the hub doesn't understand.", 0, "broken");
  }
  return { token: json.token, id: json.account.id };
}

/**
 * Proves who someone is: signs in to the service (or makes the account, `create`) and answers the account's id, then ends that
 * session at once (best effort: the hub keeps no token). Throws a FoundryError.
 */
export async function proveAccount(email, password, { create = false, ...o } = {}) {
  const s = sessionOf(await call("POST", create ? "/v1/signup" : "/v1/signin", { ...o, body: { email, password } }));
  try {
    await call("POST", "/v1/signout", { ...o, token: s.token, body: {}, ms: 5000 });
  } catch {
    // Offline or already ended: we hold nothing either way.
  }
  return { id: s.id };
}

/** Asks the service to email a Foundry Account password-reset link. The same answer whether or not the address has an account. */
export async function foundryForgot(email, o = {}) {
  const json = await call("POST", "/v1/password/forgot", { ...o, body: { email } });
  return { sent: isRecord(json) && json.sent === true, message: isRecord(json) && typeof json.message === "string" ? json.message.slice(0, 300) : "" };
}

/**
 * Who a service token (the "sfs_..." StitchFoundry holds after sign-in) belongs to: the account's id, asked of the service itself
 * and never remembered. Throws a FoundryError (kind "wrong" when the service doesn't know the token).
 */
export async function accountOfToken(token, o = {}) {
  const json = await call("POST", "/v1/account", { ...o, token, body: {} });
  if (!isRecord(json) || !Number.isSafeInteger(json.id) || json.id < 1) throw new FoundryError("The Foundry Account service answered something the hub doesn't understand.", 0, "broken");
  return { id: json.id };
}
