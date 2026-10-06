// Signatures on partner messages and invites (stitchbench src/lib/partner-signing.ts is the other copy: the two must
// build the same strings). Ed25519; a public key travels as base64 of its SPKI DER; a message is signed over
//   SBPM1 \n link id \n sender's side \n type \n message id \n sequence \n timestamp \n sha256 of the canonical data
// so a changed payload, type, id, link or sender fails, and a replay under another id fails too. The hub checks these
// before it counts a message toward the real-partnership rule; the programs check them again themselves.
import crypto from "node:crypto";

/** JSON with every object's keys sorted: the same text on both sides whatever order a database gives the keys back in. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}

export const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

const publicKeyOf = (b64) => {
  if (typeof b64 !== "string" || b64.length > 200) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
};

/** Shown in groups for two people to read to each other: the first 10 bytes of the key's sha256. */
export function fingerprint(pubB64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(pubB64, "base64")).digest("hex").slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g).join("-");
}

export const isPublicKey = (b64) => publicKeyOf(b64) !== null;

function verifyText(pubB64, text, sigB64) {
  const key = publicKeyOf(pubB64);
  if (!key || typeof sigB64 !== "string" || sigB64.length > 200) return false;
  try {
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export const messageText = (m) =>
  ["SBPM1", m.linkId, m.fromSide, m.type, m.id, m.seq, m.ts, sha256hex(canonical(m.data))].join("\n");

/** The envelope's shape, or null. `seq` is kept as text (it is a millisecond clock, past 32 bits). */
export function sigShape(s) {
  if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1) return null;
  const { pub, seq, ts, sig } = s;
  if (typeof pub !== "string" || typeof sig !== "string" || !/^\d{1,18}$/.test(String(seq)) || typeof ts !== "string" || ts.length > 40 || Number.isNaN(Date.parse(ts))) return null;
  return { v: 1, pub, seq: String(seq), ts, sig };
}

/** True when `env` is the sender's valid signature over this message. */
export function verifyMessage(env, m) {
  const s = sigShape(env);
  return !!s && verifyText(s.pub, messageText({ ...m, seq: s.seq, ts: s.ts }), s.sig);
}

export const inviteText = (o) => ["SBINV1", fingerprint(o.pub), o.side, o.shopRef, sha256hex(canonical(o.terms ?? {})), o.issuedAt].join("\n");
export const redeemText = (o) => ["SBRDM1", o.codeHash, o.side, o.shopRef, o.issuedAt].join("\n");

export const verifyInvite = (pub, o, proof) => !!proof && typeof proof.issuedAt === "string" && verifyText(pub, inviteText({ ...o, pub, issuedAt: proof.issuedAt }), proof.sig);
export const verifyRedeem = (pub, o, proof) => !!proof && typeof proof.issuedAt === "string" && verifyText(pub, redeemText({ ...o, issuedAt: proof.issuedAt }), proof.sig);
