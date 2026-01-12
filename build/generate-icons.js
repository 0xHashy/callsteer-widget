/**
 * Icon Generator for CallSteer
 *
 * Generates the CallSteer logo: Clean tac pin (teardrop shape)
 * - Small icons (16, 32, 48): Simple tac pin only - must be crisp
 * - Large icons (128, 256): Tac pin with optional signal waves
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CallSteer brand color
const TEAL = { r: 0x00, g: 0xC8, b: 0xD4 }; // #00C8D4
const DARK = { r: 0x0a, g: 0x0a, b: 0x0f }; // #0a0a0f

/**
 * Generate the CallSteer icon
 * @param {number} size - Icon size in pixels
 * @param {boolean} includeWaves - Whether to include signal waves
 */
function generateIcon(size, includeWaves = false) {
  const canvas = Buffer.alloc(size * size * 4);
  const scale = size / 64; // Design based on 64x64 viewBox

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Normalize to 64x64 design space
      const nx = x / scale;
      const ny = y / scale;

      // Default: transparent
      let r = 0, g = 0, b = 0, a = 0;

      const color = getPixelColor(nx, ny, includeWaves);
      if (color) {
        r = color.r;
        g = color.g;
        b = color.b;
        a = Math.round(color.a * 255);
      }

      canvas[idx] = r;
      canvas[idx + 1] = g;
      canvas[idx + 2] = b;
      canvas[idx + 3] = a;
    }
  }

  return canvas;
}

/**
 * Determine pixel color in 64x64 design space
 */
function getPixelColor(x, y, includeWaves) {
  // Clean tac pin - smooth teardrop shape
  // Center at x=32, top of pin circle at y=20, tip at y=58

  if (isInsideTacPin(x, y)) {
    // Check if inside the inner dark circle (hole in pin)
    const holeCenterY = 20;
    const holeRadius = 6;
    const distFromHole = Math.sqrt((x - 32) ** 2 + (y - holeCenterY) ** 2);
    if (distFromHole <= holeRadius) {
      return { ...DARK, a: 1 };
    }
    return { ...TEAL, a: 1 };
  }

  // Signal waves (only for large icons)
  if (includeWaves) {
    // Wave origin - top right of pin
    const waveOriginX = 40;
    const waveOriginY = 12;

    if (isOnWave(x, y, waveOriginX, waveOriginY, 10, 2.5)) {
      return { ...TEAL, a: 0.9 };
    }
    if (isOnWave(x, y, waveOriginX, waveOriginY, 17, 2.5)) {
      return { ...TEAL, a: 0.7 };
    }
    if (isOnWave(x, y, waveOriginX, waveOriginY, 24, 2.5)) {
      return { ...TEAL, a: 0.5 };
    }
  }

  return null;
}

/**
 * Check if point is inside the clean tac pin shape
 * Uses a smooth bezier-like curve from circle to point
 */
function isInsideTacPin(x, y) {
  const cx = 32;        // Center X
  const topY = 4;       // Top of pin
  const tipY = 58;      // Bottom tip
  const circleY = 20;   // Center of the circular part
  const maxRadius = 14; // Radius at widest point

  // Above the pin
  if (y < topY) return false;

  // Below the tip
  if (y > tipY) return false;

  const dx = Math.abs(x - cx);

  // Upper circular portion (y from topY to circleY + some overlap)
  if (y <= circleY + 4) {
    // Distance from center of circular part
    const dy = y - circleY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Use slightly larger radius at top for smooth shape
    const effectiveRadius = maxRadius + 2;
    if (dist <= effectiveRadius && y >= topY) {
      return true;
    }
  }

  // Tapered portion - smooth curve from circle to tip
  if (y > circleY - 2 && y <= tipY) {
    // Calculate width at this Y position using smooth curve
    // Use a quadratic ease for smooth taper
    const progress = (y - circleY) / (tipY - circleY);

    // Smooth taper: starts at maxRadius, ends at 0
    // Use sine curve for smoother transition
    const taperFactor = Math.cos(progress * Math.PI / 2);
    const widthAtY = maxRadius * taperFactor;

    if (dx <= widthAtY) {
      return true;
    }
  }

  return false;
}

/**
 * Check if point is on a signal wave arc
 */
function isOnWave(x, y, originX, originY, radius, strokeWidth) {
  const dx = x - originX;
  const dy = y - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Only draw in upper-right quadrant
  if (dx < -2 || dy > 2) return false;

  // Check if on the arc stroke
  const halfStroke = strokeWidth / 2;
  if (dist >= radius - halfStroke && dist <= radius + halfStroke) {
    // Limit arc angle (roughly 0 to 90 degrees, with some padding)
    const angle = Math.atan2(-dy, dx);
    if (angle >= -0.2 && angle <= Math.PI / 2 + 0.2) {
      return true;
    }
  }

  return false;
}

// PNG encoding functions
function createPNG(width, height, rgbaData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = createChunk('IHDR', ihdr);

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgbaData[srcIdx];
      rawData[dstIdx + 1] = rgbaData[srcIdx + 1];
      rawData[dstIdx + 2] = rgbaData[srcIdx + 2];
      rawData[dstIdx + 3] = rgbaData[srcIdx + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
  let crc = 0xffffffff;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc ^ 0xffffffff;
}

function createICO(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);

  let offset = 6 + (pngBuffers.length * 16);
  const entries = [];

  pngBuffers.forEach(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  });

  return Buffer.concat([header, ...entries, ...pngBuffers.map(p => p.data)]);
}

// Main execution
const buildDir = __dirname;
const chromeExtDir = path.join(__dirname, '..', '..', 'chrome-extension', 'icons');

console.log('🎨 Generating CallSteer icons (Clean Tac Pin)...\n');

const pngBuffers = [];

// Small icons: Clean tac pin only (NO waves)
[16, 32, 48].forEach(size => {
  const pixels = generateIcon(size, false); // No waves
  const png = createPNG(size, size, pixels);
  const filename = path.join(buildDir, `icon-${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`✓ Created: icon-${size}.png (clean pin)`);
  pngBuffers.push({ size, data: png });
});

// Medium icon: Clean tac pin only
{
  const size = 64;
  const pixels = generateIcon(size, false);
  const png = createPNG(size, size, pixels);
  fs.writeFileSync(path.join(buildDir, `icon-${size}.png`), png);
  console.log(`✓ Created: icon-${size}.png (clean pin)`);
  pngBuffers.push({ size, data: png });
}

// Large icons: Tac pin with waves
[128, 256].forEach(size => {
  const pixels = generateIcon(size, true); // With waves
  const png = createPNG(size, size, pixels);
  const filename = path.join(buildDir, `icon-${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`✓ Created: icon-${size}.png (pin + waves)`);
  pngBuffers.push({ size, data: png });
});

// Main icon (256px with waves)
fs.copyFileSync(
  path.join(buildDir, 'icon-256.png'),
  path.join(buildDir, 'icon.png')
);
console.log('✓ Created: icon.png (copy of 256px)');

// ICO file (Windows) - uses small clean icons
const icoSizes = [16, 32, 48, 256];
const icoBuffers = pngBuffers.filter(p => icoSizes.includes(p.size));
const ico = createICO(icoBuffers);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
console.log('✓ Created: icon.ico (Windows)');

// Chrome extension icons
console.log('\n📦 Copying to Chrome extension...');
if (fs.existsSync(chromeExtDir)) {
  [16, 32, 48, 128].forEach(size => {
    const src = path.join(buildDir, `icon-${size}.png`);
    const dest = path.join(chromeExtDir, `icon${size}.png`);
    fs.copyFileSync(src, dest);
    console.log(`✓ Copied: chrome-extension/icons/icon${size}.png`);
  });
}

// Copy to widget root
fs.copyFileSync(
  path.join(buildDir, 'icon.png'),
  path.join(buildDir, '..', 'icon.png')
);
console.log('✓ Copied: electron-widget/icon.png');

console.log('\n✅ All icons generated!');
console.log('\n📋 Design:');
console.log('   - Small (16-64px): Clean tac pin, no waves');
console.log('   - Large (128-256px): Tac pin + signal waves');
console.log('   - Color: #00C8D4 (teal) with #0a0a0f center hole');
