/* eslint-env mozilla-chrome */
/* global ExtensionAPI, Services */

"use strict";

this.zenInternals = class extends ExtensionAPI {
  getAPI(context) {
    return {
      zenInternals: {
        async createFolder(options) {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gZenFolders) {
            return { success: false, error: "Zen folders API not available" };
          }

          try {
            // Resolve workspace name to UUID
            let workspaceId;
            if (options.workspaceName && win.gZenWorkspaces) {
              const workspaces = await win.gZenWorkspaces.getWorkspaces();
              const ws = (workspaces || []).find(w => w.name === options.workspaceName);
              if (ws) workspaceId = ws.uuid;
            }

            // Find tab elements by URL (gBrowser.tabs has ALL workspace tabs)
            let tabElements = [];
            if (options.tabUrls && options.tabUrls.length > 0) {
              const urlSet = new Set(options.tabUrls);
              for (const tab of win.gBrowser.tabs) {
                try {
                  const url = tab.linkedBrowser?.currentURI?.spec;
                  if (url && urlSet.has(url)) {
                    tabElements.push(tab);
                    urlSet.delete(url);
                  }
                } catch (e) {
                  // Skip tabs that can't be inspected
                }
              }
            }

            // Ref: zen-browser/desktop src/zen/folders/ZenFolders.mjs createFolder()
            // Options: { label, collapsed, workspaceId, isLiveFolder, ... }
            const folder = win.gZenFolders.createFolder(tabElements, {
              label: options.name || "New Folder",
              collapsed: options.collapsed || false,
              workspaceId: workspaceId || undefined,
            });

            if (folder && options.userIcon) {
              win.gZenFolders.setFolderUserIcon(folder, options.userIcon);
            }

            return { success: true, tabCount: tabElements.length };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },

        async getFolders() {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gZenFolders) return [];

          try {
            // Ref: zen-browser/desktop src/zen/folders/ZenFolders.mjs storeDataForSessionStore()
            const folders = win.gBrowser.tabContainer.querySelectorAll("zen-folder");
            const result = [];
            for (const f of folders) {
              result.push({
                id: f.id,
                name: f.label || "",
                collapsed: f.collapsed || false,
                iconURL: f.iconURL || "",
                workspaceId: f.getAttribute("zen-workspace-id") || "",
              });
            }
            return result;
          } catch (e) {
            return [];
          }
        },

        async getWorkspaces() {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gZenWorkspaces) return [];

          try {
            const workspaces = await win.gZenWorkspaces.getWorkspaces();
            return (workspaces || []).map(w => ({
              uuid: w.uuid,
              name: w.name,
              icon: w.icon || "",
            }));
          } catch (e) {
            return [];
          }
        },

        async organizeTab(tabId, options) {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gBrowser) {
            return { success: false, error: "Browser not available" };
          }

          try {
            const { ExtensionParent } = ChromeUtils.importESModule(
              "resource://gre/modules/ExtensionParent.sys.mjs"
            );
            const tab = ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
            if (!tab) return { success: false, error: "Tab not found" };

            // Ref: zen-browser/desktop src/zen/tabs/ZenPinnedTabManager.mjs addToEssentials()
            if (options.essential) {
              if (win.gZenPinnedTabManager) {
                win.gZenPinnedTabManager.addToEssentials(tab);
              } else {
                tab.setAttribute("zen-essential", "true");
              }
            }

            // Ref: zen-browser/desktop src/zen/spaces/ZenSpaceManager.mjs moveTabToWorkspace()
            if (options.workspaceUuid) {
              if (win.gZenWorkspaces) {
                win.gZenWorkspaces.moveTabToWorkspace(tab, options.workspaceUuid);
              } else {
                tab.setAttribute("zen-workspace-id", options.workspaceUuid);
              }
            }

            return { success: true };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },

        // Read all tab data from chrome context (DOM attributes on XUL tab elements).
        // Replacement for native messaging host when experiment API is available.
        async getTabData() {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gBrowser) {
            return { tabs: [], workspaces: [] };
          }

          try {
            const tabs = [];
            // gBrowser.tabs returns ALL tabs across all workspaces
            for (const tab of win.gBrowser.tabs) {
              try {
                const url = tab.linkedBrowser?.currentURI?.spec;
                if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) continue;
                tabs.push({
                  url,
                  title: tab.label || "",
                  // Ref: zen-browser/desktop src/zen/tabs/ZenPinnedTabManager.mjs
                  zenEssential: tab.hasAttribute("zen-essential"),
                  // Ref: zen-browser/desktop src/zen/spaces/ZenSpaceManager.mjs
                  zenWorkspace: tab.getAttribute("zen-workspace-id") || null,
                  pinned: tab.pinned || false,
                  groupId: tab.group?.id || null,
                });
              } catch (e) {
                // Skip tabs that can't be inspected
              }
            }

            let workspaces = [];
            if (win.gZenWorkspaces) {
              const wsList = await win.gZenWorkspaces.getWorkspaces();
              workspaces = (wsList || []).map(w => ({
                uuid: w.uuid,
                name: w.name,
                icon: w.icon || "",
              }));
            }

            // Ref: zen-browser/desktop src/zen/folders/ZenFolders.mjs storeDataForSessionStore()
            let folders = [];
            const folderElements = win.gBrowser.tabContainer.querySelectorAll("zen-folder");
            for (const f of folderElements) {
              const tabUrls = [];
              if (f.tabs) {
                for (const tab of f.tabs) {
                  try {
                    const url = tab.linkedBrowser?.currentURI?.spec;
                    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
                      tabUrls.push(url);
                    }
                  } catch (e) {}
                }
              }
              // Walk up DOM to find parent folder
              const parentFolder = f.parentElement?.closest?.("zen-folder");
              folders.push({
                id: f.id,
                name: f.label || "",
                collapsed: f.collapsed || false,
                userIcon: f.iconURL || "",
                workspaceId: f.getAttribute("zen-workspace-id") || "",
                isLiveFolder: f.isLiveFolder || false,
                parentId: parentFolder ? parentFolder.id : null,
                tabUrls,
              });
            }

            return { tabs, workspaces, folders };
          } catch (e) {
            return { tabs: [], workspaces: [], folders: [] };
          }
        },

        // Ref: zen-browser/desktop src/zen/spaces/ZenSpaceCreation.mjs
        // saveWorkspace() creates or updates a workspace in Zen's storage.
        async createWorkspace(options) {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win || !win.gZenWorkspaces) {
            return { success: false, error: "Zen workspaces API not available" };
          }

          try {
            const uuid = Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
            await win.gZenWorkspaces.saveWorkspace({
              uuid,
              name: options.name || "New Workspace",
              icon: options.icon || undefined,
            });
            return { success: true, uuid };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },

        // Ref: zen-browser/desktop src/zen/folders/ZenFolder.mjs delete()
        // Calls gBrowser.removeTabGroup — tabs are ungrouped, not closed.
        async removeFolder(options) {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win) return { success: false, error: "Window not available" };

          try {
            const folders = win.gBrowser.tabContainer.querySelectorAll("zen-folder");
            for (const f of folders) {
              if (f.label === options.name) {
                await f.delete();
                return { success: true };
              }
            }
            return { success: false, error: "Folder not found" };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },

        // Ref: zen-browser/desktop src/zen/folders/ZenFolder.mjs
        // name setter fires ZenFolderRenamed event.
        // collapsed is a direct property.
        // Ref: zen-browser/desktop src/zen/folders/ZenFolders.mjs setFolderUserIcon()
        async updateFolder(options) {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (!win) return { success: false, error: "Window not available" };

          try {
            const folders = win.gBrowser.tabContainer.querySelectorAll("zen-folder");
            for (const f of folders) {
              if (f.label === options.currentName) {
                if (options.name !== undefined && options.name !== options.currentName) {
                  f.name = options.name;
                }
                if (options.collapsed !== undefined) {
                  f.collapsed = options.collapsed;
                }
                if (options.icon !== undefined && win.gZenFolders) {
                  win.gZenFolders.setFolderUserIcon(f, options.icon || null);
                }
                return { success: true };
              }
            }
            return { success: false, error: "Folder not found" };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },
      },
    };
  }
};
