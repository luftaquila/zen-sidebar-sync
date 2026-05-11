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

const SCHEMA_VERSION = 2;

const TAB_PROPS = ['url', 'title', 'icon', 'kind', 'workspaceSyncId', 'folderSyncId', 'pinned', 'position', 'lastModified'];
const FOLDER_PROPS = ['name', 'workspaceSyncId', 'parentSyncId', 'collapsed', 'userIcon', 'position', 'lastModified'];
const WS_PROPS = ['name', 'icon', 'position', 'lastModified'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
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
          state = mergeState(state, msg.state);
          state.version++;
          state.lastModified = Date.now();
          scheduleSave();

          ws.send(JSON.stringify({ type: 'state_accepted', version: state.version }));
          broadcast(ws, { type: 'state_update', state, sourceDevice: deviceId });
          break;
        }

        case 'patch': {
          if (!Array.isArray(msg.patch?.operations)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid patch structure' }));
            break;
          }
          applyPatch(state, msg.patch);
          state.version++;
          state.lastModified = Date.now();
          scheduleSave();

          ws.send(JSON.stringify({ type: 'patch_accepted', version: state.version }));
          broadcast(ws, { type: 'patch', patch: msg.patch, version: state.version, sourceDevice: deviceId });
          break;
        }

        case 'request_state': {
          ws.send(JSON.stringify({ type: 'state_update', state, sourceDevice: 'server' }));
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
  return s
    && s.schemaVersion === SCHEMA_VERSION
    && Array.isArray(s.workspaces)
    && Array.isArray(s.folders)
    && Array.isArray(s.tabs);
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

function mergeState(server, client) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaces: mergeBySyncId(server.workspaces, client.workspaces)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    folders: mergeBySyncId(server.folders, client.folders)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    tabs: mergeBySyncId(server.tabs, client.tabs)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
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
          state.tabs.push({ ...op.tab, lastModified: now });
        }
        break;

      case 'remove_tab':
        state.tabs = state.tabs.filter(t => t.syncId !== op.syncId);
        break;

      case 'update_tab': {
        const t = state.tabs.find(x => x.syncId === op.syncId);
        if (t && op.changes) {
          Object.assign(t, pick(op.changes, TAB_PROPS));
          t.lastModified = now;
        }
        break;
      }
    }
  }
  state.workspaces.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  state.folders.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  state.tabs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
