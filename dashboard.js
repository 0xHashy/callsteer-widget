// CallSteer Dashboard JavaScript

const API_BASE_URL = 'https://callsteer-backend-production.up.railway.app';

let clientCode = null;
let clientInfo = null;

// ==================== INITIALIZATION ====================

async function initDashboard() {
  console.log('[Dashboard] Initializing...');

  // Load saved credentials
  if (window.electronAPI) {
    try {
      clientCode = await window.electronAPI.getClientCode();
      clientInfo = await window.electronAPI.getClientInfo();
      console.log('[Dashboard] Loaded client code:', clientCode ? 'present' : 'none');
    } catch (e) {
      console.error('[Dashboard] Error loading client info:', e);
    }
  }

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

// ==================== USER INFO ====================

function updateUserInfo() {
  const userName = clientInfo?.rep_name || 'Rep';
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

  console.log('[Dashboard] Loading today\'s stats...');

  try {
    const response = await fetch(`${API_BASE_URL}/api/stats/today?client_code=${encodeURIComponent(clientCode)}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Stats loaded:', data);

    // Update stat cards
    updateStatCard('stat-today-nudges', data.nudges_shown || 0);
    updateStatCard('stat-today-used', data.nudges_used || 0);
    updateStatCard('stat-today-adoption', formatPercent(data.adoption_rate || 0));
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

    // Update recent activity
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
    const response = await fetch(`${API_BASE_URL}/api/stats/performance?client_code=${encodeURIComponent(clientCode)}&period=${currentPerfPeriod}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Performance stats:', data);

    // Update performance stats
    updateStatCard('perf-total-nudges', data.nudges_shown || 0);
    updateStatCard('perf-nudges-used', data.nudges_used || 0);
    updateStatCard('perf-adoption-rate', formatPercent(data.adoption_rate || 0));
    updateStatCard('perf-current-streak', data.streak || 0);

    // Update category breakdown
    updateCategoryBreakdown(data.categories || {});

    // Update insights
    updateInsights(data.insights || []);

  } catch (e) {
    console.error('[Dashboard] Error loading performance stats:', e);
  }
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
    const response = await fetch(`${API_BASE_URL}/api/stats/leaderboard?client_code=${encodeURIComponent(clientCode)}&period=${currentLbPeriod}&metric=${currentLbMetric}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log('[Dashboard] Leaderboard data:', data);

    // Update your position
    updateYourPosition(data.your_position || {});

    // Update leaderboard table
    updateLeaderboardTable(data.rankings || []);

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
      valueEl.textContent = formatPercent(position.value || 0);
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
    const rank = index + 1;
    const isYou = rep.client_code === clientCode;
    const rankBadge = getRankBadge(rank);

    return `
      <tr class="${isYou ? 'is-you' : ''}">
        <td class="col-rank">${rankBadge}</td>
        <td class="col-name">${escapeHtml(rep.rep_name || 'Unknown')}${isYou ? ' (You)' : ''}</td>
        <td class="col-nudges">${rep.nudges_shown || 0}</td>
        <td class="col-used">${rep.nudges_used || 0}</td>
        <td class="col-adoption">${formatPercent(rep.adoption_rate || 0)}</td>
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

  if (nameEl) nameEl.textContent = clientInfo?.rep_name || '-';
  if (companyEl) companyEl.textContent = clientInfo?.company_name || '-';
  if (clientCodeEl) clientCodeEl.textContent = clientCode || '-';
}

async function loadAppVersion() {
  const versionEl = document.getElementById('settings-version');
  if (!versionEl) return;

  if (window.electronAPI && window.electronAPI.getAppVersion) {
    try {
      const version = await window.electronAPI.getAppVersion();
      versionEl.textContent = `v${version}`;
    } catch (e) {
      versionEl.textContent = '-';
    }
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

  if (window.electronAPI) {
    try {
      await window.electronAPI.clearClientCode();
      // Reload the app to show login
      window.location.reload();
    } catch (e) {
      console.error('[Dashboard] Error logging out:', e);
    }
  }
}

function setupToggles() {
  // These toggles would persist settings - for now they're visual only
  // In future, connect to electronAPI.savePreferences()
  const toggles = ['toggle-notifications', 'toggle-auto-copy', 'toggle-always-on-top'];
  toggles.forEach(toggleId => {
    const toggle = document.getElementById(toggleId);
    if (toggle) {
      toggle.addEventListener('change', () => {
        console.log(`[Dashboard] Toggle ${toggleId}:`, toggle.checked);
        // TODO: Persist preference
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

// ==================== START ====================

async function initDashboardComplete() {
  await initDashboard();

  // Setup all tab functionality
  setupPerformanceTab();
  setupLeaderboardTab();
  setupTutorialTab();
  setupSettingsTab();
}

document.addEventListener('DOMContentLoaded', initDashboardComplete);
