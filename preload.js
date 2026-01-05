const { contextBridge, ipcRenderer } = require('electron');

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

  // Desktop capturer for system audio (Windows WASAPI)
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  getAudioSources: () => ipcRenderer.invoke('get-desktop-sources'), // Alias for clarity
  getSystemAudioSource: () => ipcRenderer.invoke('get-system-audio-source'), // For WASAPI loopback

  // Audio loopback controls (electron-audio-loopback)
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Logout event listener
  onLogoutRequest: (callback) => ipcRenderer.on('logout-request', () => callback())
});
