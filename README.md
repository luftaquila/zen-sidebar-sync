# zen-sidebar-sync

Real-time sidebar sync for [Zen Browser](https://zen-browser.app). Syncs spaces, essentials, pinned tabs, folders, split views, and **regular open tabs** across devices via WebSocket — instantly, not on a polling schedule.

> **Why this exists when Zen Twilight has built-in sync:** Zen's native Spaces sync (Firefox Sync based) deliberately excludes regular open tabs and propagates on Firefox Sync's pull schedule (~10 minutes typical). This project syncs everything — including open tabs — in real time over a self-hosted server. The two must not run simultaneously; the extension detects and disables Zen's native spaces engine (`services.sync.engine.spaces`).

## Architecture

```
┌───────────────────────────────┐      WebSocket      ┌──────────────┐
│ Zen + Extension               │◄───────────────────►│  Sync Server │
│  ├ experiment (chrome ctx)    │                     └──────┬───────┘
│  │   capture · diff · apply   │                            │
│  └ background: WS transport   │      WebSocket             │
├───────────────────────────────┤◄───────────────────────────┘
│ Zen + Extension (device 2)    │
└───────────────────────────────┘
```

- **Experiment API (chrome context)** does all the sync work: captures Zen's in-memory session store (`ZenSessionStore.getSidebarData()`), diffs against a per-record digest baseline, and applies incoming records with Zen's own internal APIs. Ports of Zen's MPL-2.0 sync engine (`ZenSpacesSyncModel` / `ZenSpacesSyncApplier`) extended to cover regular tabs.
- **Background script** is a thin policy + transport layer (WebSocket, initial-sync prompt, guards).
- **Server** stores a flat record map with server-assigned sequence numbers and tombstones. Self-hostable, single file.

No native messaging host, no Python — v1's session-file parsing is replaced by Zen's in-process store.

### What syncs

| Item | Identity |
|---|---|
| Spaces (name, icon, theme, container, order) | Zen space `uuid` (adopted verbatim across devices) |
| Essentials (per-container, ordered) | tab `zenSyncId` (= persisted DOM id) |
| Pinned tabs (pin target URL, static label/icon) | tab `zenSyncId` |
| Regular open tabs (live URL) | tab `zenSyncId` |
| Folders (nested, icon, order) | folder DOM id |
| Split views | split `groupId` |
| Containers (name/icon/color) | per-profile GUID map |

Record ids are Zen's own ids, adopted verbatim on receiving devices (`tab.id = remoteId`) — the same identity model Zen's native sync uses. After first sync, `document.getElementById(id)` resolves any record on any device.

### Sync behavior

- Wire protocol `schemaVersion: 4`; the server assigns a monotonic `seq` per write (no client-clock conflict resolution).
- Changes are captured event-driven (Zen's own chrome events + forced session collection, rate-limited) and uploaded as record diffs — typically < 2 s end-to-end.
- Incoming records always apply (remote wins); if the local materialization diverges, the digest baseline re-uploads local truth on the next capture (self-healing, same model as Zen's native sync).
- A **loaded tab is never navigated** by sync. Unloaded tabs are retargeted in session state; loaded ones hold the remote URL until they unload or the user navigates.
- Pinned/essential tabs sync their **pin target**, not the live page (upstream semantics). Regular tabs sync the live URL.
- Only `http:` / `https:` URLs sync, enforced on both client and server.
- Deletions are emitted only for ids whose local object is confirmed absent — a transient capture gap can never mass-delete tabs on other devices.
- First connect to an unknown server generation always **asks the user to pick a direction** (replace local / push local / cancel). Push is compare-and-swap guarded against racing devices.
- Reconnects preserve offline work: offline-deleted tabs stay deleted, offline-opened tabs push, remote deletions apply.
- Mass-deletion guards on capture (client), write (server), and apply (client, with user confirmation).

## Setup

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
docker run -d --name zen-sync \
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
| `extensions.experiments.enabled` | `true` (enables the experiment API — required) |
| `services.sync.engine.spaces` | `false` (disables Zen's native Spaces sync; the popup can do this for you) |

#### 2. Install the extension

Download the latest `.xpi` artifact from [Actions](https://github.com/luftaquila/zen-sidebar-sync/actions/workflows/extension.yml) and drag it onto Zen Browser to install.

For development, use `about:debugging` > **Load Temporary Add-on** > select `extension/manifest.json`.

#### 3. Configure and connect

Click the toolbar icon > enter server URL (`ws://host:9223`) and the sync token > toggle **Sync** on. On first connect, pick a sync direction when prompted.

## Compatibility

Requires a Zen build with persisted tab sync ids and the in-memory session store (Twilight 1.22+ / the 2026 `dev` branch internals). The extension probes every internal API it needs at startup and **fails closed** — if this Zen version is missing something, sync is disabled with an explanatory banner instead of corrupting state.

## Development

```bash
# server with auto-reload
cd server && npm run dev

# extension: reload from about:debugging after changes
```

## License

MIT. Files ported from Zen Browser (`extension/experiments/zenInternals/sync-model.js`, `sync-applier.js`) remain under MPL-2.0 as noted in their headers.
