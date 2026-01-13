// CallSteer Dashboard JavaScript

const API_BASE_URL = 'https://callsteer-backend-production.up.railway.app';

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
}

async function handleDashboardLogin(e) {
  e.preventDefault();

  const nameInput = document.getElementById('dashboard-rep-name');
  const codeInput = document.getElementById('dashboard-client-code');
  const errorEl = document.getElementById('dashboard-login-error');
  const submitBtn = document.getElementById('dashboard-login-btn');

  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();

  if (!name || !code) {
    errorEl.textContent = 'Please enter your name and company code';
    return;
  }

  // Show loading state
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    // Validate client code with backend
    console.log('[Dashboard] Validating client code:', code);
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/clients/${code}`);
    } catch (fetchError) {
      console.error('[Dashboard] Fetch failed:', fetchError);
      throw new Error('Could not connect to server. Check your internet connection.');
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Invalid company code');
      } else {
        console.error('[Dashboard] HTTP error:', response.status, response.statusText);
        throw new Error(`Server error (${response.status})`);
      }
    }

    const data = await response.json();
    console.log('[Dashboard] Got client data:', data);

    // Save credentials
    clientCode = code;
    clientInfo = {
      client_code: code,
      company_name: data.company_name,
      has_dna: data.has_dna,
      rep_name: name
    };

    if (window.electronAPI) {
      await window.electronAPI.saveClientCode(code);
      await window.electronAPI.saveClientInfo(clientInfo);
    }

    console.log('[Dashboard] Login successful:', name, code);

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
    } catch (e) {
      console.error('[Dashboard] Error clearing client code:', e);
    }
  }

  // Clear local state
  clientCode = null;
  clientInfo = null;

  // Clear login form
  const nameInput = document.getElementById('dashboard-rep-name');
  const codeInput = document.getElementById('dashboard-client-code');
  const errorEl = document.getElementById('dashboard-login-error');
  if (nameInput) nameInput.value = '';
  if (codeInput) codeInput.value = '';
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

let currentEditNudgeId = null;
let playbookData = [];

function setupPlaybookTab() {
  // Setup Add Nudge button
  const addBtn = document.getElementById('btn-add-nudge');
  if (addBtn) {
    addBtn.addEventListener('click', () => openPlaybookModal());
  }

  // Setup modal close button
  const closeBtn = document.getElementById('modal-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closePlaybookModal);
  }

  // Setup cancel button
  const cancelBtn = document.getElementById('btn-cancel-nudge');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closePlaybookModal);
  }

  // Setup form submit
  const form = document.getElementById('playbook-form');
  if (form) {
    form.addEventListener('submit', handlePlaybookSubmit);
  }

  // Close modal when clicking overlay
  const modal = document.getElementById('playbook-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePlaybookModal();
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
      <div class="playbook-actions">
        <button class="btn-edit" onclick="editNudge(${nudge.id})">Edit</button>
        <button class="btn-toggle" onclick="toggleNudge(${nudge.id}, ${!nudge.is_active})">
          ${nudge.is_active ? 'Disable' : 'Enable'}
        </button>
        <button class="btn-delete" onclick="deleteNudge(${nudge.id})">Delete</button>
      </div>
    `;
    container.appendChild(card);
  });
}

function openPlaybookModal(nudge = null) {
  const modal = document.getElementById('playbook-modal');
  const title = document.getElementById('modal-title');
  const form = document.getElementById('playbook-form');

  if (nudge) {
    // Edit mode
    currentEditNudgeId = nudge.id;
    title.textContent = 'Edit Custom Nudge';
    document.getElementById('nudge-trigger').value = nudge.trigger_phrase;
    document.getElementById('nudge-trigger-type').value = nudge.trigger_type;
    document.getElementById('nudge-category').value = nudge.category;
    document.getElementById('nudge-response').value = nudge.base_response;
  } else {
    // Add mode
    currentEditNudgeId = null;
    title.textContent = 'Add Custom Nudge';
    form.reset();
  }

  modal.style.display = 'flex';
}

function closePlaybookModal() {
  const modal = document.getElementById('playbook-modal');
  modal.style.display = 'none';
  currentEditNudgeId = null;
}

async function handlePlaybookSubmit(e) {
  e.preventDefault();

  const trigger = document.getElementById('nudge-trigger').value.trim();
  const triggerType = document.getElementById('nudge-trigger-type').value;
  const category = document.getElementById('nudge-category').value.trim();
  const response = document.getElementById('nudge-response').value.trim();

  if (!trigger || !category || !response) {
    alert('Please fill in all required fields');
    return;
  }

  const saveBtn = document.getElementById('btn-save-nudge');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    let url, method;
    const body = {
      trigger_phrase: trigger,
      trigger_type: triggerType,
      category: category,
      base_response: response
    };

    if (currentEditNudgeId) {
      // Update existing
      url = `${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/nudges/${currentEditNudgeId}`;
      method = 'PATCH';
    } else {
      // Create new
      url = `${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/nudges`;
      method = 'POST';
      body.created_by = clientInfo?.rep_name || 'Manager';
    }

    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    console.log('[Dashboard] Nudge saved:', data);

    closePlaybookModal();
    await loadPlaybook();

  } catch (err) {
    console.error('[Dashboard] Error saving nudge:', err);
    alert('Failed to save nudge. Please try again.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Nudge';
  }
}

function editNudge(nudgeId) {
  const nudge = playbookData.find(n => n.id === nudgeId);
  if (nudge) {
    openPlaybookModal(nudge);
  }
}

async function toggleNudge(nudgeId, newState) {
  try {
    const res = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/nudges/${nudgeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newState })
    });

    if (res.ok) {
      await loadPlaybook();
    }
  } catch (err) {
    console.error('[Dashboard] Error toggling nudge:', err);
  }
}

async function deleteNudge(nudgeId) {
  if (!confirm('Are you sure you want to delete this nudge?')) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/playbook/${encodeURIComponent(clientCode)}/nudges/${nudgeId}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      await loadPlaybook();
    }
  } catch (err) {
    console.error('[Dashboard] Error deleting nudge:', err);
    alert('Failed to delete nudge.');
  }
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
