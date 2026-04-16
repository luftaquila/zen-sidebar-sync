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

    // Experiment API cache
    this._experimentData = null;
    this._experimentLastFetch = 0;
    this._experimentAvailable = null;

    // Tab ID → info map for event-driven removal operations.
    // Populated from browser.tabs.query() after each state capture.
    this._tabIdToInfo = new Map();
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

    // Tab removals: generate removal op immediately from cached tab info.
    // This is the ONLY source of remove_tab/remove_essential ops — the diff
    // engine does NOT generate them, preventing incomplete captures from
    // creating false mass-removal patches.
    if (event === 'removed' && tab.id != null) {
      const info = this._tabIdToInfo.get(tab.id);
      if (info) {
        this._tabIdToInfo.delete(tab.id);
        // Update internal state
        if (info.isEssential) {
          this.state.essentials = this.state.essentials.filter(t => t.syncId !== info.syncId);
        } else if (info.workspaceSyncId) {
          const ws = this.state.workspaces.find(w => w.syncId === info.workspaceSyncId);
          if (ws) {
            ws.tabs = (ws.tabs || []).filter(t => t.syncId !== info.syncId);
            ws.pinnedTabs = (ws.pinnedTabs || []).filter(t => t.syncId !== info.syncId);
          }
        }
        const op = info.isEssential
          ? { type: 'remove_essential', syncId: info.syncId, url: info.url }
          : { type: 'remove_tab', workspaceSyncId: info.workspaceSyncId,
              workspaceName: info.workspaceName, syncId: info.syncId, url: info.url };
        this.onStateChange(this.state, { operations: [op], timestamp: Date.now() });
      }
      return; // Removal handled — no debounced capture needed
    }

    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.captureFullState(), this.DEBOUNCE_MS);
  }

  /**
   * Invalidate experiment and native caches so the next captureFullState
   * fetches fresh data. Called after apply operations.
   */
  invalidateCache() {
    this._experimentData = null;
    this._experimentLastFetch = 0;
    this._nativeData = null;
    this._nativeLastFetch = 0;
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
      this._nativeAvailable = false;
    }
    // Only mark unavailable on exception (connection failure).
    // Empty data (resp.success but 0 tabs) is transient — don't disable permanently.
    return null;
  }

  // --- Experiment API (chrome context) ---

  async _getExperimentData() {
    if (this._experimentAvailable === false) return null;

    const now = Date.now();
    if (this._experimentData && (now - this._experimentLastFetch) < NATIVE_CACHE_TTL) {
      return this._experimentData;
    }

    try {
      if (typeof browser.zenInternals === 'undefined') {
        this._experimentAvailable = false;
        return null;
      }
      const data = await browser.zenInternals.getTabData();
      if (data && data.tabs && data.tabs.length > 0) {
        this._experimentData = data;
        this._experimentLastFetch = now;
        if (this._experimentAvailable === null) {
          console.log('[TabMonitor] Experiment API (zenInternals.getTabData) connected');
        }
        this._experimentAvailable = true;
        return this._experimentData;
      }
      // API is available but returned empty data (e.g. browser startup).
      // Don't mark as unavailable — it will work once tabs load.
      return null;
    } catch (e) {
      if (this._experimentAvailable === null) {
        console.warn('[TabMonitor] Experiment API unavailable:', e.message);
      }
      this._experimentAvailable = false;
      return null;
    }
  }

  // --- State Capture ---

  /**
   * Capture current browser state.
   * @param {Object} opts
   * @param {boolean} opts.silent - If true, update state without firing onStateChange
   */
  async captureFullState({ silent = false, skipGuard = false } = {}) {
    try {
      // Priority: experiment API > native host > browser.tabs fallback
      let newState;
      const experimentData = await this._getExperimentData();
      if (experimentData && experimentData.tabs && experimentData.tabs.length > 0) {
        newState = await this._buildFromNative(experimentData);
      } else {
        const nativeData = await this._getNativeData();
        if (nativeData && nativeData.tabs && nativeData.tabs.length > 0) {
          newState = await this._buildFromNative(nativeData);
        } else {
          newState = await this._buildFromBrowserApi();
        }
      }

      // Data source returned unreliable data (e.g. many unresolved workspace UUIDs)
      if (!newState) return;

      // Reject captures where tab count drops dramatically — indicates incomplete
      // data from experiment API or native host. skipGuard is true for post-apply
      // recaptures where the drop is intentional (remote state had fewer tabs).
      if (!skipGuard) {
        const oldCount = this._countTabs(this.state);
        const newCount = this._countTabs(newState);
        if (oldCount > 5 && newCount < oldCount * 0.3) {
          console.warn(`[TabMonitor] Capture rejected: tab count dropped ${oldCount} → ${newCount} (>70% loss)`);
          return;
        }
      }

      const patch = this._computePatch(this.state, newState);

      // Extract experiment tab IDs before storing state
      const tabIdToUrl = newState._tabIdToUrl;
      delete newState._tabIdToUrl;

      this.state = newState;

      // Build _tabIdToInfo for event-driven removals.
      // Experiment API tab IDs cover ALL workspaces (including hidden ones).
      // browser.tabs.query fallback only covers active workspace.
      if (tabIdToUrl && tabIdToUrl.size > 0) {
        this._buildTabIdInfoFromExperiment(tabIdToUrl);
      } else {
        await this._updateTabIdMap();
      }

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

    // Reverse map: UUID → workspace name from previous captures.
    // Used to resolve workspace names when the workspace list is temporarily incomplete.
    const reverseWsMap = new Map();
    for (const [name, uuid] of this.workspaceUuidMap) {
      reverseWsMap.set(uuid, name);
    }

    // Collect WebExtension tab IDs from experiment API (covers all workspaces).
    // Native host data doesn't have tab IDs, so this map is only populated
    // when the experiment API provided the data.
    const tabIdToUrl = new Map();

    let skippedTabs = 0;
    for (const tab of nativeData.tabs) {
      const favicon = faviconByUrl.get(tab.url) || '';
      if (tab.tabId != null) tabIdToUrl.set(tab.tabId, tab.url);

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
          if (zenUuid === '__default__') {
            workspaceMap.set(zenUuid, {
              _zenUuid: zenUuid,
              syncId: zenUuid,
              name: 'Default',
              icon: '',
              tabs: [],
              pinnedTabs: [],
              position: workspaceMap.size,
              lastModified: Date.now(),
            });
          } else {
            // Try to resolve from previously known workspace names
            const knownName = reverseWsMap.get(zenUuid);
            if (knownName) {
              workspaceMap.set(zenUuid, {
                _zenUuid: zenUuid,
                syncId: zenUuid,
                name: knownName,
                icon: '',
                tabs: [],
                pinnedTabs: [],
                position: workspaceMap.size,
                lastModified: Date.now(),
              });
            } else {
              // Truly unknown workspace UUID — skip this tab rather than
              // creating a phantom UUID-named workspace.
              skippedTabs++;
              continue;
            }
          }
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

    // Too many tabs referencing unknown workspace UUIDs = unreliable data source
    const totalTabs = nativeData.tabs.length;
    if (totalTabs > 5 && skippedTabs > totalTabs * 0.2) {
      console.warn(`[TabMonitor] Capture rejected: ${skippedTabs}/${totalTabs} tabs reference unknown workspaces`);
      return null;
    }
    if (skippedTabs > 0) {
      console.warn(`[TabMonitor] Skipped ${skippedTabs} tabs with unresolvable workspace UUIDs`);
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

    // Build folder id → (name, wsName) for parent resolution
    const folderIdToKey = new Map();
    for (const f of (nativeData.folders || [])) {
      const wsName = wsUuidToName.get(f.workspaceId) || '';
      folderIdToKey.set(f.id, { name: f.name || '', wsName });
    }

    for (const f of (nativeData.folders || [])) {
      if (!f.name) continue; // Skip unnamed system/placeholder folders
      const wsName = wsUuidToName.get(f.workspaceId) || '';
      // Name-based syncId for cross-device consistency (not device-local DOM id)
      const syncId = this._makeSyncId('fld', `${f.name}:${wsName}`);
      let parentSyncId = null;
      if (f.parentId) {
        const parent = folderIdToKey.get(f.parentId);
        if (parent) {
          parentSyncId = this._makeSyncId('fld', `${parent.name}:${parent.wsName}`);
        }
      }
      newState.folders.push({
        syncId,
        name: f.name || '',
        collapsed: f.collapsed,
        parentSyncId,
        workspaceName: wsName,
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

    // Pass experiment tab IDs through for full-workspace _tabIdToInfo map
    if (tabIdToUrl.size > 0) {
      newState._tabIdToUrl = tabIdToUrl;
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

  async _enrichWorkspaceNames(workspaces) {
    // Try experiment API first (chrome context, reads gZenWorkspaces directly)
    try {
      if (typeof browser.zenInternals !== 'undefined') {
        const zenWorkspaces = await browser.zenInternals.getWorkspaces();
        if (zenWorkspaces && zenWorkspaces.length > 0) {
          for (const zenWs of zenWorkspaces) {
            const ws = workspaces.find(w => w._zenUuid === zenWs.uuid);
            if (ws) {
              ws.name = zenWs.name || ws.name;
              ws.icon = zenWs.icon || ws.icon;
            }
          }
          return;
        }
      }
    } catch {}

    // Fallback: browser.sessions API (reads from extData, may not work)
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

  _arraysEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  _countTabs(state) {
    if (!state) return 0;
    let count = (state.essentials || []).length;
    for (const ws of (state.workspaces || [])) {
      count += (ws.tabs || []).length + (ws.pinnedTabs || []).length;
    }
    return count;
  }

  /**
   * Build _tabIdToInfo from experiment API tab IDs (covers ALL workspaces).
   * Used when getTabData provides tabId fields.
   */
  _buildTabIdInfoFromExperiment(tabIdToUrl) {
    this._tabIdToInfo.clear();
    for (const [tabId, url] of tabIdToUrl) {
      const essSyncId = this._makeSyncId('ess', url);
      if (this.state.essentials.some(e => e.syncId === essSyncId)) {
        this._tabIdToInfo.set(tabId, {
          url, syncId: essSyncId, isEssential: true,
          workspaceSyncId: null, workspaceName: null,
        });
        continue;
      }

      const tabSyncId = this._makeSyncId('tab', url);
      for (const ws of this.state.workspaces) {
        const allWsTabs = [...(ws.tabs || []), ...(ws.pinnedTabs || [])];
        if (allWsTabs.some(t => t.syncId === tabSyncId)) {
          this._tabIdToInfo.set(tabId, {
            url, syncId: tabSyncId, isEssential: false,
            workspaceSyncId: ws.syncId, workspaceName: ws.name,
          });
          break;
        }
      }
    }
  }

  /**
   * Fallback: rebuild _tabIdToInfo from browser.tabs.query results.
   * Only covers active workspace tabs (hidden workspace tabs invisible).
   */
  async _updateTabIdMap() {
    try {
      const browserTabs = await browser.tabs.query({});
      this._tabIdToInfo.clear();
      for (const bt of browserTabs) {
        if (!bt.url || (!bt.url.startsWith('http:') && !bt.url.startsWith('https:'))) continue;

        const essSyncId = this._makeSyncId('ess', bt.url);
        if (this.state.essentials.some(e => e.syncId === essSyncId)) {
          this._tabIdToInfo.set(bt.id, {
            url: bt.url, syncId: essSyncId, isEssential: true,
            workspaceSyncId: null, workspaceName: null,
          });
          continue;
        }

        const tabSyncId = this._makeSyncId('tab', bt.url);
        for (const ws of this.state.workspaces) {
          const allWsTabs = [...(ws.tabs || []), ...(ws.pinnedTabs || [])];
          if (allWsTabs.some(t => t.syncId === tabSyncId)) {
            this._tabIdToInfo.set(bt.id, {
              url: bt.url, syncId: tabSyncId, isEssential: false,
              workspaceSyncId: ws.syncId, workspaceName: ws.name,
            });
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[TabMonitor] _updateTabIdMap error:', e.message);
    }
  }

  // --- Diff Engine ---
  //
  // Tab/essential REMOVALS are NOT generated by diffs. They come exclusively
  // from tabs.onRemoved browser events (see _onTabEvent). This prevents
  // incomplete data captures from generating false mass-removal patches.
  //
  // Exception: "moves" (e.g. essential→workspace) emit a removal paired with
  // an addition for the same URL, detected via addedUrls set below.

  _computePatch(oldState, newState) {
    const operations = [];
    const pendingRemovals = []; // Collected but not yet emitted

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
        pendingRemovals.push({ type: 'remove_essential', syncId: tab.syncId, url: tab.url });
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
        this._diffTabList(oldWs.tabs || [], ws.tabs || [], ws.syncId, ws.name, false, operations, pendingRemovals);
        this._diffTabList(oldWs.pinnedTabs || [], ws.pinnedTabs || [], ws.syncId, ws.name, true, operations, pendingRemovals);
      }
    }
    // Workspace removals always from diff (small list, reliable)
    for (const ws of oldState.workspaces) {
      if (!newWsIds.has(ws.syncId)) {
        operations.push({ type: 'remove_workspace', syncId: ws.syncId, workspace: ws });
      }
    }

    // Move detection: only emit tab/essential removals if the same URL was
    // re-added elsewhere. True tab closes come from tabs.onRemoved events.
    const addedUrls = new Set();
    for (const op of operations) {
      if ((op.type === 'add_essential' || op.type === 'add_tab') && op.tab?.url) {
        addedUrls.add(op.tab.url);
      }
      if (op.type === 'add_workspace' && op.workspace) {
        for (const t of [...(op.workspace.tabs || []), ...(op.workspace.pinnedTabs || [])]) {
          if (t.url) addedUrls.add(t.url);
        }
      }
    }
    for (const removal of pendingRemovals) {
      if (addedUrls.has(removal.url)) {
        operations.push(removal);
      }
    }

    // Diff folders (folder list is small and reliable — diff-driven is safe)
    const oldFldMap = new Map((oldState.folders || []).map(f => [f.syncId, f]));
    const newFldIds = new Set((newState.folders || []).map(f => f.syncId));

    for (const folder of (newState.folders || [])) {
      const old = oldFldMap.get(folder.syncId);
      if (!old) {
        operations.push({ type: 'add_folder', folder });
      } else {
        const tabUrlsChanged = !this._arraysEqual(old.tabUrls || [], folder.tabUrls || []);
        if (tabUrlsChanged) {
          operations.push({ type: 'remove_folder', syncId: folder.syncId, folder: old });
          operations.push({ type: 'add_folder', folder });
        } else if (old.name !== folder.name || old.collapsed !== folder.collapsed ||
                   old.userIcon !== folder.userIcon) {
          operations.push({
            type: 'update_folder',
            syncId: folder.syncId,
            oldName: old.name,
            changes: {
              name: folder.name,
              collapsed: folder.collapsed,
              userIcon: folder.userIcon,
              workspaceName: folder.workspaceName,
              tabUrls: folder.tabUrls,
            },
          });
        }
      }
    }
    for (const folder of (oldState.folders || [])) {
      if (!newFldIds.has(folder.syncId)) {
        operations.push({ type: 'remove_folder', syncId: folder.syncId, folder });
      }
    }

    return { operations, timestamp: Date.now() };
  }

  _diffTabList(oldTabs, newTabs, workspaceSyncId, workspaceName, pinned, operations, pendingRemovals) {
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
    // Tab removals go to pendingRemovals for move detection, NOT operations.
    // Actual closes come from tabs.onRemoved events.
    for (const tab of oldTabs) {
      if (!newIds.has(tab.syncId)) {
        pendingRemovals.push({ type: 'remove_tab', workspaceSyncId, workspaceName, syncId: tab.syncId, url: tab.url });
      }
    }
  }
}

export default TabMonitor;
