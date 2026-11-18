// Builds the web icon set from the product's NI mark (see public/index.html).
//
// The mark is the user-supplied "NI" logo: charcoal blob, azure diagonal letterforms
// with a soft glow, gray accent bar under the N. Shape constants below were measured
// from the source raster (162x161) and normalised to a unit square, coords in [-0.5, 0.5].
// This script rasterises that geometry with signed distances so the PNG/ICO outputs are
// pixel-faithful to the inline SVG. No dependencies: Node's zlib plus a PNG encoder.
//
//   node scripts/build-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const K = 1 / 162; // source pixels -> canvas units

const COL = {
  field: [0x20, 0x20, 0x20],
  glyph: [0x00, 0x88, 0xc8],
  glow: [0x0a, 0x6f, 0x9e],
  accent: [0x9a, 0x9a, 0x9a],
};

const STEM_R = 7.65 * K;
const DIAG_R = 7.25 * K;
const V_HALF = 23.85 * K;
const STEMS = [-31.7 * K, -1.7 * K, 31.5 * K]; // N left, N middle, I
const ACCENT = { u: -18.4 * K, v0: 2.2 * K, v1: 29.5 * K, r: 2.85 * K };
const TILT = 43.7 * Math.PI / 180; // mark is rotated CCW in the source
const COS = Math.cos(TILT);
const SIN = Math.sin(TILT);

// blob outline as radial harmonics of the source silhouette, longest radius 0.49
const BLOB = [
  [0.45853, 0],
  [-0.00655, -0.01349],
  [0.00558, -0.01223],
  [0.01191, 0.00433],
  [-0.01329, 0.00885],
  [-0.00657, 0.00062],
  [0.00064, 0.00024],
];
const GLOW_SIGMA = 0.026;
const GLOW_GAIN = 0.92;
const SQUIRCLE_R = 0.105;

// ---------- geometry ----------

function toLocal(x, y) {
  return [x * COS - y * SIN, x * SIN + y * COS];
}

function capsule(px, py, ax, ay, bx, by, r) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function blobRadius(ang) {
  let r = BLOB[0][0];
  for (let h = 1; h < BLOB.length; h++) {
    r += BLOB[h][0] * Math.cos(h * ang) + BLOB[h][1] * Math.sin(h * ang);
  }
  return r;
}

function fieldDistance(x, y, field) {
  if (field === 'blob') {
    const ang = Math.atan2(y, x);
    return Math.hypot(x, y) - blobRadius(ang);
  }
  // rounded square, full bleed
  const q = Math.abs(x) - (0.5 - SQUIRCLE_R);
  const s = Math.abs(y) - (0.5 - SQUIRCLE_R);
  const ox = Math.max(q, 0);
  const oy = Math.max(s, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(q, s), 0) + SQUIRCLE_R - 0.5;
}

function glyphDistance(x, y) {
  const [u, v] = toLocal(x, y);
  return Math.min(
    capsule(u, v, STEMS[0], -V_HALF, STEMS[0], V_HALF, STEM_R),
    capsule(u, v, STEMS[1], -V_HALF, STEMS[1], V_HALF, STEM_R),
    capsule(u, v, STEMS[2], -V_HALF, STEMS[2], V_HALF, STEM_R),
    capsule(u, v, STEMS[0], -V_HALF, STEMS[1], V_HALF, DIAG_R)
  );
}

function accentDistance(x, y) {
  const [u, v] = toLocal(x, y);
  return capsule(u, v, ACCENT.u, ACCENT.v0, ACCENT.u, ACCENT.v1, ACCENT.r);
}

// ---------- rasterising ----------

function render(S, opts) {
  // Below ~48px the halo swamps the letterforms, so tighten it and enlarge the mark.
  const compact = S <= 48;
  const { field = 'blob', glow = true, showAccent = true, mark = true } = opts;
  const baseMarkScale = opts.markScale ?? (field === 'squircle' ? 1.06 : 1);
  const markScale = baseMarkScale * (compact ? 1.12 : 1);
  const glowGain = compact ? GLOW_GAIN * 0.35 : GLOW_GAIN;
  const glowSigma = compact ? GLOW_SIGMA * 0.6 : GLOW_SIGMA;
  const ss = S >= 256 ? 2 : S >= 96 ? 3 : S >= 32 ? 4 : 6;
  const step = 1 / (S * ss); // canvas units per subpixel
  const out = Buffer.alloc(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let rA = 0, gA = 0, bA = 0, aA = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / S - 0.5;
          const y = (py + (sy + 0.5) / ss) / S - 0.5;

          const fD = fieldDistance(x, y, field);
          const fCov = Math.max(0, Math.min(1, 0.5 - fD / step));
          if (fCov <= 0) continue;

          const ms = markScale;
          const gD = mark ? glyphDistance(x / ms, y / ms) * ms : 1e9;
          const aD = mark && showAccent ? accentDistance(x / ms, y / ms) * ms : 1e9;

          // layer stack: field -> glow -> glyph/accent
          let cr = COL.field[0];
          let cg = COL.field[1];
          let cb = COL.field[2];

          if (glow && mark) {
            const d = Math.min(gD, aD);
            if (d > 0) {
              const ga = glowGain * Math.exp(-d / (glowSigma * ms)) * fCov;
              cr += (COL.glow[0] - cr) * ga;
              cg += (COL.glow[1] - cg) * ga;
              cb += (COL.glow[2] - cb) * ga;
            }
          }
          const aCov = Math.max(0, Math.min(1, 0.5 - aD / step)) * fCov;
          const gCov = Math.max(0, Math.min(1, 0.5 - gD / step)) * fCov;
          const mix = (base, target, cov) => base + (target - base) * cov;
          // accent sits behind the glyph: in the source it only shows through the gaps
          cr = mix(cr, COL.accent[0], aCov);
          cg = mix(cg, COL.accent[1], aCov);
          cb = mix(cb, COL.accent[2], aCov);
          cr = mix(cr, COL.glyph[0], gCov);
          cg = mix(cg, COL.glyph[1], gCov);
          cb = mix(cb, COL.glyph[2], gCov);

          rA += cr * fCov;
          gA += cg * fCov;
          bA += cb * fCov;
          aA += fCov;
        }
      }
      const n = ss * ss;
      const alpha = aA / n;
      const i = (py * S + px) * 4;
      if (alpha > 0) {
        out[i] = Math.min(255, Math.round(rA / n / alpha));
        out[i + 1] = Math.min(255, Math.round(gA / n / alpha));
        out[i + 2] = Math.min(255, Math.round(bA / n / alpha));
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
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

function encodePNG(S, rgba, forceRGB) {
  const hasAlpha = !forceRGB && rgba.some((v, i) => i % 4 === 3 && v !== 255);
  const channels = hasAlpha ? 4 : 3;
  const stride = S * channels;
  const raw = Buffer.alloc(S * (stride + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      for (let c = 0; c < channels; c++) {
        raw[y * (stride + 1) + 1 + x * channels + c] = rgba[(y * S + x) * 4 + c];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2;
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

// ---------- SVG master ----------

function svgPath() {
  const pts = [];
  const N = 240;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const r = blobRadius(ang) * 1000;
    pts.push([(Math.cos(ang) * r).toFixed(3), (Math.sin(ang) * r).toFixed(3)]);
  }
  return 'M ' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L ') + ' Z';
}

function svgMark() {
  const u = (v) => (v * 1000).toFixed(2);
  const [a, b] = [STEMS[0], STEMS[1]];
  const strokes = [
    `M ${u(a)} ${u(-V_HALF)} L ${u(a)} ${u(V_HALF)}`,
    `M ${u(b)} ${u(-V_HALF)} L ${u(b)} ${u(V_HALF)}`,
    `M ${u(a)} ${u(-V_HALF)} L ${u(b)} ${u(V_HALF)}`,
    `M ${u(STEMS[2])} ${u(-V_HALF)} L ${u(STEMS[2])} ${u(V_HALF)}`,
  ].join(' ');
  const accent = `M ${u(ACCENT.u)} ${u(ACCENT.v0)} L ${u(ACCENT.u)} ${u(ACCENT.v1)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="Nexyl.ai">
  <defs>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${(GLOW_SIGMA * 1000).toFixed(2)}"/>
    </filter>
  </defs>
  <g transform="translate(500 500)"><path d="${svgPath()}" fill="#202020"/></g>
  <g transform="translate(500 500) rotate(-43.7)">
    <g filter="url(#glow)" stroke="#0088c8" stroke-width="${u(STEM_R * 2)}" stroke-linecap="round" fill="none" opacity="0.55">
      <path d="${strokes}"/>
    </g>
    <path d="${strokes}" stroke="#0088c8" stroke-width="${u(STEM_R * 2)}" stroke-linecap="round" fill="none"/>
    <path d="${accent}" stroke="#9a9a9a" stroke-width="${u(ACCENT.r * 2)}" stroke-linecap="round" fill="none"/>
  </g>
</svg>
`;
}

// ---------- outputs ----------

fs.mkdirSync(OUT, { recursive: true });
const written = [];
const put = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  written.push(`${name} (${buf.length} bytes)`);
};

put('logo.svg', Buffer.from(svgMark(), 'utf8'));

const pngCache = new Map();
const icon = (S, opts, forceRGB) => {
  const key = `${S}:${JSON.stringify(opts)}:${!!forceRGB}`;
  if (!pngCache.has(key)) pngCache.set(key, encodePNG(S, render(S, opts), forceRGB));
  return pngCache.get(key);
};

for (const S of [16, 32, 48]) put(`favicon-${S}.png`, icon(S, { field: 'blob' }));
for (const S of [192, 512]) put(`icon-${S}.png`, icon(S, { field: 'squircle' }, true));
put('icon-1024.png', icon(1024, { field: 'squircle' }, true));
put('apple-touch-icon-180.png', icon(180, { field: 'squircle' }, true));
// maskable: whole mark shrunk into the 66% safe circle
for (const S of [192, 512]) put(`icon-maskable-${S}.png`, icon(S, { field: 'squircle', markScale: 0.8 }, true));

put('favicon.ico', encodeICO([16, 32, 48].map((S) => ({ S, png: icon(S, { field: 'blob' }) }))));

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