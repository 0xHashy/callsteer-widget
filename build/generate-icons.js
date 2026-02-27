/**
 * Icon Generator for CallSteer
 *
 * Generates icons from the canonical SVG source:
 *   website/CALLSTEER_Icon_V2_WoB.svg
 *
 * White speech bubble with dark outline + dark C letter
 * on transparent background.
 *
 * Outputs:
 *   - build/icon-{16,32,48,64,128,256}.png
 *   - build/icon.png (copy of 256)
 *   - build/icon.ico (Windows)
 *   - chrome-extension/icons/icon{16,32,48,128}.png
 *   - electron-widget/icon.png
 */

const fs = require('fs');
const path = require('path');

const buildDir = __dirname;
const svgPath = path.join(buildDir, '..', '..', 'website', 'CALLSTEER_Icon_V2_WoB.svg');
const chromeExtDir = path.join(buildDir, '..', '..', 'chrome-extension', 'icons');

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('sharp is required. Install it: npm install sharp');
    process.exit(1);
  }

  if (!fs.existsSync(svgPath)) {
    console.error('Source SVG not found:', svgPath);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(svgPath);
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  console.log('Generating CallSteer icons (Speech Bubble + Outline)...\n');

  for (const size of sizes) {
    const png = await sharp(svgBuffer, { density: 400 })
      .resize(size, size)
      .png()
      .toBuffer();

    const filename = path.join(buildDir, `icon-${size}.png`);
    fs.writeFileSync(filename, png);
    console.log(`  Created: icon-${size}.png`);
    pngBuffers.push({ size, data: png });
  }

  // Main icon (256px copy)
  fs.copyFileSync(
    path.join(buildDir, 'icon-256.png'),
    path.join(buildDir, 'icon.png')
  );
  console.log('  Created: icon.png (copy of 256px)');

  // ICO file (Windows)
  const icoSizes = [16, 32, 48, 256];
  const icoBuffers = pngBuffers.filter(p => icoSizes.includes(p.size));
  const ico = createICO(icoBuffers);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('  Created: icon.ico (Windows)');

  // Chrome extension icons
  console.log('\n  Copying to Chrome extension...');
  if (fs.existsSync(chromeExtDir)) {
    for (const size of [16, 32, 48, 128]) {
      const src = path.join(buildDir, `icon-${size}.png`);
      const dest = path.join(chromeExtDir, `icon${size}.png`);
      fs.copyFileSync(src, dest);
      console.log(`  Copied: chrome-extension/icons/icon${size}.png`);
    }
  }

  // Copy to widget root
  fs.copyFileSync(
    path.join(buildDir, 'icon.png'),
    path.join(buildDir, '..', 'icon.png')
  );
  console.log('  Copied: electron-widget/icon.png');

  console.log('\nAll icons generated!');
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

main().catch(e => { console.error(e); process.exit(1); });
