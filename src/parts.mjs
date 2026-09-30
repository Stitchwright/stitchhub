// Parts cross-reference: one entry per physical part, every number it's sold under, the machines it fits, and
// where to buy it. Anyone can add or fix an entry; every change keeps the whole entry as a revision.
import { bodyLimit } from "hono/body-limit";
import { pool, q, one, tx } from "./db.mjs";

const KINDS = new Set(["PART", "ACCESSORY", "SUPPLY"]);
const EVIDENCE = new Set(["listed", "tested", "maker"]);
// The most a part holds, whichever way it's written (edit, revert, merge or import). Over-full input is refused,
// never trimmed on the quiet: a universal bobbin fits thousands of machines, and every one of them should stay.
const LIMITS = { numbers: 50, fits: 10000, sources: 30 };
const LABEL = { numbers: "part numbers", fits: "machines it fits", sources: "places to buy it" };

/** Upper-case letters and digits only: how brands, numbers and models are matched. */
export const key = (s) =>
  String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

function partOut(p, nums, fits, srcs) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    category: p.category,
    specs: p.specs,
    notes: p.notes,
    deleted: p.deleted,
    updatedAt: p.updated_at,
    numbers: nums.map((n) => ({ brand: n.brand, number: n.number })),
    fits: fits.map((f) => ({ brand: f.brand, model: f.model, modelKey: f.model_key, evidence: f.evidence, source: f.source })),
    sources: srcs.map((s) => ({
      id: s.id,
      vendor: s.vendor,
      url: s.url,
      priceCents: s.price_cents,
      currency: s.currency,
      note: s.note,
      byShop: s.by_shop,
      updatedAt: s.updated_at,
    })),
  };
}

/** Full entries (numbers, fits, sources) for these ids, in the same order. Pass a client to read inside a transaction. */
export async function partsByIds(ids, db = pool) {
  if (!ids.length) return [];
  const parts = (await db.query(`SELECT * FROM xparts WHERE id = ANY($1)`, [ids])).rows;
  const nums = (await db.query(`SELECT * FROM xpart_numbers WHERE xpart_id = ANY($1) ORDER BY brand, number`, [ids])).rows;
  const fits = (await db.query(`SELECT * FROM xpart_fits WHERE xpart_id = ANY($1) ORDER BY brand, model`, [ids])).rows;
  const srcs = (await db.query(`SELECT * FROM xpart_sources WHERE xpart_id = ANY($1) ORDER BY vendor, id`, [ids])).rows;
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.xpart_id, [...(m.get(r.xpart_id) ?? []), r]);
    return m;
  };
  const [gn, gf, gs] = [group(nums), group(fits), group(srcs)];
  const byId = new Map(parts.map((p) => [p.id, partOut(p, gn.get(p.id) ?? [], gf.get(p.id) ?? [], gs.get(p.id) ?? [])]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * About how many bytes each part takes in the change feed, without loading it: the feed stops a page short of its
 * size limit using these (a part with thousands of machines it fits is megabytes).
 */
export async function partSizes(ids, db = pool) {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT p.id, 2000 + octet_length(coalesce(p.name, '')) + octet_length(coalesce(p.specs, '')) + octet_length(coalesce(p.notes, ''))
       + coalesce((SELECT sum(120 + octet_length(f.brand) + 2 * octet_length(f.model) + octet_length(coalesce(f.source, ''))) FROM xpart_fits f WHERE f.xpart_id = p.id), 0)
       + coalesce((SELECT sum(250 + octet_length(s.vendor) + octet_length(coalesce(s.url, '')) + octet_length(coalesce(s.note, '')) + octet_length(coalesce(s.by_shop, ''))) FROM xpart_sources s WHERE s.xpart_id = p.id), 0)
       + (SELECT count(*) * 150 FROM xpart_numbers n WHERE n.xpart_id = p.id) AS bytes
     FROM xparts p WHERE p.id = ANY($1)`,
    [ids],
  );
  for (const r of rows) out.set(r.id, Number(r.bytes));
  return out;
}

export function registerParts({ member, admin, fail, newId, writeLimit, validUrl }) {
  /** Validate and tidy a part entry sent by an install. */
  function cleanPart(body, defaultEvidence) {
    const numbers = [];
    const seenNum = new Set();
    for (const n of Array.isArray(body.numbers) ? body.numbers : []) {
      const brand = str(n?.brand, 60);
      const number = str(n?.number, 60);
      if (!brand || !number || !key(brand) || !key(number)) throw fail(400, "Each part number needs a brand and a number.");
      const k = `${key(brand)}|${key(number)}`;
      if (seenNum.has(k)) continue;
      seenNum.add(k);
      numbers.push({ brand, number, brandKey: key(brand), numberKey: key(number) });
    }
    const fits = [];
    const seenFit = new Set();
    for (const f of Array.isArray(body.fits) ? body.fits : []) {
      const brand = str(f?.brand, 60);
      const model = str(f?.model, 80);
      if (!brand || !model || !key(brand) || !key(model)) throw fail(400, "Each machine it fits needs a brand and a model.");
      const k = `${key(brand)}|${key(model)}`;
      if (seenFit.has(k)) continue;
      seenFit.add(k);
      fits.push({
        brand,
        model,
        brandKey: key(brand),
        modelKey: key(model),
        evidence: EVIDENCE.has(f.evidence) ? f.evidence : defaultEvidence,
        source: str(f.source, 300),
      });
    }
    const sources = [];
    for (const s of Array.isArray(body.sources) ? body.sources : []) {
      const vendor = str(s?.vendor, 120);
      if (!vendor) throw fail(400, "Each place to buy it needs a vendor name.");
      const url = str(s.url, 1000);
      if (url && !validUrl(url)) throw fail(400, "A buying link must start with http:// or https://");
      const price = s.priceCents == null || s.priceCents === "" ? null : Number(s.priceCents);
      if (price != null && (!Number.isInteger(price) || price < 0)) throw fail(400, "Prices are whole cents, 0 or more.");
      sources.push({
        id: str(s.id, 40),
        vendor,
        url,
        priceCents: price,
        currency: /^[A-Z]{3}$/.test(String(s.currency ?? "")) ? s.currency : "USD",
        note: str(s.note, 300),
      });
    }
    for (const k of Object.keys(LIMITS)) {
      if ({ numbers, fits, sources }[k].length > LIMITS[k]) throw fail(400, `A part can list up to ${LIMITS[k]} ${LABEL[k]}. Trim the entry, or split it in two.`);
    }
    const name = str(body.name, 200) ?? (numbers[0] ? `Part ${numbers[0].number}` : null);
    if (!name) throw fail(400, "Give the part a name or a part number.");
    return {
      name,
      kind: KINDS.has(body.kind) ? body.kind : "PART",
      category: str(body.category, 80),
      specs: str(body.specs, 300),
      notes: str(body.notes, 2000),
      numbers,
      fits,
      sources,
    };
  }

  const who = (c) => ({ byName: c.byName ?? null, byShop: c.get("install")?.name ?? "hub admin", installId: c.get("install")?.id ?? null });

  async function saveRevision(client, id, action, c, note, mergedFrom) {
    const [snapshot] = await partsByIds([id], client);
    const w = who(c);
    await client.query(
      `INSERT INTO xpart_revisions (id, xpart_id, action, snapshot, by_name, by_shop, install_id, note, merged_from, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())`,
      [newId(), id, action, JSON.stringify(snapshot), w.byName, w.byShop, w.installId, note ?? null, mergedFrom ?? null],
    );
  }

  /**
   * A number here that already belongs to another live part: 409 pointing at that part. Numbers on a removed part
   * don't count (see freeNumbers), or a slip of the Remove button would lock them for good.
   */
  async function checkNumbers(client, numbers, exceptId) {
    if (!numbers.length) return;
    const hit = (
      await client.query(
        `SELECT n.xpart_id FROM xpart_numbers n JOIN xparts p ON p.id = n.xpart_id AND NOT p.deleted
         JOIN unnest($1::text[], $2::text[]) u(b, k) ON n.brand_key = u.b AND n.number_key = u.k
         WHERE n.xpart_id <> $3 LIMIT 1`,
        [numbers.map((n) => n.brandKey), numbers.map((n) => n.numberKey), exceptId ?? ""],
      )
    ).rows[0];
    if (hit) {
      const e = fail(409, "That part number is already on another part. Open that part and add to it instead, or merge the two.");
      e.partId = hit.xpart_id;
      throw e;
    }
  }

  /**
   * A removed part keeps its numbers only until a live part claims them: drop them from the removed part before
   * they're written elsewhere (each (brand, number) can sit on one part). Its revision history still holds them.
   */
  async function freeNumbers(client, numbers) {
    if (!numbers.length) return;
    await client.query(
      `DELETE FROM xpart_numbers n USING xparts p, unnest($1::text[], $2::text[]) u(b, k)
       WHERE p.id = n.xpart_id AND p.deleted AND n.brand_key = u.b AND n.number_key = u.k`,
      [numbers.map((n) => n.brandKey), numbers.map((n) => n.numberKey)],
    );
  }

  /** Replace a part's numbers, fits and sources. Sources keep their id, shop and date when unchanged. */
  async function writeEntry(client, id, f, c) {
    const old = (await client.query(`SELECT * FROM xpart_sources WHERE xpart_id = $1`, [id])).rows;
    await client.query(`DELETE FROM xpart_numbers WHERE xpart_id = $1`, [id]);
    await client.query(`DELETE FROM xpart_fits WHERE xpart_id = $1`, [id]);
    await client.query(`DELETE FROM xpart_sources WHERE xpart_id = $1`, [id]);
    if (f.numbers.length) {
      await freeNumbers(client, f.numbers);
      await client.query(
        `INSERT INTO xpart_numbers (xpart_id, brand, number, brand_key, number_key)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])`,
        [id, f.numbers.map((n) => n.brand), f.numbers.map((n) => n.number), f.numbers.map((n) => n.brandKey), f.numbers.map((n) => n.numberKey)],
      );
    }
    if (f.fits.length) {
      await client.query(
        `INSERT INTO xpart_fits (xpart_id, brand, model, brand_key, model_key, evidence, source)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) ON CONFLICT DO NOTHING`,
        [
          id,
          f.fits.map((x) => x.brand),
          f.fits.map((x) => x.model),
          f.fits.map((x) => x.brandKey),
          f.fits.map((x) => x.modelKey),
          f.fits.map((x) => x.evidence),
          f.fits.map((x) => x.source),
        ],
      );
    }
    const shop = who(c).byShop;
    const now = new Date();
    const srcs = f.sources.map((s) => {
      const was = s.id ? old.find((o) => o.id === s.id) : null;
      const same =
        was && was.vendor === s.vendor && (was.url ?? null) === s.url && (was.price_cents ?? null) === s.priceCents && was.currency === s.currency && (was.note ?? null) === s.note;
      // A changed source is credited to the shop that changed it, not the one that first added it.
      return { ...s, id: was ? was.id : newId(), byShop: same ? was.by_shop : shop, updatedAt: same ? was.updated_at : now };
    });
    if (srcs.length) {
      await client.query(
        `INSERT INTO xpart_sources (id, xpart_id, vendor, url, price_cents, currency, note, by_shop, updated_at)
         SELECT u.id, $1, u.vendor, u.url, u.price, u.currency, u.note, u.by_shop, u.updated_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::timestamptz[])
           AS u(id, vendor, url, price, currency, note, by_shop, updated_at)`,
        [
          id,
          srcs.map((s) => s.id),
          srcs.map((s) => s.vendor),
          srcs.map((s) => s.url),
          srcs.map((s) => s.priceCents),
          srcs.map((s) => s.currency),
          srcs.map((s) => s.note),
          srcs.map((s) => s.byShop),
          srcs.map((s) => s.updatedAt),
        ],
      );
    }
  }

  const byNameOf = (body) => String(body?.byName ?? "").slice(0, 80) || null;

  async function current(id, client = pool) {
    const [p] = await partsByIds([id], client);
    if (!p) throw fail(404, "That part isn't on the hub.");
    return p;
  }

  // Bodies are counted as they arrive, so a body sent without a length (chunked) is held to the limit too. A whole
  // entry with LIMITS.fits machines is under 2 MB of JSON; merge, remove, restore and revert send a few fields.
  const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Too large." }, 413) });
  const entry = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: "That part entry is too large (4 MB at most)." }, 413) });

  member.post("/xparts", entry, async (c) => {
    writeLimit(c);
    const body = await c.req.json();
    const f = cleanPart(body, "tested");
    c.byName = byNameOf(body);
    const id = newId();
    await tx(async (client) => {
      await checkNumbers(client, f.numbers);
      await client.query(`INSERT INTO xparts (id, name, kind, category, specs, notes) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id,
        f.name,
        f.kind,
        f.category,
        f.specs,
        f.notes,
      ]);
      await writeEntry(client, id, f, c);
      await saveRevision(client, id, "added", c, body.note);
    });
    return c.json(await current(id));
  });

  // One entry as it is now (a shop whose copy was out of date fetches it before trying its change again).
  member.get("/xparts/:id", async (c) => c.json(await current(c.req.param("id"))));

  member.put("/xparts/:id", entry, async (c) => {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json();
    const f = cleanPart(body, "tested");
    c.byName = byNameOf(body);
    // The version the shop edited (its updatedAt). The whole entry is replaced, so an edit made from an older copy
    // would silently undo whatever changed since: another shop's fix, an import, the supplier scan's links.
    const base = body.baseUpdatedAt ? new Date(body.baseUpdatedAt).getTime() : NaN;
    await tx(async (client) => {
      const cur = (await client.query(`SELECT id, updated_at FROM xparts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw fail(404, "That part isn't on the hub.");
      if (!Number.isNaN(base) && cur.updated_at.getTime() !== base) {
        const e = fail(409, "Someone changed this part since you opened it. Its page now shows their change: make yours again on that.");
        e.partId = id;
        throw e;
      }
      await checkNumbers(client, f.numbers, id);
      await client.query(
        `UPDATE xparts SET name = $2, kind = $3, category = $4, specs = $5, notes = $6, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
        [id, f.name, f.kind, f.category, f.specs, f.notes],
      );
      await writeEntry(client, id, f, c);
      await saveRevision(client, id, "edited", c, body.note);
    });
    return c.json(await current(id));
  });

  // The two entries are the same part: move everything from :id into intoId, and remove :id.
  member.post("/xparts/:id/merge", small, async (c) => {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json();
    const intoId = String(body.intoId ?? "");
    if (!intoId || intoId === id) throw fail(400, "Pick the other part to merge into.");
    c.byName = byNameOf(body);
    await tx(async (client) => {
      const rows = (await client.query(`SELECT * FROM xparts WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [[id, intoId]])).rows;
      const from = rows.find((r) => r.id === id);
      const into = rows.find((r) => r.id === intoId);
      if (!from || !into) throw fail(404, "That part isn't on the hub.");
      if (into.deleted) throw fail(409, "The part to merge into was removed. Restore it first.");
      if (from.deleted) throw fail(409, "That part was already removed.");
      // Together they must still fit LIMITS, or the next edit of the merged part could not be saved.
      const total = (
        await client.query(
          `SELECT (SELECT count(*) FROM xpart_numbers WHERE xpart_id = ANY($1))::int AS numbers,
                  (SELECT count(DISTINCT (brand_key, model_key)) FROM xpart_fits WHERE xpart_id = ANY($1))::int AS fits,
                  (SELECT count(*) FROM xpart_sources WHERE xpart_id = ANY($1))::int AS sources`,
          [[id, intoId]],
        )
      ).rows[0];
      for (const k of Object.keys(LIMITS)) {
        if (total[k] > LIMITS[k]) throw fail(409, `Merged, this part would list more than ${LIMITS[k]} ${LABEL[k]}. Trim one of them first.`);
      }
      await client.query(`UPDATE xpart_numbers SET xpart_id = $2 WHERE xpart_id = $1`, [id, intoId]);
      await client.query(
        `INSERT INTO xpart_fits (xpart_id, brand, model, brand_key, model_key, evidence, source)
         SELECT $2, brand, model, brand_key, model_key, evidence, source FROM xpart_fits WHERE xpart_id = $1 ON CONFLICT DO NOTHING`,
        [id, intoId],
      );
      // A stronger claim wins: tested beats maker beats listed.
      await client.query(
        `UPDATE xpart_fits t SET evidence = s.evidence FROM xpart_fits s
         WHERE s.xpart_id = $1 AND t.xpart_id = $2 AND t.brand_key = s.brand_key AND t.model_key = s.model_key
           AND array_position(ARRAY['listed','maker','tested'], s.evidence) > array_position(ARRAY['listed','maker','tested'], t.evidence)`,
        [id, intoId],
      );
      await client.query(`DELETE FROM xpart_fits WHERE xpart_id = $1`, [id]);
      await client.query(`UPDATE xpart_sources SET xpart_id = $2 WHERE xpart_id = $1`, [id, intoId]);
      // Notes are joined but stay within what an edit may send back (2,000 characters), so nothing is lost later.
      await client.query(
        `UPDATE xparts SET category = coalesce(category, $2), specs = coalesce(specs, $3),
           notes = left(CASE WHEN $4::text IS NULL THEN notes WHEN notes IS NULL THEN $4 ELSE notes || E'\\n' || $4 END, 2000),
           updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
        [intoId, from.category, from.specs, from.notes],
      );
      await client.query(`UPDATE xparts SET deleted = true, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [id]);
      await saveRevision(client, id, "merged", c, body.note ?? `merged into ${into.name}`);
      await saveRevision(client, intoId, "merged", c, body.note ?? `${from.name} merged into this`, id);
    });
    return c.json(await current(intoId));
  });

  async function setDeleted(c, deleted) {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    c.byName = byNameOf(body);
    await tx(async (client) => {
      const r = await client.query(`UPDATE xparts SET deleted = $2, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [id, deleted]);
      if (!r.rowCount) throw fail(404, "That part isn't on the hub.");
      await saveRevision(client, id, deleted ? "removed" : "restored", c, body.note);
    });
    return c.json(await current(id));
  }
  member.delete("/xparts/:id", small, (c) => setDeleted(c, true));
  member.post("/xparts/:id/restore", small, (c) => setDeleted(c, false));

  member.get("/xparts/:id/history", async (c) => {
    const { rows } = await q(`SELECT * FROM xpart_revisions WHERE xpart_id = $1 ORDER BY created_at DESC, id DESC`, [c.req.param("id")]);
    return c.json(
      rows.map((r) => ({ id: r.id, action: r.action, snapshot: r.snapshot, byName: r.by_name, byShop: r.by_shop, note: r.note, createdAt: r.created_at })),
    );
  });

  member.post("/xparts/:id/revert", small, async (c) => {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json();
    const r = await one(`SELECT * FROM xpart_revisions WHERE id = $1 AND xpart_id = $2`, [String(body.revisionId ?? ""), id]);
    if (!r) throw fail(404, "That version isn't in this part's history.");
    c.byName = byNameOf(body);
    const snap = r.snapshot;
    const f = cleanPart(snap, "listed");
    // Parts merged into this one after that version: going back would drop their numbers, fits and links, so each
    // becomes its own part again as it was before the merge. A merge from before merges were recorded can't be undone
    // that way, so the roll-back stops there.
    const merges = (
      await q(
        `SELECT merged_from, created_at FROM xpart_revisions
         WHERE xpart_id = $1 AND action = 'merged' AND created_at > $2 AND (merged_from IS NOT NULL OR NOT coalesce((snapshot->>'deleted')::boolean, false))
         ORDER BY created_at DESC`,
        [id, r.created_at],
      )
    ).rows;
    if (merges.some((m) => !m.merged_from)) {
      throw fail(409, "Another part was merged into this one after that version, and going back would drop what it brought. Roll back to a version after the merge.");
    }
    await tx(async (client) => {
      const cur = (await client.query(`SELECT id FROM xparts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw fail(404, "That part isn't on the hub.");
      await checkNumbers(client, f.numbers, id);
      await client.query(
        `UPDATE xparts SET name = $2, kind = $3, category = $4, specs = $5, notes = $6, deleted = $7, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
        [id, f.name, f.kind, f.category, f.specs, f.notes, Boolean(snap.deleted)],
      );
      await writeEntry(client, id, f, c);
      await saveRevision(client, id, "reverted", c, `back to the version from ${new Date(r.created_at).toISOString().slice(0, 10)}`);
      for (const m of merges) await unmerge(client, m.merged_from, m.created_at, c);
    });
    return c.json(await current(id));
  });

  /** The part merged away at `mergedAt` comes back as it was just before (when it's still removed). */
  async function unmerge(client, fromId, mergedAt, c) {
    const from = (await client.query(`SELECT id, deleted FROM xparts WHERE id = $1 FOR UPDATE`, [fromId])).rows[0];
    if (!from?.deleted) return;
    const before = (
      await client.query(
        `SELECT snapshot FROM xpart_revisions WHERE xpart_id = $1
           AND created_at < (SELECT max(created_at) FROM xpart_revisions WHERE xpart_id = $1 AND action = 'merged' AND created_at <= $2)
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [fromId, mergedAt],
      )
    ).rows[0];
    if (!before) return;
    const f = cleanPart(before.snapshot, "listed");
    await checkNumbers(client, f.numbers, fromId);
    await client.query(
      `UPDATE xparts SET name = $2, kind = $3, category = $4, specs = $5, notes = $6, deleted = false, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
      [fromId, f.name, f.kind, f.category, f.specs, f.notes],
    );
    await writeEntry(client, fromId, f, c);
    await saveRevision(client, fromId, "restored", c, "its own part again: the part it was merged into was rolled back");
  }

  // Bulk seed: [{ name, kind, category, numbers, fits }]. A new number makes a new part; an entry whose numbers
  // are already on a live part adds its new numbers and fits to that part. `full` (only when it happened) counts
  // entries that lost numbers or fits because their part was already at LIMITS.
  admin.post("/xparts/import", async (c) => {
    const list = await c.req.json();
    if (!Array.isArray(list)) throw fail(400, "Send a JSON array of parts.");
    let added = 0;
    let merged = 0;
    let skipped = 0;
    let full = 0;
    for (let start = 0; start < list.length; start += 2000) {
      const chunk = [];
      for (const raw of list.slice(start, start + 2000)) {
        try {
          const f = cleanPart({ ...raw, sources: [] }, "listed");
          if (!f.numbers.length && !f.fits.length) skipped++;
          else chunk.push(f);
        } catch {
          skipped++;
        }
      }
      if (!chunk.length) continue;
      await tx(async (client) => {
        // Which numbers are already on a live part (a removed part's numbers are free to take), and which fits and
        // how many numbers those parts already have.
        const allNums = chunk.flatMap((f) => f.numbers);
        const owner = new Map(); // "BRAND|NUMBER" -> part id
        if (allNums.length) {
          const { rows } = await client.query(
            `SELECT n.brand_key, n.number_key, n.xpart_id FROM xpart_numbers n JOIN xparts p ON p.id = n.xpart_id AND NOT p.deleted
             JOIN unnest($1::text[], $2::text[]) u(b, k) ON n.brand_key = u.b AND n.number_key = u.k`,
            [allNums.map((n) => n.brandKey), allNums.map((n) => n.numberKey)],
          );
          for (const r of rows) owner.set(`${r.brand_key}|${r.number_key}`, r.xpart_id);
        }
        const existingIds = [...new Set(owner.values())];
        const haveFit = new Set();
        const count = { numbers: new Map(), fits: new Map() }; // part id -> how many it holds, kept within LIMITS
        if (existingIds.length) {
          const { rows } = await client.query(`SELECT xpart_id, brand_key, model_key FROM xpart_fits WHERE xpart_id = ANY($1)`, [existingIds]);
          for (const r of rows) {
            haveFit.add(`${r.xpart_id}|${r.brand_key}|${r.model_key}`);
            count.fits.set(r.xpart_id, (count.fits.get(r.xpart_id) ?? 0) + 1);
          }
          const { rows: ns } = await client.query(`SELECT xpart_id, count(*)::int AS n FROM xpart_numbers WHERE xpart_id = ANY($1) GROUP BY 1`, [existingIds]);
          for (const r of ns) count.numbers.set(r.xpart_id, r.n);
        }
        // Room on the part for one more of `kind`; counts it when there is.
        const room = (kind, id) => {
          const n = count[kind].get(id) ?? 0;
          if (n >= LIMITS[kind]) return false;
          count[kind].set(id, n + 1);
          return true;
        };
        const newParts = [];
        const nums = [];
        const fits = [];
        const touched = new Set();
        for (const f of chunk) {
          const target = f.numbers.map((n) => owner.get(`${n.brandKey}|${n.numberKey}`)).find(Boolean);
          const id = target ?? newId();
          let changed = !target;
          let dropped = false;
          if (!target) {
            newParts.push({ id, ...f });
            added++;
          }
          for (const n of f.numbers) {
            const k = `${n.brandKey}|${n.numberKey}`;
            if (owner.has(k)) continue;
            if (!room("numbers", id)) {
              dropped = true;
              continue;
            }
            owner.set(k, id);
            nums.push({ id, ...n });
            changed = true;
          }
          for (const x of f.fits) {
            const k = `${id}|${x.brandKey}|${x.modelKey}`;
            if (haveFit.has(k)) continue;
            if (!room("fits", id)) {
              dropped = true;
              continue;
            }
            haveFit.add(k);
            fits.push({ id, ...x });
            changed = true;
          }
          if (dropped) full++;
          if (target) {
            if (changed) {
              touched.add(target);
              merged++;
            } else skipped++;
          }
        }
        if (newParts.length) {
          await client.query(
            `INSERT INTO xparts (id, name, kind, category) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])`,
            [newParts.map((p) => p.id), newParts.map((p) => p.name), newParts.map((p) => p.kind), newParts.map((p) => p.category)],
          );
        }
        if (nums.length) {
          await freeNumbers(client, nums);
          await client.query(
            `INSERT INTO xpart_numbers (xpart_id, brand, number, brand_key, number_key)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) ON CONFLICT DO NOTHING`,
            [nums.map((n) => n.id), nums.map((n) => n.brand), nums.map((n) => n.number), nums.map((n) => n.brandKey), nums.map((n) => n.numberKey)],
          );
        }
        if (fits.length) {
          await client.query(
            `INSERT INTO xpart_fits (xpart_id, brand, model, brand_key, model_key, evidence, source)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) ON CONFLICT DO NOTHING`,
            [
              fits.map((x) => x.id),
              fits.map((x) => x.brand),
              fits.map((x) => x.model),
              fits.map((x) => x.brandKey),
              fits.map((x) => x.modelKey),
              fits.map((x) => x.evidence),
              fits.map((x) => x.source),
            ],
          );
        }
        if (touched.size) {
          await client.query(`UPDATE xparts SET updated_at = now(), seq = nextval('change_seq') WHERE id = ANY($1)`, [[...touched]]);
        }
        // One revision per part added or extended, holding the whole entry.
        const revIds = [...newParts.map((p) => p.id), ...touched];
        for (let i = 0; i < revIds.length; i += 1000) {
          const ids = revIds.slice(i, i + 1000);
          const snaps = await partsByIds(ids, client);
          const addedSet = new Set(newParts.map((p) => p.id));
          await client.query(
            `INSERT INTO xpart_revisions (id, xpart_id, action, snapshot, by_name, by_shop, note)
             SELECT u.id, u.part, u.action, u.snap::jsonb, 'import', 'hub admin', 'imported'
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(id, part, action, snap)`,
            [snaps.map(() => newId()), snaps.map((s) => s.id), snaps.map((s) => (addedSet.has(s.id) ? "added" : "edited")), snaps.map((s) => JSON.stringify(s))],
          );
        }
      });
    }
    return c.json({ added, merged, skipped, ...(full ? { full } : {}) });
  });

  // Where to buy, in bulk (from a supplier scan): [{ number, brand?, vendor, url, priceCents?, currency?, note? }].
  // Each row goes on the live part that owns that number: that brand's number when a brand is given, otherwise the
  // one part holding the number under any brand. Keyed by (part, url): a link already on the part gets its vendor,
  // price and note updated instead of a second copy. Rows count as unmatched when the number isn't on the hub
  // under the brand given, when no brand is given and different parts hold it under different brands (the same
  // digits from two makers are not one part), or when the vendor or link is missing. `full` (only when it
  // happened) counts new links a part had no room for.
  admin.post("/xparts/sources/import", async (c) => {
    const list = await c.req.json();
    if (!Array.isArray(list)) throw fail(400, "Send a JSON array of sources.");
    let attached = 0;
    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;
    let full = 0;
    const SCAN = "StitchHub scan";
    for (let start = 0; start < list.length; start += 5000) {
      const rows = [];
      for (const raw of list.slice(start, start + 5000)) {
        const numberKey = key(raw?.number);
        const vendor = str(raw?.vendor, 120);
        const url = str(raw?.url, 1000);
        const price = raw?.priceCents == null || raw.priceCents === "" ? null : Number(raw.priceCents);
        if (!numberKey || !vendor || !url || !validUrl(url) || (price != null && (!Number.isInteger(price) || price < 0))) {
          unmatched++;
          continue;
        }
        rows.push({
          numberKey,
          brandKey: raw.brand ? key(raw.brand) : null,
          vendor,
          url,
          priceCents: price,
          currency: /^[A-Z]{3}$/.test(String(raw.currency ?? "")) ? raw.currency : "USD",
          note: str(raw.note, 300),
        });
      }
      if (!rows.length) continue;
      await tx(async (client) => {
        // Which live parts own these numbers (by brand, for rows that name one).
        const { rows: owners } = await client.query(
          `SELECT n.number_key, n.brand_key, n.xpart_id FROM xpart_numbers n JOIN xparts p ON p.id = n.xpart_id AND NOT p.deleted
           WHERE n.number_key = ANY($1) ORDER BY n.number_key, n.brand_key`,
          [[...new Set(rows.map((r) => r.numberKey))]],
        );
        const byNumber = new Map();
        for (const o of owners) byNumber.set(o.number_key, [...(byNumber.get(o.number_key) ?? []), o]);
        // The last row for a (part, link) wins.
        const wanted = new Map();
        for (const r of rows) {
          const cands = byNumber.get(r.numberKey) ?? [];
          const part = r.brandKey ? cands.find((o) => o.brand_key === r.brandKey) : new Set(cands.map((o) => o.xpart_id)).size === 1 ? cands[0] : null;
          if (!part) {
            unmatched++;
            continue;
          }
          wanted.set(`${part.xpart_id}|${r.url}`, { ...r, partId: part.xpart_id });
        }
        if (!wanted.size) return;
        const partIds = [...new Set([...wanted.values()].map((w) => w.partId))];
        const { rows: existing } = await client.query(`SELECT id, xpart_id, url, vendor, price_cents, currency, note FROM xpart_sources WHERE xpart_id = ANY($1)`, [partIds]);
        const have = new Map(existing.map((s) => [`${s.xpart_id}|${s.url}`, s]));
        const count = new Map(); // part id -> places to buy it already holds, kept within LIMITS.sources
        for (const s of existing) count.set(s.xpart_id, (count.get(s.xpart_id) ?? 0) + 1);
        const inserts = [];
        const updates = [];
        const touched = new Set();
        for (const [k, w] of wanted) {
          const s = have.get(k);
          if (!s) {
            const n = count.get(w.partId) ?? 0;
            if (n >= LIMITS.sources) {
              full++;
              continue;
            }
            count.set(w.partId, n + 1);
            inserts.push({ ...w, id: newId() });
            touched.add(w.partId);
            attached++;
          } else if (s.vendor !== w.vendor || (s.price_cents ?? null) !== w.priceCents || s.currency !== w.currency || (s.note ?? null) !== w.note) {
            updates.push({ ...w, id: s.id });
            touched.add(w.partId);
            updated++;
          } else unchanged++;
        }
        if (inserts.length) {
          await client.query(
            `INSERT INTO xpart_sources (id, xpart_id, vendor, url, price_cents, currency, note, by_shop, updated_at)
             SELECT u.id, u.part, u.vendor, u.url, u.price, u.currency, u.note, $8, now()
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[]) AS u(id, part, vendor, url, price, currency, note)`,
            [
              inserts.map((w) => w.id),
              inserts.map((w) => w.partId),
              inserts.map((w) => w.vendor),
              inserts.map((w) => w.url),
              inserts.map((w) => w.priceCents),
              inserts.map((w) => w.currency),
              inserts.map((w) => w.note),
              SCAN,
            ],
          );
        }
        if (updates.length) {
          await client.query(
            `UPDATE xpart_sources s SET vendor = u.vendor, price_cents = u.price, currency = u.currency, note = u.note, by_shop = $6, updated_at = now()
             FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[]) AS u(id, vendor, price, currency, note)
             WHERE s.id = u.id`,
            [updates.map((w) => w.id), updates.map((w) => w.vendor), updates.map((w) => w.priceCents), updates.map((w) => w.currency), updates.map((w) => w.note), SCAN],
          );
        }
        if (!touched.size) return;
        const ids = [...touched];
        await client.query(`UPDATE xparts SET updated_at = now(), seq = nextval('change_seq') WHERE id = ANY($1)`, [ids]);
        // One revision per part whose sources changed, holding the whole entry.
        for (let i = 0; i < ids.length; i += 1000) {
          const snaps = await partsByIds(ids.slice(i, i + 1000), client);
          await client.query(
            `INSERT INTO xpart_revisions (id, xpart_id, action, snapshot, by_name, by_shop, note)
             SELECT u.id, u.part, 'sources', u.snap::jsonb, 'scan', $4, 'where to buy updated by the supplier scan'
             FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, part, snap)`,
            [snaps.map(() => newId()), snaps.map((s) => s.id), snaps.map((s) => JSON.stringify(s)), SCAN],
          );
        }
      });
    }
    return c.json({ attached, updated, unmatched, unchanged, ...(full ? { full } : {}) });
  });
}
