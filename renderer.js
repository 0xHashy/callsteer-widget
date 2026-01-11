// CallSteer Widget - WebSocket-based Renderer
// Receives real-time nudges from backend via WebSocket (Dialpad integration)
// Also captures mic (rep) and system audio (customer) for Deepgram transcription

// ==================== DEEPGRAM CONFIGURATION ====================
const DEEPGRAM_API_KEY = '846b9dfcbcd1dc4fbdb03ac2e09fee2fbe3e9fab'; // TODO: Set your Deepgram API key or fetch from backend
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

// ==================== AUDIO CAPTURE STATE ====================
let micStream = null;           // Rep voice (microphone)
let systemAudioStream = null;   // Customer voice (system audio loopback)
let micMediaRecorder = null;
let systemMediaRecorder = null;
let deepgramMicSocket = null;   // Deepgram WebSocket for mic
let deepgramSystemSocket = null; // Deepgram WebSocket for system audio
let isCapturingAudio = false;

// ==================== PERSISTENT SYSTEM AUDIO STREAM ====================
// Windows picker only shows ONCE per session - stream stays open in background
// Subsequent power toggles mute/unmute the stream instead of closing it
let persistentSystemStream = null;  // The actual MediaStream from getDisplayMedia
let systemStreamMuted = false;      // Track mute state

// ==================== DEVICE SELECTION STATE ====================
let selectedMicId = null;
let selectedSpeakerId = null;

// ==================== AUDIO SOURCE STATE ====================
// User-selected call app (for UX clarity - audio capture uses all system audio)
let selectedDialerSource = null;  // { id: string, name: string, thumbnail?: string }
let pickerResolve = null;         // Promise resolver for picker modal

// ==================== POPUP STATE ====================
let popupDismissTimer = null;
const POPUP_AUTO_DISMISS_MS = 15000;

// ==================== NUDGE AUTO-DISMISS STATE ====================
let nudgeAutoDismissTimer = null;
const NUDGE_IGNORE_TIMEOUT_MS = 60000; // 60 seconds = auto-dismiss if ignored

// ==================== REBUTTAL TRACKING STATE ====================
let currentSuggestionText = '';      // The current nudge suggestion to match against
let rebuttalsUsedToday = 0;          // Count of rebuttals used today
let rebuttalsUsedTotal = 0;          // Total rebuttals used in session
let nudgesReceivedToday = 0;         // Count of nudges received today (persisted)
let currentStreak = 0;               // Current consecutive rebuttals used
let bestStreak = 0;                  // Best streak ever
let lastRebuttalWasUsed = false;     // Track if last nudge was converted
const REBUTTAL_MATCH_THRESHOLD = 0.35; // 35% word match = rebuttal used (allows paraphrasing)

// Rolling transcript buffer - accumulates rep speech for better matching
let repTranscriptBuffer = [];        // Array of {text, timestamp} chunks
const TRANSCRIPT_BUFFER_WINDOW_MS = 30000; // Keep last 30 seconds of speech

// ==================== AUTO-TIMEOUT STATE ====================
// Tracks CUSTOMER audio only (system audio stream) - rep talking doesn't reset timer
// This ensures: left on at desk → times out, on actual call → stays on
let lastCustomerAudioTime = 0;       // Timestamp of last customer audio detected
let autoTimeoutTimer = null;         // Timer for auto-timeout check
let silenceWarningShown = false;     // Track if 5 min warning was shown
const SILENCE_WARNING_MS = 5 * 60 * 1000; // 5 minutes = show warning
const AUTO_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes = auto power off
const AUTO_TIMEOUT_CHECK_MS = 30000;      // Check every 30 seconds

// ==================== GLOBAL ERROR HANDLERS ====================
window.onerror = function(msg, url, line, col, error) {
  console.error('[WINDOW ERROR]', msg);
  console.error('[WINDOW ERROR] Location:', url, 'line:', line, 'col:', col);
  console.error('[WINDOW ERROR] Error object:', error);
  if (error && error.stack) {
    console.error('[WINDOW ERROR] Stack:', error.stack);
  }
  return false;
};

window.onunhandledrejection = function(event) {
  console.error('[UNHANDLED PROMISE REJECTION]', event.reason);
  if (event.reason && event.reason.stack) {
    console.error('[UNHANDLED PROMISE] Stack:', event.reason.stack);
  }
};

console.log('[INIT] Global error handlers installed');

// API Configuration
const API_BASE_URL = 'https://callsteer-backend-production.up.railway.app';
const WS_BASE_URL = 'wss://callsteer-backend-production.up.railway.app';
const POLL_INTERVAL = 5000; // Fallback polling (less frequent since we have WebSocket)

// State
let clientCode = null;
let clientInfo = null;
let isListening = false;
let currentNudge = null;
let nudges = [];
let seenNudgeIds = new Set();
let pollingInterval = null;
let repId = null; // Unique rep identifier (name + device hash)
let repName = null; // Rep's display name for shift-based isolation

// WebSocket state
let nudgeSocket = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// ==================== THEME MANAGEMENT ====================

/**
 * Load saved theme from localStorage and apply it
 */
function loadTheme() {
  try {
    const savedTheme = localStorage.getItem('callsteer_widget_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    console.log('[Theme] Loaded theme:', savedTheme);
  } catch (e) {
    console.error('[Theme] Failed to load theme:', e);
  }
}

/**
 * Toggle between light and dark mode
 */
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';

  document.documentElement.setAttribute('data-theme', newTheme);

  try {
    localStorage.setItem('callsteer_widget_theme', newTheme);
    console.log('[Theme] Switched to:', newTheme);
  } catch (e) {
    console.error('[Theme] Failed to save theme:', e);
  }
}

/**
 * Setup theme toggle button listener
 */
function setupThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  themeToggleBtn?.addEventListener('click', toggleTheme);
}

// Load theme immediately before DOM content loaded to prevent flash
loadTheme();

// Initialize
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
  // CRITICAL: Force remove compact mode on start - it must be explicitly enabled
  document.body.classList.remove('compact-mode');
  console.log('[Init] Compact mode forcibly removed on start');

  // Clear any stale persistent stream from previous session
  // This ensures Windows picker ALWAYS appears on first power click after app start
  persistentSystemStream = null;
  systemStreamMuted = false;
  console.log('[Init] Cleared persistentSystemStream - picker will show on first power click');

  // Setup resize handles FIRST - they must work on ALL screens
  setupGlobalResizeHandles();

  setupWindowControls();
  setupLoginHandlers();
  setupThemeToggle();
  setupSetupWizard();

  // Load compact mode preference (only enables if explicitly saved as true)
  await loadCompactModePreference();

  // Load nudge sound preference
  loadNudgeSoundPreference();

  // Load saved rep name if exists (for returning users)
  repName = localStorage.getItem('callsteer_rep_name') || null;

  // Load saved mic selection
  const savedMicId = localStorage.getItem('callsteer_selected_mic');

  // Check for stored login
  if (window.electronAPI) {
    clientCode = await window.electronAPI.getClientCode();
    clientInfo = await window.electronAPI.getClientInfo();
  }

  // Only auto-login if we have both client code AND rep name
  if (clientCode && clientInfo && repName) {
    // Generate rep ID based on name
    repId = generateRepId(repName);
    console.log('[Auth] Rep ID:', repId, 'Name:', repName);

    // Check if mic is configured
    if (savedMicId) {
      selectedMicId = savedMicId;
      showMainWidget();
    } else {
      // Need to set up mic first
      showSetupWizard();
    }
  } else {
    showLoginScreen();
  }

  // Listen for logout from tray
  if (window.electronAPI?.onLogoutRequest) {
    window.electronAPI.onLogoutRequest(handleLogout);
  }

  // Listen for display media picker request from main process
  // This is triggered when getDisplayMedia is called and main process needs us to show a picker
  if (window.electronAPI?.onShowDisplayMediaPicker) {
    window.electronAPI.onShowDisplayMediaPicker(handleDisplayMediaPickerRequest);
  }
}

// Global variable to store pending display media picker resolve function
let pendingDisplayMediaResolve = null;

// Handle display media picker request from main process
async function handleDisplayMediaPickerRequest(sources) {
  console.log('[DisplayMedia] Received picker request with', sources.length, 'sources');

  try {
    // Show our existing call app picker with the sources
    const selectedSource = await showCallAppPickerWithSources(sources);

    if (selectedSource) {
      console.log('[DisplayMedia] User selected:', selectedSource.name);
      window.electronAPI.sendDisplayMediaSourceSelected(selectedSource.id);
    } else {
      console.log('[DisplayMedia] User cancelled picker');
      window.electronAPI.sendDisplayMediaSourceSelected(null);
    }
  } catch (err) {
    console.error('[DisplayMedia] Picker error:', err);
    window.electronAPI.sendDisplayMediaSourceSelected(null);
  }
}

// Show call app picker with pre-fetched sources (for IPC flow from getDisplayMedia)
async function showCallAppPickerWithSources(sources) {
  return new Promise((resolve) => {
    // Use existing picker modal elements
    const modal = document.getElementById('call-app-picker');
    const callAppsGrid = document.getElementById('picker-call-apps-grid');
    const otherGrid = document.getElementById('picker-other-grid');
    const cancelBtn = document.getElementById('picker-cancel-btn');

    if (!modal) {
      console.error('[Picker] Modal not found: call-app-picker');
      resolve(null);
      return;
    }

    console.log('[Picker] Showing picker with', sources.length, 'sources');

    // Clear existing content
    if (callAppsGrid) callAppsGrid.innerHTML = '';
    if (otherGrid) otherGrid.innerHTML = '';

    // Categorize sources
    const screens = sources.filter(s => s.id.startsWith('screen:'));
    const windows = sources.filter(s => s.id.startsWith('window:'));

    console.log('[Picker] Screens:', screens.length, 'Windows:', windows.length);

    // Add screens to call apps section (they're the primary capture source)
    screens.forEach(source => {
      const item = createDisplayMediaPickerItem(source, resolve, modal);
      if (callAppsGrid) callAppsGrid.appendChild(item);
    });

    // Add windows to other section
    windows.forEach(source => {
      const item = createDisplayMediaPickerItem(source, resolve, modal);
      if (otherGrid) otherGrid.appendChild(item);
    });

    // Cancel button handler
    const handleCancel = () => {
      modal.style.display = 'none';
      resolve(null);
    };
    if (cancelBtn) {
      cancelBtn.onclick = handleCancel;
    }

    // Click outside to cancel
    modal.onclick = (e) => {
      if (e.target === modal) {
        handleCancel();
      }
    };

    // Show modal
    modal.style.display = 'flex';
  });
}

// Create a picker item element for display media picker
function createDisplayMediaPickerItem(source, resolve, modal) {
  const item = document.createElement('div');
  item.className = 'picker-item';
  item.dataset.sourceId = source.id;
  item.dataset.sourceName = source.name;

  // Icon container
  const iconDiv = document.createElement('div');
  iconDiv.className = 'picker-item-icon';

  // Use thumbnail or app icon
  if (source.thumbnail) {
    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = source.name;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.style.borderRadius = '4px';
    img.onerror = () => {
      // Fallback to default icon
      iconDiv.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>';
    };
    iconDiv.appendChild(img);
  } else {
    // Default screen icon
    iconDiv.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>';
  }

  // Name
  const nameSpan = document.createElement('span');
  nameSpan.className = 'picker-item-name';
  nameSpan.textContent = source.name.length > 20 ? source.name.substring(0, 20) + '...' : source.name;

  item.appendChild(iconDiv);
  item.appendChild(nameSpan);

  item.onclick = () => {
    console.log('[Picker] Selected:', source.name, source.id);
    modal.style.display = 'none';
    resolve(source);
  };

  return item;
}

// ==================== REP ID MANAGEMENT ====================

/**
 * Get or create a device ID (stays constant per installation)
 * This is combined with rep name to create the full rep_id
 */
function getOrCreateDeviceId() {
  try {
    let deviceId = localStorage.getItem('callsteer_device_id');

    if (!deviceId) {
      // Generate a unique device ID: timestamp + random string
      deviceId = `dev_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      localStorage.setItem('callsteer_device_id', deviceId);
      console.log('[Device] Generated new device ID:', deviceId);
    }

    return deviceId;
  } catch (e) {
    console.error('[Device] Failed to get/create device ID:', e);
    return `dev_temp_${Date.now()}`;
  }
}

/**
 * Generate a rep ID from the rep's name
 * Format: normalized_name_devicehash
 * This allows:
 * - Same person on different computers → different rep_ids (that's ok, data is server-side)
 * - Different people on same computer → different rep_ids (name differentiates)
 */
function generateRepId(name) {
  if (!name) return null;

  // Normalize name: lowercase, remove special chars, replace spaces with underscores
  const normalizedName = name.toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 20); // Limit length

  // Get device ID for additional uniqueness
  const deviceId = getOrCreateDeviceId();
  const deviceHash = deviceId.substring(deviceId.length - 6); // Last 6 chars

  return `${normalizedName}_${deviceHash}`;
}

// ==================== SCREEN NAVIGATION ====================

function showLoginScreen() {
  console.log('[UI] Showing login screen...');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('setup-wizard').style.display = 'none';
  document.getElementById('main-widget').style.display = 'none';
  stopPolling();
  disconnectNudgeWebSocket();
}

function showMainWidget() {
  console.log('[UI] Showing main widget...');
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('setup-wizard').style.display = 'none';

  const mainWidget = document.getElementById('main-widget');
  mainWidget.style.display = 'flex';

  // CRITICAL FIX: ALWAYS force remove compact mode class
  // It should only be added when user explicitly enables it in settings
  const hadCompactMode = document.body.classList.contains('compact-mode');
  document.body.classList.remove('compact-mode');

  if (hadCompactMode) {
    console.warn('[UI] WARNING: compact-mode was ON - forcibly removed!');
  }

  // Check if compact mode toggle is ON in settings
  const compactToggle = document.getElementById('compact-mode-toggle');
  const isCompactModeEnabled = compactToggle?.classList.contains('active') || false;

  console.log('[UI] Compact toggle state:', isCompactModeEnabled ? 'ACTIVE' : 'inactive');

  // ALWAYS force visibility on essential elements with inline styles
  // This overrides ANY CSS rule that might be hiding them
  const header = mainWidget.querySelector('.header');
  const content = mainWidget.querySelector('.content');
  const footer = mainWidget.querySelector('.footer');
  const tabNav = mainWidget.querySelector('.tab-nav');
  const audioConfig = mainWidget.querySelector('.audio-config-section');
  const toggleSection = mainWidget.querySelector('.toggle-section');
  const nudgeSection = mainWidget.querySelector('.nudge-section');

  // Force ALL essential elements visible
  if (header) {
    header.style.cssText = 'display: flex !important; visibility: visible !important;';
    console.log('[UI] Header forced visible via inline style');
  }
  if (content) {
    content.style.cssText = 'display: flex !important; flex-direction: column !important; visibility: visible !important;';
    console.log('[UI] Content forced visible via inline style');
  }
  if (footer) {
    footer.style.cssText = 'display: flex !important; visibility: visible !important;';
    console.log('[UI] Footer forced visible via inline style');
  }
  if (tabNav) {
    tabNav.style.cssText = 'display: flex !important; visibility: visible !important;';
    console.log('[UI] Tab nav forced visible via inline style');
  }
  if (audioConfig) {
    audioConfig.style.cssText = 'display: flex !important; flex-direction: column !important; visibility: visible !important;';
    console.log('[UI] Audio config forced visible via inline style');
  }
  if (toggleSection) {
    toggleSection.style.cssText = 'display: flex !important; visibility: visible !important;';
    console.log('[UI] Toggle section forced visible via inline style');
  }
  if (nudgeSection) {
    nudgeSection.style.cssText = 'display: flex !important; flex-direction: column !important; visibility: visible !important;';
    console.log('[UI] Nudge section forced visible via inline style');
  }

  // DEBUG: Full DOM diagnostic
  debugMainWidget();
}

/**
 * DEBUG FUNCTION - logs full DOM state to diagnose visibility issues
 */
function debugMainWidget() {
  console.log('=== DOM DEBUG ===');

  const mainWidget = document.getElementById('main-widget');
  console.log('Main widget:', mainWidget);
  console.log('Main widget display:', mainWidget?.style.display);
  console.log('Main widget classes:', mainWidget?.className);

  // Log ALL direct children of main-widget
  if (mainWidget) {
    console.log('Main widget children:');
    Array.from(mainWidget.children).forEach((child, i) => {
      const styles = window.getComputedStyle(child);
      console.log(`  ${i}: ${child.tagName}.${child.className}`, {
        display: styles.display,
        visibility: styles.visibility,
        opacity: styles.opacity,
        height: styles.height
      });
    });
  }

  // Check body classes
  console.log('Body classes:', document.body.className);

  // Check if header exists and its computed style
  const header = mainWidget?.querySelector('.header');
  if (header) {
    const headerStyles = window.getComputedStyle(header);
    console.log('Header computed:', {
      display: headerStyles.display,
      visibility: headerStyles.visibility,
      height: headerStyles.height,
      position: headerStyles.position
    });
  } else {
    console.log('Header: NOT FOUND IN DOM');
  }

  // Check content
  const content = mainWidget?.querySelector('.content');
  if (content) {
    const contentStyles = window.getComputedStyle(content);
    console.log('Content computed:', {
      display: contentStyles.display,
      visibility: contentStyles.visibility,
      height: contentStyles.height
    });

    // Check content children
    console.log('Content children:');
    Array.from(content.children).forEach((child, i) => {
      const styles = window.getComputedStyle(child);
      console.log(`  ${i}: ${child.tagName}.${child.className}`, {
        display: styles.display,
        visibility: styles.visibility
      });
    });
  }

  // Check footer
  const footer = mainWidget?.querySelector('.footer');
  if (footer) {
    const footerStyles = window.getComputedStyle(footer);
    console.log('Footer computed:', {
      display: footerStyles.display,
      visibility: footerStyles.visibility
    });
  } else {
    console.log('Footer: NOT FOUND IN DOM');
  }

  console.log('=== END DOM DEBUG ===');

  // Verify main widget structure and compact mode state
  const isCompact = document.body.classList.contains('compact-mode');
  console.log('[UI] Main widget shown. Compact mode:', isCompact);

  // Clear old nudges from previous sessions - start fresh
  // Live nudges only - they disappear when widget closes
  nudges = [];
  seenNudgeIds = new Set();
  currentNudge = null;
  currentSuggestionText = ''; // Clear any tracked suggestion

  // Reset listening state on widget open
  isListening = false;

  // Show empty state (not old nudge)
  displayNudge(null);
  updateNudgeEmptyState();

  // Reset toggle UI to OFF state
  updateToggleUI(false);

  setupToggle();
  setupNudgeActions();
  setupStatsTabs();
  // DON'T start polling here - only poll when listening is ON
  // startPolling() is now called in toggleListening() when turning ON
  updateConnectionStatus('connected', 'Connected');

  // Initialize device selection (hidden select for mic)
  loadSavedDevices();
  populateDeviceDropdowns();

  // Update the audio config display
  updateAudioConfigDisplay();

  // Load rebuttal tracking stats
  loadRebuttalStats();
  updateStats();
}

/**
 * Update the audio config display with current mic info
 * (Call app is selected via Windows picker when listening starts)
 */
function updateAudioConfigDisplay() {
  const micDisplay = document.getElementById('mic-display');

  // Update mic display
  if (micDisplay) {
    const micSelect = document.getElementById('mic-select');
    if (micSelect && micSelect.selectedIndex > 0) {
      const selectedOption = micSelect.options[micSelect.selectedIndex];
      // Truncate long names
      const micName = selectedOption.text.length > 25
        ? selectedOption.text.substring(0, 22) + '...'
        : selectedOption.text;
      micDisplay.textContent = micName;
      micDisplay.classList.remove('not-set');
    } else {
      micDisplay.textContent = 'Not configured';
      micDisplay.classList.add('not-set');
    }
  }

  // Update system audio status display
  updateSystemAudioStatus();
}

/**
 * Update the system audio status display
 * Shows VB-Cable status in the main widget
 */
async function updateSystemAudioStatus() {
  const statusDisplay = document.getElementById('system-audio-display');
  if (!statusDisplay) return;

  try {
    const vbCable = await detectVBCable();

    if (vbCable) {
      statusDisplay.innerHTML = '<span class="status-dot"></span>VB-Cable Ready';
      statusDisplay.classList.remove('error', 'warning');
    } else {
      statusDisplay.innerHTML = '<span class="status-dot"></span>Not configured';
      statusDisplay.classList.add('warning');
      statusDisplay.classList.remove('error');
    }
  } catch (e) {
    statusDisplay.innerHTML = '<span class="status-dot"></span>Error detecting';
    statusDisplay.classList.add('error');
    statusDisplay.classList.remove('warning');
  }
}

// ==================== WINDOW CONTROLS ====================

function setupWindowControls() {
  // Login screen controls
  document.getElementById('login-close-btn')?.addEventListener('click', () => {
    window.electronAPI?.closeWindow();
  });
  document.getElementById('login-minimize-btn')?.addEventListener('click', () => {
    window.electronAPI?.minimizeWindow();
  });

  // Main widget controls
  document.getElementById('close-btn')?.addEventListener('click', () => {
    window.electronAPI?.closeWindow();
  });
  document.getElementById('minimize-btn')?.addEventListener('click', () => {
    window.electronAPI?.minimizeWindow();
  });

  // Settings button - toggles dropdown menu
  const settingsBtn = document.getElementById('settings-btn');
  const settingsDropdown = document.getElementById('settings-dropdown');

  settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[Settings] Toggle dropdown');
    settingsDropdown?.classList.toggle('show');
    settingsBtn?.classList.toggle('active');
    updateSettingsDropdownInfo();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-menu-container')) {
      settingsDropdown?.classList.remove('show');
      settingsBtn?.classList.remove('active');
    }
  });

  // Audio Setup menu item (microphone only)
  document.getElementById('menu-audio-setup')?.addEventListener('click', () => {
    console.log('[Settings] Opening microphone setup wizard...');
    settingsDropdown?.classList.remove('show');
    settingsBtn?.classList.remove('active');
    showSetupWizard();
  });

  // Change Call App menu item - shows picker to select different call app
  document.getElementById('menu-change-call-app')?.addEventListener('click', async () => {
    console.log('[Settings] Change Call App clicked...');
    settingsDropdown?.classList.remove('show');
    settingsBtn?.classList.remove('active');

    // Show the picker
    const selected = await showCallAppPicker();
    if (selected) {
      selectedDialerSource = selected;
      updateCallAppDisplay();
      showToast(`Call app changed to ${selected.name}`, 'success');
    }
  });

  // Call app config row click handler
  document.getElementById('call-app-config-row')?.addEventListener('click', async () => {
    const selected = await showCallAppPicker();
    if (selected) {
      selectedDialerSource = selected;
      updateCallAppDisplay();
    }
  });

  // Picker cancel button
  document.getElementById('picker-cancel-btn')?.addEventListener('click', () => {
    hideCallAppPicker();
  });

  // System Audio Setup menu item - opens VB-Cable setup modal
  document.getElementById('menu-system-audio')?.addEventListener('click', () => {
    console.log('[Settings] Opening system audio setup...');
    settingsDropdown?.classList.remove('show');
    settingsBtn?.classList.remove('active');
    showVBCableSetupModal();
  });

  // Audio Help menu item - opens Listen setup guide
  document.getElementById('menu-audio-help')?.addEventListener('click', () => {
    console.log('[Settings] Opening audio help guide...');
    settingsDropdown?.classList.remove('show');
    settingsBtn?.classList.remove('active');
    showListenSetupModal();
  });

  // Audio Help link in main widget
  document.getElementById('audio-help-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('[Audio] Help link clicked');
    showListenSetupModal();
  });

  // Audio Warning dismiss button
  document.getElementById('dismiss-audio-warning')?.addEventListener('click', () => {
    const audioWarning = document.getElementById('audio-warning');
    if (audioWarning) audioWarning.style.display = 'none';
    // Remember dismissal for this session
    localStorage.setItem('callsteer_audio_warning_dismissed', 'true');
  });

  // Compact Mode toggle
  document.getElementById('menu-compact-mode')?.addEventListener('click', async (e) => {
    e.stopPropagation(); // Don't close dropdown
    const toggle = document.getElementById('compact-mode-toggle');
    const isCurrentlyCompact = toggle?.classList.contains('active');
    const newCompactState = !isCurrentlyCompact;

    // Update toggle UI
    if (toggle) {
      toggle.classList.toggle('active', newCompactState);
    }

    // Update body class
    document.body.classList.toggle('compact-mode', newCompactState);

    // Clear any inline styles so CSS rules take over properly
    const mainWidget = document.getElementById('main-widget');
    if (mainWidget) {
      const header = mainWidget.querySelector('.header');
      const content = mainWidget.querySelector('.content');
      const footer = mainWidget.querySelector('.footer');
      const tabNav = mainWidget.querySelector('.tab-nav');
      const audioConfig = mainWidget.querySelector('.audio-config-section');
      const toggleSection = mainWidget.querySelector('.toggle-section');

      // Remove inline display styles - let CSS handle it
      [header, content, footer, tabNav, audioConfig, toggleSection].forEach(el => {
        if (el) el.style.display = '';
      });
    }

    // Save preference via IPC
    if (window.electronAPI?.setCompactMode) {
      await window.electronAPI.setCompactMode(newCompactState);
    }

    console.log('[Settings] Compact mode:', newCompactState ? 'ON' : 'OFF');
  });

  // Nudge Sound toggle
  document.getElementById('menu-nudge-sound')?.addEventListener('click', (e) => {
    e.stopPropagation(); // Don't close dropdown
    const toggle = document.getElementById('nudge-sound-toggle');
    const isCurrentlyEnabled = toggle?.classList.contains('active');
    const newSoundState = !isCurrentlyEnabled;

    // Update toggle UI
    if (toggle) {
      toggle.classList.toggle('active', newSoundState);
    }

    // Save preference to localStorage
    try {
      localStorage.setItem('callsteer_nudge_sound', newSoundState ? 'on' : 'off');
    } catch (e) {}

    console.log('[Settings] Nudge sound:', newSoundState ? 'ON' : 'OFF');
  });

  // Sign Out menu item
  document.getElementById('menu-signout')?.addEventListener('click', () => {
    settingsDropdown?.classList.remove('show');
    settingsBtn?.classList.remove('active');
    handleSignOut();
  });

  // Clickable audio config rows - open setup wizard
  document.getElementById('mic-config-row')?.addEventListener('click', () => {
    console.log('[Audio Config] Mic row clicked, opening wizard...');
    showSetupWizard();
  });

  // Setup resize handles for frameless window
  setupResizeHandles();
}

/**
 * Setup custom resize handles for frameless window
 * Uses delta-based approach for smooth, responsive resizing
 */
/**
 * Setup GLOBAL resize handles - these live on the body and work on ALL screens
 * (login, setup wizard, main widget, etc.)
 */
function setupGlobalResizeHandles() {
  // Remove any existing resize handles first (from widgets or body)
  document.querySelectorAll('.resize-handle').forEach(el => el.remove());

  const edges = ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

  edges.forEach(edge => {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-handle-${edge} global-resize-handle`;
    if (edge.includes('-')) {
      handle.classList.add('resize-handle-corner');
    }
    handle.dataset.direction = edge;

    // CRITICAL: Append to BODY, not any widget container
    document.body.appendChild(handle);

    let startX, startY;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      startX = e.screenX;
      startY = e.screenY;

      // Add active class for visual feedback
      handle.classList.add('active');
      document.body.style.cursor = getComputedStyle(handle).cursor;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.screenX - startX;
        const deltaY = moveEvent.screenY - startY;

        // Update start position for next delta
        startX = moveEvent.screenX;
        startY = moveEvent.screenY;

        // Send delta to main process (synchronous, no async lag)
        if (window.electronAPI?.resizeWindowDelta) {
          window.electronAPI.resizeWindowDelta(deltaX, deltaY, edge);
        }
      };

      const onMouseUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });

  console.log('[Resize] Global resize handles initialized on body - work on ALL screens');
}

// Legacy function - now just calls the global version
function setupResizeHandles() {
  // Resize handles are now global, setup once on init
  // This function is kept for backwards compatibility
  console.log('[Resize] setupResizeHandles called - handles already global');
}

/**
 * Update the settings dropdown with current user info
 */
function updateSettingsDropdownInfo() {
  const nameEl = document.getElementById('settings-rep-name');
  const companyEl = document.getElementById('settings-company-name');

  if (nameEl) {
    nameEl.textContent = repName || 'Not signed in';
  }
  if (companyEl) {
    companyEl.textContent = clientInfo?.company_name || 'No company';
  }

  // Also update the header greeting
  updateGreeting();
}

/**
 * Update the header greeting with personalized rep name
 */
function updateGreeting() {
  const greetingEl = document.getElementById('user-greeting');
  if (!greetingEl) return;

  // Use the global repName from state, or fall back to repId
  const rawName = repName || repId || '';

  if (!rawName || rawName === 'undefined') {
    greetingEl.innerHTML = '';
    return;
  }

  // Extract first name from formats like "stephen_abc123", "Stephen Smith", "John S"
  let firstName = rawName;

  // Remove any suffix after underscore (like _abc123)
  firstName = firstName.split('_')[0];

  // Take first word/part if space-separated
  firstName = firstName.split(' ')[0];

  // Capitalize first letter, lowercase rest
  firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  // Set the greeting
  if (firstName && firstName !== 'Undefined' && firstName.length > 0) {
    greetingEl.innerHTML = `Hi, <span class="rep-name">${firstName}</span>`;
  } else {
    greetingEl.innerHTML = '';
  }
}

/**
 * Load compact mode preference from main process storage
 * CRITICAL: Defaults to FALSE - compact mode must be EXPLICITLY enabled
 */
async function loadCompactModePreference() {
  try {
    let isCompact = false; // DEFAULT: compact mode OFF

    if (window.electronAPI?.getCompactMode) {
      const savedCompact = await window.electronAPI.getCompactMode();
      // Only enable if EXPLICITLY saved as true
      isCompact = savedCompact === true;
      console.log('[Init] Compact mode preference from storage:', savedCompact, '-> using:', isCompact);
    } else {
      console.log('[Init] No electronAPI.getCompactMode - defaulting to full mode');
    }

    // Update toggle UI
    const toggle = document.getElementById('compact-mode-toggle');
    if (toggle) {
      toggle.classList.toggle('active', isCompact);
    }

    // Update body class - ONLY add if explicitly true, always remove if false
    if (isCompact) {
      document.body.classList.add('compact-mode');
      console.log('[Init] Compact mode ENABLED');
    } else {
      document.body.classList.remove('compact-mode');
      console.log('[Init] Full mode ENABLED (compact mode removed)');
    }
  } catch (e) {
    console.error('[Init] Failed to load compact mode preference:', e);
    // On error, ensure full mode
    document.body.classList.remove('compact-mode');
  }
}

/**
 * Load nudge sound preference from localStorage
 */
function loadNudgeSoundPreference() {
  try {
    const soundSetting = localStorage.getItem('callsteer_nudge_sound');
    // Default to ON if not set
    const isEnabled = soundSetting !== 'off';
    console.log('[Init] Nudge sound preference:', isEnabled ? 'ON' : 'OFF');

    // Update toggle UI
    const toggle = document.getElementById('nudge-sound-toggle');
    if (toggle) {
      toggle.classList.toggle('active', isEnabled);
    }
  } catch (e) {
    console.error('[Init] Failed to load nudge sound preference:', e);
  }
}

async function handleSignOut() {
  // Stop listening if active
  if (isListening) {
    stopListening();
  }

  // Clear persistent system audio stream (new user starts fresh)
  if (persistentSystemStream) {
    persistentSystemStream.getTracks().forEach(track => track.stop());
    persistentSystemStream = null;
    console.log('[Auth] Cleared persistent system stream');
  }

  // Clear stored credentials
  if (window.electronAPI) {
    await window.electronAPI.clearClientCode();
  }

  // Reset state - clear rep name too since sign out means different person
  clientCode = null;
  clientInfo = null;
  repId = null;
  repName = null;
  localStorage.removeItem('callsteer_rep_name');

  // Clear dialer selection on sign out (new user might have different dialer)
  clearDialerSelection();

  // Show login screen
  document.getElementById('main-widget').style.display = 'none';
  document.getElementById('setup-wizard').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('rep-name-input').value = '';
  document.getElementById('client-code-input').value = '';
  document.getElementById('login-error').textContent = '';

  console.log('[Auth] Signed out');
}


// ==================== DEVICE SELECTION ====================

function loadSavedDevices() {
  try {
    selectedMicId = localStorage.getItem('callsteer_mic_id');
    console.log('[Devices] Loaded saved mic:', selectedMicId);
  } catch (e) {
    console.error('[Devices] Failed to load saved devices:', e);
  }
}

function saveSelectedDevices() {
  try {
    if (selectedMicId) {
      localStorage.setItem('callsteer_mic_id', selectedMicId);
    }
    console.log('[Devices] Saved mic:', selectedMicId);
  } catch (e) {
    console.error('[Devices] Failed to save devices:', e);
  }
}

async function populateDeviceDropdowns() {
  try {
    // Request permissions first to get labeled devices
    await navigator.mediaDevices.getUserMedia({ audio: true });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

    console.log('[Devices] Found:', audioInputs.length, 'inputs,', audioOutputs.length, 'outputs');

    // Populate microphone dropdown
    const micSelect = document.getElementById('mic-select');
    if (micSelect) {
      micSelect.innerHTML = '<option value="">Select microphone...</option>';
      audioInputs.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${device.deviceId.substring(0, 8)}`;
        if (device.deviceId === selectedMicId) {
          option.selected = true;
        }
        micSelect.appendChild(option);
      });

      micSelect.addEventListener('change', (e) => {
        selectedMicId = e.target.value;
        saveSelectedDevices();
        updateAudioConfigDisplay();
        console.log('[Devices] Selected mic:', selectedMicId);
      });
    }

    // Auto-select first mic if none saved
    if (!selectedMicId && audioInputs.length > 0) {
      selectedMicId = audioInputs[0].deviceId;
      if (micSelect) micSelect.value = selectedMicId;
    }

    // Update the display
    updateAudioConfigDisplay();

  } catch (error) {
    console.error('[Devices] Failed to enumerate devices:', error);
    showToast('Could not access audio devices', 'error');
  }
}

// ==================== LOGIN ====================

function setupLoginHandlers() {
  const connectBtn = document.getElementById('connect-btn');
  const codeInput = document.getElementById('client-code-input');
  const nameInput = document.getElementById('rep-name-input');
  const signupLink = document.getElementById('signup-link');

  connectBtn?.addEventListener('click', handleLogin);

  // Auto-uppercase and filter company code
  codeInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // Enter key handling for both inputs
  nameInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      codeInput?.focus(); // Move to code input
    }
  });

  codeInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  signupLink?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI?.openExternal('https://callsteer.com');
  });

  // Pre-fill name if saved (for convenience)
  if (nameInput && repName) {
    nameInput.value = repName;
  }
}

async function handleLogin() {
  const nameInput = document.getElementById('rep-name-input');
  const codeInput = document.getElementById('client-code-input');
  const errorEl = document.getElementById('login-error');
  const connectBtn = document.getElementById('connect-btn');

  const name = nameInput?.value.trim() || '';
  const code = codeInput.value.trim().toUpperCase();

  // Validate name
  if (!name || name.length < 2) {
    showLoginError('Enter your name');
    nameInput?.focus();
    return;
  }

  // Validate code
  if (!code || code.length !== 6) {
    showLoginError('Enter a 6-character code');
    codeInput?.focus();
    return;
  }

  errorEl.textContent = '';
  connectBtn.classList.add('loading');
  connectBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/clients/${code}`);

    if (!response.ok) {
      throw new Error(response.status === 404 ? 'Invalid code' : 'Connection error');
    }

    const data = await response.json();

    // Save rep name and generate rep ID
    repName = name;
    localStorage.setItem('callsteer_rep_name', repName);
    repId = generateRepId(repName);
    console.log('[Auth] Rep logged in:', repName, 'ID:', repId);

    clientCode = code;
    clientInfo = {
      client_code: code,
      company_name: data.company_name,
      has_dna: data.has_dna
    };

    if (window.electronAPI) {
      await window.electronAPI.saveClientCode(code);
      await window.electronAPI.saveClientInfo(clientInfo);
    }

    // Check if dialer is already configured
    if (selectedDialerSource) {
      showMainWidget();
    } else {
      // Need to set up dialer first
      showSetupWizard();
    }

  } catch (error) {
    showLoginError(error.message);
  } finally {
    connectBtn.classList.remove('loading');
    connectBtn.disabled = false;
  }
}

function showLoginError(message) {
  const errorEl = document.getElementById('login-error');
  if (errorEl) errorEl.textContent = message;
}

async function handleLogout() {
  disconnectNudgeWebSocket();

  if (window.electronAPI) {
    await window.electronAPI.clearClientCode();
  }

  // Clear session state but KEEP rep name for convenience
  clientCode = null;
  clientInfo = null;
  repId = null;
  seenNudgeIds = new Set();
  nudges = [];
  currentNudge = null;

  // Clear inputs (name stays pre-filled from localStorage)
  document.getElementById('client-code-input').value = '';
  document.getElementById('login-error').textContent = '';

  showLoginScreen();
}

// ==================== SETUP WIZARD (MIC SELECTION + INSTRUCTIONS) ====================

function setupSetupWizard() {
  console.log('[Setup] Setting up wizard handlers...');

  // Setup wizard window controls
  document.getElementById('setup-close-btn')?.addEventListener('click', () => {
    if (window.electronAPI) window.electronAPI.closeWindow();
  });
  document.getElementById('setup-minimize-btn')?.addEventListener('click', () => {
    if (window.electronAPI) window.electronAPI.minimizeWindow();
  });

  // Step 0: Setup choice buttons
  document.getElementById('btn-use-chrome-extension')?.addEventListener('click', () => {
    console.log('[Setup] User chose Chrome Extension');
    localStorage.setItem('callsteer_setup_choice', 'chrome-extension');
    openChromeExtension();
    // Minimize or close the desktop app
    if (window.electronAPI) window.electronAPI.minimizeWindow();
  });

  document.getElementById('btn-continue-desktop')?.addEventListener('click', () => {
    console.log('[Setup] User chose Desktop App');
    localStorage.setItem('callsteer_setup_choice', 'desktop');
    showSetupStep(1);
  });

  // Step 1: Back button goes to step 0
  document.getElementById('setup-back-btn')?.addEventListener('click', () => {
    console.log('[Setup] Back button clicked - going to step 0');
    showSetupStep(0);
  });

  // Step 1: Next button goes to step 2 (Listen setup)
  const nextBtn = document.getElementById('setup-next-btn');
  console.log('[Setup] Next button element:', nextBtn);

  if (nextBtn) {
    nextBtn.addEventListener('click', handleSetupNext);
    console.log('[Setup] Next button handler attached');
  } else {
    console.error('[Setup] Next button not found!');
  }

  // Step 2: Listen setup buttons
  document.getElementById('open-sound-settings-btn')?.addEventListener('click', () => {
    console.log('[Setup] Opening Windows Sound Settings');
    openSoundSettings();
  });

  document.getElementById('setup-step2-back-btn')?.addEventListener('click', () => {
    showSetupStep(1);
  });

  document.getElementById('setup-skip-listen-btn')?.addEventListener('click', () => {
    console.log('[Setup] User skipped Listen setup');
    showSetupStep(3);
  });

  document.getElementById('setup-listen-done-btn')?.addEventListener('click', () => {
    console.log('[Setup] User completed Listen setup');
    showSetupStep(3);
  });

  // Step 3: Back button and Done button
  document.getElementById('setup-step3-back-btn')?.addEventListener('click', () => {
    showSetupStep(2);
  });

  const doneBtn = document.getElementById('setup-done-btn');
  if (doneBtn) {
    doneBtn.addEventListener('click', handleSetupDone);
  }
}

// Open Windows Sound Settings (mmsys.cpl)
function openSoundSettings() {
  if (window.electronAPI?.runCommand) {
    // Open mmsys.cpl via shell command
    window.electronAPI.runCommand('mmsys.cpl');
  } else if (window.electronAPI?.openExternal) {
    // Fallback - try opening as a URL (may not work for .cpl files)
    window.electronAPI.openExternal('mmsys.cpl');
  } else {
    showToast('Open Sound Settings from Control Panel', 'info');
  }
}

// Mic test stream and analyzer
let micTestStream = null;
let micTestAnalyzer = null;
let micTestAnimationFrame = null;

function handleSetupNext() {
  console.log('[Setup] Next button clicked - going to step 2 (Listen setup)');
  console.log('[Setup] selectedMicId:', selectedMicId);

  if (!selectedMicId) {
    console.warn('[Setup] No mic selected!');
    showToast('Please select a microphone', 'warning');
    return;
  }

  // Stop mic test before advancing
  stopMicTest();

  // Save mic selection
  const mainMicSelect = document.getElementById('mic-select');
  if (mainMicSelect) {
    mainMicSelect.value = selectedMicId;
  }
  saveSelectedDevices();

  // Show step 2 (Listen setup)
  showSetupStep(2);
}

function handleSetupDone() {
  console.log('[Setup] Done button clicked - completing setup');
  showMainWidget();
}

function showSetupStep(step) {
  const step0 = document.getElementById('setup-step-0');
  const step1 = document.getElementById('setup-step-1');
  const step2 = document.getElementById('setup-step-2');
  const step3 = document.getElementById('setup-step-3');

  // Hide all steps first
  if (step0) step0.style.display = 'none';
  if (step1) step1.style.display = 'none';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'none';

  // Show the requested step
  switch (step) {
    case 0:
      if (step0) step0.style.display = 'flex';
      stopMicTest();
      break;
    case 1:
      if (step1) step1.style.display = 'flex';
      // Start mic test
      startMicTest();
      break;
    case 2:
      if (step2) step2.style.display = 'flex';
      stopMicTest();
      break;
    case 3:
      if (step3) step3.style.display = 'flex';
      stopMicTest();
      break;
  }
}

function showSetupWizard() {
  console.log('[UI] Showing setup wizard...');
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-widget').style.display = 'none';
  document.getElementById('setup-wizard').style.display = 'flex';

  // Check if user has already made a setup choice
  const savedChoice = localStorage.getItem('callsteer_setup_choice');

  if (savedChoice === 'desktop') {
    // User already chose desktop, go directly to mic selection
    showSetupStep(1);
  } else {
    // Show setup choice screen (step 0)
    showSetupStep(0);
  }

  // Reset next button to disabled state
  const nextBtn = document.getElementById('setup-next-btn');
  if (nextBtn) {
    nextBtn.disabled = true;
  }

  // Load microphone options
  loadSetupMicOptions();

  // Update done button state (mic only now - Windows picker handles call app)
  updateSetupDoneButton();
}

// Start mic test visualization
async function startMicTest() {
  const micTestSection = document.getElementById('mic-test-section');
  const micTestStatus = document.getElementById('mic-test-status');

  if (!selectedMicId || !micTestSection) return;

  try {
    // Stop any existing test
    stopMicTest();

    // Get mic stream
    micTestStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: selectedMicId } }
    });

    // Create audio context and analyzer
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(micTestStream);
    micTestAnalyzer = audioContext.createAnalyser();
    micTestAnalyzer.fftSize = 32;
    source.connect(micTestAnalyzer);

    // Show the test section
    micTestSection.style.display = 'block';
    if (micTestStatus) micTestStatus.textContent = 'Speak to test your mic...';

    // Start visualization
    visualizeMicTest();
  } catch (error) {
    console.error('[Setup] Mic test failed:', error);
    if (micTestSection) micTestSection.style.display = 'none';
  }
}

function visualizeMicTest() {
  if (!micTestAnalyzer) return;

  const bars = document.querySelectorAll('#mic-waveform .waveform-bar');
  const dataArray = new Uint8Array(micTestAnalyzer.frequencyBinCount);
  const micTestSection = document.getElementById('mic-test-section');
  const micTestStatus = document.getElementById('mic-test-status');

  function draw() {
    micTestAnimationFrame = requestAnimationFrame(draw);
    micTestAnalyzer.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

    // Update bars
    bars.forEach((bar, i) => {
      const value = dataArray[i] || 0;
      const height = Math.max(8, (value / 255) * 36);
      bar.style.height = `${height}px`;
    });

    // Update status based on audio level
    if (average > 30) {
      micTestSection?.classList.add('active');
      if (micTestStatus) {
        micTestStatus.textContent = 'Mic is working!';
        micTestStatus.classList.add('success');
      }
    } else {
      micTestSection?.classList.remove('active');
      if (micTestStatus && !micTestStatus.classList.contains('success')) {
        micTestStatus.textContent = 'Speak to test your mic...';
      }
    }
  }

  draw();
}

function stopMicTest() {
  if (micTestAnimationFrame) {
    cancelAnimationFrame(micTestAnimationFrame);
    micTestAnimationFrame = null;
  }
  if (micTestStream) {
    micTestStream.getTracks().forEach(track => track.stop());
    micTestStream = null;
  }
  micTestAnalyzer = null;
}

/**
 * Load microphone options in setup wizard
 */
async function loadSetupMicOptions() {
  const micSelect = document.getElementById('setup-mic-select');
  if (!micSelect) return;

  try {
    // Request permissions first to get labeled devices
    await navigator.mediaDevices.getUserMedia({ audio: true });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    console.log('[Setup] Found microphones:', audioInputs.length);

    micSelect.innerHTML = '<option value="">Select microphone...</option>';
    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${device.deviceId.substring(0, 8)}`;
      if (device.deviceId === selectedMicId) {
        option.selected = true;
      }
      micSelect.appendChild(option);
    });

    // Handle mic selection change
    micSelect.addEventListener('change', (e) => {
      selectedMicId = e.target.value;
      saveSelectedDevices();
      updateSetupDoneButton();
      console.log('[Setup] Selected mic:', selectedMicId);
      // Start mic test with new selection
      if (selectedMicId) {
        startMicTest();
      }
    });

    // Auto-select first mic if none saved
    if (!selectedMicId && audioInputs.length > 0) {
      selectedMicId = audioInputs[0].deviceId;
      micSelect.value = selectedMicId;
      saveSelectedDevices();
    }

    updateSetupDoneButton();

    // Start mic test if a mic is already selected
    if (selectedMicId) {
      startMicTest();
    }

  } catch (error) {
    console.error('[Setup] Failed to load microphones:', error);
    micSelect.innerHTML = '<option value="">Microphone access denied</option>';
  }
}

/**
 * Update the Done button state based on whether mic is selected
 * (Windows picker handles call app selection when listening starts)
 */
function updateSetupDoneButton() {
  const nextBtn = document.getElementById('setup-next-btn');
  if (!nextBtn) return;

  const hasMic = !!selectedMicId;
  nextBtn.disabled = !hasMic;
  console.log('[Setup] Done button state:', { hasMic, disabled: nextBtn.disabled });
}

// Helper function for escaping HTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== TOGGLE & LISTENING ====================

function setupToggle() {
  console.log('[Setup] Setting up toggle button');
  const powerToggle = document.getElementById('power-toggle');
  console.log('[Setup] Power toggle element:', powerToggle);
  powerToggle?.addEventListener('click', toggleListening);
  console.log('[Setup] Toggle listener added');
}

async function toggleListening() {
  console.log('[Toggle] Clicked, isListening:', isListening);

  const powerToggle = document.getElementById('power-toggle');
  const toggleStatus = document.getElementById('toggle-status');
  const toggleHint = document.getElementById('toggle-hint');
  const listeningAnimation = document.getElementById('listening-animation');

  // If turning ON and no call app selected, show picker first
  if (!isListening && !selectedDialerSource) {
    console.log('[Toggle] No call app selected, showing picker...');
    const selected = await showCallAppPicker();
    if (!selected) {
      console.log('[Toggle] Picker cancelled, not turning on');
      return; // User cancelled, don't turn on
    }
    selectedDialerSource = selected;
    updateCallAppDisplay();
    console.log('[Toggle] Call app selected:', selected.name);
  }

  if (isListening) {
    // TURN OFF
    console.log('[Toggle] Turning OFF...');
    disconnectNudgeWebSocket();
    stopAudioCapture(); // Stop mic and system audio capture
    stopPolling(); // Stop fetching old nudges
    stopAutoTimeoutCheck(); // Stop auto-timeout checker
    isListening = false;

    // Clear any displayed nudges when turning off - fresh start for next session
    nudges = [];
    seenNudgeIds = new Set();
    currentNudge = null;
    currentSuggestionText = '';
    displayNudge(null);

    // Update UI to OFF state
    powerToggle?.classList.remove('active');
    document.getElementById('main-widget')?.classList.remove('listening');
    document.body.classList.remove('is-listening'); // Remove glow effect
    if (toggleStatus) {
      toggleStatus.classList.remove('active');
      toggleStatus.textContent = 'OFF';
    }
    if (toggleHint) toggleHint.textContent = 'Tap to start listening';
    if (listeningAnimation) listeningAnimation.style.display = 'none';

    // Hide audio warning banner when turning off
    const audioWarning = document.getElementById('audio-warning');
    if (audioWarning) audioWarning.style.display = 'none';

    // Update empty state text
    updateNudgeEmptyState();

    updateConnectionStatus('connected', 'Connected');
    console.log('[Toggle] Now OFF');
  } else {
    // TURN ON
    console.log('[Toggle] Turning ON...');
    isListening = true; // Set this first so updateNudgeEmptyState works correctly

    // Clear old nudges - start fresh for this listening session
    nudges = [];
    seenNudgeIds = new Set();
    currentNudge = null;
    currentSuggestionText = '';
    displayNudge(null);

    // Mark session start time - only show nudges created AFTER this moment
    sessionStartTime = new Date().toISOString();
    console.log('[Session] Started at:', sessionStartTime);

    // Update UI to ON state first
    powerToggle?.classList.add('active');
    document.getElementById('main-widget')?.classList.add('listening');
    document.body.classList.add('is-listening'); // For glow effect
    if (toggleStatus) {
      toggleStatus.classList.add('active');
      toggleStatus.textContent = 'ON';
    }
    if (toggleHint) toggleHint.textContent = 'Starting audio capture...';
    if (listeningAnimation) listeningAnimation.style.display = 'flex';

    // Show audio warning banner (VB-Cable captures all system audio)
    const audioWarning = document.getElementById('audio-warning');
    const warningDismissed = localStorage.getItem('callsteer_audio_warning_dismissed');
    if (audioWarning && !warningDismissed) {
      audioWarning.style.display = 'flex';
    }

    // Update empty state text
    updateNudgeEmptyState();

    // Connect to WebSocket for real-time nudges (from Dialpad)
    connectToNudgeWebSocket(clientCode);

    // Start polling for nudges (backup to WebSocket)
    startPolling();

    // Start audio capture (mic = rep, system = customer)
    try {
      await startAudioCapture();
      if (toggleHint) toggleHint.textContent = 'Listening to mic & speaker';
    } catch (error) {
      console.error('[Toggle] Audio capture failed:', error);
      if (toggleHint) toggleHint.textContent = 'WebSocket only (audio failed)';
    }

    // Start auto-timeout checker
    startAutoTimeoutCheck();

    console.log('[Toggle] Now ON');
  }
}

// ==================== AUTO-TIMEOUT FUNCTIONS ====================

/**
 * Start checking for customer audio silence
 * Only CUSTOMER audio (system stream) resets the timer - rep talking doesn't count
 * This ensures: left on at desk talking to coworker → times out
 *               on actual call with customer → stays on
 */
function startAutoTimeoutCheck() {
  stopAutoTimeoutCheck(); // Clear any existing timer

  // Initialize last customer audio time and reset warning flag
  lastCustomerAudioTime = Date.now();
  silenceWarningShown = false;

  // Check periodically for customer audio silence
  autoTimeoutTimer = setInterval(() => {
    if (!isListening) {
      stopAutoTimeoutCheck();
      return;
    }

    const timeSinceCustomerAudio = Date.now() - lastCustomerAudioTime;

    // Auto power off at 10 minutes of no customer audio
    if (timeSinceCustomerAudio >= AUTO_TIMEOUT_MS) {
      console.log('[AutoTimeout] 10 minutes without customer audio - powering off');
      showToast('Powered off — no customer audio detected. Turn back on for your next call.', 'info');

      // Trigger the toggle to turn off
      toggleListening();
    }
    // Warning at 5 minutes of no customer audio
    else if (timeSinceCustomerAudio >= SILENCE_WARNING_MS && !silenceWarningShown) {
      console.log('[AutoTimeout] 5 minutes without customer audio - showing warning');
      showToast('No customer audio detected. Still on a call?', 'warning');
      silenceWarningShown = true;
    }
  }, AUTO_TIMEOUT_CHECK_MS);

  console.log('[AutoTimeout] Started - tracking customer audio only');
}

/**
 * Stop the auto-timeout checker
 */
function stopAutoTimeoutCheck() {
  if (autoTimeoutTimer) {
    clearInterval(autoTimeoutTimer);
    autoTimeoutTimer = null;
  }
  silenceWarningShown = false;
}

/**
 * Record CUSTOMER audio activity to reset the timeout
 * Called only from system audio (customer) stream, NOT from mic (rep) stream
 */
function recordCustomerAudioActivity() {
  lastCustomerAudioTime = Date.now();
  // Reset warning flag when customer audio detected
  if (silenceWarningShown) {
    silenceWarningShown = false;
    console.log('[AutoTimeout] Customer audio detected - reset warning');
  }
}

/**
 * Update the nudge empty state text based on listening status
 */
function updateNudgeEmptyState() {
  const emptyText = document.querySelector('.nudge-empty .empty-text');
  const emptyHint = document.querySelector('.nudge-empty .empty-hint');

  if (isListening) {
    if (emptyText) emptyText.textContent = 'Listening for objections...';
    if (emptyHint) emptyHint.textContent = 'Rebuttals will appear here';
  } else {
    if (emptyText) emptyText.textContent = 'Ready to navigate';
    if (emptyHint) emptyHint.textContent = 'Turn on to get AI coaching';
  }
}

function updateToggleUI(on) {
  const powerToggle = document.getElementById('power-toggle');
  const toggleStatus = document.getElementById('toggle-status');
  const toggleHint = document.getElementById('toggle-hint');
  const listeningAnimation = document.getElementById('listening-animation');

  if (on) {
    powerToggle?.classList.add('active');
    if (toggleStatus) {
      toggleStatus.classList.add('active');
      toggleStatus.textContent = 'ON';
    }
    if (toggleHint) toggleHint.textContent = 'Waiting for calls...';
    if (listeningAnimation) listeningAnimation.style.display = 'flex';
  } else {
    powerToggle?.classList.remove('active');
    if (toggleStatus) {
      toggleStatus.classList.remove('active');
      toggleStatus.textContent = 'OFF';
    }
    if (toggleHint) toggleHint.textContent = 'Tap to start listening';
    if (listeningAnimation) listeningAnimation.style.display = 'none';
  }
}

// ==================== WEBSOCKET CONNECTION ====================

function connectToNudgeWebSocket(code) {
  if (!code) {
    console.error('[WebSocket] No client code provided');
    return;
  }

  // Include rep_id in WebSocket URL for per-device filtering
  const wsUrl = `${WS_BASE_URL}/ws/nudges/${code}?rep_id=${encodeURIComponent(repId)}`;
  console.log('[WebSocket] Connecting to:', wsUrl);

  try {
    nudgeSocket = new WebSocket(wsUrl);

    nudgeSocket.onopen = () => {
      console.log('[WebSocket] Connected! Waiting for nudges...');
      reconnectAttempts = 0;
      updateConnectionStatus('connected', 'Listening for calls');

      // Send periodic pings to keep connection alive
      startPingInterval();
    };

    nudgeSocket.onmessage = (event) => {
      console.log('[WebSocket] Received message:', event.data);

      // Ignore heartbeat messages
      if (event.data === 'pong' || event.data === 'ping') {
        return;
      }

      try {
        const nudge = JSON.parse(event.data);

        // Process the nudge
        if (nudge && nudge.nudge_id) {
          console.log('[WebSocket] New nudge received:', nudge);
          processNudges([nudge]);
        }
      } catch (e) {
        console.log('[WebSocket] Non-JSON message, ignoring:', event.data);
      }
    };

    nudgeSocket.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
      updateConnectionStatus('error', 'Connection error');
    };

    nudgeSocket.onclose = (event) => {
      console.log('[WebSocket] Disconnected, code:', event.code, 'reason:', event.reason);
      stopPingInterval();

      // Only reconnect if we're still supposed to be listening
      if (isListening && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`[WebSocket] Reconnecting in ${RECONNECT_DELAY}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        updateConnectionStatus('error', 'Reconnecting...');

        setTimeout(() => {
          if (isListening) {
            connectToNudgeWebSocket(code);
          }
        }, RECONNECT_DELAY);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[WebSocket] Max reconnect attempts reached');
        updateConnectionStatus('error', 'Connection failed');
        isListening = false;
        updateToggleUI(false);
      }
    };

  } catch (error) {
    console.error('[WebSocket] Failed to create connection:', error);
    updateConnectionStatus('error', 'Connection failed');
  }
}

function disconnectNudgeWebSocket() {
  console.log('[WebSocket] Disconnecting...');
  stopPingInterval();

  if (nudgeSocket) {
    nudgeSocket.close();
    nudgeSocket = null;
  }

  reconnectAttempts = 0;
  console.log('[WebSocket] Disconnected');
}

// Ping/pong to keep WebSocket alive
let pingInterval = null;

function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (nudgeSocket && nudgeSocket.readyState === WebSocket.OPEN) {
      nudgeSocket.send('ping');
    }
  }, 30000); // Ping every 30 seconds
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ==================== NUDGES ====================

function setupNudgeActions() {
  document.getElementById('copy-nudge-btn')?.addEventListener('click', copyCurrentNudge);
  document.getElementById('dismiss-nudge-btn')?.addEventListener('click', dismissCurrentNudge);
  document.getElementById('vote-up-btn')?.addEventListener('click', () => voteOnNudge('up'));
  document.getElementById('vote-down-btn')?.addEventListener('click', () => voteOnNudge('down'));
}

function startPolling() {
  stopPolling();
  fetchNudges();
  pollingInterval = setInterval(fetchNudges, POLL_INTERVAL);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// Track when this listening session started - only show nudges after this time
let sessionStartTime = null;

async function fetchNudges() {
  if (!clientCode || !isListening) {
    return;
  }

  try {
    // Include rep_id for per-device filtering and session start time
    let url = `${API_BASE_URL}/api/nudges?client_code=${clientCode}&rep_id=${encodeURIComponent(repId)}`;

    // Only fetch nudges created after this session started
    if (sessionStartTime) {
      url += `&after=${encodeURIComponent(sessionStartTime)}`;
    }

    const response = await fetch(url);

    if (!response.ok) throw new Error('Failed to fetch');

    const data = await response.json();

    if (data?.nudges?.length > 0) {
      processNudges(data.nudges);
    }

  } catch (error) {
    console.error('Fetch error:', error);
  }
}

function processNudges(newNudges) {
  let hasNew = false;
  let newCount = 0;

  newNudges.forEach(nudge => {
    if (nudge.nudge_id && !seenNudgeIds.has(nudge.nudge_id)) {
      seenNudgeIds.add(nudge.nudge_id);
      nudges.unshift(nudge);
      hasNew = true;
      newCount++;
    }
  });

  if (hasNew) {
    // Increment nudges received count and persist
    nudgesReceivedToday += newCount;
    saveRebuttalStats();

    // Show the newest nudge
    currentNudge = nudges[0];
    displayNudge(currentNudge);
    playNotificationSound();
    updateStats();
  }
}

function displayNudge(nudge) {
  const nudgeCard = document.getElementById('nudge-card');
  const nudgeEmpty = document.getElementById('nudge-empty');
  const nudgeType = document.getElementById('nudge-type');
  const nudgeTime = document.getElementById('nudge-time');
  const nudgeText = document.getElementById('nudge-text');
  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');

  // Reset vote buttons for new nudge
  voteUpBtn?.classList.remove('voted');
  voteDownBtn?.classList.remove('voted');

  // Clear any existing auto-dismiss timer
  if (nudgeAutoDismissTimer) {
    clearTimeout(nudgeAutoDismissTimer);
    nudgeAutoDismissTimer = null;
  }

  if (!nudge) {
    nudgeCard.style.display = 'none';
    nudgeEmpty.style.display = 'flex';
    currentSuggestionText = ''; // Clear suggestion when no nudge
    return;
  }

  nudgeEmpty.style.display = 'none';
  nudgeCard.style.display = 'block';

  // Set content
  nudgeType.textContent = (nudge.category || 'TIP').toUpperCase().replace(/_/g, ' ');
  nudgeTime.textContent = formatTimestamp(nudge.timestamp);

  // Handle two-part format: echo + suggestion
  const echo = nudge.echo || '';
  const suggestion = nudge.suggestion || 'No suggestion';

  // Store suggestion for rebuttal tracking
  currentSuggestionText = suggestion;
  repTranscriptBuffer = []; // Clear buffer when new nudge appears
  console.log('[Rebuttal] Tracking suggestion:', currentSuggestionText);

  if (echo && echo.trim()) {
    // Display echo on its own line, styled differently
    nudgeText.innerHTML = `<span class="nudge-echo">"${echo}"</span><span class="nudge-suggestion">${suggestion}</span>`;
  } else {
    // No echo, just show suggestion
    nudgeText.innerHTML = `<span class="nudge-suggestion">${suggestion}</span>`;
  }

  // Add animation
  nudgeCard.style.animation = 'none';
  nudgeCard.offsetHeight; // Trigger reflow
  nudgeCard.style.animation = 'nudgeAppear 0.4s ease-out';

  // Start 60-second auto-dismiss timer for ignored nudges
  nudgeAutoDismissTimer = setTimeout(() => {
    console.log('[Nudge] Auto-dismissing after 60 seconds (ignored)');
    // Mark as dismissed in backend
    if (currentNudge?.nudge_id) {
      sendNudgeFeedback(currentNudge.nudge_id, 'dismissed');
    }
    // Reset streak since nudge was ignored
    currentStreak = 0;
    saveRebuttalStats();
    dismissCurrentNudge();
  }, NUDGE_IGNORE_TIMEOUT_MS);
}

// ==================== NUDGE POPUP (Compact Mode) ====================

function showNudgePopup(nudge) {
  clearNudgePopup();

  const container = document.getElementById('nudge-popup-container');
  if (!container) return;

  const popup = document.createElement('div');
  popup.className = 'nudge-popup';
  popup.id = 'active-nudge-popup';

  const echo = nudge.echo || '';
  const suggestion = nudge.suggestion || 'No suggestion';
  const category = (nudge.category || 'TIP').toUpperCase().replace(/_/g, ' ');

  popup.innerHTML = `
    <div class="nudge-header">
      <span class="nudge-type">${category}</span>
      <span class="nudge-time">${formatTimestamp(nudge.timestamp)}</span>
    </div>
    <p class="nudge-text">
      ${echo && echo.trim() ? `<span class="nudge-echo">"${echo}"</span>` : ''}
      <span class="nudge-suggestion">${suggestion}</span>
    </p>
    <div class="nudge-actions">
      <button class="nudge-btn popup-copy-btn" title="Copy">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
      <button class="nudge-btn popup-dismiss-btn" title="Dismiss">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="popup-progress"></div>
  `;

  container.appendChild(popup);

  // Add event listeners
  popup.querySelector('.popup-copy-btn')?.addEventListener('click', () => {
    copyCurrentNudge();
    clearNudgePopup();
  });

  popup.querySelector('.popup-dismiss-btn')?.addEventListener('click', () => {
    clearNudgePopup();
  });

  // Click anywhere on popup to dismiss
  popup.addEventListener('click', (e) => {
    if (e.target === popup) {
      clearNudgePopup();
    }
  });

  // Auto-dismiss after 15 seconds
  popupDismissTimer = setTimeout(() => {
    clearNudgePopup();
  }, POPUP_AUTO_DISMISS_MS);
}

function clearNudgePopup() {
  if (popupDismissTimer) {
    clearTimeout(popupDismissTimer);
    popupDismissTimer = null;
  }

  const popup = document.getElementById('active-nudge-popup');
  if (popup) {
    popup.classList.add('hiding');
    setTimeout(() => {
      popup.remove();
    }, 300);
  }
}

function copyCurrentNudge() {
  if (!currentNudge?.suggestion) return;

  // Combine echo and suggestion for copying
  const echo = currentNudge.echo || '';
  const suggestion = currentNudge.suggestion || '';
  const textToCopy = echo && echo.trim()
    ? `"${echo}" ${suggestion}`
    : suggestion;

  if (window.electronAPI?.copyToClipboard) {
    window.electronAPI.copyToClipboard(textToCopy);
  } else {
    navigator.clipboard.writeText(textToCopy);
  }

  showToast('Copied!', 'success');
}

function dismissCurrentNudge() {
  const nudgeCard = document.getElementById('nudge-card');

  // If manually dismissed (not from rebuttal match), break streak
  if (currentSuggestionText && !lastRebuttalWasUsed) {
    // Nudge was dismissed without using rebuttal - break streak
    currentStreak = 0;
    saveRebuttalStats();
    updateStats();
  }

  // Reset flag for next nudge
  lastRebuttalWasUsed = false;

  // Fade out animation
  nudgeCard.style.opacity = '0';
  nudgeCard.style.transform = 'translateY(-10px)';

  setTimeout(() => {
    // Remove current nudge from list
    if (currentNudge) {
      const idx = nudges.indexOf(currentNudge);
      if (idx > -1) nudges.splice(idx, 1);
    }

    // Show next nudge or empty state
    currentNudge = nudges[0] || null;
    displayNudge(currentNudge);

    // Reset styles
    nudgeCard.style.opacity = '';
    nudgeCard.style.transform = '';
  }, 200);
}

/**
 * Vote on the current nudge (thumbs up/down)
 * Sends feedback to backend for AI learning
 */
async function voteOnNudge(vote) {
  if (!currentNudge?.nudge_id) {
    console.warn('[Vote] No current nudge to vote on');
    return;
  }

  const nudgeId = currentNudge.nudge_id;
  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');

  // Visual feedback - show which button was clicked
  if (vote === 'up') {
    voteUpBtn?.classList.add('voted');
    voteDownBtn?.classList.remove('voted');
  } else {
    voteDownBtn?.classList.add('voted');
    voteUpBtn?.classList.remove('voted');
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/nudges/${encodeURIComponent(nudgeId)}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vote: vote,
        rep_id: repId,
        customer_objection: lastCustomerTranscript || null
      })
    });

    if (response.ok) {
      const emoji = vote === 'up' ? '👍' : '👎';
      console.log(`[Vote] ${emoji} Recorded for nudge: ${nudgeId}`);
      showToast(vote === 'up' ? 'Thanks for the feedback!' : 'Noted, we\'ll improve!', 'success');
    } else {
      console.error('[Vote] Failed to record vote:', response.status);
    }
  } catch (error) {
    console.error('[Vote] Error:', error);
  }
}

// Track last customer transcript for vote context
let lastCustomerTranscript = null;

/**
 * Send feedback/status for a nudge (dismissed, copied, etc.)
 */
async function sendNudgeFeedback(nudgeId, action) {
  if (!nudgeId) return;

  console.log(`[Feedback] Sending ${action} for nudge: ${nudgeId}`);

  try {
    const response = await fetch(`${API_BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nudge_id: nudgeId,
        feedback: action,
        client_code: clientCode,
        rep_id: repId
      })
    });

    if (response.ok) {
      console.log(`[Feedback] ${action} recorded for nudge: ${nudgeId}`);
    } else {
      console.error('[Feedback] Failed:', response.status);
    }
  } catch (error) {
    console.error('[Feedback] Error:', error);
  }
}

// ==================== TABS ====================

function setupStatsTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      // Update button states
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(`tab-${tabId}`)?.classList.add('active');

      // Update stats tab when switching to it
      if (tabId === 'stats') {
        updateStatsTab();
      }
    });
  });
}

// ==================== STATS ====================

function updateStats() {
  // Calculate adoption rate: rebuttals used / nudges received today
  const adoptionRate = nudgesReceivedToday > 0
    ? Math.min(100, Math.round((rebuttalsUsedToday / nudgesReceivedToday) * 100))
    : 0;

  // Update Live tab quick stats
  const rebuttalsEl = document.getElementById('stat-rebuttals');
  const adoptionEl = document.getElementById('stat-adoption');
  const nudgesEl = document.getElementById('stat-nudges');

  if (rebuttalsEl) rebuttalsEl.textContent = rebuttalsUsedToday;
  if (adoptionEl) adoptionEl.textContent = `${adoptionRate}%`;
  if (nudgesEl) nudgesEl.textContent = nudgesReceivedToday;

  // Also update Stats tab if visible
  updateStatsTab();
}

function updateStatsTab() {
  const adoptionRate = nudgesReceivedToday > 0
    ? Math.min(100, Math.round((rebuttalsUsedToday / nudgesReceivedToday) * 100))
    : 0;

  // Update profile header
  const repNameEl = document.getElementById('stats-rep-name');
  const companyNameEl = document.getElementById('stats-company-name');

  if (repNameEl && repName) {
    repNameEl.textContent = repName;
  }
  if (companyNameEl && clientInfo?.company_name) {
    companyNameEl.textContent = clientInfo.company_name;
  }

  // Hero adoption rate
  const heroValue = document.getElementById('stats-adoption-big');
  if (heroValue) {
    const oldValue = heroValue.textContent;
    heroValue.textContent = `${adoptionRate}%`;
    // Pulse animation when value changes
    if (oldValue !== `${adoptionRate}%`) {
      heroValue.classList.add('pulse');
      setTimeout(() => heroValue.classList.remove('pulse'), 400);
    }
  }

  // Stats cards
  const usedEl = document.getElementById('stats-used-today');
  const receivedEl = document.getElementById('stats-received-today');
  const streakEl = document.getElementById('stats-streak');
  const bestEl = document.getElementById('stats-best-streak');

  if (usedEl) usedEl.textContent = rebuttalsUsedToday;
  if (receivedEl) receivedEl.textContent = nudgesReceivedToday;
  if (streakEl) streakEl.textContent = currentStreak;
  if (bestEl) bestEl.textContent = bestStreak;

  // Fire animation for streak >= 3
  const streakIcon = document.querySelector('.stats-card-icon.streak');
  if (streakIcon) {
    if (currentStreak >= 3) {
      streakIcon.classList.add('on-fire');
    } else {
      streakIcon.classList.remove('on-fire');
    }
  }

  // Update motivation message
  updateMotivationMessage(adoptionRate, currentStreak, rebuttalsUsedToday);

  // Fetch leaderboard data
  fetchLeaderboard();
}

function updateMotivationMessage(adoptionRate, streak, used) {
  const motivationEl = document.getElementById('stats-motivation');
  if (!motivationEl) return;

  let emoji = '🎯';
  let message = 'Start using rebuttals to build your streak!';

  if (used === 0) {
    emoji = '🎯';
    message = 'Use your first rebuttal to get started!';
  } else if (streak >= 5) {
    emoji = '🔥';
    message = `Incredible! ${streak} in a row - you're on fire!`;
  } else if (streak >= 3) {
    emoji = '⚡';
    message = `Nice streak of ${streak}! Keep the momentum!`;
  } else if (adoptionRate >= 80) {
    emoji = '🏆';
    message = `${adoptionRate}% adoption - elite performance!`;
  } else if (adoptionRate >= 50) {
    emoji = '💪';
    message = `${adoptionRate}% adoption - solid work!`;
  } else if (adoptionRate >= 25) {
    emoji = '📈';
    message = 'Good start! Try using more rebuttals.';
  } else if (used > 0) {
    emoji = '👍';
    message = `${used} rebuttal${used > 1 ? 's' : ''} used - keep going!`;
  }

  motivationEl.querySelector('.motivation-emoji').textContent = emoji;
  motivationEl.querySelector('.motivation-text').textContent = message;
}

// ==================== LEADERBOARD ====================

let leaderboardCache = null;
let lastLeaderboardFetch = 0;
const LEADERBOARD_CACHE_MS = 30000; // Cache for 30 seconds

async function fetchLeaderboard() {
  if (!clientCode) return;

  // Use cache if recent
  const now = Date.now();
  if (leaderboardCache && (now - lastLeaderboardFetch) < LEADERBOARD_CACHE_MS) {
    renderLeaderboard(leaderboardCache);
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/clients/${clientCode}/leaderboard?limit=5`);

    if (!response.ok) {
      console.error('[Leaderboard] Failed to fetch:', response.status);
      return;
    }

    const data = await response.json();
    leaderboardCache = data;
    lastLeaderboardFetch = now;

    renderLeaderboard(data);

  } catch (error) {
    console.error('[Leaderboard] Error:', error);
  }
}

function renderLeaderboard(data) {
  const listEl = document.getElementById('leaderboard-list');
  const rankBadge = document.getElementById('stats-rank-badge');

  if (!listEl) return;

  const leaderboard = data.leaderboard || [];

  if (leaderboard.length === 0) {
    listEl.innerHTML = '<div class="leaderboard-empty">No team data yet</div>';
    return;
  }

  // Find current user's rank
  const myEntry = leaderboard.find(entry => entry.rep_id === repId);
  const myRank = myEntry?.rank || null;

  // Update rank badge
  if (rankBadge) {
    const rankNum = rankBadge.querySelector('.rank-number');
    if (myRank) {
      rankNum.textContent = `#${myRank}`;
      if (myRank <= 3) {
        rankBadge.classList.add('top-3');
      } else {
        rankBadge.classList.remove('top-3');
      }
    } else {
      rankNum.textContent = '#-';
      rankBadge.classList.remove('top-3');
    }
  }

  // Render leaderboard items
  listEl.innerHTML = leaderboard.map(entry => {
    const isMe = entry.rep_id === repId;
    const rankDisplay = entry.rank <= 3 ? getMedalEmoji(entry.rank) : `${entry.rank}`;

    return `
      <div class="leaderboard-item ${isMe ? 'is-me' : ''}">
        <span class="leaderboard-rank">${rankDisplay}</span>
        <span class="leaderboard-name">${escapeHtml(entry.display_name)}${isMe ? ' (You)' : ''}</span>
        <div class="leaderboard-stats">
          <span class="leaderboard-stat" title="Adoption Rate">
            <span class="stat-value adoption">${entry.adoption_rate}%</span>
          </span>
          <span class="leaderboard-stat" title="Rebuttals Used / Nudges Received Today">
            <span class="stat-value used">${entry.rebuttals_used_today}/${entry.nudges_received_today}</span>
          </span>
        </div>
      </div>
    `;
  }).join('');
}

function getMedalEmoji(rank) {
  switch (rank) {
    case 1: return '🥇';
    case 2: return '🥈';
    case 3: return '🥉';
    default: return `${rank}`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== CONNECTION STATUS ====================

function updateConnectionStatus(status, text) {
  const statusEl = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  const headerStatus = document.getElementById('header-status');

  // Update footer
  if (statusEl) statusEl.className = 'footer ' + status;
  if (statusText) statusText.textContent = text;

  // Update header indicator
  if (headerStatus) {
    headerStatus.className = 'status-indicator ' + status;
  }
}

// ==================== UTILITIES ====================

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Just now';

  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'Just now';

  const diff = Date.now() - date;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString();
}

function isToday(timestamp) {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

/**
 * Check if nudge sounds are enabled
 */
function isNudgeSoundEnabled() {
  try {
    const setting = localStorage.getItem('callsteer_nudge_sound');
    // Default to ON if not set
    return setting !== 'off';
  } catch (e) {
    return true;
  }
}

/**
 * Play subtle notification sound when a new nudge appears
 * Uses Web Audio API for a clean, pleasant synthesized tone
 */
function playNotificationSound() {
  // Check if sounds are enabled
  if (!isNudgeSoundEnabled()) {
    console.log('[Audio] Nudge sound disabled, skipping');
    return;
  }

  try {
    // Use Web Audio API for a clean, pleasant synthesized notification
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Create a soft "pop" notification sound (like Slack or iMessage)
    const playTone = (frequency, startTime, duration, volume = 0.12) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Triangle wave for a softer tone
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, startTime);

      // Gentle envelope - soft attack, quick decay
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.015); // Very quick fade in
      gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration); // Smooth fade out

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };

    const now = audioContext.currentTime;

    // Soft ascending "pop" - E5 to A5 (pleasant major third interval)
    playTone(659, now, 0.12, 0.1);         // E5 - first note
    playTone(880, now + 0.05, 0.15, 0.12); // A5 - second note

    console.log('[Audio] Played nudge notification sound');
  } catch (e) {
    console.log('[Audio] Notification sound failed:', e);
  }
}

// ==================== CALL APP PICKER ====================

// Known call app patterns for categorization
// These patterns are designed to match NATIVE apps, not browser tabs
// Browser tabs are detected separately by checking for browser suffix
const CALL_APP_PATTERNS = [
  // VoIP/Calling apps - match native app windows
  { pattern: /^Zoom/i, name: 'Zoom', icon: 'zoom' },                    // "Zoom Meeting" etc
  { pattern: /^Microsoft Teams/i, name: 'Teams', icon: 'teams' },       // Native Teams app
  { pattern: /^Dialpad/i, name: 'Dialpad', icon: 'dialpad' },           // Native Dialpad
  { pattern: /^Webex/i, name: 'Webex', icon: 'webex' },                 // Native Webex
  { pattern: /^Slack/i, name: 'Slack', icon: 'slack' },                 // Native Slack
  { pattern: /^Discord/i, name: 'Discord', icon: 'discord' },           // Native Discord
  { pattern: /^RingCentral/i, name: 'RingCentral', icon: 'ringcentral' },
  { pattern: /^Aircall/i, name: 'Aircall', icon: 'aircall' },
  // Note: Google Meet is browser-only, will show in Browser Tabs section
];

// Windows system windows to filter out (not useful for call capture)
const SYSTEM_WINDOW_FILTERS = [
  /^Default IME$/i,
  /^MSCTFIME/i,
  /^Microsoft Text Input/i,
  /^Program Manager$/i,
  /^Settings$/i,
  /^Windows Input Experience/i,
  /^Task Switching$/i,
  /^Start$/i,
  /^Search$/i,
  /^Cortana$/i,
  /^Action Center$/i,
  /^Notification/i,
  /^SystemSettings/i,
  /^ShellExperienceHost/i,
  /^LockApp/i,
  /^Windows Security/i,
  /^Setup$/i,
  /^Input Indicator/i,
  /^IME$/i,
  /^Desktop$/i,
  /^$/ // Empty names
];

/**
 * Check if a window name is a system window that should be filtered out
 */
function isSystemWindow(name) {
  if (!name || name.trim() === '') return true;
  return SYSTEM_WINDOW_FILTERS.some(filter => filter.test(name));
}

/**
 * Detect if a window is a known call app
 */
function detectCallApp(windowName) {
  for (const app of CALL_APP_PATTERNS) {
    if (app.pattern.test(windowName)) {
      return app;
    }
  }
  return null;
}

/**
 * Show the call app picker and return selected source
 * Returns: { id: string, name: string } or null if cancelled
 */
async function showCallAppPicker() {
  const picker = document.getElementById('call-app-picker');
  const callAppsGrid = document.getElementById('picker-call-apps-grid');
  const otherGrid = document.getElementById('picker-other-grid');
  const callAppsSection = document.getElementById('picker-call-apps');
  const otherSection = document.getElementById('picker-other-windows');

  if (!picker) return null;

  // Get desktop sources from Electron
  let sources = [];
  if (window.electronAPI?.getDesktopSources) {
    sources = await window.electronAPI.getDesktopSources();

    // Log RAW sources for debugging
    console.log('[Picker] ═══════════════════════════════════════════════════');
    console.log('[Picker] RAW desktopCapturer.getSources() output:');
    console.log('[Picker] Total sources:', sources.length);
    sources.forEach((s, i) => {
      console.log(`[Picker]   ${i}: id="${s.id}" name="${s.name}" display_id="${s.display_id || 'N/A'}"`);
    });
    console.log('[Picker] ═══════════════════════════════════════════════════');
  }

  // Categorize sources into: Call Apps, Browser Tabs, Other Windows, Screens
  const callApps = [];
  const browserTabs = [];
  const otherWindows = [];
  const screens = [];

  // Browser patterns for detecting browser windows/tabs
  const browserPatterns = [
    { pattern: /^.+ - Google Chrome$/i, browser: 'Chrome' },
    { pattern: /^.+ - Chrome$/i, browser: 'Chrome' },
    { pattern: /^.+ - Mozilla Firefox$/i, browser: 'Firefox' },
    { pattern: /^.+ - Firefox$/i, browser: 'Firefox' },
    { pattern: /^.+ - Microsoft Edge$/i, browser: 'Edge' },
    { pattern: /^.+ - Edge$/i, browser: 'Edge' },
    { pattern: /^.+ - Brave$/i, browser: 'Brave' },
    { pattern: /^.+ - Opera$/i, browser: 'Opera' },
    { pattern: /^.+ - Safari$/i, browser: 'Safari' }
  ];

  for (const source of sources) {
    // Handle screens separately
    if (source.id.startsWith('screen:')) {
      screens.push(source);
      continue;
    }

    // Skip system windows (Default IME, MSCTFIME, etc.)
    if (isSystemWindow(source.name)) {
      console.log('[Picker] Filtered out system window:', source.name);
      continue;
    }

    // IMPORTANT: Check for browser FIRST before call apps
    // This prevents "Zoom Meeting - Google Chrome" from being categorized as Zoom
    let isBrowser = false;
    for (const bp of browserPatterns) {
      if (bp.pattern.test(source.name)) {
        // Extract the tab title (everything before " - Browser")
        const tabTitle = source.name.replace(/ - (Google Chrome|Chrome|Mozilla Firefox|Firefox|Microsoft Edge|Edge|Brave|Opera|Safari)$/i, '');
        browserTabs.push({ ...source, tabTitle, browser: bp.browser });
        isBrowser = true;
        break;
      }
    }
    if (isBrowser) continue;

    // Check if it's a known NATIVE call app (not browser-based)
    const detected = detectCallApp(source.name);
    if (detected) {
      callApps.push({ ...source, detectedApp: detected });
      continue;
    }

    // Everything else goes to Other Windows
    otherWindows.push(source);
  }

  console.log('[Picker] Categorized:');
  console.log('[Picker]   Call apps:', callApps.length, callApps.map(s => s.name));
  console.log('[Picker]   Browser tabs:', browserTabs.length, browserTabs.map(s => s.tabTitle));
  console.log('[Picker]   Other windows:', otherWindows.length, otherWindows.map(s => s.name));
  console.log('[Picker]   Screens:', screens.length);

  // Build call apps grid - prioritize app icon, then thumbnail, then fallback SVG
  if (callApps.length > 0) {
    callAppsSection.style.display = 'block';
    callAppsGrid.innerHTML = callApps.map(source => {
      // Prefer app icon over thumbnail for cleaner look
      const iconHtml = source.appIcon
        ? `<img src="${source.appIcon}" alt="${source.detectedApp.name}" class="app-icon">`
        : (source.thumbnail
          ? `<img src="${source.thumbnail}" alt="${source.detectedApp.name}">`
          : `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/>
            </svg>`);
      return `
        <div class="picker-item" data-source-id="${source.id}" data-source-name="${escapeHtml(source.name)}">
          <div class="picker-item-icon">${iconHtml}</div>
          <span class="picker-item-name">${source.detectedApp.name}</span>
          <span class="picker-item-hint">${escapeHtml(source.name)}</span>
        </div>
      `;
    }).join('');
  } else {
    callAppsSection.style.display = 'none';
  }

  // Build "Browser Tabs & Other Windows" grid
  const allOtherWindows = [...browserTabs, ...otherWindows];
  if (allOtherWindows.length > 0) {
    otherSection.style.display = 'block';
    // Show up to 8 windows
    otherGrid.innerHTML = allOtherWindows.slice(0, 8).map(source => {
      const displayName = source.tabTitle || source.name;
      const truncatedName = displayName.length > 40 ? displayName.substring(0, 37) + '...' : displayName;
      // Prefer app icon (cleaner) over thumbnail
      const iconHtml = source.appIcon
        ? `<img src="${source.appIcon}" alt="" class="app-icon">`
        : (source.thumbnail
          ? `<img src="${source.thumbnail}" alt="">`
          : `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18"/>
            </svg>`);
      return `
        <div class="picker-item" data-source-id="${source.id}" data-source-name="${escapeHtml(source.name)}">
          <div class="picker-item-icon">${iconHtml}</div>
          <span class="picker-item-name">${escapeHtml(truncatedName)}</span>
          ${source.browser ? `<span class="picker-item-hint">${source.browser}</span>` : ''}
        </div>
      `;
    }).join('');
  } else {
    otherSection.style.display = 'none';
  }

  // Show picker
  picker.style.display = 'flex';

  // Return a promise that resolves when user selects
  return new Promise((resolve) => {
    pickerResolve = resolve;

    // Handle item clicks
    const handleItemClick = (e) => {
      const item = e.target.closest('.picker-item');
      if (!item) return;

      const sourceId = item.dataset.sourceId;
      const sourceName = item.dataset.sourceName;

      picker.style.display = 'none';
      picker.removeEventListener('click', handleItemClick);
      pickerResolve = null;

      resolve({ id: sourceId, name: sourceName });
    };

    picker.addEventListener('click', handleItemClick);
  });
}

/**
 * Escape HTML to prevent XSS in picker
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Hide the call app picker (cancel)
 */
function hideCallAppPicker() {
  const picker = document.getElementById('call-app-picker');
  if (picker) {
    picker.style.display = 'none';
  }
  if (pickerResolve) {
    pickerResolve(null);
    pickerResolve = null;
  }
}

/**
 * Update the call app display in the main widget
 */
function updateCallAppDisplay() {
  const display = document.getElementById('call-app-display');
  if (display) {
    if (selectedDialerSource) {
      display.textContent = selectedDialerSource.name;
      display.style.color = '';
    } else {
      display.textContent = 'Not selected';
      display.style.color = 'var(--text-muted)';
    }
  }
}

function showToast(message, type = 'success') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ==================== REBUTTAL TRACKING ====================

/**
 * Fuzzy match rep speech against the current suggestion
 * Returns similarity score 0-1 based on word overlap
 */
function calculateSimilarity(repSpeech, suggestion) {
  if (!repSpeech || !suggestion) return 0;

  // Normalize: lowercase, remove punctuation, split into words
  // Keep words with 2+ chars to catch important short words like "no", "we", "ok"
  const normalize = (text) => text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length >= 2);

  const repWords = normalize(repSpeech);
  const suggestionWords = normalize(suggestion);

  if (suggestionWords.length === 0) return 0;

  // Count how many suggestion words appear in rep speech
  let matchCount = 0;
  for (const sugWord of suggestionWords) {
    // Check for exact match, substring, or stem match (first 4 chars)
    const stem = sugWord.slice(0, 4);
    const found = repWords.some(repWord =>
      repWord === sugWord ||
      repWord.includes(sugWord) ||
      sugWord.includes(repWord) ||
      (stem.length >= 4 && repWord.startsWith(stem)) // Stem matching for conjugations
    );
    if (found) matchCount++;
  }

  const similarity = matchCount / suggestionWords.length;
  // Only log if there's a meaningful match to reduce noise
  if (similarity >= 0.2) {
    console.log(`[Rebuttal] Match: ${(similarity * 100).toFixed(0)}% (${matchCount}/${suggestionWords.length} words)`);
  }
  return similarity;
}

/**
 * Add transcript chunk to rolling buffer and check for rebuttal match
 */
function checkRebuttalMatch(repTranscript) {
  if (!repTranscript) return;

  const now = Date.now();

  // Add to buffer
  repTranscriptBuffer.push({ text: repTranscript, timestamp: now });

  // Prune old entries (older than 30 seconds)
  repTranscriptBuffer = repTranscriptBuffer.filter(
    chunk => (now - chunk.timestamp) < TRANSCRIPT_BUFFER_WINDOW_MS
  );

  if (!currentSuggestionText) return;

  // Build combined transcript from buffer (last 30 seconds of speech)
  const combinedTranscript = repTranscriptBuffer.map(c => c.text).join(' ');

  // Check similarity against the full accumulated speech
  const similarity = calculateSimilarity(combinedTranscript, currentSuggestionText);

  // Also check just this chunk in case it's a perfect match
  const chunkSimilarity = calculateSimilarity(repTranscript, currentSuggestionText);

  if (similarity >= REBUTTAL_MATCH_THRESHOLD || chunkSimilarity >= REBUTTAL_MATCH_THRESHOLD) {
    const matchType = chunkSimilarity >= REBUTTAL_MATCH_THRESHOLD ? 'chunk' : 'accumulated';
    console.log(`[Rebuttal] ✅ MATCH DETECTED (${matchType})! Rep used the rebuttal.`);
    onRebuttalUsed();
    // Clear buffer after successful match to prevent double-counting
    repTranscriptBuffer = [];
  }
}

/**
 * Called when rep successfully uses a rebuttal
 * NOTE: Does NOT auto-dismiss - rep can keep reading the full suggestion
 */
function onRebuttalUsed() {
  // Clear the auto-dismiss timer since nudge was adopted
  if (nudgeAutoDismissTimer) {
    clearTimeout(nudgeAutoDismissTimer);
    nudgeAutoDismissTimer = null;
  }

  // Increment counters
  rebuttalsUsedToday++;
  rebuttalsUsedTotal++;

  // Update streak
  currentStreak++;
  if (currentStreak > bestStreak) {
    bestStreak = currentStreak;
  }
  lastRebuttalWasUsed = true;

  // Save to localStorage
  saveRebuttalStats();

  // Sync adoption to backend for accurate leaderboard stats
  syncAdoptionToBackend();

  // Show success animation on nudge card (but DON'T dismiss)
  showRebuttalSuccess();

  // Play success sound
  playSuccessSound();

  // Update stats display
  updateStats();

  // DO NOT auto-dismiss - let rep finish reading the full suggestion
  // They can manually dismiss when ready, or it stays until next nudge

  // Clear current suggestion to prevent re-matching same nudge
  currentSuggestionText = '';
}

/**
 * Sync adoption to backend so leaderboard stats are accurate
 */
async function syncAdoptionToBackend() {
  if (!currentNudge?.nudge_id) {
    console.log('[Adoption] No current nudge to sync');
    return;
  }

  const nudgeId = currentNudge.nudge_id;
  console.log('[Adoption] Syncing to backend:', nudgeId);

  try {
    const response = await fetch(`${API_BASE_URL}/api/nudges/${encodeURIComponent(nudgeId)}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      console.error('[Adoption] Backend sync failed:', response.status);
      return;
    }

    const data = await response.json();
    console.log('[Adoption] Backend sync success:', data.status);

    // Invalidate leaderboard cache so next fetch gets fresh data
    lastLeaderboardFetch = 0;

  } catch (error) {
    console.error('[Adoption] Failed to sync:', error);
    // Don't break the user experience - local stats are still tracked
  }
}

/**
 * Show checkmark animation on nudge card
 * Checkmark appears in corner, doesn't block text
 * Auto-dismisses after delay so rep can finish reading
 */
function showRebuttalSuccess() {
  const nudgeCard = document.getElementById('nudge-card');
  if (!nudgeCard) return;

  // Add success class for green border glow
  nudgeCard.classList.add('rebuttal-success');

  // Create small checkmark badge in top-right corner (doesn't block text)
  const checkmark = document.createElement('div');
  checkmark.className = 'rebuttal-checkmark-badge';
  checkmark.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="10" fill="#00C8D4"/>
      <path fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 12l3 3 7-7"/>
    </svg>
  `;
  nudgeCard.appendChild(checkmark);

  // After 2 seconds, fade out checkmark and auto-dismiss nudge
  setTimeout(() => {
    checkmark.classList.add('fade-out');
    setTimeout(() => {
      checkmark.remove();
      nudgeCard.classList.remove('rebuttal-success');
      // Auto-dismiss the nudge after rep has had time to finish reading
      dismissCurrentNudge();
    }, 300);
  }, 2000); // 2 second delay before clearing
}

/**
 * Play subtle success sound - pleasant two-tone chime
 */
function playSuccessSound() {
  // Check if sounds are enabled
  if (!isNudgeSoundEnabled()) {
    console.log('[Audio] Nudge sound disabled, skipping success sound');
    return;
  }

  try {
    // Use Web Audio API for a clean, pleasant synthesized chime
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Create a pleasant two-note chime (like a gentle "ding-ding")
    const playTone = (frequency, startTime, duration) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Sine wave for a soft, pure tone
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startTime);

      // Gentle envelope - fade in quickly, sustain, fade out smoothly
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.02); // Quick fade in
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration); // Smooth fade out

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };

    const now = audioContext.currentTime;

    // Two ascending notes - G5 and C6 (pleasant interval)
    playTone(784, now, 0.15);        // G5 - first note
    playTone(1047, now + 0.08, 0.2); // C6 - second note (slightly delayed)

  } catch (e) {
    console.log('[Audio] Success sound failed:', e);
  }
}

/**
 * Get storage key for rebuttal stats (per-rep isolation)
 */
function getRebuttalStatsKey() {
  // Use repId for per-rep stats isolation on shared computers
  return repId ? `callsteer_rebuttal_stats_${repId}` : 'callsteer_rebuttal_stats';
}

/**
 * Save rebuttal stats to localStorage (per-rep)
 */
function saveRebuttalStats() {
  try {
    const today = new Date().toDateString();
    const storageKey = getRebuttalStatsKey();
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');

    // Reset daily counts if it's a new day
    if (stored.date !== today) {
      stored.date = today;
      stored.todayCount = 0;
      stored.nudgesToday = 0;
      // Don't reset streak on new day - keep it going
    }

    stored.todayCount = rebuttalsUsedToday;
    stored.nudgesToday = nudgesReceivedToday;
    stored.totalCount = rebuttalsUsedTotal;
    stored.currentStreak = currentStreak;
    stored.bestStreak = Math.max(stored.bestStreak || 0, bestStreak);

    localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch (e) {
    console.error('[Rebuttal] Failed to save stats:', e);
  }
}

/**
 * Load rebuttal stats from localStorage (per-rep)
 */
function loadRebuttalStats() {
  try {
    const today = new Date().toDateString();
    const storageKey = getRebuttalStatsKey();
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');

    // Reset daily counts if it's a new day
    if (stored.date === today) {
      rebuttalsUsedToday = stored.todayCount || 0;
      nudgesReceivedToday = stored.nudgesToday || 0;
    } else {
      rebuttalsUsedToday = 0;
      nudgesReceivedToday = 0;
    }

    rebuttalsUsedTotal = stored.totalCount || 0;
    currentStreak = stored.currentStreak || 0;
    bestStreak = stored.bestStreak || 0;

    console.log('[Stats] Loaded stats for', repId, ':', {
      rebuttalsToday: rebuttalsUsedToday,
      nudgesToday: nudgesReceivedToday,
      total: rebuttalsUsedTotal,
      streak: currentStreak,
      best: bestStreak
    });
  } catch (e) {
    console.error('[Stats] Failed to load stats:', e);
  }
}

// ==================== AUDIO CAPTURE (MIC + SYSTEM) ====================

/**
 * Start capturing both mic (rep) and system audio (customer)
 * Streams both to Deepgram for real-time transcription
 */
async function startAudioCapture() {
  if (isCapturingAudio) {
    console.log('[Audio] Already capturing');
    return;
  }

  console.log('[Audio] Starting dual audio capture...');

  try {
    // 1. Capture microphone (rep voice)
    await startMicCapture();

    // 2. Capture system audio (customer voice via loopback)
    await startSystemAudioCapture();

    isCapturingAudio = true;
    console.log('[Audio] Dual audio capture started');
    updateConnectionStatus('connected', 'Listening (mic + speaker)');

  } catch (error) {
    console.error('[Audio] Failed to start capture:', error);
    stopAudioCapture();
    throw error;
  }
}

/**
 * Stop all audio capture
 */
function stopAudioCapture() {
  console.log('[Audio] Stopping audio capture...');

  // Reset call ID for next session (affects debouncing)
  if (typeof resetCallId === 'function') {
    resetCallId();
  }

  // Stop mic
  if (micMediaRecorder && micMediaRecorder.state !== 'inactive') {
    micMediaRecorder.stop();
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (deepgramMicSocket) {
    deepgramMicSocket.close();
    deepgramMicSocket = null;
  }

  // Stop system audio - MUTE instead of close if persistent stream exists
  // This allows the stream to be reused without showing the picker again
  if (systemMediaRecorder && systemMediaRecorder.state !== 'inactive') {
    systemMediaRecorder.stop();
  }
  if (persistentSystemStream) {
    // MUTE the persistent stream instead of stopping it
    const tracks = persistentSystemStream.getAudioTracks();
    tracks.forEach(track => {
      track.enabled = false;
      console.log('[Audio] System audio track MUTED (not stopped):', track.label);
    });
    systemStreamMuted = true;
    systemAudioStream = null; // Clear reference but keep persistent stream
    console.log('[Audio] Persistent system stream muted - will reuse on next toggle');
  } else if (systemAudioStream) {
    // No persistent stream, just stop it
    systemAudioStream.getTracks().forEach(track => track.stop());
    systemAudioStream = null;
  }
  if (deepgramSystemSocket) {
    deepgramSystemSocket.close();
    deepgramSystemSocket = null;
  }

  // Clear window capture handler
  if (window.electronAPI?.clearWindowCapture) {
    window.electronAPI.clearWindowCapture().catch(() => {});
  }

  isCapturingAudio = false;
  console.log('[Audio] Audio capture stopped');
}

// ==================== MICROPHONE CAPTURE (REP VOICE) ====================

async function startMicCapture() {
  console.log('[Mic] Requesting microphone access...');

  try {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000
      }
    };

    // Use selected mic if available
    if (selectedMicId) {
      constraints.audio.deviceId = { exact: selectedMicId };
      console.log('[Mic] Using selected device:', selectedMicId);
    }

    micStream = await navigator.mediaDevices.getUserMedia(constraints);

    console.log('[Mic] Microphone access granted');

    // Connect to Deepgram for mic transcription
    connectDeepgramMic();

  } catch (error) {
    console.error('[Mic] Failed to get microphone:', error);
    throw error;
  }
}

function connectDeepgramMic() {
  if (!DEEPGRAM_API_KEY) {
    console.warn('[Mic] No Deepgram API key - mic transcription disabled');
    return;
  }

  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'en-US',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300'
  });

  const wsUrl = `${DEEPGRAM_WS_URL}?${params.toString()}`;
  console.log('[Mic] Connecting to Deepgram...');

  deepgramMicSocket = new WebSocket(wsUrl, ['token', DEEPGRAM_API_KEY]);

  deepgramMicSocket.onopen = () => {
    console.log('[Mic] Deepgram connected - starting MediaRecorder');
    startMicRecording();
  };

  deepgramMicSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript;
        const isFinal = data.is_final;

        if (transcript.trim()) {
          // Note: Rep audio does NOT reset auto-timeout - only customer audio does
          // This ensures listening auto-powers off if left on without a customer on the line

          console.log(`[Mic/REP] ${isFinal ? 'FINAL' : 'interim'}: ${transcript}`);

          // Check if rep used the suggested rebuttal (fuzzy match)
          if (isFinal && transcript.length > 5) {
            checkRebuttalMatch(transcript);
            sendTranscriptToBackend(transcript, 'rep');
          }
        }
      }
    } catch (e) {
      console.error('[Mic] Failed to parse Deepgram response:', e);
    }
  };

  deepgramMicSocket.onerror = (error) => {
    console.error('[Mic] Deepgram WebSocket error:', error);
  };

  deepgramMicSocket.onclose = (event) => {
    console.log('[Mic] Deepgram disconnected:', event.code, event.reason);
  };
}

function startMicRecording() {
  if (!micStream || !deepgramMicSocket) return;

  try {
    micMediaRecorder = new MediaRecorder(micStream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    micMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && deepgramMicSocket?.readyState === WebSocket.OPEN) {
        deepgramMicSocket.send(event.data);
      }
    };

    micMediaRecorder.start(250); // Send chunks every 250ms
    console.log('[Mic] MediaRecorder started');

  } catch (error) {
    console.error('[Mic] Failed to start MediaRecorder:', error);
  }
}

// ==================== SYSTEM AUDIO CAPTURE (CUSTOMER VOICE) ====================
// Priority order:
// 1. VB-Cable (most reliable on Windows)
// 2. Direct WASAPI loopback via electron-audio-loopback
// 3. getDisplayMedia fallback (requires screen picker)

// ==================== VB-CABLE DETECTION & CAPTURE ====================

// Detect VB-Cable virtual audio device
async function detectVBCable() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('[VB-Cable] Checking', devices.length, 'audio devices...');

    const vbCable = devices.find(d =>
      d.kind === 'audioinput' &&
      (d.label.toLowerCase().includes('cable output') ||
       d.label.toLowerCase().includes('vb-audio') ||
       d.label.toLowerCase().includes('virtual cable'))
    );

    if (vbCable) {
      console.log('[VB-Cable] Found:', vbCable.label, vbCable.deviceId);
    } else {
      console.log('[VB-Cable] Not found. Available inputs:',
        devices.filter(d => d.kind === 'audioinput').map(d => d.label).join(', '));
    }

    return vbCable || null;
  } catch (e) {
    console.error('[VB-Cable] Detection error:', e);
    return null;
  }
}

// Capture audio from VB-Cable device
async function captureVBCable(deviceId) {
  console.log('[VB-Cable] Capturing from device:', deviceId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  console.log('[VB-Cable] Capture successful, tracks:', stream.getAudioTracks().length);
  return stream;
}

// VB-Cable test state
let vbCableTestStream = null;
let vbCableTestAnalyser = null;
let vbCableTestAnimationId = null;
let vbCableAudioDetected = false;
let vbCableNoAudioTimeout = null;

// Show VB-Cable setup modal (Step 1: Installation)
function showVBCableSetupModal() {
  // Remove existing modal if any
  const existingModal = document.getElementById('vbcable-modal');
  if (existingModal) existingModal.remove();
  cleanupVBCableTest();

  const modal = document.createElement('div');
  modal.id = 'vbcable-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content vbcable-setup">
      <div class="modal-header">
        <h3>🎧 Customer Audio Setup</h3>
        <span class="modal-step-indicator">Step 1 of 2</span>
        <button class="modal-close" onclick="closeVBCableModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="setup-requirement-notice">
          <span class="requirement-icon">⚠️</span>
          <p>To capture <strong>customer audio</strong> from your dialer, VB-Cable is required (free, one-time setup)</p>
        </div>

        <p class="setup-time-notice">
          ⏱️ This is a <strong>one-time 2-minute setup</strong>. After this, CallSteer will work automatically.
        </p>

        <div class="audio-routing-explainer">
          <div class="routing-item">
            <span class="routing-icon">🎤</span>
            <div class="routing-text">
              <strong>Your Microphone</strong> → captures YOUR voice (the rep)
            </div>
          </div>
          <div class="routing-item">
            <span class="routing-icon">🔊</span>
            <div class="routing-text">
              <strong>VB-Cable</strong> → captures CUSTOMER voice from dialer
            </div>
          </div>
        </div>

        <div class="setup-steps">
          <div class="step">
            <span class="step-num">1</span>
            <span>Download & install VB-Cable from vb-audio.com (free)</span>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <span>Restart your computer after installation</span>
          </div>
          <div class="step">
            <span class="step-num">3</span>
            <span>In your <strong>dialer's SPEAKER settings</strong>, select <strong>"CABLE Input (VB-Audio)"</strong></span>
          </div>
        </div>

        <div class="setup-diagram">
          <div class="diagram-section">
            <div class="diagram-label">Customer Audio Flow:</div>
            <div class="diagram-flow">
              <span class="diagram-box">Dialer Speaker</span>
              <span class="diagram-arrow">→</span>
              <span class="diagram-box highlight">CABLE Input</span>
              <span class="diagram-arrow">→</span>
              <span class="diagram-box highlight">CABLE Output</span>
              <span class="diagram-arrow">→</span>
              <span class="diagram-box accent">CallSteer</span>
            </div>
          </div>
        </div>

        <div class="setup-important-note">
          <strong>⚠️ Important:</strong>
          <ul>
            <li>Do NOT change your microphone settings</li>
            <li>Only change your dialer's <strong>speaker/output</strong> device</li>
            <li>You'll still hear the customer in your headphones</li>
          </ul>
        </div>

        <div class="dialer-examples">
          <div class="dialer-examples-label">Quick Setup for Common Dialers:</div>
          <div class="dialer-list">
            <span class="dialer-item"><strong>Zoom:</strong> Settings → Audio → Speaker</span>
            <span class="dialer-item"><strong>Dialpad:</strong> Settings → Audio → Output</span>
            <span class="dialer-item"><strong>Google Meet:</strong> Settings → Audio → Speaker</span>
            <span class="dialer-item"><strong>Teams:</strong> Settings → Devices → Speaker</span>
          </div>
        </div>

        <div class="chrome-extension-alternative">
          <div class="alternative-divider">
            <span>OR</span>
          </div>
          <div class="alternative-content">
            <span class="alternative-icon">✨</span>
            <div class="alternative-text">
              <strong>Want zero setup?</strong>
              <p>Try our Chrome extension instead - works instantly with web-based dialers!</p>
            </div>
            <button class="btn-chrome" onclick="openChromeExtension()">Use Chrome Extension</button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeVBCableModal()">Cancel</button>
        <button class="btn-secondary" onclick="recheckVBCable()">I've Installed It</button>
        <button class="btn-primary" onclick="downloadVBCable()">Download VB-Cable</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Add styles if not already present
  if (!document.getElementById('vbcable-modal-styles')) {
    const styles = document.createElement('style');
    styles.id = 'vbcable-modal-styles';
    styles.textContent = `
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        backdrop-filter: blur(4px);
      }
      .modal-content.vbcable-setup {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid rgba(0, 199, 190, 0.3);
        border-radius: 12px;
        width: 90%;
        max-width: 420px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
      }
      .modal-header h3 {
        margin: 0;
        font-size: 16px;
        color: #fff;
      }
      .modal-close {
        background: none;
        border: none;
        color: #888;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .modal-close:hover { color: #fff; }
      .modal-body {
        padding: 20px;
        color: #ccc;
        font-size: 13px;
        line-height: 1.5;
        overflow-y: auto;
        flex: 1;
      }
      .modal-footer {
        padding: 16px 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        flex-shrink: 0;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      }
      .setup-steps {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 12px;
        margin: 12px 0;
      }
      .step {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      .step:last-child { border-bottom: none; }
      .step-num {
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        color: #fff;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: bold;
        flex-shrink: 0;
      }
      .setup-diagram {
        background: rgba(0, 199, 190, 0.1);
        border: 1px solid rgba(0, 199, 190, 0.2);
        border-radius: 8px;
        padding: 16px;
        margin-top: 16px;
      }
      .diagram-flow {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .diagram-box {
        background: rgba(0, 0, 0, 0.4);
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
      }
      .diagram-box.highlight {
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        color: #fff;
      }
      .diagram-arrow {
        color: #00c7be;
        font-size: 16px;
      }
      .modal-footer {
        display: flex;
        gap: 8px;
        padding: 16px 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        justify-content: flex-end;
      }
      .modal-footer button {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-primary {
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        border: none;
        color: #fff;
      }
      .btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 199, 190, 0.4);
      }
      .btn-secondary {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #ccc;
      }
      .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
      .modal-step-indicator {
        font-size: 11px;
        color: var(--nav-teal, #00c7be);
        background: rgba(0, 199, 190, 0.15);
        padding: 3px 8px;
        border-radius: 10px;
        margin-left: auto;
        margin-right: 12px;
      }
      /* Audio test styles */
      .audio-test-section {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 16px;
        margin: 16px 0;
        text-align: center;
      }
      .audio-meter-container {
        background: rgba(0, 0, 0, 0.4);
        border-radius: 6px;
        height: 24px;
        overflow: hidden;
        margin: 12px 0;
        position: relative;
      }
      .audio-meter-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #00c7be, #4a90d9, #34c759);
        transition: width 0.05s ease-out;
        border-radius: 6px;
      }
      .audio-meter-label {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 10px;
        color: rgba(255, 255, 255, 0.6);
        z-index: 1;
      }
      .audio-test-status {
        font-size: 12px;
        margin-top: 8px;
        min-height: 18px;
      }
      .audio-test-status.success {
        color: #34c759;
      }
      .audio-test-status.warning {
        color: #ff9f0a;
      }
      .audio-test-status.error {
        color: #ff453a;
      }
      .audio-test-hint {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        margin-top: 8px;
      }
      .detected-device {
        background: rgba(0, 199, 190, 0.15);
        border: 1px solid rgba(0, 199, 190, 0.3);
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .detected-device-icon {
        color: #00c7be;
        font-size: 18px;
      }
      .detected-device-info {
        flex: 1;
        text-align: left;
      }
      .detected-device-label {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
      }
      .detected-device-name {
        font-size: 12px;
        color: #fff;
      }
      /* Requirement and time notices */
      .setup-requirement-notice {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(255, 159, 10, 0.15);
        border: 1px solid rgba(255, 159, 10, 0.3);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .setup-requirement-notice .requirement-icon {
        font-size: 20px;
      }
      .setup-requirement-notice p {
        margin: 0;
        font-size: 13px;
        color: #fff;
      }
      .setup-time-notice {
        font-size: 12px;
        color: #34c759;
        margin-bottom: 12px;
        padding: 8px 12px;
        background: rgba(52, 199, 89, 0.1);
        border-radius: 6px;
      }
      /* Chrome extension alternative */
      .chrome-extension-alternative {
        margin-top: 16px;
        padding-top: 8px;
      }
      .alternative-divider {
        display: flex;
        align-items: center;
        margin-bottom: 12px;
      }
      .alternative-divider::before,
      .alternative-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: rgba(255, 255, 255, 0.15);
      }
      .alternative-divider span {
        padding: 0 12px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      .alternative-content {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(66, 133, 244, 0.1);
        border: 1px solid rgba(66, 133, 244, 0.3);
        border-radius: 8px;
        padding: 12px;
      }
      .alternative-icon {
        font-size: 24px;
      }
      .alternative-text {
        flex: 1;
      }
      .alternative-text strong {
        display: block;
        color: #fff;
        font-size: 13px;
        margin-bottom: 2px;
      }
      .alternative-text p {
        margin: 0;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.6);
      }
      .btn-chrome {
        background: linear-gradient(135deg, #4285f4, #34a853);
        border: none;
        color: #fff;
        padding: 8px 14px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.2s;
      }
      .btn-chrome:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(66, 133, 244, 0.4);
      }
      /* Audio routing explainer */
      .audio-routing-explainer {
        background: rgba(0, 199, 190, 0.08);
        border: 1px solid rgba(0, 199, 190, 0.2);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .routing-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }
      .routing-item:first-child {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding-bottom: 8px;
        margin-bottom: 4px;
      }
      .routing-icon {
        font-size: 18px;
      }
      .routing-text {
        font-size: 12px;
        color: #fff;
      }
      .routing-text strong {
        color: var(--nav-teal, #00c7be);
      }
      /* Important note box */
      .setup-important-note {
        background: rgba(255, 159, 10, 0.1);
        border: 1px solid rgba(255, 159, 10, 0.25);
        border-radius: 6px;
        padding: 10px 12px;
        margin: 12px 0;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.9);
      }
      .setup-important-note strong {
        color: #ff9f0a;
        display: block;
        margin-bottom: 6px;
      }
      .setup-important-note ul {
        margin: 0;
        padding-left: 18px;
      }
      .setup-important-note li {
        margin: 3px 0;
        color: rgba(255, 255, 255, 0.8);
      }
      /* Dialer examples */
      .dialer-examples {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        padding: 10px 12px;
        margin: 12px 0;
      }
      .dialer-examples-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.6);
        margin-bottom: 8px;
      }
      .dialer-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dialer-item {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.8);
      }
      .dialer-item strong {
        color: var(--nav-teal, #00c7be);
      }
      /* Diagram section label */
      .diagram-section {
        text-align: center;
      }
      .diagram-label {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }
      .diagram-box.accent {
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        color: #fff;
        font-weight: 600;
      }
      /* Test instructions */
      .test-instructions {
        background: rgba(0, 199, 190, 0.08);
        border: 1px solid rgba(0, 199, 190, 0.2);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .test-instructions p {
        margin: 0 0 8px 0;
        font-size: 13px;
        color: #fff;
      }
      .test-instructions ol {
        margin: 0;
        padding-left: 20px;
      }
      .test-instructions li {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.85);
        margin: 4px 0;
      }
      .test-instructions strong {
        color: var(--nav-teal, #00c7be);
      }
      /* Success state styling */
      .setup-success-notice {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(52, 199, 89, 0.15);
        border: 1px solid rgba(52, 199, 89, 0.3);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .setup-success-notice .success-icon {
        font-size: 32px;
      }
      .setup-success-notice .success-text h4 {
        margin: 0 0 4px 0;
        font-size: 16px;
        color: #34c759;
      }
      .setup-success-notice .success-text p {
        margin: 0;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.8);
      }
    `;
    document.head.appendChild(styles);
  }
}

// Show VB-Cable test modal (Step 2: Test Audio)
function showVBCableTestModal(vbCableDevice) {
  const existingModal = document.getElementById('vbcable-modal');
  if (existingModal) existingModal.remove();
  cleanupVBCableTest();

  vbCableAudioDetected = false;

  const modal = document.createElement('div');
  modal.id = 'vbcable-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content vbcable-setup">
      <div class="modal-header">
        <h3>🎧 Test Customer Audio</h3>
        <span class="modal-step-indicator">Step 2 of 2</span>
        <button class="modal-close" onclick="closeVBCableModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="detected-device">
          <span class="detected-device-icon">✓</span>
          <div class="detected-device-info">
            <div class="detected-device-label">VB-Cable Detected</div>
            <div class="detected-device-name">${vbCableDevice.label || 'CABLE Output (VB-Audio)'}</div>
          </div>
        </div>

        <div class="test-instructions">
          <p><strong>Testing Customer Audio Capture:</strong></p>
          <ol>
            <li>Start a test call or play audio in your dialer</li>
            <li>The meter below should move when the <strong>CUSTOMER speaks</strong></li>
            <li>Your own voice should <strong>NOT</strong> move this meter</li>
          </ol>
        </div>

        <div class="audio-test-section">
          <div class="audio-meter-container">
            <span class="audio-meter-label" id="vbcable-meter-label">Waiting for customer audio...</span>
            <div class="audio-meter-bar" id="vbcable-meter-bar"></div>
          </div>
          <div class="audio-test-status" id="vbcable-test-status">Listening for customer audio...</div>
          <div class="audio-test-hint">Make sure your dialer's speaker is set to "CABLE Input"</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="showVBCableSetupModal()">← Back</button>
        <button class="btn-primary" id="vbcable-continue-btn" onclick="finishVBCableSetup()" disabled>Continue</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Start audio test
  startVBCableAudioTest(vbCableDevice);
}

// Start VB-Cable audio test with level monitoring
async function startVBCableAudioTest(vbCableDevice) {
  try {
    console.log('[VB-Cable Test] Starting audio test for device:', vbCableDevice.deviceId);

    // Capture from VB-Cable
    vbCableTestStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: vbCableDevice.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    console.log('[VB-Cable Test] Got stream with', vbCableTestStream.getAudioTracks().length, 'tracks');

    // Create audio context and analyser
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(vbCableTestStream);
    vbCableTestAnalyser = audioContext.createAnalyser();
    vbCableTestAnalyser.fftSize = 256;
    source.connect(vbCableTestAnalyser);

    const dataArray = new Uint8Array(vbCableTestAnalyser.frequencyBinCount);
    let peakLevel = 0;
    let audioDetectedTime = null;

    // Start monitoring
    function updateMeter() {
      if (!vbCableTestAnalyser) return;

      vbCableTestAnalyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const level = Math.min(100, avg * 1.5); // Scale up for visibility

      // Track peak
      if (level > peakLevel) peakLevel = level;

      // Update UI
      const meterBar = document.getElementById('vbcable-meter-bar');
      const meterLabel = document.getElementById('vbcable-meter-label');
      const statusEl = document.getElementById('vbcable-test-status');
      const continueBtn = document.getElementById('vbcable-continue-btn');

      if (meterBar) {
        meterBar.style.width = `${level}%`;
      }

      // Detect audio (level above threshold for sustained period)
      if (level > 5) {
        if (!audioDetectedTime) {
          audioDetectedTime = Date.now();
        } else if (Date.now() - audioDetectedTime > 500 && !vbCableAudioDetected) {
          // Audio confirmed after 500ms
          vbCableAudioDetected = true;
          console.log('[VB-Cable Test] Audio detected!');

          if (meterLabel) meterLabel.textContent = 'Audio detected!';
          if (statusEl) {
            statusEl.innerHTML = '✓ <strong>VB-Cable is working!</strong> Your calls will be captured automatically.';
            statusEl.className = 'audio-test-status success';
          }
          if (continueBtn) {
            continueBtn.disabled = false;
            continueBtn.textContent = "You're All Set →";
          }

          // Clear no-audio timeout
          if (vbCableNoAudioTimeout) {
            clearTimeout(vbCableNoAudioTimeout);
            vbCableNoAudioTimeout = null;
          }
        }
      } else {
        audioDetectedTime = null;
        if (meterLabel && !vbCableAudioDetected) {
          meterLabel.textContent = 'Waiting for audio...';
        }
      }

      vbCableTestAnimationId = requestAnimationFrame(updateMeter);
    }

    updateMeter();

    // Set timeout for no audio detected
    vbCableNoAudioTimeout = setTimeout(() => {
      if (!vbCableAudioDetected) {
        const statusEl = document.getElementById('vbcable-test-status');
        if (statusEl) {
          statusEl.textContent = '⚠ No audio detected. Check your dialer outputs to "CABLE Input"';
          statusEl.className = 'audio-test-status warning';
        }
      }
    }, 10000);

  } catch (error) {
    console.error('[VB-Cable Test] Error:', error);
    const statusEl = document.getElementById('vbcable-test-status');
    if (statusEl) {
      statusEl.textContent = `Error: ${error.message}`;
      statusEl.className = 'audio-test-status error';
    }
  }
}

// Cleanup VB-Cable test resources
function cleanupVBCableTest() {
  if (vbCableTestAnimationId) {
    cancelAnimationFrame(vbCableTestAnimationId);
    vbCableTestAnimationId = null;
  }
  if (vbCableTestStream) {
    vbCableTestStream.getTracks().forEach(track => track.stop());
    vbCableTestStream = null;
  }
  if (vbCableNoAudioTimeout) {
    clearTimeout(vbCableNoAudioTimeout);
    vbCableNoAudioTimeout = null;
  }
  vbCableTestAnalyser = null;
  vbCableAudioDetected = false;
}

// Finish VB-Cable setup and start capture
function finishVBCableSetup() {
  cleanupVBCableTest();
  closeVBCableModal();
  showToast('VB-Cable detected and working! Your calls will now be captured automatically.', 'success');
  startSystemAudioCapture();
}

// Close VB-Cable modal
function closeVBCableModal() {
  cleanupVBCableTest();
  const modal = document.getElementById('vbcable-modal');
  if (modal) modal.remove();
}

// Show Listen Setup Modal (for "Can't hear your calls?" help)
function showListenSetupModal() {
  // Remove existing modal if any
  const existingModal = document.getElementById('listen-setup-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'listen-setup-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content listen-setup-modal">
      <div class="modal-header">
        <h2>Hear Your Calls</h2>
        <button class="modal-close" onclick="closeListenSetupModal()">×</button>
      </div>
      <div class="modal-body">
        <p style="margin-bottom: 16px; color: #aaa;">
          By default, you won't hear audio routed through VB-Cable.<br>
          Follow these steps to hear your calls:
        </p>

        <button class="btn-primary listen-modal-btn" onclick="openSoundSettingsFromModal()" style="width: 100%; margin-bottom: 16px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Open Sound Settings
        </button>

        <div class="listen-steps-modal">
          <div class="listen-step-modal">
            <span class="step-num">1</span>
            <span>Go to <strong>"Recording"</strong> tab</span>
          </div>
          <div class="listen-step-modal">
            <span class="step-num">2</span>
            <span>Right-click <strong>"CABLE Output"</strong> → Properties</span>
          </div>
          <div class="listen-step-modal">
            <span class="step-num">3</span>
            <span>Click <strong>"Listen"</strong> tab</span>
          </div>
          <div class="listen-step-modal">
            <span class="step-num">4</span>
            <span>Check <strong>"Listen to this device"</strong></span>
          </div>
          <div class="listen-step-modal">
            <span class="step-num">5</span>
            <span>Select your headphones, click <strong>Apply</strong></span>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeListenSetupModal()">Close</button>
      </div>
    </div>
  `;

  // Add styles for this modal
  if (!document.getElementById('listen-modal-styles')) {
    const styles = document.createElement('style');
    styles.id = 'listen-modal-styles';
    styles.textContent = `
      .listen-setup-modal {
        max-width: 380px;
        width: 90%;
        background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      }
      .listen-setup-modal .modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .listen-setup-modal h2 {
        margin: 0;
        font-size: 16px;
        color: #fff;
      }
      .listen-setup-modal .modal-close {
        background: none;
        border: none;
        color: #888;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
      }
      .listen-setup-modal .modal-close:hover {
        color: #fff;
      }
      .listen-setup-modal .modal-body {
        padding: 16px 20px;
      }
      .listen-modal-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px 16px;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        color: #fff;
      }
      .listen-modal-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 199, 190, 0.4);
      }
      .listen-steps-modal {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 12px;
      }
      .listen-step-modal {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 0;
        font-size: 12px;
        color: #bbb;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      .listen-step-modal:last-child {
        border-bottom: none;
      }
      .listen-step-modal .step-num {
        background: linear-gradient(135deg, #00c7be, #4a90d9);
        color: #fff;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: bold;
        flex-shrink: 0;
      }
      .listen-step-modal strong {
        color: #fff;
      }
      .listen-setup-modal .modal-footer {
        padding: 12px 20px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        justify-content: flex-end;
      }
      .listen-setup-modal .btn-secondary {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #ccc;
      }
      .listen-setup-modal .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
    `;
    document.head.appendChild(styles);
  }

  document.body.appendChild(modal);
}

// Close Listen Setup Modal
function closeListenSetupModal() {
  const modal = document.getElementById('listen-setup-modal');
  if (modal) modal.remove();
}

// Open sound settings from modal
function openSoundSettingsFromModal() {
  openSoundSettings();
}

// Download VB-Cable
function downloadVBCable() {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal('https://vb-audio.com/Cable/');
  } else {
    window.open('https://vb-audio.com/Cable/', '_blank');
  }
}

// Open Chrome extension page as alternative to VB-Cable setup
function openChromeExtension() {
  // TODO: Update with actual Chrome Web Store URL when published
  const chromeExtensionUrl = 'https://callsteer.ai/chrome-extension';

  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(chromeExtensionUrl);
  } else {
    window.open(chromeExtensionUrl, '_blank');
  }

  // Close the VB-Cable modal since user chose alternative
  closeVBCableModal();
  showToast('Opening Chrome extension page...', 'info');
}

// Re-check for VB-Cable after installation - now shows test step
async function recheckVBCable() {
  closeVBCableModal();
  showToast('Checking for VB-Cable...', 'info');

  // Small delay to allow device enumeration to refresh
  await new Promise(r => setTimeout(r, 500));

  const vbCable = await detectVBCable();
  if (vbCable) {
    showToast('VB-Cable detected!', 'success');
    // Show test modal instead of immediately starting capture
    showVBCableTestModal(vbCable);
  } else {
    showToast('VB-Cable not found. Please install and restart.', 'warning');
    showVBCableSetupModal();
  }
}

// Helper function to handle a successfully captured audio stream
function handleSystemAudioStream(stream) {
  const toggleHint = document.getElementById('toggle-hint');

  // Stop video tracks if any - we only need audio
  stream.getVideoTracks().forEach(track => {
    console.log('[System] Stopping video track:', track.label);
    track.stop();
    stream.removeTrack(track);
  });

  // Check if we got audio
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.warn('[System] No audio track in stream');
    if (toggleHint) toggleHint.textContent = 'Listening (mic only)';
    showToast('No audio track available.', 'warning');
    return;
  }

  // Store the audio stream
  systemAudioStream = stream;
  persistentSystemStream = stream;
  systemStreamMuted = false;

  // Handle stream ending
  audioTracks[0].onended = () => {
    console.log('[System] Audio track ended');
    persistentSystemStream = null;
  };

  const audioTrack = audioTracks[0];
  console.log('[System] System audio capture successful!');
  console.log('[System] Audio track:', audioTrack.label);
  console.log('[System] Audio track settings:', JSON.stringify(audioTrack.getSettings()));

  // Update UI
  if (toggleHint) toggleHint.textContent = 'Listening (system audio)';
  showToast('System audio connected', 'success');

  // Connect to Deepgram for transcription
  connectDeepgramSystem();
}

async function startSystemAudioCapture() {
  const toggleHint = document.getElementById('toggle-hint');

  try {
    console.log('[System] ═══════════════════════════════════════════════════');
    console.log('[System] STARTING SYSTEM AUDIO CAPTURE');
    console.log('[System] ═══════════════════════════════════════════════════');

    // Check if we already have a persistent stream
    if (persistentSystemStream) {
      const tracks = persistentSystemStream.getAudioTracks();
      const isActive = tracks.length > 0 && tracks[0].readyState === 'live';

      if (isActive) {
        console.log('[System] Reusing persistent stream (no new capture needed)');
        tracks.forEach(track => {
          track.enabled = true;
          console.log('[System] Track unmuted:', track.label);
        });
        systemStreamMuted = false;
        systemAudioStream = persistentSystemStream;

        if (toggleHint) toggleHint.textContent = 'Listening (system audio)';
        connectDeepgramSystem();
        return;
      } else {
        console.log('[System] Persistent stream ended - need new capture');
        persistentSystemStream = null;
      }
    }

    if (toggleHint) toggleHint.textContent = 'Detecting audio devices...';

    // ═══════════════════════════════════════════════════════════════════
    // OPTION 1: VB-Cable (most reliable on Windows)
    // No screen picker, no permissions issues, works with any dialer
    // ═══════════════════════════════════════════════════════════════════
    console.log('[System] Checking for VB-Cable...');
    const vbCable = await detectVBCable();

    if (vbCable) {
      console.log('[System] VB-Cable found! Using:', vbCable.label);
      if (toggleHint) toggleHint.textContent = 'Connecting to VB-Cable...';

      try {
        const stream = await captureVBCable(vbCable.deviceId);
        if (stream && stream.getAudioTracks().length > 0) {
          console.log('[System] VB-Cable capture successful!');
          handleSystemAudioStream(stream);
          return;
        }
      } catch (vbError) {
        console.error('[System] VB-Cable capture failed:', vbError.message);
        showToast('VB-Cable found but capture failed. Check permissions.', 'warning');
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // OPTION 2: Direct WASAPI loopback (experimental)
    // May not work on all systems - try before showing setup modal
    // ═══════════════════════════════════════════════════════════════════
    if (window.electronAPI?.hasDirectLoopback && window.electronAPI.hasDirectLoopback()) {
      console.log('[System] Direct loopback available - trying WASAPI capture...');
      if (toggleHint) toggleHint.textContent = 'Trying direct capture...';

      try {
        const stream = await window.electronAPI.getLoopbackAudioStream();
        if (stream && stream.getAudioTracks().length > 0) {
          console.log('[System] Direct WASAPI capture successful!');
          handleSystemAudioStream(stream);
          return;
        }
      } catch (directError) {
        console.warn('[System] Direct loopback failed:', directError.message);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // NO CAPTURE METHOD AVAILABLE - Show VB-Cable setup instructions
    // ═══════════════════════════════════════════════════════════════════
    console.log('[System] No system audio capture available');
    console.log('[System] Showing VB-Cable setup modal...');

    if (toggleHint) toggleHint.textContent = 'Listening (mic only)';
    showVBCableSetupModal();

  } catch (error) {
    console.error('[System] System audio capture failed:', error.name, error.message);
    console.error('[System] Full error:', error);

    const toggleHint = document.getElementById('toggle-hint');
    if (toggleHint) toggleHint.textContent = 'Listening (mic only)';

    if (error.name === 'NotAllowedError') {
      showToast('Audio permission denied. Check settings.', 'warning');
    } else if (error.name === 'NotReadableError') {
      showToast('Audio source busy. Try closing other apps.', 'warning');
    } else {
      showToast(`Audio error: ${error.message}`, 'warning');
    }
  }
}

function connectDeepgramSystem() {
  if (!DEEPGRAM_API_KEY || !systemAudioStream) {
    return;
  }

  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'en-US',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300'
  });

  const wsUrl = `${DEEPGRAM_WS_URL}?${params.toString()}`;
  console.log('[System] Connecting to Deepgram...');

  deepgramSystemSocket = new WebSocket(wsUrl, ['token', DEEPGRAM_API_KEY]);

  deepgramSystemSocket.onopen = () => {
    console.log('[System] Deepgram connected');
    startSystemRecording();
  };

  deepgramSystemSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript;
        const isFinal = data.is_final;

        if (transcript.trim()) {
          // Record CUSTOMER audio activity - this resets the auto-timeout timer
          // Only customer audio keeps the listener active, not rep audio
          recordCustomerAudioActivity();

          console.log(`[System/CUSTOMER] ${isFinal ? 'FINAL' : 'interim'}: ${transcript}`);

          if (isFinal && transcript.length > 5) {
            // Store for vote context
            lastCustomerTranscript = transcript;
            sendTranscriptToBackend(transcript, 'customer');
          }
        }
      }
    } catch (e) {
      console.error('[System] Parse error:', e);
    }
  };

  deepgramSystemSocket.onerror = (error) => {
    console.error('[System] Deepgram error:', error);
  };

  deepgramSystemSocket.onclose = (event) => {
    console.log('[System] Deepgram disconnected:', event.code);
  };
}

function startSystemRecording() {
  if (!systemAudioStream || !deepgramSystemSocket) return;

  const audioTracks = systemAudioStream.getAudioTracks();
  if (audioTracks.length === 0) return;

  const audioOnlyStream = new MediaStream(audioTracks);

  try {
    systemMediaRecorder = new MediaRecorder(audioOnlyStream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    systemMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && deepgramSystemSocket?.readyState === WebSocket.OPEN) {
        deepgramSystemSocket.send(event.data);
      }
    };

    systemMediaRecorder.start(250);
    console.log('[System] Recording started');

  } catch (error) {
    console.error('[System] MediaRecorder error:', error);
  }
}

// ==================== SEND TRANSCRIPT TO BACKEND ====================

// Session-based call ID - ONE ID for entire listening session
let currentCallId = null;

// Client-side debounce - don't send transcripts within X seconds of last nudge
let lastNudgeTime = 0;
const CLIENT_DEBOUNCE_MS = 4000; // 4 seconds - balance between catching objections and not spamming

// Prevent double-fire: block sending while a request is in flight
let requestInFlight = false;

function getOrCreateCallId() {
  if (!currentCallId) {
    currentCallId = `widget_${clientCode}_${Date.now()}`;
    console.log('[Backend] Created call ID:', currentCallId);
  }
  return currentCallId;
}

function resetCallId() {
  console.log('[Backend] Reset call ID');
  currentCallId = null;
  lastNudgeTime = 0;
}

async function sendTranscriptToBackend(transcript, speaker) {
  if (!clientCode || !transcript) return;

  // Prevent double-fire: don't send if a request is already in flight
  if (requestInFlight) {
    console.log(`[Backend] Request in flight, skipping: "${transcript.substring(0, 30)}..."`);
    return;
  }

  // Debounce check - don't send within X seconds of last nudge
  const timeSinceLastNudge = Date.now() - lastNudgeTime;
  if (lastNudgeTime > 0 && timeSinceLastNudge < CLIENT_DEBOUNCE_MS) {
    console.log(`[Backend] Debounce active (${((CLIENT_DEBOUNCE_MS - timeSinceLastNudge) / 1000).toFixed(1)}s)`);
    return;
  }

  const endpoint = `${API_BASE_URL}/api/transcribe`;
  const callId = getOrCreateCallId();

  console.log(`[Backend] >>> Sending ${speaker}: "${transcript.substring(0, 50)}..."`);

  // Mark request as in flight
  requestInFlight = true;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_code: clientCode,
        transcript: transcript,
        speaker: speaker,
        call_id: callId,
        rep_id: repId, // Include unique rep ID for per-device isolation
        source: 'electron_widget',
        is_final: true
      })
    });

    if (!response.ok) {
      console.error('[Backend] Failed:', response.status, await response.text());
      return;
    }

    const data = await response.json();
    console.log('[Backend] <<< Response:', JSON.stringify(data).substring(0, 200));

    if (data.nudge) {
      console.log('[Backend] Nudge received:', data.nudge);
      lastNudgeTime = Date.now();
      processNudges([data.nudge]);
    } else {
      console.log('[Backend] No nudge returned (Claude said null)');
    }

  } catch (error) {
    console.error('[Backend] Error:', error);
  } finally {
    // Always clear the in-flight flag
    requestInFlight = false;
  }
}
