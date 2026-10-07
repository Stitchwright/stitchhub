// The duplicate cross-reference finder (StitchBench docs/plans/ai-assistant-scope.md 1.5 c): finds entries in the community
// parts cross-reference that are probably the same part filed twice (the same brand, the same machines fitted, names a
// letter or two apart), asks Claude Haiku through the Batch API whether each group is one part, and lists the ones it
// says are. Pure here (no database, no network): scripts/find-duplicate-xparts.mjs reads the rows and runs the batch.
// A person reads the list and merges by hand (mergeCrossRef in the program); nothing here changes the cross-reference.

export const MODEL = "claude-haiku-4-5-20251001";
// Batch API prices, dollars per million tokens (half of the standard Haiku price): input, output.
export const BATCH_PRICE = { input: 0.5, output: 2.5 };

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Levenshtein distance between two strings (the names are short). */
export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Names a letter or two apart: at most 2 edits and at most a fifth of the longer name, ignoring case, spaces and punctuation. */
export function similarNames(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  const d = distance(x, y);
  return d <= 2 && d <= Math.floor(Math.max(x.length, y.length) * 0.2);
}

/**
 * @param {{ id: string, name: string, brandKeys: string[], fitKeys: string[], numbers?: string[], fits?: string[] }[]} parts
 *   fitKeys are "brand_key|model_key"
 * @returns groups (2 to 6 entries each) of parts that share a brand and at least one fit and whose names are close, joined
 *   transitively; a bucket of one fit larger than `maxBucket` is skipped (a part that fits everything says nothing).
 */
export function candidateGroups(parts, { maxBucket = 200, maxGroup = 6 } = {}) {
  const byFit = new Map();
  for (const p of parts) {
    for (const f of new Set(p.fitKeys)) {
      if (!byFit.has(f)) byFit.set(f, []);
      byFit.get(f).push(p);
    }
  }
  const parent = new Map(parts.map((p) => [p.id, p.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const linked = new Set();
  const seen = new Set();
  for (const bucket of byFit.values()) {
    if (bucket.length > maxBucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!a.brandKeys.some((x) => b.brandKeys.includes(x))) continue;
        if (!similarNames(a.name, b.name)) continue;
        parent.set(find(a.id), find(b.id));
        linked.add(a.id);
        linked.add(b.id);
      }
    }
  }
  const groups = new Map();
  for (const p of parts) {
    if (!linked.has(p.id)) continue;
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  return [...groups.values()].filter((g) => g.length >= 2 && g.length <= maxGroup).sort((a, b) => a[0].name.localeCompare(b[0].name));
}

const SYSTEM = `You help a repair shop's community parts list stay tidy. Each group is entries someone filed separately that may be the same physical part. Decide whether ALL of them are one part (the same part under a slightly different name) or whether any is a different part (a different size, length, voltage, side or fit).
Answer with JSON only: {"verdict":"same"|"different"|"unsure","why":"one short sentence"}. Say "same" only when you are confident.`;

const line = (p) => `[${p.id}] ${p.name} | numbers: ${(p.numbers ?? []).slice(0, 6).join("; ") || "none"} | fits: ${(p.fits ?? []).slice(0, 6).join(", ") || "none"}`;

/** The Batch API's requests, one per group (custom_id g0, g1, ...). */
export function batchRequests(groups) {
  return groups.map((g, i) => ({
    custom_id: `g${i}`,
    params: { model: MODEL, max_tokens: 150, system: SYSTEM, messages: [{ role: "user", content: g.map(line).join("\n") }] },
  }));
}

/** { verdict, why } from a model's text, or null when it isn't usable. */
export function parseVerdict(text) {
  const s = String(text ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (!["same", "different", "unsure"].includes(j.verdict)) return null;
    return { verdict: j.verdict, why: String(j.why ?? "").slice(0, 300) };
  } catch {
    return null;
  }
}

/** What running the groups would cost, in dollars: about 800 tokens in and 80 out for a group of two to six. */
export function estimateDollars(groupCount) {
  return (groupCount * (800 * BATCH_PRICE.input + 80 * BATCH_PRICE.output)) / 1_000_000;
}
