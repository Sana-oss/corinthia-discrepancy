// Generates the PWA icon PNGs from the Corinthia logo (new-logo.svg).
// Requires the `sharp` dependency (npm install sharp).
// Outputs, overwriting in place (same names as before, so manifest / HTML /
// service worker need no changes):
//   icon-192.png / icon-512.png            — ivory square, logo centered
//   icon-maskable-192.png / -512.png       — full-bleed background, logo kept
//                                            inside the maskable "safe zone"
//                                            (~80% diameter)
//   favicon.svg                            — square, mark-only (column symbol,
//                                            no wordmark) for the browser tab
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IVORY = { r: 241, g: 240, b: 238, alpha: 1 };   // --bg  #f1f0ee
const INK   = { r: 31,  g: 29,  b: 25,  alpha: 1 };   // --ink #1f1d19

// Recolor the logo to brand ink (the source SVG has no fill attributes,
// so its paths default to black) and force a transparent canvas.
function tintedSvg(svgPath) {
  let svg = fs.readFileSync(svgPath, 'utf8');
  svg = svg.replace('<svg id="Layer_1"', '<svg id="Layer_1" fill="#1f1d19"');
  return Buffer.from(svg);
}

async function trimmedLogo(svgPath) {
  // Render large, auto-crop to the artwork's bounding box.
  const buf = await sharp(tintedSvg(svgPath), { density: 200 })
    .trim({ threshold: 8 })
    .png()
    .toBuffer();
  const meta = await sharp(buf).metadata();
  return { buf, width: meta.width, height: meta.height };
}

async function makeIcon(logo, size, maskable, outFile) {
  // Regular icons: logo takes ~68% of the square.
  // Maskable: content must sit inside the 80%-diameter safe zone; a wide
  // logo needs extra margin, so scale to ~46% and center it.
  const contentSize = Math.round(size * (maskable ? 0.46 : 0.68));
  const inner = await sharp(logo.buf)
    .resize({ width: contentSize, height: contentSize, fit: 'inside' })
    .png()
    .toBuffer();
  const innerMeta = await sharp(inner).metadata();
  const padX = Math.round((size - innerMeta.width) / 2);
  const padY = Math.round((size - innerMeta.height) / 2);
  await sharp({
    create: { width: size, height: size, channels: 4, background: IVORY }
  })
    .composite([{ input: inner, left: padX, top: padY }])
    .png()
    .toFile(path.join(__dirname, outFile));
  console.log('[icons] wrote ' + outFile);
}

// Renders the full logo, then finds the mark's bounding box by scanning raw
// pixels in the upper band of the artwork (the column symbol lives above the
// wordmark, which starts at y≈280 in viewBox units).
async function markFromSvg(svgPath) {
  const SCALE = 200 / 72; // density 200 → px per viewBox unit
  const full = await sharp(tintedSvg(svgPath), { density: 200 }).png().toBuffer();
  const { data, info } = await sharp(full).raw().toBuffer({ resolveWithObject: true });
  // Scan window: x 500-640, y 100-250 in viewBox units (the mark's band).
  const xs = Math.round(500 * SCALE), xe = Math.round(640 * SCALE);
  const ys = Math.round(100 * SCALE), ye = Math.round(250 * SCALE);
  let minX = xe, minY = ye, maxX = xs, maxY = ys;
  for (let y = ys; y < Math.min(ye, info.height); y++) {
    for (let x = xs; x < Math.min(xe, info.width); x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) { // ink stroke
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX >= maxX) throw new Error('[icons] mark not found in scan window — logo file changed?');
  // px coords are absolute in the full render, so px/SCALE is already the
  // viewBox unit coordinate; the scan window only filters which px we look at.
  return {
    x: minX / SCALE,
    y: minY / SCALE,
    w: (maxX - minX + 1) / SCALE,
    h: (maxY - minY + 1) / SCALE
  };
}

// Builds favicon.svg: square ivory canvas, ink mark centered with breathing
// room. Mark paths are copied verbatim from the source SVG (fill is
// inherited from the root <svg> element).
async function makeFavicon(svgPath) {
  const source = fs.readFileSync(svgPath, 'utf8');
  const markPrefixes = ['M540.51', 'M600.34', 'M588.9', 'M576.96', 'M521.17', 'M533.23', 'M524.31'];
  const paths = (source.match(/<path\b[^>]*\/>/g) || [])
    .filter((el) => markPrefixes.some((p) => el.includes('d="' + p)));
  if (paths.length !== markPrefixes.length) {
    throw new Error('[icons] expected ' + markPrefixes.length + ' mark paths, found ' + paths.length + ' — logo file changed?');
  }
  const box = await markFromSvg(svgPath);
  const side = Math.max(box.w, box.h) * 1.5; // ~17% margin each side
  const x0 = box.x + box.w / 2 - side / 2;
  const y0 = box.y + box.h / 2 - side / 2;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' ' + side.toFixed(2) + ' ' + side.toFixed(2) + '" fill="#1f1d19">\n' +
    '  <rect x="' + x0.toFixed(2) + '" y="' + y0.toFixed(2) + '" width="' + side.toFixed(2) + '" height="' + side.toFixed(2) + '" fill="#f1f0ee"/>\n' +
    '  ' + paths.join('\n  ') + '\n' +
    '</svg>\n';
  fs.writeFileSync(path.join(__dirname, 'favicon.svg'), svg);
  console.log('[icons] wrote favicon.svg');
}

(async () => {
  const logo = await trimmedLogo(path.join(__dirname, 'new-logo.svg'));
  console.log('[icons] trimmed logo: ' + logo.width + 'x' + logo.height);
  await makeIcon(logo, 192, false, 'icon-192.png');
  await makeIcon(logo, 512, false, 'icon-512.png');
  await makeIcon(logo, 192, true, 'icon-maskable-192.png');
  await makeIcon(logo, 512, true, 'icon-maskable-512.png');
  await makeFavicon(path.join(__dirname, 'new-logo.svg'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
