// A small JSON Schema checker for the Stitch contracts (no dependencies, so both repos can carry it as is).
// It supports only the keywords the schemas in this folder use, and THROWS on any other keyword, so a schema can never
// quietly rely on something this file ignores. Supported: type (string or array), enum, const, required, properties,
// additionalProperties (boolean or schema), items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
// format ("date-time" only), oneOf, anyOf, $ref (a sibling file name or "#/$defs/name"), $defs, and the notes
// $schema, $id, title, description, examples, default, $comment.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const NOTES = new Set(["$schema", "$id", "title", "description", "examples", "default", "$comment", "$defs"]);
const KEYWORDS = new Set(["type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "format", "oneOf", "anyOf", "$ref"]);
const cache = new Map();

export function loadSchema(name) {
  const file = name.endsWith(".json") ? name : `${name}.json`;
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(path.join(DIR, "schemas", file), "utf8")));
  return cache.get(file);
}

export function loadExample(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, "examples", name.endsWith(".json") ? name : `${name}.json`), "utf8"));
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

/** The problems with `value` against the schema (a name in schemas/, or the schema object), as short strings. [] = valid. */
export function check(schema, value, file = "", at = "$", root = null) {
  const s = typeof schema === "string" ? loadSchema(schema) : schema;
  const here = typeof schema === "string" ? schema : file;
  const top = root ?? s;
  const errors = [];
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k) && !NOTES.has(k)) throw new Error(`contracts/validate.mjs does not support the keyword "${k}" (${here || "inline schema"})`);
  if (s.$ref) {
    const ref = s.$ref;
    if (ref.startsWith("#/$defs/")) {
      const def = top.$defs?.[ref.slice(8)];
      if (!def) throw new Error(`unknown ${ref} in ${here}`);
      return check(def, value, here, at, top);
    }
    return check(loadSchema(ref), value, ref, at, null);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => isType(value, t))) return [`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: not one of ${JSON.stringify(s.enum)}`);
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    if (s.minLength != null && value.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (s.maxLength != null && value.length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${at}: does not match ${s.pattern}`);
    if (s.format === "date-time" && !(/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)))) errors.push(`${at}: not a date-time`);
  }
  if (typeof value === "number") {
    if (s.minimum != null && value < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (s.maximum != null && value > s.maximum) errors.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems != null && value.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems != null && value.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...check(s.items, v, here, `${at}[${i}]`, top)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const r of s.required ?? []) if (!(r in value)) errors.push(`${at}: missing "${r}"`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in value) errors.push(...check(sub, value[k], here, `${at}.${k}`, top));
    if (s.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in (s.properties ?? {}))) errors.push(`${at}: unexpected "${k}"`);
    else if (s.additionalProperties && typeof s.additionalProperties === "object") for (const k of Object.keys(value)) if (!(k in (s.properties ?? {}))) errors.push(...check(s.additionalProperties, value[k], here, `${at}.${k}`, top));
  }
  if (s.oneOf) {
    const ok = s.oneOf.filter((sub) => check(sub, value, here, at, top).length === 0).length;
    if (ok !== 1) errors.push(`${at}: matches ${ok} of the oneOf options, must match exactly 1`);
  }
  if (s.anyOf && !s.anyOf.some((sub) => check(sub, value, here, at, top).length === 0)) errors.push(`${at}: matches none of the anyOf options`);
  return errors;
}
