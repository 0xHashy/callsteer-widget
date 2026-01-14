// CallSteer Dashboard JavaScript

const API_BASE_URL = 'https://callsteer-backend-production.up.railway.app';

// Password visibility toggle
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const eyeIcon = btn.querySelector('.eye-icon');
  const eyeOffIcon = btn.querySelector('.eye-off-icon');

  if (input.type === 'password') {
    input.type = 'text';
    eyeIcon.style.display = 'none';
    eyeOffIcon.style.display = 'block';
  } else {
    input.type = 'password';
    eyeIcon.style.display = 'block';
    eyeOffIcon.style.display = 'none';
  }
}

let clientCode = null;
let clientInfo = null;
let repId = null;

// ==================== INITIALIZATION ====================

async function initDashboard() {
  console.log('[Dashboard] Initializing...');

  // Load saved credentials
  if (window.electronAPI) {
    try {
      clientCode = await window.electronAPI.getClientCode();
      clientInfo = await window.electronAPI.getClientInfo();
      console.log('[Dashboard] Loaded client code:', clientCode ? 'present' : 'none');
      console.log('[Dashboard] Client info:', clientInfo);
    } catch (e) {
      console.error('[Dashboard] Error loading client info:', e);
    }
  }

  // Check if logged in (require both clientCode and clientInfo with rep_name)
  if (!clientCode || !clientInfo || !clientInfo.rep_name) {
    console.log('[Dashboard] No credentials or missing rep_name, showing login screen');
    showLoginScreen();
    setupLoginForm();
    return;
  }

  // Generate repId from rep_name for stats lookups
  repId = clientInfo.rep_id || generateRepId(clientInfo.rep_name);
  console.log('[Dashboard] Rep ID:', repId);

  // Show main dashboard
  showDashboard();

  // Update UI with user info
  updateUserInfo();

  // Setup tab navigation
  setupTabNavigation();

  // Setup launch widget button
  const launchBtn = document.getElementById('btn-launch-widget');
  if (launchBtn) {
    launchBtn.addEventListener('click', launchWidget);
  }

  // Load today's stats
  await loadTodayStats();

  // Refresh stats periodically (every 30 seconds)
  setInterval(loadTodayStats, 30000);

  console.log('[Dashboard] Initialization complete');
}

// ==================== LOGIN/LOGOUT SCREENS ====================

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('dashboard-main').style.display = 'none';
}

function showDashboard() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard-main').style.display = 'flex';
}

function setupLoginForm() {
  const form = document.getElementById('dashboard-login-form');
  if (form) {
    form.addEventListener('submit', handleDashboardLogin);
  }

  // Caps lock detection for login fields
  const capsLockWarning = document.getElementById('dashboard-caps-lock-warning');
  const codeInput = document.getElementById('dashboard-client-code');
  const repIdInput = document.getElementById('dashboard-rep-id');
  const pinInput = document.getElementById('dashboard-pin');
  const loginInputs = [codeInput, repIdInput, pinInput];

  loginInputs.forEach(input => {
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.getModifierState && capsLockWarning) {
        const isCapsOn = e.getModifierState('CapsLock');
        capsLockWarning.style.display = isCapsOn ? 'flex' : 'none';
      }
    });
    input.addEventListener('keyup', (e) => {
      if (e.getModifierState && capsLockWarning) {
        const isCapsOn = e.getModifierState('CapsLock');
        capsLockWarning.style.display = isCapsOn ? 'flex' : 'none';
      }
    });
  });
}

async function handleDashboardLogin(e) {
  e.preventDefault();

  const codeInput = document.getElementById('dashboard-client-code');
  const repIdInput = document.getElementById('dashboard-rep-id');
  const pinInput = document.getElementById('dashboard-pin');
  const errorEl = document.getElementById('dashboard-login-error');
  const submitBtn = document.getElementById('dashboard-login-btn');

  const code = codeInput.value.trim().toUpperCase();
  const repIdValue = repIdInput.value.trim();
  const pin = pinInput.value.trim();

  // Validate inputs
  if (!code || code.length !== 6) {
    errorEl.textContent = 'Enter a 6-character company code';
    codeInput.focus();
    return;
  }

  if (!repIdValue) {
    errorEl.textContent = 'Enter your Rep ID';
    repIdInput.focus();
    return;
  }

  if (!pin || pin.length !== 6) {
    errorEl.textContent = 'Enter your 6-digit PIN';
    pinInput.focus();
    return;
  }

  // Show loading state
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    // Use the rep login API with PIN authentication
    console.log('[Dashboard] Authenticating:', code, repIdValue);
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/rep/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_code: code,
          rep_id: repIdValue,
          pin: pin
        })
      });
    } catch (fetchError) {
      console.error('[Dashboard] Fetch failed:', fetchError);
      throw new Error('Could not connect to server. Check your internet connection.');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || 'Invalid credentials');
    }

    console.log('[Dashboard] Login successful:', data);

    // Clear PIN from memory (security)
    pinInput.value = '';

    // Save credentials
    clientCode = data.client_code;
    repId = data.rep_id;
    clientInfo = {
      client_code: data.client_code,
      company_name: data.company_name,
      rep_name: data.name,
      rep_id: data.rep_id,
      role: data.role
    };

    // Save to localStorage for convenience
    localStorage.setItem('callsteer_client_code', data.client_code);
    localStorage.setItem('callsteer_rep_id', data.rep_id);
    localStorage.setItem('callsteer_rep_name', data.name);

    if (window.electronAPI) {
      await window.electronAPI.saveClientCode(data.client_code);
      await window.electronAPI.saveClientInfo(clientInfo);
    }

    console.log('[Dashboard] Credentials saved:', data.name, data.client_code);

    // Show dashboard
    showDashboard();

    // Initialize dashboard features
    updateUserInfo();
    setupTabNavigation();

    const launchBtn = document.getElementById('btn-launch-widget');
    if (launchBtn) {
      launchBtn.addEventListener('click', launchWidget);
    }

    await loadTodayStats();
    setInterval(loadTodayStats, 30000);

  } catch (error) {
    console.error('[Dashboard] Login error:', error);
    errorEl.textContent = error.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
}

// ==================== USER INFO ====================

function updateUserInfo() {
  // Try clientInfo first, fall back to localStorage for backwards compatibility
  const userName = clientInfo?.rep_name || localStorage.getItem('callsteer_rep_name') || 'Rep';
  const companyName = clientInfo?.company_name || 'Company';

  // Update sidebar footer
  const sidebarUserName = document.getElementById('sidebar-user-name');
  const sidebarCompanyName = document.getElementById('sidebar-company-name');
  if (sidebarUserName) sidebarUserName.textContent = userName;
  if (sidebarCompanyName) sidebarCompanyName.textContent = companyName;

  // Update home tab greeting
  const homeUserName = document.getElementById('home-user-name');
  if (homeUserName) homeUserName.textContent = userName.split(' ')[0]; // First name only
}

// ==================== TAB NAVIGATION ====================

function setupTabNavigation() {
  const navTabs = document.querySelectorAll('.nav-tab');

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabId}`);
  });

  console.log('[Dashboard] Switched to tab:', tabId);
}

// ==================== LAUNCH WIDGET ====================

async function launchWidget() {
  console.log('[Dashboard] Launching widget...');

  if (window.electronAPI && window.electronAPI.launchWidget) {
    try {
      await window.electronAPI.launchWidget();
      console.log('[Dashboard] Widget launched successfully');
    } catch (e) {
      console.error('[Dashboard] Error launching widget:', e);
    }
  } else {
    console.warn('[Dashboard] electronAPI.launchWidget not available');
  }
}

// ==================== TODAY'S STATS ====================

async function loadTodayStats() {
  if (!clientCode) {
    console.log('[Dashboard] No client code, skipping stats load');
    return;
  }

  console.log('[Dashboard] Loading today\'s stats from unified endpoint...');

  try {
    // Use unified stats endpoint - single source of truth
    const response = await fetch(`${API_BASE_URL}/api/stats/unified?client_code=${encodeURIComponent(clientCode)}&rep_id=${encodeURIComponent(repId || '')}&period=today`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Unified stats loaded:', data);

    // Update stat cards from unified endpoint
    updateStatCard('stat-today-nudges', data.overall?.total_nudges || 0);
    updateStatCard('stat-today-used', data.overall?.total_adopted || 0);
    updateStatCard('stat-today-adoption', formatPercent((data.overall?.adoption_rate || 0) / 100));
    updateStatCard('stat-today-streak', data.streak || 0);

    // Update rank
    const rankSpan = document.getElementById('home-rank');
    if (rankSpan && data.rank) {
      rankSpan.textContent = data.rank;
    }

    // Show/hide rank banner based on whether we have rank data
    const rankBanner = document.getElementById('rank-banner');
    if (rankBanner) {
      rankBanner.style.display = data.rank ? 'flex' : 'none';
    }

    // Update recent activity with proper timestamps
    updateRecentActivity(data.recent_activity || []);

  } catch (e) {
    console.error('[Dashboard] Error loading stats:', e);
  }
}

function updateStatCard(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

function formatPercent(value) {
  if (typeof value === 'number') {
    return Math.round(value * 100) + '%';
  }
  return value;
}

// ==================== RECENT ACTIVITY ====================

function updateRecentActivity(activities) {
  const activityList = document.getElementById('activity-list');
  if (!activityList) return;

  if (!activities || activities.length === 0) {
    activityList.innerHTML = '<div class="activity-empty">No activity yet today. Launch the widget to start!</div>';
    return;
  }

  activityList.innerHTML = activities.map(activity => `
    <div class="activity-item">
      <div class="activity-icon">
        ${getActivityIcon(activity.type)}
      </div>
      <div class="activity-text">${escapeHtml(activity.text)}</div>
      <div class="activity-time">${formatTime(activity.timestamp)}</div>
    </div>
  `).join('');
}

function getActivityIcon(type) {
  switch (type) {
    case 'nudge_used':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'nudge_shown':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    case 'call_started':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function generateRepId(name) {
  if (!name) return null;
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_').substring(0, 20);
  const random = Math.random().toString(36).substring(2, 8);
  return `${normalized}_${random}`;
}

// ==================== PERFORMANCE TAB ====================

let currentPerfPeriod = 'today';

function setupPerformanceTab() {
  // Period filter buttons
  const periodBtns = document.querySelectorAll('.period-btn');
  periodBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      periodBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPerfPeriod = btn.dataset.period;
      loadPerformanceStats();
    });
  });
}

async function loadPerformanceStats() {
  if (!clientCode) return;

  console.log('[Dashboard] Loading performance stats for period:', currentPerfPeriod);

  try {
    // Use unified stats endpoint - single source of truth
    const response = await fetch(`${API_BASE_URL}/api/stats/unified?client_code=${encodeURIComponent(clientCode)}&rep_id=${encodeURIComponent(repId || '')}&period=${currentPerfPeriod}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Performance stats (unified):', data);

    // Update performance stats from unified endpoint
    updateStatCard('perf-total-nudges', data.overall?.total_nudges || 0);
    updateStatCard('perf-nudges-used', data.overall?.total_adopted || 0);
    updateStatCard('perf-adoption-rate', formatPercent((data.overall?.adoption_rate || 0) / 100));
    updateStatCard('perf-current-streak', data.streak || 0);

    // Category breakdown from unified endpoint
    const categories = data.categories || {};
    const categoryDisplay = {};
    for (const [cat, stats] of Object.entries(categories)) {
      categoryDisplay[cat] = stats.shown || 0;
    }
    updateCategoryBreakdown(categoryDisplay);

    // Generate insights from unified data
    const insights = generateInsights(data);
    updateInsights(insights);

  } catch (e) {
    console.error('[Dashboard] Error loading performance stats:', e);
  }
}

function generateInsights(data) {
  const insights = [];
  const categories = data.categories || {};
  const overall = data.overall || {};

  // Find best and worst categories
  let bestCat = null, worstCat = null;
  let bestRate = -1, worstRate = 101;

  for (const [cat, stats] of Object.entries(categories)) {
    if (stats.shown > 0) {
      const rate = (stats.adopted / stats.shown) * 100;
      if (rate > bestRate) {
        bestRate = rate;
        bestCat = cat;
      }
      if (rate < worstRate) {
        worstRate = rate;
        worstCat = cat;
      }
    }
  }

  if (bestCat && bestRate > 50) {
    insights.push({
      type: 'success',
      text: `Great job on ${bestCat} objections! ${Math.round(bestRate)}% adoption rate.`
    });
  }

  if (worstCat && worstRate < 30 && categories[worstCat].shown >= 3) {
    insights.push({
      type: 'warning',
      text: `${worstCat.charAt(0).toUpperCase() + worstCat.slice(1)} objections need attention. Try using more nudges!`
    });
  }

  if (overall.adoption_rate > 60) {
    insights.push({
      type: 'improvement',
      text: `You're in the top performers with ${overall.adoption_rate}% overall adoption!`
    });
  }

  if (data.streak >= 3) {
    insights.push({
      type: 'success',
      text: `${data.streak} day streak! Keep using nudges daily to maintain it.`
    });
  }

  return insights;
}

function updateCategoryBreakdown(categories) {
  const categoryMap = {
    price: 'cat-price',
    timing: 'cat-timing',
    authority: 'cat-authority',
    competition: 'cat-competition',
    trust: 'cat-trust',
    interest: 'cat-interest'
  };

  // Find max for percentage calculation
  const values = Object.values(categories);
  const maxValue = Math.max(...values, 1);

  for (const [category, elementId] of Object.entries(categoryMap)) {
    const count = categories[category] || 0;
    const percentage = (count / maxValue) * 100;

    const countEl = document.getElementById(elementId);
    const barEl = document.getElementById(`${elementId}-bar`);

    if (countEl) countEl.textContent = count;
    if (barEl) barEl.style.width = `${percentage}%`;
  }
}

function updateInsights(insights) {
  const insightsList = document.getElementById('insights-list');
  if (!insightsList) return;

  if (!insights || insights.length === 0) {
    insightsList.innerHTML = `
      <div class="insight-card">
        <div class="insight-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </div>
        <div class="insight-text">Use more nudges to unlock personalized insights!</div>
      </div>
    `;
    return;
  }

  insightsList.innerHTML = insights.map(insight => `
    <div class="insight-card">
      <div class="insight-icon">
        ${getInsightIcon(insight.type)}
      </div>
      <div class="insight-text">${escapeHtml(insight.text)}</div>
    </div>
  `).join('');
}

function getInsightIcon(type) {
  switch (type) {
    case 'improvement':
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
    case 'warning':
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    case 'success':
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }
}

// ==================== LEADERBOARD TAB ====================

let currentLbPeriod = 'week';
let currentLbMetric = 'adoption';

function setupLeaderboardTab() {
  const periodFilter = document.getElementById('lb-period-filter');
  const metricFilter = document.getElementById('lb-metric-filter');

  if (periodFilter) {
    periodFilter.addEventListener('change', () => {
      currentLbPeriod = periodFilter.value;
      loadLeaderboard();
    });
  }

  if (metricFilter) {
    metricFilter.addEventListener('change', () => {
      currentLbMetric = metricFilter.value;
      loadLeaderboard();
    });
  }
}

async function loadLeaderboard() {
  if (!clientCode) return;

  console.log('[Dashboard] Loading leaderboard:', currentLbPeriod, currentLbMetric);

  try {
    // Use new leaderboard endpoint
    const response = await fetch(`${API_BASE_URL}/api/stats/leaderboard?client_code=${encodeURIComponent(clientCode)}&period=${currentLbPeriod}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Leaderboard data:', data);

    // Find your position from the leaderboard
    const leaderboard = data.leaderboard || [];
    let yourPosition = { rank: null, value: 0 };

    if (repId) {
      const repBase = repId.split('_')[0].toLowerCase();
      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const entryBase = (entry.rep_id || '').split('_')[0].toLowerCase();
        if (entryBase === repBase || entry.name?.toLowerCase() === repBase) {
          yourPosition = {
            rank: i + 1,
            value: currentLbMetric === 'adoption' ? entry.adoption_rate : entry.total_nudges
          };
          break;
        }
      }
    }

    updateYourPosition(yourPosition);
    updateLeaderboardTable(leaderboard);

  } catch (e) {
    console.error('[Dashboard] Error loading leaderboard:', e);
    // Show error in table
    const tbody = document.getElementById('leaderboard-body');
    if (tbody) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Failed to load leaderboard</td></tr>';
    }
  }
}

function updateYourPosition(position) {
  const rankEl = document.getElementById('your-lb-rank');
  const valueEl = document.getElementById('your-lb-value');

  if (rankEl) rankEl.textContent = position.rank ? `#${position.rank}` : '#-';
  if (valueEl) {
    if (currentLbMetric === 'adoption') {
      // adoption_rate is already a percentage (e.g., 28.2), so divide by 100 for formatPercent
      valueEl.textContent = formatPercent((position.value || 0) / 100);
    } else {
      valueEl.textContent = position.value || 0;
    }
  }
}

function updateLeaderboardTable(rankings) {
  const tbody = document.getElementById('leaderboard-body');
  if (!tbody) return;

  if (!rankings || rankings.length === 0) {
    tbody.innerHTML = '<tr class="loading-row"><td colspan="6">No data available</td></tr>';
    return;
  }

  tbody.innerHTML = rankings.map((rep, index) => {
    const rank = rep.rank || (index + 1);
    // Check if this is the current user (compare base names)
    const repBase = (rep.rep_id || '').split('_')[0].toLowerCase();
    const myBase = (repId || '').split('_')[0].toLowerCase();
    const isYou = repBase && myBase && (repBase === myBase || rep.name?.toLowerCase() === myBase);
    const rankBadge = getRankBadge(rank);

    return `
      <tr class="${isYou ? 'is-you' : ''}">
        <td class="col-rank">${rankBadge}</td>
        <td class="col-name">${escapeHtml(rep.name || rep.rep_name || 'Unknown')}${isYou ? ' (You)' : ''}</td>
        <td class="col-nudges">${rep.total_nudges || rep.nudges_shown || 0}</td>
        <td class="col-used">${rep.adopted || rep.nudges_used || 0}</td>
        <td class="col-adoption">${formatPercent((rep.adoption_rate || 0) / 100)}</td>
        <td class="col-streak">${rep.streak || 0}</td>
      </tr>
    `;
  }).join('');
}

function getRankBadge(rank) {
  if (rank === 1) return '<span class="rank-badge gold">1</span>';
  if (rank === 2) return '<span class="rank-badge silver">2</span>';
  if (rank === 3) return '<span class="rank-badge bronze">3</span>';
  return `<span>${rank}</span>`;
}

// ==================== TUTORIAL TAB ====================

function setupTutorialTab() {
  // VB-Cable link
  const vbCableLink = document.getElementById('vb-cable-link');
  if (vbCableLink) {
    vbCableLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.openExternal) {
        window.electronAPI.openExternal('https://vb-audio.com/Cable/');
      }
    });
  }

  // Open Sound Settings button
  const soundSettingsBtn = document.getElementById('btn-open-sound-settings');
  if (soundSettingsBtn) {
    soundSettingsBtn.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.runCommand) {
        window.electronAPI.runCommand('mmsys.cpl');
      }
    });
  }

  // FAQ accordion
  const faqQuestions = document.querySelectorAll('.faq-question');
  faqQuestions.forEach(question => {
    question.addEventListener('click', () => {
      const faqItem = question.closest('.faq-item');
      const isOpen = faqItem.classList.contains('open');

      // Close all FAQs
      document.querySelectorAll('.faq-item').forEach(item => item.classList.remove('open'));

      // Open clicked one if it wasn't open
      if (!isOpen) {
        faqItem.classList.add('open');
      }
    });
  });
}

// ==================== SETTINGS TAB ====================

function setupSettingsTab() {
  // Update account info
  updateSettingsInfo();

  // Logout button
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  // Check for updates
  const checkUpdatesRow = document.getElementById('setting-check-updates');
  if (checkUpdatesRow) {
    checkUpdatesRow.addEventListener('click', checkForUpdates);
  }

  // Load app version
  loadAppVersion();

  // Setup toggle switches
  setupToggles();
}

function updateSettingsInfo() {
  const nameEl = document.getElementById('settings-name');
  const companyEl = document.getElementById('settings-company');
  const clientCodeEl = document.getElementById('settings-client-code');

  // Try multiple sources: clientInfo (from electronAPI), then localStorage
  const repName = clientInfo?.rep_name || localStorage.getItem('callsteer_rep_name') || '-';
  const companyName = clientInfo?.company_name || localStorage.getItem('callsteer_company_name') || '-';
  const code = clientCode || localStorage.getItem('callsteer_client_code') || '-';

  if (nameEl) nameEl.textContent = repName;
  if (companyEl) companyEl.textContent = companyName;
  if (clientCodeEl) clientCodeEl.textContent = code;

  console.log('[Dashboard] Settings loaded:', { repName, companyName, clientCode: code });
}

async function loadAppVersion() {
  const versionEl = document.getElementById('settings-version');
  if (!versionEl) return;

  if (window.electronAPI && window.electronAPI.getAppVersion) {
    try {
      const version = await window.electronAPI.getAppVersion();
      versionEl.textContent = `v${version}`;
      console.log('[Dashboard] App version:', version);
    } catch (e) {
      console.error('[Dashboard] Error getting version:', e);
      versionEl.textContent = 'v1.0.0';  // Fallback
    }
  } else {
    versionEl.textContent = 'v1.0.0';  // Fallback when not in Electron
  }
}

async function checkForUpdates() {
  console.log('[Dashboard] Checking for updates...');
  if (window.electronAPI && window.electronAPI.checkForUpdates) {
    try {
      await window.electronAPI.checkForUpdates();
    } catch (e) {
      console.error('[Dashboard] Error checking for updates:', e);
    }
  }
}

async function handleLogout() {
  console.log('[Dashboard] Logging out...');

  // Clear electronAPI stored credentials (this clears the JSON config file)
  if (window.electronAPI) {
    try {
      await window.electronAPI.clearClientCode();
      console.log('[Dashboard] Credentials cleared');

      // Also logout the widget window if it's open
      await window.electronAPI.logoutWidget();
      console.log('[Dashboard] Widget logout triggered');
    } catch (e) {
      console.error('[Dashboard] Error clearing client code:', e);
    }
  }

  // Clear local state
  clientCode = null;
  clientInfo = null;

  // Clear login form (keep code and rep ID, just clear PIN for security)
  const pinInput = document.getElementById('dashboard-pin');
  const errorEl = document.getElementById('dashboard-login-error');
  if (pinInput) pinInput.value = '';
  if (errorEl) errorEl.textContent = '';

  // Show login screen
  showLoginScreen();
  setupLoginForm();

  console.log('[Dashboard] Logged out, showing login screen');
}

// Shared localStorage keys for widget-dashboard sync
const SETTINGS_KEYS = {
  'toggle-notifications': 'callsteer_nudge_sound',       // 'on' or 'off'
  'toggle-auto-copy': 'callsteer_auto_copy',             // 'true' or 'false'
  'toggle-always-on-top': 'callsteer_always_on_top'      // 'true' or 'false'
};

function setupToggles() {
  // Persist settings to localStorage for widget sync
  Object.entries(SETTINGS_KEYS).forEach(([toggleId, storageKey]) => {
    const toggle = document.getElementById(toggleId);
    if (toggle) {
      // Load saved state
      const savedValue = localStorage.getItem(storageKey);
      if (savedValue !== null) {
        // For nudge sound: 'on' = checked, 'off' = unchecked
        // For others: 'true' = checked, 'false' = unchecked
        if (toggleId === 'toggle-notifications') {
          toggle.checked = savedValue !== 'off';
        } else {
          toggle.checked = savedValue === 'true';
        }
      }

      // Save on change
      toggle.addEventListener('change', () => {
        let value;
        if (toggleId === 'toggle-notifications') {
          value = toggle.checked ? 'on' : 'off';
        } else {
          value = toggle.checked ? 'true' : 'false';
        }
        localStorage.setItem(storageKey, value);
        console.log(`[Dashboard] Setting ${storageKey}:`, value);

        // For always-on-top, also notify main process
        if (toggleId === 'toggle-always-on-top' && window.electronAPI?.setAlwaysOnTop) {
          window.electronAPI.setAlwaysOnTop(toggle.checked);
        }
      });
    }
  });
}

// ==================== TAB LOAD HANDLERS ====================

function onTabSwitch(tabId) {
  switch (tabId) {
    case 'performance':
      loadPerformanceStats();
      break;
    case 'leaderboard':
      loadLeaderboard();
      break;
    case 'playbook':
      loadPlaybook();
      loadMySuggestionsCount();
      break;
    case 'settings':
      updateSettingsInfo();
      break;
  }
}

// Override switchTab to include data loading
const originalSwitchTab = switchTab;
switchTab = function(tabId) {
  originalSwitchTab(tabId);
  onTabSwitch(tabId);
};

// ==================== PLAYBOOK TAB ====================
// NOTE: Playbook editing (add/edit/delete nudges) is handled via the Admin portal.
// Reps can view team nudges and suggest new ones using the suggestion system below.

let playbookData = [];

function setupPlaybookTab() {
  // Suggestion modal setup
  const suggestBtn = document.getElementById('btn-suggest-nudge');
  if (suggestBtn) {
    suggestBtn.addEventListener('click', openSuggestionModal);
  }

  const suggestionCloseBtn = document.getElementById('suggestion-modal-close');
  if (suggestionCloseBtn) {
    suggestionCloseBtn.addEventListener('click', closeSuggestionModal);
  }

  const cancelSuggestionBtn = document.getElementById('btn-cancel-suggestion');
  if (cancelSuggestionBtn) {
    cancelSuggestionBtn.addEventListener('click', closeSuggestionModal);
  }

  const suggestionForm = document.getElementById('suggestion-form');
  if (suggestionForm) {
    suggestionForm.addEventListener('submit', handleSuggestionSubmit);
  }

  const suggestionModal = document.getElementById('suggestion-modal');
  if (suggestionModal) {
    suggestionModal.addEventListener('click', (e) => {
      if (e.target === suggestionModal) closeSuggestionModal();
    });
  }

  // My suggestions modal
  const mySuggestionsBtn = document.getElementById('btn-my-suggestions');
  if (mySuggestionsBtn) {
    mySuggestionsBtn.addEventListener('click', openMySuggestionsModal);
  }

  const mySuggestionsClose = document.getElementById('my-suggestions-close');
  if (mySuggestionsClose) {
    mySuggestionsClose.addEventListener('click', closeMySuggestionsModal);
  }

  const mySuggestionsModal = document.getElementById('my-suggestions-modal');
  if (mySuggestionsModal) {
    mySuggestionsModal.addEventListener('click', (e) => {
      if (e.target === mySuggestionsModal) closeMySuggestionsModal();
    });
  }
}

async function loadPlaybook() {
  if (!clientCode) return;

  console.log('[Dashboard] Loading playbook...');

  try {
    const response = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/nudges`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Playbook data:', data);

    playbookData = data.nudges || [];

    // Update stats
    updatePlaybookStats(data);

    // Render nudge list
    renderPlaybookList(playbookData);

  } catch (e) {
    console.error('[Dashboard] Error loading playbook:', e);
    document.getElementById('playbook-empty').style.display = 'flex';
  }
}

async function loadPlaybookAnalytics() {
  if (!clientCode) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/analytics`);

    if (response.ok) {
      const analytics = await response.json();
      document.getElementById('playbook-total').textContent = analytics.total_nudges || 0;
      document.getElementById('playbook-active').textContent = analytics.active_nudges || 0;
      document.getElementById('playbook-adoption').textContent = `${analytics.adoption_rate || 0}%`;
      document.getElementById('playbook-triggered').textContent = analytics.total_triggered || 0;
    }
  } catch (e) {
    console.error('[Dashboard] Error loading playbook analytics:', e);
  }
}

function updatePlaybookStats(data) {
  const nudges = data.nudges || [];
  const active = nudges.filter(n => n.is_active).length;
  const totalTriggered = nudges.reduce((sum, n) => sum + (n.times_triggered || 0), 0);
  const totalAdopted = nudges.reduce((sum, n) => sum + (n.times_adopted || 0), 0);
  const adoptionRate = totalTriggered > 0 ? Math.round((totalAdopted / totalTriggered) * 100) : 0;

  document.getElementById('playbook-total').textContent = nudges.length;
  document.getElementById('playbook-active').textContent = active;
  document.getElementById('playbook-adoption').textContent = `${adoptionRate}%`;
  document.getElementById('playbook-triggered').textContent = totalTriggered;
}

function renderPlaybookList(nudges) {
  const container = document.getElementById('playbook-list');
  const emptyState = document.getElementById('playbook-empty');

  if (!nudges || nudges.length === 0) {
    emptyState.style.display = 'flex';
    // Remove any existing nudge cards
    container.querySelectorAll('.playbook-card').forEach(el => el.remove());
    return;
  }

  emptyState.style.display = 'none';

  // Remove existing cards
  container.querySelectorAll('.playbook-card').forEach(el => el.remove());

  // Add nudge cards
  nudges.forEach(nudge => {
    const card = document.createElement('div');
    card.className = `playbook-card ${nudge.is_active ? '' : 'inactive'}`;
    card.innerHTML = `
      <div class="playbook-card-header">
        <div class="playbook-category">${escapeHtml(nudge.category)}</div>
        <div class="playbook-status ${nudge.is_active ? 'active' : 'inactive'}">
          ${nudge.is_active ? 'Active' : 'Inactive'}
        </div>
      </div>
      <div class="playbook-trigger">
        <span class="trigger-label">Trigger:</span>
        <span class="trigger-phrase">"${escapeHtml(nudge.trigger_phrase)}"</span>
        <span class="trigger-type">${nudge.trigger_type}</span>
      </div>
      <div class="playbook-response">
        <strong>Response:</strong> ${escapeHtml(nudge.base_response)}
      </div>
      ${nudge.ai_variations && nudge.ai_variations.length > 0 ? `
        <div class="playbook-variations">
          <span class="variations-label">${nudge.ai_variations.length} AI variations</span>
        </div>
      ` : ''}
      <div class="playbook-stats-row">
        <span>Triggered: ${nudge.times_triggered || 0}</span>
        <span>Adopted: ${nudge.times_adopted || 0}</span>
        <span>Effectiveness: ${nudge.effectiveness || 0}%</span>
      </div>
      <div class="playbook-card-footer">
        <span class="view-only-badge">Team Nudge</span>
      </div>
    `;
    container.appendChild(card);
  });
}

// ==================== SUGGESTION FUNCTIONS ====================

function openSuggestionModal() {
  const modal = document.getElementById('suggestion-modal');
  const form = document.getElementById('suggestion-form');
  const successMsg = document.getElementById('suggestion-success');

  if (form) form.reset();
  if (successMsg) successMsg.style.display = 'none';
  if (modal) modal.style.display = 'flex';
}

function closeSuggestionModal() {
  const modal = document.getElementById('suggestion-modal');
  if (modal) modal.style.display = 'none';
}

async function handleSuggestionSubmit(e) {
  e.preventDefault();

  const trigger = document.getElementById('suggestion-trigger').value.trim();
  const response = document.getElementById('suggestion-response').value.trim();
  const category = document.getElementById('suggestion-category').value;
  const context = document.getElementById('suggestion-context').value.trim();

  if (!trigger || !response) {
    alert('Please fill in the required fields');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-suggestion');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  try {
    const res = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/suggestions?rep_id=${encodeURIComponent(repId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_phrase: trigger,
        suggested_response: response,
        category: category || null,
        context: context || null
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.error('[Dashboard] Suggestion error:', res.status, errorData);
      throw new Error(errorData.detail || `HTTP ${res.status}`);
    }

    console.log('[Dashboard] Suggestion submitted successfully');

    // Show success message
    const form = document.getElementById('suggestion-form');
    const successMsg = document.getElementById('suggestion-success');
    if (form) form.style.display = 'none';
    if (successMsg) successMsg.style.display = 'flex';

    // Update suggestions count
    loadMySuggestionsCount();

    // Close modal after delay
    setTimeout(() => {
      closeSuggestionModal();
      if (form) form.style.display = 'block';
    }, 2000);

  } catch (err) {
    console.error('[Dashboard] Error submitting suggestion:', err);
    alert(`Failed to submit suggestion: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit for Review';
  }
}

function openMySuggestionsModal() {
  const modal = document.getElementById('my-suggestions-modal');
  if (modal) modal.style.display = 'flex';
  loadMySuggestions();
}

function closeMySuggestionsModal() {
  const modal = document.getElementById('my-suggestions-modal');
  if (modal) modal.style.display = 'none';
}

async function loadMySuggestions() {
  const container = document.getElementById('my-suggestions-list');
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/suggestions?rep_id=${encodeURIComponent(repId)}`);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const suggestions = data.suggestions || [];

    if (suggestions.length === 0) {
      container.innerHTML = `
        <div class="empty-suggestions">
          <p>You haven't submitted any suggestions yet.</p>
          <p>When you find a rebuttal that works well, share it with your team!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = suggestions.map(s => `
      <div class="suggestion-item ${s.status}">
        <div class="suggestion-header">
          <span class="suggestion-status status-${s.status}">${s.status}</span>
          <span class="suggestion-date">${formatSuggestionDate(s.created_at)}</span>
        </div>
        <div class="suggestion-trigger">"${escapeHtml(s.trigger_phrase)}"</div>
        <div class="suggestion-response">${escapeHtml(s.suggested_response)}</div>
        ${s.admin_notes ? `<div class="suggestion-notes"><strong>Admin notes:</strong> ${escapeHtml(s.admin_notes)}</div>` : ''}
      </div>
    `).join('');

  } catch (err) {
    console.error('[Dashboard] Error loading suggestions:', err);
    container.innerHTML = '<div class="error">Failed to load suggestions</div>';
  }
}

async function loadMySuggestionsCount() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/suggestions?rep_id=${encodeURIComponent(repId)}`);

    if (res.ok) {
      const data = await res.json();
      const count = (data.suggestions || []).filter(s => s.status === 'pending').length;
      const badge = document.getElementById('my-suggestions-count');
      if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline' : 'none';
      }
    }
  } catch (err) {
    console.error('[Dashboard] Error loading suggestions count:', err);
  }
}

function formatSuggestionDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp.endsWith('Z') ? timestamp : timestamp + 'Z');
  return date.toLocaleDateString();
}

// ==================== START ====================

async function initDashboardComplete() {
  await initDashboard();

  // Setup all tab functionality
  setupPerformanceTab();
  setupLeaderboardTab();
  setupPlaybookTab();
  setupTutorialTab();
  setupSettingsTab();
}

document.addEventListener('DOMContentLoaded', initDashboardComplete);
