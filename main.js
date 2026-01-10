const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Dev mode flag - set to true to enable DevTools
const DEV_MODE = true;

// Enable audio capture features for Windows - MUST be before app.ready
// These flags are REQUIRED for chromeMediaSource: 'desktop' to work in getUserMedia
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('enable-features', 'DesktopCaptureAudio,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
// Allow insecure localhost for development (audio capture requires secure context)
app.commandLine.appendSwitch('allow-insecure-localhost');
// Disable GPU sandbox to avoid audio capture issues on some Windows systems
app.commandLine.appendSwitch('disable-gpu-sandbox');

// NOTE: We use desktopCapturer + getUserMedia with chromeMediaSource: 'desktop'
// This is the standard Electron approach for system audio capture (used by Discord, OBS, etc.)
// getDisplayMedia does NOT work in Electron - it returns 'Not supported'

// Auto-updater - lazy load to avoid accessing app before ready
let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  }
  return autoUpdater;
}

let mainWindow;
let tray;

// Config file paths
const configPath = path.join(app.getPath('userData'), 'window-config.json');
const clientConfigPath = path.join(app.getPath('userData'), 'client-config.json');

// Widget dimensions - fixed 320px width to match CSS
const WIDGET_WIDTH = 320;
const WIDGET_HEIGHT = 520;

function loadWindowBounds() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load window config:', e);
  }
  return null;
}

function saveWindowBounds() {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(configPath, JSON.stringify(bounds));
  } catch (e) {
    console.error('Failed to save window config:', e);
  }
}

function createWindow() {
  // Get screen dimensions for top-right positioning
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Load saved bounds or calculate default top-right position
  const savedBounds = loadWindowBounds();
  const defaultX = screenWidth - WIDGET_WIDTH - 20; // 20px margin from right
  const defaultY = 20; // 20px margin from top

  const bounds = savedBounds || {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: defaultX,
    y: defaultY
  };

  // Validate bounds are within screen
  if (savedBounds) {
    if (bounds.x < 0) bounds.x = 0;
    if (bounds.y < 0) bounds.y = 0;
    if (bounds.x + bounds.width > screenWidth) bounds.x = screenWidth - bounds.width;
    if (bounds.y + bounds.height > screenHeight) bounds.y = screenHeight - bounds.height;
  }

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 200,
    minHeight: 200,
    maxWidth: 400,
    maxHeight: 800,
    transparent: true,
    backgroundColor: '#00000000', // Fully transparent for glassmorphism
    hasShadow: true,
    vibrancy: 'ultra-dark', // macOS vibrancy effect
    visualEffectState: 'active',
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false // Keep audio capture running in background
    }
  });

  // Handle media/microphone/screen permission requests for audio capture
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'screen', 'desktopCapture', 'display-capture'];
    if (allowedPermissions.includes(permission)) {
      console.log(`[Main] Permission granted: ${permission}`);
      callback(true);
    } else {
      console.log(`[Main] Permission denied: ${permission}`);
      callback(false);
    }
  });

  // Also handle permission check handler for some Electron versions
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'screen', 'desktopCapture', 'display-capture'];
    return allowedPermissions.includes(permission);
  });

  // NOTE: setDisplayMediaRequestHandler is set up on session.defaultSession in app.on('ready')
  // This provides loopback audio for system audio capture via getDisplayMedia

  // Set always on top with highest level to stay above all windows
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  mainWindow.loadFile('index.html');

  // DevTools - F12 or Ctrl+Shift+I to toggle
  if (DEV_MODE) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      // F12 or Ctrl+Shift+I to toggle DevTools
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  // Make window draggable
  mainWindow.setMenu(null);

  // Save bounds on resize/move (debounced)
  let saveTimeout;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveWindowBounds, 500);
  };

  mainWindow.on('resize', () => {
    debouncedSave();
    // Notify renderer of size change for responsive UI
    mainWindow.webContents.send('window-resized', mainWindow.getBounds());
  });

  mainWindow.on('move', debouncedSave);

  // Prevent window from closing, minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      saveWindowBounds();
      mainWindow.hide();
    }
    return false;
  });

  // Create system tray icon
  createTray();

  // NOTE: Do NOT call clearDisplayMediaHandler() here!
  // electron-audio-loopback sets up its handler in enableLoopbackAudio IPC
  // and we must not clear it or system audio capture will fail
}

function createTray() {
  // Create a 16x16 tray icon (ship wheel pattern)
  const iconSize = 16;
  const canvas = Buffer.alloc(iconSize * iconSize * 4);
  const cx = iconSize / 2;
  const cy = iconSize / 2;

  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const idx = (y * iconSize + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      let isGreen = false;

      // Outer ring (radius 6-7)
      if (dist >= 5.5 && dist <= 7.5) {
        isGreen = true;
      }
      // Inner hub (radius 1.5-2.5)
      if (dist >= 1 && dist <= 2.5) {
        isGreen = true;
      }
      // Spokes (8 spokes, every 45 degrees)
      for (let i = 0; i < 8; i++) {
        const spokeAngle = (i * Math.PI) / 4;
        const angleDiff = Math.abs(angle - spokeAngle);
        const normalizedDiff = Math.min(angleDiff, 2 * Math.PI - angleDiff);
        if (normalizedDiff < 0.25 && dist >= 2 && dist <= 6) {
          isGreen = true;
        }
      }
      // Handles at spoke ends
      for (let i = 0; i < 8; i++) {
        const spokeAngle = (i * Math.PI) / 4;
        const handleX = cx + Math.cos(spokeAngle) * 7;
        const handleY = cy + Math.sin(spokeAngle) * 7;
        const handleDist = Math.sqrt((x - handleX) ** 2 + (y - handleY) ** 2);
        if (handleDist <= 1.5) {
          isGreen = true;
        }
      }

      if (isGreen) {
        canvas[idx] = 0x00;     // R
        canvas[idx + 1] = 0xff; // G
        canvas[idx + 2] = 0x88; // B
        canvas[idx + 3] = 0xff; // A
      } else {
        canvas[idx] = 0x00;
        canvas[idx + 1] = 0x00;
        canvas[idx + 2] = 0x00;
        canvas[idx + 3] = 0x00;
      }
    }
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Widget',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Developer Tools (F12)',
      click: () => {
        mainWindow.show();
        mainWindow.webContents.toggleDevTools();
      },
      visible: DEV_MODE
    },
    {
      type: 'separator'
    },
    {
      label: 'Switch Company',
      click: () => {
        // Clear stored client and notify renderer to show login
        try {
          if (fs.existsSync(clientConfigPath)) {
            fs.unlinkSync(clientConfigPath);
          }
        } catch (e) {
          console.error('Failed to clear client config:', e);
        }
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('logout-request');
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit CallSteer',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('CallSteer - Click to show widget');
  tray.setContextMenu(contextMenu);

  // Left-click to show/restore widget
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Double-click also shows widget
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// IPC handlers
ipcMain.on('minimize-window', () => {
  mainWindow.minimize();  // Minimize to taskbar instead of hiding
});

ipcMain.on('close-window', () => {
  mainWindow.hide();  // Close button hides to tray
});


// Clipboard handler
ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  return true;
});

// Client storage handlers
ipcMain.handle('save-client-code', (event, code) => {
  try {
    const config = loadClientConfig();
    config.client_code = code;
    fs.writeFileSync(clientConfigPath, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save client code:', e);
    return false;
  }
});

ipcMain.handle('get-client-code', () => {
  try {
    const config = loadClientConfig();
    return config.client_code || null;
  } catch (e) {
    console.error('Failed to get client code:', e);
    return null;
  }
});

ipcMain.handle('clear-client-code', () => {
  try {
    if (fs.existsSync(clientConfigPath)) {
      fs.unlinkSync(clientConfigPath);
    }
    return true;
  } catch (e) {
    console.error('Failed to clear client code:', e);
    return false;
  }
});

ipcMain.handle('save-client-info', (event, info) => {
  try {
    const config = loadClientConfig();
    config.client_info = info;
    fs.writeFileSync(clientConfigPath, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save client info:', e);
    return false;
  }
});

ipcMain.handle('get-client-info', () => {
  try {
    const config = loadClientConfig();
    return config.client_info || null;
  } catch (e) {
    console.error('Failed to get client info:', e);
    return null;
  }
});

// Open external links
ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
  return true;
});

// Desktop capturer for system audio (customer voice)
// Returns windows and screens with thumbnails for the dialer picker
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 150, height: 100 },
      fetchWindowIcons: true
    });

    // Filter out empty/system windows and return useful info
    return sources
      .filter(source => source.name && source.name.trim() !== '')
      .map(source => ({
        id: source.id,
        name: source.name,
        display_id: source.display_id,
        thumbnail: source.thumbnail?.toDataURL() || null,
        appIcon: source.appIcon?.toDataURL() || null
      }));
  } catch (e) {
    console.error('Failed to get desktop sources:', e);
    return [];
  }
});

// Get system audio source ID for WASAPI loopback capture
ipcMain.handle('get-system-audio-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false
    });

    // Return the first screen source (we just need it for audio loopback)
    if (sources.length > 0) {
      console.log('[Main] System audio source:', sources[0].name, sources[0].id);
      return sources[0].id;
    }
    return null;
  } catch (error) {
    console.error('Failed to get system audio source:', error);
    return null;
  }
});

// NOTE: electron-audio-loopback's initMain() automatically registers
// 'enable-loopback-audio' and 'disable-loopback-audio' IPC handlers.
// Do NOT manually register them here or you'll get duplicate handler errors.

// Clear any display media handler on startup to ensure system picker works
// This is called from createWindow after mainWindow is ready
// IMPORTANT: electron-audio-loopback or other libs may set a handler that intercepts getDisplayMedia
function clearDisplayMediaHandler() {
  try {
    const { session } = require('electron');
    // Set handler to null to ensure the native Windows picker appears
    session.defaultSession.setDisplayMediaRequestHandler(null);
    console.log('[Main] ═══════════════════════════════════════════════════');
    console.log('[Main] Display media handler set to NULL');
    console.log('[Main] Windows system picker will now be used for getDisplayMedia');
    console.log('[Main] ═══════════════════════════════════════════════════');
  } catch (err) {
    console.warn('[Main] Could not clear display media handler:', err.message);
  }
}

// Set up display media handler for specific window capture
// NOTE: This is currently disabled in favor of system picker
// The system picker is more reliable for getting audio on Windows
ipcMain.handle('setup-window-capture', async (event, sourceId) => {
  // Don't set up a custom handler - let the system picker work
  console.log('[Main] setup-window-capture called with:', sourceId);
  console.log('[Main] Using system picker for actual capture (more reliable for audio)');
  return { success: true };
});

// Clear display media handler
ipcMain.handle('clear-window-capture', async () => {
  try {
    const { session } = require('electron');
    session.defaultSession.setDisplayMediaRequestHandler(null);
    console.log('[Main] Window capture handler cleared');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to clear window capture:', error);
    return { success: false, error: error.message };
  }
});

// Helper to load client config
function loadClientConfig() {
  try {
    if (fs.existsSync(clientConfigPath)) {
      const data = fs.readFileSync(clientConfigPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load client config:', e);
  }
  return {};
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

// ============================================
// AUTO-UPDATE FUNCTIONALITY
// ============================================

function setupAutoUpdater() {
  // Lazy-load electron-updater to avoid accessing app before ready
  const updater = getAutoUpdater();

  // Register event handlers
  updater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...');
    if (mainWindow) {
      mainWindow.webContents.send('update-status', { status: 'checking' });
    }
  });

  updater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'available',
        version: info.version
      });
    }
  });

  updater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] Already up to date:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', { status: 'up-to-date' });
    }
  });

  updater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${Math.round(progress.percent)}%`);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'downloading',
        percent: Math.round(progress.percent)
      });
    }
  });

  updater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'ready',
        version: info.version
      });
    }
    // The update will install on next app quit (autoInstallOnAppQuit = true)
  });

  updater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'error',
        message: err.message
      });
    }
  });

  // Check for updates on startup (with delay to not slow launch)
  setTimeout(() => {
    console.log('[AutoUpdater] Checking for updates...');
    updater.checkForUpdates().catch(err => {
      console.log('[AutoUpdater] Update check failed:', err.message);
    });
  }, 5000);

  // Check for updates every 30 minutes
  setInterval(() => {
    console.log('[AutoUpdater] Periodic update check...');
    updater.checkForUpdates().catch(err => {
      console.log('[AutoUpdater] Update check failed:', err.message);
    });
  }, 30 * 60 * 1000);
}

// IPC handler to manually trigger update check
ipcMain.handle('check-for-updates', async () => {
  try {
    const updater = getAutoUpdater();
    const result = await updater.checkForUpdates();
    return { success: true, version: result?.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC handler to get current app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Start auto-updater when app is ready
app.on('ready', setupAutoUpdater);
