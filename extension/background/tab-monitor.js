/**
 * Tab Monitor - Tracks Zen Browser tab state
 *
 * Uses a native messaging host to read Zen's internal session store files
 * (recovery.jsonlz4, zen-sessions.jsonlz4) for workspace/essential data
 * that isn't accessible via WebExtension APIs.
 *
 * Falls back to browser.sessions API if native host is unavailable.
 */

const NATIVE_HOST = 'zen_sidebar_sync';
const NATIVE_CACHE_TTL = 5000; // 5 seconds

class TabMonitor {
  constructor(onStateChange) {
    this.onStateChange = onStateChange;
    this.state = { essentials: [], workspaces: [] };
    this.debounceTimer = null;
    this.DEBOUNCE_MS = 300;
    this._applyingCount = 0;
    /** @type {Map<string, string>} workspace name -> local Zen UUID */
    this.workspaceUuidMap = new Map();

    // Native messaging cache
    this._nativeData = null;
    this._nativeLastFetch = 0;
    this._nativeAvailable = null; // null=unknown, true/false after first try
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

  _onTabEvent(event, tab) {
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
      const resp = await browser.runtime.sendNativeMessage(
        NATIVE_HOST, { type: 'get_tab_data' }
      );
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
        console.warn('[TabMonitor] Install the native host: extension/native/install.sh');
      }
    }
    this._nativeAvailable = false;
    return null;
  }

  // --- State Capture ---

  /**
   * Capture current browser state.
   * @param {Object} opts
   * @param {boolean} opts.silent - If true, update state without firing onStateChange
   */
  async captureFullState({ silent = false } = {}) {
    try {
      const nativeData = await this._getNativeData();

      let newState;
      if (nativeData && nativeData.tabs && nativeData.tabs.length > 0) {
        newState = await this._buildFromNative(nativeData);
      } else {
        newState = await this._buildFromBrowserApi();
      }

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
   * Build state from native host session store data (all workspaces, all tabs).
   * Overlays browser API data for favicons on visible tabs.
   */
  async _buildFromNative(nativeData) {
    const newState = { essentials: [], workspaces: [], groups: [], folders: [] };
    const workspaceMap = new Map();

    // Get browser tabs for favicon overlay
    const browserTabs = await browser.tabs.query({});
    const faviconByUrl = new Map();
    for (const bt of browserTabs) {
      if (bt.url && bt.favIconUrl) faviconByUrl.set(bt.url, bt.favIconUrl);
    }

    // Pre-populate ALL workspaces from native data (including empty ones)
    for (const wsDef of (nativeData.workspaces || [])) {
      workspaceMap.set(wsDef.uuid, {
        _zenUuid: wsDef.uuid,
        syncId: wsDef.uuid,
        name: wsDef.name || wsDef.uuid,
        icon: wsDef.icon || '',
        tabs: [],
        pinnedTabs: [],
        position: workspaceMap.size,
        lastModified: Date.now(),
      });
    }

    for (const tab of nativeData.tabs) {
      const favicon = faviconByUrl.get(tab.url) || '';

      if (tab.zenEssential) {
        newState.essentials.push({
          syncId: this._makeSyncId('ess', tab.url),
          url: tab.url,
          title: tab.title || '',
          icon: favicon,
          groupId: tab.groupId || null,
          position: 0,
          lastModified: Date.now(),
        });
      } else {
        const zenUuid = tab.zenWorkspace || '__default__';
        if (!workspaceMap.has(zenUuid)) {
          workspaceMap.set(zenUuid, {
            _zenUuid: zenUuid,
            syncId: zenUuid,
            name: zenUuid === '__default__' ? 'Default' : zenUuid,
            icon: '',
            tabs: [],
            pinnedTabs: [],
            position: workspaceMap.size,
            lastModified: Date.now(),
          });
        }

        const ws = workspaceMap.get(zenUuid);
        const tabData = {
          syncId: this._makeSyncId('tab', tab.url),
          url: tab.url,
          title: tab.title || '',
          icon: favicon,
          groupId: tab.groupId || null,
          position: 0,
          pinned: tab.pinned,
          lastModified: Date.now(),
        };

        if (tab.pinned) ws.pinnedTabs.push(tabData);
        else ws.tabs.push(tabData);
      }
    }

    newState.workspaces = Array.from(workspaceMap.values());

    // Groups and folders — use workspace name-based IDs for cross-device sync
    const wsUuidToName = new Map();
    for (const wsDef of (nativeData.workspaces || [])) {
      wsUuidToName.set(wsDef.uuid, wsDef.name);
    }

    for (const g of (nativeData.groups || [])) {
      newState.groups.push({
        syncId: this._makeSyncId('grp', g.id),
        name: g.name || '',
        color: g.color || '',
        collapsed: g.collapsed,
        pinned: g.pinned,
        essential: g.essential,
      });
    }

    // Build folder id → tab URLs mapping via groupId
    const folderTabUrls = new Map();
    for (const tab of nativeData.tabs) {
      if (tab.groupId) {
        if (!folderTabUrls.has(tab.groupId)) folderTabUrls.set(tab.groupId, []);
        folderTabUrls.get(tab.groupId).push(tab.url);
      }
    }

    for (const f of (nativeData.folders || [])) {
      newState.folders.push({
        syncId: this._makeSyncId('fld', f.id),
        name: f.name || '',
        collapsed: f.collapsed,
        parentSyncId: f.parentId ? this._makeSyncId('fld', f.parentId) : null,
        workspaceName: wsUuidToName.get(f.workspaceId) || '',
        userIcon: f.userIcon || '',
        isLiveFolder: f.isLiveFolder,
        tabUrls: folderTabUrls.get(f.id) || [],
      });
    }

    this.workspaceUuidMap.clear();
    for (const ws of newState.workspaces) {
      this.workspaceUuidMap.set(ws.name, ws._zenUuid);
      ws.syncId = this._makeSyncId('ws', ws.name);
      delete ws._zenUuid;
    }

    return newState;
  }

  /**
   * Fallback: build state from browser.tabs API + browser.sessions.
   * Only sees active workspace tabs.
   */
  async _buildFromBrowserApi() {
    const allTabs = await browser.tabs.query({});
    const newState = { essentials: [], workspaces: [], groups: [], folders: [] };
    const workspaceMap = new Map();

    for (const tab of allTabs) {
      if (!tab.url || (!tab.url.startsWith('http:') && !tab.url.startsWith('https:'))) {
        continue;
      }

      const [ess, wsId] = await Promise.all([
        browser.sessions.getTabValue(tab.id, 'zen-essential').catch(() => null),
        browser.sessions.getTabValue(tab.id, 'zen-workspace-id').catch(() => null),
      ]);

      if (ess) {
        newState.essentials.push({
          syncId: this._makeSyncId('ess', tab.url),
          url: tab.url,
          title: tab.title || '',
          icon: tab.favIconUrl || '',
          position: tab.index,
          lastModified: Date.now(),
        });
      } else {
        const zenUuid = wsId || '__default__';
        if (!workspaceMap.has(zenUuid)) {
          workspaceMap.set(zenUuid, {
            _zenUuid: zenUuid,
            syncId: zenUuid,
            name: zenUuid === '__default__' ? 'Default' : zenUuid,
            icon: '',
            tabs: [],
            pinnedTabs: [],
            position: workspaceMap.size,
            lastModified: Date.now(),
          });
        }

        const ws = workspaceMap.get(zenUuid);
        const tabData = {
          syncId: this._makeSyncId('tab', tab.url),
          url: tab.url,
          title: tab.title || '',
          icon: tab.favIconUrl || '',
          position: tab.index,
          pinned: tab.pinned,
          lastModified: Date.now(),
        };

        if (tab.pinned) ws.pinnedTabs.push(tabData);
        else ws.tabs.push(tabData);
      }
    }

    newState.workspaces = Array.from(workspaceMap.values());
    await this._enrichWorkspaceNames(newState.workspaces);

    this.workspaceUuidMap.clear();
    for (const ws of newState.workspaces) {
      this.workspaceUuidMap.set(ws.name, ws._zenUuid);
      ws.syncId = this._makeSyncId('ws', ws.name);
      delete ws._zenUuid;
    }

    return newState;
  }

  // --- Fallback: browser.sessions API ---

  async _enrichWorkspaceNames(workspaces) {
    try {
      const windows = await browser.windows.getAll();
      const wsDataList = await Promise.all(
        windows.map(win =>
          browser.sessions.getWindowValue(win.id, 'zen-workspace-data').catch(() => null)
        )
      );
      for (const wsData of wsDataList) {
        if (wsData && Array.isArray(wsData)) {
          for (const zenWs of wsData) {
            const ws = workspaces.find(w => w._zenUuid === zenWs.uuid);
            if (ws) {
              ws.name = zenWs.name || ws.name;
              ws.icon = zenWs.icon || ws.icon;
            }
          }
        }
      }
    } catch {}
  }

  // --- Utilities ---

  _makeSyncId(prefix, str) {
    return `${prefix}-${this._hashCode(str || '')}`;
  }

  _hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // --- Diff Engine ---

  _computePatch(oldState, newState) {
    const operations = [];

    // Diff essentials
    const oldEssMap = new Map(oldState.essentials.map(t => [t.syncId, t]));
    const newEssIds = new Set(newState.essentials.map(t => t.syncId));

    for (const tab of newState.essentials) {
      const old = oldEssMap.get(tab.syncId);
      if (!old) {
        operations.push({ type: 'add_essential', tab });
      } else if (old.url !== tab.url || old.title !== tab.title) {
        operations.push({
          type: 'update_essential',
          syncId: tab.syncId,
          oldUrl: old.url,
          changes: { url: tab.url, title: tab.title, icon: tab.icon },
        });
      }
    }
    for (const tab of oldState.essentials) {
      if (!newEssIds.has(tab.syncId)) {
        operations.push({ type: 'remove_essential', syncId: tab.syncId, url: tab.url });
      }
    }

    // Diff workspaces
    const oldWsMap = new Map(oldState.workspaces.map(w => [w.syncId, w]));
    const newWsIds = new Set(newState.workspaces.map(w => w.syncId));

    for (const ws of newState.workspaces) {
      const oldWs = oldWsMap.get(ws.syncId);
      if (!oldWs) {
        operations.push({ type: 'add_workspace', workspace: ws });
      } else {
        if (oldWs.name !== ws.name || oldWs.icon !== ws.icon) {
          operations.push({
            type: 'update_workspace',
            syncId: ws.syncId,
            changes: { name: ws.name, icon: ws.icon },
          });
        }
        this._diffTabList(oldWs.tabs || [], ws.tabs || [], ws.syncId, ws.name, false, operations);
        this._diffTabList(oldWs.pinnedTabs || [], ws.pinnedTabs || [], ws.syncId, ws.name, true, operations);
      }
    }
    for (const ws of oldState.workspaces) {
      if (!newWsIds.has(ws.syncId)) {
        operations.push({ type: 'remove_workspace', syncId: ws.syncId, workspace: ws });
      }
    }

    return { operations, timestamp: Date.now() };
  }

  _diffTabList(oldTabs, newTabs, workspaceSyncId, workspaceName, pinned, operations) {
    const oldMap = new Map(oldTabs.map(t => [t.syncId, t]));
    const newIds = new Set(newTabs.map(t => t.syncId));

    for (const tab of newTabs) {
      const old = oldMap.get(tab.syncId);
      if (!old) {
        operations.push({ type: 'add_tab', workspaceSyncId, workspaceName, tab, pinned });
      } else if (old.url !== tab.url || old.title !== tab.title) {
        operations.push({
          type: 'update_tab',
          workspaceSyncId,
          workspaceName,
          syncId: tab.syncId,
          oldUrl: old.url,
          changes: { url: tab.url, title: tab.title, icon: tab.icon },
        });
      }
    }
    for (const tab of oldTabs) {
      if (!newIds.has(tab.syncId)) {
        operations.push({ type: 'remove_tab', workspaceSyncId, workspaceName, syncId: tab.syncId, url: tab.url });
      }
    }
  }
}

export default TabMonitor;
