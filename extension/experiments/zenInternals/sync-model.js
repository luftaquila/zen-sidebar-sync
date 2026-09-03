/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Ported and extended from Zen Browser's ZenSpacesSyncModel.sys.mjs
 * (github.com/zen-browser/desktop, dev branch, src/zen/sync/). Extensions
 * over the upstream model:
 *   - regular (unpinned, non-essential) tabs are syncable; their identity is
 *     the live session-entry URL instead of the pinned initial state
 *   - space records carry a `normalChildren` ordering array for the
 *     unpinned section, and tab records carry an explicit `pinned` flag
 *   - the uploaded-baseline snapshot stores {digest, kind} per id so
 *     tombstone routing and absence confirmation know the record kind
 *   - deletions are only reported for ids whose owning local object is
 *     confirmed absent (never for "projection returned null")
 *   - pending navigation holds: records the applier could not materialize
 *     on a loaded tab are excluded from the outgoing diff until resolved
 */

/* eslint-env mozilla-chrome */
/* global ChromeUtils, Services, Components, Cu */

"use strict";

// Loaded via Services.scriptloader.loadSubScript into the shared
// zenInternals experiment scope. Everything exported hangs off `this`.

// The experiment sandbox exposes only a curated set of globals — WebIDL
// utilities like TextEncoder/PathUtils may be absent. Borrow them from the
// shared system global (the one Services lives in).
const ZenSyncSystemGlobal = (() => {
  try {
    const cu = typeof Cu !== "undefined" ? Cu : Components.utils;
    return cu.getGlobalForObject(Services);
  } catch (e) {
    return globalThis;
  }
})();
const ZenTextEncoder =
  typeof TextEncoder !== "undefined" ? TextEncoder : ZenSyncSystemGlobal.TextEncoder;
const ZenPathUtils =
  typeof PathUtils !== "undefined" ? PathUtils : ZenSyncSystemGlobal.PathUtils;

const ZenSyncModules = (() => {
  const mods = {};
  const tryImport = (name, url, symbol) => {
    try {
      mods[name] = ChromeUtils.importESModule(url)[symbol];
    } catch (e) {
      mods[name] = null;
    }
  };
  tryImport("ZenSessionStore", "resource:///modules/zen/ZenSessionManager.sys.mjs", "ZenSessionStore");
  tryImport("ZenWindowSync", "resource:///modules/zen/ZenWindowSync.sys.mjs", "ZenWindowSync");
  tryImport("ZenLiveFoldersManager", "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs", "ZenLiveFoldersManager");
  tryImport("JSONFile", "resource://gre/modules/JSONFile.sys.mjs", "JSONFile");
  tryImport("SessionSaver", "resource:///modules/sessionstore/SessionSaver.sys.mjs", "SessionSaver");
  tryImport("TabStateFlusher", "resource:///modules/sessionstore/TabStateFlusher.sys.mjs", "TabStateFlusher");
  tryImport("E10SUtils", "resource://gre/modules/E10SUtils.sys.mjs", "E10SUtils");
  tryImport("TabStateCache", "resource:///modules/sessionstore/TabStateCache.sys.mjs", "TabStateCache");
  tryImport(
    "ContextualIdentityService",
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
    "ContextualIdentityService"
  );
  if (!mods.ContextualIdentityService) {
    // Older module registry location.
    tryImport(
      "ContextualIdentityService",
      "resource://gre/modules/ContextualIdentityService.sys.mjs",
      "ContextualIdentityService"
    );
  }
  return mods;
})();

const RECORD_KINDS = Object.freeze({
  CONTAINER: "container",
  SPACE: "space",
  TAB: "tab",
  FOLDER: "folder",
  SPLIT: "split",
  LAYOUT: "layout",
});

const LAYOUT_RECORD_ID = "layout";

const BUILTIN_CONTAINER_MAX = 4;
const BUILTIN_GUID_PREFIX = "builtin-";

const STORE_FILE_NAME = "zen-sidebar-sync.json";
const STORE_VERSION = 1;

// Everything setIcon accepts without a loading principal.
const LOCAL_ICON_PROTOCOLS = ["data:", "chrome:", "about:", "resource:"];

function isSyncableUrl(url) {
  return typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"));
}

// Normalizes a tab icon for syncing (upstream syncableIconUrl): unwraps
// moz-remote-image: wrappers (per-process ids meaningless elsewhere) and
// drops anything setIcon would reject as remote.
function syncableIconUrl(icon) {
  if (!icon || typeof icon !== "string") {
    return "";
  }
  if (icon.startsWith("moz-remote-image:")) {
    try {
      const uri = Services.io.newURI(icon);
      icon = new URLSearchParams(uri.query).get("url") || "";
    } catch (e) {
      return "";
    }
  }
  return LOCAL_ICON_PROTOCOLS.some((protocol) => icon.startsWith(protocol)) ? icon : "";
}

function sortedClone(value) {
  if (Array.isArray(value)) {
    return value.map(sortedClone);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedClone(value[key]);
    }
    return out;
  }
  return value === undefined ? null : value;
}

// Deterministic JSON serialization (recursively sorted keys, undefined→null)
// so two structurally equal payloads always stringify identically. This is
// the canonicalization that keeps digests comparable across devices.
function canonicalJSON(value) {
  return JSON.stringify(sortedClone(value));
}

const _textEncoder = new ZenTextEncoder();

function _sha256b64(str) {
  const Cc_ = typeof Cc !== "undefined" ? Cc : Components.classes;
  const Ci_ = typeof Ci !== "undefined" ? Ci : Components.interfaces;
  const hasher = Cc_["@mozilla.org/security/hash;1"].createInstance(Ci_.nsICryptoHash);
  hasher.init(Ci_.nsICryptoHash.SHA256);
  const bytes = _textEncoder.encode(str);
  hasher.update(bytes, bytes.length);
  return hasher.finish(/* base64 = */ true);
}

// FNV-1a 64-bit over the canonical string. Only used if nsICryptoHash is
// unavailable in this scope; collision odds over a per-profile record set
// are negligible for equality-only comparisons.
function _fnv64(str) {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c >> 8) | (c << 3)), 0x01000193) >>> 0;
  }
  return `fnv-${h1.toString(36)}-${h2.toString(36)}`;
}

let _hashImpl = null;
function recordDigest(kind, data) {
  const canonical = canonicalJSON({ kind, data });
  if (!_hashImpl) {
    try {
      _sha256b64("probe");
      _hashImpl = _sha256b64;
    } catch (e) {
      _hashImpl = _fnv64;
    }
  }
  return _hashImpl(canonical);
}

class ZenSyncModelImpl {
  #file = null;
  #cache = null;
  #digestCache = null;

  #data() {
    if (!this.#file) {
      this.#file = new ZenSyncModules.JSONFile({
        path: ZenPathUtils.join(ZenPathUtils.profileDir, STORE_FILE_NAME),
        dataPostProcessor: (data) => {
          if (data.version !== STORE_VERSION) {
            // Drop the uploaded snapshot so everything re-diffs, but keep
            // the container identity mappings (they describe this profile,
            // not the server).
            data.uploaded = {};
            data.holds = {};
            delete data.generation;
          }
          data.version = STORE_VERSION;
          data.uploaded ||= {};
          data.containers ||= {};
          data.holds ||= {};
          return data;
        },
      });
      this.#file.ensureDataReady();
    }
    return this.#file.data;
  }

  invalidate() {
    this.#cache = null;
    this.#digestCache = null;
  }

  /* Mark: server generation */

  // The server's store generation we last synced against. A different
  // generation means the server state is not the one our uploaded snapshot
  // describes (reset / replaced by someone else) — the orchestrator must
  // re-run the initial-sync direction prompt instead of auto-reconciling.
  getGeneration() {
    return this.#data().generation || null;
  }

  setGeneration(generation) {
    this.#data().generation = generation;
    this.#file.saveSoon();
  }

  /* Mark: container identity */

  guidForContextId(userContextId, { create = false } = {}) {
    const id = Number(userContextId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    if (id <= BUILTIN_CONTAINER_MAX) {
      return `${BUILTIN_GUID_PREFIX}${id}`;
    }
    const data = this.#data();
    for (const [guid, mapped] of Object.entries(data.containers)) {
      if (mapped === id) {
        return guid;
      }
    }
    if (!create) {
      return null;
    }
    const guid = Services.uuid.generateUUID().toString().slice(1, -1);
    data.containers[guid] = id;
    this.#file.saveSoon();
    return guid;
  }

  contextIdForGuid(guid) {
    if (typeof guid !== "string" || !guid) {
      return null;
    }
    if (guid.startsWith(BUILTIN_GUID_PREFIX)) {
      const id = Number(guid.slice(BUILTIN_GUID_PREFIX.length));
      return Number.isSafeInteger(id) && id > 0 && id <= BUILTIN_CONTAINER_MAX ? id : null;
    }
    return this.#data().containers[guid] ?? null;
  }

  registerContainerGuid(guid, userContextId) {
    if (guid.startsWith(BUILTIN_GUID_PREFIX)) {
      return;
    }
    this.#data().containers[guid] = userContextId;
    this.#file.saveSoon();
  }

  forgetContainerGuid(guid) {
    const data = this.#data();
    if (guid in data.containers) {
      delete data.containers[guid];
      this.#file.saveSoon();
    }
  }

  /* Mark: pending navigation holds */

  // A hold means: the record's canonical URL could not be applied to this
  // (loaded) tab without navigating it out from under the user. While a
  // hold is active the tab is excluded from the outgoing diff — otherwise
  // this device would re-upload its stale URL and the devices would
  // ping-pong. Holds resolve when the tab unloads (retarget), when the
  // user navigates it themselves (local truth wins, hold dropped), or when
  // the URLs converge naturally.
  getHolds() {
    return this.#data().holds;
  }

  setHold(tabId, hold) {
    this.#data().holds[tabId] = hold;
    this.#file.saveSoon();
  }

  dropHold(tabId) {
    const data = this.#data();
    if (tabId in data.holds) {
      delete data.holds[tabId];
      this.#file.saveSoon();
    }
  }

  /* Mark: projections */

  #isCandidateTab(tabData) {
    return !!(
      tabData &&
      tabData.zenSyncId &&
      !tabData.zenIsEmpty &&
      !tabData.zenIsGlance &&
      !tabData.zenLiveFolderItemId
    );
  }

  // Identity of a pinned/essential tab is the canonical pin target
  // (upstream semantics — navigation inside a pinned tab does not change
  // the record). Identity of a normal tab is its current session entry —
  // navigation IS the record change.
  #tabIdentity(tabData) {
    const isPinnedKind = !!(tabData.pinned || tabData.zenEssential);
    const initial = tabData._zenPinnedInitialState;
    let url = isPinnedKind ? initial?.entry?.url : null;
    let title = isPinnedKind ? initial?.entry?.title : null;
    if (!url || url === "about:blank") {
      const entries = tabData.entries || [];
      if (entries.length) {
        const index = Math.min(Math.max((tabData.index || entries.length) - 1, 0), entries.length - 1);
        const entry = entries[index] || entries[0];
        if (entry?.url && entry.url !== "about:blank") {
          url = entry.url;
          title ??= entry.title;
        }
      }
    }
    if (!isSyncableUrl(url)) {
      return null;
    }
    title = title || "";
    // Loading-state canonicalization: a mid-load title is the URL itself.
    // Projecting it as "" on every device keeps digests convergent and
    // avoids one round of title-churn uploads per navigation.
    if (title === url) {
      title = "";
    }
    const icon = syncableIconUrl(tabData.image || (isPinnedKind ? initial?.image : "") || "");
    return { url, title, icon };
  }

  // Ordered child ids for one parent (ported #childSequence). Tabs and
  // splits are ordered by their position in the collected tab list;
  // folders are spliced next to their recorded previous sibling.
  #childSequence({ tabs, folders, splitIds, splitParents, splitWs, scope }) {
    const seq = [];
    const seenSplits = new Set();
    for (const tab of tabs) {
      const groupId = tab.groupId || null;
      if (groupId && splitIds.has(groupId)) {
        if (
          !seenSplits.has(groupId) &&
          scope.matchSplit(splitParents.get(groupId) ?? null, splitWs.get(groupId) ?? null, tab)
        ) {
          seenSplits.add(groupId);
          seq.push(groupId);
        }
        continue;
      }
      if (scope.matchTab(tab, groupId)) {
        seq.push(tab.zenSyncId);
      }
    }
    for (const folder of folders) {
      if (!scope.matchFolder(folder)) {
        continue;
      }
      let index = seq.length;
      const prev = folder.prevSiblingInfo;
      if (!prev || prev.type === "start") {
        index = 0;
      } else if (prev.id) {
        const at = seq.indexOf(prev.id);
        if (at !== -1) {
          index = at + 1;
        } else if (prev.type === "tab") {
          index = 0;
        }
      }
      seq.splice(index, 0, folder.id);
    }
    return seq;
  }

  #projectionContext(sidebar) {
    const candidates = (sidebar.tabs || []).filter((t) => this.#isCandidateTab(t));
    // Identity is resolved once; tabs with no projectable identity are
    // PENDING (locally present, not projected) — never deletions.
    const identities = new Map();
    const pendingTabs = new Set();
    const tabs = [];
    for (const tab of candidates) {
      const identity = this.#tabIdentity(tab);
      if (identity) {
        identities.set(tab.zenSyncId, identity);
        tabs.push(tab);
      } else {
        pendingTabs.add(tab.zenSyncId);
      }
    }

    const folders = (sidebar.folders || []).filter((f) => f?.id && !f.splitViewGroup);
    const folderIds = new Set(folders.map((f) => f.id));
    const allSplits = (sidebar.splitViewData || []).filter((g) => g?.groupId);
    const splitParents = new Map();
    for (const entry of sidebar.folders || []) {
      if (entry?.splitViewGroup && entry.id) {
        splitParents.set(entry.id, entry.parentId || null);
      }
    }

    // Only splits whose members are all synced tabs are synced themselves.
    const syncableTabIds = new Set(tabs.map((t) => t.zenSyncId));
    const splits = allSplits.filter(
      (g) => Array.isArray(g.tabs) && g.tabs.length >= 2 && g.tabs.every((id) => syncableTabIds.has(id))
    );
    const splitIds = new Set(splits.map((g) => g.groupId));
    const splitWs = new Map();
    const splitPinned = new Map();
    for (const tab of tabs) {
      const groupId = tab.groupId || null;
      if (groupId && splitIds.has(groupId) && !splitWs.has(groupId)) {
        splitWs.set(groupId, tab.zenWorkspace || null);
        splitPinned.set(groupId, !!(tab.pinned || tab.zenEssential));
      }
    }
    const folderOf = (groupId) => {
      if (!groupId) {
        return null;
      }
      if (splitIds.has(groupId)) {
        return splitParents.get(groupId) || null;
      }
      return folderIds.has(groupId) ? groupId : null;
    };
    return {
      tabs,
      identities,
      pendingTabs,
      folders,
      splits,
      splitIds,
      splitParents,
      splitWs,
      splitPinned,
      folderOf,
    };
  }

  #projectTabs(map, ctx) {
    for (const tab of ctx.tabs) {
      const identity = ctx.identities.get(tab.zenSyncId);
      const essential = !!tab.zenEssential;
      const pinned = !!(tab.pinned || essential);
      map.set(tab.zenSyncId, {
        kind: RECORD_KINDS.TAB,
        data: {
          tabId: tab.zenSyncId,
          url: identity.url,
          title: identity.title,
          icon: identity.icon,
          containerGuid: this.guidForContextId(tab.userContextId, { create: true }),
          essential,
          pinned,
          workspaceUuid: essential ? null : tab.zenWorkspace || null,
          folderId: pinned ? ctx.folderOf(tab.groupId || null) : null,
          staticLabel: typeof tab.zenStaticLabel === "string" ? tab.zenStaticLabel : null,
          hasStaticIcon: !!tab.zenHasStaticIcon,
          defaultContainer: !!tab.zenDefaultUserContextId,
        },
      });
    }
  }

  projections() {
    const sidebar = ZenSyncModules.ZenSessionStore?.getSidebarData() || {};
    const stamp = sidebar.lastCollected || 0;
    if (this.#cache && this.#cache.stamp === stamp) {
      return this.#cache.map;
    }

    const map = new Map();
    const pending = new Set();
    const ctx = this.#projectionContext(sidebar);
    const { tabs, folders, splits, splitIds, splitParents, splitWs, splitPinned } = ctx;
    for (const id of ctx.pendingTabs) {
      pending.add(id);
    }

    if (ZenSyncModules.ContextualIdentityService) {
      for (const identity of ZenSyncModules.ContextualIdentityService.getPublicIdentities()) {
        if (!identity.name) {
          continue;
        }
        const guid = this.guidForContextId(identity.userContextId, { create: true });
        if (!guid) {
          continue;
        }
        map.set(guid, {
          kind: RECORD_KINDS.CONTAINER,
          data: {
            guid,
            name: identity.name,
            icon: identity.icon || "",
            color: identity.color || "",
          },
        });
      }
    }

    const spaces = sidebar.spaces || [];
    for (const space of spaces) {
      if (!space?.uuid) {
        continue;
      }
      const uuid = space.uuid;
      map.set(uuid, {
        kind: RECORD_KINDS.SPACE,
        data: {
          uuid,
          name: space.name ?? "",
          icon: space.icon ?? null,
          theme: space.theme ?? null,
          containerGuid: this.guidForContextId(space.containerTabId, { create: true }),
          children: this.#childSequence({
            tabs,
            folders,
            splitIds,
            splitParents,
            splitWs,
            scope: {
              matchTab: (t, groupId) =>
                !groupId && !t.zenEssential && !!t.pinned && (t.zenWorkspace || null) === uuid,
              matchSplit: (parent, ws, sampleTab) =>
                !parent && ws === uuid && !!splitPinned.get(sampleTab.groupId),
              matchFolder: (f) => !f.parentId && (f.workspaceId || null) === uuid,
            },
          }),
          // v3 extension: ordering of the unpinned section. Folders never
          // live there; splits of unpinned tabs do.
          normalChildren: this.#childSequence({
            tabs,
            folders,
            splitIds,
            splitParents,
            splitWs,
            scope: {
              matchTab: (t, groupId) =>
                !groupId && !t.zenEssential && !t.pinned && (t.zenWorkspace || null) === uuid,
              matchSplit: (parent, ws, sampleTab) =>
                !parent && ws === uuid && !splitPinned.get(sampleTab.groupId),
              matchFolder: () => false,
            },
          }),
        },
      });
    }

    for (const folder of folders) {
      const fid = folder.id;
      let live = null;
      if (folder.isLiveFolder) {
        try {
          live = ZenSyncModules.ZenLiveFoldersManager?.getSyncableFolderData(fid) ?? null;
        } catch (e) {
          console.error("ZenSidebarSync: failed to project live folder", e);
        }
        if (!live) {
          pending.add(fid);
          continue;
        }
      }
      map.set(fid, {
        kind: RECORD_KINDS.FOLDER,
        data: {
          folderId: fid,
          name: folder.name ?? "",
          // Filtered at projection so every device projects the same value
          // (an apply-side-only filter would diverge digests and ping-pong).
          icon: syncableIconUrl(folder.userIcon || "") || null,
          workspaceUuid: folder.workspaceId || null,
          parentFolderId: folder.parentId || null,
          live,
          children: this.#childSequence({
            tabs,
            folders,
            splitIds,
            splitParents,
            splitWs,
            scope: {
              matchTab: (t, groupId) => groupId === fid,
              matchSplit: (parent) => parent === fid,
              matchFolder: (f) => f.parentId === fid,
            },
          }),
        },
      });
    }

    this.#projectTabs(map, ctx);

    for (const split of splits) {
      map.set(split.groupId, {
        kind: RECORD_KINDS.SPLIT,
        data: {
          splitId: split.groupId,
          gridType: split.gridType || "grid",
          tabs: [...split.tabs],
          workspaceUuid: splitWs.get(split.groupId) ?? null,
          folderId: splitParents.get(split.groupId) || null,
        },
      });
    }

    if (spaces.length) {
      const essentials = {};
      for (const tab of tabs) {
        if (!tab.zenEssential) {
          continue;
        }
        const key = this.guidForContextId(tab.userContextId, { create: true }) || "default";
        (essentials[key] ||= []).push(tab.zenSyncId);
      }
      map.set(LAYOUT_RECORD_ID, {
        kind: RECORD_KINDS.LAYOUT,
        data: {
          spaces: spaces.map((s) => s.uuid).filter(Boolean),
          essentials,
        },
      });
    }

    this.#cache = { stamp, map, pending };
    return map;
  }

  // Ids locally present but deliberately not projected this cycle (tabs
  // without a projectable identity yet, live folders whose provider config
  // isn't loaded). The diff must not read their absence as a deletion.
  pendingIds() {
    this.projections();
    return this.#cache.pending;
  }

  #digestAll() {
    const map = this.projections();
    if (this.#digestCache?.map === map) {
      return this.#digestCache.digests;
    }
    const digests = new Map();
    for (const [id, projected] of map) {
      digests.set(id, recordDigest(projected.kind, projected.data));
    }
    this.#digestCache = { map, digests };
    return digests;
  }

  digestFor(id) {
    return this.#digestAll().get(id) ?? null;
  }

  uploadedDigest(id) {
    return this.#data().uploaded[id]?.d ?? null;
  }

  uploadedKind(id) {
    return this.#data().uploaded[id]?.k ?? null;
  }

  hasUploaded(id) {
    return id in this.#data().uploaded;
  }

  getFullProjection() {
    const out = [];
    for (const [id, projected] of this.projections()) {
      out.push({ id, kind: projected.kind, data: projected.data });
    }
    return out;
  }

  projectRecord(id) {
    return this.projections().get(id) ?? null;
  }

  // Confirms that the local object owning `id` is really gone. This is the
  // R1 invariant: a tombstone may only be emitted for a confirmed-absent
  // id, never because a projection momentarily returned null.
  #confirmAbsent(id, kind) {
    const win = ZenSyncModules.ZenWindowSync?.firstSyncedWindow;
    if (!win) {
      return false;
    }
    try {
      switch (kind) {
        case RECORD_KINDS.LAYOUT:
          return false;
        case RECORD_KINDS.CONTAINER: {
          const mapped = this.contextIdForGuid(id);
          if (mapped === null) {
            return true;
          }
          return !ZenSyncModules.ContextualIdentityService?.getPublicIdentityFromId(mapped);
        }
        case RECORD_KINDS.SPACE:
          return !win.gZenWorkspaces.getWorkspaces().some((s) => s.uuid === id);
        default:
          // tab / folder / split / unknown: the record id is the DOM id.
          return !win.document.getElementById(id);
      }
    } catch (e) {
      return false;
    }
  }

  /**
   * Diff between current projections and the uploaded baseline.
   * Returns { changed: [{id, kind, data}], deleted: [ids] }.
   * Held ids (pending navigation) and pending ids are excluded; deletions
   * require confirmed local absence.
   */
  computeChanges() {
    const uploaded = this.#data().uploaded;
    const holds = this.#data().holds;
    const map = this.projections();
    const digests = this.#digestAll();
    const pending = this.pendingIds();

    const changed = [];
    for (const [id, digest] of digests) {
      if (id in holds) {
        continue;
      }
      if (uploaded[id]?.d !== digest) {
        const projected = map.get(id);
        changed.push({ id, kind: projected.kind, data: projected.data });
      }
    }

    const deleted = [];
    for (const [id, entry] of Object.entries(uploaded)) {
      if (map.has(id) || pending.has(id)) {
        continue;
      }
      if (this.#confirmAbsent(id, entry.k)) {
        deleted.push(id);
      }
    }
    return { changed, deleted };
  }

  // After the server acknowledged an upload: remember exactly what it now
  // holds. The baseline is computed from the SENT payload, never from the
  // ack-time projection — a tab closed (or navigated) while its upload was
  // in flight must keep its baseline entry, or its tombstone (or update)
  // could never be emitted and the server would hold a ghost record.
  markUploaded({ records = [], deleted = [] }) {
    const data = this.#data();
    for (const record of records) {
      if (!record?.id) {
        continue;
      }
      data.uploaded[record.id] = { d: recordDigest(record.kind, record.data), k: record.kind };
    }
    for (const id of deleted) {
      delete data.uploaded[id];
    }
    this.#file.saveSoon();
  }

  // After an incoming record was applied locally: store the INCOMING digest
  // as the uploaded state. A faithful local materialization produces no
  // re-upload; a divergent one re-uploads local truth (self-healing).
  noteApplied(id, cleartext) {
    const data = this.#data();
    if (!cleartext) {
      delete data.uploaded[id];
    } else {
      data.uploaded[id] = { d: recordDigest(cleartext.kind, cleartext.data), k: cleartext.kind };
    }
    this.#file.saveSoon();
  }

  // Wipes the uploaded snapshot (e.g. server generation change accepted by
  // the user). Container mappings and holds survive — they describe this
  // profile, not the server.
  resetBaseline() {
    const data = this.#data();
    data.uploaded = {};
    delete data.generation;
    this.#file.saveSoon();
  }

  uploadedIds() {
    return Object.keys(this.#data().uploaded);
  }
}

// Exported into the shared experiment scope. The explicit `this.*`
// assignments guarantee the exports land on the loadSubScript target
// object regardless of how top-level `var` binds under non-syntactic
// scopes.
var ZenSyncModel = new ZenSyncModelImpl();
var ZenSyncModelStatics = {
  RECORD_KINDS,
  LAYOUT_RECORD_ID,
  canonicalJSON,
  recordDigest,
  syncableIconUrl,
  isSyncableUrl,
  modules: ZenSyncModules,
};
this.ZenSyncModel = ZenSyncModel;
this.ZenSyncModelStatics = ZenSyncModelStatics;
