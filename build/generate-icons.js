/**
 * Icon Generator for CallSteer
 *
 * This script generates PNG icons of various sizes.
 * After running, you need to convert icon-256.png to icon.ico using:
 * - Online: https://convertico.com/ or https://icoconvert.com/
 * - Or install: npm install -g png-to-ico && png-to-ico icon-256.png > icon.ico
 */

const fs = require('fs');
const path = require('path');

// Generate a ship wheel icon as raw pixel data
function generateIcon(size) {
  const canvas = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 256;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      let r = 0x1a, g = 0x1a, b = 0x2e, a = 255; // Background color
      let isIcon = false;

      // Background circle
      const bgRadius = 120 * scale;
      if (dist > bgRadius) {
        a = 0; // Transparent outside
      } else {
        // Outer ring
        const outerR = 70 * scale;
        const ringWidth = 12 * scale;
        if (dist >= outerR - ringWidth / 2 && dist <= outerR + ringWidth / 2) {
          isIcon = true;
        }

        // Inner hub
        const innerR = 25 * scale;
        const hubWidth = 8 * scale;
        if (dist >= innerR - hubWidth / 2 && dist <= innerR + hubWidth / 2) {
          isIcon = true;
        }

        // Spokes (8 spokes)
        const spokeWidth = 8 * scale;
        for (let i = 0; i < 8; i++) {
          const spokeAngle = (i * Math.PI) / 4;
          const angleDiff = Math.abs(angle - spokeAngle);
          const normalizedDiff = Math.min(angleDiff, 2 * Math.PI - angleDiff);
          const spokeAngularWidth = Math.atan2(spokeWidth / 2, dist);
          if (normalizedDiff < spokeAngularWidth && dist >= innerR && dist <= outerR) {
            isIcon = true;
          }
        }

        // Handles at spoke ends
        const handleRadius = 10 * scale;
        const handleDist = 78 * scale;
        for (let i = 0; i < 8; i++) {
          const spokeAngle = (i * Math.PI) / 4;
          const handleX = cx + Math.cos(spokeAngle) * handleDist;
          const handleY = cy + Math.sin(spokeAngle) * handleDist;
          const hDist = Math.sqrt((x - handleX) ** 2 + (y - handleY) ** 2);
          if (hDist <= handleRadius) {
            isIcon = true;
          }
        }

        // Headset band (arc at top)
        const bandY = 35 * scale;
        const bandWidth = 8 * scale;
        if (y < cy && dist >= 93 * scale && dist <= 93 * scale + bandWidth) {
          const bandAngle = Math.acos(Math.abs(dx) / dist);
          if (bandAngle > 0.3 && bandAngle < Math.PI - 0.3) {
            isIcon = true;
          }
        }

        // Headset earpieces
        const earX1 = 55 * scale;
        const earX2 = (256 - 55) * scale;
        const earY = 95 * scale;
        const earRx = 18 * scale;
        const earRy = 25 * scale;

        // Left earpiece
        const ear1Dist = Math.sqrt(((x - earX1) / earRx) ** 2 + ((y - earY) / earRy) ** 2);
        if (ear1Dist <= 1) {
          isIcon = true;
        }

        // Right earpiece
        const ear2Dist = Math.sqrt(((x - earX2) / earRx) ** 2 + ((y - earY) / earRy) ** 2);
        if (ear2Dist <= 1) {
          isIcon = true;
        }

        // Microphone
        const micEndX = 90 * scale;
        const micEndY = 160 * scale;
        const micR = 12 * scale;
        const micDist = Math.sqrt((x - micEndX) ** 2 + (y - micEndY) ** 2);
        if (micDist <= micR) {
          isIcon = true;
        }

        if (isIcon) {
          // Blue-cyan gradient (#00C8D4 to #00A8B8)
          const gradientT = (x + y) / (2 * size);
          r = Math.round(0x00);
          g = Math.round(0xC8 - gradientT * 0x20);
          b = Math.round(0xD4 - gradientT * 0x1C);
        }
      }

      canvas[idx] = r;
      canvas[idx + 1] = g;
      canvas[idx + 2] = b;
      canvas[idx + 3] = a;
    }
  }

  return canvas;
}

// Simple PNG encoder (uncompressed for simplicity)
function createPNG(width, height, rgbaData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT chunk (image data)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgbaData[srcIdx];
      rawData[dstIdx + 1] = rgbaData[srcIdx + 1];
      rawData[dstIdx + 2] = rgbaData[srcIdx + 2];
      rawData[dstIdx + 3] = rgbaData[srcIdx + 3];
    }
  }

  // Use zlib to compress
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
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

// CRC32 implementation
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

// Generate icons
const sizes = [16, 32, 48, 64, 128, 256];
const buildDir = __dirname;

console.log('Generating CallSteer icons...');

sizes.forEach(size => {
  const pixels = generateIcon(size);
  const png = createPNG(size, size, pixels);
  const filename = path.join(buildDir, `icon-${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created: icon-${size}.png`);
});

// Copy 256 as the main icon
fs.copyFileSync(
  path.join(buildDir, 'icon-256.png'),
  path.join(buildDir, 'icon.png')
);
console.log('Created: icon.png (copy of 256px)');

console.log('\n✅ Icons generated successfully!');
console.log('\n📋 Next steps:');
console.log('1. Convert icon-256.png to icon.ico using:');
console.log('   - Online: https://convertico.com/');
console.log('   - Or: npm install -g png-to-ico && png-to-ico build/icon-256.png > build/icon.ico');
console.log('2. Then run: npm run build');
