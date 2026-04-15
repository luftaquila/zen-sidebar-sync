/**
 * Tab Applier - Applies remote state to local browser
 *
 * After every apply, recaptures tabMonitor state to prevent stale diffs.
 * Uses experiment API (chrome context) to set Zen internal tab properties
 * (zenEssential, zenWorkspace). Falls back to browser.sessions API.
 */

const ALLOWED_SCHEMES = ['http:', 'https:'];

function isAllowedUrl(url) {
  if (!url) return false;
  try { return ALLOWED_SCHEMES.includes(new URL(url).protocol); }
  catch { return false; }
}

class TabApplier {
  constructor(tabMonitor) {
    this.tabMonitor = tabMonitor;
  }

  async applyState(remoteState, { addOnly = false } = {}) {
    this.tabMonitor.setApplying(true);

    try {
      // Use tabMonitor.state (from native host / session store) for ALL local URLs
      // browser.tabs.query() only returns active workspace tabs — using it causes
      // hidden workspace tabs to be "not found" and duplicated on merge
      const allLocalUrls = new Set();
      for (const ess of (this.tabMonitor.state?.essentials || [])) {
        allLocalUrls.add(ess.url);
      }
      for (const ws of (this.tabMonitor.state?.workspaces || [])) {
        for (const t of [...(ws.tabs || []), ...(ws.pinnedTabs || [])]) {
          allLocalUrls.add(t.url);
        }
      }

      // Also get browser API tabs for update operations (pinned state, etc.)
      const localTabs = await browser.tabs.query({});
      const localByUrl = new Map();
      for (const t of localTabs) {
        if (!t.url) continue;
        if (!localByUrl.has(t.url)) localByUrl.set(t.url, []);
        localByUrl.get(t.url).push(t);
      }

      const remoteUrls = new Set();

      const totalRemoteTabs = (remoteState.essentials || []).length
        + (remoteState.workspaces || []).reduce(
          (sum, ws) => sum + (ws.tabs || []).length + (ws.pinnedTabs || []).length, 0);

      // Empty remote state = likely corruption — force addOnly
      if (!addOnly && totalRemoteTabs === 0) {
        addOnly = true;
      }

      // 1. Essentials
      for (const ess of (remoteState.essentials || [])) {
        if (!isAllowedUrl(ess.url)) continue;
        remoteUrls.add(ess.url);

        if (!allLocalUrls.has(ess.url)) {
          await this._createTab(ess.url, { pinned: true, essential: true });
          allLocalUrls.add(ess.url);
        } else {
          // Ensure essential + pinned on existing visible tabs
          const locals = localByUrl.get(ess.url);
          if (locals && locals[0]) {
            if (!locals[0].pinned) {
              await browser.tabs.update(locals[0].id, { pinned: true }).catch(() => {});
            }
            await this._organizeTab(locals[0].id, { essential: true });
          }
        }
      }

      // 2. Workspace tabs
      for (const ws of (remoteState.workspaces || [])) {
        const wsUuid = this.tabMonitor.workspaceUuidMap.get(ws.name);

        for (const tab of (ws.pinnedTabs || [])) {
          if (!isAllowedUrl(tab.url)) continue;
          remoteUrls.add(tab.url);

          if (!allLocalUrls.has(tab.url)) {
            await this._createTab(tab.url, { pinned: true, workspaceId: wsUuid });
            allLocalUrls.add(tab.url);
          } else {
            const locals = localByUrl.get(tab.url);
            if (locals && locals[0] && !locals[0].pinned) {
              await browser.tabs.update(locals[0].id, { pinned: true }).catch(() => {});
            }
          }
        }

        for (const tab of (ws.tabs || [])) {
          if (!isAllowedUrl(tab.url)) continue;
          remoteUrls.add(tab.url);

          if (!allLocalUrls.has(tab.url)) {
            await this._createTab(tab.url, { pinned: false, workspaceId: wsUuid });
            allLocalUrls.add(tab.url);
          }
        }
      }

      // 3. Folder restoration
      await this._applyFolders(remoteState.folders || []);

      // 4. Remove tabs not in remote state
      if (!addOnly) {
        for (const local of localTabs) {
          if (!local.url || local.url.startsWith('about:') || local.url.startsWith('moz-extension:')) continue;
          if (!remoteUrls.has(local.url)) {
            await browser.tabs.remove(local.id).catch(() => {});
          }
        }

        const remaining = await browser.tabs.query({});
        if (remaining.length === 0) {
          await browser.tabs.create({});
        }
      }
    } catch (err) {
      console.error('[TabApplier] applyState error:', err);
    } finally {
      // Recapture to sync tabMonitor.state with actual browser state,
      // then release the guard. This prevents stale diffs after apply.
      await this.tabMonitor.captureFullState({ silent: true });
      this.tabMonitor.setApplying(false);
    }
  }

  async applyPatch(patch) {
    this.tabMonitor.setApplying(true);

    try {
      // Build full URL set from tabMonitor.state (all workspaces) for dedup
      const allLocalUrls = new Set();
      for (const ess of (this.tabMonitor.state?.essentials || [])) {
        allLocalUrls.add(ess.url);
      }
      for (const ws of (this.tabMonitor.state?.workspaces || [])) {
        for (const t of [...(ws.tabs || []), ...(ws.pinnedTabs || [])]) {
          allLocalUrls.add(t.url);
        }
      }

      // Browser API tabs for update/remove operations on visible tabs
      const allTabs = await browser.tabs.query({});
      const byUrl = new Map();
      for (const t of allTabs) {
        if (t.url) byUrl.set(t.url, t);
      }

      for (const op of patch.operations) {
        await this._applyOp(op, byUrl, allLocalUrls);
      }
    } catch (err) {
      console.error('[TabApplier] applyPatch error:', err);
    } finally {
      await this.tabMonitor.captureFullState({ silent: true });
      this.tabMonitor.setApplying(false);
    }
  }

  async _applyOp(op, byUrl, allLocalUrls) {
    switch (op.type) {
      case 'add_essential': {
        if (!isAllowedUrl(op.tab?.url)) break;
        if (allLocalUrls.has(op.tab.url)) {
          const existing = byUrl.get(op.tab.url);
          if (existing) {
            if (!existing.pinned) {
              await browser.tabs.update(existing.id, { pinned: true }).catch(() => {});
            }
            await this._organizeTab(existing.id, { essential: true });
          }
          break;
        }
        const existing = byUrl.get(op.tab.url);
        if (!existing) {
          const tab = await this._createTab(op.tab.url, { pinned: true, essential: true });
          if (tab) {
            byUrl.set(op.tab.url, tab);
            allLocalUrls.add(op.tab.url);
          }
        } else {
          if (!existing.pinned) {
            await browser.tabs.update(existing.id, { pinned: true }).catch(() => {});
          }
          await this._organizeTab(existing.id, { essential: true });
        }
        break;
      }

      case 'remove_essential':
      case 'remove_tab': {
        if (op.url) {
          const tab = byUrl.get(op.url);
          if (tab) {
            await browser.tabs.remove(tab.id).catch(() => {});
            byUrl.delete(op.url);
          }
        }
        break;
      }

      case 'update_essential':
      case 'update_tab': {
        if (op.oldUrl && op.changes?.url && op.oldUrl !== op.changes.url) {
          const tab = byUrl.get(op.oldUrl);
          if (tab && isAllowedUrl(op.changes.url)) {
            await browser.tabs.update(tab.id, { url: op.changes.url }).catch(() => {});
            byUrl.delete(op.oldUrl);
            byUrl.set(op.changes.url, tab);
          }
        }
        break;
      }

      case 'add_tab': {
        if (!isAllowedUrl(op.tab?.url)) break;
        if (allLocalUrls.has(op.tab.url)) break;
        const wsUuid = op.workspaceName
          ? this.tabMonitor.workspaceUuidMap.get(op.workspaceName)
          : null;
        const tab = await this._createTab(op.tab.url, {
          pinned: op.pinned || false,
          workspaceId: wsUuid,
        });
        if (tab) {
          byUrl.set(op.tab.url, tab);
          allLocalUrls.add(op.tab.url);
        }
        break;
      }

      case 'add_workspace': {
        if (!op.workspace) break;
        const wsUuid2 = this.tabMonitor.workspaceUuidMap.get(op.workspace.name);
        for (const tab of (op.workspace.pinnedTabs || [])) {
          if (isAllowedUrl(tab.url) && !allLocalUrls.has(tab.url)) {
            const created = await this._createTab(tab.url, { pinned: true, workspaceId: wsUuid2 });
            if (created) {
              byUrl.set(tab.url, created);
              allLocalUrls.add(tab.url);
            }
          }
        }
        for (const tab of (op.workspace.tabs || [])) {
          if (isAllowedUrl(tab.url) && !allLocalUrls.has(tab.url)) {
            const created = await this._createTab(tab.url, { pinned: false, workspaceId: wsUuid2 });
            if (created) {
              byUrl.set(tab.url, created);
              allLocalUrls.add(tab.url);
            }
          }
        }
        break;
      }

      case 'remove_workspace': {
        if (!op.workspace) break;
        for (const tab of [...(op.workspace.tabs || []), ...(op.workspace.pinnedTabs || [])]) {
          if (tab.url) {
            const local = byUrl.get(tab.url);
            if (local) {
              await browser.tabs.remove(local.id).catch(() => {});
              byUrl.delete(tab.url);
            }
          }
        }
        break;
      }
    }
  }

  async _applyFolders(remoteFolders) {
    if (!remoteFolders || remoteFolders.length === 0) return;

    try {
      if (typeof browser.zenInternals === 'undefined') {
        console.warn('[TabApplier] zenInternals experiment API not available — folder sync skipped');
        return;
      }

      // Get existing local folders to avoid duplicates
      const localFolders = await browser.zenInternals.getFolders();
      const localNames = new Set(localFolders.map(f => f.name));

      for (const folder of remoteFolders) {
        if (!folder.name || localNames.has(folder.name)) continue;

        const result = await browser.zenInternals.createFolder({
          name: folder.name,
          collapsed: folder.collapsed || false,
          userIcon: folder.userIcon || '',
          workspaceName: folder.workspaceName || '',
          tabUrls: folder.tabUrls || [],
        });

        if (result.success) {
          localNames.add(folder.name);
        } else {
          console.warn(`[TabApplier] createFolder failed: ${folder.name}`, result.error);
        }
      }
    } catch (e) {
      console.warn('[TabApplier] folder apply error:', e.message);
    }
  }

  async _organizeTab(tabId, { essential = false, workspaceId = null } = {}) {
    const opts = {};
    if (essential) opts.essential = true;
    if (workspaceId && workspaceId !== '__default__') opts.workspaceUuid = workspaceId;
    if (Object.keys(opts).length === 0) return;

    if (typeof browser.zenInternals !== 'undefined') {
      await browser.zenInternals.organizeTab(tabId, opts).catch(() => {});
    } else {
      // Fallback: session API (stores in extData, may not be read by Zen)
      if (essential) {
        await browser.sessions.setTabValue(tabId, 'zen-essential', true).catch(() => {});
      }
      if (opts.workspaceUuid) {
        await browser.sessions.setTabValue(tabId, 'zen-workspace-id', opts.workspaceUuid).catch(() => {});
      }
    }
  }

  async _createTab(url, { pinned = false, essential = false, workspaceId = null } = {}) {
    try {
      const tab = await browser.tabs.create({ url, pinned, active: false });
      await this._organizeTab(tab.id, { essential, workspaceId });
      return tab;
    } catch (err) {
      console.error(`[TabApplier] create failed: ${url}`, err);
      return null;
    }
  }
}

export default TabApplier;
