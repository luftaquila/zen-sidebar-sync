# CLAUDE.md

## Project

Zen Browser sidebar sync extension + WebSocket sync server. Syncs essentials, workspaces, and open tabs in real-time across devices.

## Structure

- `extension/` — Firefox WebExtension (Manifest V2, targets Zen Browser / Gecko 115+)
  - `background/` — ES modules loaded via background page
    - `main.js` — orchestrator, wires TabMonitor ↔ SyncClient ↔ TabApplier
    - `tab-monitor.js` — captures browser tab state (experiment API > native host > browser API), computes diffs
    - `sync-client.js` — WebSocket client with reconnect/auth
    - `tab-applier.js` — applies remote state to local browser (additive on initial, full reconciliation after)
  - `popup/` — settings UI (vanilla HTML/CSS/JS)
  - `native/` — native messaging host for reading Zen's session store
    - `zen_sidebar_native.py` — pure Python host (no external deps, built-in LZ4 decompressor)
    - `zen_sidebar_native.bat` — Windows wrapper (Windows can't exec .py directly)
    - `install.sh` — Linux/macOS installer
    - `install.ps1` — Windows installer (PowerShell, registers in Windows Registry)
  - `experiments/zenInternals/` — WebExtension experiment API (chrome-context access)
    - `api.js` — `createFolder` (with `label`, `workspaceId`, `setFolderUserIcon`), `getFolders`, `getWorkspaces`, `organizeTab` (`addToEssentials`/`moveTabToWorkspace`), `getTabData` (tabs + workspaces + folders from chrome context), `createWorkspace` (`saveWorkspace`), `removeFolder` (`folder.delete()`), `updateFolder` (`folder.name`/`collapsed`/`setFolderUserIcon`)
    - `schema.json` — experiment API schema definition (8 functions)
    - Requires `extensions.experiments.enabled = true` in `about:config`
- `server/` — Node.js WebSocket server (ESM, single file, `ws` library)
  - Stores state in `sync-state.json`, token hashes in `tokens.json` under `DATA_DIR` (default: `__dirname`)
  - Container runs as non-root `app` user, data in `/data` volume
- `.github/workflows/container.yml` — builds multi-arch image on push to `main` (only triggers on `server/**` changes) and pushes to `ghcr.io/luftaquila/zen-sidebar-sync`
- `.github/workflows/extension.yml` — builds `.xpi` on push to `main` and uploads as workflow artifact
- `compose.yml` — works with both `docker compose` and `podman-compose`

## Key design decisions

- Initial connect merges additively (never closes local tabs on first sync).
- After initial sync, all changes propagate bidirectionally including tab closes.
- Empty remote state triggers addOnly mode to prevent accidental mass tab deletion.
- **Tab state data source priority**: (1) Experiment API `getTabData` — reads all tab DOM attributes (`zen-essential`, `zen-workspace-id`) and workspaces directly from chrome context via `gBrowser.tabs`. (2) Native messaging host — reads `recovery.jsonlz4` and `zen-sessions.jsonlz4` session store files. (3) `browser.tabs.query` + `browser.sessions` fallback — limited to active workspace only.
- `browser.tabs.query({})` in Zen 1.8b+ only returns active workspace tabs — hidden workspace tabs are invisible to WebExtension API. Experiment API and native host both see all workspaces.
- Both experiment and native data are cached for 5 seconds to avoid repeated calls on every tab event.
- All workspaces from `zen-sessions.jsonlz4` are pre-populated before tab assignment, so empty workspaces are included in sync state.
- Tab deduplication in both `applyState` and `applyPatch` uses `tabMonitor.state` (native host data, all workspaces) instead of `browser.tabs.query` (active workspace only). Using browser API for dedup causes duplicate tab creation for hidden workspace tabs.
- Tab creation uses experiment API `organizeTab` which calls `gZenPinnedTabManager.addToEssentials(tab)` for essentials and `gZenWorkspaces.moveTabToWorkspace(tab, uuid)` for workspace assignment. These are Zen's internal APIs that handle DOM container moves, UI updates, and event dispatch. Falls back to `browser.sessions.setTabValue` if experiment API unavailable (stores in `extData`, not read by Zen). DOM attributes are kebab-case (`zen-essential`, `zen-workspace-id`), session store serializes as camelCase (`zenEssential`, `zenWorkspace`).
- Folder sync is fully bidirectional: add (`createFolder`), remove (`folder.delete()` — ungroupstabs, doesn't close them), update (`folder.name`, `folder.collapsed`, `setFolderUserIcon`). Diff engine tracks `add_folder`/`remove_folder`/`update_folder` operations. Folder rename appears as remove+add (tabs are ungrouped then regrouped via tabUrls).
- Workspace creation uses `gZenWorkspaces.saveWorkspace({ uuid, name, icon })` via experiment API. Missing workspaces are auto-created when receiving remote state (`_ensureWorkspace` helper). `Services.uuid.generateUUID()` for UUID generation.
- Workspace syncIds are name-based (not Zen UUID) for cross-device consistency. Folder syncIds are also name+workspace based (`fld-hash(name:workspaceName)`) for cross-device matching.
- Folder data includes `tabUrls` array mapping folder → member tab URLs via `groupId`.
- After every apply (state or patch), `captureFullState({ silent: true })` immediately recaptures browser state to prevent stale diffs triggering echo loops.
- `_applyingCount` counter guards against tab events during apply; recapture runs while guard is still held.
- Debounce of 300ms on tab events before state capture.
- Server uses server-side timestamps for merge — client timestamps are ignored to prevent stale overwrites on reconnect.
- Patch property updates are allowlisted (url, title, icon, position, pinned) to prevent state corruption.
- Only http/https URLs are captured and synced.
- SyncIds are URL-based hashes (no timestamp) for stability across extension restarts and cross-device consistency.
- Server writes are debounced (1s) and atomic (write-tmp + rename).
- Always send patches after initial sync — never full_state (server merge is additive and loses removals).
- `force_push` uses `replace: true` to completely replace server state instead of additive merge.
- `add_essential` removes the tab's URL from `byUrl` after promoting, so the paired `remove_tab` (from workspace→essential move) can't find and close it.
- Reconnect (auth_ok while `initialSyncDone=true`) uses additive merge + pushes local state to server, preserving offline changes. Distinguished from broadcasts via `isAuthState` flag from sync-client.
- Folder tab membership changes emit `remove_folder` + `add_folder` instead of `update_folder` (no API to update folder membership in place).
- Cache invalidation (`invalidateCache()`) runs after every apply to prevent stale experiment/native data from generating echo patches.
- Apply operations are queued via promise chain to prevent concurrent `applyState`/`applyPatch` overlap.
- When docs (README.md, CLAUDE.md) describe behavior affected by a code change, always update them together.

## Known limitations

- **Hidden workspace tab removal**: `applyState` step 4 (remove tabs not in remote state) only removes active workspace tabs because `browser.tabs.query` doesn't return hidden ones. Tabs removed from remote state in hidden workspaces become zombies until that workspace is activated.
- **Fallback mode limitations**: Without experiment API or native messaging host, only active workspace tabs are visible. Workspace/folder creation and organization require experiment API — fallback mode can only sync tabs.
- **Folder rename is remove+add**: Folder syncIds are name-based, so renaming a folder produces a remove_folder + add_folder pair. Tabs are ungrouped by `folder.delete()` then regrouped by `createFolder` via URL matching.
- **Folder content change is remove+add**: Adding/removing a tab from a folder emits remove_folder + add_folder. Causes brief visual flicker. No Zen API to update folder membership in place.
- **Pin toggle recreates tab**: Toggling pin state moves a tab between `ws.tabs` and `ws.pinnedTabs`, generating `remove_tab` + `add_tab`. The tab is destroyed and recreated, losing in-page state (scroll position, form data).
- **Workspace deletion incomplete**: No `removeWorkspace` experiment API. Only workspace tabs are removed; the workspace container itself persists on the remote device.
- **Stale resurrection on reconnect**: Additive reconnect merge preserves local items, but items deleted by another device while disconnected are re-added when the reconnecting device pushes its state. Without version-tracked operations, this is inherent.
- **Hash collision risk**: `_hashCode` uses Java's `hashCode` algorithm. Two URLs with the same hash would collide. Unlikely in practice but theoretically possible.

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

# reset server sync state
podman exec zen-sync sh -c 'echo "{\"essentials\":[],\"workspaces\":[],\"groups\":[],\"folders\":[],\"version\":0,\"lastModified\":0}" > /data/sync-state.json'
```

## Conventions

- Extension code uses `browser.*` APIs (Firefox WebExtension).
- Server uses Node.js ESM (`"type": "module"`).
- No build step for the extension — plain ES modules.
- Experiment API code runs in chrome context (privileged), can access `gBrowser`, `gZenFolders`, `gZenWorkspaces`, `gZenPinnedTabManager`, `Services.*`.
