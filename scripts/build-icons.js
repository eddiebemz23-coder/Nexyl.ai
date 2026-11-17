// Builds the web icon set from the product's own logo glyph (see public/index.html).
//
// The mark is defined once, in SVG, and this script rasterises that same geometry with
// signed distances so the PNG/ICO outputs are pixel-faithful to the inline SVG rather
// than a hand-redrawn approximation. No dependencies: Node's zlib plus a PNG encoder.
//
//   node scripts/build-icons.js
//
// Geometry, taken verbatim from the <template id="logo-tpl"> artwork at 32x32 units:
//   field   rounded square, inset 0, corner radius 9
//   fill    linear gradient (0,0) -> (1,1), #5eead4 -> #818cf8
//   glyph   polyline (9,23)-(9,9)-(23,23)-(23,9), stroke #0a0c11, width 3.2, round caps/joins

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const C1 = [0x5e, 0xea, 0xd4]; // teal   #5eead4
const C2 = [0x81, 0x8c, 0xf8]; // indigo #818cf8
const INK = [0x0a, 0x0c, 0x11]; // near-black #0a0c11
const RADIUS = 9;
const HALF_W = 1.6;
const PTS = [[9, 23], [9, 9], [23, 23], [23, 9]];
const UNIT = 32;

// ---------- geometry ----------

function sdRoundBox(p, half, r) {
  const qx = Math.abs(p[0]) - half[0] + r;
  const qy = Math.abs(p[1]) - half[1] + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

// A stroked polyline with round caps and joins is exactly the union of its capsules.
function sdGlyph(p) {
  let d = Infinity;
  for (let i = 0; i < PTS.length - 1; i++) d = Math.min(d, sdSegment(p, PTS[i], PTS[i + 1]));
  return d - HALF_W;
}

// ---------- rasterising ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Coverage from a signed distance: full inside half a pixel, zero beyond it.
const cover = (d, px) => clamp01(0.5 - d / px);

function render(S, mode) {
  // mode: 'rounded' transparent-corner app icon, 'square' full-bleed,
  // 'maskable' full-bleed with the glyph shrunk into the 66% safe circle
  const px = UNIT / S; // one device pixel expressed in logo units
  const glyphScale = mode === 'maskable' ? 0.61 : 1;
  const center = UNIT / 2;
  const rgba = Buffer.alloc(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // device pixel (top-left origin) -> logo units (centre origin)
      const ux = ((x + 0.5) / S) * UNIT;
      const uy = ((y + 0.5) / S) * UNIT;
      const p = [ux - center, uy - center];

      const fieldA = mode === 'rounded' ? cover(sdRoundBox(p, [center, center], RADIUS), px) : 1;
      const t = (ux + uy) / UNIT / 2; // SVG gradient position along (0,0)->(1,1)
      const fill = C1.map((c, i) => c + (C2[i] - c) * t);

      const gx = p[0] / glyphScale;
      const gy = p[1] / glyphScale;
      const inkA = cover(sdGlyph([gx, gy]), px / glyphScale);

      // source-over: dark stroke onto gradient field, then field onto transparent
      const aS = inkA, aD = fieldA;
      const outA = aS + aD * (1 - aS);
      const o = (y * S + x) * 4;
      if (outA > 0) {
        for (let i = 0; i < 3; i++) {
          const cS = INK[i] * aS;
          const cD = fill[i] * aD * (1 - aS);
          rgba[o + i] = Math.round(Math.min(255, (cS + cD) / outA));
        }
        rgba[o + 3] = Math.round(outA * 255);
      }
    }
  }
  return rgba;
}

// ---------- PNG / ICO writers ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(S, rgba) {
  const stride = S * 4;
  const raw = Buffer.alloc(S * (stride + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeICO(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ S, png }) => {
    const e = Buffer.alloc(16);
    e[0] = S >= 256 ? 0 : S;
    e[1] = S >= 256 ? 0 : S;
    e[4] = 1; // planes
    e[6] = 32; // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

// ---------- outputs ----------

const svgMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Nexyl.ai">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#g)"/>
  <path d="M9 23V9l14 14V9" fill="none" stroke="#0a0c11" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const written = [];
const put = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  written.push(`${name} (${buf.length} bytes)`);
};

put('logo.svg', Buffer.from(svgMark, 'utf8'));

const pngCache = new Map();
const icon = (S, mode = 'rounded') => {
  const key = `${S}:${mode}`;
  if (!pngCache.has(key)) pngCache.set(key, encodePNG(S, render(S, mode)));
  return pngCache.get(key);
};

for (const S of [16, 32, 48]) put(`favicon-${S}.png`, icon(S));
for (const S of [192, 512]) put(`icon-${S}.png`, icon(S));
put('icon-1024.png', icon(1024, 'square'));
put('apple-touch-icon-180.png', icon(180, 'square'));
for (const S of [192, 512]) put(`icon-maskable-${S}.png`, icon(S, 'maskable'));

put('favicon.ico', encodeICO([16, 32, 48].map((S) => ({ S, png: icon(S) }))));

const manifest = {
  name: 'Nexyl.ai',
  short_name: 'Nexyl',
  description: 'Ask. Calculate. Remember. A full-stack JavaScript assistant built on Express and PostgreSQL.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0a0c11',
  theme_color: '#0a0c11',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
put('site.webmanifest', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));

console.log(`wrote ${written.length} files to ${path.relative(process.cwd(), OUT)}`);
for (const w of written) console.log('  ' + w);
