# CLAUDE.md

## Project

Zen Browser sidebar sync extension + WebSocket sync server. Syncs essentials, workspaces, and open tabs in real-time across devices.

## Structure

- `extension/` — Firefox WebExtension (Manifest V2, targets Zen Browser / Gecko 115+)
  - `background/` — ES modules loaded via background page
    - `main.js` — orchestrator, wires TabMonitor ↔ SyncClient ↔ TabApplier
    - `tab-monitor.js` — captures browser tab state via native messaging, computes diffs
    - `sync-client.js` — WebSocket client with reconnect/auth
    - `tab-applier.js` — applies remote state to local browser (additive on initial, full reconciliation after)
  - `popup/` — settings UI (vanilla HTML/CSS/JS)
  - `native/` — native messaging host for reading Zen's session store
    - `zen_sidebar_native.py` — pure Python host (no external deps, built-in LZ4 decompressor)
    - `zen_sidebar_native.bat` — Windows wrapper (Windows can't exec .py directly)
    - `install.sh` — Linux/macOS installer
    - `install.ps1` — Windows installer (PowerShell, registers in Windows Registry)
  - `experiments/zenInternals/` — WebExtension experiment API (chrome-context access)
    - `api.js` — wraps `gZenWorkspaces`, `gZenFolders`, `gZenPinnedTabManager`, `gBrowser` for workspace/folder/tab CRUD and transitions. Verified call shapes documented inline.
    - `schema.json` — experiment API schema definition
    - Requires `extensions.experiments.enabled = true` in `about:config`
- `server/` — Node.js WebSocket server (ESM, single file, `ws` library)
  - Stores state in `sync-state.json`, token hashes in `tokens.json` under `DATA_DIR` (default: `__dirname`)
  - Container runs as non-root `app` user, data in `/data` volume
- `.github/workflows/container.yml` — builds multi-arch image on push to `main` (only triggers on `server/**` changes) and pushes to `ghcr.io/luftaquila/zen-sidebar-sync`
- `.github/workflows/extension.yml` — builds `.xpi` on push to `main` and uploads as workflow artifact
- `compose.yml` — works with both `docker compose` and `podman-compose`

## State schema (v2)

Server and extension share `schemaVersion: 2`. The shape is a flat tab model:

```
{
  schemaVersion: 2, version, lastModified,
  workspaces: [{ syncId, name, icon, position, lastModified }],
  folders:    [{ syncId, name, workspaceSyncId, parentSyncId, collapsed, userIcon, position, lastModified }],
  tabs: [{
    syncId, url, title, icon,
    kind: 'essential' | 'pinned' | 'normal',
    workspaceSyncId,                // null only when kind='essential' AND no home space
    folderSyncId,                   // null when not in folder; valid only when kind='pinned'
    pinned, position, lastModified,
  }]
}
```

SyncId rules (deterministic hashes):
- workspace: `ws-<hash(name)>` — rename = remove+add cycle
- folder:    `fld-<hash(workspaceSyncId + ":" + path)>` where path is the slash-separated folder name chain from root
- tab:       `tab-<hash(url)>`

The patch op set: `add/remove/update` × `workspace/folder/tab`. Every transition (essential↔pinned↔normal, workspace move, folder move, pin/unpin) is a single `update_tab` with the changed property in `changes`.

## Key design decisions

- Initial connect merges additively (`addOnly=true`). After initial sync, all changes propagate bidirectionally including tab closes.
- Empty remote state triggers addOnly mode to prevent accidental mass tab deletion.
- **Native messaging host** reads Zen's internal session store files because `browser.tabs.query({})` in Zen 1.8b+ only returns active workspace tabs. The host reads `recovery.jsonlz4` (per-tab zenWorkspace/zenEssential/pinned/groupId/position) and `zen-sessions.jsonlz4` (workspace definitions, groups, folders). Falls back to browser.sessions API if unavailable (active workspace only, no folders).
- Native data is cached for 5 seconds to avoid spawning Python on every tab event.
- **UUID-shaped workspace names are dropped on capture** (regex guard in `tab-monitor.js`). Tabs anchored to such workspaces are skipped to prevent ghost-workspace propagation.
- All Zen-internal mutations (createWorkspace, moveTab, createFolder, addTabToFolder, setFolderParent, setEssential, …) flow through the experiment API in `experiments/zenInternals/api.js`. Each function is best-effort and returns `{success, error?}`; failures are logged but never abort the apply.
- TabMonitor maintains three local↔sync identity maps: `workspaceUuidBySyncId` (workspace name → Zen UUID), `folderLocalIdBySyncId` (folder syncId → DOM id), `folderSyncIdByLocalId` (reverse). These are rebuilt every capture and used by the applier to find local resources.
- Apply order on full state: workspaces → tabs → folders (topologically sorted by `parentSyncId`) → tab→folder membership → removal pass.
- Apply order on patch: ops sorted by `opPriority` (workspace add → folder add → tab add → tab update → tab remove → folder remove → workspace remove).
- Workspace syncIds are name-based (not Zen UUID) for cross-device consistency. Folder syncIds incorporate the full path so nested folders with the same name don't collide.
- Server merges by syncId; conflicts resolve by `lastModified` (last write wins per record). The `remove_workspace` op cascades to drop folders/tabs anchored to it; `remove_folder` orphans tabs to top-level pinned (folderSyncId becomes null).
- After every apply (state or patch), `captureFullState({ silent: true, skipGuard: true })` immediately recaptures browser state to prevent stale diffs triggering echo loops. `invalidateCache()` is called first so the recapture sees post-apply data, not the cached snapshot.
- `_applyingCount` counter guards against tab events during apply; recapture runs while guard is still held.
- Debounce of 300ms on tab events before state capture.
- **Apply queue**: `TabApplier` serializes `applyState`/`applyPatch` through a Promise chain so two patches arriving back-to-back (or a force_pull during a patch) don't race and corrupt the maps.
- **Always send patches after initial sync**: large local changes still go as a patch, never as `full_state`. Server's full_state merges by syncId and would not propagate removals, causing stale tab resurrection.
- **`replace` mode** on `full_state`: when the client sets `{replace: true}`, the server replaces state outright instead of merging. Used by `force_push` so the user can declare local state as authoritative.
- **Reconnect path** preserves offline changes: when `auth_ok` arrives while `initialSyncDone=true`, the orchestrator does an additive merge of remote state then pushes local state. A full reconciliation would otherwise delete tabs opened during the disconnect.
- **Capture safety guard**: a capture is rejected only when the previous state had >30 tabs AND the new state has <10% of that — catastrophic catch-all for transient runtime API failures. Threshold tuned loose so legitimate mass-close operations (user closes many tabs) propagate.
- **Server patch safety guard**: rejects a patch only when current state has >30 items and removals exceed 90% — second line of defense behind the capture guard, equally loose.
- **`remove_tab` schema accepts `{syncUuid}` alone**: the experiment-API schema previously declared `tabUrl` as the only param, so the applier's `removeTab({syncUuid: X})` call from `_applyOp` was rejected with a type error before reaching `resolveTab`. The schema for `removeTab` and `removeTabFromFolder` now declares `tabId`, `tabUrl`, `syncUuid` as optional — matching the `resolveTab` precedence chain.
- **Patch-driven tab reorder**: `_applyPatch` now applies a reorder pass after all ops. Per-bucket (`workspaceSyncId|kind|folderSyncId`) ordering from the incoming patch is applied via `browser.zenInternals.reorderTabsInPlace`. Previously reorder only ran during `_applyState`, so drag-reorders during normal operation never propagated. The patch reorder rebuilds each touched bucket's order from the post-op `tabMonitor.state` plus the patch's own tab objects.
- **`browser.zenInternals.log(msg)`**: cheap chrome-side `Services.console.logStringMessage` channel. Background-script `console.log` doesn't reach `Services.console`, so this helper exists for situations where Marionette-driven log inspection is needed.
- **Transient native-host empty responses** do not permanently disable the native messaging path. Only a connection-level exception flips `_nativeAvailable` to `false`.
- Patch property updates are allowlisted (TAB_PROPS, FOLDER_PROPS, WS_PROPS) to prevent state corruption.
- Only http/https URLs are captured and synced.
- Server writes are debounced (1s) and atomic (write-tmp + rename).
- When docs (README.md, CLAUDE.md) describe behavior affected by a code change, always update them together.

## Known limitations

- **Schema-version mismatch surfaces as `schema_mismatch` status**; reset server state with the command below before re-syncing.
- **Hidden workspace tab removal via browser API**: Removal pass uses experiment API `removeTab({tabUrl})` which iterates `gBrowser.tabs` (all workspaces). Folder deletion likewise uses `gZenFolders` DOM. Both work cross-workspace.
- **Fallback mode (no native host)**: Only active workspace tabs are visible; folders are not captured (empty `folders` array sent to server). Re-installing the native host restores full visibility.
- **Workspace rename = remove+add cycle**: changing a workspace name regenerates its syncId and all dependent folder syncIds. Server-side cascade drops the old workspace's data; the new name's records replace it. Keep renames rare.

## Commands

```bash
# run server
cd server && npm start

# run server in dev mode (auto-reload)
cd server && npm run dev

# run via container (docker or podman)
docker compose up -d    # or: podman-compose up -d

# install native messaging host (required for workspace/essential detection)
# Linux/macOS:
cd extension/native && ./install.sh
# Windows (PowerShell):
cd extension\native; powershell -ExecutionPolicy Bypass -File install.ps1

# reset server sync state (schema v3)
podman exec zen-sync sh -c 'echo "{\"schemaVersion\":3,\"workspaces\":[],\"folders\":[],\"tabs\":[],\"version\":0,\"lastModified\":0}" > /data/sync-state.json'
```

## Conventions

- Extension code uses `browser.*` APIs (Firefox WebExtension).
- Server uses Node.js ESM (`"type": "module"`).
- No build step for the extension — plain ES modules.
- Experiment API code runs in chrome context (privileged), can access `gBrowser`, `gZenFolders`, `gZenWorkspaces`, `Services.*`.
