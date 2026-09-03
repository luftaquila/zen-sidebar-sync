/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Capture side of the sync engine: listens to the chrome events Zen itself
 * replicates across windows, forces session collections so the sidebar
 * snapshot stays fresh, and turns each fresh collection into a digest diff
 * emitted to the background script.
 *
 * Echo prevention is stateless: a capture triggered by our own applier's
 * mutations re-projects state whose digests match the noteApplied baseline
 * and emits nothing. Event bookkeeping here is only noise reduction.
 */

/* eslint-env mozilla-chrome */
/* global ChromeUtils, Services, ZenSyncModel, ZenSyncModelStatics, ZenSyncApplier */

"use strict";

const { setTimeout: zenSyncSetTimeout, clearTimeout: zenSyncClearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

// The events Zen's own window sync replicates (ZenWindowSync EVENTS), plus
// space/folder-level signals and TabAttrModified for load-settled titles.
const ZEN_SYNC_WINDOW_EVENTS = [
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabPinned",
  "TabUnpinned",
  "TabAddedToEssentials",
  "TabRemovedFromEssentials",
  "TabUngrouped",
  "TabGrouped",
  "TabGroupUpdate",
  "TabGroupCreate",
  "TabGroupRemoved",
  "TabGroupMoved",
  "ZenTabIconChanged",
  "ZenTabLabelChanged",
  "ZenTabRemovedFromSplit",
  "ZenSplitViewTabsSplit",
  "ZenWorkspaceDataChanged",
  "ZenWorkspacesUIUpdate",
  "ZenFolderRenamed",
  "ZenFolderChangedWorkspace",
  "TabAttrModified",
];

const ZEN_SYNC_OBS_TOPICS = [
  "zen-sidebar-data-collected",
  "contextual-identity-created",
  "contextual-identity-updated",
  "contextual-identity-deleted",
];

const DEBOUNCE_MS = 500;
const FORCED_SAVE_MIN_INTERVAL_MS = 3000;

var ZenSyncEvents = new (class {
  #started = false;
  #ready = false;
  #shuttingDown = false;
  #onRecordsChanged = null;
  #onEnvironmentChanged = null;
  #debounceTimer = null;
  #trailingSaveTimer = null;
  #lastForcedSave = 0;
  #attachedWindows = new WeakSet();
  #wwObserver = null;
  #prefObserver = null;
  #lastGuard = null;

  get #mods() {
    return ZenSyncModelStatics.modules;
  }

  /* Mark: capability probe */

  // Fails closed: when any dependency is missing, both capture and apply
  // stay disabled (a capture-only mode would upload wrong projections).
  probe() {
    const missing = [];
    const mods = this.#mods;
    if (!mods.ZenSessionStore?.getSidebarData) missing.push("ZenSessionStore.getSidebarData");
    if (!mods.ZenWindowSync) missing.push("ZenWindowSync");
    if (mods.ZenWindowSync && typeof mods.ZenWindowSync.setPinnedInitialState !== "function") {
      missing.push("ZenWindowSync.setPinnedInitialState");
    }
    if (mods.ZenWindowSync && typeof mods.ZenWindowSync.on_TabOpen !== "function") {
      missing.push("ZenWindowSync.on_TabOpen");
    }
    if (!mods.SessionSaver?.run) missing.push("SessionSaver.run");
    if (!mods.E10SUtils) missing.push("E10SUtils");
    if (!mods.JSONFile) missing.push("JSONFile");
    if (!mods.ContextualIdentityService) missing.push("ContextualIdentityService");

    const win = this.anyBrowserWindow();
    if (win) {
      const checks = [
        ["gZenWorkspaces.getWorkspaces", win.gZenWorkspaces?.getWorkspaces],
        ["gZenWorkspaces.allStoredTabs", win.gZenWorkspaces && "allStoredTabs" in win.gZenWorkspaces],
        ["gZenWorkspaces.propagateWorkspaces", win.gZenWorkspaces?.propagateWorkspaces],
        ["gZenWorkspaces.moveTabToWorkspace", win.gZenWorkspaces?.moveTabToWorkspace],
        ["gZenWorkspaces.workspaceElement", win.gZenWorkspaces?.workspaceElement],
        ["gZenWorkspaces.removeWorkspace", win.gZenWorkspaces?.removeWorkspace],
        ["gZenFolders.createFolder", win.gZenFolders?.createFolder],
        ["gZenFolders.setFolderUserIcon", win.gZenFolders?.setFolderUserIcon],
        ["gZenPinnedTabManager.addToEssentials", win.gZenPinnedTabManager?.addToEssentials],
        ["gZenPinnedTabManager.removeEssentials", win.gZenPinnedTabManager?.removeEssentials],
        ["gBrowser.addTrustedTab", win.gBrowser?.addTrustedTab],
        ["gBrowser.pinTab", win.gBrowser?.pinTab],
        ["SessionStore.getTabState", win.SessionStore?.getTabState],
      ];
      for (const [name, value] of checks) {
        if (!value) {
          missing.push(name);
        }
      }
      // zenHandleTabMove is optional (the applier falls back to raw moves)
      // but worth surfacing.
      if (typeof win.gBrowser?.zenHandleTabMove !== "function") {
        missing.push("gBrowser.zenHandleTabMove (optional)");
      }
    } else {
      missing.push("no browser window yet");
    }
    const compatible = !missing.some((m) => !m.includes("(optional)"));
    return { compatible, missing };
  }

  anyBrowserWindow() {
    return Services.wm.getMostRecentWindow("navigator:browser");
  }

  getEnvironment() {
    let spacesEngineEnabled = false;
    let fxaConfigured = false;
    try {
      spacesEngineEnabled = Services.prefs.getBoolPref("services.sync.engine.spaces", false);
    } catch (e) {}
    try {
      fxaConfigured = !!Services.prefs.getStringPref("services.sync.username", "");
    } catch (e) {}
    const probe = this.probe();
    return {
      spacesEngineEnabled,
      fxaConfigured,
      hostName: this.#hostName(),
      zenVersion: Services.appinfo.version,
      compatible: probe.compatible,
      missing: probe.missing,
      ready: this.#ready,
      guardSuppressed: this.#lastGuard,
      provision: this.#readProvision(),
    };
  }

  // Headless provisioning via about:config / user.js — lets a fresh profile
  // connect without touching the popup (multi-device setup, E2E automation).
  //   extensions.zenSidebarSync.serverUrl   (string)
  //   extensions.zenSidebarSync.token       (string)
  //   extensions.zenSidebarSync.deviceName  (string, optional)
  //   extensions.zenSidebarSync.enabled     (bool, connect on startup)
  //   extensions.zenSidebarSync.autoInitial ("push" | "replace", optional:
  //     answers the initial-sync direction prompt automatically)
  #readProvision() {
    const provision = {};
    const read = (key, pref) => {
      try {
        const v = Services.prefs.getStringPref(pref, "");
        if (v) provision[key] = v;
      } catch (e) {}
    };
    read("invite", "extensions.zenSidebarSync.invite");
    read("serverUrl", "extensions.zenSidebarSync.serverUrl");
    read("token", "extensions.zenSidebarSync.token");
    read("deviceName", "extensions.zenSidebarSync.deviceName");
    read("autoInitial", "extensions.zenSidebarSync.autoInitial");
    try {
      provision.enabled = Services.prefs.getBoolPref("extensions.zenSidebarSync.enabled", false);
    } catch (e) {}
    return provision;
  }

  setSpacesEnginePref(value) {
    Services.prefs.setBoolPref("services.sync.engine.spaces", !!value);
  }

  // Machine name, so a new device names itself instead of asking the user.
  #hostName() {
    try {
      const env = Cc["@mozilla.org/process/environment;1"]?.getService(Ci.nsIEnvironment);
      for (const key of ["HOSTNAME", "COMPUTERNAME", "HOST"]) {
        const value = env?.get(key);
        if (value) {
          return value.replace(/\.local$/, "");
        }
      }
    } catch (e) {}
    try {
      const sysInfo = Services.sysinfo;
      const host = sysInfo.getProperty("host");
      if (host) {
        return String(host).replace(/\.local$/, "");
      }
    } catch (e) {}
    return "";
  }

  /* Mark: lifecycle */

  async start({ onRecordsChanged, onEnvironmentChanged }) {
    if (this.#started) {
      this.#onRecordsChanged = onRecordsChanged;
      this.#onEnvironmentChanged = onEnvironmentChanged;
      return this.getEnvironment();
    }
    this.#started = true;
    this.#onRecordsChanged = onRecordsChanged;
    this.#onEnvironmentChanged = onEnvironmentChanged;

    for (const topic of ZEN_SYNC_OBS_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
    Services.obs.addObserver(this, "quit-application-granted");

    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.#attachWindow(win);
    }
    this.#wwObserver = (subject, topic) => {
      if (topic !== "domwindowopened") {
        return;
      }
      subject.addEventListener(
        "load",
        () => {
          if (subject.document.documentElement.getAttribute("windowtype") === "navigator:browser") {
            this.#attachWindow(subject);
          }
        },
        { once: true }
      );
    };
    Services.ww.registerNotification(this.#wwObserver);

    this.#prefObserver = {
      observe: () => {
        try {
          this.#onEnvironmentChanged?.(this.getEnvironment());
        } catch (e) {}
      },
    };
    Services.prefs.addObserver("services.sync.engine.spaces", this.#prefObserver);

    await this.#awaitReady();
    this.#ready = true;

    // Force one fresh collection so the first diff runs against live data.
    this.forceCapture();
    return this.getEnvironment();
  }

  stop() {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    this.#ready = false;
    zenSyncClearTimeout(this.#debounceTimer);
    zenSyncClearTimeout(this.#trailingSaveTimer);
    for (const topic of ZEN_SYNC_OBS_TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (e) {}
    }
    try {
      Services.obs.removeObserver(this, "quit-application-granted");
    } catch (e) {}
    if (this.#wwObserver) {
      try {
        Services.ww.unregisterNotification(this.#wwObserver);
      } catch (e) {}
      this.#wwObserver = null;
    }
    if (this.#prefObserver) {
      try {
        Services.prefs.removeObserver("services.sync.engine.spaces", this.#prefObserver);
      } catch (e) {}
      this.#prefObserver = null;
    }
    this.#onRecordsChanged = null;
    this.#onEnvironmentChanged = null;
  }

  // First-upload gate (mass-deletion protection at startup): everything
  // must be fully restored before the first diff, or a half-restored
  // sidebar reads as "the user closed most tabs".
  async #awaitReady() {
    try {
      const { SessionStore } = ChromeUtils.importESModule(
        "resource:///modules/sessionstore/SessionStore.sys.mjs"
      );
      await (SessionStore.promiseAllWindowsRestored || SessionStore.promiseInitialized);
    } catch (e) {}
    // Wait for a synced (non-private, non-popup) window with Zen ready.
    for (let i = 0; i < 120; i++) {
      const win = this.#mods.ZenWindowSync?.firstSyncedWindow;
      if (win?.gZenWorkspaces) {
        try {
          await win.gZenWorkspaces.promiseInitialized;
        } catch (e) {}
        return;
      }
      await new Promise((resolve) => zenSyncSetTimeout(resolve, 500));
    }
  }

  #attachWindow(win) {
    if (this.#attachedWindows.has(win)) {
      return;
    }
    this.#attachedWindows.add(win);
    // A sandbox function handed to a chrome window's addEventListener gets
    // Xray-wrapped into something the DOM can't call ("Property
    // 'handleEvent' is not callable") — export it into the window's
    // compartment first.
    let listener = (event) => this.#onWindowEvent(event);
    let unloadListener = () => {
      for (const name of ZEN_SYNC_WINDOW_EVENTS) {
        try {
          win.removeEventListener(name, listener, true);
        } catch (e) {}
      }
    };
    try {
      const cu = typeof Cu !== "undefined" ? Cu : Components.utils;
      if (cu?.exportFunction) {
        listener = cu.exportFunction(listener, win);
        unloadListener = cu.exportFunction(unloadListener, win);
      }
    } catch (e) {}
    for (const name of ZEN_SYNC_WINDOW_EVENTS) {
      win.addEventListener(name, listener, true);
    }
    win.addEventListener("unload", unloadListener, { once: true });
    this.#diag(`attached ${ZEN_SYNC_WINDOW_EVENTS.length} listeners to window`);
  }

  /* Mark: capture scheduling */

  // Low-frequency status lines on the Services.console channel (readable
  // via Marionette / Browser Console) — background console.log never
  // reaches Services.console.
  #diag(msg) {
    try {
      Services.console.logStringMessage(`[ZenSidebarSync] ${msg}`);
    } catch (e) {}
  }

  #lastEventAt = 0;

  #onWindowEvent(event) {
    this.#lastEventAt = Date.now();
    if (!this.#started || this.#shuttingDown) {
      return;
    }
    if (event.type === "TabAttrModified") {
      // Fires constantly during page loads; only the identity-relevant
      // attribute changes are capture triggers. detail crosses from the
      // chrome compartment — waive Xrays so array methods work.
      let changed = null;
      try {
        const cu = typeof Cu !== "undefined" ? Cu : Components.utils;
        changed = cu.waiveXrays(event.detail)?.changed;
      } catch (e) {
        changed = event.detail?.changed;
      }
      if (!changed || ![...changed].some((c) => c === "label" || c === "image" || c === "pending")) {
        return;
      }
    }
    this.scheduleCapture();
  }

  scheduleCapture() {
    zenSyncClearTimeout(this.#debounceTimer);
    this.#debounceTimer = zenSyncSetTimeout(() => this.#requestSave(), DEBOUNCE_MS);
  }

  // Forces a session collection, rate-limited. The collection fires
  // zen-sidebar-data-collected, which is where the diff actually runs.
  #requestSave() {
    if (!this.#started || this.#shuttingDown) {
      return;
    }
    if (ZenSyncApplier.isApplying) {
      // The applier ends with its own SessionSaver.runDelayed(); a forced
      // save mid-apply would diff half-applied state.
      zenSyncClearTimeout(this.#trailingSaveTimer);
      this.#trailingSaveTimer = zenSyncSetTimeout(() => this.#requestSave(), FORCED_SAVE_MIN_INTERVAL_MS);
      return;
    }
    const now = Date.now();
    const since = now - this.#lastForcedSave;
    if (since < FORCED_SAVE_MIN_INTERVAL_MS) {
      zenSyncClearTimeout(this.#trailingSaveTimer);
      this.#trailingSaveTimer = zenSyncSetTimeout(
        () => this.#requestSave(),
        FORCED_SAVE_MIN_INTERVAL_MS - since
      );
      return;
    }
    this.#lastForcedSave = now;
    this.#flushAndSave();
  }

  // A freshly opened (eager) tab has no TabState in the parent cache until
  // its first content flush — a forced collection before that simply omits
  // the tab. Flush every browser window first (the same pattern Zen's
  // setPinnedTabState uses), then collect.
  async #flushAndSave() {
    try {
      if (this.#mods.TabStateFlusher) {
        const flushes = [];
        for (const win of Services.wm.getEnumerator("navigator:browser")) {
          try {
            flushes.push(this.#mods.TabStateFlusher.flushWindow(win));
          } catch (e) {}
        }
        await Promise.all(flushes);
      }
    } catch (e) {}
    if (!this.#started || this.#shuttingDown) {
      return;
    }
    try {
      this.#mods.SessionSaver.run();
    } catch (e) {
      this.#diag(`forced session save FAILED: ${e?.message || e}`);
    }
  }

  forceCapture() {
    this.#lastForcedSave = 0;
    this.#requestSave();
  }

  /* Mark: observer */

  observe(subject, topic) {
    if (topic === "quit-application-granted") {
      this.#shuttingDown = true;
      zenSyncClearTimeout(this.#debounceTimer);
      zenSyncClearTimeout(this.#trailingSaveTimer);
      return;
    }
    if (!this.#started || this.#shuttingDown || !this.#ready) {
      return;
    }
    if (topic === "zen-sidebar-data-collected") {
      this.#onCollected();
      return;
    }
    // contextual-identity-*: containers have no window event; schedule.
    this.scheduleCapture();
  }

  #lastPendingKey = "";
  #emptyDiffRetried = false;

  #onCollected() {
    if (ZenSyncApplier.isApplying) {
      // A natural session save landed mid-apply; the applier's trailing
      // runDelayed() produces the collection this diff should run on.
      return;
    }
    try {
      ZenSyncModel.invalidate();
      ZenSyncApplier.processHolds();

      // A tab mid-load can miss its session entries in this collection and
      // sit in the pending set (correct: never a deletion). Schedule ONE
      // follow-up forced collection per distinct pending set so a freshly
      // opened tab surfaces within seconds instead of waiting out the
      // 15s session-save interval. A pending set that doesn't change stops
      // retrying (permanently unprojectable tabs must not spin saves).
      const pending = ZenSyncModel.pendingIds();
      const pendingKey = [...pending].sort().join(",");
      if (pending.size && pendingKey !== this.#lastPendingKey) {
        this.scheduleCapture();
      }
      this.#lastPendingKey = pendingKey;

      const { changed, deleted } = ZenSyncModel.computeChanges();
      if (changed.length || deleted.length) {
        this.#diag(`diff: changed=${changed.length} deleted=${deleted.length} pending=${pending.size}`);
      }
      if (!changed.length && !deleted.length) {
        // A collection triggered right after a burst of tab events can miss
        // the change (session data for a brand-new tab lands a beat later).
        // Retry once per quiet stretch so propagation doesn't wait out the
        // 15s session-save interval.
        if (Date.now() - this.#lastEventAt < 5000 && !this.#emptyDiffRetried) {
          this.#emptyDiffRetried = true;
          this.#diag("empty diff right after events — scheduling one retry");
          this.scheduleCapture();
        }
        this.#lastGuard = null;
        return;
      }
      this.#emptyDiffRetried = false;

      // Outbound catastrophic-capture guard (kept from v2): a projection
      // that lost nearly every previously-synced tab is a transient
      // failure, not a mass close.
      const uploadedTabCount = ZenSyncModel.uploadedIds().filter(
        (id) => ZenSyncModel.uploadedKind(id) === ZenSyncModelStatics.RECORD_KINDS.TAB
      ).length;
      let currentTabCount = 0;
      for (const [, projected] of ZenSyncModel.projections()) {
        if (projected.kind === ZenSyncModelStatics.RECORD_KINDS.TAB) {
          currentTabCount++;
        }
      }
      if (uploadedTabCount > 30 && currentTabCount < uploadedTabCount * 0.1) {
        this.#lastGuard = { uploadedTabCount, currentTabCount };
        console.warn(
          `ZenSidebarSync: capture guard held an emit (${currentTabCount}/${uploadedTabCount} tabs)`
        );
        return;
      }
      this.#lastGuard = null;
      this.#onRecordsChanged?.({ changed, deleted });
    } catch (e) {
      console.error("ZenSidebarSync: capture diff failed:", e);
    }
  }
})();

this.ZenSyncEvents = ZenSyncEvents;
