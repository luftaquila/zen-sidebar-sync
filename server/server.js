import { WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PORT = parseInt(process.env.PORT || '9223');
const STATE_FILE = join(DATA_DIR, 'sync-state.json');
const TOKEN_FILE = join(DATA_DIR, 'tokens.json');

const SCHEMA_VERSION = 3;

const TAB_PROPS = ['url', 'title', 'icon', 'kind', 'workspaceSyncId', 'folderSyncId', 'pinned', 'position', 'syncUuid', 'lastModified'];
const FOLDER_PROPS = ['name', 'workspaceSyncId', 'parentSyncId', 'collapsed', 'userIcon', 'position', 'lastModified'];
const WS_PROPS = ['name', 'icon', 'theme', 'position', 'lastModified'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

// --- Logging ---

function logState(label) {
  const w = (state.workspaces || []).length;
  const f = (state.folders || []).length;
  const t = (state.tabs || []);
  const byKind = { essential: 0, pinned: 0, normal: 0 };
  for (const x of t) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  console.log(`[state] ${label} | v${state.version} | ws:${w} folders:${f} tabs:${t.length} (ess:${byKind.essential} pin:${byKind.pinned} norm:${byKind.normal})`);
}

function logPatchOp(op) {
  const trunc = (s) => (s || '').toString().slice(0, 70);
  switch (op.type) {
    case 'add_tab':       return `add_tab ${op.tab?.kind} ${trunc(op.tab?.url)}`;
    case 'update_tab':    return `update_tab ${trunc(op.tab?.url || op.syncId)} ${JSON.stringify(op.changes).slice(0, 80)}`;
    case 'remove_tab':    return `remove_tab ${trunc(op.url || op.syncId)}`;
    case 'add_workspace': return `add_workspace "${op.workspace?.name}"`;
    case 'update_workspace': return `update_workspace ${op.syncId} ${JSON.stringify(op.changes).slice(0, 60)}`;
    case 'remove_workspace': return `remove_workspace ${op.syncId}`;
    case 'add_folder':    return `add_folder "${op.folder?.name}" ws=${op.folder?.workspaceSyncId}`;
    case 'update_folder': return `update_folder ${op.syncId} ${JSON.stringify(op.changes).slice(0, 60)}`;
    case 'remove_folder': return `remove_folder ${op.syncId}`;
    default:              return op.type;
  }
}

// --- Safety guards ---

function countRemovals(patch, st) {
  let n = 0;
  for (const op of patch.operations) {
    if (op.type === 'remove_tab' || op.type === 'remove_folder' || op.type === 'remove_essential') {
      n++;
    } else if (op.type === 'remove_workspace') {
      // Workspace removal cascades to its tabs + folders; count those too.
      n++;
      n += (st.tabs || []).filter(t => t.workspaceSyncId === op.syncId).length;
      n += (st.folders || []).filter(f => f.workspaceSyncId === op.syncId).length;
    }
  }
  return n;
}

function countStateItems(st) {
  return (st.workspaces || []).length + (st.folders || []).length + (st.tabs || []).length;
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaces: [],
    folders: [],
    tabs: [],
    version: 0,
    lastModified: Date.now(),
  };
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        console.error(`State schema mismatch (got ${parsed.schemaVersion}, expected ${SCHEMA_VERSION}), resetting`);
        return emptyState();
      }
      return parsed;
    }
  } catch (e) {
    console.error('Corrupt state file, resetting:', e.message);
  }
  return emptyState();
}

function loadTokens() {
  try {
    if (existsSync(TOKEN_FILE)) {
      return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Corrupt token file, resetting:', e.message);
  }
  return {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STATE_FILE + '.tmp';
      await writeFile(tmp, JSON.stringify(state));
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('State save error:', e.message);
    }
  }, 1000);
}

let state = loadState();
const tokens = loadTokens();

function generateToken() {
  return randomBytes(32).toString('hex');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

if (Object.keys(tokens).length === 0) {
  const token = generateToken();
  tokens[hashToken(token)] = { name: 'default', createdAt: Date.now() };
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('='.repeat(60));
  console.log('  Initial sync token (save this!):');
  console.log(`  ${token}`);
  console.log('='.repeat(60));
}

function authenticateToken(token) {
  return tokens[hashToken(token)] !== undefined;
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 4 * 1024 * 1024 });
const clients = new Map();

console.log(`Zen Sidebar Sync server listening on ws://0.0.0.0:${PORT} (schema v${SCHEMA_VERSION})`);

wss.on('connection', (ws) => {
  let authenticated = false;
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!authenticated) {
      if (msg.type === 'auth') {
        if (!authenticateToken(msg.token)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close(4001, 'Unauthorized');
          return;
        }
        authenticated = true;
        deviceId = msg.deviceId || randomBytes(8).toString('hex');
        clients.set(ws, { deviceId, name: msg.deviceName || 'Unknown' });

        ws.send(JSON.stringify({
          type: 'auth_ok',
          deviceId,
          schemaVersion: SCHEMA_VERSION,
          state,
          connectedDevices: Array.from(clients.values()).map(c => c.name),
        }));

        broadcast(ws, {
          type: 'device_connected',
          deviceId,
          deviceName: msg.deviceName || 'Unknown',
        });

        console.log(`Device connected: ${msg.deviceName || deviceId}`);
        return;
      }
      ws.send(JSON.stringify({ type: 'error', message: 'Must authenticate first' }));
      return;
    }

    try {
      switch (msg.type) {
        case 'full_state': {
          if (!isValidV2State(msg.state)) {
            ws.send(JSON.stringify({ type: 'error', message: `Invalid state structure (expected schemaVersion ${SCHEMA_VERSION})` }));
            break;
          }
          if (msg.replace) {
            // Force-push: caller asserts authority. Replace server state outright.
            state = {
              schemaVersion: SCHEMA_VERSION,
              workspaces: msg.state.workspaces,
              folders: msg.state.folders,
              tabs: msg.state.tabs,
              version: state.version,
              lastModified: Date.now(),
            };
            console.log(`[${msg.deviceId || deviceId}] ← full_state REPLACE`);
          } else {
            state = mergeState(state, msg.state);
            console.log(`[${msg.deviceId || deviceId}] ← full_state MERGE`);
          }
          state.version++;
          state.lastModified = Date.now();
          scheduleSave();
          logState('after full_state');

          ws.send(JSON.stringify({ type: 'state_accepted', version: state.version }));
          broadcast(ws, { type: 'state_update', state, sourceDevice: deviceId });
          break;
        }

        case 'patch': {
          if (!Array.isArray(msg.patch?.operations)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid patch structure' }));
            break;
          }
          // Mass-removal guard: catches catastrophically corrupted captures
          // (client bug returning no tabs at all). Tuned very loose so a real
          // user mass-close operation passes through; client-side capture
          // guard is the first line of defense.
          const removals = countRemovals(msg.patch, state);
          const current = countStateItems(state);
          if (current > 30 && removals > current * 0.9) {
            console.warn(`[${deviceId}] REJECTED patch: ${removals}/${current} removals (>90%)`);
            for (const op of msg.patch.operations) console.warn(`  ${logPatchOp(op)}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Patch rejected: too many removals' }));
            break;
          }
          console.log(`[${deviceId}] ← patch (${msg.patch.operations.length} ops)`);
          for (const op of msg.patch.operations) console.log(`  ${logPatchOp(op)}`);

          applyPatch(state, msg.patch);
          state.version++;
          state.lastModified = Date.now();
          scheduleSave();
          logState('after patch');

          ws.send(JSON.stringify({ type: 'patch_accepted', version: state.version }));
          broadcast(ws, { type: 'patch', patch: msg.patch, version: state.version, sourceDevice: deviceId });
          break;
        }

        case 'request_state': {
          ws.send(JSON.stringify({ type: 'state_update', state, sourceDevice: 'server' }));
          break;
        }

        case 'admin_reset_state': {
          // Wipe the server state AND force every connected device off.
          // Without the force-disable, the admin client's normal capture
          // loop would emit patches for its local tabs seconds later and
          // re-populate the server, making the reset look like it did
          // nothing. Forcing everyone off means the next person to
          // re-enable sync re-seeds the server from scratch (and
          // subsequent devices hit the initial-sync confirm prompt).
          state = {
            schemaVersion: SCHEMA_VERSION,
            workspaces: [],
            folders: [],
            tabs: [],
            version: 0,
            lastModified: Date.now(),
          };
          scheduleSave();
          console.log(`[${deviceId}] ADMIN reset state (force-disable all)`);
          ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_state' }));
          const data = JSON.stringify({ type: 'force_disable', reason: 'admin_reset' });
          for (const [client] of clients) {
            if (client.readyState === 1) client.send(data);
          }
          break;
        }

        case 'admin_disable_all': {
          // Tell every connected device (including sender) to disable sync.
          // Each client will turn off syncEnabled in storage and disconnect.
          console.log(`[${deviceId}] ADMIN disable all`);
          const data = JSON.stringify({ type: 'force_disable', reason: 'admin' });
          for (const [client] of clients) {
            if (client.readyState === 1) client.send(data);
          }
          ws.send(JSON.stringify({ type: 'admin_ok', action: 'disable_all' }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (e) {
      console.error('Message handling error:', e.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Internal error' }));
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`Device disconnected: ${client.name || client.deviceId}`);
      broadcast(ws, { type: 'device_disconnected', deviceId: client.deviceId, deviceName: client.name });
      clients.delete(ws);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    const client = clients.get(ws);
    if (client) {
      broadcast(ws, { type: 'device_disconnected', deviceId: client.deviceId, deviceName: client.name });
    }
    clients.delete(ws);
  });

  setTimeout(() => {
    if (!authenticated && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
      ws.close(4002, 'Auth timeout');
    }
  }, 10000);
});

function broadcast(sender, msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== sender && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function isValidV2State(s) {
  if (!s
    || s.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(s.workspaces)
    || !Array.isArray(s.folders)
    || !Array.isArray(s.tabs)) {
    return false;
  }
  // Referential integrity: every non-essential tab's workspaceSyncId
  // MUST resolve to a workspace in the same payload. A tab with an
  // unresolvable workspaceSyncId cannot be placed by any client
  // (`tabMonitor.workspaceUuidBySyncId.get(...)` returns undefined),
  // so the client falls back to creating the tab in its currently
  // active workspace — the "all tabs dump into current space" bug.
  // Reject the whole payload so the publisher fixes its capture.
  const wsIds = new Set(s.workspaces.map(w => w?.syncId).filter(Boolean));
  for (const t of s.tabs) {
    if (t?.kind === 'essential') continue;
    if (!t?.workspaceSyncId || !wsIds.has(t.workspaceSyncId)) {
      console.warn(`[validate] tab ${t?.syncId} kind=${t?.kind} has dangling workspaceSyncId=${t?.workspaceSyncId}`);
      return false;
    }
  }
  return true;
}

function mergeBySyncId(serverItems, clientItems) {
  const merged = new Map();
  for (const item of (serverItems || [])) {
    if (item?.syncId) merged.set(item.syncId, item);
  }
  for (const item of (clientItems || [])) {
    if (!item?.syncId) continue;
    const existing = merged.get(item.syncId);
    if (!existing) {
      merged.set(item.syncId, item);
    } else if ((item.lastModified || 0) >= (existing.lastModified || 0)) {
      merged.set(item.syncId, item);
    }
  }
  return Array.from(merged.values());
}

// Stable sort: primary by position, secondary by syncId so equal
// positions don't reorder across requests / server restarts. Without
// the tiebreaker, two clients could end up with different final
// orderings even after seeing the same data.
function stableSort(items) {
  return items.slice().sort((a, b) => {
    const dp = (a.position ?? 0) - (b.position ?? 0);
    if (dp !== 0) return dp;
    const sa = a.syncId || '';
    const sb = b.syncId || '';
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

function mergeState(server, client) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaces: stableSort(mergeBySyncId(server.workspaces, client.workspaces)),
    folders: stableSort(mergeBySyncId(server.folders, client.folders)),
    tabs: stableSort(mergeBySyncId(server.tabs, client.tabs)),
    version: server.version,
    lastModified: Date.now(),
  };
}

function applyPatch(state, patch) {
  const now = Date.now();
  for (const op of patch.operations) {
    switch (op.type) {
      case 'add_workspace':
        if (op.workspace?.syncId && !state.workspaces.some(w => w.syncId === op.workspace.syncId)) {
          state.workspaces.push({ ...op.workspace, lastModified: now });
        }
        break;

      case 'remove_workspace':
        state.workspaces = state.workspaces.filter(w => w.syncId !== op.syncId);
        // Cascade: drop folders + tabs anchored to this workspace
        state.folders = state.folders.filter(f => f.workspaceSyncId !== op.syncId);
        state.tabs = state.tabs.filter(t => t.workspaceSyncId !== op.syncId);
        break;

      case 'update_workspace': {
        const ws = state.workspaces.find(w => w.syncId === op.syncId);
        if (ws && op.changes) {
          Object.assign(ws, pick(op.changes, WS_PROPS));
          ws.lastModified = now;
        }
        break;
      }

      case 'add_folder':
        if (op.folder?.syncId && !state.folders.some(f => f.syncId === op.folder.syncId)) {
          state.folders.push({ ...op.folder, lastModified: now });
        }
        break;

      case 'remove_folder':
        state.folders = state.folders.filter(f => f.syncId !== op.syncId);
        // Tabs that referenced this folder become folder-less but stay pinned in their workspace
        for (const t of state.tabs) {
          if (t.folderSyncId === op.syncId) {
            t.folderSyncId = null;
            t.lastModified = now;
          }
        }
        break;

      case 'update_folder': {
        const f = state.folders.find(x => x.syncId === op.syncId);
        if (f && op.changes) {
          Object.assign(f, pick(op.changes, FOLDER_PROPS));
          f.lastModified = now;
        }
        break;
      }

      case 'add_tab':
        if (op.tab?.syncId && !state.tabs.some(t => t.syncId === op.tab.syncId)) {
          // Same referential-integrity guard as isValidV2State: a non-
          // essential tab without a known workspaceSyncId would land on
          // every subscriber's active workspace. Reject the op instead.
          if (op.tab.kind !== 'essential') {
            const wsExists = state.workspaces.some(w => w.syncId === op.tab.workspaceSyncId);
            if (!op.tab.workspaceSyncId || !wsExists) {
              console.warn(`[patch] dropping add_tab ${op.tab.syncId} — dangling workspaceSyncId=${op.tab.workspaceSyncId}`);
              break;
            }
          }
          state.tabs.push({ ...op.tab, lastModified: now });
        }
        break;

      case 'remove_tab':
        state.tabs = state.tabs.filter(t => t.syncId !== op.syncId);
        break;

      case 'update_tab': {
        const t = state.tabs.find(x => x.syncId === op.syncId);
        if (t && op.changes) {
          // If the update would change workspaceSyncId, ensure target
          // workspace exists. Silently dropping a workspace move leaves
          // the tab anchored to a stale workspace; rejecting the update
          // is preferable to corrupting the state.
          if (op.changes.workspaceSyncId !== undefined
              && op.changes.workspaceSyncId !== null
              && !state.workspaces.some(w => w.syncId === op.changes.workspaceSyncId)) {
            console.warn(`[patch] dropping update_tab ${op.syncId} — would set dangling workspaceSyncId=${op.changes.workspaceSyncId}`);
            break;
          }
          Object.assign(t, pick(op.changes, TAB_PROPS));
          t.lastModified = now;
        }
        break;
      }

      default:
        // Unknown op type — log so a client/schema mismatch is visible
        // rather than silently dropped.
        console.warn(`[patch] unknown op type: ${op.type}`);
        break;
    }
  }
  state.workspaces = stableSort(state.workspaces);
  state.folders = stableSort(state.folders);
  state.tabs = stableSort(state.tabs);
}
