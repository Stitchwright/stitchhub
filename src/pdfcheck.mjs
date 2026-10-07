// The hub's own look at an uploaded PDF (design section 6.4 and 0.2), with no dependency: node:zlib and a small reader.
//
//   inspectPdf(buffer) -> { refused: "why, in words" }                        a file the hub won't take
//                       | { pages, flags: [{ code, text }], markings }       taken (for the owner's review)
//
// Refused: not a PDF (the first bytes), encrypted (/Encrypt), or naming /JavaScript, /JS, /Launch, /EmbeddedFile,
// /RichMedia or /XFA. Names are searched in the PDF's own syntax (the dictionaries between the streams) and in the
// object streams (where a modern PDF keeps its dictionaries), inflated up to 64 MB: not in picture or font data, which
// would hold the same few bytes by chance in a big file. Names written with #-escapes (/J#53) are found too. A file the
// reader can't make sense of is flagged, not refused (the owner looks at it).
//
// Markings (0.2): the first three pages and the last are read for the words scan_markings.py looks for (strong:
// confidential, dealer only, internal use only, not for distribution, restricted, proprietary and confidential; medium:
// service personnel only, not to be given to end users). The page tree is followed from /Root, each page's content
// streams inflated (Flate, or none), and the strings of the text operators collected. That reads plain text with a
// standard encoding, which is how covers and stamps are mostly set; text in a font with its own encoding (Identity-H
// subsets) comes out as noise and a scan has none, so a page with under 20 letters counts as "not read" and, with { ocr: true }, is listed in
// markings.ocrPages for src/ocr.mjs (status "checking" until that has run). If none of the
// pages read, the answer is "not checked: scan or unreadable text" for the owner to look at the cover himself. A hit is
// a flag with the page and the words around it, never a refusal (lawyer question L1).
//
// Every inflate (object streams and page contents) counts against the one 64 MB budget, and a content stream named by
// several pages is read once. The upload path calls inspectPdfIsolated: the same check in a worker thread with a time
// limit (REPO_CHECK_MS, 60000) and a heap limit (REPO_CHECK_HEAP_MB, 1024), so a hostile file can't stall the hub; a
// file that runs over either is refused.
import zlib from "node:zlib";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const MB = 1024 * 1024;
const INFLATE_BUDGET = 64 * MB;

// ----- the names that make a file refused -----
const hexName = (name) =>
  [...name]
    .map((ch) => {
      const h = ch.charCodeAt(0).toString(16).padStart(2, "0");
      const both = h.replace(/[a-f]/g, (x) => `[${x}${x.toUpperCase()}]`);
      return `(?:${/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[^\w]/g, "\\$&")}|#${both})`;
    })
    .join("");
const FORBIDDEN = ["JavaScript", "JS", "Launch", "EmbeddedFile", "RichMedia", "XFA"].map((n) => ({ n, rx: new RegExp(`/${hexName(n)}(?=[\\s()<>\\[\\]{}/%]|$)`) }));
const ENCRYPT = new RegExp(`/${hexName("Encrypt")}(?=[\\s()<>\\[\\]{}/%]|$)`);
const forbiddenIn = (text) => FORBIDDEN.find((f) => f.rx.test(text))?.n ?? null;

// ----- markings: scan_markings.py's rules -----
export const STRONG = [
  ["confidential", /\b(company\s+)?confidential\b/i],
  ["dealer only", /\b(for\s+)?(authori[sz]ed\s+)?dealers?(\s+use)?\s+only\b/i],
  ["internal use only", /\binternal\s+use\s+only\b|\bfor\s+internal\s+use\b/i],
  ["not for distribution", /\bnot\s+for\s+(public\s+)?(distribution|circulation|release|sale)\b|\bdo\s+not\s+(distribute|circulate)\b/i],
  ["restricted", /\brestricted\s+(document|information|distribution)\b/i],
  ["proprietary", /\bproprietary(\s+and\s+confidential|\s+information|\s+document)\b/i],
];
export const MEDIUM = [
  ["service personnel only", /\b(for\s+)?(authori[sz]ed\s+|qualified\s+)?(service|repair)\s+(personnel|technicians?|engineers?|centers?|centres?)\s+only\b/i],
  ["not to the end user", /\bnot\s+(to\s+be\s+)?(given|provided|supplied|distributed)\s+to\s+(the\s+)?(end\s+)?(users?|customers?|consumers?)\b/i],
];

/** Hits in one page's text: [{ level, label, page, context }] (the words around, 50 characters each way). */
export function markingHits(text, page) {
  const flat = text.replace(/\s+/g, " ");
  const hits = [];
  for (const [level, rules] of [["strong", STRONG], ["medium", MEDIUM]]) {
    for (const [label, rx] of rules) {
      const m = rx.exec(flat);
      if (m) hits.push({ level, label, page, context: flat.slice(Math.max(0, m.index - 50), Math.min(flat.length, m.index + m[0].length + 50)).trim() });
    }
  }
  return hits;
}

// ----- reading the file -----

const inflate = (data, max) => {
  try {
    return zlib.inflateSync(data, { maxOutputLength: max });
  } catch (e) {
    if (e.code === "ERR_BUFFER_TOO_LARGE") throw e;
    // A truncated or slightly damaged stream still gives what came before the damage.
    return zlib.inflateSync(data, { maxOutputLength: max, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
};

const budgetError = () => Object.assign(new Error("the inflate budget is spent"), { code: "ERR_BUFFER_TOO_LARGE", budget: true });
/** Inflates against the file's one budget ({ left } bytes); throws once it is spent. */
function inflateCounted(data, budget, cap) {
  if (budget.left <= 0) throw budgetError();
  let bytes;
  try {
    bytes = inflate(data, Math.min(budget.left, cap));
  } catch (e) {
    if (e.code === "ERR_BUFFER_TOO_LARGE" && budget.left <= cap) budget.left = 0;
    throw e;
  }
  budget.left -= bytes.length;
  return bytes;
}

/** The objects of a file as { dict (text), data (the stream's bytes or null) }, by object number, in file order. */
function readObjects(buf, raw, flags, budget) {
  const objs = new Map();
  const structure = []; // text outside stream data, for the name search
  const rx = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let m;
  let last = 0;
  while ((m = rx.exec(raw))) {
    structure.push(raw.slice(last, m.index));
    const end = raw.indexOf("endobj", rx.lastIndex);
    const stop = end < 0 ? raw.length : end;
    const body = rx.lastIndex;
    // Searched within this object only (to its endobj): a search to the end of the file from every object is quadratic.
    const rel = raw.slice(body, stop).indexOf("stream");
    const s = rel < 0 ? -1 : body + rel;
    let dict;
    let data = null;
    if (s >= 0) {
      dict = raw.slice(body, s);
      let from = s + 6;
      if (raw[from] === "\r") from++;
      if (raw[from] === "\n") from++;
      const e = from < stop ? raw.slice(from, stop).indexOf("endstream") : -1;
      data = buf.subarray(from, e < 0 ? stop : from + e);
    } else dict = raw.slice(body, stop);
    structure.push(dict);
    objs.set(Number(m[1]), { dict, data });
    last = stop;
    rx.lastIndex = Math.max(stop, rx.lastIndex);
  }
  structure.push(raw.slice(last));
  // Object streams: their objects are dictionaries too, and are searched for the forbidden names.
  let unreadable = 0;
  for (const [, o] of [...objs]) {
    if (!o.data || !/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
    try {
      const flate = /\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(o.dict);
      const bytes = flate ? inflateCounted(o.data, budget, INFLATE_BUDGET) : o.data;
      const text = bytes.toString("latin1");
      const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
      const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
      const head = text.slice(0, first).trim().split(/\s+/).map(Number);
      structure.push(text);
      for (let i = 0; i < n && 2 * i + 1 < head.length; i++) {
        const num = head[2 * i];
        const at = first + head[2 * i + 1];
        const next = i + 1 < n ? first + head[2 * i + 3] : text.length;
        if (!objs.has(num) || !objs.get(num).data) objs.set(num, { dict: text.slice(at, next), data: null });
      }
    } catch (e) {
      unreadable++;
      if (e.code === "ERR_BUFFER_TOO_LARGE") flags.push({ code: "inflate-budget", text: "An object stream inflates past the hub's 64 MB check budget: the file wasn't fully checked for scripts." });
    }
  }
  if (unreadable && !flags.some((f) => f.code === "inflate-budget")) flags.push({ code: "objstm-unreadable", text: `${unreadable} object stream(s) couldn't be read: the file wasn't fully checked for scripts.` });
  return { objs, structure };
}

const refsIn = (s) => [...s.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));

/** The pages in order (object numbers), from the root; null when there is no page tree to follow. */
function pageOrder(objs, structure) {
  const tail = structure.join("\n");
  const roots = [...tail.matchAll(/\/Root\s+(\d+)\s+\d+\s+R\b/g)];
  let catalog = roots.length ? Number(roots[roots.length - 1][1]) : null;
  if (catalog == null) for (const [n, o] of objs) if (/\/Type\s*\/Catalog\b/.test(o.dict)) catalog = n;
  const top = catalog != null ? Number(/\/Pages\s+(\d+)\s+\d+\s+R\b/.exec(objs.get(catalog)?.dict ?? "")?.[1]) : NaN;
  if (!Number.isInteger(top)) return null;
  const pages = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (seen.has(n) || depth > 40 || pages.length > 50000) return;
    seen.add(n);
    const d = objs.get(n)?.dict;
    if (d == null) return;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d);
    if (kids) for (const k of refsIn(kids[1])) walk(k, depth + 1);
    else if (/\/Type\s*\/Page\b(?!s)/.test(d) || /\/Contents\b/.test(d)) pages.push(n);
  };
  walk(top, 0);
  const count = Number(/\/Count\s+(\d+)/.exec(objs.get(top)?.dict ?? "")?.[1]);
  return { pages, count: Number.isInteger(count) && count > 0 ? count : pages.length };
}

/** The decoded bytes of an object's stream: Flate or no filter; null for any other filter or no stream. */
function streamOf(o, budget) {
  if (!o?.data) return null;
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict)?.[1];
  if (!filter) return o.data;
  const names = [...filter.matchAll(/\/(\w+)/g)].map((x) => x[1]);
  if (names.length !== 1 || names[0] !== "FlateDecode") return null;
  return inflateCounted(o.data, budget, 16 * MB);
}

/** The text of a page's content stream(s): the strings of the text-showing operators, TJ gaps over 200 as spaces. */
function textOfContent(bytes) {
  const s = bytes.toString("latin1");
  const out = [];
  const lit = (i) => {
    let depth = 1;
    let str = "";
    for (i++; i < s.length && depth; i++) {
      const c = s[i];
      if (c === "\\") {
        const n = s[++i];
        if (n === "n" || n === "r" || n === "t") str += " ";
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
          str += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (n === "\n" || n === "\r") {
          /* a line continued */
        } else str += n;
      } else if (c === "(") {
        depth++;
        str += c;
      } else if (c === ")") {
        if (--depth) str += c;
      } else str += c;
    }
    return [str, i];
  };
  let inText = false;
  for (let i = 0; i < s.length && out.length < 200000; ) {
    const c = s[i];
    if (c === "(") {
      const [str, next] = lit(i);
      if (inText) out.push(str);
      i = next;
    } else if (c === "<" && s[i + 1] !== "<") {
      const e = s.indexOf(">", i);
      if (e < 0) break;
      if (inText) {
        const hx = s.slice(i + 1, e).replace(/\s+/g, "");
        let str = "";
        for (let k = 0; k + 1 < hx.length; k += 2) str += String.fromCharCode(parseInt(hx.slice(k, k + 2), 16) || 32);
        out.push(str);
      }
      i = e + 1;
    } else if (c === "[" && inText) {
      // a TJ array: strings joined, a big negative number is a space
      i++;
      let piece = "";
      while (i < s.length && s[i] !== "]") {
        if (s[i] === "(") {
          const [str, next] = lit(i);
          piece += str;
          i = next;
        } else if (/[-\d.]/.test(s[i])) {
          const m = /^-?\d*\.?\d+/.exec(s.slice(i, i + 24));
          if (m && Number(m[0]) < -200) piece += " ";
          i += m ? m[0].length : 1;
        } else i++;
      }
      out.push(piece);
      i++;
    } else if (c === "B" && s[i + 1] === "T" && /[\s\d]/.test(s[i - 1] ?? " ") && /[\s]/.test(s[i + 2] ?? " ")) {
      inText = true;
      i += 2;
    } else if (c === "E" && s[i + 1] === "T" && /[\s)\]]/.test(s[i - 1] ?? " ") && /[\s]/.test(s[i + 2] ?? " ")) {
      inText = false;
      out.push("\n");
      i += 2;
    } else i++;
  }
  return out.join(" ");
}

const letters = (t) => (t.match(/[A-Za-z]/g) ?? []).length;

/** The markings part: which pages were read and what they say. */
function markingsOf(objs, order, ocr, budget) {
  if (!order || !order.pages.length) return { status: "not-checked", reason: "not checked for markings: the file's pages couldn't be found", hits: [], pagesRead: [] };
  const n = order.pages.length;
  const want = [...new Set([0, 1, 2, n - 1].filter((i) => i >= 0 && i < n))];
  const hits = [];
  const read = [];
  const ocrPages = [];
  const texts = new Map(); // a content stream named by several pages is read once
  for (const i of want) {
    const page = objs.get(order.pages[i]);
    const c = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R\b)/.exec(page?.dict ?? "")?.[1];
    if (!c) continue;
    let refs = refsIn(c);
    if (c[0] !== "[" && refs.length === 1) {
      const d = objs.get(refs[0]);
      if (d && !d.data && /^\s*\[/.test(d.dict)) refs = refsIn(d.dict); // the contents array is an object of its own
    }
    let text = "";
    try {
      // Each stream once per page (the same one drawn again adds no words), and a page's words up to 4 MB.
      for (const r of new Set(refs.slice(0, 40))) {
        if (text.length > 4 * MB) break;
        if (!texts.has(r)) {
          const bytes = streamOf(objs.get(r), budget);
          texts.set(r, bytes ? `${textOfContent(bytes)}\n` : "");
        }
        text += texts.get(r);
      }
    } catch (e) {
      if (e.budget) throw e;
      continue;
    }
    if (letters(text) < 20) {
      ocrPages.push(i + 1);
      continue;
    }
    read.push(i + 1);
    hits.push(...markingHits(text, i + 1));
  }
  // Pages with no text layer (a scan): with OCR on they are read afterwards (src/ocr.mjs), and the answer waits.
  if (ocr && ocrPages.length) return { status: "checking", reason: "checking for markings (reading the scanned pages)", hits, pagesRead: read, ocrPages };
  if (!read.length) return { status: "not-checked", reason: "not checked for markings: scan or unreadable text (look at the cover yourself)", hits: [], pagesRead: [] };
  return { status: hits.length ? "flagged" : "clean", reason: null, hits, pagesRead: read };
}

export function inspectPdf(buf, { ocr = false } = {}) {
  if (buf.length < 8 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { refused: "That file isn't a PDF (it doesn't start with %PDF-)." };
  const raw = buf.toString("latin1");
  const flags = [];
  const budget = { left: INFLATE_BUDGET };
  let objs;
  let structure;
  try {
    ({ objs, structure } = readObjects(buf, raw, flags, budget));
  } catch (e) {
    return { pages: null, flags: [{ code: "unreadable", text: `The file's structure couldn't be read (${e.message}): look at it before approving.` }], markings: { status: "not-checked", reason: "not checked for markings: the file couldn't be read", hits: [], pagesRead: [] } };
  }
  const all = structure.join("\n");
  if (ENCRYPT.test(all)) return { refused: "That PDF is encrypted. Save it again without protection that only you may remove (for example with Microsoft Print to PDF) if you may share it." };
  const bad = forbiddenIn(all);
  if (bad) return { refused: `That PDF contains /${bad} (a script, a launch action or an embedded file). Save it again with Microsoft Print to PDF to leave that out.` };
  if (!objs.size) flags.push({ code: "no-objects", text: "No objects were found in the file: it may be damaged." });
  let order = null;
  try {
    order = pageOrder(objs, structure);
  } catch {
    /* no page tree: flagged below */
  }
  if (!order) flags.push({ code: "no-page-tree", text: "The page tree couldn't be followed: the page count and the markings aren't known." });
  let markings;
  try {
    markings = markingsOf(objs, order, ocr, budget);
  } catch (e) {
    markings = { status: "not-checked", reason: e.budget ? "not checked for markings: the file's streams inflate past the hub's 64 MB check budget" : `not checked for markings: ${e.message}`, hits: [], pagesRead: [] };
  }
  return { pages: order?.count ?? null, flags, markings };
}

const envNum = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/**
 * inspectPdf in a worker thread, off the hub's main thread: the same answer, or { refused } when the check runs past its
 * time (REPO_CHECK_MS) or its heap (REPO_CHECK_HEAP_MB), or the worker fails. The worker is stopped either way.
 */
export function inspectPdfIsolated(buf, opts = {}) {
  const ms = envNum("REPO_CHECK_MS", 60_000);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const w = new Worker(new URL(import.meta.url), {
      workerData: { pdfcheck: true, bytes: buf, opts },
      resourceLimits: { maxOldGenerationSizeMb: envNum("REPO_CHECK_HEAP_MB", 1024), maxYoungGenerationSizeMb: 64 },
    });
    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.terminate().catch(() => {});
      resolve(answer);
    };
    timer = setTimeout(() => finish({ refused: `The hub couldn't finish checking that PDF within ${Math.round(ms / 1000)} seconds. Save it again (for example with Microsoft Print to PDF) and offer it again.` }), ms);
    w.once("message", finish);
    w.once("error", (e) =>
      finish({ refused: e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "That PDF needs more memory to check than the hub allows. Save it again (for example with Microsoft Print to PDF) and offer it again." : "The hub couldn't check that PDF. Save it again (for example with Microsoft Print to PDF) and offer it again." }),
    );
    w.once("exit", () => finish({ refused: "The hub couldn't check that PDF. Save it again (for example with Microsoft Print to PDF) and offer it again." }));
  });
}

// The worker side of inspectPdfIsolated.
if (!isMainThread && workerData?.pdfcheck) {
  const b = workerData.bytes;
  parentPort.postMessage(inspectPdf(Buffer.from(b.buffer, b.byteOffset, b.byteLength), workerData.opts));
}
