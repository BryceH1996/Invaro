// Draws the Invaro "Receipt i" app icon (the same artwork as build/icon.svg) as a PNG, with no dependencies.
//   node build/make-icon.js                                   -> build/icon.png (1024x1024, as macOS needs at least 512)
//   node build/make-icon.js --size 180 --out docs/apple-touch-icon.png --full
// --full fills the whole image with the tile; without it the tile keeps a small transparent margin, as app icons do.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const S = Number(arg('--size', 1024));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'icon.png')));
const SS = S <= 256 ? 4 : 2; // supersampling per axis
// Shapes below are in the SVG's 48-unit coordinates. The tile spans 240/256 of the image unless --full.
const M = process.argv.includes('--full') ? 0 : S * 8 / 256, K = (S - 2 * M) / 48;
const INK = [14, 31, 59], BRAND = [14, 124, 134], WHITE = [255, 255, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inPolygon(x, y, pts) { // even-odd ray cast
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// The torn receipt: M18 20 H30 V40 L27 37.5 L24 40 L21 37.5 L18 40 Z
const RECEIPT = [[18, 20], [30, 20], [30, 40], [27, 37.5], [24, 40], [21, 37.5], [18, 40]];
// Paint order: later shapes win.
const shapes = [
  [p => inRoundRect(p.x, p.y, 0, 0, 48, 48, 12), INK],
  [p => (p.x - 24) ** 2 + (p.y - 12.5) ** 2 <= 5.5 ** 2, BRAND],
  [p => inPolygon(p.x, p.y, RECEIPT), WHITE],
];

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const p = { x: (x + (sx + 0.5) / SS - M) / K, y: (y + (sy + 0.5) / SS - M) / K };
      let col = null;
      for (const [hit, c] of shapes) if (hit(p)) col = c;
      if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
    }
    const n = SS * SS, o = y * (S * 4 + 1) + 1 + x * 4, cov = a / 255;
    raw[o] = cov ? Math.round(r / cov) : 0;
    raw[o + 1] = cov ? Math.round(g / cov) : 0;
    raw[o + 2] = cov ? Math.round(b / cov) : 0;
    raw[o + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${S}x${S})`);
