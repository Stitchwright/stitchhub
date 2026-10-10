// Program updates (StitchBench docs/plans/ease-of-use-design.md, section 1; migration 035). The owner publishes each
// installer with scripts/release/publish-release.mjs (in the StitchBench repo): the file goes to R2 on a presigned URL
// (or stays at an https address of its own) and the release is recorded here with its sha256, size and Ed25519
// signature. The programs ask GET /v1/releases/latest (no key) and download from /v1/releases/:id/download. The hub does
// not verify the signature (it has no key); the program does, against the public key built into it.
import crypto from "node:crypto";
import { one, q } from "./db.mjs";
import { r2FromEnv } from "./r2.mjs";

const FLAVORS = { stitchbench: "StitchBench", stitchshop: "StitchShop" };
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const MAX_SIZE = 600 * 1024 * 1024;
const PUT_SECONDS = 900;
const GET_SECONDS = 900;

const cmp = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export function registerReleases({ app, admin, fail, newId, allow, clientIp, hubUrl }) {
  const r2 = r2FromEnv();
  const needR2 = () => {
    if (!r2) throw fail(503, "The hub's file storage isn't set up yet (R2_* variables), so it can't keep installers. Publish with --url instead.");
    return r2;
  };
  const flavorOf = (v) => {
    const f = String(v ?? "");
    if (!Object.hasOwn(FLAVORS, f)) throw fail(400, "flavor is stitchbench or stitchshop.");
    return f;
  };
  const versionOf = (v) => {
    const s = String(v ?? "");
    if (!SEMVER.test(s)) throw fail(400, "version looks like 1.7.1.");
    return s;
  };
  const sizeOf = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SIZE) throw fail(400, `size is the file's bytes, 1 to ${MAX_SIZE}.`);
    return n;
  };
  const fileName = (r) => `${FLAVORS[r.flavor]} Setup ${r.version}.exe`;
  const out = (r) => ({
    id: r.id,
    flavor: r.flavor,
    version: r.version,
    url: r.r2_key ? `${hubUrl || ""}/v1/releases/${r.id}/download` : r.url,
    sha256: r.sha256,
    size: Number(r.size),
    signature: r.signature,
    notes: r.notes,
    publishedAt: r.created_at,
  });

  // ----- the programs' routes (no key) -----

  app.get("/v1/releases/latest", async (c) => {
    if (!allow(`releases:${clientIp(c)}`, 120)) throw fail(429, "Too many tries. Wait a while.");
    const flavor = flavorOf(c.req.query("flavor"));
    const rows = (await q(`SELECT * FROM releases WHERE flavor = $1 AND withdrawn_at IS NULL`, [flavor])).rows;
    if (!rows.length) throw fail(404, "No release has been published.");
    rows.sort((a, b) => cmp(b.version, a.version));
    return c.json(out(rows[0]));
  });

  app.get("/v1/releases/:id/download", async (c) => {
    if (!allow(`releases:${clientIp(c)}`, 120)) throw fail(429, "Too many tries. Wait a while.");
    const r = await one(`SELECT * FROM releases WHERE id = $1`, [c.req.param("id")]);
    if (!r || !r.r2_key || r.withdrawn_at) throw fail(404, "No such download.");
    const s = needR2().presign("GET", r.r2_key, {
      expires: GET_SECONDS,
      query: [
        ["response-content-type", "application/octet-stream"],
        ["response-content-disposition", `attachment; filename="${fileName(r)}"`],
      ],
    });
    return c.redirect(s.url, 302);
  });

  // ----- the owner's routes -----

  admin.get("/releases", async (c) => {
    const rows = (await q(`SELECT * FROM releases`)).rows;
    rows.sort((a, b) => a.flavor.localeCompare(b.flavor) || cmp(b.version, a.version));
    return c.json({ storage: Boolean(r2), releases: rows.map((r) => ({ ...out(r), where: r.r2_key ? "hub" : "url", withdrawnAt: r.withdrawn_at })) });
  });

  admin.post("/releases/upload-url", async (c) => {
    const b = await c.req.json();
    const flavor = flavorOf(b.flavor);
    const version = versionOf(b.version);
    const size = sizeOf(b.size);
    const store = needR2();
    if (await one(`SELECT 1 FROM releases WHERE flavor = $1 AND version = $2`, [flavor, version])) throw fail(409, `${FLAVORS[flavor]} ${version} is already published.`);
    const key = `releases/${flavor}/${version}/${crypto.randomBytes(8).toString("hex")}.exe`;
    const slot = store.putUrl(key, { contentType: "application/octet-stream", size, expires: PUT_SECONDS });
    return c.json({ key, putUrl: slot.url, putHeaders: slot.headers, expiresAt: slot.expiresAt });
  });

  admin.post("/releases", async (c) => {
    const b = await c.req.json();
    const flavor = flavorOf(b.flavor);
    const version = versionOf(b.version);
    const size = sizeOf(b.size);
    const sha256 = String(b.sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw fail(400, "sha256 is 64 hex characters.");
    const signature = String(b.signature ?? "");
    if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(signature) || signature.length > 512 || signature.length % 4 !== 0) throw fail(400, "signature is base64.");
    const notes = b.notes ?? [];
    if (!Array.isArray(notes) || notes.length > 12 || notes.some((n) => typeof n !== "string" || !n.trim() || n.length > 200)) throw fail(400, "notes is a list of up to 12 lines, each up to 200 characters.");
    const hasUrl = b.url !== undefined && b.url !== null && b.url !== "";
    const hasKey = b.key !== undefined && b.key !== null && b.key !== "";
    if (hasUrl === hasKey) throw fail(400, "Send exactly one of url (https) or key (from upload-url).");
    let url = null;
    let key = null;
    if (hasUrl) {
      try {
        const u = new URL(String(b.url));
        if (u.protocol !== "https:" || String(b.url).length > 1000) throw new Error("bad");
        url = u.href;
      } catch {
        throw fail(400, "url must be an https address.");
      }
    } else {
      key = String(b.key);
      if (!key.startsWith(`releases/${flavor}/${version}/`) || key.length > 200 || key.includes("..")) throw fail(400, "That key isn't one upload-url gave for this version.");
      const head = await needR2().head(key);
      if (!head) throw fail(400, "The file isn't in storage yet. Upload it first.");
      if (head.size !== size) throw fail(400, `The file in storage is ${head.size} bytes, not ${size}.`);
    }
    const id = newId();
    try {
      await q(`INSERT INTO releases (id, flavor, version, url, r2_key, sha256, size, signature, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, flavor, version, url, key, sha256, size, signature, JSON.stringify(notes.map((n) => n.trim()))]);
    } catch (e) {
      if (e.code === "23505") throw fail(409, `${FLAVORS[flavor]} ${version} is already published.`);
      throw e;
    }
    return c.json(out(await one(`SELECT * FROM releases WHERE id = $1`, [id])));
  });

  admin.post("/releases/:id/withdraw", async (c) => {
    const r = await one(`UPDATE releases SET withdrawn_at = COALESCE(withdrawn_at, now()) WHERE id = $1 RETURNING *`, [c.req.param("id")]);
    if (!r) throw fail(404, "No such release.");
    return c.json({ ...out(r), withdrawnAt: r.withdrawn_at });
  });
}
