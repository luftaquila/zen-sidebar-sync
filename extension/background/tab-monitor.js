/**
 * Tab Monitor - Tracks Zen Browser tab/workspace/folder state (schema v2).
 *
 * Reads Zen's session store via the native messaging host (recovery.jsonlz4 +
 * zen-sessions.jsonlz4) and emits a flat unified state:
 *   { schemaVersion: 2, workspaces, folders, tabs }
 * where each tab carries its own kind/workspaceSyncId/folderSyncId so transitions
 * (essential <-> pinned <-> normal, workspace move, folder move) are a single
 * `update_tab` op instead of a remove+add cycle.
 */

const SCHEMA_VERSION = 2;
const NATIVE_HOST = 'zen_sidebar_sync';
const NATIVE_CACHE_TTL = 5000;
const UUID_NAME_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

class TabMonitor {
  constructor(onStateChange) {
    this.onStateChange = onStateChange;
    this.state = emptyState();
    this.debounceTimer = null;
    this.DEBOUNCE_MS = 300;
    this._applyingCount = 0;

    /** @type {Map<string,string>} workspace name -> local Zen UUID */
    this.workspaceUuidByName = new Map();
    /** @type {Map<string,string>} workspace syncId -> local Zen UUID */
    this.workspaceUuidBySyncId = new Map();
    /** @type {Map<string,string>} folder syncId -> local Zen folder id */
    this.folderLocalIdBySyncId = new Map();
    /** @type {Map<string,string>} local Zen folder id -> folder syncId */
    this.folderSyncIdByLocalId = new Map();

    this._nativeData = null;
    this._nativeLastFetch = 0;
    this._nativeAvailable = null;
  }

  async init() {
    browser.tabs.onCreated.addListener((tab) => this._onTabEvent('created', tab));
    browser.tabs.onRemoved.addListener((tabId) => this._onTabEvent('removed', { id: tabId }));
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.title || changeInfo.pinned !== undefined || changeInfo.status === 'complete') {
        this._onTabEvent('updated', tab);
      }
    });
    browser.tabs.onMoved.addListener((tabId) => this._onTabEvent('moved', { id: tabId }));
    browser.tabs.onAttached.addListener((tabId) => this._onTabEvent('attached', { id: tabId }));
    browser.tabs.onDetached.addListener((tabId) => this._onTabEvent('detached', { id: tabId }));

    await this.captureFullState();
    return this.state;
  }

  setApplying(v) {
    if (v) this._applyingCount++;
    else this._applyingCount = Math.max(0, this._applyingCount - 1);
  }

  _onTabEvent() {
    if (this._applyingCount > 0) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.captureFullState(), this.DEBOUNCE_MS);
  }

  // --- Native Messaging ---

  async _getNativeData() {
    if (this._nativeAvailable === false) return null;

    const now = Date.now();
    if (this._nativeData && (now - this._nativeLastFetch) < NATIVE_CACHE_TTL) {
      return this._nativeData;
    }

    try {
      const resp = await browser.runtime.sendNativeMessage(NATIVE_HOST, { type: 'get_tab_data' });
      if (resp && resp.success) {
        this._nativeData = resp.data;
        this._nativeLastFetch = now;
        if (this._nativeAvailable === null) {
          console.log('[TabMonitor] Native messaging host connected');
        }
        this._nativeAvailable = true;
        return this._nativeData;
      }
      console.warn('[TabMonitor] Native host error:', resp?.error);
    } catch (e) {
      if (this._nativeAvailable === null) {
        console.warn('[TabMonitor] Native messaging unavailable:', e.message);
      }
    }
    this._nativeAvailable = false;
    return null;
  }

  // --- State Capture ---

  async captureFullState({ silent = false } = {}) {
    try {
      const nativeData = await this._getNativeData();

      const newState = (nativeData && Array.isArray(nativeData.tabs))
        ? await this._buildFromNative(nativeData)
        : await this._buildFromBrowserApi();

      const patch = this._computePatch(this.state, newState);
      this.state = newState;

      if (!silent && patch.operations.length > 0) {
        this.onStateChange(newState, patch);
      }
    } catch (err) {
      console.error('[TabMonitor] captureFullState error:', err);
    }
  }

  /**
   * Native session store data — has every workspace, every tab (incl. hidden),
   * every folder. The authoritative path.
   */
  async _buildFromNative(nativeData) {
    const now = Date.now();
    const workspaces = [];
    const folders = [];
    const tabs = [];

    this.workspaceUuidByName.clear();
    this.workspaceUuidBySyncId.clear();
    this.folderLocalIdBySyncId.clear();
    this.folderSyncIdByLocalId.clear();

    // Favicon overlay from browser.tabs (only active workspace tabs have favicons cached)
    const browserTabs = await browser.tabs.query({});
    const faviconByUrl = new Map();
    for (const bt of browserTabs) {
      if (bt.url && bt.favIconUrl) faviconByUrl.set(bt.url, bt.favIconUrl);
    }

    // 1. Workspaces — drop UUID-shaped names (corruption from old sync).
    const wsBySrcUuid = new Map();
    let wsPos = 0;
    for (const w of (nativeData.workspaces || [])) {
      const name = (w.name || '').trim();
      if (!name || UUID_NAME_RE.test(name)) {
        console.warn('[TabMonitor] dropping workspace with invalid name:', name || w.uuid);
        continue;
      }
      const syncId = makeSyncId('ws', name);
      const ws = {
        syncId,
        name,
        icon: w.icon || '',
        position: wsPos++,
        lastModified: now,
      };
      workspaces.push(ws);
      wsBySrcUuid.set(w.uuid, ws);
      this.workspaceUuidByName.set(name, w.uuid);
      this.workspaceUuidBySyncId.set(syncId, w.uuid);
    }

    // 2. Folders — first pass: by local id, capture raw fields.
    const rawFolders = (nativeData.folders || []).slice();
    const folderById = new Map(rawFolders.map(f => [f.id, f]));

    // Compute folder path (root → leaf names) for stable, tree-aware syncId.
    function folderPath(localId, seen = new Set()) {
      if (seen.has(localId)) return [];
      seen.add(localId);
      const f = folderById.get(localId);
      if (!f) return [];
      const parent = f.parentId ? folderPath(f.parentId, seen) : [];
      return [...parent, f.name || ''];
    }

    let fldPos = 0;
    const folderSyncIdByLocal = this.folderSyncIdByLocalId;
    for (const f of rawFolders) {
      const ws = wsBySrcUuid.get(f.workspaceId);
      if (!ws) continue;
      const path = folderPath(f.id);
      if (path.length === 0) continue;
      const syncId = makeSyncId('fld', `${ws.syncId}:${path.join('/')}`);
      const parentSyncId = f.parentId ? folderSyncIdByLocal.get(f.parentId) || null : null;

      folders.push({
        syncId,
        name: f.name || '',
        workspaceSyncId: ws.syncId,
        parentSyncId,
        collapsed: !!f.collapsed,
        userIcon: f.userIcon || '',
        position: fldPos++,
        lastModified: now,
      });

      folderSyncIdByLocal.set(f.id, syncId);
      this.folderLocalIdBySyncId.set(syncId, f.id);
    }

    // 3. Tabs — flat list with kind/workspaceSyncId/folderSyncId.
    //    Native data can contain duplicate URLs (e.g. same URL is essential in
    //    one space and pinned in another — Zen stores them as separate tabs).
    //    We collapse by URL with priority: essential > pinned-in-folder > pinned > normal.
    //    Without dedup, the same syncId would be emitted twice with conflicting
    //    properties, breaking idempotency and the diff engine.
    const byUrl = new Map();
    const score = (x) => (x.zenEssential ? 1000 : 0) + (x.groupId ? 10 : 0) + (x.pinned ? 1 : 0);
    for (const t of (nativeData.tabs || [])) {
      if (!t.url) continue;
      const existing = byUrl.get(t.url);
      if (!existing || score(t) > score(existing)) {
        byUrl.set(t.url, t);
      }
    }

    let tabPos = 0;
    for (const t of byUrl.values()) {
      const favicon = faviconByUrl.get(t.url) || '';
      const wsAnchor = t.zenWorkspace ? wsBySrcUuid.get(t.zenWorkspace) : null;

      let kind, workspaceSyncId;
      if (t.zenEssential) {
        kind = 'essential';
        workspaceSyncId = wsAnchor ? wsAnchor.syncId : null;
      } else if (!wsAnchor) {
        // Tab anchored to dropped/UUID-named workspace — skip; corruption.
        continue;
      } else {
        kind = t.pinned ? 'pinned' : 'normal';
        workspaceSyncId = wsAnchor.syncId;
      }

      const folderSyncId = (kind === 'pinned' && t.groupId)
        ? folderSyncIdByLocal.get(t.groupId) || null
        : null;

      tabs.push({
        syncId: makeSyncId('tab', t.url),
        url: t.url,
        title: t.title || '',
        icon: favicon,
        kind,
        workspaceSyncId,
        folderSyncId,
        pinned: kind !== 'normal',
        position: typeof t.position === 'number' ? t.position : tabPos++,
        lastModified: now,
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaces,
      folders,
      tabs,
    };
  }

  /**
   * Fallback: only sees active workspace via browser API. Limited but better than nothing.
   */
  async _buildFromBrowserApi() {
    const now = Date.now();
    const allTabs = await browser.tabs.query({});
    const workspaces = [];
    const tabs = [];

    this.workspaceUuidByName.clear();
    this.workspaceUuidBySyncId.clear();
    this.folderLocalIdBySyncId.clear();
    this.folderSyncIdByLocalId.clear();

    const wsBySrcUuid = new Map();

    let pos = 0;
    for (const tab of allTabs) {
      if (!tab.url || (!tab.url.startsWith('http:') && !tab.url.startsWith('https:'))) continue;

      const [ess, wsId] = await Promise.all([
        browser.sessions.getTabValue(tab.id, 'zen-essential').catch(() => null),
        browser.sessions.getTabValue(tab.id, 'zen-workspace-id').catch(() => null),
      ]);

      let workspaceSyncId = null;
      if (wsId) {
        let ws = wsBySrcUuid.get(wsId);
        if (!ws) {
          // Without zen-sessions data we have no name. Skip — don't emit UUID-named workspace.
          ws = null;
        }
        workspaceSyncId = ws?.syncId || null;
      }

      const kind = ess ? 'essential' : (tab.pinned ? 'pinned' : 'normal');
      if (!ess && !workspaceSyncId) continue;

      tabs.push({
        syncId: makeSyncId('tab', tab.url),
        url: tab.url,
        title: tab.title || '',
        icon: tab.favIconUrl || '',
        kind,
        workspaceSyncId,
        folderSyncId: null,
        pinned: kind !== 'normal',
        position: pos++,
        lastModified: now,
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaces,
      folders: [],
      tabs,
    };
  }

  // --- Diff Engine ---

  _computePatch(oldState, newState) {
    const ops = [];

    diffById(
      oldState.workspaces, newState.workspaces,
      WS_PROPS,
      (ws) => ops.push({ type: 'add_workspace', workspace: ws }),
      (syncId, changes, ws) => ops.push({ type: 'update_workspace', syncId, changes, workspace: ws }),
      (syncId) => ops.push({ type: 'remove_workspace', syncId }),
    );

    diffById(
      oldState.folders, newState.folders,
      FOLDER_PROPS,
      (f) => ops.push({ type: 'add_folder', folder: f }),
      (syncId, changes) => ops.push({ type: 'update_folder', syncId, changes }),
      (syncId) => ops.push({ type: 'remove_folder', syncId }),
    );

    diffById(
      oldState.tabs, newState.tabs,
      TAB_PROPS,
      (t) => ops.push({ type: 'add_tab', tab: t }),
      (syncId, changes, tab) => ops.push({ type: 'update_tab', syncId, changes, tab }),
      (syncId, oldTab) => ops.push({ type: 'remove_tab', syncId, url: oldTab?.url }),
    );

    return { operations: ops, timestamp: Date.now() };
  }
}

// --- Helpers (pure) ---

const WS_PROPS = ['name', 'icon', 'position'];
const FOLDER_PROPS = ['name', 'workspaceSyncId', 'parentSyncId', 'collapsed', 'userIcon', 'position'];
const TAB_PROPS = ['url', 'title', 'icon', 'kind', 'workspaceSyncId', 'folderSyncId', 'pinned', 'position'];

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, workspaces: [], folders: [], tabs: [] };
}

function makeSyncId(prefix, str) {
  return `${prefix}-${hashCode(str || '')}`;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function diffById(oldList, newList, propsToCompare, onAdd, onUpdate, onRemove) {
  const oldMap = new Map((oldList || []).map(x => [x.syncId, x]));
  const newIds = new Set((newList || []).map(x => x.syncId));

  for (const item of (newList || [])) {
    const old = oldMap.get(item.syncId);
    if (!old) {
      onAdd(item);
    } else {
      const changes = {};
      let changed = false;
      for (const k of propsToCompare) {
        if (old[k] !== item[k]) {
          changes[k] = item[k];
          changed = true;
        }
      }
      if (changed) {
        changes.lastModified = item.lastModified;
        onUpdate(item.syncId, changes, item);
      }
    }
  }
  for (const item of (oldList || [])) {
    if (!newIds.has(item.syncId)) onRemove(item.syncId, item);
  }
}

export default TabMonitor;
