# zen-sidebar-sync

Real-time sidebar sync for [Zen Browser](https://zen-browser.app). Syncs essentials, workspaces, and open tabs across devices via WebSocket.

## Architecture

```
┌─────────────┐     WebSocket     ┌──────────────┐
│  Zen + Ext  │◄─────────────────►│  Sync Server │
└──────┬──────┘                   └──────┬───────┘
       │                                 │
  Native Host                            │
  (Python)                               │
       │                                 │
┌──────┴──────┐     WebSocket            │
│  Zen + Ext  │◄─────────────────────────┘
└──────┬──────┘
       │
  Native Host
  (Python)
```

- **Extension** monitors tab state via native messaging host and communicates with the sync server.
- **Native messaging host** reads Zen's internal session store files (`recovery.jsonlz4`, `zen-sessions.jsonlz4`) to detect all workspaces, essentials, and tabs — including hidden workspace tabs that the WebExtension API cannot access.
- **Server** is a WebSocket server that merges and broadcasts state. Self-hostable.

### What syncs

| Item | Detection |
|---|---|
| Workspaces (spaces, including empty) | `spaces[]` in `zen-sessions.jsonlz4` |
| Essentials (global pinned shortcuts) | `zenEssential` flag in session store |
| Pinned tabs (per workspace) | `pinned` + `zenWorkspace` in session store |
| Open tabs (per workspace) | `zenWorkspace` in session store |
| Folders (nested, with userIcon, collapsed state) | `folders[]` in `zen-sessions.jsonlz4` |
| Tab → folder membership | `groupId` on tab → folder id |

A tab is **one of** essential / pinned / normal — transitions between these states sync as a single update without tearing the tab down.

### Sync behavior

- State is `schemaVersion: 2`. Server rejects mismatched payloads.
- Initial connect merges additively (no tabs are closed).
- After initial sync, all changes propagate bidirectionally — including tab closes.
- Empty remote state forces additive merge (defends against accidental wipe).
- Small diffs go as patches; large changes send full state.
- Conflicts resolved by `lastModified` per record (last write wins).
- Workspace creation, folder creation/nesting/rename/delete, tab pin/unpin/essential/move propagate via the experiment API (Zen-internal calls `gZenWorkspaces`, `gZenFolders`, `gZenPinnedTabManager`).
- Workspace whose name is UUID-shaped (`{xxxx-xxxx-…}`) is treated as corruption and dropped from sync.
- Only `http:` and `https:` URLs are synced — `data:`, `javascript:`, `file:` are rejected.

## Setup

### Prerequisites

- **Python 3.6+** — required for the native messaging host
- **Zen Browser** — with access to `about:config`

### Server

Container image is published to GHCR on every push to `main`.

```
ghcr.io/luftaquila/zen-sidebar-sync:latest
```

#### Container (Docker / Podman)

```bash
docker compose up -d     # or: podman-compose up -d
```

Or without compose:

```bash
docker run -d --name zen-sync \     # or: podman run
  -p 9223:9223 \
  -v zen-sync-data:/data \
  ghcr.io/luftaquila/zen-sidebar-sync:latest
```

First run prints a **sync token** to the container logs. Save it:

```bash
docker logs zen-sync    # or: podman logs zen-sync
```

`PORT` env var overrides the default port. State and tokens are persisted in the `/data` volume.

#### From source

```bash
cd server
npm install
npm start
```

### Extension

#### 1. Browser settings

Open `about:config` in Zen Browser and set:

| Key | Value |
|---|---|
| `xpinstall.signatures.required` | `false` (allows unsigned extensions) |
| `extensions.experiments.enabled` | `true` (enables experiment API for folder sync) |

#### 2. Install the extension

Download the latest `.xpi` artifact from [Actions](https://github.com/luftaquila/zen-sidebar-sync/actions/workflows/extension.yml) and drag it onto Zen Browser to install.

For development, use `about:debugging` > **Load Temporary Add-on** > select `extension/manifest.json`.

#### 3. Install the native messaging host

The native messaging host is required to read Zen's internal session store for full workspace/essential detection.

**Linux / macOS:**

```bash
cd extension/native
./install.sh
```

**Windows (PowerShell):**

```powershell
cd extension\native
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer copies the Python script and registers the native messaging manifest. The host runs on-demand (spawned per message, not a persistent daemon).

#### 4. Configure and connect

Click the toolbar icon > enter server URL (`ws://host:9223`) and the sync token > toggle **Sync** on.

## Development

```bash
# server with auto-reload
cd server && npm run dev

# extension: reload from about:debugging after changes
```

## License

MIT
