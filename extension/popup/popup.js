import { parseInvite, buildInvite } from '../common/invite.js';

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

  // Name the device after the machine so the invite is the only thing to fill.
  if (!config.deviceName && status?.engineEnv?.hostName) {
    $('#deviceName').value = status.engineEnv.hostName;
  }

  if (status?.pendingInitialInfo) {
    renderInitialSyncPrompt(status.pendingInitialInfo);
  }
  if (status?.pendingGuardInfo) {
    renderGuardPrompt(status.pendingGuardInfo);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status_update') {
      if (msg.status === 'awaiting_initial_confirm' && msg.initialSyncInfo) {
        renderInitialSyncPrompt(msg.initialSyncInfo);
        return;
      }
      if (msg.status === 'apply_guard' && msg.guardInfo) {
        renderGuardPrompt(msg.guardInfo);
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
  $('#inviteInput').addEventListener('paste', (e) => {
    // Apply on paste (the common path) without waiting for a blur.
    const text = e.clipboardData?.getData('text');
    if (text) {
      e.preventDefault();
      $('#inviteInput').value = text.trim();
      applyInvite();
    }
  });
  $('#inviteInput').addEventListener('change', applyInvite);
  $('#copyInviteBtn').addEventListener('click', copyInvite);
  $('#forcePushBtn').addEventListener('click', forcePush);
  $('#forcePullBtn').addEventListener('click', forcePull);
  $('#confirmReplaceBtn').addEventListener('click', confirmInitialReplace);
  $('#confirmPushBtn').addEventListener('click', confirmInitialPush);
  $('#cancelInitialBtn').addEventListener('click', cancelInitialSync);
  $('#confirmGuardBtn').addEventListener('click', confirmApplyGuard);
  $('#rejectGuardBtn').addEventListener('click', rejectApplyGuard);
  $('#adminDisableAllBtn').addEventListener('click', adminDisableAll);
  $('#adminResetStateBtn').addEventListener('click', adminResetState);

  for (const id of ['serverUrl', 'syncToken', 'deviceName']) {
    $(`#${id}`).addEventListener('change', onConfigChange);
  }
}

// Promise-based custom confirm (styled, unaffected by modal policies).
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

// --- Initial sync prompt ---

async function confirmInitialReplace() {
  if (!(await customConfirm('Replace LOCAL tabs and workspaces with the server\'s state?', { okText: 'Replace local', okClass: 'danger' }))) return;
  const btn = $('#confirmReplaceBtn');
  btn.disabled = true; btn.textContent = 'Applying…';
  await browser.runtime.sendMessage({ type: 'confirm_initial_replace' });
  $('#initialSyncPrompt').classList.add('hidden');
  btn.disabled = false; btn.textContent = 'Replace local (use server)';
}

async function confirmInitialPush() {
  if (!(await customConfirm('Overwrite SERVER state with this device\'s local? Other connected devices will conform to the replaced state.', { okText: 'Push local', okClass: 'danger' }))) return;
  const btn = $('#confirmPushBtn');
  btn.disabled = true; btn.textContent = 'Pushing…';
  await browser.runtime.sendMessage({ type: 'confirm_initial_push' });
  $('#initialSyncPrompt').classList.add('hidden');
  btn.disabled = false; btn.textContent = 'Push local (overwrite server)';
}

async function cancelInitialSync() {
  await browser.runtime.sendMessage({ type: 'cancel_initial_sync' });
  $('#initialSyncPrompt').classList.add('hidden');
  syncToggle.checked = false;
}

function renderInitialSyncPrompt(info) {
  const sec = $('#initialSyncPrompt');
  if (!info) { sec.classList.add('hidden'); return; }
  const intro = $('#initialSyncIntro');
  intro.textContent = info.serverEmpty
    ? 'Server is empty. Push this device\'s state as the seed, or wait for another device.'
    : 'Server has data from another device (or was reset). Pick which side wins:';
  const ul = $('#initialSyncSummary');
  ul.innerHTML = '';
  const serverLine = document.createElement('li');
  serverLine.innerHTML = `<strong>Server:</strong> ${info.workspaces} workspaces · ${info.folders} folders · ${info.essentials} essentials · ${info.tabs} tabs`;
  ul.appendChild(serverLine);
  const localLine = document.createElement('li');
  localLine.innerHTML = `<strong>This device:</strong> ${info.localWorkspaces} workspaces · ${info.localTabs} tabs`;
  ul.appendChild(localLine);
  $('#confirmReplaceBtn').style.display = info.serverEmpty ? 'none' : '';
  sec.classList.remove('hidden');
}

// --- Apply guard prompt ---

function renderGuardPrompt(guard) {
  const sec = $('#guardPrompt');
  if (!guard) { sec.classList.add('hidden'); return; }
  $('#guardText').textContent =
    `An incoming update wants to delete ${guard.wouldDelete} of your ${guard.localCount} synced items. ` +
    'Apply the deletions, or stop syncing on this device?';
  sec.classList.remove('hidden');
}

async function confirmApplyGuard() {
  const btn = $('#confirmGuardBtn');
  btn.disabled = true; btn.textContent = 'Applying…';
  await browser.runtime.sendMessage({ type: 'confirm_apply_guard' });
  $('#guardPrompt').classList.add('hidden');
  btn.disabled = false; btn.textContent = 'Apply deletions';
}

async function rejectApplyGuard() {
  await browser.runtime.sendMessage({ type: 'reject_apply_guard' });
  $('#guardPrompt').classList.add('hidden');
  syncToggle.checked = false;
}

// --- Invite ---

function setInviteHint(text, tone = 'muted') {
  const hint = $('#inviteHint');
  hint.textContent = text;
  hint.style.color = tone === 'error' ? '#f87171' : tone === 'ok' ? '#4ade80' : '';
}

// Paste an invite → fills the manual fields, saves, and connects. This is
// the whole setup flow for a new device.
async function applyInvite() {
  const input = $('#inviteInput');
  const raw = input.value.trim();
  if (!raw) return;

  const parsed = parseInvite(raw);
  if (!parsed) {
    setInviteHint('Not a valid invite. Expected zensync://host/?t=…', 'error');
    return;
  }

  $('#serverUrl').value = parsed.serverUrl;
  $('#syncToken').value = parsed.token;
  if (parsed.deviceName) $('#deviceName').value = parsed.deviceName;
  const deviceName = $('#deviceName').value.trim();

  savedConfig = { serverUrl: parsed.serverUrl, syncToken: parsed.token, deviceName };
  // Clear the pasted secret from the visible field once it is stored.
  input.value = '';
  setInviteHint(`Connecting to ${parsed.serverUrl}…`, 'ok');

  await browser.runtime.sendMessage({
    type: 'connect',
    serverUrl: parsed.serverUrl,
    token: parsed.token,
    deviceName,
  });
  syncToggle.checked = true;
}

async function copyInvite() {
  const btn = $('#copyInviteBtn');
  const config = await browser.runtime.sendMessage({ type: 'get_config' });
  const invite = buildInvite({ serverUrl: config?.serverUrl, token: config?.syncToken });
  if (!invite) {
    btn.textContent = 'Nothing to copy';
    setTimeout(() => { btn.textContent = 'Copy invite'; }, 1500);
    return;
  }
  try {
    await navigator.clipboard.writeText(invite);
    btn.textContent = 'Copied — paste on the next device';
  } catch {
    // Clipboard can be unavailable; fall back to revealing it for manual copy.
    $('#inviteInput').type = 'text';
    $('#inviteInput').value = invite;
    btn.textContent = 'Select and copy above';
  }
  setTimeout(() => { btn.textContent = 'Copy invite'; }, 2500);
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
    updateStatus('disconnected');
  }
}

async function onConfigChange() {
  const serverUrl = $('#serverUrl').value.trim();
  const token = $('#syncToken').value.trim();
  const deviceName = $('#deviceName').value.trim();

  if (serverUrl === savedConfig.serverUrl && token === savedConfig.syncToken && deviceName === savedConfig.deviceName) {
    return;
  }

  savedConfig = { serverUrl, syncToken: token, deviceName };

  await browser.runtime.sendMessage({ type: 'save_config', serverUrl, token, deviceName });

  if (syncToggle.checked && serverUrl && token) {
    await browser.runtime.sendMessage({ type: 'connect', serverUrl, token, deviceName });
  }
}

async function forcePush() {
  const ok = await customConfirm(
    'Overwrite SERVER state with this device\'s local state? All other devices will conform.',
    { okText: 'Force push', okClass: 'danger' },
  );
  if (!ok) return;
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

async function disableSpacesEngine() {
  const result = await browser.runtime.sendMessage({ type: 'disable_spaces_engine' });
  if (result?.success) {
    const status = await browser.runtime.sendMessage({ type: 'get_status' });
    updateUI(status);
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
  const result = await browser.runtime.sendMessage({ type: 'admin_disable_all' });
  if (result?.success) {
    btn.textContent = 'Sent';
  } else {
    btn.textContent = 'Failed';
    await customConfirm(`Disable sync on all failed: ${result?.error || 'unknown error'}`, { okText: 'OK', okClass: 'primary' });
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = 'Disable sync on all'; }, 1500);
}

async function adminResetState() {
  const ok = await customConfirm(
    'WIPE all server state AND disable sync on every connected device? Each device will need to be re-enabled manually.',
    { okText: 'Reset everything', okClass: 'danger' },
  );
  if (!ok) return;
  const btn = $('#adminResetStateBtn');
  btn.disabled = true; btn.textContent = 'Resetting…';
  const result = await browser.runtime.sendMessage({ type: 'admin_reset_state' });
  if (result?.success) {
    btn.textContent = 'Done';
  } else {
    btn.textContent = 'Failed';
    await customConfirm(`Reset failed: ${result?.error || 'unknown error'}`, { okText: 'OK', okClass: 'primary' });
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = 'Reset server state'; }, 1500);
}

// --- UI ---

function updateUI(status) {
  if (!status) return;

  updateStatus(status.syncStatus, status);
  syncToggle.checked = status.syncEnabled;

  infoSection.classList.remove('hidden');
  updateStats(status.counts);
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
    spaces_engine_conflict: 'Zen sync conflict',
    incompatible_zen: 'Incompatible Zen',
    awaiting_initial_confirm: 'Awaiting confirmation',
    apply_guard: 'Held for confirmation',
  };

  statusText.textContent = labels[status] || status;
  renderBanner(status, ctx);

  browser.runtime.sendMessage({ type: 'get_status' }).then(s => {
    if (s) updateStats(s.counts);
  });

  if (status === 'auth_failed' || status === 'failed' || status === 'schema_mismatch' || status === 'incompatible_zen') {
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
  host.textContent = '';
  if (status === 'schema_mismatch') {
    host.style.display = 'block';
    host.style.background = '#fde7e7';
    host.style.color = '#900';
    host.textContent = ctx.schemaError || 'Server schema is incompatible. Update all clients or reset server state.';
  } else if (status === 'spaces_engine_conflict') {
    host.style.display = 'block';
    host.style.background = '#fff4d6';
    host.style.color = '#7a4f00';
    const text = document.createElement('div');
    text.textContent = 'Zen\'s built-in Spaces sync (Mozilla account) is enabled. Running both syncs corrupts state.';
    const btn = document.createElement('button');
    btn.textContent = 'Disable Zen\'s Spaces sync';
    btn.className = 'btn danger';
    btn.style.marginTop = '6px';
    btn.addEventListener('click', disableSpacesEngine);
    host.appendChild(text);
    host.appendChild(btn);
  } else if (status === 'incompatible_zen') {
    host.style.display = 'block';
    host.style.background = '#fde7e7';
    host.style.color = '#900';
    const missing = ctx.engineEnv?.missing?.filter(m => !m.includes('(optional)')) || [];
    host.textContent = `This Zen version is missing internals the sync engine needs${missing.length ? `: ${missing.join(', ')}` : '.'} Sync is disabled to protect your data.`;
  } else {
    host.style.display = 'none';
  }
}

function updateStats(counts) {
  if (!counts) {
    $('#essentialCount').textContent = '-';
    $('#workspaceCount').textContent = '-';
    $('#tabCount').textContent = '-';
    return;
  }
  $('#essentialCount').textContent = counts.essentials ?? 0;
  $('#workspaceCount').textContent = counts.spaces ?? 0;
  $('#tabCount').textContent = (counts.pinned ?? 0) + (counts.normal ?? 0);
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
