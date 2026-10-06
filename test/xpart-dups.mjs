// Checks the duplicate cross-reference finder's pure half (src/xpart-dups.mjs): names a letter apart, grouping by brand and
// shared fit, the batch requests and the verdict reader. No database, no network.
import assert from "node:assert/strict";
import { batchRequests, candidateGroups, distance, estimateDollars, MODEL, parseVerdict, similarNames } from "../src/xpart-dups.mjs";

assert.equal(distance("kitten", "sitting"), 3);
assert.ok(similarNames("Needle plate screw", "Needle plate screws"));
assert.ok(similarNames("Bobbin case", "bobbin  case."));
assert.ok(!similarNames("Bobbin case", "Bobbin cover"), "three letters apart is a different name");
assert.ok(!similarNames("A", "B"), "a short name needs to be exact");
assert.ok(!similarNames("", "x"));

const p = (id, name, brands, fits, numbers = []) => ({ id, name, brandKeys: brands, fitKeys: fits, numbers, fits: fits.map((f) => f.replace("|", " ")) });
const parts = [
  p("a", "Needle plate screw", ["SINGER"], ["SINGER|15-91", "SINGER|201"]),
  p("b", "Needle plate screws", ["SINGER"], ["SINGER|15-91"]),
  p("c", "Needle plate screw", ["JANOME"], ["JANOME|MC6700P"]), // same name, other brand and fits: not a duplicate
  p("d", "Needle plate screw", ["SINGER"], ["SINGER|99K"]), // same brand and name, no shared fit
  p("e", "Needle plate screw.", ["SINGER"], ["SINGER|201"]),
  p("f", "Hook gib", ["SINGER"], ["SINGER|15-91"]),
  p("g", "Hook gibs", ["SINGER", "KENMORE"], ["SINGER|15-91"]),
];
const groups = candidateGroups(parts);
assert.deepEqual(
  groups.map((g) => g.map((x) => x.id).sort()),
  [["f", "g"], ["a", "b", "e"]],
  "a and b share a fit, a and e share one: joined; c and d are left alone",
);
assert.deepEqual(candidateGroups(parts, { maxBucket: 1 }), [], "a fit shared by too many entries says nothing");
assert.equal(candidateGroups([p("x", "Lonely", ["A"], ["A|1"])]).length, 0);

const reqs = batchRequests(groups);
assert.deepEqual(reqs.map((r) => r.custom_id), ["g0", "g1"]);
assert.equal(reqs[0].params.model, MODEL);
assert.match(reqs[1].params.messages[0].content, /\[a\] Needle plate screw \| numbers: none \| fits: SINGER 15-91, SINGER 201/);
assert.deepEqual(parseVerdict('Sure {"verdict":"same","why":"Plural only."}'), { verdict: "same", why: "Plural only." });
assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
assert.equal(parseVerdict("no json"), null);
const cost = estimateDollars(2000);
assert.ok(cost > 1 && cost < 2, `about $1.30 for 2,000 groups, not ${cost}`);
console.log("xpart-dups: all checks passed");
