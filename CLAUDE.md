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
    - `api.js` — accesses `gZenFolders`, `gZenWorkspaces`, `gBrowser.tabs` for folder/workspace operations; `organizeTab` sets `zenEssential`/`zenWorkspace` properties on tabs via `ExtensionParent.tabTracker`
    - `schema.json` — experiment API schema definition
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
- **Native messaging host** reads Zen's internal session store files because `browser.tabs.query({})` in Zen 1.8b+ only returns active workspace tabs — hidden workspace tabs are invisible to WebExtension API. The host reads `recovery.jsonlz4` (per-tab zenWorkspace/zenEssential/groupId) and `zen-sessions.jsonlz4` (workspace definitions, groups, folders). Falls back to browser.sessions API if native host is unavailable (limited to active workspace only).
- Native data is cached for 5 seconds to avoid spawning Python on every tab event.
- All workspaces from `zen-sessions.jsonlz4` are pre-populated before tab assignment, so empty workspaces are included in sync state.
- Tab deduplication in both `applyState` and `applyPatch` uses `tabMonitor.state` (native host data, all workspaces) instead of `browser.tabs.query` (active workspace only). Using browser API for dedup causes duplicate tab creation for hidden workspace tabs.
- Tab creation uses experiment API `organizeTab` to set `zenEssential`/`zenWorkspace` properties directly on the XUL tab element (chrome context). Falls back to `browser.sessions.setTabValue` if the experiment API is unavailable. The session API stores values in `extData` which Zen does not read — only the direct properties work.
- Workspace syncIds are name-based (not Zen UUID) for cross-device consistency.
- Folder data includes `tabUrls` array mapping folder → member tab URLs via `groupId`.
- After every apply (state or patch), `captureFullState({ silent: true })` immediately recaptures browser state to prevent stale diffs triggering echo loops.
- `_applyingCount` counter guards against tab events during apply; recapture runs while guard is still held.
- Debounce of 300ms on tab events before state capture.
- Server uses server-side timestamps for merge — client timestamps are ignored to prevent stale overwrites on reconnect.
- Patch property updates are allowlisted (url, title, icon, position, pinned) to prevent state corruption.
- Only http/https URLs are captured and synced.
- SyncIds are URL-based hashes (no timestamp) for stability across extension restarts and cross-device consistency.
- Server writes are debounced (1s) and atomic (write-tmp + rename).
- When docs (README.md, CLAUDE.md) describe behavior affected by a code change, always update them together.

## Known limitations

- **Folder restoration disabled**: The experiment API's `createFolder` and `getFolders` use DOM selectors (`zen-folder`, `f.label`) that have not been verified against actual Zen Browser DOM. Folder data is captured and synced, but restoration on receiving devices is disabled until the DOM selectors are tested in a real browser.
- **Hidden workspace tab removal**: `applyState` step 4 (remove tabs not in remote state) only removes active workspace tabs because `browser.tabs.query` doesn't return hidden ones. Tabs removed from remote state in hidden workspaces become zombies until that workspace is activated.
- **Fallback mode limitations**: Without the native messaging host, only active workspace tabs are visible. Workspace detection falls back to `browser.sessions` API which may return UUIDs instead of names.

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
- Experiment API code runs in chrome context (privileged), can access `gBrowser`, `gZenFolders`, `gZenWorkspaces`, `Services.*`.
