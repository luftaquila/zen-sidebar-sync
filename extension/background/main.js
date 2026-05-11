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
      // Server empty — seed from local.
      if (syncClient.isConnected && tabMonitor.state) {
        syncClient.sendFullState(tabMonitor.state);
      }
    } else {
      // Initial connect with server data — additive merge of remote
      // INTO local, then push local back so any local-only workspaces,
      // folders, or tabs that the server didn't yet know about propagate
      // to peers. Without this push, anything created on a device while
      // the server was tracking only a subset stays stuck locally.
      await tabApplier.applyState(remoteState, { addOnly: true });
      if (syncClient.isConnected && tabMonitor.state) {
        syncClient.sendFullState(tabMonitor.state);
      }
    }
    initialSyncDone = true;
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
    // Broadcast from another device or force_pull — full reconciliation.
    await tabApplier.applyState(remoteState, { addOnly: false });
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
      await syncClient.connect(serverUrl, token, deviceName);
      return { success: true };
    }

    case 'disconnect':
      syncClient.disconnect();
      syncEnabled = false;
      initialSyncDone = false;
      await browser.storage.local.set({ syncEnabled: false });
      return { success: true };

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
