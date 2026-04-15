const $ = (sel) => document.querySelector(sel);

const statusBadge = $('#statusBadge');
const statusText = statusBadge.querySelector('.status-text');
const infoSection = $('#infoSection');
const syncToggle = $('#syncToggle');

let lastSyncTimestamp = null;
let refreshTimer = null;
let savedConfig = {};

// --- Init ---

async function init() {
  const config = await browser.runtime.sendMessage({ type: 'get_config' });
  savedConfig = { serverUrl: config.serverUrl, syncToken: config.syncToken, deviceName: config.deviceName };
  if (config.serverUrl) $('#serverUrl').value = config.serverUrl;
  if (config.deviceName) $('#deviceName').value = config.deviceName;
  if (config.syncToken) $('#syncToken').value = config.syncToken;

  const status = await browser.runtime.sendMessage({ type: 'get_status' });
  updateUI(status);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status_update') {
      updateStatus(msg.status);
      if (msg.lastSyncTime) {
        lastSyncTimestamp = msg.lastSyncTime;
        updateLastSync(msg.lastSyncTime);
        scheduleRefresh();
      }
    }
  });

  syncToggle.addEventListener('change', onToggleChange);
  $('#forcePushBtn').addEventListener('click', forcePush);
  $('#forcePullBtn').addEventListener('click', forcePull);

  for (const id of ['serverUrl', 'syncToken', 'deviceName']) {
    $(`#${id}`).addEventListener('change', onConfigChange);
  }
}

// --- Actions ---

async function onToggleChange() {
  const enabled = syncToggle.checked;

  if (enabled) {
    const serverUrl = $('#serverUrl').value.trim();
    const token = $('#syncToken').value.trim();
    const deviceName = $('#deviceName').value.trim() || `Zen-${Date.now().toString(36)}`;

    if (!serverUrl || !token) {
      syncToggle.checked = false;
      alert('Server URL and Sync Token are required.');
      return;
    }

    await browser.runtime.sendMessage({
      type: 'connect',
      serverUrl,
      token,
      deviceName,
    });
  } else {
    await browser.runtime.sendMessage({ type: 'disconnect' });
    infoSection.classList.add('hidden');
    updateStatus('disconnected');
  }
}

async function onConfigChange() {
  const serverUrl = $('#serverUrl').value.trim();
  const token = $('#syncToken').value.trim();
  const deviceName = $('#deviceName').value.trim();

  // Only save + reconnect if something actually changed
  if (serverUrl === savedConfig.serverUrl && token === savedConfig.syncToken && deviceName === savedConfig.deviceName) {
    return;
  }

  savedConfig = { serverUrl, syncToken: token, deviceName };

  await browser.runtime.sendMessage({
    type: 'save_config',
    serverUrl,
    token,
    deviceName,
  });

  if (syncToggle.checked && serverUrl && token) {
    await browser.runtime.sendMessage({
      type: 'connect',
      serverUrl,
      token,
      deviceName,
    });
  }
}

async function forcePush() {
  const result = await browser.runtime.sendMessage({ type: 'force_push' });
  if (result.success) {
    $('#forcePushBtn').textContent = 'Pushed!';
    setTimeout(() => { $('#forcePushBtn').textContent = 'Force Push'; }, 1500);
  }
}

async function forcePull() {
  const result = await browser.runtime.sendMessage({ type: 'force_pull' });
  if (result.success) {
    $('#forcePullBtn').textContent = 'Pulled!';
    setTimeout(() => { $('#forcePullBtn').textContent = 'Force Pull'; }, 1500);
  }
}

// --- UI ---

function updateUI(status) {
  if (!status) return;

  updateStatus(status.syncStatus);
  syncToggle.checked = status.syncEnabled;

  if (status.syncEnabled && status.syncStatus === 'connected') {
    infoSection.classList.remove('hidden');
  } else {
    infoSection.classList.add('hidden');
  }

  if (status.state) updateStats(status.state);
  if (status.lastSyncTime) {
    lastSyncTimestamp = status.lastSyncTime;
    updateLastSync(status.lastSyncTime);
    scheduleRefresh();
  }
}

function updateStatus(status) {
  statusBadge.className = `status-badge ${status}`;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    connected: 'Connected',
    reconnecting: 'Reconnecting...',
    error: 'Error',
    auth_failed: 'Auth Failed',
    failed: 'Failed',
  };

  statusText.textContent = labels[status] || status;

  if (status === 'connected') {
    infoSection.classList.remove('hidden');
    browser.runtime.sendMessage({ type: 'get_status' }).then(s => {
      if (s?.state) updateStats(s.state);
    });
  } else if (status === 'auth_failed' || status === 'failed') {
    syncToggle.checked = false;
    infoSection.classList.add('hidden');
  }
}

function updateStats(state) {
  if (!state) return;

  const essentials = (state.essentials || []).length;
  const workspaces = (state.workspaces || []).length;
  let tabs = 0;
  for (const ws of (state.workspaces || [])) {
    tabs += (ws.tabs || []).length + (ws.pinnedTabs || []).length;
  }

  $('#essentialCount').textContent = essentials;
  $('#workspaceCount').textContent = workspaces;
  $('#tabCount').textContent = tabs;
}

function updateLastSync(timestamp) {
  if (!timestamp) return;
  const diff = Date.now() - timestamp;

  let text;
  if (diff < 5000) text = 'Just now';
  else if (diff < 60000) text = `${Math.floor(diff / 1000)}s ago`;
  else if (diff < 3600000) text = `${Math.floor(diff / 60000)}m ago`;
  else text = new Date(timestamp).toLocaleTimeString();

  $('#lastSync').textContent = text;
}

// Adaptive refresh: 1s when seconds display, 60s when minutes display
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!lastSyncTimestamp) return;

  const diff = Date.now() - lastSyncTimestamp;
  const delay = diff < 60000 ? 1000 : 60000;

  refreshTimer = setTimeout(() => {
    updateLastSync(lastSyncTimestamp);
    scheduleRefresh();
  }, delay);
}

init();
