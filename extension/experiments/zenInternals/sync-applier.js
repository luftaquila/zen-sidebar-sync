/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Ported and extended from Zen Browser's ZenSpacesSyncApplier.sys.mjs
 * (github.com/zen-browser/desktop, dev branch, src/zen/sync/). Extensions:
 *   - regular (unpinned) tab records: created without pinning, placed into
 *     their workspace; URL convergence never navigates a LOADED tab —
 *     unloaded tabs are retargeted, loaded ones get a pending hold
 *   - apply-side mass-deletion guard (v2 only guarded the outbound path)
 *   - reconcile mode for the initial "Replace local" flow: local synced
 *     items absent from the incoming set are deleted, using LIVE browser
 *     state (not the possibly-stale session collection)
 *   - freshly created lazy tabs always get real session entries written so
 *     their projection identity is total (they must never read as deleted)
 */

/* eslint-env mozilla-chrome */
/* global ChromeUtils, Services, ZenSyncModel, ZenSyncModelStatics */

"use strict";

// eslint-disable-next-line no-var
var ZenSyncApplier = new (class {
  #queue = Promise.resolve();
  #applying = false;

  get isApplying() {
    return this.#applying;
  }

  get #mods() {
    return ZenSyncModelStatics.modules;
  }

  get #KINDS() {
    return ZenSyncModelStatics.RECORD_KINDS;
  }

  #itemIn(win, id) {
    return id ? win.document.getElementById(id) : null;
  }

  // A record can reference a workspace this device doesn't have (e.g. the
  // space was deleted concurrently and a racing tab update recreated the
  // record server-side). Falling back to the active workspace keeps the tab
  // alive, and the digest self-heal re-uploads the REAL placement so the
  // server record converges instead of freezing broken.
  #resolveWorkspace(win, workspaceUuid) {
    if (!workspaceUuid) {
      return null;
    }
    if (win.gZenWorkspaces.getWorkspaces().some((s) => s.uuid === workspaceUuid)) {
      return workspaceUuid;
    }
    console.warn(`ZenSidebarSync: unknown workspace ${workspaceUuid}, using active workspace`);
    return win.gZenWorkspaces.activeWorkspace || null;
  }

  /**
   * Public entry point. Serialized through a promise chain so batches
   * arriving back-to-back never interleave.
   *
   * @param {Array<{id, kind, data}>} records
   * @param {Array<string>} deleted
   * @param {object} opts - { reconcile, overrideGuard }
   * @returns {Promise<{failed: string[], guard: ?object}>}
   */
  apply(records, deleted, opts = {}) {
    const run = this.#queue.then(async () => {
      this.#applying = true;
      try {
        return await this.#applyBatch(records || [], deleted || [], opts);
      } finally {
        this.#applying = false;
      }
    });
    // Keep the chain alive even when a batch throws.
    this.#queue = run.catch(() => {});
    return run;
  }

  async #applyBatch(records, deleted, { reconcile = false, overrideGuard = false } = {}) {
    const KINDS = this.#KINDS;
    const incoming = {
      containers: [],
      spaces: [],
      tabs: [],
      folders: [],
      splits: [],
      layout: null,
      deleted: deleted.filter((id) => typeof id === "string" && id && id !== ZenSyncModelStatics.LAYOUT_RECORD_ID)
        .map((id) => ({ key: id })),
    };
    const handled = [];

    for (const record of records) {
      if (typeof record?.id !== "string" || !record.id || !record.data) {
        continue;
      }
      const entry = { key: record.id, data: record.data, record };
      switch (record.kind) {
        case KINDS.CONTAINER:
          incoming.containers.push(entry);
          break;
        case KINDS.SPACE:
          incoming.spaces.push(entry);
          break;
        case KINDS.TAB:
          incoming.tabs.push(entry);
          break;
        case KINDS.FOLDER:
          incoming.folders.push(entry);
          break;
        case KINDS.SPLIT:
          incoming.splits.push(entry);
          break;
        case KINDS.LAYOUT:
          incoming.layout = entry;
          break;
        default:
          // Unknown kind (newer peer): leave untouched and unacknowledged.
          continue;
      }
      handled.push(record);
    }

    const failed = new Set();
    const fail = (entry, e) => {
      failed.add(entry.key);
      console.error(`ZenSidebarSync: failed to apply ${entry.key}:`, e);
    };
    // Withheld (guard / deferred confirmation): unacknowledged for
    // redelivery, but not an error.
    const withhold = (entry) => failed.add(entry.key);

    let guard = null;

    // Container UPSERTS run first — tabs applied below resolve their
    // userContextId through them. Container deletions are handled with the
    // other deletions, behind the window check and the mass-deletion guard
    // (a poisoned batch must not be able to destroy the container registry
    // unconfirmed).
    this.#applyContainerUpserts(incoming.containers, fail);

    const win = this.#mods.ZenWindowSync?.firstSyncedWindow;
    if (!win) {
      // No synced window to apply into — report everything as failed so
      // the orchestrator retries the batch later.
      for (const entry of [
        ...incoming.spaces,
        ...incoming.folders,
        ...incoming.tabs,
        ...incoming.splits,
        ...(incoming.layout ? [incoming.layout] : []),
        ...incoming.deleted,
      ]) {
        failed.add(entry.key);
      }
      return { failed: [...failed], guard: null };
    }

    await win.gZenWorkspaces.promiseInitialized;

    let containerRemovals = incoming.deleted.filter((e) => ZenSyncModel.contextIdForGuid(e.key) !== null);
    const otherDeletions = incoming.deleted.filter((e) => ZenSyncModel.contextIdForGuid(e.key) === null);
    let removals = this.#routeTombstones(win, otherDeletions);

    // Apply-side mass-deletion guard: an incoming batch that would delete
    // most of this device's synced items pauses instead of executing.
    // (v2 only guarded the outbound direction; a poisoned server state
    // still wiped clients.)
    if (!overrideGuard && !reconcile) {
      const wouldDelete =
        removals.tabs.length +
        removals.folders.length +
        removals.spaces.length +
        removals.splits.length +
        containerRemovals.length;
      const localCount = ZenSyncModel.projections().size;
      if (wouldDelete > 10 && wouldDelete > localCount * 0.5) {
        guard = { wouldDelete, localCount };
        removals = { tabs: [], folders: [], splits: [], spaces: [] };
        containerRemovals = [];
        // Deletions are withheld (and NOT acknowledged via noteApplied);
        // upserts still apply below.
        for (const entry of incoming.deleted) {
          withhold(entry);
        }
      }
    }

    this.#deleteContainers(containerRemovals, fail);
    this.#deleteTabs(win, removals.tabs, fail);
    this.#deleteSplits(win, removals.splits, fail);
    await this.#applySpaces(win, incoming.spaces, fail);
    await this.#applyFolders(win, incoming.folders, fail);
    this.#applyTabs(win, incoming.tabs, fail);
    this.#applySplits(win, incoming.splits, fail);
    await this.#deleteFolders(win, removals.folders, fail);
    await this.#deleteSpaces(win, removals.spaces, fail, withhold, {
      skipConfirm: reconcile || overrideGuard,
    });
    this.#applyOrdering(win, incoming, fail);

    if (reconcile) {
      try {
        await this.#reconcileRemovals(win, records);
      } catch (e) {
        console.error("ZenSidebarSync: reconcile removal pass failed:", e);
      }
    }

    // Collect the session soon so the stored sidebar (and with it the sync
    // projections) reflects the applied state instead of re-uploading the
    // pre-apply one.
    this.#mods.SessionSaver?.runDelayed();

    ZenSyncModel.invalidate();
    for (const record of handled) {
      if (failed.has(record.id)) {
        continue;
      }
      ZenSyncModel.noteApplied(record.id, { kind: record.kind, data: record.data });
    }
    for (const entry of incoming.deleted) {
      if (!failed.has(entry.key)) {
        ZenSyncModel.noteApplied(entry.key, null);
      }
    }
    return { failed: [...failed], guard };
  }

  /**
   * Tombstones have no payload. Whatever local thing owns the id decides
   * what kind of deletion this is; the uploaded-baseline kind is the
   * fallback for ids with no live counterpart (those need no work anyway).
   */
  #routeTombstones(win, deletions) {
    const routed = { tabs: [], folders: [], splits: [], spaces: [] };
    const spaces = win.gZenWorkspaces.getWorkspaces();
    for (const entry of deletions) {
      const el = this.#itemIn(win, entry.key);
      if (win.gBrowser.isTab(el)) {
        routed.tabs.push(entry);
      } else if (el?.isZenFolder) {
        routed.folders.push(entry);
      } else if (el?.hasAttribute?.("split-view-group")) {
        routed.splits.push(entry);
      } else if (spaces.some((s) => s.uuid === entry.key)) {
        routed.spaces.push(entry);
      }
    }
    return routed;
  }

  /* Mark: containers */

  #applyContainerUpserts(containers, fail) {
    const CIS = this.#mods.ContextualIdentityService;
    for (const entry of containers) {
      const { key: guid, data } = entry;
      try {
        if (!data.name || !CIS) {
          continue;
        }
        const mapped = ZenSyncModel.contextIdForGuid(guid);
        const existing = mapped !== null ? CIS.getPublicIdentityFromId(mapped) : null;
        if (existing) {
          CIS.update(mapped, data.name, data.icon, data.color);
        } else {
          const identity = CIS.create(data.name, data.icon, data.color);
          ZenSyncModel.registerContainerGuid(guid, identity.userContextId);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  #deleteContainers(removals, fail) {
    for (const entry of removals) {
      try {
        const mapped = ZenSyncModel.contextIdForGuid(entry.key);
        if (mapped !== null && this.#mods.ContextualIdentityService?.getPublicIdentityFromId(mapped)) {
          this.#mods.ContextualIdentityService.remove(mapped);
        }
        ZenSyncModel.forgetContainerGuid(entry.key);
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: spaces */

  async #applySpaces(win, spaces, fail) {
    if (!spaces.length) {
      return;
    }
    const list = win.gZenWorkspaces.getWorkspaces();
    let changed = false;
    const repaint = [];
    for (const entry of spaces) {
      const { data } = entry;
      try {
        if (!data.uuid) {
          continue;
        }
        const fields = {
          uuid: data.uuid,
          name: data.name ?? "",
          icon: data.icon ?? undefined,
          theme: data.theme ?? null,
          containerTabId: ZenSyncModel.contextIdForGuid(data.containerGuid) ?? 0,
        };
        // A space record re-syncs whenever its child ordering changes, so
        // only propagate (and especially repaint) when its own fields did.
        const index = list.findIndex((s) => s.uuid === data.uuid);
        const current = index === -1 ? null : list[index];
        const canonicalJSON = ZenSyncModelStatics.canonicalJSON;
        const visualChanged =
          !current ||
          (current.name ?? "") !== fields.name ||
          (current.icon ?? null) !== (fields.icon ?? null) ||
          canonicalJSON(current.theme ?? null) !== canonicalJSON(fields.theme ?? null);
        const containerChanged = !current || (current.containerTabId ?? 0) !== fields.containerTabId;
        if (!current) {
          list.push(fields);
          changed = true;
        } else if (visualChanged || containerChanged) {
          list[index] = { ...current, ...fields };
          changed = true;
        }
        if (visualChanged) {
          repaint.push(data.uuid);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
    if (changed) {
      await win.gZenWorkspaces.propagateWorkspaces(list);
      try {
        (win.gZenWindowSync || this.#mods.ZenWindowSync)?.propagateWorkspacesToAllWindows(list);
      } catch (e) {}
      for (const uuid of repaint) {
        const updated = list.find((s) => s.uuid === uuid);
        if (updated) {
          try {
            win.gZenThemePicker?.onWorkspaceChange(updated);
          } catch (e) {}
        }
      }
    }
  }

  async #deleteSpaces(win, removals, fail, withhold, { skipConfirm = false } = {}) {
    for (const entry of removals) {
      const { key: uuid } = entry;
      try {
        const spaces = win.gZenWorkspaces.getWorkspaces();
        if (!spaces.some((s) => s.uuid === uuid)) {
          continue;
        }
        if (spaces.length <= 1) {
          // Never delete the last space; the local copy revives it remotely.
          continue;
        }
        if (skipConfirm) {
          await win.gZenWorkspaces.removeWorkspace(uuid);
        } else {
          // The confirmation modal must NOT be awaited inside the apply
          // queue — an unattended device would otherwise stall all applying
          // and capturing until a human clicks. Withhold the tombstone
          // (unacknowledged) and resolve it in a detached prompt chain.
          withhold(entry);
          this.#queueSpaceDeleteConfirm(uuid);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  #confirmChain = Promise.resolve();
  #pendingSpaceConfirms = new Set();

  #queueSpaceDeleteConfirm(uuid) {
    if (this.#pendingSpaceConfirms.has(uuid)) {
      return;
    }
    this.#pendingSpaceConfirms.add(uuid);
    this.#confirmChain = this.#confirmChain
      .then(async () => {
        try {
          const win = this.#mods.ZenWindowSync?.firstSyncedWindow;
          if (!win) {
            return;
          }
          const spaces = win.gZenWorkspaces.getWorkspaces();
          if (!spaces.some((s) => s.uuid === uuid) || spaces.length <= 1) {
            return;
          }
          const ok = await this.#confirmRemoteSpaceDelete(win, uuid);
          if (ok) {
            await win.gZenWorkspaces.removeWorkspace(uuid);
          }
          // Either way the baseline entry is dropped: confirmed → space and
          // baseline both gone, quiet; declined → the local space is no
          // longer in the baseline, so the next diff re-uploads it and
          // revives it on the server (keep-everywhere semantics).
          ZenSyncModel.noteApplied(uuid, null);
          ZenSyncModel.invalidate();
          this.#mods.SessionSaver?.runDelayed();
        } catch (e) {
          console.error("ZenSidebarSync: space delete confirmation failed:", e);
        } finally {
          this.#pendingSpaceConfirms.delete(uuid);
        }
      })
      .catch(() => {});
  }

  async #confirmRemoteSpaceDelete(win, uuid) {
    const name = win.gZenWorkspaces.getWorkspaceFromId(uuid)?.name || uuid;
    try {
      const result = await Services.prompt.asyncConfirmEx(
        win.browsingContext,
        Services.prompt.MODAL_TYPE_WINDOW,
        "Delete synced space?",
        `Another device deleted the space "${name}" (including its tabs and folders). Delete it here too?`,
        Services.prompt.STD_YES_NO_BUTTONS,
        null,
        null,
        null,
        null,
        false
      );
      return result.get("buttonNumClicked") === 0;
    } catch (e) {
      // Prompt unavailable — err on the side of keeping local data.
      return false;
    }
  }

  /* Mark: folders */

  async #applyFolders(win, folders, fail) {
    // Break parent cycles in the merged (local + incoming) parent graph
    // before applying: appendChild of an ancestor into its descendant
    // throws, and the poisoned record would be redelivered forever.
    const parentOf = new Map();
    for (const f of ZenSyncModel.getFullProjection()) {
      if (f.kind === this.#KINDS.FOLDER) {
        parentOf.set(f.id, f.data.parentFolderId || null);
      }
    }
    for (const f of folders) {
      parentOf.set(f.key, f.data.parentFolderId || null);
    }
    for (const f of folders) {
      const seen = new Set([f.key]);
      let parent = f.data.parentFolderId || null;
      while (parent) {
        if (seen.has(parent)) {
          console.warn(`ZenSidebarSync: folder nesting cycle at ${f.key}; dropping its parent edge`);
          f.data = { ...f.data, parentFolderId: null };
          parentOf.set(f.key, null);
          break;
        }
        seen.add(parent);
        parent = parentOf.get(parent) || null;
      }
    }

    // Parents before children so nesting targets exist.
    const depths = new Map(folders.map((f) => [f.key, f.data.parentFolderId]));
    const depthOf = (key) => {
      let depth = 0;
      let parent = depths.get(key);
      while (parent && depths.has(parent) && depth < 10) {
        depth++;
        parent = depths.get(parent);
      }
      return depth;
    };
    const ordered = [...folders].sort((a, b) => depthOf(a.key) - depthOf(b.key));

    for (const entry of ordered) {
      const { key: folderId, data } = entry;
      try {
        const workspaceUuid = this.#resolveWorkspace(win, data.workspaceUuid);
        let folder = this.#itemIn(win, folderId);
        if (!folder?.isZenFolder) {
          folder = win.gZenFolders.createFolder([], {
            id: folderId,
            label: data.name || "Folder",
            workspaceId: workspaceUuid || win.gZenWorkspaces.activeWorkspace,
            isLiveFolder: !!data.live,
          });
        } else if (data.name && folder.label !== data.name) {
          folder.label = data.name;
        }

        if (data.live && !folder.isLiveFolder) {
          folder.isLiveFolder = true;
        }

        // Same local-icon filter as capture: a malicious/corrupt record
        // must not smuggle an arbitrary URL into setFolderUserIcon.
        const wantIcon = ZenSyncModelStatics.syncableIconUrl(data.icon || "") || null;
        if ((folder.iconURL || null) !== wantIcon) {
          win.gZenFolders.setFolderUserIcon(folder, wantIcon);
          folder.dispatchEvent(new win.CustomEvent("TabGroupUpdate", { bubbles: true }));
        }

        const desiredParent = data.parentFolderId ? this.#itemIn(win, data.parentFolderId) : null;
        const currentParent = folder.group;
        if ((currentParent?.id || null) !== (data.parentFolderId || null)) {
          if (desiredParent?.isZenFolder) {
            this.#handleTabMove(win, folder, () => {
              if (desiredParent.tabs.length) {
                desiredParent.tabs[0].after(folder);
              } else {
                desiredParent.appendChild(folder);
              }
            });
          } else if (!data.parentFolderId && currentParent?.isZenFolder) {
            const ws = workspaceUuid || win.gZenWorkspaces.activeWorkspace;
            const container = win.gZenWorkspaces.workspaceElement(ws)?.pinnedTabsContainer;
            if (container) {
              this.#handleTabMove(win, folder, () => {
                container.insertBefore(folder, container.querySelector(".pinned-tabs-container-separator"));
              });
            }
          }
        }
        if (workspaceUuid && folder.getAttribute("zen-workspace-id") !== workspaceUuid) {
          if (!folder.group) {
            win.gZenFolders.changeFolderToSpace(folder, workspaceUuid);
          } else {
            folder.setAttribute("zen-workspace-id", workspaceUuid);
          }
        }
        if (data.live && this.#mods.ZenLiveFoldersManager?.adoptSyncedFolder) {
          await this.#mods.ZenLiveFoldersManager.adoptSyncedFolder(folderId, data.live);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  async #deleteFolders(win, removals, fail) {
    for (const entry of removals) {
      try {
        const folder = this.#itemIn(win, entry.key);
        if (!folder?.isZenFolder) {
          continue;
        }
        // Members without their own tombstone survive: unpack, then delete
        // the (now empty) folder.
        await folder.unpackTabs();
        await folder.delete();
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: tabs */

  #applyTabs(win, tabs, fail) {
    for (const entry of tabs) {
      const { key: tabId, data } = entry;
      try {
        if (!ZenSyncModelStatics.isSyncableUrl(data.url)) {
          continue;
        }
        const existing = this.#itemIn(win, tabId);
        if (win.gBrowser.isTab(existing)) {
          this.#updateTab(win, existing, data);
        } else {
          this.#createTab(win, tabId, data);
        }
        // Essential membership can be refused (capacity, container rules);
        // report as failed so the record is retried instead of silently
        // diverging until the next digest self-heal.
        if (data.essential) {
          const tab = this.#itemIn(win, tabId);
          if (win.gBrowser.isTab(tab) && !tab.hasAttribute("zen-essential")) {
            fail(entry, new Error("addToEssentials refused"));
          }
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  #createTab(win, tabId, data) {
    const userContextId = ZenSyncModel.contextIdForGuid(data.containerGuid) ?? 0;
    const tab = win.gBrowser.addTrustedTab(data.url, {
      createLazyBrowser: true,
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      lazyTabTitle: data.title || undefined,
      userContextId,
    });
    // Setting the sync id before the queued TabOpen handler runs makes
    // window sync treat this tab as already replicated.
    tab.id = tabId;
    tab._zenContentsVisible = true;
    // No setTabState here: the lazy tab's lazyData (url + lazyTabTitle)
    // already synthesizes session entries at collection time, so its
    // projection identity is total. Calling setTabState would instantiate
    // the browser and the tab would count as "loaded" for every later URL
    // application (holds instead of retargets).
    if (data.essential || data.pinned) {
      this.#updateTabIdentity(win, tab, data);
    }
    if (data.essential) {
      win.gZenPinnedTabManager.addToEssentials(tab);
    } else {
      const workspaceUuid = this.#resolveWorkspace(win, data.workspaceUuid);
      if (workspaceUuid) {
        tab.setAttribute("zen-workspace-id", workspaceUuid);
      }
      if (data.pinned) {
        win.gBrowser.pinTab(tab);
      }
      if (workspaceUuid) {
        win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
      }
      if (data.pinned) {
        const folder = data.folderId && this.#itemIn(win, data.folderId);
        if (folder?.isZenFolder) {
          folder.addTabs([tab]);
        }
      }
    }
    try {
      this.#mods.ZenWindowSync?.on_TabOpen({ target: tab }, { ignoreExistingId: true });
    } catch (e) {}
  }

  /**
   * Reconciles a pinned/essential tab's synced identity: pinned initial
   * state, static label/icon, live icon, default-container marker.
   * (Upstream #updateTabIdentity, pinned-only by construction.)
   */
  #updateTabIdentity(win, tab, data) {
    const syncableIconUrl = ZenSyncModelStatics.syncableIconUrl;
    const icon = syncableIconUrl(data.icon);
    const initial = tab._zenPinnedInitialState;
    const identityChanged =
      initial?.entry?.url !== data.url || (initial?.entry?.title || "") !== (data.title || "");
    if (identityChanged || syncableIconUrl(initial?.image || "") !== icon) {
      try {
        this.#mods.ZenWindowSync?.setPinnedInitialState(
          tab,
          { url: data.url, title: data.title || "" },
          icon || undefined
        );
      } catch (e) {}
    }
    if (identityChanged && this.#isUnloadedTab(tab)) {
      this.#retargetUnloadedTab(win, tab, data, initial?.entry?.url);
    }

    const staticLabel = typeof data.staticLabel === "string" ? data.staticLabel : null;
    const localLabel = typeof tab.zenStaticLabel === "string" ? tab.zenStaticLabel : null;
    if (staticLabel !== localLabel) {
      tab.zenStaticLabel = staticLabel ?? undefined;
      if (staticLabel) {
        tab._zenChangeLabelFlag = true;
        try {
          win.gBrowser._setTabLabel(tab, staticLabel);
        } finally {
          delete tab._zenChangeLabelFlag;
        }
      }
    }
    tab.zenStaticIcon = data.hasStaticIcon && icon ? icon : undefined;
    // Compare normalized: setIcon rewraps svg data: icons into
    // moz-remote-image urls when writing the attribute.
    if (icon && syncableIconUrl(tab.getAttribute("image")) !== icon) {
      try {
        win.gBrowser.setIcon(tab, icon);
        this.#mods.TabStateCache?.update(tab.linkedBrowser.permanentKey, { image: null });
      } catch (e) {
        console.error("ZenSidebarSync: failed to set tab icon", e);
      }
    }
    if (data.defaultContainer) {
      tab.setAttribute("zenDefaultUserContextId", "true");
    } else {
      tab.removeAttribute("zenDefaultUserContextId");
    }
  }

  /**
   * Points an unloaded tab's session state at the record's canonical url.
   * Skips when the local tab already navigated away from the previously
   * synced url (the user changed it while the record was in flight).
   */
  #retargetUnloadedTab(win, tab, data, previousUrl) {
    try {
      const state = JSON.parse(win.SessionStore.getTabState(tab));
      const entries = state.entries || [];
      let currentUrl = null;
      if (entries.length) {
        const index = Math.min(Math.max((state.index || entries.length) - 1, 0), entries.length - 1);
        currentUrl = entries[index]?.url || null;
      }
      if (currentUrl === data.url || (currentUrl && previousUrl && currentUrl !== previousUrl)) {
        return;
      }
      state.entries = [
        {
          url: data.url,
          title: data.title || "",
          triggeringPrincipal_base64: this.#mods.E10SUtils.serializePrincipal(
            Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(data.url), {})
          ),
        },
      ];
      state.index = 1;
      state.image = ZenSyncModelStatics.syncableIconUrl(data.icon) || undefined;
      delete state.scroll;
      win.SessionStore.setTabState(tab, state);
    } catch (e) {
      console.error("ZenSidebarSync: failed to retarget unloaded tab", e);
    }
  }

  #loadedTabUrl(tab) {
    try {
      const spec = tab.linkedBrowser?.currentURI?.spec;
      return spec && spec !== "about:blank" ? spec : null;
    } catch (e) {
      return null;
    }
  }

  // "Unloaded" for navigation purposes: nothing a user could be looking at
  // would be yanked. Covers true lazy tabs (no linkedPanel) AND restored/
  // retargeted tabs still pending their first real load — setTabState
  // instantiates the browser, so linkedPanel alone under-reports.
  #isUnloadedTab(tab) {
    return !tab.linkedPanel || tab.hasAttribute("pending");
  }

  /**
   * Converges a NORMAL tab's URL. A loaded tab is never navigated — the
   * remote URL is stored as a pending hold that resolves when the tab
   * unloads, the user navigates it themselves, or the URLs converge.
   */
  #applyNormalTabUrl(win, tab, data) {
    if (this.#isUnloadedTab(tab)) {
      ZenSyncModel.dropHold(tab.id);
      this.#retargetUnloadedTab(win, tab, data, null);
      return;
    }
    const currentUrl = this.#loadedTabUrl(tab);
    if (!currentUrl || currentUrl === data.url) {
      ZenSyncModel.dropHold(tab.id);
      return;
    }
    ZenSyncModel.setHold(tab.id, {
      url: data.url,
      title: data.title || "",
      icon: data.icon || "",
      localUrl: currentUrl,
    });
  }

  #applyFolderMembership(win, item, folderId) {
    const currentFolder = item.group?.isZenFolder ? item.group.id : null;
    const wantFolder = folderId || null;
    if (currentFolder === wantFolder) {
      return;
    }
    const target = wantFolder && this.#itemIn(win, wantFolder);
    if (target?.isZenFolder) {
      target.addTabs([item]);
    } else if (!wantFolder && currentFolder) {
      // ungroupTab pops a single nesting level; keep going until the item
      // is actually top-level.
      while (win.gBrowser.isTabGroup(item.group) && item.group.isZenFolder) {
        win.gBrowser.ungroupTab(item);
      }
    }
  }

  #updateTab(win, tab, data) {
    if (data.essential || data.pinned) {
      this.#updateTabIdentity(win, tab, data);
    } else {
      this.#applyNormalTabUrl(win, tab, data);
    }

    // Kind transitions are field updates on one record, never remove+add.
    // Order matters: essential is cleared first (removeEssentials re-homes
    // the tab to the RECEIVER's active workspace, so the explicit workspace
    // move below must always run afterwards).
    const isEssential = tab.hasAttribute("zen-essential");
    if (data.essential && !isEssential) {
      win.gZenPinnedTabManager.addToEssentials(tab);
      return;
    }
    if (!data.essential && isEssential) {
      win.gZenPinnedTabManager.removeEssentials(tab, /* unpin */ false);
    }
    if (data.essential) {
      return;
    }

    if (data.pinned && !tab.pinned) {
      win.gBrowser.pinTab(tab);
    } else if (!data.pinned && tab.pinned) {
      win.gBrowser.unpinTab(tab);
    }

    const inSplit = tab.group?.hasAttribute("split-view-group");
    if (inSplit) {
      // The split record governs placement of its members.
      return;
    }
    if (data.pinned) {
      this.#applyFolderMembership(win, tab, data.folderId);
    } else if (tab.group?.isZenFolder) {
      this.#applyFolderMembership(win, tab, null);
    }
    const workspaceUuid = this.#resolveWorkspace(win, data.workspaceUuid);
    if (
      (!data.folderId || !data.pinned) &&
      workspaceUuid &&
      tab.getAttribute("zen-workspace-id") !== workspaceUuid
    ) {
      win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
    }
  }

  #removeTab(win, tab) {
    if (tab.splitView) {
      win.gZenViewSplitter.removeTabFromGroup(tab, undefined, {
        forUnsplit: true,
        changeTab: false,
      });
    }
    ZenSyncModel.dropHold(tab.id);
    win.gBrowser.removeTab(tab, { animate: true });
  }

  #deleteTabs(win, removals, fail) {
    for (const entry of removals) {
      try {
        const tab = this.#itemIn(win, entry.key);
        if (win.gBrowser.isTab(tab)) {
          this.#removeTab(win, tab);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: splits */

  #applySplits(win, splits, fail) {
    for (const entry of splits) {
      const { key: splitId, data } = entry;
      try {
        const members = (data.tabs || [])
          .map((id) => this.#itemIn(win, id))
          .filter((tab) => win.gBrowser.isTab(tab));
        const existing = this.#itemIn(win, splitId);
        const hasGroup = existing?.hasAttribute?.("split-view-group");
        if (hasGroup) {
          const wanted = new Set(data.tabs || []);
          for (const tab of [...existing.tabs]) {
            if (tab.id && !wanted.has(tab.id)) {
              win.gZenViewSplitter.removeTabFromGroup(tab, undefined, { changeTab: false });
            }
          }
        }
        if (members.length >= 2) {
          win.gZenViewSplitter.splitTabs(members, data.gridType, -1, { groupFetchId: splitId });
        }
        const group = this.#itemIn(win, splitId);
        if (group?.hasAttribute?.("split-view-group")) {
          this.#applyFolderMembership(win, group, data.folderId);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  #deleteSplits(win, removals, fail) {
    for (const entry of removals) {
      try {
        const index = win.gZenViewSplitter._data.findIndex((group) => group.groupId === entry.key);
        if (index >= 0) {
          win.gZenViewSplitter.removeGroup(index);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: ordering */

  #handleTabMove(win, el, callback) {
    if (typeof win.gBrowser.zenHandleTabMove === "function") {
      win.gBrowser.zenHandleTabMove(el, callback);
    } else {
      callback();
    }
  }

  #applyRelativeOrder(win, elements) {
    let prev = null;
    for (const el of elements) {
      if (!el) {
        continue;
      }
      if (prev && prev.parentNode && prev.parentNode === el.parentNode && prev.nextElementSibling !== el) {
        this.#handleTabMove(win, el, () => prev.after(el));
      }
      prev = el;
    }
  }

  /**
   * Ordering runs in the first synced window only: every move goes through
   * zenHandleTabMove, whose TabMove events window sync replicates into the
   * other windows.
   */
  #applyOrdering(win, incoming, fail) {
    for (const entry of [...incoming.spaces, ...incoming.folders]) {
      const { key, data } = entry;
      try {
        if (Array.isArray(data.children) && data.children.length) {
          // A folder's empty-tab placeholder anchors its first child.
          const folder = data.folderId ? this.#itemIn(win, key) : null;
          const start = folder?.isZenFolder ? folder.tabs.find((t) => t.hasAttribute("zen-empty-tab")) : null;
          this.#applyRelativeOrder(win, [start ?? null, ...data.children.map((id) => this.#itemIn(win, id))]);
        }
        if (Array.isArray(data.normalChildren) && data.normalChildren.length > 1) {
          this.#applyRelativeOrder(
            win,
            data.normalChildren.map((id) => this.#itemIn(win, id))
          );
        }
      } catch (e) {
        fail(entry, e);
      }
    }
    if (!incoming.layout) {
      return;
    }
    const { data } = incoming.layout;
    try {
      for (const tabIds of Object.values(data.essentials || {})) {
        if (Array.isArray(tabIds) && tabIds.length > 1) {
          this.#applyRelativeOrder(
            win,
            tabIds.map((id) => this.#itemIn(win, id))
          );
        }
      }
      if (Array.isArray(data.spaces) && data.spaces.length > 1) {
        const current = win.gZenWorkspaces.getWorkspaces();
        const byUuid = new Map(current.map((s) => [s.uuid, s]));
        const ordered = data.spaces.map((uuid) => byUuid.get(uuid)).filter(Boolean);
        for (const space of current) {
          if (!data.spaces.includes(space.uuid)) {
            ordered.push(space);
          }
        }
        const changedOrder = ordered.some((space, i) => current[i]?.uuid !== space.uuid);
        if (changedOrder && ordered.length === current.length) {
          (win.gZenWindowSync || this.#mods.ZenWindowSync)?.propagateWorkspacesToAllWindows(ordered);
        }
      }
    } catch (e) {
      fail(incoming.layout, e);
    }
  }

  /* Mark: reconcile (initial "Replace local") */

  // Deletes local synced things absent from the incoming record set. Live
  // browser state drives the pass — a stale session collection must not
  // let stragglers survive a full replace (v2 lesson). Containers are
  // never deleted here (shared infrastructure, too destructive). Every
  // removal is awaited so the post-apply session collection reflects a
  // finished state instead of diffing (and briefly re-uploading) leftovers.
  async #reconcileRemovals(win, records) {
    const keep = new Set(records.map((r) => r.id));

    // Tabs: any live tab with a sync id and a syncable identity not in the
    // incoming set gets closed. Tabs that cannot be represented remotely
    // (about:, extension pages) are left alone.
    for (const tab of [...win.gZenWorkspaces.allStoredTabs]) {
      try {
        if (!tab.id || keep.has(tab.id)) {
          continue;
        }
        if (tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
          continue;
        }
        const url = this.#loadedTabUrl(tab) || this.#lazyTabUrl(win, tab);
        if (!ZenSyncModelStatics.isSyncableUrl(url)) {
          continue;
        }
        this.#removeTab(win, tab);
      } catch (e) {
        console.warn("ZenSidebarSync: reconcile tab removal failed:", e);
      }
    }

    // Folders (documents zen-folder custom elements, live DOM).
    for (const folder of [...win.document.querySelectorAll("zen-folder")]) {
      try {
        if (!folder.id || keep.has(folder.id) || !folder.isZenFolder) {
          continue;
        }
        await folder.unpackTabs?.();
        await folder.delete?.();
      } catch (e) {
        console.warn("ZenSidebarSync: reconcile folder removal failed:", e);
      }
    }

    // Spaces (never the last one).
    for (const space of [...win.gZenWorkspaces.getWorkspaces()]) {
      try {
        if (keep.has(space.uuid)) {
          continue;
        }
        if (win.gZenWorkspaces.getWorkspaces().length <= 1) {
          break;
        }
        await win.gZenWorkspaces.removeWorkspace(space.uuid);
      } catch (e) {
        console.warn("ZenSidebarSync: reconcile space removal failed:", e);
      }
    }
  }

  #lazyTabUrl(win, tab) {
    try {
      const state = JSON.parse(win.SessionStore.getTabState(tab));
      const entries = state?.entries || [];
      if (!entries.length) {
        return null;
      }
      const index = Math.min(Math.max((state.index || entries.length) - 1, 0), entries.length - 1);
      return entries[index]?.url || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolves pending navigation holds against current tab state. Called
   * from the capture path on every fresh collection.
   */
  processHolds() {
    const win = this.#mods.ZenWindowSync?.firstSyncedWindow;
    if (!win) {
      return;
    }
    const holds = ZenSyncModel.getHolds();
    for (const [tabId, hold] of Object.entries(holds)) {
      const tab = this.#itemIn(win, tabId);
      if (!win.gBrowser.isTab(tab)) {
        // Tab closed — its tombstone path handles the rest.
        ZenSyncModel.dropHold(tabId);
        continue;
      }
      if (this.#isUnloadedTab(tab)) {
        // Unloaded now: converge without ever having navigated the user.
        // The hold is kept until a session collection reflects the retarget
        // — dropping it now would let THIS cycle's diff (built from the
        // pre-retarget collection) re-upload the stale local URL and undo
        // the remote change.
        const lazyUrl = this.#lazyTabUrl(win, tab);
        if (lazyUrl === hold.url) {
          ZenSyncModel.dropHold(tabId);
        } else {
          this.#retargetUnloadedTab(win, tab, { url: hold.url, title: hold.title, icon: hold.icon }, null);
        }
        continue;
      }
      const currentUrl = this.#loadedTabUrl(tab);
      if (!currentUrl) {
        continue;
      }
      if (currentUrl === hold.url) {
        // Converged naturally.
        ZenSyncModel.dropHold(tabId);
      } else if (currentUrl !== hold.localUrl) {
        // The user navigated this tab themselves — local truth wins and
        // re-uploads through the normal diff.
        ZenSyncModel.dropHold(tabId);
      }
    }
  }
})();

this.ZenSyncApplier = ZenSyncApplier;
