// CallSteer Widget - Redesigned Renderer
// Minimal toggle-based UI with glassmorphic design

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
const POLL_INTERVAL = 2000;

// State
let clientCode = null;
let clientInfo = null;
let isListening = false;
let currentNudge = null;
let nudges = [];
let seenNudgeIds = new Set();
let pollingInterval = null;

// Audio capture state (MediaRecorder - NO ScriptProcessor!)
let mediaRecorder = null;
let deepgramSocket = null;
let micStream = null;

// System audio capture state (for customer voice via WASAPI)
let systemMediaRecorder = null;
let systemDeepgramSocket = null;
let systemStream = null;

// ==================== BACKEND API ====================

/**
 * Send transcript to backend
 * @param {string} transcript - The transcribed text
 * @param {string} speaker - 'rep' for microphone (salesperson) or 'customer' for system audio
 */
async function sendTranscriptToBackend(transcript, speaker = 'rep') {
  // Use stored clientCode or fallback
  const code = clientCode || localStorage.getItem('clientCode') || 'IO1EOF';

  // Build URL with query parameters (backend expects query params, not JSON body)
  const params = new URLSearchParams({
    client_code: code,
    transcript: transcript,
    speaker: speaker
  });

  const url = `https://callsteer-backend-production.up.railway.app/api/process-transcript?${params}`;

  console.log('[Backend] Sending transcript:', { transcript: transcript.substring(0, 50), speaker, clientCode: code });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Backend] Error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log('[Backend] Response:', data);

    // If there's a nudge, display it
    if (data.nudge) {
      console.log('[Backend] NUDGE RECEIVED:', data.nudge);
      processNudges([data.nudge]);
    }

    return data;
  } catch (error) {
    console.error('[Backend] Request failed:', error);
    return null;
  }
}

// ==================== DEVICE SELECTION ====================

/**
 * Populate the microphone dropdown with available devices
 */
async function populateMicrophoneList() {
  try {
    console.log('[Devices] Populating microphone list...');

    // Request permission first to get device labels
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());
    } catch (e) {
      console.warn('[Devices] Could not get initial permission:', e.message);
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    const micSelect = document.getElementById('mic-select');
    if (!micSelect) {
      console.log('[Devices] No mic-select element found');
      return;
    }

    micSelect.innerHTML = '';

    if (mics.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No microphones found';
      micSelect.appendChild(option);
      return;
    }

    mics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${index + 1}`;
      micSelect.appendChild(option);
    });

    // Load saved preference
    const savedMic = localStorage.getItem('preferredMic');
    if (savedMic && mics.some(m => m.deviceId === savedMic)) {
      micSelect.value = savedMic;
    }

    // Save when changed
    micSelect.addEventListener('change', () => {
      localStorage.setItem('preferredMic', micSelect.value);
      console.log('[Devices] Saved preferred mic:', micSelect.value);
    });

    console.log('[Devices] Found', mics.length, 'microphone(s)');

  } catch (e) {
    console.error('[Devices] Error populating mic list:', e);
  }
}

/**
 * Populate the speaker/output dropdown with available devices
 */
async function populateSpeakerList() {
  try {
    console.log('[Devices] Populating speaker list...');

    const devices = await navigator.mediaDevices.enumerateDevices();
    const speakers = devices.filter(d => d.kind === 'audiooutput');

    const speakerSelect = document.getElementById('speaker-select');
    if (!speakerSelect) {
      console.log('[Devices] No speaker-select element found');
      return;
    }

    speakerSelect.innerHTML = '';

    if (speakers.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No speakers found';
      speakerSelect.appendChild(option);
      return;
    }

    speakers.forEach((speaker, index) => {
      const option = document.createElement('option');
      option.value = speaker.deviceId;
      option.textContent = speaker.label || `Speaker ${index + 1}`;
      speakerSelect.appendChild(option);
    });

    // Load saved preference
    const savedSpeaker = localStorage.getItem('preferredSpeaker');
    if (savedSpeaker && speakers.some(s => s.deviceId === savedSpeaker)) {
      speakerSelect.value = savedSpeaker;
    }

    // Save when changed
    speakerSelect.addEventListener('change', () => {
      localStorage.setItem('preferredSpeaker', speakerSelect.value);
      console.log('[Devices] Saved preferred speaker:', speakerSelect.value);
    });

    console.log('[Devices] Found', speakers.length, 'speaker(s)');

  } catch (e) {
    console.error('[Devices] Error populating speaker list:', e);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
  setupWindowControls();
  setupLoginHandlers();

  // Populate device lists
  await populateMicrophoneList();
  await populateSpeakerList();

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
  if (isListening) stopMicCapture();

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
    stopMicCapture();           // Stop rep's voice capture
    stopSystemAudioCapture();   // Stop customer's voice capture
    isListening = false;

    // Update UI to OFF state
    powerToggle?.classList.remove('active');
    if (toggleStatus) {
      toggleStatus.classList.remove('active');
      toggleStatus.textContent = 'OFF';
    }
    if (toggleHint) toggleHint.textContent = 'Tap to start listening';
    if (listeningAnimation) listeningAnimation.style.display = 'none';

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
    if (toggleHint) toggleHint.textContent = 'Listening to your call...';
    if (listeningAnimation) listeningAnimation.style.display = 'flex';

    // Start BOTH audio captures
    await startMicCapture();           // Rep's voice (microphone)
    await startSystemAudioCapture();   // Customer's voice (system audio/WASAPI)
    // isListening is set to true inside startMicCapture on success

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
    if (toggleHint) toggleHint.textContent = 'Listening to your call...';
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

// ==================== CLEAN MEDIARECORDER AUDIO CAPTURE ====================

async function startMicCapture() {
  const micSelect = document.getElementById('mic-select');
  const selectedMicId = micSelect?.value;

  console.log('[MIC] Starting microphone capture...');
  console.log('[MIC] Selected device:', selectedMicId || 'default');

  try {
    // Step 1: Get microphone stream
    console.log('[MIC] Step 1: Requesting microphone access...');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    console.log('[MIC] Step 1: SUCCESS - Got microphone stream');

    // Step 2: Connect to Deepgram
    console.log('[MIC] Step 2: Connecting to Deepgram...');

    deepgramSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen',
      ['token', 'fbd2742fdb1be9c89ff2681a5f35d504d0bd1ad8']
    );

    deepgramSocket.onopen = () => {
      console.log('[DEEPGRAM] Connected! Starting MediaRecorder...');

      // Step 3: Create MediaRecorder
      try {
        mediaRecorder = new MediaRecorder(micStream, {
          mimeType: 'audio/webm;codecs=opus'
        });
        console.log('[MIC] Step 3: MediaRecorder created');

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0 && deepgramSocket?.readyState === WebSocket.OPEN) {
            deepgramSocket.send(event.data);
          }
        };

        mediaRecorder.onerror = (err) => {
          console.error('[MIC] MediaRecorder error:', err);
        };

        mediaRecorder.start(250); // Send data every 250ms
        console.log('[MIC] Step 4: MediaRecorder started - capturing audio!');
        isListening = true;
        updateConnectionStatus('connected', 'Listening');

      } catch (recorderError) {
        console.error('[MIC] Failed to create MediaRecorder:', recorderError);
        isListening = false;
        updateToggleUI(false);
        updateConnectionStatus('error', 'Recorder failed');
      }
    };

    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim() && data.is_final) {
          console.log('[TRANSCRIPT] Rep said:', transcript);
          // Send to backend for nudge processing
          if (transcript.length > 3) {
            sendTranscriptToBackend(transcript, 'rep');
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    deepgramSocket.onerror = (err) => {
      console.error('[DEEPGRAM] WebSocket error:', err);
      updateConnectionStatus('error', 'Connection error');
    };

    deepgramSocket.onclose = () => {
      console.log('[DEEPGRAM] Disconnected');
      if (isListening) {
        isListening = false;
        updateToggleUI(false);
        updateConnectionStatus('connected', 'Disconnected');
      }
    };

  } catch (error) {
    console.error('[MIC] Failed to start:', error);
    isListening = false;
    updateToggleUI(false);
    updateConnectionStatus('error', 'Mic access denied');
  }
}

function stopMicCapture() {
  console.log('[MIC] Stopping capture...');

  // Stop MediaRecorder
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  // Close Deepgram socket
  if (deepgramSocket) {
    deepgramSocket.close();
  }
  deepgramSocket = null;

  // Stop mic stream tracks
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }
  micStream = null;

  isListening = false;
  updateConnectionStatus('connected', 'Connected');
  console.log('[MIC] Stopped');
}

// ==================== SYSTEM AUDIO CAPTURE (Customer Voice via getDisplayMedia) ====================

async function startSystemAudioCapture() {
  console.log('[SYSTEM] Starting system audio capture...');

  try {
    // On Windows, getDisplayMedia can capture system audio
    // User will see a dialog to select what to share
    console.log('[SYSTEM] Requesting display media with audio...');

    systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: 1,
        height: 1,
        frameRate: 1
      },
      audio: true  // This requests system audio
    });

    console.log('[SYSTEM] Got display media stream');
    console.log('[SYSTEM] Audio tracks:', systemStream.getAudioTracks().length);
    console.log('[SYSTEM] Video tracks:', systemStream.getVideoTracks().length);

    // Check if we got audio
    if (systemStream.getAudioTracks().length === 0) {
      console.error('[SYSTEM] No audio track in stream - user may not have shared audio');
      return;
    }

    // Remove video tracks (we only want audio)
    systemStream.getVideoTracks().forEach(track => {
      track.stop();
      systemStream.removeTrack(track);
    });

    console.log('[SYSTEM] Video tracks removed, connecting to Deepgram...');

    // Connect to Deepgram
    systemDeepgramSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen',
      ['token', 'fbd2742fdb1be9c89ff2681a5f35d504d0bd1ad8']
    );

    systemDeepgramSocket.onopen = () => {
      console.log('[SYSTEM-DEEPGRAM] Connected!');

      systemMediaRecorder = new MediaRecorder(systemStream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      systemMediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && systemDeepgramSocket?.readyState === WebSocket.OPEN) {
          systemDeepgramSocket.send(event.data);
        }
      };

      systemMediaRecorder.onerror = (err) => {
        console.error('[SYSTEM] MediaRecorder error:', err);
      };

      systemMediaRecorder.start(250);
      console.log('[SYSTEM] Now capturing customer audio!');
    };

    systemDeepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim() && data.is_final) {
          console.log('[TRANSCRIPT] Customer said:', transcript);
          // Send as CUSTOMER - this triggers objection detection!
          if (transcript.length > 3) {
            sendTranscriptToBackend(transcript, 'customer');
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    systemDeepgramSocket.onerror = (err) => {
      console.error('[SYSTEM-DEEPGRAM] WebSocket error:', err);
    };

    systemDeepgramSocket.onclose = () => {
      console.log('[SYSTEM-DEEPGRAM] Disconnected');
    };

  } catch (error) {
    console.error('[SYSTEM] Failed:', error.name, error.message);

    if (error.name === 'NotAllowedError') {
      console.log('[SYSTEM] User denied permission or closed dialog');
    }
  }
}

function stopSystemAudioCapture() {
  console.log('[SYSTEM] Stopping system audio capture...');

  if (systemMediaRecorder && systemMediaRecorder.state !== 'inactive') {
    systemMediaRecorder.stop();
  }
  systemMediaRecorder = null;

  if (systemDeepgramSocket) {
    systemDeepgramSocket.close();
  }
  systemDeepgramSocket = null;

  if (systemStream) {
    systemStream.getTracks().forEach(track => track.stop());
  }
  systemStream = null;

  console.log('[SYSTEM] Stopped');
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
    updateConnectionStatus('error', 'Not connected');
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/nudges?client_code=${clientCode}`);

    if (!response.ok) throw new Error('Failed to fetch');

    const data = await response.json();
    updateConnectionStatus('connected', 'Connected');

    if (data?.nudges?.length > 0) {
      processNudges(data.nudges);
    }

  } catch (error) {
    console.error('Fetch error:', error);
    updateConnectionStatus('error', 'Connection error');
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
  statusEl.className = 'footer ' + status;
  statusText.textContent = text;

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
