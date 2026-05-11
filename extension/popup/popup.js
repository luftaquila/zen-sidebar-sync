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
  try {
    const v = browser.runtime.getManifest()?.version;
    if (v) $('#extVersion').textContent = `v${v}`;
  } catch {}
  const config = await browser.runtime.sendMessage({ type: 'get_config' });
  savedConfig = { serverUrl: config.serverUrl, syncToken: config.syncToken, deviceName: config.deviceName };
  if (config.serverUrl) $('#serverUrl').value = config.serverUrl;
  if (config.deviceName) $('#deviceName').value = config.deviceName;
  if (config.syncToken) $('#syncToken').value = config.syncToken;

  const status = await browser.runtime.sendMessage({ type: 'get_status' });
  updateUI(status);

  // If the background had a pending initial-sync prompt at popup-open time.
  if (status?.pendingInitialInfo) {
    renderInitialSyncPrompt(status.pendingInitialInfo);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status_update') {
      if (msg.status === 'awaiting_initial_confirm' && msg.initialSyncInfo) {
        renderInitialSyncPrompt(msg.initialSyncInfo);
        return;
      }
      updateStatus(msg.status, msg);
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
  $('#confirmReplaceBtn').addEventListener('click', confirmInitialReplace);
  $('#cancelInitialBtn').addEventListener('click', cancelInitialSync);
  $('#adminDisableAllBtn').addEventListener('click', adminDisableAll);
  $('#adminResetStateBtn').addEventListener('click', adminResetState);

  for (const id of ['serverUrl', 'syncToken', 'deviceName']) {
    $(`#${id}`).addEventListener('change', onConfigChange);
  }
}

// Promise-based custom confirm. Resolves true on OK, false on Cancel / Esc /
// backdrop click. Used in place of window.confirm() so the destructive
// prompts match popup styling and aren't subject to browser modal quirks.
function customConfirm(message, { okText = 'OK', okClass = 'primary' } = {}) {
  return new Promise((resolve) => {
    const overlay = $('#confirmOverlay');
    const msg = $('#confirmMessage');
    const okBtn = $('#confirmOkBtn');
    const cancelBtn = $('#confirmCancelBtn');
    msg.textContent = message;
    okBtn.textContent = okText;
    okBtn.className = `btn ${okClass}`;
    overlay.classList.remove('hidden');
    const finish = (v) => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === overlay) finish(false); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

async function confirmInitialReplace() {
  if (!(await customConfirm('Replace local tabs and workspaces with the server\'s state?', { okText: 'Replace', okClass: 'danger' }))) return;
  const btn = $('#confirmReplaceBtn');
  btn.disabled = true; btn.textContent = 'Applying…';
  await browser.runtime.sendMessage({ type: 'confirm_initial_replace' });
  $('#initialSyncPrompt').classList.add('hidden');
  btn.disabled = false; btn.textContent = 'Replace local';
}

async function cancelInitialSync() {
  await browser.runtime.sendMessage({ type: 'cancel_initial_sync' });
  $('#initialSyncPrompt').classList.add('hidden');
  syncToggle.checked = false;
}

function renderInitialSyncPrompt(info) {
  const sec = $('#initialSyncPrompt');
  if (!info) { sec.classList.add('hidden'); return; }
  const ul = $('#initialSyncSummary');
  ul.innerHTML = '';
  for (const [label, n] of [
    ['workspaces', info.workspaces],
    ['folders', info.folders],
    ['essentials', info.essentials],
    ['tabs', info.tabs],
  ]) {
    const li = document.createElement('li');
    li.textContent = `${n} ${label}`;
    ul.appendChild(li);
  }
  sec.classList.remove('hidden');
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

async function adminDisableAll() {
  const ok = await customConfirm(
    'Turn off sync on EVERY connected device? Each device will need to be re-enabled manually.',
    { okText: 'Disable all', okClass: 'danger' },
  );
  if (!ok) return;
  const btn = $('#adminDisableAllBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  await browser.runtime.sendMessage({ type: 'admin_disable_all' });
  btn.disabled = false; btn.textContent = 'Sent';
  setTimeout(() => { btn.textContent = 'Disable sync on all'; }, 1500);
}

async function adminResetState() {
  const ok = await customConfirm(
    'WIPE all server-side sync state? Cannot be undone. Connected devices will see the empty state on next push.',
    { okText: 'Reset state', okClass: 'danger' },
  );
  if (!ok) return;
  const btn = $('#adminResetStateBtn');
  btn.disabled = true; btn.textContent = 'Resetting…';
  await browser.runtime.sendMessage({ type: 'admin_reset_state' });
  btn.disabled = false; btn.textContent = 'Reset';
  setTimeout(() => { btn.textContent = 'Reset server state'; }, 1500);
}

// --- UI ---

function updateUI(status) {
  if (!status) return;

  updateStatus(status.syncStatus, status);
  syncToggle.checked = status.syncEnabled;

  // Persistent errors override the sync-status badge for banner rendering.
  if (status.nativeMissing) renderBanner('native_missing', status);
  else if (status.schemaError) renderBanner('schema_mismatch', status);

  // Always show stats — they reflect the local tabMonitor capture and are
  // meaningful regardless of sync state. Hide-on-disconnect made the popup
  // look empty/broken when sync was off or reconnecting.
  infoSection.classList.remove('hidden');
  updateStats(status.state);
  if (status.lastSyncTime) {
    lastSyncTimestamp = status.lastSyncTime;
    updateLastSync(status.lastSyncTime);
    scheduleRefresh();
  }
}

function updateStatus(status, ctx = {}) {
  statusBadge.className = `status-badge ${status}`;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    connected: 'Connected',
    reconnecting: 'Reconnecting...',
    error: 'Error',
    auth_failed: 'Auth Failed',
    failed: 'Failed',
    schema_mismatch: 'Schema mismatch',
    native_missing: 'Native host missing',
  };

  statusText.textContent = labels[status] || status;
  renderBanner(status, ctx);

  // Always refresh stats on status change.
  browser.runtime.sendMessage({ type: 'get_status' }).then(s => {
    if (s) updateStats(s.state);
  });

  if (status === 'auth_failed' || status === 'failed' || status === 'schema_mismatch' || status === 'native_missing') {
    syncToggle.checked = false;
  }
}

function renderBanner(status, ctx) {
  let host = document.querySelector('#syncBanner');
  if (!host) {
    host = document.createElement('div');
    host.id = 'syncBanner';
    host.style.cssText = 'padding:8px;margin:8px;border-radius:6px;font-size:12px;display:none;';
    document.querySelector('.container')?.insertBefore(host, document.querySelector('.container')?.firstChild);
  }
  if (status === 'schema_mismatch') {
    host.style.display = 'block';
    host.style.background = '#fde7e7';
    host.style.color = '#900';
    host.textContent = ctx.schemaError || 'Server schema is incompatible. Reset server state.';
  } else if (status === 'native_missing') {
    host.style.display = 'block';
    host.style.background = '#fff4d6';
    host.style.color = '#7a4f00';
    host.textContent = 'Native messaging host not installed. Install it before enabling sync to avoid creating duplicate tabs.';
  } else {
    host.style.display = 'none';
  }
}

function updateStats(state) {
  if (!state || !Array.isArray(state.tabs)) {
    $('#essentialCount').textContent = '-';
    $('#workspaceCount').textContent = '-';
    $('#tabCount').textContent = '-';
    return;
  }
  const tabs = state.tabs;
  const essentials = tabs.filter(t => t.kind === 'essential').length;
  // "Tabs" excludes essentials so the three numbers don't double-count.
  const nonEssential = tabs.length - essentials;
  $('#essentialCount').textContent = essentials;
  $('#workspaceCount').textContent = (state.workspaces || []).length;
  $('#tabCount').textContent = nonEssential;
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
