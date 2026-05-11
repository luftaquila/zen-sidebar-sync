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

const SCHEMA_VERSION = 3;
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

    // Tabs the applier just created via browser.tabs.create. Their
    // currentURI is "about:blank" for up to several hundred ms while the
    // real URL loads, so the runtime API capture skips them entirely
    // (the http/https filter). Without this map, the silent recapture
    // after apply produces a state that's MISSING the tab we just
    // created — the very next normal capture then diffs against that
    // gap and emits add_tab back to the server. That's the echo loop
    // that creates duplicate tabs on every navigation.
    /** @type {Map<string, {tab: object, expiresAt: number}>} url -> info */
    this._pendingTabs = new Map();
  }

  /** Called by tab-applier after browser.tabs.create succeeds. */
  recordPendingTab(remoteTab) {
    if (!remoteTab?.url) return;
    this._pendingTabs.set(remoteTab.url, {
      tab: { ...remoteTab, lastModified: Date.now() },
      expiresAt: Date.now() + 60000, // safety: drop after 60s even if URL never loads
    });
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

  /**
   * Bust the native cache so the next captureFullState fetches fresh data
   * instead of returning the stale snapshot taken before an apply.
   */
  invalidateCache() {
    this._nativeData = null;
    this._nativeLastFetch = 0;
  }

  // --- Runtime / Native data source ---

  // Preferred: read state straight from Zen's chrome runtime via the
  // experiment API. Zero flush latency, so local changes show up in capture
  // immediately. Native messaging is used only as a fallback when the
  // experiment API isn't loaded (legacy/dev installs).

  async _getRuntimeState() {
    try {
      const data = await browser.zenInternals.getRuntimeState();
      if (data && Array.isArray(data.tabs)) {
        if (this._runtimeAvailable === undefined) {
          console.log('[TabMonitor] Runtime state via experiment API');
        }
        this._runtimeAvailable = true;
        return data;
      }
    } catch (e) {
      if (this._runtimeAvailable === undefined) {
        console.warn('[TabMonitor] Runtime API unavailable:', e?.message);
      }
      this._runtimeAvailable = false;
    }
    return null;
  }

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
      // Successful round-trip but empty data is transient (browser starting up,
      // session not yet loaded). Don't disable permanently.
      return null;
    } catch (e) {
      if (this._nativeAvailable === null) {
        console.warn('[TabMonitor] Native messaging unavailable:', e.message);
      }
      this._nativeAvailable = false;
      return null;
    }
  }

  // --- State Capture ---

  async captureFullState({ silent = false, skipGuard = false } = {}) {
    try {
      // Preferred path: runtime state via experiment API — no flush lag.
      // Fall back to native host (lagged but works without chrome API),
      // then to browser API (active workspace only, fallback marker).
      let source = await this._getRuntimeState();
      if (!source) source = await this._getNativeData();

      const newState = (source && Array.isArray(source.tabs))
        ? await this._buildFromNative(source)
        : await this._buildFromBrowserApi();

      // Inject any in-flight (just-created via apply) tabs that haven't
      // surfaced in the runtime capture yet. Without this, silent recapture
      // produces a state missing freshly-created tabs, the next normal
      // capture diffs against that gap, and we emit a spurious add_tab
      // back to the server (the echo that creates duplicates on receivers).
      if (this._pendingTabs.size > 0) {
        const capturedUrls = new Set(newState.tabs.map(t => t.url));
        const now = Date.now();
        for (const [url, entry] of this._pendingTabs) {
          if (capturedUrls.has(url)) {
            // Real tab is now visible to capture; stop tracking.
            this._pendingTabs.delete(url);
          } else if (now > entry.expiresAt) {
            this._pendingTabs.delete(url);
          } else {
            newState.tabs.push(entry.tab);
          }
        }
      }

      // Reject captures where the tab count collapses unexpectedly. This catches
      // partial native reads (e.g. session store mid-write) that would otherwise
      // diff into a flood of remove_tab ops and propagate as mass deletion.
      // Post-apply recaptures use skipGuard since the drop may be intentional
      // (we just received a state where many tabs were removed).
      if (!skipGuard) {
        const oldCount = (this.state.tabs || []).length;
        const newCount = (newState.tabs || []).length;
        if (oldCount > 5 && newCount < oldCount * 0.3) {
          console.warn(`[TabMonitor] Capture rejected: tab count dropped ${oldCount} → ${newCount} (>70% loss)`);
          return;
        }
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
    // `theme` (Zen's gradient/color identity) flows through so receiving
    // devices recreate the workspace with matching visual identity.
    const wsBySrcUuid = new Map();
    let wsPos = 0;
    for (const w of (nativeData.workspaces || [])) {
      const name = (w.name || '').trim();
      if (!name || UUID_NAME_RE.test(name)) {
        console.warn('[TabMonitor] dropping workspace with invalid name:', name || w.uuid);
        continue;
      }
      const syncId = makeSyncId('ws', name);
      // Reject empty themes (defaults with no gradientColors) so we never
      // overwrite a receiver's populated theme with sterile placeholder.
      const theme = (w.theme && Array.isArray(w.theme.gradientColors) && w.theme.gradientColors.length > 0)
        ? w.theme : null;
      const ws = {
        syncId,
        name,
        icon: w.icon || '',
        theme,
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

      // Schema v3: identity is per-tab sync UUID (persisted via SessionStore).
      // URL is now a regular property — changes (navigation) produce
      // update_tab ops instead of remove+add cycles, eliminating the
      // "page navigation creates a new tab on the other device" bug.
      // Tabs without a syncUuid (native host fallback, no chrome access)
      // are skipped — better than emitting URL-based syncIds that won't
      // round-trip with UUID-based ones from the other device.
      if (!t.syncUuid) {
        continue;
      }

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
        syncId: `tab-${t.syncUuid}`,
        syncUuid: t.syncUuid,
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
   * Fallback when the native messaging host isn't available. Visibility is
   * limited to the active workspace (browser.tabs.query only returns visible
   * tabs), but we recover workspace names from per-window session storage so
   * tabs are at least anchored to a real syncId instead of being dropped.
   */
  async _buildFromBrowserApi() {
    const now = Date.now();
    const allTabs = await browser.tabs.query({});
    const tabs = [];

    this.workspaceUuidByName.clear();
    this.workspaceUuidBySyncId.clear();
    this.folderLocalIdBySyncId.clear();
    this.folderSyncIdByLocalId.clear();

    // Resolve workspace UUID → name from window-level session data. Zen
    // stores the workspace list as a `zen-workspace-data` window value;
    // without this we have no way to translate a tab's `zen-workspace-id`
    // attribute into a stable name-based syncId.
    const wsBySrcUuid = new Map();
    try {
      const windows = await browser.windows.getAll();
      const winData = await Promise.all(windows.map(w =>
        browser.sessions.getWindowValue(w.id, 'zen-workspace-data').catch(() => null)
      ));
      let wsPos = 0;
      for (const list of winData) {
        if (!Array.isArray(list)) continue;
        for (const zw of list) {
          if (!zw?.uuid || wsBySrcUuid.has(zw.uuid)) continue;
          const name = (zw.name || '').trim();
          if (!name || UUID_NAME_RE.test(name)) continue;
          const syncId = makeSyncId('ws', name);
          const ws = { syncId, name, icon: zw.icon || '', position: wsPos++, lastModified: now };
          wsBySrcUuid.set(zw.uuid, ws);
          this.workspaceUuidByName.set(name, zw.uuid);
          this.workspaceUuidBySyncId.set(syncId, zw.uuid);
        }
      }
    } catch (e) {
      console.warn('[TabMonitor] workspace name resolution failed:', e.message);
    }

    const workspaces = Array.from(wsBySrcUuid.values());

    // Schema v3 requires per-tab syncUuid from chrome-side SessionStore.
    // The browser-API fallback can't read it (browser.sessions and
    // SessionStore.getCustomTabValue are different storage), so we
    // intentionally emit NO tabs here. Workspaces still flow through so
    // the applier knows the layout, but the _fallback flag still blocks
    // the apply path entirely — preventing the "every tab duplicates"
    // failure mode that motivated this whole architecture change.

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaces,
      folders: [],
      tabs: [],
      _fallback: true,
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

// `position` is intentionally omitted: positions are recomputed every
// capture from DOM order, so the value flutters at the noise floor (any
// tab being added/removed shifts every subsequent index). Without removing
// it from the diff, every capture emits dozens of position-only update ops
// for tabs/folders that didn't actually move — exactly the ~600ms echo
// storm visible on the server. We don't apply position changes anyway
// (no reorder API), so the data is purely informational.
//
// `theme` is also omitted from WS_PROPS: it's an object whose runtime-API
// representation differs by reference (and sometimes by content — Zen's
// shallow-clone of _workspaceCache strips gradient internals), making the
// diff fire on every capture. Theme is propagated via add_workspace at
// creation time and via explicit setWorkspaceTheme calls only.
const WS_PROPS = ['name', 'icon'];
const FOLDER_PROPS = ['name', 'workspaceSyncId', 'parentSyncId', 'collapsed', 'userIcon'];
const TAB_PROPS = ['url', 'title', 'icon', 'kind', 'workspaceSyncId', 'folderSyncId', 'pinned'];

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

  // Object-valued props (theme is a gradient definition object) need deep
  // comparison; reference equality would emit a spurious update on every
  // capture since each capture allocates a fresh object.
  const eq = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
  };

  for (const item of (newList || [])) {
    const old = oldMap.get(item.syncId);
    if (!old) {
      onAdd(item);
    } else {
      const changes = {};
      let changed = false;
      for (const k of propsToCompare) {
        if (!eq(old[k], item[k])) {
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

export { makeSyncId };
export default TabMonitor;
