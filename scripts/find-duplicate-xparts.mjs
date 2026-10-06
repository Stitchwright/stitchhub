// The owner's duplicate cross-reference finder (docs/plans/ai-assistant-scope.md 1.5 c; run about once a quarter).
//   node scripts/find-duplicate-xparts.mjs --dry              groups found and what asking would cost; nothing is sent
//   node scripts/find-duplicate-xparts.mjs [--out file.json]  asks Claude Haiku through the Batch API (about $1.30 for the
//                                                             whole cross-reference), waits, prints the groups it says are
//                                                             one part and writes every verdict to the file
// Needs DATABASE_URL (the hub's) and, to ask, ANTHROPIC_API_KEY. Reads only; nothing in the cross-reference is changed:
// open the entries in the program as an administrator and use "Merge" on the ones you agree with.
import "../src/env.mjs";
import fs from "node:fs";
import { q } from "../src/db.mjs";
import { candidateGroups, batchRequests, estimateDollars, parseVerdict, MODEL } from "../src/xpart-dups.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : "duplicate-xparts.json";
const BASE = (process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com").replace(/\/+$/, "");

const rows = (
  await q(`
  SELECT x.id, x.name,
         coalesce((SELECT array_agg(DISTINCT n.brand_key) FROM xpart_numbers n WHERE n.xpart_id = x.id), '{}') AS brand_keys,
         coalesce((SELECT array_agg(n.brand || ' ' || n.number) FROM xpart_numbers n WHERE n.xpart_id = x.id), '{}') AS numbers,
         coalesce((SELECT array_agg(f.brand_key || '|' || f.model_key) FROM xpart_fits f WHERE f.xpart_id = x.id), '{}') AS fit_keys,
         coalesce((SELECT array_agg(f.brand || ' ' || f.model) FROM xpart_fits f WHERE f.xpart_id = x.id), '{}') AS fits
  FROM xparts x WHERE NOT x.deleted`)
).rows;
const groups = candidateGroups(rows.map((r) => ({ id: r.id, name: r.name, brandKeys: r.brand_keys, fitKeys: r.fit_keys, numbers: r.numbers, fits: r.fits })));
console.log(`${rows.length} entries, ${groups.length} groups of near-identical names with the same brand and a shared fit.`);
console.log(`Asking about them would cost about $${estimateDollars(groups.length).toFixed(2)} (${MODEL}, Batch API).`);
if (dry || !groups.length) {
  for (const g of groups.slice(0, 40)) console.log(`  ${g.map((p) => `${p.name} (${p.id})`).join("  /  ")}`);
  if (groups.length > 40) console.log(`  ... and ${groups.length - 40} more`);
  process.exit(0);
}
const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
if (!key) {
  console.error("ANTHROPIC_API_KEY isn't set, so nothing can be asked. Use --dry to see the groups.");
  process.exit(1);
}
const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`Anthropic ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
};
const requests = batchRequests(groups);
const batch = await (await api("/v1/messages/batches", { method: "POST", body: JSON.stringify({ requests }) })).json();
console.log(`Batch ${batch.id} sent; waiting (a batch usually finishes within the hour).`);
let state = batch;
while (state.processing_status !== "ended") {
  await new Promise((r) => setTimeout(r, 30_000));
  state = await (await api(`/v1/messages/batches/${batch.id}`)).json();
  console.log(`  ${state.processing_status}: ${JSON.stringify(state.request_counts ?? {})}`);
}
const text = await (await api(`/v1/messages/batches/${batch.id}/results`)).text();
const verdicts = [];
for (const ln of text.split("\n").filter(Boolean)) {
  const r = JSON.parse(ln);
  const g = groups[Number(String(r.custom_id).slice(1))];
  const v = r.result?.type === "succeeded" ? parseVerdict(r.result.message?.content?.[0]?.text) : null;
  if (g) verdicts.push({ ids: g.map((p) => p.id), names: g.map((p) => p.name), verdict: v?.verdict ?? "error", why: v?.why ?? r.result?.type ?? "" });
}
fs.writeFileSync(outFile, JSON.stringify(verdicts, null, 2));
const same = verdicts.filter((v) => v.verdict === "same");
console.log(`${same.length} of ${verdicts.length} groups look like one part (all verdicts are in ${outFile}):`);
for (const v of same) console.log(`  ${v.names.join("  /  ")}\n    ${v.ids.join(" ")}  ${v.why}`);
process.exit(0);
