// Signing StitchBench license keys for the program itself (module "base"), as StitchBench's src/lib/license.ts reads
// them: `SB1.<base64url payload JSON>.<base64url Ed25519 signature over the payload bytes>`. The private half is
// HUB_LICENSE_KEY (the PEM, or the PEM base64-encoded, as `npm run license:keygen -- --kid hub1 --hub` prints it) and
// its kid is HUB_LICENSE_KID; the public half is compiled into both programs (license-keys.ts, scope "hub"). Anyone with
// the private half can license any shop, so it lives only in the hub's variables and is never logged.
import crypto from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const NO_END = "2099-12-31";

/** A key id as the program expects it: 8 letters and digits from the Crockford alphabet (/^[0-9A-Z]{6,20}$/). */
export function newKeyId() {
  return [...crypto.randomBytes(8)].map((b) => CROCKFORD[b % 32]).join("");
}

/** The key text for a payload: exactly encodeLicense in license.ts. */
export function encodeLicense(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `SB1.${bytes.toString("base64url")}.${crypto.sign(null, bytes, privateKey).toString("base64url")}`;
}

function readPrivateKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const pem = text.startsWith("-----") ? text.replace(/\\n/g, "\n") : Buffer.from(text, "base64").toString("utf8");
  try {
    const key = crypto.createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

let memo;
/**
 * The hub's signer from HUB_LICENSE_KID and HUB_LICENSE_KEY: { kid, key, x } (x is the public half as it appears in
 * license-keys.ts, printed at start so the owner can compare), or null with `problem` saying why not.
 */
export function signer() {
  if (memo !== undefined) return memo;
  const kid = (process.env.HUB_LICENSE_KID ?? "").trim();
  const raw = process.env.HUB_LICENSE_KEY ?? "";
  if (!kid && !raw.trim()) return (memo = { signer: null, problem: "HUB_LICENSE_KID and HUB_LICENSE_KEY aren't set: the hub issues no keys, so standing changes nothing in the program." });
  if (!/^[a-z][a-z0-9]{0,15}$/.test(kid)) return (memo = { signer: null, problem: "HUB_LICENSE_KID isn't a kid (a short lower-case word like hub1)." });
  const key = readPrivateKey(raw);
  if (!key) return (memo = { signer: null, problem: "HUB_LICENSE_KEY isn't an Ed25519 private key (the PEM from `npm run license:keygen -- --kid hub1 --hub`, base64)." });
  const x = crypto.createPublicKey(key).export({ format: "jwk" }).x;
  return (memo = { signer: { kid, key, x }, problem: null });
}

/**
 * Sign one key for a shop. `f` and `u` are YYYY-MM-DD (u >= f), `g` days of grace, `p` the plan letter
 * (t trial, m monthly, y yearly, c comped, w waived). Returns { id, key, payload }.
 */
export function signKey(s, { shopId, shopName, modules = ["base"], plan, firstDay, lastDay, graceDays = 14 }) {
  if (lastDay < firstDay) throw new Error(`a key can't end (${lastDay}) before it starts (${firstDay})`);
  const payload = { v: 1, k: s.kid, id: newKeyId(), s: shopId, n: String(shopName ?? "").slice(0, 120), m: modules, p: plan, f: firstDay, u: lastDay, g: graceDays, t: new Date().toISOString() };
  return { id: payload.id, key: encodeLicense(payload, s.key), payload };
}
