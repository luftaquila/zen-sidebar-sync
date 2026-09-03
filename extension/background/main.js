/**
 * Zen Sidebar Sync - Background Script (Entry Point)
 *
 * Policy layer between the chrome-side sync engine (zenInternals experiment:
 * capture, digest diff, apply) and the WebSocket transport (SyncClient).
 * Owns: initial-sync direction prompt, spaces-engine conflict gate,
 * apply-guard confirmation, admin actions, popup messaging.
 */

import SyncClient from './sync-client.js';
import { parseInvite } from '../common/invite.js';

const SCHEMA_VERSION = 4;

let syncClient;
let syncEnabled = false;
let syncStatus = 'disconnected';
let lastSyncTime = null;
let schemaError = null;
let engineEnv = null;
// True once this connection is allowed to exchange records: the server
// generation matched our stored one, or the user explicitly picked an
// initial-sync direction.
let syncActive = false;
let lastServerVersion = 0;
let lastServerGeneration = null;
// Initial connect against an unknown server generation — held until the
// user picks a direction (Replace local / Push local / Cancel).
let pendingInitial = null;
// Incoming batch withheld by the apply-side mass-deletion guard — held
// until the user confirms.
let pendingGuard = null;
let retryTimer = null;
// In-flight uploads keyed by reqId: the ack advances the baseline from the
// SENT payload (never the ack-time projection — see sync-model markUploaded).
let putSeq = 0;
const inflightPuts = new Map();
// Set while a force-push replace is in flight, so a CAS conflict retries the
// push instead of silently degrading into a pull.
let forcePushRetries = null;
// The record payload of the replace_state in flight (baseline source on ack).
let pendingReplaceRecords = null;

const zen = () => browser.zenInternals;

// --- Initialize ---

async function init() {
  const config = await browser.storage.local.get([
    'serverUrl', 'syncToken', 'deviceName', 'syncEnabled',
  ]);

  // Message listener first: the popup may open while the engine is still
  // waiting for session restore.
  browser.runtime.onMessage.addListener(handleMessage);

  syncClient = new SyncClient({
    onAuthState,
    onRecordsUpdate,
    onRecordsAccepted,
    onPutRejected,
    onStateRecords,
    onReplaceAccepted,
    onReplaceConflict,
    onDeviceEvent,
    onStatusChange: onSyncStatusChange,
    onForceDisable,
  });

  // start() resolves only after session restore + Zen workspaces are ready
  // (first-upload gate) — nothing captures or connects before that.
  engineEnv = await zen().start();
  browser.zenInternals.onRecordsChanged.addListener(onLocalRecordsChanged);
  browser.zenInternals.onEnvironmentChanged.addListener(onEnvironmentChanged);

  // Headless provisioning (about:config extensions.zenSidebarSync.*): a
  // fresh profile with no stored config adopts the pref-provided one.
  const provision = engineEnv?.provision || {};
  // A single `invite` pref stands in for serverUrl + token.
  if (provision.invite && !provision.serverUrl && !provision.token) {
    const parsed = parseInvite(provision.invite);
    if (parsed) {
      provision.serverUrl = parsed.serverUrl;
      provision.token = parsed.token;
      provision.deviceName ||= parsed.deviceName || '';
    } else {
      console.warn('[ZenSync] Ignoring malformed extensions.zenSidebarSync.invite');
    }
  }
  if (!config.serverUrl && !config.syncToken && provision.serverUrl && provision.token) {
    config.serverUrl = provision.serverUrl;
    config.syncToken = provision.token;
    config.deviceName = provision.deviceName || config.deviceName;
    if (provision.enabled) config.syncEnabled = true;
    await browser.storage.local.set({
      serverUrl: config.serverUrl,
      syncToken: config.syncToken,
      deviceName: config.deviceName,
      syncEnabled: !!config.syncEnabled,
    });
    console.log('[ZenSync] Adopted provisioning prefs');
  }

  if (config.syncEnabled && config.serverUrl && config.syncToken) {
    syncEnabled = true;
    await maybeConnect(config.serverUrl, config.syncToken, config.deviceName);
  }

  const ver = browser.runtime.getManifest()?.version ?? '?';
  console.log(`[ZenSync] Initialized — extension v${ver}, schema v${SCHEMA_VERSION}, engine compatible=${engineEnv?.compatible}`);
}

// --- Connection gating ---

function spacesEngineConflict() {
  return !!(engineEnv?.spacesEngineEnabled && engineEnv?.fxaConfigured);
}

async function maybeConnect(serverUrl, token, deviceName) {
  engineEnv = await zen().getEnvironment();
  if (!engineEnv?.compatible) {
    // Fail closed: a partially working engine must not capture or apply.
    setStatus('incompatible_zen');
    console.error('[ZenSync] Incompatible Zen version, missing:', engineEnv?.missing);
    return;
  }
  if (spacesEngineConflict()) {
    // Two syncers over the same data feed back into each other. Refuse
    // until the user disables Zen's native FxA spaces engine.
    setStatus('spaces_engine_conflict');
    return;
  }
  await syncClient.connect(serverUrl, token, deviceName);
}

function onEnvironmentChanged(env) {
  engineEnv = env;
  if (spacesEngineConflict() && syncClient?.isConnected) {
    console.warn('[ZenSync] services.sync.engine.spaces re-enabled — pausing sync');
    syncActive = false;
    syncClient.disconnect();
    setStatus('spaces_engine_conflict');
  }
}

// --- Outbound: local changes → server ---

function sendPut(records, deleted, { force = false } = {}) {
  const reqId = `put-${++putSeq}`;
  inflightPuts.set(reqId, { records, deleted });
  if (!syncClient.putRecords(records, deleted, { reqId, force })) {
    inflightPuts.delete(reqId);
    return false;
  }
  return true;
}

function onLocalRecordsChanged({ changed, deleted }) {
  if (!syncEnabled || !syncClient.isConnected || !syncActive) return;
  if (!changed.length && !deleted.length) return;
  sendPut(changed, deleted);
  lastSyncTime = Date.now();
}

function onRecordsAccepted(ids, rejected, version, reqId) {
  if (typeof version === 'number') lastServerVersion = version;
  if (rejected?.length) {
    console.warn('[ZenSync] Server rejected records:', rejected);
  }
  // Baseline advances only on server ack, and from the SENT payload — a tab
  // closed or navigated while its upload was in flight must keep a baseline
  // entry, or its tombstone/update could never be emitted.
  const batch = reqId ? inflightPuts.get(reqId) : null;
  if (!batch) {
    console.warn('[ZenSync] records_accepted for unknown reqId — baseline not advanced (will re-diff)');
    return;
  }
  inflightPuts.delete(reqId);
  const rejectedIds = new Set((rejected || []).map(r => r.id));
  zen().markUploaded({
    records: batch.records.filter(r => !rejectedIds.has(r.id)),
    deleted: batch.deleted.filter(id => !rejectedIds.has(id)),
  }).catch(() => {});
  lastSyncTime = Date.now();
}

// Server-side mass-deletion guard fired: surface the same confirmation UI
// as the apply-side guard; on confirm the batch is re-sent with force.
function onPutRejected(reqId, info) {
  const batch = reqId ? inflightPuts.get(reqId) : null;
  if (reqId) inflightPuts.delete(reqId);
  if (!batch || info?.reason !== 'mass_delete') {
    console.warn('[ZenSync] put_records rejected:', info);
    return;
  }
  pendingGuard = {
    mode: 'server',
    records: batch.records,
    deleted: batch.deleted,
    guard: { wouldDelete: info.wouldDelete, localCount: info.current, server: true },
  };
  setStatus('apply_guard', { guardInfo: pendingGuard.guard });
  browser.browserAction.openPopup().catch(() => {});
}

// --- Inbound: auth (connect / reconnect) ---

async function onAuthState({ schemaVersion, generation, version, records }) {
  if (schemaVersion !== SCHEMA_VERSION) {
    schemaError = `Server schema v${schemaVersion ?? '?'} ≠ extension v${SCHEMA_VERSION}. Update all clients or reset server state.`;
    console.error('[ZenSync]', schemaError);
    setStatus('schema_mismatch');
    return;
  }
  schemaError = null;
  lastServerVersion = version;
  lastServerGeneration = generation;

  const storedGeneration = await zen().getGeneration();
  if (storedGeneration && storedGeneration === generation) {
    // Known server: reconcile automatically, preserving offline work.
    syncActive = true;
    const result = await zen().reconnectMerge({ records });
    handleApplyResult(result, { mode: 'reconnect', records });
    // Leftover local truth (offline changes/deletions, divergence) pushes
    // through the post-apply capture diff.
    zen().forceCapture().catch(() => {});
    lastSyncTime = Date.now();
    notifyPopup();
    return;
  }

  // Unknown server generation: never touch either side silently.
  const localCounts = (await zen().getCounts()) || { spaces: 0, folders: 0, essentials: 0, pinned: 0, normal: 0 };
  const serverCounts = countRecords(records);
  const serverEmpty = records.length === 0;
  const localEmpty = localCounts.spaces + localCounts.essentials + localCounts.pinned + localCounts.normal + localCounts.folders === 0;

  if (serverEmpty && localEmpty) {
    // Nothing to negotiate.
    await adoptGeneration(generation);
    syncActive = true;
    notifyPopup();
    return;
  }

  pendingInitial = { records, generation, version };
  pendingInitial.info = {
    ...serverCounts,
    localTabs: localCounts.pinned + localCounts.normal + localCounts.essentials,
    localWorkspaces: localCounts.spaces,
    serverEmpty,
  };

  // Headless provisioning can answer the direction prompt automatically
  // (extensions.zenSidebarSync.autoInitial = "push" | "replace").
  const autoInitial = engineEnv?.provision?.autoInitial;
  if (autoInitial === 'push') {
    console.log('[ZenSync] autoInitial=push — pushing local state');
    await pushLocalAsAuthority(version);
    return;
  }
  if (autoInitial === 'replace' && !serverEmpty) {
    console.log('[ZenSync] autoInitial=replace — replacing local state');
    await performInitialReplace();
    return;
  }

  setStatus('awaiting_initial_confirm', { initialSyncInfo: pendingInitial.info });
  try { await browser.browserAction.openPopup(); } catch {}
}

// Shared by the popup's "Replace local" button and autoInitial=replace.
async function performInitialReplace() {
  if (!pendingInitial) return { success: false, error: 'no pending state' };
  const { records, generation } = pendingInitial;
  // Baseline reset before apply (noteApplied refills it); the generation is
  // adopted only after the apply demonstrably ran — a wholesale failure
  // (e.g. no synced window) with syncActive flipped on would otherwise diff
  // the untouched local state against the empty baseline and upload exactly
  // what the user chose to discard.
  await zen().resetBaseline();
  const result = await zen().applyRecords({ records, reconcile: true });
  const wholesale = records.length > 0 && (result?.failed?.length ?? 0) >= records.length;
  if (result?.error || wholesale) {
    console.error('[ZenSync] initial replace failed wholesale — keeping prompt', result?.error);
    setStatus('awaiting_initial_confirm', { initialSyncInfo: pendingInitial.info });
    return { success: false, error: result?.error || 'apply failed (no synced window?)' };
  }
  await zen().setGeneration(generation);
  pendingInitial = null;
  syncActive = true;
  if (result?.failed?.length) {
    console.warn(`[ZenSync] initial replace: ${result.failed.length} records failed`);
  }
  zen().forceCapture().catch(() => {});
  // Broadcasts that arrived while the prompt was open were dropped
  // (syncActive was false) — refresh from the server so the applied
  // snapshot isn't stale.
  syncClient.requestState();
  notifyPopup();
  return { success: true };
}

async function adoptGeneration(generation) {
  await zen().resetBaseline();
  await zen().setGeneration(generation);
}

function countRecords(records) {
  const counts = { workspaces: 0, folders: 0, essentials: 0, pinned: 0, normal: 0, tabs: 0 };
  for (const r of records || []) {
    switch (r.kind) {
      case 'space': counts.workspaces++; break;
      case 'folder': counts.folders++; break;
      case 'tab':
        counts.tabs++;
        if (r.data?.essential) counts.essentials++;
        else if (r.data?.pinned) counts.pinned++;
        else counts.normal++;
        break;
    }
  }
  return counts;
}

// --- Inbound: live updates ---

async function onRecordsUpdate(records, deleted, sourceDevice, version) {
  if (!syncActive) return;
  lastServerVersion = version;
  const result = await zen().applyRecords({ records, deleted });
  handleApplyResult(result, { mode: 'update', records, deleted });
  lastSyncTime = Date.now();
}

async function onStateRecords({ generation, version, records }) {
  lastServerVersion = version;
  lastServerGeneration = generation;
  if (pendingInitial) {
    // Prompt refresh (e.g. after a replace_conflict).
    pendingInitial = { records, generation, version };
    const localCounts = (await zen().getCounts()) || { spaces: 0, essentials: 0, pinned: 0, normal: 0, folders: 0 };
    pendingInitial.info = {
      ...countRecords(records),
      localTabs: localCounts.pinned + localCounts.normal + localCounts.essentials,
      localWorkspaces: localCounts.spaces,
      serverEmpty: records.length === 0,
    };
    setStatus('awaiting_initial_confirm', { initialSyncInfo: pendingInitial.info });
    return;
  }
  if (!syncActive) return;
  // A generation change mid-session means this is not the server state our
  // baseline describes (reset/replaced elsewhere) — auto-merging would
  // mass-delete local records. Fall back to the direction prompt.
  const storedGeneration = await zen().getGeneration();
  if (storedGeneration && generation && generation !== storedGeneration) {
    console.warn('[ZenSync] Server generation changed mid-session — re-prompting');
    syncActive = false;
    await onAuthState({ schemaVersion: SCHEMA_VERSION, generation, version, records });
    return;
  }
  // Full-state refresh (force pull, a peer's replace, redelivery retry).
  const result = await zen().reconnectMerge({ records });
  handleApplyResult(result, { mode: 'reconnect', records });
  lastSyncTime = Date.now();
}

function handleApplyResult(result, context) {
  if (result?.guard) {
    // Deletions were withheld: incoming batch would remove most local
    // synced items. Requires explicit user confirmation.
    pendingGuard = { ...context, guard: result.guard };
    setStatus('apply_guard', { guardInfo: result.guard });
    browser.browserAction.openPopup().catch(() => {});
    return;
  }
  if (result?.failed?.length || result?.error) {
    console.warn(`[ZenSync] ${result?.failed?.length || 0} records failed to apply${result?.error ? ` (${result.error})` : ''} — scheduling state refresh`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (syncClient.isConnected && syncActive) syncClient.requestState();
    }, 10000);
  }
}

// --- Replace flow (initial push / force push) ---

async function pushLocalAsAuthority(baseVersion) {
  const projection = await zen().getFullProjection();
  if (!projection) return { success: false, error: 'projection unavailable' };
  pendingReplaceRecords = projection;
  if (!syncClient.replaceState(projection, baseVersion)) {
    pendingReplaceRecords = null;
    return { success: false, error: 'not connected' };
  }
  return { success: true };
}

async function onReplaceAccepted(ids, generation, version) {
  lastServerVersion = version;
  lastServerGeneration = generation;
  forcePushRetries = null;
  const sent = pendingReplaceRecords || [];
  pendingReplaceRecords = null;
  await adoptGeneration(generation);
  // Baseline = exactly what the server accepted (the sent payload).
  const acceptedIds = new Set(ids);
  await zen().markUploaded({ records: sent.filter(r => acceptedIds.has(r.id)), deleted: [] });
  pendingInitial = null;
  syncActive = true;
  lastSyncTime = Date.now();
  notifyPopup();
}

function onReplaceConflict(version) {
  lastServerVersion = version;
  pendingReplaceRecords = null;
  if (forcePushRetries !== null && pendingInitial === null) {
    // Force push raced a concurrent write. Retry once against the fresh
    // version — falling back to requestState here would silently turn the
    // user's push into a remote-wins pull.
    if (forcePushRetries < 1) {
      forcePushRetries++;
      console.warn('[ZenSync] force push conflict — retrying against fresh version');
      pushLocalAsAuthority(version).catch(() => {});
      return;
    }
    forcePushRetries = null;
    console.error('[ZenSync] force push failed twice on CAS conflict — giving up');
    return;
  }
  console.warn('[ZenSync] replace_state conflict — refreshing prompt');
  // Initial-sync push raced another device. Refresh and re-prompt with
  // current counts.
  syncClient.requestState();
}

// --- Device events / status ---

function onDeviceEvent(event) {
  console.log(`[ZenSync] ${event.type}: ${event.deviceName}`);
}

function onSyncStatusChange(status) {
  syncStatus = status;
  if (status === 'auth_failed') {
    syncActive = false;
  }
  if (status === 'disconnected' || status === 'reconnecting') {
    // Reconnects re-run the auth-state reconcile; records must not flow
    // until it completes. Un-acked uploads re-diff after reconnect.
    syncActive = false;
    inflightPuts.clear();
    pendingReplaceRecords = null;
    forcePushRetries = null;
  }
  notifyPopup();
}

function setStatus(status, extra = {}) {
  syncStatus = status;
  browser.runtime.sendMessage({ type: 'status_update', status, lastSyncTime, schemaError, engineEnv, ...extra }).catch(() => {});
}

function notifyPopup() {
  browser.runtime.sendMessage({ type: 'status_update', status: syncStatus, lastSyncTime, schemaError, engineEnv }).catch(() => {});
}

// --- Force disable (admin) ---

async function onForceDisable(reason) {
  console.log('[ZenSync] Force-disable received:', reason);
  syncClient.disconnect();
  syncEnabled = false;
  syncActive = false;
  pendingInitial = null;
  pendingGuard = null;
  await browser.storage.local.set({ syncEnabled: false });
  browser.runtime.sendMessage({ type: 'status_update', status: 'disconnected', forceDisabled: true }).catch(() => {});
}

// --- One-shot admin WS ---
// Open a transient WebSocket using stored config, auth, send the admin
// command, await admin_ok, then close. Used when the persistent sync
// connection is closed (e.g. right after "Disable sync on all").
async function sendOneShotAdmin(cmd) {
  const cfg = await browser.storage.local.get(['serverUrl', 'syncToken', 'deviceId']);
  if (!cfg.serverUrl || !cfg.syncToken) {
    return { success: false, error: 'Sync config missing — set server URL and token first.' };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(result);
    };
    let ws;
    try {
      ws = new WebSocket(cfg.serverUrl);
    } catch (e) {
      return finish({ success: false, error: `WS open failed: ${e.message}` });
    }
    const timeout = setTimeout(() => finish({ success: false, error: 'timed out' }), 10000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'auth',
        token: cfg.syncToken,
        deviceId: cfg.deviceId || 'admin-oneshot',
        deviceName: 'admin-oneshot',
      }));
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify(cmd));
      } else if (msg.type === 'admin_ok') {
        clearTimeout(timeout);
        finish({ success: true });
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        finish({ success: false, error: msg.message });
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      finish({ success: false, error: 'WS error' });
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (!settled) finish({ success: false, error: 'closed before admin_ok' });
    };
  });
}

// --- Message handler (from popup) ---

async function handleMessage(msg) {
  switch (msg.type) {
    case 'get_status':
      return {
        syncEnabled,
        syncStatus,
        schemaError,
        engineEnv,
        lastSyncTime,
        counts: await zen().getCounts().catch(() => null),
        deviceId: syncClient?.deviceId || null,
        pendingInitialInfo: pendingInitial?.info || null,
        pendingGuardInfo: pendingGuard?.guard || null,
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
      syncActive = false;
      pendingInitial = null;
      pendingGuard = null;
      await maybeConnect(serverUrl, token, deviceName);
      return { success: true };
    }

    case 'disconnect':
      syncClient.disconnect();
      syncEnabled = false;
      syncActive = false;
      pendingInitial = null;
      pendingGuard = null;
      await browser.storage.local.set({ syncEnabled: false });
      return { success: true };

    case 'disable_spaces_engine': {
      const result = await zen().setSpacesEnginePref(false);
      engineEnv = await zen().getEnvironment();
      if (result?.success && syncEnabled && !syncClient.isConnected) {
        const cfg = await browser.storage.local.get(['serverUrl', 'syncToken', 'deviceName']);
        if (cfg.serverUrl && cfg.syncToken) {
          await maybeConnect(cfg.serverUrl, cfg.syncToken, cfg.deviceName);
        }
      }
      return result;
    }

    case 'confirm_initial_replace':
      // User confirmed: discard local, materialize server state outright.
      return await performInitialReplace();

    case 'confirm_initial_push': {
      // User chose: this device's state is authoritative; server wipes its
      // state (CAS-guarded) and accepts ours.
      if (!syncClient.isConnected || !pendingInitial) return { success: false, error: 'not connected' };
      return await pushLocalAsAuthority(pendingInitial.version);
    }

    case 'cancel_initial_sync': {
      syncClient.disconnect();
      syncEnabled = false;
      syncActive = false;
      pendingInitial = null;
      await browser.storage.local.set({ syncEnabled: false });
      setStatus('disconnected');
      return { success: true };
    }

    case 'confirm_apply_guard': {
      // User confirmed the mass deletion the guard withheld.
      if (!pendingGuard) return { success: false, error: 'no pending guard' };
      const held = pendingGuard;
      pendingGuard = null;
      if (held.mode === 'server') {
        // The SERVER's guard rejected our outbound deletion batch; re-send
        // with force now that the user vouched for it.
        if (!syncClient.isConnected) return { success: false, error: 'not connected' };
        sendPut(held.records, held.deleted, { force: true });
        notifyPopup();
        return { success: true };
      }
      let result;
      if (held.mode === 'reconnect') {
        result = await zen().reconnectMerge({ records: held.records, overrideGuard: true });
      } else {
        result = await zen().applyRecords({ records: held.records, deleted: held.deleted, overrideGuard: true });
      }
      handleApplyResult(result, held);
      notifyPopup();
      return { success: true };
    }

    case 'reject_apply_guard': {
      // Protective stop: the user says this mass deletion is wrong.
      pendingGuard = null;
      syncClient.disconnect();
      syncEnabled = false;
      syncActive = false;
      await browser.storage.local.set({ syncEnabled: false });
      setStatus('disconnected');
      return { success: true };
    }

    case 'admin_reset_state': {
      if (syncClient.isConnected) {
        syncClient.sendAdminResetState();
        return { success: true };
      }
      return await sendOneShotAdmin({ type: 'admin_reset_state' });
    }

    case 'admin_disable_all': {
      if (syncClient.isConnected) {
        syncClient.sendAdminDisableAll();
        return { success: true };
      }
      return await sendOneShotAdmin({ type: 'admin_disable_all' });
    }

    case 'save_config': {
      const { serverUrl, token, deviceName } = msg;
      await browser.storage.local.set({ serverUrl, syncToken: token, deviceName });
      return { success: true };
    }

    case 'force_push': {
      if (!syncClient.isConnected || !syncActive) return { success: false, error: 'Not connected' };
      forcePushRetries = 0;
      return await pushLocalAsAuthority(lastServerVersion);
    }

    case 'force_pull':
      if (syncClient.isConnected && syncActive) {
        syncClient.requestState();
        return { success: true };
      }
      return { success: false, error: 'Not connected' };

    case 'get_config': {
      return await browser.storage.local.get(['serverUrl', 'syncToken', 'deviceName']);
    }
  }
}

init();
