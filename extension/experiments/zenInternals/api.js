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

// Robust URL extraction. Unloaded/lazy tabs (Zen's tab unload feature, or
// freshly session-restored tabs that haven't been activated) have a
// linkedBrowser whose currentURI reads "about:blank" even though their
// session-stored URL is something else. If we relied on currentURI alone,
// capture would skip those tabs and the diff would emit a flood of
// remove_tab ops — exactly the cascade-delete bug we keep hitting.
function getTabUrl(xulTab) {
  try {
    const cur = xulTab.linkedBrowser?.currentURI?.spec;
    if (cur && cur !== "about:blank" && cur !== "") return cur;
  } catch {}
  // For unloaded/lazy tabs only: get the persisted URL from session state.
  // (Deliberately NOT falling back to linkedBrowser.userTypedValue — that
  // races with active navigation, reporting a typed-but-not-yet-loaded URL
  // and triggering a spurious update_tab that then fails to apply on the
  // receiver when the actual URL load completes elsewhere.)
  try {
    const SS = ss();
    if (SS) {
      const raw = SS.getTabState(xulTab);
      if (raw) {
        const state = JSON.parse(raw);
        const entries = state?.entries || [];
        const idx = Math.max(0, Math.min((state?.index || entries.length) - 1, entries.length - 1));
        const url = entries[idx]?.url;
        if (url) return url;
      }
    }
  } catch {}
  return null;
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
            // createAndSaveWorkspace with dontChange=true persists the
            // workspace into _workspaceCache and propagates it to all
            // windows but Zen's ZenSessionStore.getClonedSpaces() — what
            // getWorkspaces(true) reads — does not include freshly-created
            // workspaces until the next session-store flush (timing-dependent).
            // We still call this because it's the only API that exists; the
            // capture path (getRuntimeState) reads from _workspaceCache as
            // a fallback so receiver-side dedup catches it.
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace(
              name || "Space",
              icon || undefined,
              /* dontChange */ true,
            );
            if (!ws?.uuid) return { success: false, error: "createAndSaveWorkspace returned no uuid" };
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
            // which returns the persisted shape; getWorkspaces() (no arg)
            // reads _workspaceCache which includes freshly-created workspaces
            // that haven't yet been persisted. Need the cache union so the
            // applier's name-based dedup catches a newly-created workspace
            // BEFORE Zen flushes it to session store (otherwise apply runs
            // again 5 seconds later via the periodic capture and creates
            // a duplicate). Cached entries with the same name dedup to the
            // first occurrence; live entries take precedence for theme/icon.
            const live = (() => { try { return win.gZenWorkspaces.getWorkspaces(true) || []; } catch { return []; } })();
            const cached = (() => { try { return win.gZenWorkspaces.getWorkspaces() || []; } catch { return []; } })();
            const liveByUuid = new Map(live.map(w => [w.uuid, w]));
            const seenNames = new Map();
            const wsList = [];
            for (const w of live) {
              if (!w?.name || seenNames.has(w.name)) continue;
              seenNames.set(w.name, w.uuid);
              wsList.push(w);
            }
            for (const w of cached) {
              if (!w?.name) continue;
              if (liveByUuid.has(w.uuid)) continue; // already added from live
              if (seenNames.has(w.name)) continue;  // duplicate name, skip
              seenNames.set(w.name, w.uuid);
              wsList.push(w);
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
              const url = getTabUrl(tab);
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

        // Reorder a sequence of tabs to match the given UUID order. Tabs
        // are repositioned WITHIN THEIR CURRENT CONTAINER (workspace tab
        // strip) by walking the parent's children list and insertBefore'ing
        // them in order. This avoids the cross-workspace pitfalls of
        // gBrowser.moveTabTo (which operates on a global index that
        // doesn't respect Zen's per-workspace tab containers).
        async reorderTabsInPlace({ orderedSyncUuids }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gBrowser || !Array.isArray(orderedSyncUuids)) return { success: false, error: "bad args" };

            // Walk in reverse so each insertBefore lands the tab before
            // the already-positioned tail of its bucket.
            let touched = 0;
            const reversed = orderedSyncUuids.slice().reverse();
            // Track per-container insertion anchors (last-placed tab of that bucket).
            const anchorByContainer = new Map();
            for (const uuid of reversed) {
              const tab = findTabBySyncUuid(win, uuid);
              if (!tab) continue;
              const container = tab.parentNode;
              if (!container) continue;
              const anchor = anchorByContainer.get(container);
              try {
                container.insertBefore(tab, anchor || null);
                anchorByContainer.set(container, tab);
                touched++;
              } catch (e) {
                console.warn('[zenInternals] reorder insertBefore failed:', uuid, e.message);
              }
            }
            try { win.gBrowser.tabContainer._invalidateCachedTabs?.(); } catch {}
            return { success: true, moved: touched };
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

        async log(msg) {
          try { Services.console.logStringMessage(`[ZenSyncExt] ${msg}`); } catch {}
          return { success: true };
        },

        // Reorder workspaces to match the given UUID list. Mirrors
        // ZenSpaceManager.reorderWorkspace(id, newPosition) in upstream Zen
        // (src/zen/spaces/ZenSpaceManager.mjs ~line 1520); calling it for
        // each entry walks the workspace cache and re-emits the sidebar
        // render. Best-effort: missing UUIDs are skipped, exceptions are
        // swallowed by `safe`.
        async reorderWorkspaces({ orderedUuids }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.gZenWorkspaces || !Array.isArray(orderedUuids)) return { success: false, error: "bad args" };
            if (typeof win.gZenWorkspaces.reorderWorkspace !== "function") {
              return { success: false, error: "reorderWorkspace not in this Zen version" };
            }
            let moved = 0;
            for (let i = 0; i < orderedUuids.length; i++) {
              try {
                await win.gZenWorkspaces.reorderWorkspace(orderedUuids[i], i);
                moved++;
              } catch {}
            }
            return { success: true, moved };
          });
        },

        // Reorder sibling folders within their parent container. There is
        // no upstream ZenFolders API for this; we walk the DOM. parentId
        // is null for top-level folders (siblings in the workspace
        // container); for nested folders, the parent's groupContainer is
        // the insertion target. Pattern matches reorderTabsInPlace above.
        async reorderFolders({ orderedFolderIds, parentId }) {
          return safe(async () => {
            const win = getWin();
            if (!win?.document || !Array.isArray(orderedFolderIds)) return { success: false, error: "bad args" };
            const reversed = orderedFolderIds.slice().reverse();
            let anchor = null;
            let touched = 0;
            for (const id of reversed) {
              const folder = win.document.getElementById(id);
              if (!folder || folder.tagName?.toLowerCase() !== "zen-folder") continue;
              const parent = parentId
                ? findFolderById(win, parentId)?.groupContainer
                : folder.parentNode;
              if (!parent) continue;
              try {
                parent.insertBefore(folder, anchor || null);
                anchor = folder;
                touched++;
              } catch {}
            }
            return { success: true, moved: touched };
          });
        },
      },
    };
  }
};
