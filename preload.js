const { contextBridge, ipcRenderer } = require('electron');

// Try to load electron-audio-loopback for direct WASAPI access
let getLoopbackAudioMediaStream = null;
try {
  const audioLoopback = require('electron-audio-loopback');
  getLoopbackAudioMediaStream = audioLoopback.getLoopbackAudioMediaStream;
  console.log('[Preload] electron-audio-loopback loaded successfully');
} catch (e) {
  console.warn('[Preload] electron-audio-loopback not available:', e.message);
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  onWindowResized: (callback) => ipcRenderer.on('window-resized', (event, bounds) => callback(bounds)),

  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // Client storage (for login persistence)
  saveClientCode: (code) => ipcRenderer.invoke('save-client-code', code),
  getClientCode: () => ipcRenderer.invoke('get-client-code'),
  clearClientCode: () => ipcRenderer.invoke('clear-client-code'),
  saveClientInfo: (info) => ipcRenderer.invoke('save-client-info', info),
  getClientInfo: () => ipcRenderer.invoke('get-client-info'),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Run shell commands (for opening mmsys.cpl, etc.)
  runCommand: (cmd) => ipcRenderer.invoke('run-command', cmd),

  // Desktop capturer for system audio (Windows WASAPI)
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  getAudioSources: () => ipcRenderer.invoke('get-desktop-sources'), // Alias for clarity
  getSystemAudioSource: () => ipcRenderer.invoke('get-system-audio-source'), // For WASAPI loopback

  // Audio loopback controls (electron-audio-loopback)
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Direct WASAPI loopback capture (bypasses getDisplayMedia entirely)
  // Returns MediaStream directly - no screen picker needed!
  getLoopbackAudioStream: async (options = {}) => {
    if (!getLoopbackAudioMediaStream) {
      throw new Error('electron-audio-loopback not available');
    }
    console.log('[Preload] Getting loopback audio stream directly...');
    const stream = await getLoopbackAudioMediaStream(options);
    console.log('[Preload] Got stream with', stream.getAudioTracks().length, 'audio tracks');
    return stream;
  },

  // Check if direct loopback is available
  hasDirectLoopback: () => !!getLoopbackAudioMediaStream,

  // Window-specific audio capture
  setupWindowCapture: (sourceId) => ipcRenderer.invoke('setup-window-capture', sourceId),
  clearWindowCapture: () => ipcRenderer.invoke('clear-window-capture'),

  // Logout event listener
  onLogoutRequest: (callback) => ipcRenderer.on('logout-request', () => callback()),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, status) => callback(status)),

  // Display media picker IPC (for getDisplayMedia flow)
  onShowDisplayMediaPicker: (callback) => ipcRenderer.on('show-display-media-picker', (event, sources) => callback(sources)),
  sendDisplayMediaSourceSelected: (sourceId) => ipcRenderer.send('display-media-source-selected', sourceId),

  // Window bounds
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),

  // Window resize (for custom resize handles in frameless window)
  resizeWindow: (bounds) => ipcRenderer.invoke('resize-window', bounds),

  // Delta-based window resize (synchronous, more responsive)
  resizeWindowDelta: (deltaX, deltaY, edge) => ipcRenderer.send('resize-window-delta', { deltaX, deltaY, edge }),

  // Dashboard/Widget navigation
  launchWidget: () => ipcRenderer.invoke('launch-widget'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  focusDashboard: () => ipcRenderer.invoke('focus-dashboard'),

  // Window settings (synced with dashboard)
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled)
});
