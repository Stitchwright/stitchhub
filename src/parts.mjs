// Parts cross-reference: one entry per physical part, every number it's sold under, the machines it fits, and
// where to buy it. Anyone can add or fix an entry; every change keeps the whole entry as a revision.
import { pool, q, one, tx } from "./db.mjs";

const KINDS = new Set(["PART", "ACCESSORY", "SUPPLY"]);
const EVIDENCE = new Set(["listed", "tested", "maker"]);

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

export function registerParts({ member, admin, fail, newId, writeLimit, validUrl }) {
  /** Validate and tidy a part entry sent by an install. */
  function cleanPart(body, defaultEvidence) {
    const numbers = [];
    const seenNum = new Set();
    for (const n of Array.isArray(body.numbers) ? body.numbers.slice(0, 50) : []) {
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
    for (const f of Array.isArray(body.fits) ? body.fits.slice(0, 3000) : []) {
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
    for (const s of Array.isArray(body.sources) ? body.sources.slice(0, 30) : []) {
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

  async function saveRevision(client, id, action, c, note) {
    const [snapshot] = await partsByIds([id], client);
    const w = who(c);
    await client.query(
      `INSERT INTO xpart_revisions (id, xpart_id, action, snapshot, by_name, by_shop, install_id, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
      [newId(), id, action, JSON.stringify(snapshot), w.byName, w.byShop, w.installId, note ?? null],
    );
  }

  /** A number here that already belongs to another part: 409 pointing at that part. */
  async function checkNumbers(client, numbers, exceptId) {
    if (!numbers.length) return;
    const hit = (
      await client.query(
        `SELECT n.xpart_id FROM xpart_numbers n JOIN unnest($1::text[], $2::text[]) u(b, k) ON n.brand_key = u.b AND n.number_key = u.k
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

  /** Replace a part's numbers, fits and sources. Sources keep their id, shop and date when unchanged. */
  async function writeEntry(client, id, f, c) {
    const old = (await client.query(`SELECT * FROM xpart_sources WHERE xpart_id = $1`, [id])).rows;
    await client.query(`DELETE FROM xpart_numbers WHERE xpart_id = $1`, [id]);
    await client.query(`DELETE FROM xpart_fits WHERE xpart_id = $1`, [id]);
    await client.query(`DELETE FROM xpart_sources WHERE xpart_id = $1`, [id]);
    if (f.numbers.length) {
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
      return { ...s, id: was ? was.id : newId(), byShop: was ? was.by_shop : shop, updatedAt: same ? was.updated_at : now };
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

  member.post("/xparts", async (c) => {
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

  member.put("/xparts/:id", async (c) => {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json();
    const f = cleanPart(body, "tested");
    c.byName = byNameOf(body);
    await tx(async (client) => {
      const cur = (await client.query(`SELECT id FROM xparts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw fail(404, "That part isn't on the hub.");
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
  member.post("/xparts/:id/merge", async (c) => {
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
      await client.query(
        `UPDATE xparts SET category = coalesce(category, $2), specs = coalesce(specs, $3),
           notes = CASE WHEN $4::text IS NULL THEN notes WHEN notes IS NULL THEN $4 ELSE notes || E'\\n' || $4 END,
           updated_at = now(), seq = nextval('change_seq') WHERE id = $1`,
        [intoId, from.category, from.specs, from.notes],
      );
      await client.query(`UPDATE xparts SET deleted = true, updated_at = now(), seq = nextval('change_seq') WHERE id = $1`, [id]);
      await saveRevision(client, id, "merged", c, body.note ?? `merged into ${into.name}`);
      await saveRevision(client, intoId, "merged", c, body.note ?? `${from.name} merged into this`);
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
  member.delete("/xparts/:id", (c) => setDeleted(c, true));
  member.post("/xparts/:id/restore", (c) => setDeleted(c, false));

  member.get("/xparts/:id/history", async (c) => {
    const { rows } = await q(`SELECT * FROM xpart_revisions WHERE xpart_id = $1 ORDER BY created_at DESC, id DESC`, [c.req.param("id")]);
    return c.json(
      rows.map((r) => ({ id: r.id, action: r.action, snapshot: r.snapshot, byName: r.by_name, byShop: r.by_shop, note: r.note, createdAt: r.created_at })),
    );
  });

  member.post("/xparts/:id/revert", async (c) => {
    writeLimit(c);
    const id = c.req.param("id");
    const body = await c.req.json();
    const r = await one(`SELECT * FROM xpart_revisions WHERE id = $1 AND xpart_id = $2`, [String(body.revisionId ?? ""), id]);
    if (!r) throw fail(404, "That version isn't in this part's history.");
    c.byName = byNameOf(body);
    const snap = r.snapshot;
    const f = cleanPart(snap, "listed");
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
    });
    return c.json(await current(id));
  });

  // Bulk seed: [{ name, kind, category, numbers, fits }]. A new number makes a new part; an entry whose numbers
  // are already on the hub adds its new numbers and fits to that part.
  admin.post("/xparts/import", async (c) => {
    const list = await c.req.json();
    if (!Array.isArray(list)) throw fail(400, "Send a JSON array of parts.");
    let added = 0;
    let merged = 0;
    let skipped = 0;
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
        // Which numbers are already on the hub, and which fits those parts already have.
        const allNums = chunk.flatMap((f) => f.numbers);
        const owner = new Map(); // "BRAND|NUMBER" -> part id
        if (allNums.length) {
          const { rows } = await client.query(
            `SELECT n.brand_key, n.number_key, n.xpart_id FROM xpart_numbers n
             JOIN unnest($1::text[], $2::text[]) u(b, k) ON n.brand_key = u.b AND n.number_key = u.k`,
            [allNums.map((n) => n.brandKey), allNums.map((n) => n.numberKey)],
          );
          for (const r of rows) owner.set(`${r.brand_key}|${r.number_key}`, r.xpart_id);
        }
        const existingIds = [...new Set(owner.values())];
        const haveFit = new Set();
        if (existingIds.length) {
          const { rows } = await client.query(`SELECT xpart_id, brand_key, model_key FROM xpart_fits WHERE xpart_id = ANY($1)`, [existingIds]);
          for (const r of rows) haveFit.add(`${r.xpart_id}|${r.brand_key}|${r.model_key}`);
        }
        const newParts = [];
        const nums = [];
        const fits = [];
        const touched = new Set();
        for (const f of chunk) {
          const target = f.numbers.map((n) => owner.get(`${n.brandKey}|${n.numberKey}`)).find(Boolean);
          const id = target ?? newId();
          let changed = !target;
          if (!target) {
            newParts.push({ id, ...f });
            added++;
          }
          for (const n of f.numbers) {
            const k = `${n.brandKey}|${n.numberKey}`;
            if (owner.has(k)) continue;
            owner.set(k, id);
            nums.push({ id, ...n });
            changed = true;
          }
          for (const x of f.fits) {
            const k = `${id}|${x.brandKey}|${x.modelKey}`;
            if (haveFit.has(k)) continue;
            haveFit.add(k);
            fits.push({ id, ...x });
            changed = true;
          }
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
    return c.json({ added, merged, skipped });
  });

  // Where to buy, in bulk (from a supplier scan): [{ number, brand?, vendor, url, priceCents?, currency?, note? }].
  // Each row goes on the part that owns that number (that brand's number when a brand is given), keyed by
  // (part, url): a link already on the part gets its vendor, price and note updated instead of a second copy.
  // Rows whose number isn't on the hub (or that are missing a vendor or a valid link) count as unmatched.
  admin.post("/xparts/sources/import", async (c) => {
    const list = await c.req.json();
    if (!Array.isArray(list)) throw fail(400, "Send a JSON array of sources.");
    let attached = 0;
    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;
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
          const cands = byNumber.get(r.numberKey);
          if (!cands) {
            unmatched++;
            continue;
          }
          const part = (r.brandKey && cands.find((o) => o.brand_key === r.brandKey)) || cands[0];
          wanted.set(`${part.xpart_id}|${r.url}`, { ...r, partId: part.xpart_id });
        }
        if (!wanted.size) return;
        const partIds = [...new Set([...wanted.values()].map((w) => w.partId))];
        const { rows: existing } = await client.query(
          `SELECT id, xpart_id, url, vendor, price_cents, currency, note FROM xpart_sources WHERE xpart_id = ANY($1) AND url IS NOT NULL`,
          [partIds],
        );
        const have = new Map(existing.map((s) => [`${s.xpart_id}|${s.url}`, s]));
        const inserts = [];
        const updates = [];
        const touched = new Set();
        for (const [k, w] of wanted) {
          const s = have.get(k);
          if (!s) {
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
    return c.json({ attached, updated, unmatched, unchanged });
  });
}
