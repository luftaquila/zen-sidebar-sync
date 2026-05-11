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
          // Rename if metadata drifted (still using existing UUID).
          const localWs = localWsBySyncId.get(ws.syncId);
          if (localWs && (localWs.name !== ws.name || localWs.icon !== ws.icon)) {
            const uuid = this.tabMonitor.workspaceUuidBySyncId.get(ws.syncId);
            if (uuid) await browser.zenInternals.renameWorkspace({ uuid, name: ws.name, icon: ws.icon });
          }
          continue;
        }
        // (b) name match
        const byName = this.tabMonitor.workspaceUuidByName.get(ws.name);
        if (byName) {
          this.tabMonitor.workspaceUuidBySyncId.set(ws.syncId, byName);
          continue;
        }
        // (c) create, with native re-query fallback
        const r = await browser.zenInternals.createWorkspace({ name: ws.name, icon: ws.icon })
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
      for (const tab of (remoteState.tabs || [])) {
        if (!isAllowedUrl(tab.url)) continue;
        const localTab = localTabsByUrl.get(tab.url);
        if (!localTab) {
          await this._createAndPlaceTab(tab);
        } else {
          await this._reconcileTab(tab, localTab);
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

      // 5. Removal pass.
      if (!addOnly) {
        const remoteUrls = new Set((remoteState.tabs || []).map(t => t.url));
        for (const t of (local.tabs || [])) {
          if (!remoteUrls.has(t.url)) {
            await browser.zenInternals.removeTab({ tabUrl: t.url });
          }
        }
        const remoteFolderIds = new Set((remoteState.folders || []).map(f => f.syncId));
        for (const f of (local.folders || [])) {
          if (!remoteFolderIds.has(f.syncId)) {
            const folderId = this.tabMonitor.folderLocalIdBySyncId.get(f.syncId);
            if (folderId) await browser.zenInternals.deleteFolder({ folderId });
          }
        }
        const remoteWsIds = new Set((remoteState.workspaces || []).map(w => w.syncId));
        for (const w of (local.workspaces || [])) {
          if (!remoteWsIds.has(w.syncId)) {
            const uuid = this.tabMonitor.workspaceUuidBySyncId.get(w.syncId);
            if (uuid) await browser.zenInternals.deleteWorkspace({ uuid });
          }
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

      for (const op of ops) {
        try {
          await this._applyOp(op);
        } catch (e) {
          console.warn('[TabApplier] op failed:', op.type, e?.message);
        }
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
        const r = await browser.zenInternals.createWorkspace({ name: ws.name, icon: ws.icon });
        if (r?.success && r.uuid) {
          wsMap.set(ws.syncId, r.uuid);
          wsByName.set(ws.name, r.uuid);
        }
        break;
      }
      case 'update_workspace': {
        const uuid = wsMap.get(op.syncId);
        if (uuid && op.changes) {
          await browser.zenInternals.renameWorkspace({ uuid, name: op.changes.name, icon: op.changes.icon });
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
        await this._createAndPlaceTab(op.tab);
        break;
      }
      case 'update_tab': {
        const tab = op.tab;
        if (!tab?.url) break;
        await this._reconcileTab(tab, null);
        break;
      }
      case 'remove_tab': {
        const url = op.url;
        if (url) await browser.zenInternals.removeTab({ tabUrl: url });
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
    await this._reconcileTab(remoteTab, null);
    return tab;
  }

  async _reconcileTab(remoteTab, localTab) {
    const url = remoteTab.url;
    const wsUuid = remoteTab.workspaceSyncId
      ? this.tabMonitor.workspaceUuidBySyncId.get(remoteTab.workspaceSyncId)
      : null;

    if (remoteTab.kind === 'essential') {
      if (!localTab || localTab.kind !== 'essential') {
        await browser.zenInternals.setEssential({ tabUrl: url, essential: true });
      }
    } else {
      if (localTab && localTab.kind === 'essential') {
        await browser.zenInternals.setEssential({ tabUrl: url, essential: false });
      }
      if (wsUuid && (!localTab || localTab.workspaceSyncId !== remoteTab.workspaceSyncId)) {
        await browser.zenInternals.moveTabToWorkspace({ tabUrl: url, workspaceUuid: wsUuid });
      }
      const wantPinned = remoteTab.kind === 'pinned';
      if (!localTab || localTab.pinned !== wantPinned) {
        await browser.zenInternals.setPinned({ tabUrl: url, pinned: wantPinned });
      }
    }

    // Folder membership (only meaningful for pinned tabs)
    if (remoteTab.kind === 'pinned' && remoteTab.folderSyncId) {
      if (!localTab || localTab.folderSyncId !== remoteTab.folderSyncId) {
        const folderId = this.tabMonitor.folderLocalIdBySyncId.get(remoteTab.folderSyncId);
        if (folderId) await browser.zenInternals.addTabToFolder({ tabUrl: url, folderId });
      }
    } else if (localTab?.folderSyncId && !remoteTab.folderSyncId) {
      await browser.zenInternals.removeTabFromFolder({ tabUrl: url });
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
