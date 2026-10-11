// Room for the pictures members keep on the hub, all in the database (bytea): note photos, listing photos, figure
// snapshots and the screens sent with Help. The hourly request limits alone would let one install store about 100 GB an
// hour and fill the database's disk, so what is kept is limited too, counted over the pictures on the hub now (a removed
// note or listing has no photos left, a removed figure no bytes, a Help picture is cleared 90 days after it is done):
//   MEDIA_QUOTA_COMPANY_MB (1024)   a company: an install and the company its rows are kept under
//   MEDIA_QUOTA_INSTALL_MB (10240)  an install, all its companies together (a hosted program serves many)
//   MEDIA_QUOTA_HUB_GB (50)         the whole hub: past it nobody's new pictures are taken, and the log says so at most
//                                   once an hour; the admin page shows the total against it
// octet_length reads each picture's stored size from its header, so the sums don't read the pictures themselves.
import { pool } from "./db.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const limit = (name, byDefault, unit) => Math.round((Number(process.env[name]) > 0 ? Number(process.env[name]) : byDefault) * unit);
export const MEDIA_LIMITS = { company: limit("MEDIA_QUOTA_COMPANY_MB", 1024, MB), install: limit("MEDIA_QUOTA_INSTALL_MB", 10240, MB), hub: limit("MEDIA_QUOTA_HUB_GB", 50, GB) };

/** A size in words: "1 GB", "1.5 GB", "512 MB". */
export const sizeWords = (bytes) => (bytes >= GB ? `${+(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);

// Every picture of one install ($1), with the company it is kept under ('' where its program named none). $3: a figure
// being replaced, whose old copy doesn't count.
const INSTALL_PICTURES = `
  SELECT p.shop_ref AS ref, octet_length(ph.data) AS n FROM photos ph JOIN posts p ON p.id = ph.post_id WHERE p.install_id = $1
  UNION ALL SELECT l.shop_ref, octet_length(lp.data) FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id WHERE l.install_id = $1
  UNION ALL SELECT coalesce(f.shop_ref, ''), octet_length(f.data) FROM figures f WHERE f.install_id = $1 AND NOT f.deleted AND f.id <> $3
  UNION ALL SELECT fb.shop_ref, octet_length(fb.picture) FROM feedback fb WHERE fb.install_id = $1 AND fb.picture IS NOT NULL`;
const HUB_PICTURES = `SELECT (SELECT coalesce(sum(octet_length(data)), 0) FROM photos) + (SELECT coalesce(sum(octet_length(data)), 0) FROM listing_photos)
  + (SELECT coalesce(sum(octet_length(data)), 0) FROM figures WHERE NOT deleted) + (SELECT coalesce(sum(octet_length(picture)), 0) FROM feedback) AS n`;

// The whole hub's total sums every picture on it, so it is read again only every ten minutes, or after pictures were
// removed or imported (a reading that started before that is not kept); what is kept in between is counted on. An upload
// reads it on its own connection (`db`): asking the pool for a second one while holding the first could wait for good
// when every connection is held by an upload.
let hubTotal = null; // { bytes, at }
let generation = 0;
async function hubBytes(db, fresh = false) {
  if (!fresh && hubTotal && Date.now() - hubTotal.at < 600_000) return hubTotal.bytes;
  const started = generation;
  const bytes = Number((await db.query(HUB_PICTURES)).rows[0].n);
  if (started === generation) hubTotal = { bytes, at: Date.now() };
  return bytes;
}

/** Pictures were stored (`bytes` more, or fewer when negative: a figure redrawn smaller). */
export function mediaKept(bytes) {
  if (hubTotal) hubTotal.bytes += bytes;
}

/** Pictures were removed (or imported): the hub's total is read again before the next upload. */
export function mediaChanged() {
  generation++;
  hubTotal = null;
}

let warnedAt = 0;

/**
 * Whether `bytes` more pictures fit for company `ref` ('' for none) of install `installId`: null when they do, else the
 * refusal in words. Run it in the transaction that stores them: from here to its commit the install's uploads take
 * turns, so two can't both fit in the last of its room. `figure`: the id of a figure this upload replaces.
 */
export async function mediaFull(client, { installId, ref, bytes, figure = "" }) {
  // Two keys: their own space, apart from the hub's one-key locks (the writer lock is held for as long as the hub runs).
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('stitchhub:media'), hashtext($1))`, [installId]);
  const kept = (
    await client.query(
      `SELECT coalesce(sum(n), 0)::bigint AS install, coalesce(sum(n) FILTER (WHERE ref = $2), 0)::bigint AS company FROM (${INSTALL_PICTURES}) m`,
      [installId, ref ?? "", figure],
    )
  ).rows[0];
  if (Number(kept.company) + bytes > MEDIA_LIMITS.company) return `This shop's photos on the hub have reached ${sizeWords(MEDIA_LIMITS.company)}. Remove old notes or listings to make room.`;
  if (Number(kept.install) + bytes > MEDIA_LIMITS.install) {
    return `The photos of all the shops in this program have reached ${sizeWords(MEDIA_LIMITS.install)} on the hub. Remove old notes or listings to make room.`;
  }
  const hub = await hubBytes(client);
  if (hub + bytes > MEDIA_LIMITS.hub) {
    if (Date.now() - warnedAt > 3600_000) {
      warnedAt = Date.now();
      console.warn(`media: the hub's pictures (${sizeWords(hub)}) have reached MEDIA_QUOTA_HUB_GB (${sizeWords(MEDIA_LIMITS.hub)}); new ones are refused until some are removed or the limit is raised`);
    }
    return "The hub has no room for more photos right now. Try again later, or tell the hub admin.";
  }
  return null;
}

/** The whole hub's pictures now, and its limit (the admin page shows them). */
export async function mediaUse() {
  return { usedBytes: await hubBytes(pool, true), limitBytes: MEDIA_LIMITS.hub };
}
