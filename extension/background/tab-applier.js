/**
 * Tab Applier - Applies remote v2 state/patches to the local Zen Browser.
 *
 * Identity contract:
 *   - workspaces: name-based syncId -> local Zen UUID via tabMonitor.workspaceUuidBySyncId
 *   - folders:    path-based syncId -> local Zen folder DOM id via tabMonitor.folderLocalIdBySyncId
 *   - tabs:       url-based syncId; reconciliation finds the local tab by URL
 *
 * Every Zen-internal mutation goes through the experiment API (browser.zenInternals.*).
 * Each call is best-effort and returns {success, error?}; failures are logged but never
 * abort the apply — partial sync is preferable to corrupted state.
 *
 * After every apply, captureFullState({silent: true}) refreshes the maps and stamps
 * tabMonitor.state to current ground truth, preventing stale-diff echo loops.
 */

import { makeSyncId } from './tab-monitor.js';

const ALLOWED_SCHEMES = ['http:', 'https:'];

function isAllowedUrl(url) {
  if (!url) return false;
  try { return ALLOWED_SCHEMES.includes(new URL(url).protocol); } catch { return false; }
}

class TabApplier {
  constructor(tabMonitor) {
    this.tabMonitor = tabMonitor;
    // Serial Promise chain: prevents concurrent applyState/applyPatch from
    // racing. Two patches arriving fast (or a force_pull during a patch)
    // would otherwise read mid-mutation state and corrupt the maps.
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch(err => {
      console.error('[TabApplier] queue error:', err);
    });
    return this._queue;
  }

  // --- Full state apply ---

  async applyState(remoteState, opts) {
    return this._enqueue(() => this._applyState(remoteState, opts));
  }

  async applyPatch(patch) {
    return this._enqueue(() => this._applyPatch(patch));
  }

  async _applyState(remoteState, { addOnly = false } = {}) {
    this.tabMonitor.setApplying(true);
    try {
      if (!remoteState || !Array.isArray(remoteState.tabs)) return;

      const local = this.tabMonitor.state || {};
      const localTabsByUrl = new Map((local.tabs || []).map(t => [t.url, t]));
      const localTabsByUuid = new Map((local.tabs || []).filter(t => t.syncUuid).map(t => [t.syncUuid, t]));
      const localFoldersBySyncId = new Map((local.folders || []).map(f => [f.syncId, f]));
      const localWsBySyncId = new Map((local.workspaces || []).map(w => [w.syncId, w]));

      const remoteTotal = (remoteState.tabs || []).length;
      if (!addOnly && remoteTotal === 0) addOnly = true;

      // Capture-quality guard: if local state was built from the browser-API
      // fallback (no native host), it only contains active-workspace tabs.
      // Applying remote state in that case would create duplicates of every
      // tab living in a hidden workspace, since localTabsByUrl can't see them.
      // Force the apply to no-op and surface an error so the user installs
      // the native host before sync touches anything.
      if (local._fallback && remoteTotal > 5) {
        const msg = 'native host missing — apply blocked to prevent duplicate tabs';
        console.error('[TabApplier]', msg);
        browser.runtime.sendMessage({ type: 'status_update', status: 'native_missing', error: msg }).catch(() => {});
        return;
      }

      // 1. Workspaces — ensure every remote workspace has a local UUID
      // mapping before we place any tabs. Three resolution paths:
      //   a) syncId matches local (tabMonitor already populated the map).
      //   b) name matches an existing local workspace (different syncId on
      //      first sync, or stale cache after rename) — bind that UUID to
      //      the remote syncId instead of creating a duplicate.
      //   c) no match — createWorkspace; if it fails (e.g. a same-named
      //      workspace already exists in Zen but isn't in tabMonitor.state
      //      yet because captureFullState used the browser-API fallback),
      //      re-query native data and pick up the existing UUID.
      // Without these fallbacks, an unresolved workspace leaves
      // workspaceUuidBySyncId unset, then _createAndPlaceTab silently
      // drops every incoming tab into the active workspace.
      for (const ws of (remoteState.workspaces || [])) {
        // (a) syncId match
        if (this.tabMonitor.workspaceUuidBySyncId.has(ws.syncId)) {
          // Rename / re-theme if metadata drifted (still using existing UUID).
          const localWs = localWsBySyncId.get(ws.syncId);
          const themeChanged = JSON.stringify(localWs?.theme || null) !== JSON.stringify(ws.theme || null);
          if (localWs && (localWs.name !== ws.name || localWs.icon !== ws.icon || themeChanged)) {
            const uuid = this.tabMonitor.workspaceUuidBySyncId.get(ws.syncId);
            if (uuid) await browser.zenInternals.renameWorkspace({ uuid, name: ws.name, icon: ws.icon, theme: ws.theme });
          }
          continue;
        }
        // (b) name match
        const byName = this.tabMonitor.workspaceUuidByName.get(ws.name);
        if (byName) {
          this.tabMonitor.workspaceUuidBySyncId.set(ws.syncId, byName);
          // Push theme to the existing local workspace too, so colors match
          // even when this device pre-existed the remote one by name.
          if (ws.theme) {
            await browser.zenInternals.renameWorkspace({ uuid: byName, name: ws.name, icon: ws.icon, theme: ws.theme }).catch(() => {});
          }
          continue;
        }
        // (c) create, with native re-query fallback
        const r = await browser.zenInternals.createWorkspace({ name: ws.name, icon: ws.icon, theme: ws.theme })
          .catch(err => ({ success: false, error: err?.message }));
        let uuid = (r?.success && r.uuid) ? r.uuid : null;
        if (!uuid) {
          // Fallback: native session store may already have a workspace
          // with this name (race vs createWorkspace, or different casing).
          const native = await this.tabMonitor._getNativeData().catch(() => null);
          const match = native?.workspaces?.find(w => (w.name || '').trim() === ws.name);
          uuid = match?.uuid || null;
          if (uuid) {
            console.warn('[TabApplier] createWorkspace failed but native has', ws.name, '— binding existing UUID');
          }
        }
        if (uuid) {
          this.tabMonitor.workspaceUuidByName.set(ws.name, uuid);
          this.tabMonitor.workspaceUuidBySyncId.set(ws.syncId, uuid);
        } else {
          console.warn('[TabApplier] No UUID for workspace, tabs will be skipped:', ws.name, r?.error);
        }
      }

      // 2. Tabs — create missing, reconcile properties on mismatched.
      // Live-URL dedup: ask the experiment API for every URL currently open
      // (any workspace, visible or hidden). The tab-monitor cache lags Zen
      // session-store flushes by up to 15s, so localTabsByUrl alone misses
      // hidden-workspace tabs that exist but weren't in the last capture
      // — without this guard we'd create duplicates of them.
      const liveUrlsArr = await browser.zenInternals.listLiveUrls().catch(() => []);
      const liveUrls = new Set(Array.isArray(liveUrlsArr) ? liveUrlsArr : []);

      for (const tab of (remoteState.tabs || [])) {
        if (!isAllowedUrl(tab.url)) continue;
        // Match by syncUuid first (survives URL changes), then by URL, then
        // by live-browser URL set (catches hidden-workspace tabs we lost
        // track of). Only create when truly absent.
        const byUuid = tab.syncUuid ? localTabsByUuid.get(tab.syncUuid) : null;
        const byUrl = byUuid || localTabsByUrl.get(tab.url);
        if (byUrl) {
          await this._reconcileTab(tab, byUrl);
        } else if (liveUrls.has(tab.url)) {
          await this._reconcileTab(tab, null);
        } else {
          await this._createAndPlaceTab(tab);
          liveUrls.add(tab.url);
        }
      }

      // 3. Folders — topologically sorted: top-level first, then children.
      const remoteFolders = topoSortFolders(remoteState.folders || []);
      for (const f of remoteFolders) {
        const localFld = localFoldersBySyncId.get(f.syncId);
        const wsUuid = this.tabMonitor.workspaceUuidBySyncId.get(f.workspaceSyncId);
        const parentId = f.parentSyncId
          ? this.tabMonitor.folderLocalIdBySyncId.get(f.parentSyncId) || null
          : null;
        const tabUrls = (remoteState.tabs || [])
          .filter(t => t.folderSyncId === f.syncId && t.kind === 'pinned')
          .map(t => t.url);

        if (!localFld) {
          const r = await browser.zenInternals.createFolder({
            name: f.name,
            collapsed: f.collapsed,
            userIcon: f.userIcon,
            workspaceUuid: wsUuid,
            parentId,
            tabUrls,
          });
          if (r?.success && r.id) {
            this.tabMonitor.folderLocalIdBySyncId.set(f.syncId, r.id);
            this.tabMonitor.folderSyncIdByLocalId.set(r.id, f.syncId);
          } else {
            console.warn('[TabApplier] createFolder failed:', f.name, r?.error);
          }
        } else {
          const folderId = this.tabMonitor.folderLocalIdBySyncId.get(f.syncId);
          if (folderId) {
            if (localFld.name !== f.name) await browser.zenInternals.renameFolder({ folderId, name: f.name });
            if (localFld.collapsed !== f.collapsed) await browser.zenInternals.setFolderCollapsed({ folderId, collapsed: !!f.collapsed });
            if ((localFld.userIcon || '') !== (f.userIcon || '')) await browser.zenInternals.setFolderUserIcon({ folderId, userIcon: f.userIcon || '' });
            if (localFld.parentSyncId !== f.parentSyncId) {
              await browser.zenInternals.setFolderParent({ folderId, parentId });
            }
          }
        }
      }

      // 4. Tab → folder membership (folders may have been created in step 3).
      for (const tab of (remoteState.tabs || [])) {
        if (tab.kind !== 'pinned' || !tab.folderSyncId) continue;
        const localTab = localTabsByUrl.get(tab.url);
        if (localTab && localTab.folderSyncId === tab.folderSyncId) continue;
        const folderId = this.tabMonitor.folderLocalIdBySyncId.get(tab.folderSyncId);
        if (folderId) {
          await browser.zenInternals.addTabToFolder({ tabUrl: tab.url, folderId });
        }
      }

      // 5a. Reorder tabs to match remote order. Group by
      // (workspaceSyncId, kind, folderSyncId), sort each bucket by
      // remote position, and reorder via the experiment API (which uses
      // DOM insertBefore so workspace containers are respected).
      try {
        const buckets = new Map();
        for (const t of (remoteState.tabs || [])) {
          if (!t.syncUuid) continue;
          const k = `${t.workspaceSyncId || ''}|${t.kind}|${t.folderSyncId || ''}`;
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(t);
        }
        for (const bucket of buckets.values()) {
          bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          const ordered = bucket.map(t => t.syncUuid);
          if (ordered.length >= 2) {
            await browser.zenInternals.reorderTabsInPlace({ orderedSyncUuids: ordered });
          }
        }
      } catch (e) {
        console.warn('[TabApplier] tab reorder failed:', e?.message);
      }

      // 5b. Reorder workspaces to match remote order. gZenWorkspaces
      // expects local UUIDs, so translate syncIds via workspaceUuidBySyncId.
      try {
        const orderedWsUuids = (remoteState.workspaces || [])
          .slice()
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map(w => this.tabMonitor.workspaceUuidBySyncId.get(w.syncId))
          .filter(Boolean);
        if (orderedWsUuids.length >= 2) {
          await browser.zenInternals.reorderWorkspaces({ orderedUuids: orderedWsUuids });
        }
      } catch (e) {
        console.warn('[TabApplier] workspace reorder failed:', e?.message);
      }

      // 5c. Reorder folders within each parent bucket
      // (workspaceSyncId, parentSyncId). Uses local folder DOM ids.
      try {
        const fldBuckets = new Map();
        for (const f of (remoteState.folders || [])) {
          const k = `${f.workspaceSyncId || ''}|${f.parentSyncId || ''}`;
          if (!fldBuckets.has(k)) fldBuckets.set(k, []);
          fldBuckets.get(k).push(f);
        }
        for (const [k, bucket] of fldBuckets) {
          bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          const orderedIds = bucket
            .map(f => this.tabMonitor.folderLocalIdBySyncId.get(f.syncId))
            .filter(Boolean);
          if (orderedIds.length >= 2) {
            const parentSyncId = k.split('|')[1] || null;
            const parentLocalId = parentSyncId
              ? this.tabMonitor.folderLocalIdBySyncId.get(parentSyncId)
              : null;
            await browser.zenInternals.reorderFolders({ orderedFolderIds: orderedIds, parentId: parentLocalId });
          }
        }
      } catch (e) {
        console.warn('[TabApplier] folder reorder failed:', e?.message);
      }

      // 6. Removal pass — driven by the LIVE browser state, not the
      // (possibly stale or incomplete) tabMonitor.state snapshot. A
      // capture that missed some tabs would otherwise leave those tabs
      // alive after a destructive replace, which is exactly the
      // "old tabs still hanging around" symptom users hit.
      if (!addOnly) {
        // Tabs: query gBrowser directly via experiment API.
        let liveUrls = [];
        try {
          liveUrls = await browser.zenInternals.listLiveUrls();
        } catch {
          liveUrls = (local.tabs || []).map(t => t.url);
        }
        const remoteUrls = new Set((remoteState.tabs || []).map(t => t.url));
        for (const url of liveUrls) {
          if (!url) continue;
          if (!remoteUrls.has(url)) {
            await browser.zenInternals.removeTab({ tabUrl: url });
          }
        }

        // Folders: pull a fresh native/runtime snapshot so we see every
        // current zen-folder, not just those tabMonitor caught.
        let liveFolderIds = [];
        try {
          const fresh = await browser.zenInternals.getRuntimeState();
          liveFolderIds = (fresh?.folders || []).map(f => f.id).filter(Boolean);
        } catch {}
        const remoteFolderSyncIds = new Set((remoteState.folders || []).map(f => f.syncId));
        // Map local folder id → syncId via the monitor's reverse map.
        // Any local folder whose syncId isn't in the remote set is dropped.
        for (const fid of liveFolderIds) {
          const syncId = this.tabMonitor.folderSyncIdByLocalId.get(fid);
          if (syncId && remoteFolderSyncIds.has(syncId)) continue;
          // Either not in remote, or we don't have a syncId mapping (orphan).
          await browser.zenInternals.deleteFolder({ folderId: fid }).catch(() => {});
        }

        // Workspaces: same idea but querying gZenWorkspaces directly.
        const remoteWsIds = new Set((remoteState.workspaces || []).map(w => w.syncId));
        let liveWs = [];
        try {
          const fresh = await browser.zenInternals.getRuntimeState();
          liveWs = (fresh?.workspaces || []);
        } catch {}
        for (const w of liveWs) {
          const name = (w.name || '').trim();
          if (!name) continue;
          const syncId = makeSyncId('ws', name);
          if (remoteWsIds.has(syncId)) continue;
          await browser.zenInternals.deleteWorkspace({ uuid: w.uuid }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[TabApplier] applyState error:', err);
    } finally {
      // Bust the native cache so post-apply recapture sees fresh data,
      // not the cached snapshot from before our mutations.
      this.tabMonitor.invalidateCache();
      await this.tabMonitor.captureFullState({ silent: true, skipGuard: true });
      this.tabMonitor.setApplying(false);
    }
  }

  // --- Patch apply ---

  async _applyPatch(patch) {
    this.tabMonitor.setApplying(true);
    try {
      if (!patch || !Array.isArray(patch.operations)) return;

      // Process in dependency order: workspaces → folders → tabs → tab membership → removals.
      const ops = [...patch.operations];
      ops.sort((a, b) => opPriority(a) - opPriority(b));

      // Before any add_tab / update_tab can run, every workspaceSyncId
      // those ops reference MUST already have a local UUID mapping.
      // Otherwise the tab placement falls back to the user's active
      // workspace ("tabs dump into current space" bug). The set of
      // workspace IDs referenced by this patch is the union of:
      //   - explicit add_workspace ops (handled by the priority sort),
      //   - workspaceSyncId fields on every add_tab / update_tab op.
      // For each referenced syncId that isn't yet mapped, try the same
      // three-step resolution as _applyState (syncId → name → create+
      // native re-query). Resolving lazily inside _applyOp would mean
      // every tab op pays a native query latency.
      const referencedWsSyncIds = new Set();
      for (const op of ops) {
        const wsId = op.tab?.workspaceSyncId
          ?? op.changes?.workspaceSyncId
          ?? op.workspace?.syncId;
        if (wsId) referencedWsSyncIds.add(wsId);
      }
      await this._ensureWorkspacesResolved(referencedWsSyncIds);

      // Collect intended remote state for each tab touched by this patch
      // so we can resolve final bucket placement after applying ops.
      // For an `update_tab` op, the post-state bucket is determined by the
      // INCOMING tab object (op.tab); for `add_tab` it's op.tab; for
      // `remove_tab` we have nothing to add, but the OLD bucket may need
      // reorder to close the gap (handled implicitly by capture).
      const touchedBuckets = new Set();
      const recordBucket = (t) => {
        if (!t) return;
        touchedBuckets.add(`${t.workspaceSyncId || ''}|${t.kind || ''}|${t.folderSyncId || ''}`);
      };

      for (const op of ops) {
        try {
          await this._applyOp(op);
          if (op.type === 'add_tab' || op.type === 'update_tab') recordBucket(op.tab);
        } catch (e) {
          console.warn('[TabApplier] op failed:', op.type, e?.message);
        }
      }

      // Reorder pass — after all ops applied, walk the patch's intended
      // state and reorder each touched bucket to match remote positions.
      // The intended state is reconstructed by combining ops with the
      // post-capture state below — but since recapture happens in the
      // finally block AFTER setApplying is decremented, do the reorder
      // here using the patch's own tab objects.
      try {
        const tabsByBucket = new Map();
        for (const op of ops) {
          if (op.type !== 'add_tab' && op.type !== 'update_tab') continue;
          const t = op.tab;
          if (!t?.syncUuid) continue;
          const k = `${t.workspaceSyncId || ''}|${t.kind || ''}|${t.folderSyncId || ''}`;
          if (!touchedBuckets.has(k)) continue;
          if (!tabsByBucket.has(k)) tabsByBucket.set(k, []);
          tabsByBucket.get(k).push(t);
        }
        // Augment from current tabMonitor.state.tabs so the reorder list
        // includes pre-existing tabs in each touched bucket — otherwise
        // we'd only reorder the few tabs the patch directly mentions.
        for (const t of (this.tabMonitor.state.tabs || [])) {
          if (!t.syncUuid) continue;
          const k = `${t.workspaceSyncId || ''}|${t.kind || ''}|${t.folderSyncId || ''}`;
          if (!touchedBuckets.has(k)) continue;
          if (!tabsByBucket.has(k)) tabsByBucket.set(k, []);
          // Don't duplicate if the patch already added this syncUuid.
          if (!tabsByBucket.get(k).some(x => x.syncUuid === t.syncUuid)) {
            tabsByBucket.get(k).push(t);
          }
        }
        for (const bucket of tabsByBucket.values()) {
          bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          const ordered = bucket.map(t => t.syncUuid);
          if (ordered.length >= 2) {
            await browser.zenInternals.reorderTabsInPlace({ orderedSyncUuids: ordered });
          }
        }
      } catch (e) {
        console.warn('[TabApplier] patch reorder failed:', e?.message);
      }
    } catch (err) {
      console.error('[TabApplier] applyPatch error:', err);
    } finally {
      this.tabMonitor.invalidateCache();
      await this.tabMonitor.captureFullState({ silent: true, skipGuard: true });
      this.tabMonitor.setApplying(false);
    }
  }

  /**
   * For each remote workspace syncId, ensure tabMonitor.workspaceUuidBySyncId
   * has a local Zen UUID. Tries:
   *   1) already-mapped (no-op)
   *   2) re-query native data and match by reconstructing the
   *      makeSyncId('ws', name) form — handles the case where the local
   *      workspace already exists in Zen but tabMonitor didn't capture
   *      it (browser-API fallback path)
   *   3) match the remote workspace name through the local
   *      state.workspaces list if it was populated some other way
   * Workspaces still unresolved after this stay unmapped; subsequent
   * tab ops will then skip rather than create in the active workspace.
   */
  async _ensureWorkspacesResolved(syncIds) {
    const wsMap = this.tabMonitor.workspaceUuidBySyncId;
    const wsByName = this.tabMonitor.workspaceUuidByName;
    const unresolved = [...syncIds].filter(id => id && !wsMap.has(id));
    if (unresolved.length === 0) return;

    // One native query covers all unresolved syncIds in this patch.
    const native = await this.tabMonitor._getNativeData().catch(() => null);
    if (native?.workspaces?.length) {
      for (const w of native.workspaces) {
        const name = (w.name || '').trim();
        if (!name) continue;
        const syncId = makeSyncId('ws', name);
        if (!wsMap.has(syncId)) wsMap.set(syncId, w.uuid);
        if (!wsByName.has(name)) wsByName.set(name, w.uuid);
      }
    }

    // If the remote workspace name happens to already exist by name in
    // wsByName but under a different syncId path, bind it now.
    for (const id of unresolved) {
      if (wsMap.has(id)) continue;
      // No reverse lookup from syncId → name without remote state, so
      // we can only bind via native (above). Leaving unresolved entries
      // alone makes _createAndPlaceTab refuse them deterministically.
    }
  }

  async _applyOp(op) {
    const wsMap = this.tabMonitor.workspaceUuidBySyncId;
    const wsByName = this.tabMonitor.workspaceUuidByName;
    const fldMap = this.tabMonitor.folderLocalIdBySyncId;
    const fldRevMap = this.tabMonitor.folderSyncIdByLocalId;

    switch (op.type) {
      case 'add_workspace': {
        const ws = op.workspace;
        if (!ws?.name) break;
        const r = await browser.zenInternals.createWorkspace({ name: ws.name, icon: ws.icon, theme: ws.theme });
        if (r?.success && r.uuid) {
          wsMap.set(ws.syncId, r.uuid);
          wsByName.set(ws.name, r.uuid);
        }
        break;
      }
      case 'update_workspace': {
        const uuid = wsMap.get(op.syncId);
        if (uuid && op.changes) {
          await browser.zenInternals.renameWorkspace({
            uuid,
            name: op.changes.name,
            icon: op.changes.icon,
            theme: op.changes.theme,
          });
        }
        break;
      }
      case 'remove_workspace': {
        const uuid = wsMap.get(op.syncId);
        if (uuid) await browser.zenInternals.deleteWorkspace({ uuid });
        wsMap.delete(op.syncId);
        break;
      }

      case 'add_folder': {
        const f = op.folder;
        if (!f?.name) break;
        const wsUuid = wsMap.get(f.workspaceSyncId);
        const parentId = f.parentSyncId ? fldMap.get(f.parentSyncId) || null : null;
        const r = await browser.zenInternals.createFolder({
          name: f.name,
          collapsed: f.collapsed,
          userIcon: f.userIcon,
          workspaceUuid: wsUuid,
          parentId,
        });
        if (r?.success && r.id) {
          fldMap.set(f.syncId, r.id);
          fldRevMap.set(r.id, f.syncId);
        }
        break;
      }
      case 'update_folder': {
        const folderId = fldMap.get(op.syncId);
        if (!folderId || !op.changes) break;
        if ('name' in op.changes) await browser.zenInternals.renameFolder({ folderId, name: op.changes.name });
        if ('collapsed' in op.changes) await browser.zenInternals.setFolderCollapsed({ folderId, collapsed: !!op.changes.collapsed });
        if ('userIcon' in op.changes) await browser.zenInternals.setFolderUserIcon({ folderId, userIcon: op.changes.userIcon || '' });
        if ('parentSyncId' in op.changes) {
          const parentId = op.changes.parentSyncId ? fldMap.get(op.changes.parentSyncId) || null : null;
          await browser.zenInternals.setFolderParent({ folderId, parentId });
        }
        break;
      }
      case 'remove_folder': {
        const folderId = fldMap.get(op.syncId);
        if (folderId) {
          await browser.zenInternals.deleteFolder({ folderId });
          fldRevMap.delete(folderId);
        }
        fldMap.delete(op.syncId);
        break;
      }

      case 'add_tab': {
        if (!isAllowedUrl(op.tab?.url)) break;
        const remote = op.tab;
        // syncUuid is the cross-device tab identity. If we already have a
        // local tab with this uuid (from a prior sync), reconcile instead.
        if (remote.syncUuid) {
          const local = (this.tabMonitor.state.tabs || []).find(t => t.syncUuid === remote.syncUuid);
          if (local) {
            await this._reconcileTab(remote, local);
            break;
          }
        }
        await this._createAndPlaceTab(remote);
        break;
      }
      case 'update_tab': {
        const tab = op.tab;
        if (!tab?.syncUuid) break;
        // URL change is a property update (navigation), no longer a
        // remove+add cycle. Navigate the existing tab directly.
        if (op.changes && 'url' in op.changes && isAllowedUrl(op.changes.url)) {
          const found = await browser.zenInternals.findTabIdBySyncUuid({ syncUuid: tab.syncUuid });
          if (found?.success && found.tabId != null) {
            await browser.tabs.update(found.tabId, { url: op.changes.url }).catch(() => {});
          }
        }
        await this._reconcileTab(tab, null);
        break;
      }
      case 'remove_tab': {
        // Prefer syncUuid (stable identity); fall back to URL for any
        // legacy ops still in flight from an older sender. The schema
        // was updated to accept tabId/tabUrl/syncUuid as optional —
        // calling with `{syncUuid}` alone used to be silently rejected.
        const uuid = op.syncId?.startsWith('tab-') ? op.syncId.slice(4) : null;
        if (uuid) {
          await browser.zenInternals.removeTab({ syncUuid: uuid });
        } else if (op.url) {
          await browser.zenInternals.removeTab({ tabUrl: op.url });
        }
        break;
      }
    }
  }

  // --- Tab placement primitives ---

  async _createAndPlaceTab(remoteTab) {
    if (!isAllowedUrl(remoteTab.url)) return null;
    // Pre-flight: a non-essential tab MUST resolve to a known workspace
    // UUID before we materialize it. browser.tabs.create() places the new
    // tab in whatever workspace is currently active; if the subsequent
    // moveTabToWorkspace can't find a target UUID it silently no-ops,
    // and every unresolved remote tab piles up in the user's current
    // workspace. Skip instead — the next sync round will retry once the
    // mapping is populated (e.g. after captureFullState reads native).
    if (remoteTab.kind !== 'essential' && remoteTab.workspaceSyncId) {
      const wsUuid = this.tabMonitor.workspaceUuidBySyncId.get(remoteTab.workspaceSyncId);
      if (!wsUuid) {
        console.warn(
          '[TabApplier] SKIP — no local workspace UUID for',
          remoteTab.workspaceSyncId, '→', remoteTab.url,
        );
        return null;
      }
      console.log(
        '[TabApplier] PLACE',
        remoteTab.workspaceSyncId, '→ uuid', wsUuid.slice(0, 8),
        '/', remoteTab.kind, '/', remoteTab.url.slice(0, 60),
      );
    }
    let tab;
    try {
      tab = await browser.tabs.create({ url: remoteTab.url, active: false });
    } catch (err) {
      console.warn('[TabApplier] tabs.create failed:', remoteTab.url, err?.message);
      return null;
    }
    // Bind the cross-device syncUuid to the just-created tab so subsequent
    // ops (update_tab/remove_tab) from the source device can locate it
    // here regardless of URL changes.
    if (remoteTab.syncUuid) {
      await browser.zenInternals.setTabSyncUuid({ tabId: tab.id, syncUuid: remoteTab.syncUuid }).catch(() => {});
    }
    // Tell the monitor about the just-created tab so the next (silent)
    // recapture doesn't lose it just because currentURI is still
    // about:blank. Without this, capture skips the tab → tabMonitor.state
    // omits it → the very next normal capture diffs against the gap and
    // emits a duplicate add_tab back to the server.
    this.tabMonitor.recordPendingTab(remoteTab, tab.id);
    // CRITICAL: pass tab.id through to _reconcileTab. The brand-new tab's
    // linkedBrowser.currentURI is still about:blank for a moment, so the
    // experiment API's URL-based lookup would miss it — moveTabToWorkspace,
    // setEssential, etc. would all return "tab not found" and the tab would
    // be left in the active workspace. tabId resolves directly via
    // context.extension.tabManager and works immediately after create.
    await this._reconcileTab(remoteTab, null, tab.id);
    return tab;
  }

  async _reconcileTab(remoteTab, localTab, tabId = null) {
    const url = remoteTab.url;
    const wsUuid = remoteTab.workspaceSyncId
      ? this.tabMonitor.workspaceUuidBySyncId.get(remoteTab.workspaceSyncId)
      : null;
    // Identity precedence inside zen-internals: tabId (newly created) >
    // syncUuid (stable cross-device) > tabUrl (legacy fallback).
    const tabRef = { tabId, syncUuid: remoteTab.syncUuid, tabUrl: url };

    if (remoteTab.kind === 'essential') {
      await browser.zenInternals.setEssential({ ...tabRef, essential: true });
    } else {
      // ALWAYS clear essential first — Zen's moveTabsToWorkspace silently
      // skips any tab with the zen-essential attribute. If we only call this
      // when localTab.kind was 'essential', stale local state (or just a
      // freshly-created tab whose attributes haven't been queried) will
      // leave the tab stuck. setEssential(false) is idempotent at the
      // experiment API layer — no-ops for tabs that aren't essential.
      await browser.zenInternals.setEssential({ ...tabRef, essential: false });
      if (wsUuid) {
        await browser.zenInternals.moveTabToWorkspace({ ...tabRef, workspaceUuid: wsUuid });
      }
      await browser.zenInternals.setPinned({ ...tabRef, pinned: remoteTab.kind === 'pinned' });
    }

    // Folder membership (only meaningful for pinned tabs)
    if (remoteTab.kind === 'pinned' && remoteTab.folderSyncId) {
      const folderId = this.tabMonitor.folderLocalIdBySyncId.get(remoteTab.folderSyncId);
      if (folderId) await browser.zenInternals.addTabToFolder({ ...tabRef, folderId });
    } else if (localTab?.folderSyncId && !remoteTab.folderSyncId) {
      await browser.zenInternals.removeTabFromFolder({ ...tabRef });
    }
  }
}

// --- Helpers ---

function opPriority(op) {
  switch (op.type) {
    case 'add_workspace':    return 1;
    case 'update_workspace': return 2;
    case 'add_folder':       return 3;
    case 'update_folder':    return 4;
    case 'add_tab':          return 5;
    case 'update_tab':       return 6;
    case 'remove_tab':       return 7;
    case 'remove_folder':    return 8;
    case 'remove_workspace': return 9;
    default:                 return 50;
  }
}

function topoSortFolders(folders) {
  const bySyncId = new Map(folders.map(f => [f.syncId, f]));
  const visited = new Set();
  const out = [];
  function visit(f) {
    if (!f || visited.has(f.syncId)) return;
    visited.add(f.syncId);
    if (f.parentSyncId && bySyncId.has(f.parentSyncId)) {
      visit(bySyncId.get(f.parentSyncId));
    }
    out.push(f);
  }
  for (const f of folders) visit(f);
  return out;
}

export default TabApplier;
