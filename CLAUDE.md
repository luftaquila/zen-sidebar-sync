# CLAUDE.md

## Project

Zen Browser sidebar sync extension + WebSocket sync server (v3, "records" architecture). Syncs spaces, essentials, pinned tabs, folders, split views, and regular open tabs in real time across devices.

v2 (name/URL-hash syncIds + Python native messaging host + per-op RPC applier) was abandoned as too buggy; v3 is a ground-up rewrite that adopts Zen's own sync identity model and data layer (available since Zen Twilight 1.22 / dev@2026-08). Zen's native Spaces sync (Firefox Sync engine, Twilight-only) deliberately excludes regular tabs and polls (~10 min); this project replaces it entirely and requires it disabled.

## Structure

- `extension/` — Firefox WebExtension (Manifest V2, experiment API required)
  - `background/` — thin policy + transport layer (ES modules via background page)
    - `main.js` — orchestrator: initial-sync direction prompt, spaces-engine conflict gate, apply-guard confirmation, admin actions, popup messaging
    - `sync-client.js` — WebSocket transport for the v3 record protocol (auth/reconnect/ping)
  - `popup/` — settings UI (vanilla HTML/CSS/JS)
  - `experiments/zenInternals/` — the sync engine, chrome context (privileged)
    - `api.js` — ExtensionAPI glue: loads the three engine scripts into a shared scope, exposes functions + `onRecordsChanged`/`onEnvironmentChanged` events
    - `sync-model.js` — **port of Zen's `ZenSpacesSyncModel.sys.mjs` (MPL-2.0)**: projections from `ZenSessionStore.getSidebarData()`, canonical-JSON SHA-256 digests, uploaded-baseline store, container GUID map, pending navigation holds
    - `sync-applier.js` — **port of Zen's `ZenSpacesSyncApplier.sys.mjs` (MPL-2.0)**: applies incoming records (containers → tombstone routing → deletes → spaces → folders → tabs → splits → ordering), promise-queue serialized
    - `sync-events.js` — chrome event listeners, forced session collection (rate-limited `SessionSaver.run()`), first-upload gating, capture guard, diff emission
    - `schema.json` — experiment API schema
    - Requires `extensions.experiments.enabled = true` in `about:config`
  - v2 leftovers deleted: `extension/native/` (Python host), `background/tab-monitor.js`, `background/tab-applier.js`
- `server/` — Node.js WebSocket server (ESM, single file, `ws` library)
  - Record map + tombstones in `sync-state.json`, token hashes in `tokens.json` under `DATA_DIR` (default: `__dirname`)
  - Container runs as non-root `app` user, data in `/data` volume
- `.github/workflows/container.yml` — builds multi-arch image on push to `main` (only `server/**` changes), pushes to `ghcr.io/luftaquila/zen-sidebar-sync`
- `.github/workflows/extension.yml` — builds `.xpi` on push to `main`, uploads as workflow artifact
- `compose.yml` — works with both `docker compose` and `podman-compose`

## Wire schema (v4) — record protocol

Record kinds mirror Zen's native sync (`container | space | tab | folder | split | layout`) with v3 extensions marked (+):

```
container: { guid, name, icon, color }                 // guid: "builtin-1..4" or per-profile UUID via GUID table
space:     { uuid, name, icon, theme, containerGuid,
             children: [ids],                          // pinned section: tabIds/folderIds/splitIds
             normalChildren: [ids] }                   // (+) unpinned section ordering
tab:       { tabId, url, title, icon, containerGuid, essential,
             pinned,                                   // (+) false ⇒ regular open tab
             workspaceUuid, folderId, staticLabel, hasStaticIcon, defaultContainer }
folder:    { folderId, name, icon, workspaceUuid, parentFolderId, live, children: [ids] }
split:     { splitId, gridType, tabs: [ids], workspaceUuid, folderId }
layout:    { spaces: [uuids], essentials: { containerGuid|"default": [tabIds] } }   // singleton id "layout"
```

**Record ids are Zen's native ids, verbatim**: tab `zenSyncId` (= DOM `id`, persisted in session state, restart-stable), folder DOM id, space `uuid`, split `groupId`. Receiving devices adopt the remote id as the local id (`tab.id = tabId`, `createFolder({id})`), so after first sync `getElementById(id)` resolves any record on any device. Only containers translate through a per-profile GUID map. Ordering is relative (children id arrays), never numeric positions.

Messages: `auth` → `auth_ok {generation, version, records}`; `put_records {records, deleted, reqId, force}` → `records_accepted {reqId, ids, rejected, version}` + `records_update` broadcast, or `put_rejected {reqId, reason: "mass_delete", wouldDelete, current}`; `request_state` → `state_records`; `replace_state {records, baseVersion}` (CAS) → `replace_accepted | replace_conflict`; `admin_reset_state` / `admin_disable_all` / `force_disable` / `ping`.

`reqId` matters: the client keeps each in-flight put's payload and, on ack, advances the baseline **from the sent payload** — never from the ack-time projection. A tab closed (or navigated) while its upload was in flight must keep a baseline entry, or its tombstone/update could never be emitted and the server would hold a ghost record that reconnects keep resurrecting.

## Key design decisions

- **Everything Zen-touching lives in the experiment (chrome context).** `browser.tabs.*` is not used at all — Zen scopes `gBrowser.tabs` (and thus `tabs.query`) to the active space, which was the root of several v2 bugs. Capture reads `ZenSessionStore.getSidebarData()` (in-memory, all workspaces, refreshed on session save, obs topic `zen-sidebar-data-collected`); the v2 Python host that parsed `recovery.jsonlz4` is obsolete.
- **Echo prevention is stateless (digest baseline), not flag-based.** The model keeps `uploaded[id] = {digest, kind}` — the state the server last acknowledged. After applying a remote record, `noteApplied` stores the *incoming* digest as the baseline: a faithful materialization diffs to nothing; a divergent one re-uploads local truth (self-healing). v2's `_applyingCount`/post-apply-recapture approach is gone; ZenWindowSync's async cross-window mirror events make any time-window suppression unsound.
- **Capture pipeline**: chrome events (Zen's own `ZenWindowSync` EVENTS list + `ZenWorkspaceDataChanged`, `ZenFolderRenamed`, `TabAttrModified(label/image/pending)`, `contextual-identity-*`) → 500 ms debounce → **`TabStateFlusher.flushWindow()` on every browser window, then** forced `SessionSaver.run()` (3 s rate limit, suppressed while applying) → `zen-sidebar-data-collected` → digest diff → `onRecordsChanged`. The flush is load-bearing: a freshly opened (eager) tab has no TabState in the parent cache until its first content flush, so an unflushed forced collection simply omits it — that's the difference between sub-second and 15 s propagation (E2E-proven). Two retry backstops: a distinct pending set schedules one follow-up collection (late identities), and an empty diff within 5 s of tab events schedules one retry. Baseline advances only on server ack (`markUploaded`), so lost sends retry automatically on the next diff.
- **Experiment sandbox gotchas (E2E-discovered)**: the schema API sandbox lacks WebIDL globals — `TextEncoder`/`PathUtils` must be borrowed from `Cu.getGlobalForObject(Services)` (a bare `new TextEncoder()` kills the whole loadSubScript). A sandbox function passed to a chrome window's `addEventListener` gets Xray-wrapped into something the DOM can't call (`Property 'handleEvent' is not callable`) — export listeners with `Cu.exportFunction(fn, win)` first. `event.detail` from chrome events needs `Cu.waiveXrays`.
- **Tombstone invariant (the v3 rule that prevents mass-deletion bugs)**: a deletion is emitted ONLY for an id whose owning local object is confirmed absent (`getElementById(id) === null` for tab/folder/split, live workspace list for spaces, container registry for containers) — never because a projection momentarily returned null. Tabs without a projectable identity (lazy tabs without entries, non-http URLs, live folders awaiting provider config) go into a `pending` set that is excluded from deletion detection.
- **Freshly created tabs are true lazy tabs** (`addTrustedTab(url, {createLazyBrowser, lazyTabTitle})`): their lazyData synthesizes session entries at collection time, so projection identity is total without `setTabState` — calling `setTabState` at creation would instantiate the browser and every later URL application would treat the tab as "loaded" (holds instead of retargets). "Unloaded" for navigation purposes is `!tab.linkedPanel || tab.hasAttribute("pending")` (`#isUnloadedTab`) — setTabState/restore instantiates the browser, so `linkedPanel` alone under-reports.
- **A loaded tab is never navigated by sync.** Pinned/essential identity is the pin target (`_zenPinnedInitialState`, upstream semantics) so navigation inside them never churns records. Normal tabs sync the live session-entry URL; on apply, unloaded tabs are retargeted via session state, loaded tabs get a **pending hold** (stored in the model file) that resolves when the tab unloads (retarget), the user navigates it (local wins, re-uploads), or URLs converge. Held ids are excluded from the outgoing diff to prevent ping-pong.
- **Conflict clock is the server-assigned monotonic `seq`** — client `lastModified` LWW (v2) is clock-skew-vulnerable and gone. Idempotent puts: a record whose canonical digest equals the stored one is a no-op (no seq bump, no broadcast), so ack-lost re-uploads never echo.
- **Server generation** (random id, new on init/admin-reset): clients store the generation they synced against. Matching generation on connect → automatic `reconnectMerge`; unknown/changed generation → the initial-sync direction prompt. This replaces v2's per-session `initialSyncDone` flag.
- **Reconnect preserves offline work** (`reconnectMerge`, chrome-side): (1) records we deleted offline (absent locally, uploaded digest == server digest) are NOT re-applied — the next diff pushes their deletion; (2) ids we uploaded before that the server no longer has were deleted remotely → deleted locally; (3) everything else applies remote-wins; leftover local truth pushes via the post-apply diff. Replaces v2's fragile "additive merge then push".
- **Initial-sync direction prompt** (kept from v2): first connect against an unknown generation pauses until the user picks Replace local / Push local / Cancel. Push is CAS-guarded (`baseVersion`) so two devices choosing "push" within seconds can't silently clobber each other — the loser re-prompts with fresh counts. Replace local applies with `reconcile: true`, whose removal pass walks **live** browser state (`allStoredTabs`, folder DOM, workspace list), not the possibly-stale session collection.
- **Three mass-deletion guards**: capture-side (projection lost >90% of >30 previously-synced tabs → emit held), server-side (>90% **effective** deletions of >30 records → structured `put_rejected`; only deletions that would remove an *existing* record count, so an ack-lost replay never wedges; client re-sends with `force` after user confirmation), and **apply-side** (incoming batch deleting >50% of >10 local synced items — containers included — → deletions withheld + user confirmation via popup; v2 only guarded outbound, so a poisoned server state could still wipe clients). Container deletions run behind the window check and the guard, never before. Plus: never delete the last space; remote space deletions confirm via a **deferred, non-blocking** modal (never awaited inside the apply queue — an unattended device must keep applying/capturing; decline re-uploads the local space and revives it on the server); folder deletion unpacks members first.
- **Records referencing an unknown workspace fall back to the active workspace** (never fail-loop, never freeze): the digest self-heal then re-uploads the real placement, correcting the server record. Server-side, deleting a `space` record cascades tombstones to records still referencing it (repairs the delete-vs-update race that would otherwise durably orphan tabs); records upserted in the same message keep their new placement.
- **First-upload gating**: the engine reports ready only after `SessionStore.promiseAllWindowsRestored` + a synced window's `gZenWorkspaces.promiseInitialized`, then forces one fresh collection. Capture stops at `quit-application-granted`.
- **Apply runs in `ZenWindowSync.firstSyncedWindow` only** (no window → whole batch failed and retried); Zen's window sync mirrors to other windows. DOM moves go through `gBrowser.zenHandleTabMove` (falls back to raw moves on older Zen) so TabMove events fire and ordering survives restart. Tab creation sets `tab.id` BEFORE `ZenWindowSync.on_TabOpen({target}, {ignoreExistingId: true})` so window sync treats it as already replicated.
- **Kind transitions (normal ↔ pinned ↔ essential) are field updates on one record**, never remove+add. Essential is cleared first (Zen's `removeEssentials` re-homes to the receiver's active space), then pin state, then the explicit workspace move, then folder membership. Essential-add refusal (`canEssentialBeAdded`) marks the record failed for retry.
- **Failed records are retried, not shrugged off** (replaces v2's best-effort `{success, error}`): apply failures schedule a `request_state` refresh 10 s later; `state_records` while synced runs `reconnectMerge`.
- **Folder nesting cycles** (device A nests X→Y while B nests Y→X) are broken pre-apply by dropping the incoming parent edge; the digest self-heal re-uploads the corrected truth. Zen only bounds sort depth, which doesn't prevent the DOM exception.
- **Canonicalization keeps digests convergent across devices**: sorted-key JSON with `undefined→null`; tab AND folder icons through Zen's `syncableIconUrl` at projection (unwraps `moz-remote-image:`, drops remote favicons — filtering apply-side only would diverge digests and ping-pong); mid-load titles (`title === url`) project as `""`. Splits sync only when every member is syncable; glance tabs, zen-empty placeholders, and live-folder item tabs are excluded (`zenIsGlance`/`zenIsEmpty`/`zenLiveFolderItemId`).
- **Two-syncer conflict gate**: connecting is refused while `services.sync.engine.spaces` is true AND an FxA account is configured (`spaces_engine_conflict` status; popup offers one-click disable). A pref observer pauses sync if it flips back on mid-session.
- **Capability probe, fail closed**: `start()`/`getEnvironment()` verify every gZen*/module symbol the engine touches; on any missing (non-optional) symbol, capture AND apply stay disabled with status `incompatible_zen`. Twilight moves weekly — silent partial operation corrupts state slowly.
- Only http/https URLs are captured, applied, and accepted by the server (`javascript:` etc. rejected server-side too). Server also caps record size (512 KB) and icon fields (128 KB) on every kind — one junk blob would otherwise bloat every future `auth_ok`/`state_records` replay.
- Server writes are debounced (1 s) and atomic (write-tmp + rename); tombstones carry `{seq, deletedAt}` only and are GC'd after 60 days (safe because reconnect reconciliation doesn't depend on them).
- **Force-push CAS conflicts retry the push** (once, against the fresh version) — falling back to `request_state` would silently turn the user's push into a remote-wins pull. Initial-sync push conflicts instead refresh the direction prompt. `confirm_initial_replace` adopts the server generation only after the apply demonstrably ran; a wholesale failure (e.g. no synced window) keeps the prompt — flipping syncActive on with an empty baseline would upload exactly the local state the user chose to discard. After a successful replace, `request_state` refreshes once (broadcasts during the prompt were dropped).
- **`browser.zenInternals.log(msg)`**: chrome-side `Services.console` channel for Marionette-driven log inspection (background `console.log` doesn't reach `Services.console`). The engine also emits low-frequency `[ZenSidebarSync]` diag lines there (diff sizes, guard holds, save failures).
- **Headless provisioning** (`extensions.zenSidebarSync.*` prefs: `serverUrl`, `token`, `deviceName`, `enabled`, `autoInitial="push"|"replace"`): a fresh profile with no stored config adopts these at startup and can even answer the initial-sync direction prompt — used by the E2E harness and useful for multi-device setup via user.js.
- When docs (README.md, CLAUDE.md) describe behavior affected by a code change, always update them together.

## Known limitations

- **Zen native Spaces sync must be off** (`services.sync.engine.spaces=false`). Two syncers over the same data cross-couple; the extension enforces this before connecting. Calling Zen's `ZenSpacesSyncApplier` directly is also forbidden — its `noteApplied` writes into the FxA engine's digest store.
- **Regular tabs inside stock tab groups** sync flat (group membership is not a record kind yet); Zen folders (pinned area) sync fully.
- **Two loaded copies of the same tab may show different pages** until one unloads — by design (loaded tabs are never navigated; the record holds last-writer-by-seq).
- **Folder collapsed state** is not synced (matches upstream Zen sync).
- **Requires Zen with `zenSyncId` persistence and `ZenSessionStore.getSidebarData()`** (Twilight 1.22+ / dev@2026-08 internals). Older Zen fails the capability probe and sync stays disabled.
- Wire schema v4 is incompatible with v2 servers/clients (deliberately — v2 shipped schemaVersion 3). Reset server state when upgrading.

## Commands

```bash
# run server
cd server && npm start

# run server in dev mode (auto-reload)
cd server && npm run dev

# run via container (docker or podman)
docker compose up -d    # or: podman-compose up -d

# reset server sync state (wipes records + tombstones, NEW generation on next start)
podman exec zen-sync sh -c 'rm /data/sync-state.json' && podman restart zen-sync
# (or use the popup's Admin → Reset server state, which also force-disables all clients)

# unit tests (no browser needed; server test needs server/node_modules installed)
node test/sync-model.test.mjs        # projection/digest/tombstone-invariant/hold/baseline tests (vm-shimmed chrome globals)
node test/server-protocol.test.mjs   # spawns the server, drives the full v4 wire protocol incl. guards/CAS/cascade

# full two-profile E2E against a real Zen build (launches two GUI windows,
# ~3 min; requires Twilight 1.22+; drives everything via Marionette)
ZEN_BIN="/path/to/Twilight.app/Contents/MacOS/zen" node test/e2e/run-e2e.mjs
```

## Verification (two-profile end-to-end)

Automated: `test/e2e/run-e2e.mjs` (see Commands) provisions two throwaway profiles via prefs, installs the extension through Marionette (`--marionette --remote-allow-system-access`), and walks the milestone gates against a real Twilight build. **Last full pass: Twilight 1.22t (BuildID 20260823110335), 2026-09-03 — 44/44**, measured propagation: initial push 0.5 s, tab open A→B 0.8 s, close 1.0 s, navigation retarget 3.0 s, pin 0.5 s, folder 2.0 s, kind transitions ~3 s, split 2.5 s, container 3.0 s, 60 tabs A→B 1.5 s.

Milestone gates:
- **M1** records reach the server with correct kinds (normal/pinned/essential/space/layout).
- **M2** idle → zero `put_records` (baseline quiescence).
- **M3** fresh profile Replace-local → identical ids materialize, workspace uuid verbatim, zero `put_records` after (echo-free).
- **M4** realtime matrix, each converges: open, close, navigate (unloaded copy retargeted; LOADED copy never navigated — URL held, converges on unload), pin/unpin (no remove+add), space rename, folder create+membership, **kind transitions normal↔pinned↔essential↔normal on one id**, **normal-tab reorder** (verified flip), **split create/unsplit** (same group id, members kept), **nested folder** (parent edge intact), **container create**, **pinned-tab navigation → zero record churn** (pin target is identity).
- **M5** matrix quiescence — no A↔B ping-pong.
- **M6** space create (uuid verbatim); **remote space deletion held behind a confirmation modal**, applied only on accept.
- **M7** browser restart → all record ids survive, zero puts after (echo-free restart).
- **M8** server killed → both peers edit offline (add + close) → on reconnect the new tabs upload, the offline close propagates, both converge with no resurrection and no loss.
- **M9** scale: 60 tabs opened at once → all reach the server (1.5 s) and materialize on the peer.
- **M10** a forced 55-record deletion (server guard bypassed) → the **apply-side guard withholds it on BOTH clients** (tabs survive), and sync keeps flowing while the guard awaits confirmation.

Not yet covered by automation (verify in real use): multi-week tombstone GC / long-offline reconcile, live folders, multi-window capture dedup, real-network reconnect storms, Twilight version drift. Manual setup for ad-hoc testing: two profiles with `extensions.experiments.enabled=true`, `xpinstall.signatures.required=false`, `services.sync.engine.spaces=false`, extension loaded, `ws://localhost:9223`.

## Conventions

- Extension code uses `browser.*` APIs only for storage/messaging; all tab/workspace work happens in the experiment.
- Server uses Node.js ESM (`"type": "module"`).
- No build step for the extension — plain ES modules + loadSubScript chrome scripts.
- Experiment code runs in chrome context (privileged): `gBrowser`, `gZenFolders`, `gZenWorkspaces`, `gZenPinnedTabManager`, `gZenViewSplitter`, `Services.*`, `ChromeUtils.importESModule`.
- `sync-model.js` / `sync-applier.js` keep their MPL-2.0 headers (ported from Zen); the rest of the repo is MIT.
