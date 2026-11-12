// Generates build/icon.png (256x256) with no dependencies. Run: node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256, SS = 4; // size, supersampling
const GOLD = [191, 144, 0], WHITE = [255, 255, 255], LIGHT = [255, 229, 153], LINE = [214, 190, 120];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Paint order: later shapes win.
const shapes = [
  [p => inRoundRect(p.x, p.y, 8, 8, 248, 248, 52), GOLD],
  [p => inRoundRect(p.x, p.y, 66, 40, 190, 216, 12), WHITE],
  [p => inRoundRect(p.x, p.y, 66, 40, 190, 92, 12) && p.y < 92, LIGHT],
  [p => p.y >= 82 && p.y < 92 && p.x >= 66 && p.x <= 190, LIGHT],
  [p => inRoundRect(p.x, p.y, 84, 112, 172, 122, 5), LINE],
  [p => inRoundRect(p.x, p.y, 84, 136, 172, 146, 5), LINE],
  [p => inRoundRect(p.x, p.y, 84, 160, 140, 170, 5), LINE],
  [p => inRoundRect(p.x, p.y, 128, 186, 172, 198, 6), GOLD],
];

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const p = { x: x + (sx + 0.5) / SS, y: y + (sy + 0.5) / SS };
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
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('wrote build/icon.png');
