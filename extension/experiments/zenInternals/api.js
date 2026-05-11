/* eslint-env mozilla-chrome */
/* global ExtensionAPI, Services */

"use strict";

/*
 * Wrapper around Zen Browser internal globals.
 * Verified call shapes (zen-browser/desktop @ HEAD, May 2026):
 *   gZenWorkspaces.createAndSaveWorkspace(name, icon, dontChange, containerTabId, opts)
 *     -> resolves to workspaceData {uuid, name, icon, ...}    (ZenSpaceManager.mjs:2562)
 *   gZenWorkspaces.saveWorkspace(workspaceData)                (ZenSpaceManager.mjs:1206)
 *   gZenWorkspaces.removeWorkspace(uuid)        -> Promise     (ZenSpaceManager.mjs:1222)
 *   gZenWorkspaces.getWorkspaces()              -> array       (ZenSpaceManager.mjs:670)
 *   gZenWorkspaces.getWorkspaceFromId(uuid)                    (ZenSpaceManager.mjs:662)
 *   gZenWorkspaces.moveTabToWorkspace(tab, uuid)               (ZenSpaceManager.mjs:1493)
 *   gZenWorkspaces.workspaceElement(uuid)                      (ZenSpaceManager.mjs:337)
 *   gZenFolders.createFolder(tabs, opts)        -> folder      (ZenFolders.mjs:623)
 *   gZenFolders.setFolderUserIcon(folder, icon)                (ZenFolders.mjs:1087)
 *   folder.label / folder.collapsed setters                    (ZenFolder.mjs)
 *   folder.addTabs(tabs)                                       (ZenFolder.mjs:289)
 *   folder.delete()                             -> Promise     (ZenFolder.mjs:174)
 *   gZenPinnedTabManager.addToEssentials(tab|tabs)             (ZenPinnedTabManager.mjs:446)
 *   gZenPinnedTabManager.removeEssentials(tab, unpin)          (ZenPinnedTabManager.mjs:503)
 *   gBrowser.pinTab(tab) / gBrowser.unpinTab(tab)
 */

function getWin() {
  return Services.wm.getMostRecentWindow("navigator:browser");
}

// SessionStore-backed per-tab UUID. Stable across navigations (URL changes
// no longer break tab identity), persisted on disk via session store, and
// survives browser restart. This is the cross-device identity for tabs.
let _SS = null;
function ss() {
  if (!_SS) {
    try {
      _SS = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs").SessionStore;
    } catch {
      _SS = null;
    }
  }
  return _SS;
}

function getTabSyncUuid(xulTab, { create = false } = {}) {
  const SS = ss();
  if (!SS) return null;
  try {
    let uuid = SS.getCustomTabValue(xulTab, "zen-sync-uuid");
    if (!uuid && create) {
      uuid = Services.uuid.generateUUID().toString().slice(1, -1); // strip braces
      SS.setCustomTabValue(xulTab, "zen-sync-uuid", uuid);
    }
    return uuid || null;
  } catch {
    return null;
  }
}

function findTabByUrl(win, url) {
  if (!url || !win?.gBrowser) return null;
  for (const tab of win.gBrowser.tabs) {
    try {
      const u = tab.linkedBrowser?.currentURI?.spec;
      if (u === url) return tab;
    } catch {}
  }
  return null;
}

// Resolve a WebExtension tab id to the XUL <tab> element. This is the only
// reliable path for tabs that were just created via browser.tabs.create —
// their currentURI is still about:blank for a moment after create, so
// findTabByUrl misses them.
function findTabByExtId(context, tabId) {
  if (tabId == null) return null;
  try {
    return context.extension?.tabManager?.get(tabId)?.nativeTab || null;
  } catch {
    return null;
  }
}

function findTabBySyncUuid(win, syncUuid) {
  if (!syncUuid || !win?.gBrowser) return null;
  for (const tab of win.gBrowser.tabs) {
    try {
      if (getTabSyncUuid(tab) === syncUuid) return tab;
    } catch {}
  }
  return null;
}

function resolveTab(context, win, tabId, tabUrl, syncUuid) {
  // Precedence: explicit tabId (from a just-created tab) > syncUuid
  // (stable cross-device identity, survives URL changes) > tabUrl
  // (legacy fallback, fails for newly-created tabs because currentURI
  // hasn't transitioned away from about:blank).
  const byId = findTabByExtId(context, tabId);
  if (byId) return byId;
  const byUuid = findTabBySyncUuid(win, syncUuid);
  if (byUuid) return byUuid;
  return findTabByUrl(win, tabUrl);
}

function listLiveUrls(win) {
  const out = new Set();
  if (!win?.gBrowser) return out;
  for (const tab of win.gBrowser.tabs) {
    try {
      const u = tab.linkedBrowser?.currentURI?.spec;
      if (u) out.add(u);
    } catch {}
  }
  return out;
}

function findFolderById(win, folderId) {
  if (!folderId || !win) return null;
  const el = win.document.getElementById(folderId);
  if (el && el.tagName?.toLowerCase() === "zen-folder") return el;
  return null;
}

function isPopulatedTheme(t) {
  return !!(t && typeof t === "object" && Array.isArray(t.gradientColors) && t.gradientColors.length > 0);
}

async function safe(fn) {
  try {
    const result = await fn();
    return result === undefined ? { success: true } : result;
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

this.zenInternals = class extends ExtensionAPI {
  getAPI(context) {
    return {
      zenInternals: {
        // --- Workspace CRUD ---

        async createWorkspace({ name, icon, theme }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace(
              name || "Space",
              icon || undefined,
              /* dontChange */ true,
            );
            if (!ws?.uuid) return { success: false, error: "createAndSaveWorkspace returned no uuid" };
            // createAndSaveWorkspace always installs a fresh random theme;
            // overwrite ONLY when the incoming theme has actual content.
            // An empty gradientColors array means the source's runtime cache
            // returned defaults — don't propagate that emptiness here, the
            // local fresh theme is more useful than a sterile replacement.
            if (isPopulatedTheme(theme)) {
              try {
                const updated = { ...ws, theme };
                win.gZenWorkspaces.saveWorkspace(updated);
              } catch (e) {
                console.warn('[zenInternals] saveWorkspace theme failed:', e.message);
              }
            }
            return { success: true, uuid: ws.uuid, name: ws.name, icon: ws.icon };
          });
        },

        async renameWorkspace({ uuid, name, icon, theme }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const ws = win.gZenWorkspaces.getWorkspaceFromId(uuid);
            if (!ws) return { success: false, error: `workspace not found: ${uuid}` };
            const updated = { ...ws };
            if (typeof name === "string") updated.name = name;
            if (typeof icon === "string") updated.icon = icon;
            // Theme: only apply when the incoming gradient is non-empty.
            // This prevents an empty default theme (from a misbehaving
            // capture on the source device) from wiping out the existing
            // populated local theme.
            if (isPopulatedTheme(theme)) updated.theme = theme;
            win.gZenWorkspaces.saveWorkspace(updated);
            return { success: true };
          });
        },

        async deleteWorkspace({ uuid }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            await win.gZenWorkspaces.removeWorkspace(uuid);
            return { success: true };
          });
        },

        async getWorkspaces() {
          const win = getWin();
          if (!win?.gZenWorkspaces) return [];
          try {
            const ws = win.gZenWorkspaces.getWorkspaces() || [];
            return ws.map(w => ({ uuid: w.uuid, name: w.name, icon: w.icon || "" }));
          } catch {
            return [];
          }
        },

        // --- Live state query ---

        // Returns the set of URLs currently open in any tab (any workspace,
        // visible or hidden). Used by the applier to dedup against live state
        // when the tab-monitor cache hasn't refreshed yet.
        async listLiveUrls() {
          const win = getWin();
          return Array.from(listLiveUrls(win));
        },

        // Real-time state dump straight from Zen's runtime — bypasses the
        // session-store flush delay (15-30s) that breaks reverse-direction
        // sync and essential counting. Matches the shape native host returns.
        async getRuntimeState() {
          const win = getWin();
          if (!win?.gBrowser || !win?.gZenWorkspaces) {
            return { workspaces: [], folders: [], tabs: [] };
          }
          const out = { workspaces: [], folders: [], tabs: [] };
          try {
            // getWorkspaces(true) goes through ZenSessionStore.getClonedSpaces()
            // which returns the full persisted shape including the gradient
            // theme; the default getWorkspaces() reads _workspaceCache which
            // can hand back themes with empty gradientColors arrays (we saw
            // this on the wire — every synced workspace ended up with the
            // default empty theme on receivers).
            let wsList = [];
            try { wsList = win.gZenWorkspaces.getWorkspaces(true) || []; } catch {}
            if (!wsList.length) {
              try { wsList = win.gZenWorkspaces.getWorkspaces() || []; } catch {}
            }
            for (const w of wsList) {
              // Defensive: if a workspace from the cloned-spaces path still
              // has an empty gradient (rare race), fall back to the cache
              // entry's theme for that UUID. Either source is acceptable
              // — we just don't want to overwrite a populated theme with
              // an empty one on receiving devices.
              let theme = w.theme || null;
              if (theme && Array.isArray(theme.gradientColors) && theme.gradientColors.length === 0) {
                try {
                  const cached = (win.gZenWorkspaces.getWorkspaces() || []).find(c => c.uuid === w.uuid);
                  if (cached?.theme?.gradientColors?.length) theme = cached.theme;
                } catch {}
              }
              out.workspaces.push({
                uuid: w.uuid,
                name: w.name || '',
                icon: w.icon || '',
                theme,
                containerTabId: w.containerTabId ?? 0,
              });
            }
          } catch (e) {
            console.warn('[zenInternals] getWorkspaces failed:', e.message);
          }
          try {
            const folders = win.document.querySelectorAll('zen-folder');
            for (const f of folders) {
              const parent = f.parentElement?.closest('zen-folder');
              const userIconImg = f.icon?.querySelector('svg .icon image');
              out.folders.push({
                id: f.id,
                name: f.label || '',
                collapsed: !!f.collapsed,
                parentId: parent ? parent.id : null,
                workspaceId: f.getAttribute('zen-workspace-id') || '',
                userIcon: userIconImg?.getAttribute('href') || '',
                isLiveFolder: !!f.isLiveFolder,
              });
            }
          } catch (e) {
            console.warn('[zenInternals] folder enum failed:', e.message);
          }
          try {
            let pos = 0;
            for (const tab of win.gBrowser.tabs) {
              const url = tab.linkedBrowser?.currentURI?.spec;
              if (!url || (!url.startsWith('http:') && !url.startsWith('https:'))) continue;
              const groupId = tab.group?.id || null;
              // Stable per-tab identity — generated and persisted on first
              // capture, survives navigation and restart.
              const syncUuid = getTabSyncUuid(tab, { create: true });
              out.tabs.push({
                url,
                title: tab.label || '',
                zenWorkspace: tab.getAttribute('zen-workspace-id') || null,
                zenEssential: tab.getAttribute('zen-essential') === 'true',
                pinned: !!tab.pinned,
                groupId,
                position: pos++,
                syncUuid,
              });
            }
          } catch (e) {
            console.warn('[zenInternals] tab enum failed:', e.message);
          }
          return out;
        },

        async setTabSyncUuid({ tabId, syncUuid }) {
          return safe(async () => {
            const tab = findTabByExtId(context, tabId);
            if (!tab) return { success: false, error: `tab not found: ${tabId}` };
            if (!syncUuid) return { success: false, error: "missing syncUuid" };
            const SS = ss();
            if (!SS) return { success: false, error: "SessionStore unavailable" };
            SS.setCustomTabValue(tab, "zen-sync-uuid", syncUuid);
            return { success: true };
          });
        },

        async findTabIdBySyncUuid({ syncUuid }) {
          return safe(async () => {
            const win = getWin();
            const tab = findTabBySyncUuid(win, syncUuid);
            if (!tab) return { success: false, error: "not found" };
            const id = context.extension?.tabManager?.getWrapper?.(tab)?.id;
            return { success: true, tabId: id ?? null, url: tab.linkedBrowser?.currentURI?.spec || null };
          });
        },

        // --- Tab placement ---
        // All tab ops accept `tabId` (preferred — direct WebExtension tab id
        // mapping) or fall back to `tabUrl`. Newly-created tabs MUST use tabId
        // because their `currentURI` is still about:blank for a moment after
        // browser.tabs.create — URL lookup would miss them entirely, causing
        // the tab to be left in the active workspace instead of being placed.

        async moveTabToWorkspace({ tabId, tabUrl, syncUuid, workspaceUuid }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId || syncUuid}` };
            // Zen's moveTabsToWorkspace silently skips tabs with zen-essential
            // attribute. Caller is responsible for clearing essential first.
            win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
            return { success: true };
          });
        },

        async setEssential({ tabId, tabUrl, syncUuid, essential }) {
          return safe(async () => {
            const win = getWin();
            const mgr = win?.gZenPinnedTabManager;
            if (!mgr) return { success: false, error: "gZenPinnedTabManager unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId || syncUuid}` };
            const isEssential = tab.hasAttribute("zen-essential");
            if (essential && !isEssential) {
              mgr.addToEssentials(tab);
            } else if (!essential && isEssential) {
              mgr.removeEssentials(tab, /* unpin */ false);
            }
            return { success: true };
          });
        },

        async setPinned({ tabId, tabUrl, syncUuid, pinned }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gBrowser) return { success: false, error: "gBrowser unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId || syncUuid}` };
            if (tab.hasAttribute("zen-essential")) {
              return { success: true, skipped: "essential tab" };
            }
            if (pinned && !tab.pinned) win.gBrowser.pinTab(tab);
            else if (!pinned && tab.pinned) win.gBrowser.unpinTab(tab);
            return { success: true };
          });
        },

        async removeTab({ tabId, tabUrl, syncUuid }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gBrowser) return { success: false, error: "gBrowser unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: true, skipped: "not found" };
            win.gBrowser.removeTab(tab);
            return { success: true };
          });
        },

        // --- Folders ---

        async createFolder({ id, name, collapsed, userIcon, workspaceUuid, parentId, tabUrls }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenFolders) return { success: false, error: "gZenFolders unavailable" };

            // Pre-existing folder with this id? -> just update properties.
            const existing = id ? findFolderById(win, id) : null;
            if (existing) {
              if (typeof name === "string") existing.label = name;
              if (typeof collapsed === "boolean") existing.collapsed = collapsed;
              if (typeof userIcon === "string") win.gZenFolders.setFolderUserIcon(existing, userIcon);
              return { success: true, id: existing.id, alreadyExisted: true };
            }

            const tabElements = [];
            if (Array.isArray(tabUrls) && tabUrls.length > 0) {
              const urlSet = new Set(tabUrls);
              for (const tab of win.gBrowser.tabs) {
                try {
                  const u = tab.linkedBrowser?.currentURI?.spec;
                  if (u && urlSet.has(u)) {
                    tabElements.push(tab);
                    urlSet.delete(u);
                  }
                } catch {}
              }
            }

            const opts = {
              label: name || "Folder",
              collapsed: !!collapsed,
              workspaceId: workspaceUuid || (win.gZenWorkspaces?.activeWorkspace),
            };
            if (id) opts.id = id;

            const folder = win.gZenFolders.createFolder(tabElements, opts);
            if (!folder) return { success: false, error: "createFolder returned null" };

            if (userIcon) {
              try { win.gZenFolders.setFolderUserIcon(folder, userIcon); } catch {}
            }

            if (parentId) {
              const parent = findFolderById(win, parentId);
              if (parent?.groupContainer) {
                try {
                  parent.groupContainer.appendChild(folder);
                } catch (e) {
                  return { success: true, id: folder.id, parentWarning: e.message };
                }
              }
            }

            return { success: true, id: folder.id, tabCount: tabElements.length };
          });
        },

        async renameFolder({ folderId, name }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };
            folder.label = name;
            return { success: true };
          });
        },

        async setFolderCollapsed({ folderId, collapsed }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };
            folder.collapsed = !!collapsed;
            return { success: true };
          });
        },

        async setFolderUserIcon({ folderId, userIcon }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };
            if (win.gZenFolders?.setFolderUserIcon) {
              win.gZenFolders.setFolderUserIcon(folder, userIcon || "");
            }
            return { success: true };
          });
        },

        async setFolderParent({ folderId, parentId }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };

            if (!parentId) {
              // Move to top level: re-anchor under the workspace's pinned tabs container.
              const wsId = folder.getAttribute("zen-workspace-id");
              const wsEl = wsId ? win.gZenWorkspaces?.workspaceElement?.(wsId) : null;
              const target = wsEl?.pinnedTabsContainer || win.gZenWorkspaces?.pinnedTabsContainer;
              if (target) target.appendChild(folder);
              return { success: true };
            }

            const parent = findFolderById(win, parentId);
            if (!parent?.groupContainer) return { success: false, error: `parent not found: ${parentId}` };
            parent.groupContainer.appendChild(folder);
            return { success: true };
          });
        },

        async deleteFolder({ folderId }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: true, skipped: "not found" };
            await folder.delete();
            return { success: true };
          });
        },

        async addTabToFolder({ tabId, tabUrl, syncUuid, folderId }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId || syncUuid}` };
            if (!tab.pinned && win.gBrowser?.pinTab) win.gBrowser.pinTab(tab);
            folder.addTabs([tab]);
            return { success: true };
          });
        },

        async removeTabFromFolder({ tabId, tabUrl, syncUuid }) {
          return safe(async () => {
            const win = getWin();
            const tab = resolveTab(context, win, tabId, tabUrl, syncUuid);
            if (!tab) return { success: true, skipped: "not found" };
            if (tab.group && win.gBrowser?.ungroupTab) {
              win.gBrowser.ungroupTab(tab);
            }
            return { success: true };
          });
        },
      },
    };
  }
};
