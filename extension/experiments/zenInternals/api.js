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

function resolveTab(context, win, tabId, tabUrl) {
  const byId = findTabByExtId(context, tabId);
  if (byId) return byId;
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

        async createWorkspace({ name, icon }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace(
              name || "Space",
              icon || undefined,
              /* dontChange */ true,
            );
            if (!ws?.uuid) return { success: false, error: "createAndSaveWorkspace returned no uuid" };
            return { success: true, uuid: ws.uuid, name: ws.name, icon: ws.icon };
          });
        },

        async renameWorkspace({ uuid, name, icon }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const ws = win.gZenWorkspaces.getWorkspaceFromId(uuid);
            if (!ws) return { success: false, error: `workspace not found: ${uuid}` };
            const updated = { ...ws };
            if (typeof name === "string") updated.name = name;
            if (typeof icon === "string") updated.icon = icon;
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

        // --- Tab placement ---
        // All tab ops accept `tabId` (preferred — direct WebExtension tab id
        // mapping) or fall back to `tabUrl`. Newly-created tabs MUST use tabId
        // because their `currentURI` is still about:blank for a moment after
        // browser.tabs.create — URL lookup would miss them entirely, causing
        // the tab to be left in the active workspace instead of being placed.

        async moveTabToWorkspace({ tabId, tabUrl, workspaceUuid }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces) return { success: false, error: "gZenWorkspaces unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId}` };
            // Zen's moveTabsToWorkspace silently skips tabs with zen-essential
            // attribute. Caller is responsible for clearing essential first.
            win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
            return { success: true };
          });
        },

        async setEssential({ tabId, tabUrl, essential }) {
          return safe(async () => {
            const win = getWin();
            const mgr = win?.gZenPinnedTabManager;
            if (!mgr) return { success: false, error: "gZenPinnedTabManager unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId}` };
            const isEssential = tab.hasAttribute("zen-essential");
            if (essential && !isEssential) {
              mgr.addToEssentials(tab);
            } else if (!essential && isEssential) {
              mgr.removeEssentials(tab, /* unpin */ false);
            }
            return { success: true };
          });
        },

        async setPinned({ tabId, tabUrl, pinned }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gBrowser) return { success: false, error: "gBrowser unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId}` };
            if (tab.hasAttribute("zen-essential")) {
              return { success: true, skipped: "essential tab" };
            }
            if (pinned && !tab.pinned) win.gBrowser.pinTab(tab);
            else if (!pinned && tab.pinned) win.gBrowser.unpinTab(tab);
            return { success: true };
          });
        },

        async removeTab({ tabId, tabUrl }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gBrowser) return { success: false, error: "gBrowser unavailable" };
            const tab = resolveTab(context, win, tabId, tabUrl);
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

        async addTabToFolder({ tabId, tabUrl, folderId }) {
          return safe(async () => {
            const win = getWin();
            const folder = findFolderById(win, folderId);
            if (!folder) return { success: false, error: `folder not found: ${folderId}` };
            const tab = resolveTab(context, win, tabId, tabUrl);
            if (!tab) return { success: false, error: `tab not found: ${tabUrl || tabId}` };
            if (!tab.pinned && win.gBrowser?.pinTab) win.gBrowser.pinTab(tab);
            folder.addTabs([tab]);
            return { success: true };
          });
        },

        async removeTabFromFolder({ tabId, tabUrl }) {
          return safe(async () => {
            const win = getWin();
            const tab = resolveTab(context, win, tabId, tabUrl);
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
