/* eslint-env mozilla-chrome */
/* global ExtensionAPI, ExtensionCommon, Services, ChromeUtils */

"use strict";

/*
 * zenInternals experiment API — glue between the background script and the
 * chrome-side sync engine. The engine itself lives in three sub-scripts
 * loaded into a shared scope:
 *   sync-model.js    projection / digest baseline / container GUID map
 *                    (port of Zen's ZenSpacesSyncModel, extended for
 *                    regular tabs)
 *   sync-applier.js  applies incoming records to the live browser
 *                    (port of Zen's ZenSpacesSyncApplier)
 *   sync-events.js   event listeners + capture scheduling + diff emission
 *
 * Identity model: record ids are Zen's own ids verbatim — tab `zenSyncId`
 * (= DOM id, persisted in session state), folder DOM id, space uuid, split
 * groupId; containers map through per-profile GUIDs. No hashing, no
 * identity maps: `document.getElementById(id)` resolves every record.
 */

this.zenInternals = class extends ExtensionAPI {
  onStartup() {}

  onShutdown() {
    try {
      this._scope?.ZenSyncEvents?.stop();
    } catch (e) {}
  }

  #ensureEngine() {
    if (this._scope) {
      return this._scope;
    }
    const scope = {};
    const base = this.extension.rootURI.resolve("experiments/zenInternals/");
    for (const file of ["sync-model.js", "sync-applier.js", "sync-events.js"]) {
      Services.scriptloader.loadSubScript(base + file, scope);
    }
    this._scope = scope;
    return scope;
  }

  getAPI(context) {
    const api = this;
    const { EventManager } =
      typeof ExtensionCommon !== "undefined"
        ? ExtensionCommon
        : ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;

    const recordListeners = new Set();
    const environmentListeners = new Set();

    const dispatchRecords = (payload) => {
      for (const listener of recordListeners) {
        try {
          listener(payload);
        } catch (e) {}
      }
    };
    const dispatchEnvironment = (payload) => {
      for (const listener of environmentListeners) {
        try {
          listener(payload);
        } catch (e) {}
      }
    };

    return {
      zenInternals: {
        // --- Engine lifecycle ---

        async start() {
          const scope = api.#ensureEngine();
          try {
            return await scope.ZenSyncEvents.start({
              onRecordsChanged: dispatchRecords,
              onEnvironmentChanged: dispatchEnvironment,
            });
          } catch (e) {
            return { compatible: false, missing: [`start failed: ${e?.message || e}`] };
          }
        },

        async stop() {
          try {
            api.#ensureEngine().ZenSyncEvents.stop();
          } catch (e) {}
        },

        async getEnvironment() {
          try {
            return api.#ensureEngine().ZenSyncEvents.getEnvironment();
          } catch (e) {
            return { compatible: false, missing: [`getEnvironment failed: ${e?.message || e}`] };
          }
        },

        async setSpacesEnginePref(enabled) {
          try {
            api.#ensureEngine().ZenSyncEvents.setSpacesEnginePref(enabled);
            return { success: true };
          } catch (e) {
            return { success: false, error: e?.message || String(e) };
          }
        },

        // --- Capture / diff ---

        async getFullProjection() {
          try {
            const scope = api.#ensureEngine();
            scope.ZenSyncModel.invalidate();
            return scope.ZenSyncModel.getFullProjection();
          } catch (e) {
            console.error("ZenSidebarSync: getFullProjection failed:", e);
            return null;
          }
        },

        async computeLocalChanges() {
          try {
            const scope = api.#ensureEngine();
            scope.ZenSyncModel.invalidate();
            return scope.ZenSyncModel.computeChanges();
          } catch (e) {
            return { changed: [], deleted: [], error: e?.message || String(e) };
          }
        },

        async forceCapture() {
          try {
            api.#ensureEngine().ZenSyncEvents.forceCapture();
            return { success: true };
          } catch (e) {
            return { success: false, error: e?.message || String(e) };
          }
        },

        async getCounts() {
          try {
            const scope = api.#ensureEngine();
            const KINDS = scope.ZenSyncModelStatics.RECORD_KINDS;
            scope.ZenSyncModel.invalidate();
            const counts = { spaces: 0, folders: 0, essentials: 0, pinned: 0, normal: 0, splits: 0 };
            for (const [, projected] of scope.ZenSyncModel.projections()) {
              switch (projected.kind) {
                case KINDS.SPACE:
                  counts.spaces++;
                  break;
                case KINDS.FOLDER:
                  counts.folders++;
                  break;
                case KINDS.SPLIT:
                  counts.splits++;
                  break;
                case KINDS.TAB:
                  if (projected.data.essential) counts.essentials++;
                  else if (projected.data.pinned) counts.pinned++;
                  else counts.normal++;
                  break;
              }
            }
            return counts;
          } catch (e) {
            return null;
          }
        },

        // --- Apply ---

        async applyRecords({ records, deleted, reconcile, overrideGuard }) {
          try {
            const scope = api.#ensureEngine();
            return await scope.ZenSyncApplier.apply(records || [], deleted || [], {
              reconcile: !!reconcile,
              overrideGuard: !!overrideGuard,
            });
          } catch (e) {
            console.error("ZenSidebarSync: applyRecords failed:", e);
            return {
              failed: (records || []).map((r) => r.id).concat(deleted || []),
              guard: null,
              error: e?.message || String(e),
            };
          }
        },

        // Reconnect path: applies the server's full record set on top of
        // local state while preserving offline work.
        //  - a record we deleted offline (absent locally, uploaded digest
        //    identical to the server's) is NOT re-applied; the next diff
        //    pushes its deletion
        //  - an id we uploaded before that the server no longer has was
        //    deleted remotely while we were offline → delete locally
        //  - everything else applies; local divergence re-uploads through
        //    the digest diff afterwards (self-heal)
        async reconnectMerge({ records, overrideGuard }) {
          try {
            const scope = api.#ensureEngine();
            const model = scope.ZenSyncModel;
            const statics = scope.ZenSyncModelStatics;
            model.invalidate();

            const local = model.computeChanges();
            const locallyDeleted = new Set(local.deleted);

            const toApply = [];
            for (const record of records || []) {
              if (!record?.id) {
                continue;
              }
              if (locallyDeleted.has(record.id)) {
                const incomingDigest = statics.recordDigest(record.kind, record.data);
                if (model.uploadedDigest(record.id) === incomingDigest) {
                  // We deleted exactly this synced content offline.
                  continue;
                }
              }
              toApply.push(record);
            }

            const serverIds = new Set((records || []).map((r) => r.id));
            const remoteDeleted = [];
            for (const id of model.uploadedIds()) {
              if (!serverIds.has(id) && !locallyDeleted.has(id)) {
                remoteDeleted.push(id);
              }
            }

            const result = await scope.ZenSyncApplier.apply(toApply, remoteDeleted, {
              overrideGuard: !!overrideGuard,
            });
            return { failed: result.failed, guard: result.guard };
          } catch (e) {
            console.error("ZenSidebarSync: reconnectMerge failed:", e);
            // Report every id as failed so the orchestrator's retry fires —
            // a silent empty result would leave a half-merged baseline.
            return {
              failed: (records || []).map((r) => r.id),
              guard: null,
              error: e?.message || String(e),
            };
          }
        },

        // --- Baseline bookkeeping ---

        async markUploaded({ records, deleted }) {
          try {
            api.#ensureEngine().ZenSyncModel.markUploaded({ records: records || [], deleted: deleted || [] });
            return { success: true };
          } catch (e) {
            return { success: false, error: e?.message || String(e) };
          }
        },

        async getGeneration() {
          try {
            return api.#ensureEngine().ZenSyncModel.getGeneration();
          } catch (e) {
            return null;
          }
        },

        async setGeneration(generation) {
          try {
            api.#ensureEngine().ZenSyncModel.setGeneration(generation);
            return { success: true };
          } catch (e) {
            return { success: false, error: e?.message || String(e) };
          }
        },

        async resetBaseline() {
          try {
            api.#ensureEngine().ZenSyncModel.resetBaseline();
            return { success: true };
          } catch (e) {
            return { success: false, error: e?.message || String(e) };
          }
        },

        // --- Diagnostics ---

        // Chrome-side console channel (background console.log doesn't reach
        // Services.console); kept for Marionette-driven log inspection.
        async log(msg) {
          try {
            Services.console.logStringMessage(`[ZenSidebarSync] ${msg}`);
          } catch (e) {}
          return { success: true };
        },

        // --- Events ---

        onRecordsChanged: new EventManager({
          context,
          name: "zenInternals.onRecordsChanged",
          register: (fire) => {
            const listener = (payload) => fire.async(payload).catch(() => {});
            recordListeners.add(listener);
            return () => {
              recordListeners.delete(listener);
            };
          },
        }).api(),

        onEnvironmentChanged: new EventManager({
          context,
          name: "zenInternals.onEnvironmentChanged",
          register: (fire) => {
            const listener = (payload) => fire.async(payload).catch(() => {});
            environmentListeners.add(listener);
            return () => {
              environmentListeners.delete(listener);
            };
          },
        }).api(),
      },
    };
  }
};
