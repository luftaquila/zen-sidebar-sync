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
            // Switch to target workspace if specified
            if (options.workspaceName && win.gZenWorkspaces) {
              const workspaces = await win.gZenWorkspaces.getWorkspaces();
              const ws = (workspaces || []).find(w => w.name === options.workspaceName);
              if (ws) {
                await win.gZenWorkspaces.changeWorkspace(ws.uuid);
              }
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

            const folder = win.gZenFolders.createFolder(tabElements, {
              name: options.name || "Folder",
            });

            if (folder && options.userIcon) {
              folder.setAttribute("user-icon", options.userIcon);
            }
            if (folder && options.collapsed) {
              folder.collapsed = true;
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
            const folders = win.document.querySelectorAll("zen-folder");
            const result = [];
            for (const f of folders) {
              result.push({
                id: f.id,
                name: f.label || "",
                collapsed: f.collapsed || false,
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
      },
    };
  }
};
