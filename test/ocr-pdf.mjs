// A scanned-style PDF maker for the OCR tests: each page is one gray image (text drawn with @napi-rs/canvas, then
// embedded as the page's only content, Flate-compressed DeviceGray), no text layer, as a scanner's output has.
import zlib from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";

/** pages: an array of lines-of-text arrays ([] = a blank page). Returns a PDF Buffer. */
export function scannedPdf(pages, { width = 1275, height = 1650 } = {}) {
  const objs = [];
  const add = (n, body) => objs.push(Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, "latin1"));
  const raw = (n, dict, bytes) => objs.push(Buffer.concat([Buffer.from(`${n} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`, "latin1"), bytes, Buffer.from("\nendstream\nendobj\n", "latin1")]));
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((lines, i) => {
    const cv = createCanvas(width, height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    ctx.font = "bold 64px sans-serif";
    lines.forEach((t, k) => ctx.fillText(t, 100, 300 + k * 140));
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const gray = Buffer.alloc(width * height);
    for (let p = 0; p < gray.length; p++) gray[p] = rgba[p * 4];
    const n = 3 + 3 * i;
    add(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${n + 1} 0 R /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> >>`);
    raw(n + 1, "/Filter /FlateDecode", zlib.deflateSync(Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q")));
    raw(n + 2, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(gray));
  });
  const total = 3 + 3 * pages.length;
  return Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), ...objs, Buffer.from(`trailer\n<< /Root 1 0 R /Size ${total} >>\n%%EOF\n`, "latin1")]);
}
