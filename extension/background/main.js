/**
 * Zen Sidebar Sync - Background Script (Entry Point)
 *
 * Orchestrates TabMonitor, SyncClient, and TabApplier.
 * Initial connect merges additively, then full bidirectional sync.
 */

import TabMonitor from './tab-monitor.js';
import SyncClient from './sync-client.js';
import TabApplier from './tab-applier.js';

const SCHEMA_VERSION = 2;

let tabMonitor;
let syncClient;
let tabApplier;
let syncEnabled = false;
let syncStatus = 'disconnected';
let lastSyncTime = null;
let initialSyncDone = false;
let schemaError = null;

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
  console.log('[ZenSync] Initialized');
}

// --- Local State Change (from TabMonitor) ---

function onLocalStateChange(state, patch) {
  if (!syncEnabled || !syncClient.isConnected || !initialSyncDone) return;

  if (patch.operations.length > 0 && patch.operations.length <= 10) {
    syncClient.sendPatch(patch);
  } else if (patch.operations.length > 0) {
    syncClient.sendFullState(state);
  }

  lastSyncTime = Date.now();
}

// --- Remote State Update (from Server, full state) ---

async function onRemoteStateUpdate(remoteState, sourceDevice) {
  if (sourceDevice === syncClient.deviceId) return;

  if (!isCompatibleState(remoteState)) {
    schemaError = `Server schema v${remoteState?.schemaVersion ?? '?'} ≠ extension v${SCHEMA_VERSION}. Reset server state.`;
    console.error('[ZenSync]', schemaError);
    browser.runtime.sendMessage({ type: 'status_update', status: 'schema_mismatch', schemaError }).catch(() => {});
    return;
  }
  schemaError = null;

  if (!initialSyncDone) {
    const totalRemoteTabs = (remoteState.tabs || []).length;

    if (totalRemoteTabs === 0) {
      if (syncClient.isConnected && tabMonitor.state) {
        syncClient.sendFullState(tabMonitor.state);
      }
    } else {
      await tabApplier.applyState(remoteState, { addOnly: true });
    }
    initialSyncDone = true;
  } else {
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
        syncClient.sendFullState(tabMonitor.state);
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
