/**
 * Zen Sidebar Sync - Background Script (Entry Point)
 *
 * Orchestrates TabMonitor, SyncClient, and TabApplier.
 * Initial connect merges additively, then full bidirectional sync.
 */

import TabMonitor from './tab-monitor.js';
import SyncClient from './sync-client.js';
import TabApplier from './tab-applier.js';

const SCHEMA_VERSION = 3;

let tabMonitor;
let syncClient;
let tabApplier;
let syncEnabled = false;
let syncStatus = 'disconnected';
let lastSyncTime = null;
let initialSyncDone = false;
let schemaError = null;
let nativeMissing = false;
// Pending initial sync — server already has data from a prior device,
// and this is our first connect to it. We hold the remote state here
// and wait for the user to confirm a destructive replace before applying.
// Until confirmed, sync stays paused (no patches sent/received).
let pendingInitialState = null;
let pendingInitialInfo = null;

// --- Initialize ---

async function init() {
  const config = await browser.storage.local.get([
    'serverUrl', 'syncToken', 'deviceName', 'syncEnabled',
  ]);

  tabMonitor = new TabMonitor(onLocalStateChange);
  await tabMonitor.init();

  tabApplier = new TabApplier(tabMonitor);

  syncClient = new SyncClient({
    onStateUpdate: onRemoteStateUpdate,
    onPatch: onRemotePatch,
    onDeviceEvent: onDeviceEvent,
    onStatusChange: onSyncStatusChange,
    onForceDisable: onForceDisable,
  });

  if (config.syncEnabled && config.serverUrl && config.syncToken) {
    syncEnabled = true;
    await syncClient.connect(config.serverUrl, config.syncToken, config.deviceName);
  }

  browser.runtime.onMessage.addListener(handleMessage);
  const ver = browser.runtime.getManifest()?.version ?? '?';
  console.log(`[ZenSync] Initialized — extension v${ver}, schema v${SCHEMA_VERSION}`);
}

// --- Local State Change (from TabMonitor) ---

function onLocalStateChange(state, patch) {
  if (!syncEnabled || !syncClient.isConnected || !initialSyncDone) return;

  // Always send patches — server full_state merge is additive on syncId
  // and would not propagate removals, causing stale tab resurrection.
  // For very large changes, the patch is still the right wire format.
  if (patch.operations.length > 0) {
    syncClient.sendPatch(patch);
  }

  lastSyncTime = Date.now();
}

// --- Remote State Update (from Server, full state) ---

async function onRemoteStateUpdate(remoteState, sourceDevice, isAuthState = false) {
  if (sourceDevice === syncClient.deviceId) return;

  if (!isCompatibleState(remoteState)) {
    schemaError = `Server schema v${remoteState?.schemaVersion ?? '?'} ≠ extension v${SCHEMA_VERSION}. Reset server state.`;
    console.error('[ZenSync]', schemaError);
    browser.runtime.sendMessage({ type: 'status_update', status: 'schema_mismatch', schemaError }).catch(() => {});
    return;
  }
  schemaError = null;

  // Native host is required for accurate cross-workspace tab tracking. Without
  // it, local capture only sees the active workspace and applyState would
  // create duplicate tabs for everything in hidden workspaces. Refuse to apply
  // and surface to popup so the user knows to install the native host.
  if (tabMonitor?._nativeAvailable === false && (remoteState.tabs || []).length > 5) {
    nativeMissing = true;
    console.error('[ZenSync] Native host missing — apply blocked');
    browser.runtime.sendMessage({ type: 'status_update', status: 'native_missing' }).catch(() => {});
    return;
  }
  nativeMissing = false;

  const totalRemoteTabs = (remoteState.tabs || []).length;

  if (!initialSyncDone) {
    if (totalRemoteTabs === 0) {
      // Server empty — this device is the AUTHORITATIVE first one. Push
      // local state outright (replace=true) so any other devices that
      // connect later see this exact set as the seed.
      if (syncClient.isConnected && tabMonitor.state) {
        syncClient.sendFullState(tabMonitor.state, { replace: true });
      }
      initialSyncDone = true;
    } else {
      // Server already has data from a prior device. Don't auto-merge —
      // queue the state for user confirmation. The popup shows a
      // destructive-replace prompt; until the user confirms, sync stays
      // paused (initialSyncDone stays false → no patches flow). On
      // confirm we apply the server state with addOnly=false (deletes
      // local tabs/workspaces not in the server's snapshot).
      pendingInitialState = remoteState;
      pendingInitialInfo = {
        workspaces: (remoteState.workspaces || []).length,
        folders: (remoteState.folders || []).length,
        tabs: (remoteState.tabs || []).length,
        essentials: (remoteState.tabs || []).filter(t => t.kind === 'essential').length,
      };
      browser.runtime.sendMessage({
        type: 'status_update',
        status: 'awaiting_initial_confirm',
        initialSyncInfo: pendingInitialInfo,
      }).catch(() => {});
      try { await browser.browserAction.openPopup(); } catch {}
    }
  } else if (isAuthState) {
    // Reconnect (auth_ok while already synced) — preserve offline changes:
    // additive merge of remote, then push local state so any changes made
    // while disconnected propagate to the server. Otherwise full
    // reconciliation would delete tabs opened during disconnect.
    if (totalRemoteTabs === 0 && syncClient.isConnected && tabMonitor.state) {
      // Server forgot everything (reset?). Re-seed from local.
      syncClient.sendFullState(tabMonitor.state);
    } else {
      await tabApplier.applyState(remoteState, { addOnly: true });
      if (syncClient.isConnected && tabMonitor.state) {
        syncClient.sendFullState(tabMonitor.state);
      }
    }
  } else {
    // Broadcast state_update from another device (a peer's full_state
    // push or a request_state reply). Apply additively only — never
    // remove local tabs based on a peer's snapshot. If A just closed
    // a tab and B simultaneously sent a full_state still containing it,
    // a full reconciliation would re-create the closed tab on A. Tab
    // removals propagate via dedicated `patch` ops (remove_tab) which
    // explicitly express the user's close intent.
    await tabApplier.applyState(remoteState, { addOnly: true });
  }

  lastSyncTime = Date.now();
}

function isCompatibleState(state) {
  return state && state.schemaVersion === SCHEMA_VERSION;
}

// --- Remote Patch (from Server, incremental) ---

async function onRemotePatch(patch, sourceDevice, version) {
  if (sourceDevice === syncClient.deviceId) return;

  await tabApplier.applyPatch(patch);
  lastSyncTime = Date.now();
}

// --- Device Events ---

function onDeviceEvent(event) {
  console.log(`[ZenSync] ${event.type}: ${event.deviceName}`);
}

// --- Force Disable (admin) ---

async function onForceDisable(reason) {
  console.log('[ZenSync] Force-disable received:', reason);
  syncClient.disconnect();
  syncEnabled = false;
  initialSyncDone = false;
  pendingInitialState = null;
  pendingInitialInfo = null;
  await browser.storage.local.set({ syncEnabled: false });
  browser.runtime.sendMessage({ type: 'status_update', status: 'disconnected', forceDisabled: true }).catch(() => {});
}

// --- Sync Status ---

function onSyncStatusChange(status) {
  syncStatus = status;

  // Only reset on auth failure — reconnects resume without re-merging.
  // Explicit connect/disconnect handlers reset initialSyncDone separately.
  if (status === 'auth_failed') {
    initialSyncDone = false;
  }

  browser.runtime.sendMessage({ type: 'status_update', status, lastSyncTime }).catch(() => {});
}

// --- Message Handler (from Popup) ---

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'get_status':
      return {
        syncEnabled,
        syncStatus,
        schemaError,
        nativeMissing,
        lastSyncTime,
        state: tabMonitor?.state || null,
        deviceId: syncClient?.deviceId || null,
        pendingInitialInfo,
      };

    case 'connect': {
      const { serverUrl, token, deviceName } = msg;
      await browser.storage.local.set({
        serverUrl,
        syncToken: token,
        deviceName,
        syncEnabled: true,
      });
      syncEnabled = true;
      initialSyncDone = false;
      pendingInitialState = null;
      pendingInitialInfo = null;
      await syncClient.connect(serverUrl, token, deviceName);
      return { success: true };
    }

    case 'disconnect':
      syncClient.disconnect();
      syncEnabled = false;
      initialSyncDone = false;
      pendingInitialState = null;
      pendingInitialInfo = null;
      await browser.storage.local.set({ syncEnabled: false });
      return { success: true };

    case 'confirm_initial_replace': {
      // User confirmed: discard local, apply server state outright.
      if (!pendingInitialState) return { success: false, error: 'no pending state' };
      await tabApplier.applyState(pendingInitialState, { addOnly: false });
      pendingInitialState = null;
      pendingInitialInfo = null;
      initialSyncDone = true;
      browser.runtime.sendMessage({ type: 'status_update', status: syncStatus, lastSyncTime }).catch(() => {});
      return { success: true };
    }

    case 'cancel_initial_sync': {
      // User declined: disconnect to avoid touching either side.
      syncClient.disconnect();
      syncEnabled = false;
      initialSyncDone = false;
      pendingInitialState = null;
      pendingInitialInfo = null;
      await browser.storage.local.set({ syncEnabled: false });
      browser.runtime.sendMessage({ type: 'status_update', status: 'disconnected', lastSyncTime }).catch(() => {});
      return { success: true };
    }

    case 'admin_reset_state': {
      if (!syncClient.isConnected) return { success: false, error: 'not connected' };
      syncClient.sendAdminResetState();
      return { success: true };
    }

    case 'admin_disable_all': {
      if (!syncClient.isConnected) return { success: false, error: 'not connected' };
      syncClient.sendAdminDisableAll();
      return { success: true };
    }

    case 'save_config': {
      const { serverUrl, token, deviceName } = msg;
      await browser.storage.local.set({
        serverUrl,
        syncToken: token,
        deviceName,
      });
      return { success: true };
    }

    case 'force_push':
      if (syncClient.isConnected && tabMonitor.state) {
        // Replace mode: server state is completely replaced with local state.
        syncClient.sendFullState(tabMonitor.state, { replace: true });
        return { success: true };
      }
      return { success: false, error: 'Not connected' };

    case 'force_pull':
      if (syncClient.isConnected) {
        initialSyncDone = true;
        syncClient.requestState();
        return { success: true };
      }
      return { success: false, error: 'Not connected' };

    case 'get_config': {
      const config = await browser.storage.local.get([
        'serverUrl', 'syncToken', 'deviceName',
      ]);
      return config;
    }
  }
}

init();
