// A small QR code maker for the shop-hop passport (src/hops.mjs): the code "HOP-7K2M-9QXD" as a version 1 symbol
// (21 x 21), error correction M, alphanumeric mode, which holds up to 20 of the characters 0-9 A-Z space $ % * + - . / :.
// That is all the passport needs, so the hub takes no QR library. Built after ISO/IEC 18004 (and Project Nayuki's
// QR Code generator, MIT, for the layout): data, Reed-Solomon check words, finder and timing patterns, format bits, and
// the mask with the lowest penalty. Returns an SVG.

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const SIZE = 21;
const DATA_WORDS = 16; // version 1-M: 26 code words, 16 of data
const EC_WORDS = 10;

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < r.length; i++) r[i] ^= gfMul(divisor[i], factor);
  }
  return r;
}

/** The 26 code words for `text` (alphanumeric, at most 20 characters). */
export function codewords(text) {
  const t = String(text);
  if (t.length > 20 || [...t].some((ch) => !ALNUM.includes(ch))) throw new Error("A version 1 QR code here holds up to 20 of 0-9 A-Z space $ % * + - . / :");
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0010, 4); // alphanumeric mode
  put(t.length, 9);
  for (let i = 0; i + 1 < t.length; i += 2) put(ALNUM.indexOf(t[i]) * 45 + ALNUM.indexOf(t[i + 1]), 11);
  if (t.length % 2) put(ALNUM.indexOf(t[t.length - 1]), 6);
  const cap = DATA_WORDS * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < DATA_WORDS; pad ^= 0xec ^ 0x11) data.push(pad);
  return [...data, ...rsRemainder(data, rsDivisor(EC_WORDS))];
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(words, mask) {
  const m = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
  const fn = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < SIZE; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Format bits: level M (00) and the mask, BCH(15,5), XOR 0x5412.
  const fdata = (0 << 3) | mask;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const f = ((fdata << 10) | rem) ^ 0x5412;
  const bit = (i) => ((f >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
  set(8, SIZE - 8, true); // the dark module
  // The code words, two columns at a time from the bottom right, up and down in turn, skipping the timing column.
  let i = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? SIZE - 1 - vert : vert;
        if (fn[y][x]) continue;
        const dark = i < words.length * 8 ? ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
        i++;
        m[y][x] = dark !== MASKS[mask](x, y);
      }
    }
  }
  return m;
}

// The penalty rules for runs of one colour, 2 x 2 blocks, finder-like patterns and the dark/light balance.
function penalty(m) {
  let p = 0;
  const lines = [...m, ...m[0].map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
    const s = line.map((d) => (d ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) for (let k = s.indexOf(pat); k !== -1; k = s.indexOf(pat, k + 1)) p += 40;
  }
  for (let y = 0; y + 1 < SIZE; y++) for (let x = 0; x + 1 < SIZE; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  const dark = m.flat().filter(Boolean).length;
  p += Math.floor(Math.abs(dark * 20 - SIZE * SIZE * 10) / (SIZE * SIZE)) * 10;
  return p;
}

/** The modules (true = dark) of the QR code for `text`, rows top to bottom. */
export function qrModules(text) {
  const words = codewords(text);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(words, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { m, p };
  }
  return best.m;
}

/** An SVG of the QR code (a 4-module quiet zone), `px` wide. */
export function qrSvg(text, px = 240) {
  const m = qrModules(text);
  const n = SIZE + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${text}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
