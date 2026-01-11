const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Dev mode flag - set to true to enable DevTools
const DEV_MODE = true;

// Configure command line switches FIRST - BEFORE any other modules that might use them
// These must be set before app.ready for them to take effect
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaCaptureMuteAudio');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
// Allow file:// protocol to use media APIs
app.commandLine.appendSwitch('allow-insecure-localhost');

// Initialize electron-audio-loopback AFTER command line switches
// This library sets up IPC handlers for enable-loopback-audio and disable-loopback-audio
// When enableLoopbackAudio() is called from renderer, it sets up setDisplayMediaRequestHandler
try {
  const { initMain } = require('electron-audio-loopback');
  // Pass options to configure the library
  initMain({
    loopbackWithMute: false,  // Don't mute local audio
  });
  console.log('[Main] electron-audio-loopback initMain() called successfully');
  console.log('[Main] IPC handlers registered: enable-loopback-audio, disable-loopback-audio');
} catch (err) {
  console.error('[Main] Failed to initialize electron-audio-loopback:', err.message);
}

// NOTE: Electron requires setDisplayMediaRequestHandler for getDisplayMedia to work
// The handler shows our custom picker via IPC, then returns selected source with audio: 'loopback'

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

// Widget dimensions - resizable with min/max constraints
// PRINCIPLE: Launch big, resize dynamically, stay beautiful at any size
const DEFAULT_WIDTH = 380;   // Comfortable default
const DEFAULT_HEIGHT = 650;  // Shows everything without scroll
const MIN_WIDTH = 280;       // Minimum compact
const MIN_HEIGHT = 400;      // Minimum usable
const MAX_WIDTH = 500;
const MAX_HEIGHT = 850;      // Maximum for detailed view

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
  const defaultX = screenWidth - DEFAULT_WIDTH - 20; // 20px margin from right
  const defaultY = 20; // 20px margin from top

  const bounds = savedBounds || {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: defaultX,
    y: defaultY
  };

  // Validate bounds are within screen and constraints
  if (savedBounds) {
    // Enforce min/max constraints on saved bounds
    bounds.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, bounds.width));
    bounds.height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, bounds.height));
    // Keep window on screen
    if (bounds.x < 0) bounds.x = 0;
    if (bounds.y < 0) bounds.y = 0;
    if (bounds.x + bounds.width > screenWidth) bounds.x = screenWidth - bounds.width;
    if (bounds.y + bounds.height > screenHeight) bounds.y = screenHeight - bounds.height;
  }

  // Load the app icon for taskbar and window
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'build', 'icon.ico')
    : path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    transparent: true,
    backgroundColor: '#00000000', // Fully transparent for glassmorphism
    hasShadow: true,
    vibrancy: 'ultra-dark', // macOS vibrancy effect
    visualEffectState: 'active',
    skipTaskbar: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // Keep audio capture running in background
      // Enable getDisplayMedia and screen capture features
      enableBlinkFeatures: 'GetDisplayMedia,AudioVideoTracks'
    }
  });

  // Grant ALL media permissions automatically (like Chrome does)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`[Main] Permission requested: ${permission}`);
    // Grant all media-related permissions
    if (['media', 'microphone', 'audioCapture', 'screen', 'desktopCapture', 'display-capture', 'mediaKeySystem'].includes(permission)) {
      console.log(`[Main] Permission GRANTED: ${permission}`);
      callback(true);
    } else {
      callback(true); // Grant everything for now to debug
    }
  });

  // Permission check handler - return true for all media permissions
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    console.log(`[Main] Permission check: ${permission} from ${requestingOrigin}`);
    // Allow all permissions
    return true;
  });

  // DO NOT set a custom setDisplayMediaRequestHandler here!
  // electron-audio-loopback sets its own handler when enableLoopbackAudio() is called
  // Setting our own handler would overwrite the library's handler
  console.log('[Main] No custom display media handler - electron-audio-loopback will set one when enabled');

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

  // NOTE: No custom handlers needed - Electron 39+ uses native picker like Chrome
}

function createTray() {
  // Use the actual CallSteer teal map pin icon
  const trayIconPath = process.platform === 'win32'
    ? path.join(__dirname, 'build', 'icon.ico')
    : path.join(__dirname, 'build', 'icon.png');

  let icon;
  try {
    icon = nativeImage.createFromPath(trayIconPath);
    // Resize for tray (16x16 on Windows, varies on other platforms)
    if (process.platform === 'win32') {
      icon = icon.resize({ width: 16, height: 16 });
    }
    console.log('[Main] Tray icon loaded from:', trayIconPath);
  } catch (e) {
    console.error('[Main] Failed to load tray icon:', e);
    // Fallback to a simple icon if file fails
    icon = nativeImage.createEmpty();
  }

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

// Run shell commands (for opening Windows control panel applets like mmsys.cpl)
ipcMain.handle('run-command', (event, cmd) => {
  // Only allow safe commands
  const allowedCommands = ['mmsys.cpl', 'control', 'ms-settings:sound'];
  const cmdLower = cmd.toLowerCase();

  if (allowedCommands.some(allowed => cmdLower.includes(allowed))) {
    const { exec } = require('child_process');
    exec(cmd, (error) => {
      if (error) {
        console.error('[Main] Command execution error:', error);
      }
    });
    return true;
  }

  console.warn('[Main] Command not allowed:', cmd);
  return false;
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

// Compact mode dimensions
const COMPACT_WIDTH = 280;
const COMPACT_HEIGHT = 200;

// IPC handler for compact mode toggle
ipcMain.handle('set-compact-mode', (event, isCompact) => {
  try {
    const config = loadClientConfig();
    config.compactMode = isCompact;
    fs.writeFileSync(clientConfigPath, JSON.stringify(config, null, 2));

    // Resize window for compact mode
    if (mainWindow) {
      const currentBounds = mainWindow.getBounds();
      if (isCompact) {
        // Save current size before going compact
        config.fullModeSize = { width: currentBounds.width, height: currentBounds.height };
        fs.writeFileSync(clientConfigPath, JSON.stringify(config, null, 2));
        mainWindow.setMinimumSize(COMPACT_WIDTH, COMPACT_HEIGHT);
        mainWindow.setSize(COMPACT_WIDTH, COMPACT_HEIGHT, true);
      } else {
        // Restore previous size or default
        const restoreWidth = config.fullModeSize?.width || DEFAULT_WIDTH;
        const restoreHeight = config.fullModeSize?.height || DEFAULT_HEIGHT;
        mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
        mainWindow.setSize(restoreWidth, restoreHeight, true);
      }
    }
    return true;
  } catch (e) {
    console.error('Failed to set compact mode:', e);
    return false;
  }
});

ipcMain.handle('get-compact-mode', () => {
  try {
    const config = loadClientConfig();
    // Only return true if EXPLICITLY set to true (boolean)
    // Any other value (undefined, null, string, etc.) returns false
    return config.compactMode === true;
  } catch (e) {
    return false;
  }
});

// IPC handler to get current window bounds
ipcMain.handle('get-window-bounds', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

// IPC handler for window resize (custom resize handles for frameless window)
// Uses delta-based approach for smooth, responsive resizing
ipcMain.on('resize-window-delta', (event, { deltaX, deltaY, edge }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const [x, y] = win.getPosition();
  const [width, height] = win.getSize();

  let newWidth = width;
  let newHeight = height;
  let newX = x;
  let newY = y;

  // Apply deltas based on which edge is being dragged
  if (edge.includes('right')) {
    newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width + deltaX));
  }
  if (edge.includes('bottom')) {
    newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height + deltaY));
  }
  if (edge.includes('left')) {
    const proposedWidth = width - deltaX;
    if (proposedWidth >= MIN_WIDTH && proposedWidth <= MAX_WIDTH) {
      newWidth = proposedWidth;
      newX = x + deltaX;
    }
  }
  if (edge.includes('top')) {
    const proposedHeight = height - deltaY;
    if (proposedHeight >= MIN_HEIGHT && proposedHeight <= MAX_HEIGHT) {
      newHeight = proposedHeight;
      newY = y + deltaY;
    }
  }

  win.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight });
});

// Legacy handler for backwards compatibility
ipcMain.handle('resize-window', (event, { width, height, x, y }) => {
  if (mainWindow) {
    const currentBounds = mainWindow.getBounds();
    const newBounds = {
      x: x !== undefined ? x : currentBounds.x,
      y: y !== undefined ? y : currentBounds.y,
      width: width !== undefined ? width : currentBounds.width,
      height: height !== undefined ? height : currentBounds.height
    };
    mainWindow.setBounds(newBounds);
    return true;
  }
  return false;
});

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
