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

const ALLOWED_SCHEMES = ['http:', 'https:'];

function isAllowedUrl(url) {
  if (!url) return false;
  try { return ALLOWED_SCHEMES.includes(new URL(url).protocol); } catch { return false; }
}

class TabApplier {
  constructor(tabMonitor) {
    this.tabMonitor = tabMonitor;
  }

  // --- Full state apply ---

  async applyState(remoteState, { addOnly = false } = {}) {
    this.tabMonitor.setApplying(true);
    try {
      if (!remoteState || !Array.isArray(remoteState.tabs)) return;

      const local = this.tabMonitor.state || {};
      const localTabsByUrl = new Map((local.tabs || []).map(t => [t.url, t]));
      const localFoldersBySyncId = new Map((local.folders || []).map(f => [f.syncId, f]));
      const localWsBySyncId = new Map((local.workspaces || []).map(w => [w.syncId, w]));

      const remoteTotal = (remoteState.tabs || []).length;
      if (!addOnly && remoteTotal === 0) addOnly = true;

      // 1. Workspaces — create missing, rename mismatched.
      for (const ws of (remoteState.workspaces || [])) {
        const localWs = localWsBySyncId.get(ws.syncId);
        if (!localWs) {
          const r = await browser.zenInternals.createWorkspace({ name: ws.name, icon: ws.icon });
          if (r?.success && r.uuid) {
            this.tabMonitor.workspaceUuidByName.set(ws.name, r.uuid);
            this.tabMonitor.workspaceUuidBySyncId.set(ws.syncId, r.uuid);
          } else {
            console.warn('[TabApplier] createWorkspace failed:', ws.name, r?.error);
          }
        } else if (localWs.name !== ws.name || localWs.icon !== ws.icon) {
          const uuid = this.tabMonitor.workspaceUuidBySyncId.get(ws.syncId);
          if (uuid) await browser.zenInternals.renameWorkspace({ uuid, name: ws.name, icon: ws.icon });
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
      await this.tabMonitor.captureFullState({ silent: true });
      this.tabMonitor.setApplying(false);
    }
  }

  // --- Patch apply ---

  async applyPatch(patch) {
    this.tabMonitor.setApplying(true);
    try {
      if (!patch || !Array.isArray(patch.operations)) return;

      // Process in dependency order: workspaces → folders → tabs → tab membership → removals.
      const ops = [...patch.operations];
      ops.sort((a, b) => opPriority(a) - opPriority(b));

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
      await this.tabMonitor.captureFullState({ silent: true });
      this.tabMonitor.setApplying(false);
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
