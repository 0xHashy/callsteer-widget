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

// ==================== DEVICE SELECTION STATE ====================
let selectedMicId = null;
let selectedSpeakerId = null;

// ==================== POPUP STATE ====================
let popupDismissTimer = null;
const POPUP_AUTO_DISMISS_MS = 15000;

// ==================== REBUTTAL TRACKING STATE ====================
let currentSuggestionText = '';      // The current nudge suggestion to match against
let rebuttalsUsedToday = 0;          // Count of rebuttals used today
let rebuttalsUsedTotal = 0;          // Total rebuttals used in session
let currentStreak = 0;               // Current consecutive rebuttals used
let bestStreak = 0;                  // Best streak ever
let lastRebuttalWasUsed = false;     // Track if last nudge was converted
const REBUTTAL_MATCH_THRESHOLD = 0.5; // 50% word match = rebuttal used

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

// Initialize
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
  setupWindowControls();
  setupLoginHandlers();

  // Load saved rep name if exists (for returning users)
  repName = localStorage.getItem('callsteer_rep_name') || null;

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
    showMainWidget();
  } else {
    showLoginScreen();
  }

  // Listen for logout from tray
  if (window.electronAPI?.onLogoutRequest) {
    window.electronAPI.onLogoutRequest(handleLogout);
  }
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
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('main-widget').style.display = 'none';
  stopPolling();
  disconnectNudgeWebSocket();
}

function showMainWidget() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-widget').style.display = 'flex';

  // Clear old nudges from previous sessions - start fresh
  nudges = [];
  seenNudgeIds = new Set();
  currentNudge = null;
  displayNudge(null);

  setupToggle();
  setupNudgeActions();
  setupStatsTabs();
  startPolling();
  updateConnectionStatus('connected', 'Connected');

  // Initialize device selection
  loadSavedDevices();
  populateDeviceDropdowns();

  // Load rebuttal tracking stats
  loadRebuttalStats();
  updateStats();
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

  // Sign out button
  document.getElementById('signout-btn')?.addEventListener('click', handleSignOut);
}

async function handleSignOut() {
  // Stop listening if active
  if (isListening) {
    stopListening();
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

  // Show login screen
  document.getElementById('main-widget').style.display = 'none';
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
    selectedSpeakerId = localStorage.getItem('callsteer_speaker_id');
    console.log('[Devices] Loaded saved devices:', { mic: selectedMicId, speaker: selectedSpeakerId });
  } catch (e) {
    console.error('[Devices] Failed to load saved devices:', e);
  }
}

function saveSelectedDevices() {
  try {
    if (selectedMicId) {
      localStorage.setItem('callsteer_mic_id', selectedMicId);
    }
    if (selectedSpeakerId) {
      localStorage.setItem('callsteer_speaker_id', selectedSpeakerId);
    }
    console.log('[Devices] Saved devices:', { mic: selectedMicId, speaker: selectedSpeakerId });
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
        console.log('[Devices] Selected mic:', selectedMicId);
      });
    }

    // Populate speaker dropdown
    const speakerSelect = document.getElementById('speaker-select');
    if (speakerSelect) {
      speakerSelect.innerHTML = '<option value="">Select speaker...</option>';
      audioOutputs.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Speaker ${device.deviceId.substring(0, 8)}`;
        if (device.deviceId === selectedSpeakerId) {
          option.selected = true;
        }
        speakerSelect.appendChild(option);
      });

      speakerSelect.addEventListener('change', (e) => {
        selectedSpeakerId = e.target.value;
        saveSelectedDevices();
        console.log('[Devices] Selected speaker:', selectedSpeakerId);
      });
    }

    // Auto-select first devices if none saved
    if (!selectedMicId && audioInputs.length > 0) {
      selectedMicId = audioInputs[0].deviceId;
      if (micSelect) micSelect.value = selectedMicId;
    }
    if (!selectedSpeakerId && audioOutputs.length > 0) {
      selectedSpeakerId = audioOutputs[0].deviceId;
      if (speakerSelect) speakerSelect.value = selectedSpeakerId;
    }

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

    showMainWidget();

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

  if (isListening) {
    // TURN OFF
    console.log('[Toggle] Turning OFF...');
    disconnectNudgeWebSocket();
    stopAudioCapture(); // Stop mic and system audio capture
    isListening = false;

    // Update UI to OFF state
    powerToggle?.classList.remove('active');
    if (toggleStatus) {
      toggleStatus.classList.remove('active');
      toggleStatus.textContent = 'OFF';
    }
    if (toggleHint) toggleHint.textContent = 'Tap to start listening';
    if (listeningAnimation) listeningAnimation.style.display = 'none';

    updateConnectionStatus('connected', 'Connected');
    console.log('[Toggle] Now OFF');
  } else {
    // TURN ON
    console.log('[Toggle] Turning ON...');

    // Update UI to ON state first
    powerToggle?.classList.add('active');
    if (toggleStatus) {
      toggleStatus.classList.add('active');
      toggleStatus.textContent = 'ON';
    }
    if (toggleHint) toggleHint.textContent = 'Starting audio capture...';
    if (listeningAnimation) listeningAnimation.style.display = 'flex';

    // Connect to WebSocket for real-time nudges (from Dialpad)
    connectToNudgeWebSocket(clientCode);

    // Start audio capture (mic = rep, system = customer)
    try {
      await startAudioCapture();
      if (toggleHint) toggleHint.textContent = 'Listening to mic & speaker';
    } catch (error) {
      console.error('[Toggle] Audio capture failed:', error);
      if (toggleHint) toggleHint.textContent = 'WebSocket only (audio failed)';
    }

    isListening = true;
    console.log('[Toggle] Now ON');
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

async function fetchNudges() {
  if (!clientCode) {
    return;
  }

  try {
    // Include rep_id for per-device filtering
    const response = await fetch(`${API_BASE_URL}/api/nudges?client_code=${clientCode}&rep_id=${encodeURIComponent(repId)}`);

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

  newNudges.forEach(nudge => {
    if (nudge.nudge_id && !seenNudgeIds.has(nudge.nudge_id)) {
      seenNudgeIds.add(nudge.nudge_id);
      nudges.unshift(nudge);
      hasNew = true;
    }
  });

  if (hasNew) {
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
  const todayNudges = nudges.filter(n => isToday(n.timestamp)).length;

  // Calculate adoption rate: rebuttals used / nudges received today
  const adoptionRate = todayNudges > 0
    ? Math.min(100, Math.round((rebuttalsUsedToday / todayNudges) * 100))
    : 0;

  // Update Live tab quick stats
  const rebuttalsEl = document.getElementById('stat-rebuttals');
  const adoptionEl = document.getElementById('stat-adoption');
  const nudgesEl = document.getElementById('stat-nudges');

  if (rebuttalsEl) rebuttalsEl.textContent = rebuttalsUsedToday;
  if (adoptionEl) adoptionEl.textContent = `${adoptionRate}%`;
  if (nudgesEl) nudgesEl.textContent = todayNudges;

  // Also update Stats tab if visible
  updateStatsTab();
}

function updateStatsTab() {
  const todayNudges = nudges.filter(n => isToday(n.timestamp)).length;
  const adoptionRate = todayNudges > 0
    ? Math.min(100, Math.round((rebuttalsUsedToday / todayNudges) * 100))
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
  if (receivedEl) receivedEl.textContent = todayNudges;
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
          <span class="leaderboard-adoption">${entry.adoption_rate}%</span>
          <span class="leaderboard-used">${entry.rebuttals_used_today}</span>
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

function playNotificationSound() {
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTUIGWi77eeeTRAMUKfj8LZjHAY4ktfzyn0tBSh+zPLaizsKF2S96+qoVRQLR6Hh8r1sIAUrgc7y2Yk1CBlou+3nnk0QDFC46fC2YxwGOJLX88p9LQUofszy2os7ChdjvevqqFUUC0eh4fK9bCAFK4HO8tmJNQgZaLvt555NEAxQuOnwtmMcBjiS1/PKfS0FKH7M8tqLOwoXY73r6qhVFAtHoeHyvWwgBSuBzvLZiTUIGWi77eeeTRAMULjp8LZjHAY4ktfzyn0tBSh+zPLaizsKF2O96+qoVRQLR6Hh8r1sIAU=');
    audio.volume = 0.3;
    audio.play().catch(() => {});
  } catch (e) {}
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

  // Normalize both strings: lowercase, remove punctuation, split into words
  const normalize = (text) => text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2); // Ignore tiny words like "a", "to"

  const repWords = normalize(repSpeech);
  const suggestionWords = normalize(suggestion);

  if (suggestionWords.length === 0) return 0;

  // Count how many suggestion words appear in rep speech
  let matchCount = 0;
  for (const sugWord of suggestionWords) {
    // Check for exact match or close match (substring)
    const found = repWords.some(repWord =>
      repWord === sugWord ||
      repWord.includes(sugWord) ||
      sugWord.includes(repWord)
    );
    if (found) matchCount++;
  }

  const similarity = matchCount / suggestionWords.length;
  console.log(`[Rebuttal] Similarity: ${(similarity * 100).toFixed(0)}% (${matchCount}/${suggestionWords.length} words)`);
  return similarity;
}

/**
 * Check if rep speech matches the current suggestion
 */
function checkRebuttalMatch(repTranscript) {
  if (!currentSuggestionText || !repTranscript) return;

  const similarity = calculateSimilarity(repTranscript, currentSuggestionText);

  if (similarity >= REBUTTAL_MATCH_THRESHOLD) {
    console.log('[Rebuttal] ✅ MATCH DETECTED! Rep used the rebuttal.');
    onRebuttalUsed();
  }
}

/**
 * Called when rep successfully uses a rebuttal
 */
function onRebuttalUsed() {
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

  // Show success animation on nudge card
  showRebuttalSuccess();

  // Play success sound
  playSuccessSound();

  // Update stats display
  updateStats();

  // Auto-dismiss the nudge after animation
  setTimeout(() => {
    dismissCurrentNudge();
  }, 1500);

  // Clear current suggestion to prevent re-matching
  currentSuggestionText = '';
}

/**
 * Show checkmark animation on nudge card
 */
function showRebuttalSuccess() {
  const nudgeCard = document.getElementById('nudge-card');
  if (!nudgeCard) return;

  // Add success class for animation
  nudgeCard.classList.add('rebuttal-success');

  // Create checkmark overlay
  const checkmark = document.createElement('div');
  checkmark.className = 'rebuttal-checkmark';
  checkmark.innerHTML = `
    <svg viewBox="0 0 52 52" width="48" height="48">
      <circle class="checkmark-circle" cx="26" cy="26" r="24" fill="none" stroke="#34C759" stroke-width="3"/>
      <path class="checkmark-check" fill="none" stroke="#34C759" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M14 27l8 8 16-16"/>
    </svg>
    <span class="rebuttal-label">Nice!</span>
  `;
  nudgeCard.appendChild(checkmark);

  // Remove after animation
  setTimeout(() => {
    checkmark.remove();
    nudgeCard.classList.remove('rebuttal-success');
  }, 1500);
}

/**
 * Play subtle success sound
 */
function playSuccessSound() {
  try {
    // Success chime - pleasant, short, not annoying
    const audio = new Audio('data:audio/wav;base64,UklGRqQEAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YYAEAAB/f39/gICBgYKCg4OEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f');
    audio.volume = 0.4;
    audio.play().catch(() => {});
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

    // Reset daily count if it's a new day
    if (stored.date !== today) {
      stored.date = today;
      stored.todayCount = 0;
      // Don't reset streak on new day - keep it going
    }

    stored.todayCount = rebuttalsUsedToday;
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

    // Reset daily count if it's a new day
    if (stored.date === today) {
      rebuttalsUsedToday = stored.todayCount || 0;
    } else {
      rebuttalsUsedToday = 0;
    }

    rebuttalsUsedTotal = stored.totalCount || 0;
    currentStreak = stored.currentStreak || 0;
    bestStreak = stored.bestStreak || 0;

    console.log('[Rebuttal] Loaded stats for', repId, ':', {
      today: rebuttalsUsedToday,
      total: rebuttalsUsedTotal,
      streak: currentStreak,
      best: bestStreak
    });
  } catch (e) {
    console.error('[Rebuttal] Failed to load stats:', e);
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

  // Stop system audio
  if (systemMediaRecorder && systemMediaRecorder.state !== 'inactive') {
    systemMediaRecorder.stop();
  }
  if (systemAudioStream) {
    systemAudioStream.getTracks().forEach(track => track.stop());
    systemAudioStream = null;
  }
  if (deepgramSystemSocket) {
    deepgramSystemSocket.close();
    deepgramSystemSocket = null;
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

async function startSystemAudioCapture() {
  const toggleHint = document.getElementById('toggle-hint');

  try {
    console.log('[System] ═══════════════════════════════════════════════════');
    console.log('[System] STARTING SYSTEM AUDIO CAPTURE - DEVICE ENUMERATION');

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    console.log('[System] ALL DEVICES FOUND (' + allDevices.length + ' total):');
    allDevices.forEach((device, index) => {
      console.log('[System]   ' + index + ': ' + device.kind + ' - "' + device.label + '"');
    });

    const audioOutputs = allDevices.filter(d => d.kind === 'audiooutput');
    const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
    console.log('[System] Summary: ' + audioOutputs.length + ' outputs, ' + audioInputs.length + ' inputs');
    console.log('[System] ═══════════════════════════════════════════════════');

    if (toggleHint) toggleHint.textContent = 'Finding audio devices...';

    // Use selected speaker to find corresponding loopback
    let targetOutputName = '';
    if (selectedSpeakerId) {
      const selectedOutput = audioOutputs.find(d => d.deviceId === selectedSpeakerId);
      if (selectedOutput) {
        targetOutputName = selectedOutput.label;
        console.log('[System] Using selected speaker:', targetOutputName);
      }
    }

    // If no selection, use default
    if (!targetOutputName) {
      const defaultOutput = audioOutputs.find(d => d.deviceId === 'default');
      if (defaultOutput && defaultOutput.label) {
        const match = defaultOutput.label.match(/Default\s*[-–—]\s*(.+)/i);
        targetOutputName = match ? match[1].trim() : defaultOutput.label;
      }
    }

    console.log('[System] Target output device:', targetOutputName);

    // Find loopback device
    let loopbackDevice = null;
    let matchReason = '';

    // Extract keywords from output name
    if (targetOutputName) {
      const outputKeywords = targetOutputName.toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .split(/[\s,\-]+/)
        .filter(w => w.length > 2 && !['default', 'audio', 'device'].includes(w));

      console.log('[System] Output keywords:', outputKeywords);

      // Strategy 1: Loopback matching output
      for (const input of audioInputs) {
        const inputLabel = input.label.toLowerCase();
        if (inputLabel.includes('loopback')) {
          for (const keyword of outputKeywords) {
            if (inputLabel.includes(keyword)) {
              loopbackDevice = input;
              matchReason = `Loopback matching "${keyword}"`;
              break;
            }
          }
          if (loopbackDevice) break;
        }
      }
    }

    // Strategy 2: Any loopback
    if (!loopbackDevice) {
      const anyLoopback = audioInputs.find(d => d.label.toLowerCase().includes('loopback'));
      if (anyLoopback) {
        loopbackDevice = anyLoopback;
        matchReason = 'Generic loopback';
      }
    }

    // Strategy 3: What U Hear
    if (!loopbackDevice) {
      const whatUHear = audioInputs.find(d => d.label.toLowerCase().includes('what u hear'));
      if (whatUHear) {
        loopbackDevice = whatUHear;
        matchReason = 'What U Hear';
      }
    }

    // Strategy 4: Stereo Mix
    if (!loopbackDevice) {
      const stereoMix = audioInputs.find(d => d.label.toLowerCase().includes('stereo mix'));
      if (stereoMix) {
        loopbackDevice = stereoMix;
        matchReason = 'Stereo Mix';
      }
    }

    // Strategy 5: Any mix device
    if (!loopbackDevice) {
      const mixDevice = audioInputs.find(d => {
        const label = d.label.toLowerCase();
        return label.includes('wave out') || label.includes('mix');
      });
      if (mixDevice) {
        loopbackDevice = mixDevice;
        matchReason = 'Mix device';
      }
    }

    if (!loopbackDevice) {
      console.error('[System] No loopback device found');
      if (toggleHint) toggleHint.textContent = 'No loopback - mic only';
      showToast('No system audio capture available', 'warning');
      return;
    }

    console.log('[System] Selected:', loopbackDevice.label, '-', matchReason);

    // Capture audio
    systemAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: loopbackDevice.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const audioTracks = systemAudioStream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.error('[System] No audio track');
      systemAudioStream = null;
      return;
    }

    console.log('[System] ✅ Capture successful:', loopbackDevice.label);
    if (toggleHint) toggleHint.textContent = 'Listening to mic & speaker';

    connectDeepgramSystem();

  } catch (error) {
    console.error('[System] Failed:', error);
    if (toggleHint) toggleHint.textContent = 'System audio failed - mic only';
    showToast('System audio unavailable', 'warning');
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
          console.log(`[System/CUSTOMER] ${isFinal ? 'FINAL' : 'interim'}: ${transcript}`);

          if (isFinal && transcript.length > 5) {
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

// Client-side debounce - don't send transcripts within 10 seconds of last nudge
let lastNudgeTime = 0;
const CLIENT_DEBOUNCE_MS = 10000;

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

  // Debounce check
  const timeSinceLastNudge = Date.now() - lastNudgeTime;
  if (lastNudgeTime > 0 && timeSinceLastNudge < CLIENT_DEBOUNCE_MS) {
    console.log(`[Backend] Debounce active (${((CLIENT_DEBOUNCE_MS - timeSinceLastNudge) / 1000).toFixed(1)}s)`);
    return;
  }

  const endpoint = `${API_BASE_URL}/api/transcribe`;
  const callId = getOrCreateCallId();

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
      console.error('[Backend] Failed:', response.status);
      return;
    }

    const data = await response.json();

    if (data.nudge) {
      console.log('[Backend] Nudge received:', data.nudge);
      lastNudgeTime = Date.now();
      processNudges([data.nudge]);
    }

  } catch (error) {
    console.error('[Backend] Error:', error);
  }
}
