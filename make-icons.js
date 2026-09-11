// Generates the PWA icon PNGs. No dependencies — hand-rolled PNG encoder
// (zlib + CRC32 from Node's stdlib). Outputs:
//   icon-192.png / icon-512.png            — rounded square, tick mark
//   icon-maskable-192.png / -512.png       — full-bleed, tick inside the
//                                            maskable "safe zone" (~80%)
// Re-run with `node make-icons.js` after changing colors, or swap the files
// for the real Corinthia logo (keep the same file names).
const fs = require('fs');
const zlib = require('zlib');

const INK   = [31, 29, 25];    // Corinthia ink  --ink  #1f1d19 (icon + text)
const IVORY = [241, 240, 238]; // Corinthia ivory --bg  #f1f0ee (icon background)

// --- minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // Add the per-scanline filter byte (0 = none) before compressing.
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- drawing ----------------------------------------------------------------
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}
function makeIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const cornerR = size * 0.18;                 // rounded corners (regular only)
  const tickScale = maskable ? 0.62 : 0.72;    // tick size (maskable keeps a margin)
  const strokeHalf = size * (maskable ? 0.055 : 0.075);
  const half = size / 2;
  // Tick polyline in unit space (centered), then scaled + translated.
  const pts = [[-0.21, 0.02], [-0.05, 0.17], [0.24, -0.18]].map(([x, y]) => [
    half + x * size * tickScale,
    half + y * size * tickScale
  ]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let alpha = 255;
      if (!maskable) {
        const rx = Math.min(cx, size - cx), ry = Math.min(cy, size - cy);
        if (rx < cornerR && ry < cornerR) {
          const d = Math.sqrt(Math.pow(rx - cornerR, 2) + Math.pow(ry - cornerR, 2));
          alpha = Math.max(0, Math.min(255, Math.round((cornerR - d) * 255)));
        }
      }
      const d = Math.min(
        distToSegment(cx, cy, pts[0][0], pts[0][1], pts[1][0], pts[1][1]),
        distToSegment(cx, cy, pts[1][0], pts[1][1], pts[2][0], pts[2][1])
      );
      const cov = Math.max(0, Math.min(1, strokeHalf - d + 0.5)); // 1px AA edge
      const o = (y * size + x) * 4;
      px[o]     = Math.round(INK[0] * (1 - cov) + IVORY[0] * cov);
      px[o + 1] = Math.round(INK[1] * (1 - cov) + IVORY[1] * cov);
      px[o + 2] = Math.round(INK[2] * (1 - cov) + IVORY[2] * cov);
      px[o + 3] = alpha;
    }
  }
  return encodePNG(size, size, px);
}

const files = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of files) {
  fs.writeFileSync(require('path').join(__dirname, name), makeIcon(size, maskable));
  console.log('[icons] wrote ' + name);
}
