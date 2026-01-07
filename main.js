const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, shell, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Enable audio capture features for Windows WASAPI - MUST be before app.ready
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// Set up the display media request handler on the default session
// This MUST be done in the 'ready' event, before creating windows
app.on('ready', () => {
  console.log('[Main] Setting up display media request handler for loopback audio...');

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    console.log('[Main] Display media requested - providing loopback audio');

    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      console.log('[Main] Got', sources.length, 'screen source(s)');

      if (sources.length > 0) {
        // Grant access to first screen with loopback audio
        // 'loopback' is the official Electron way to capture system audio on Windows
        callback({
          video: sources[0],
          audio: 'loopback'
        });
        console.log('[Main] ✅ Granted loopback audio access for source:', sources[0].name);
      } else {
        console.error('[Main] ❌ No screen sources found');
        callback({});
      }
    }).catch(err => {
      console.error('[Main] ❌ Error getting sources:', err);
      callback({});
    });
  });

  console.log('[Main] ✅ Display media request handler configured');
});

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

  // DevTools enabled for debugging
  mainWindow.webContents.openDevTools({ mode: 'detach' });

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
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id
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
