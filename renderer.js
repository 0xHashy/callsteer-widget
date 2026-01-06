// CallSteer Widget - WebSocket-based Renderer
// Receives real-time nudges from backend via WebSocket (Dialpad integration)

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

  // Check for stored login
  if (window.electronAPI) {
    clientCode = await window.electronAPI.getClientCode();
    clientInfo = await window.electronAPI.getClientInfo();
  }

  if (clientCode && clientInfo) {
    showMainWidget();
  } else {
    showLoginScreen();
  }

  // Listen for logout from tray
  if (window.electronAPI?.onLogoutRequest) {
    window.electronAPI.onLogoutRequest(handleLogout);
  }
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

  setupToggle();
  setupNudgeActions();
  startPolling();
  updateConnectionStatus('connected', 'Connected');
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
}

// ==================== LOGIN ====================

function setupLoginHandlers() {
  const connectBtn = document.getElementById('connect-btn');
  const codeInput = document.getElementById('client-code-input');
  const signupLink = document.getElementById('signup-link');

  connectBtn?.addEventListener('click', handleLogin);

  codeInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  codeInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  signupLink?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI?.openExternal('https://callsteer.com');
  });
}

async function handleLogin() {
  const codeInput = document.getElementById('client-code-input');
  const errorEl = document.getElementById('login-error');
  const connectBtn = document.getElementById('connect-btn');

  const code = codeInput.value.trim().toUpperCase();

  if (!code || code.length !== 6) {
    showLoginError('Enter a 6-character code');
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

  clientCode = null;
  clientInfo = null;
  seenNudgeIds = new Set();
  nudges = [];
  currentNudge = null;

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
    if (toggleHint) toggleHint.textContent = 'Waiting for calls...';
    if (listeningAnimation) listeningAnimation.style.display = 'flex';

    // Connect to WebSocket for real-time nudges
    connectToNudgeWebSocket(clientCode);
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

  const wsUrl = `${WS_BASE_URL}/ws/nudges/${code}`;
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

      try {
        const nudge = JSON.parse(event.data);

        // Handle pong response
        if (nudge === 'pong' || event.data === 'pong') {
          console.log('[WebSocket] Pong received');
          return;
        }

        // Process the nudge
        if (nudge && nudge.nudge_id) {
          console.log('[WebSocket] New nudge received:', nudge);
          processNudges([nudge]);
        }
      } catch (e) {
        console.error('[WebSocket] Failed to parse message:', e);
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
    const response = await fetch(`${API_BASE_URL}/api/nudges?client_code=${clientCode}`);

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
    return;
  }

  nudgeEmpty.style.display = 'none';
  nudgeCard.style.display = 'block';

  // Set content
  nudgeType.textContent = (nudge.category || 'TIP').toUpperCase().replace(/_/g, ' ');
  nudgeTime.textContent = formatTimestamp(nudge.timestamp);
  nudgeText.textContent = nudge.suggestion || 'No suggestion';

  // Add animation
  nudgeCard.style.animation = 'none';
  nudgeCard.offsetHeight; // Trigger reflow
  nudgeCard.style.animation = 'nudge-appear 0.4s ease-out';
}

function copyCurrentNudge() {
  if (!currentNudge?.suggestion) return;

  if (window.electronAPI?.copyToClipboard) {
    window.electronAPI.copyToClipboard(currentNudge.suggestion);
  } else {
    navigator.clipboard.writeText(currentNudge.suggestion);
  }

  showToast('Copied!', 'success');
}

function dismissCurrentNudge() {
  const nudgeCard = document.getElementById('nudge-card');

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

// ==================== STATS ====================

function updateStats() {
  const todayNudges = nudges.filter(n => isToday(n.timestamp)).length;
  const total = nudges.length;
  const adoptionRate = total > 0 ? Math.min(100, total * 5) : 0;
  const streak = Math.floor(total / 10);

  document.getElementById('stat-streak').textContent = streak;
  document.getElementById('stat-adoption').textContent = `${adoptionRate}%`;
  document.getElementById('stat-nudges').textContent = todayNudges;
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
