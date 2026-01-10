// Test if we're running in the UTILITY process sandbox
console.log('=== ELECTRON PROCESS INFO ===');
console.log('process.type:', process.type);
console.log('process.sandboxed:', process.sandboxed);
console.log('process.contextIsolated:', process.contextIsolated);
console.log('process.versions.electron:', process.versions.electron);

// Check if process.type is undefined - this means we're in utility/sandbox mode
if (process.type === undefined) {
  console.log('');
  console.log('WARNING: process.type is undefined');
  console.log('This happens when Electron runs in utility process or sandbox mode');
  console.log('The main process should have process.type === "browser"');
}

// See what require.resolve says
console.log('');
console.log('=== MODULE RESOLUTION ===');
try {
  const resolvedPath = require.resolve('electron');
  console.log('require.resolve("electron"):', resolvedPath);
} catch (e) {
  console.log('Could not resolve electron:', e.message);
}
