const fs = require('fs');
const path = require('path');

const buildDir = __dirname;
const pngPath = path.join(buildDir, 'icon-256.png');
const icoPath = path.join(buildDir, 'icon.ico');

console.log('Converting PNG to ICO...');

// Dynamic import for ESM module
(async () => {
  try {
    const pngToIco = (await import('png-to-ico')).default;
    const buf = await pngToIco(pngPath);
    fs.writeFileSync(icoPath, buf);
    console.log('✅ Created: icon.ico');
  } catch (err) {
    console.error('Error converting to ICO:', err);
    process.exit(1);
  }
})();
