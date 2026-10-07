// OCR for the markings check (design 0.2): the pages of an uploaded PDF that have no text layer (a scan) are drawn to
// an image and read, then the same STRONG / MEDIUM words as pdfcheck.mjs look at what was read.
//
// Pure JS / WASM, nothing to install on the machine: pdfjs-dist (the PDF drawn to a canvas) with @napi-rs/canvas (a
// prebuilt binary for Linux x64 glibc and musl, Windows and macOS; no compiler) and tesseract.js (WASM, in a worker
// thread) with the English "best_int" traineddata from @tesseract.js-data/eng, read from node_modules (never fetched
// from a CDN, never written to a cache). Pdfjs decodes every image kind a scan uses (CCITT, JBIG2, DCT, Flate).
//
//   ocrOn()                              false when REPO_OCR=off
//   ocrMarkings(bytes, pageNumbers, prior)  -> a markings object (status flagged | clean | not-checked, hits, ocr: {...})
//   ocrQueue(job)                        runs jobs one at a time (concurrency 1), off the request path
//
// Limits (environment, read at call time): REPO_OCR_PAGE_MS 20000 a page (drawing and reading; the worker is stopped
// and started again after a timeout), REPO_OCR_MAX_MB 60 (a bigger file isn't read), REPO_OCR_MAX_RSS_MB 1200 (a page
// waits, then is skipped, while the process is over this resident size). Pages are drawn at about 200 dpi, at most
// 3200 pixels on the long side. The worker is stopped after 60 seconds idle, which gives its memory back.
import path from "node:path";
import { createRequire } from "node:module";
import { markingHits } from "./pdfcheck.mjs";

const require = createRequire(import.meta.url);
const MB = 1024 * 1024;
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
export const ocrOn = () => !/^(off|false|0|no)$/i.test(process.env.REPO_OCR ?? "");

let libs = null;
async function load() {
  if (libs) return libs;
  const [pdfjs, canvas, tess] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas"), import("tesseract.js")]);
  libs = { pdfjs, canvas, tess: tess.default ?? tess };
  return libs;
}

// ----- the OCR worker: one, started when needed, stopped when idle or after a timeout -----
let worker = null;
let workerStarting = null;
let idleTimer = null;
const stopWorker = async () => {
  const w = worker;
  worker = null;
  workerStarting = null;
  clearTimeout(idleTimer);
  if (w) await w.terminate().catch(() => {});
};
async function getWorker() {
  clearTimeout(idleTimer);
  if (worker) return worker;
  if (!workerStarting) {
    workerStarting = (async () => {
      const { tess } = await load();
      const langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
      const w = await tess.createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none", errorHandler: () => {} });
      worker = w;
      return w;
    })().catch((e) => {
      workerStarting = null;
      throw e;
    });
  }
  return workerStarting;
}
const idleSoon = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stopWorker(), 60_000);
  idleTimer.unref?.();
};

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`), { timeout: true })), ms)))]).finally(() => clearTimeout(t));
};

/** One page (1-based) of an open document: drawn, then read. Returns the text. */
async function readPage(doc, n) {
  const { canvas } = await load();
  const page = await doc.getPage(n);
  let task = null;
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(200 / 72, 3200 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const cv = canvas.createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    task = page.render({ canvasContext: ctx, canvas: cv, viewport: vp });
    await task.promise;
    const png = cv.toBuffer("image/png");
    const w = await getWorker();
    const { data } = await w.recognize(png);
    return data.text ?? "";
  } finally {
    try {
      task?.cancel();
    } catch {
      /* already done */
    }
    page.cleanup();
  }
}

const rssMb = () => process.memoryUsage().rss / MB;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the given pages (1-based) of a PDF. Returns { texts: Map(page -> text), failed: [{ page, why }] }.
 * Each page has its own time limit; a failed page doesn't stop the next.
 */
export async function ocrPages(bytes, pageNumbers) {
  const texts = new Map();
  const failed = [];
  if (bytes.length > num("REPO_OCR_MAX_MB", 60) * MB) return { texts, failed: pageNumbers.map((page) => ({ page, why: "file too large to OCR" })) };
  const { pdfjs } = await load();
  let doc;
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: false });
  try {
    doc = await withTimeout(loading.promise, num("REPO_OCR_PAGE_MS", 20_000), "opening the file");
  } catch (e) {
    await loading.destroy().catch(() => {});
    return { texts, failed: pageNumbers.map((page) => ({ page, why: e.timeout ? "timed out" : `couldn't be opened for OCR (${e.message})` })) };
  }
  try {
    // Starting the engine (about 1 to 4 seconds) isn't counted against a page.
    await withTimeout(getWorker(), 60_000, "starting OCR");
  } catch (e) {
    await stopWorker();
    await loading.destroy().catch(() => {});
    return { texts, failed: pageNumbers.map((page) => ({ page, why: `OCR couldn't start (${e.message})` })) };
  }
  try {
    for (const n of pageNumbers) {
      if (n > doc.numPages) {
        failed.push({ page: n, why: "no such page" });
        continue;
      }
      let waited = 0;
      while (rssMb() > num("REPO_OCR_MAX_RSS_MB", 1200) && waited < 3) {
        await sleep(2000);
        waited++;
      }
      if (rssMb() > num("REPO_OCR_MAX_RSS_MB", 1200)) {
        failed.push({ page: n, why: "skipped: the hub's memory use was too high" });
        continue;
      }
      try {
        texts.set(n, await withTimeout(readPage(doc, n), num("REPO_OCR_PAGE_MS", 20_000), `page ${n}`));
      } catch (e) {
        failed.push({ page: n, why: e.timeout ? "timed out" : `OCR failed (${e.message})` });
        // A stuck or broken worker is replaced for the next page.
        await stopWorker();
      }
    }
  } finally {
    await loading.destroy().catch(() => {});
    idleSoon();
  }
  return { texts, failed };
}

/**
 * The markings after OCR. `prior` is the check's answer before OCR (hits and pagesRead of the pages that had text).
 * Hits from OCR are the same rules on the same words; they say they were read by OCR.
 */
export async function ocrMarkings(bytes, pageNumbers, prior = {}) {
  const hits = [...(prior.hits ?? [])];
  const read = [...(prior.pagesRead ?? [])];
  const { texts, failed } = await ocrPages(bytes, pageNumbers);
  for (const [page, text] of texts) {
    read.push(page);
    hits.push(...markingHits(text, page).map((h) => ({ ...h, ocr: true })));
  }
  read.sort((a, b) => a - b);
  const ocr = { pages: pageNumbers, failed };
  if (hits.length) return { status: "flagged", reason: failed.length ? `OCR could not read page${failed.length === 1 ? "" : "s"} ${failed.map((f) => f.page).join(", ")}` : null, hits, pagesRead: read, ocr };
  if (failed.length) {
    const why = [...new Set(failed.map((f) => f.why))].join("; ");
    const timedOut = failed.every((f) => f.why === "timed out");
    return { status: "not-checked", reason: `not checked for markings: OCR ${timedOut ? "timed out" : "failed"} on page${failed.length === 1 ? "" : "s"} ${failed.map((f) => f.page).join(", ")} (${why}); look at the cover yourself`, hits: [], pagesRead: read, ocr };
  }
  // Pages the check before OCR couldn't read at all (prior.unread): never clean while they stay unread.
  const unread = prior.unread ?? [];
  if (unread.length) return { status: "not-checked", reason: `not checked for markings: page${unread.length === 1 ? "" : "s"} ${unread.join(", ")} couldn't be read (look at the cover yourself)`, hits: [], pagesRead: read, ocr };
  return { status: "clean", reason: null, hits: [], pagesRead: read, ocr };
}

// ----- the queue: one job at a time -----
const jobs = [];
let busy = false;
export function ocrQueue(job) {
  jobs.push(job);
  if (busy) return;
  busy = true;
  (async () => {
    while (jobs.length) {
      try {
        await jobs.shift()();
      } catch (e) {
        console.error("ocr job:", e?.message ?? e);
      }
    }
    busy = false;
  })();
}
export const ocrIdle = () => !busy && jobs.length === 0;
export const ocrStop = stopWorker;
