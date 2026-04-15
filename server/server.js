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

// [C1] Allowlisted properties for patch updates
const TAB_PROPS = ['url', 'title', 'icon', 'position', 'pinned', 'lastModified'];
const WS_PROPS = ['name', 'icon'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

// --- State Management [H2] safe loading ---

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Corrupt state file, resetting:', e.message);
  }
  return { essentials: [], workspaces: [], groups: [], folders: [], version: 0, lastModified: Date.now() };
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

// [P5] Debounced async write with atomic rename
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

// --- Token Management ---

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

// --- WebSocket Server [C2] maxPayload ---

const wss = new WebSocketServer({ port: PORT, maxPayload: 4 * 1024 * 1024 });
const clients = new Map();

console.log(`Zen Sidebar Sync server listening on ws://0.0.0.0:${PORT}`);

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

    // [H3][H4] Validated message handling with try/catch
    try {
      switch (msg.type) {
        case 'full_state': {
          if (!msg.state || !Array.isArray(msg.state.essentials) || !Array.isArray(msg.state.workspaces)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid state structure' }));
            break;
          }
          const merged = mergeState(state, msg.state);
          state = merged;
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

  // [H1] Auth timeout with readyState guard
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

// --- State Merge [H7] server-side timestamps, content-based ---

function mergeState(server, client) {
  return {
    essentials: mergeTabList(server.essentials, client.essentials),
    workspaces: mergeWorkspaces(server.workspaces, client.workspaces),
    groups: mergeBySyncId(server.groups, client.groups),
    folders: mergeBySyncId(server.folders, client.folders),
    version: server.version,
    lastModified: Date.now(),
  };
}

function mergeBySyncId(serverItems, clientItems) {
  if (!Array.isArray(clientItems)) return serverItems || [];
  if (!serverItems || serverItems.length === 0) return clientItems;

  const merged = new Map();
  for (const item of serverItems) merged.set(item.syncId, item);
  for (const item of clientItems) merged.set(item.syncId, { ...item, lastModified: Date.now() });
  return Array.from(merged.values());
}

function mergeTabList(serverTabs, clientTabs) {
  if (!Array.isArray(clientTabs)) return serverTabs || [];
  if (!serverTabs || serverTabs.length === 0) {
    return deduplicateByUrl(clientTabs.map(t => ({ ...t, lastModified: Date.now() })));
  }

  const merged = new Map();

  for (const tab of serverTabs) {
    merged.set(tab.syncId, tab);
  }

  for (const tab of clientTabs) {
    const existing = merged.get(tab.syncId);
    if (!existing) {
      merged.set(tab.syncId, { ...tab, lastModified: Date.now() });
    } else if (existing.url !== tab.url || existing.title !== tab.title) {
      merged.set(tab.syncId, { ...tab, lastModified: Date.now() });
    }
  }

  return deduplicateByUrl(Array.from(merged.values()))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function deduplicateByUrl(tabs) {
  const byUrl = new Map();
  for (const tab of tabs) {
    const existing = byUrl.get(tab.url);
    if (!existing || (tab.lastModified || 0) > (existing.lastModified || 0)) {
      byUrl.set(tab.url, tab);
    }
  }
  return Array.from(byUrl.values());
}

function mergeWorkspaces(serverWs, clientWs) {
  if (!Array.isArray(clientWs)) return serverWs || [];
  if (!serverWs || serverWs.length === 0) {
    return clientWs.map(w => ({ ...w, lastModified: Date.now() }));
  }

  const merged = new Map();

  for (const ws of serverWs) {
    merged.set(ws.syncId, ws);
  }

  for (const ws of clientWs) {
    const existing = merged.get(ws.syncId);
    if (!existing) {
      merged.set(ws.syncId, { ...ws, lastModified: Date.now() });
    } else {
      const metaChanged = existing.name !== ws.name || existing.icon !== ws.icon;
      merged.set(ws.syncId, {
        ...existing,
        ...(metaChanged ? { name: ws.name, icon: ws.icon } : {}),
        syncId: ws.syncId,
        tabs: mergeTabList(existing.tabs, ws.tabs),
        pinnedTabs: mergeTabList(existing.pinnedTabs, ws.pinnedTabs),
        lastModified: Date.now(),
      });
    }
  }

  // Deduplicate workspaces by name (different syncIds can map to same workspace)
  const byName = new Map();
  for (const ws of merged.values()) {
    const existing = byName.get(ws.name);
    if (!existing) {
      byName.set(ws.name, ws);
    } else {
      existing.tabs = mergeTabList(existing.tabs || [], ws.tabs || []);
      existing.pinnedTabs = mergeTabList(existing.pinnedTabs || [], ws.pinnedTabs || []);
    }
  }

  return Array.from(byName.values())
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

// --- Patch Application [C1][P4] sanitized + map-based ---

function applyPatch(state, patch) {
  for (const op of patch.operations) {
    switch (op.type) {
      case 'add_essential':
        if (op.tab?.syncId
            && !state.essentials.some(t => t.syncId === op.tab.syncId)
            && !state.essentials.some(t => t.url === op.tab.url)) {
          state.essentials.push(op.tab);
          state.essentials.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        }
        break;

      case 'remove_essential':
        state.essentials = state.essentials.filter(t => t.syncId !== op.syncId);
        break;

      case 'update_essential': {
        const idx = state.essentials.findIndex(t => t.syncId === op.syncId);
        if (idx >= 0 && op.changes) {
          Object.assign(state.essentials[idx], pick(op.changes, TAB_PROPS));
        }
        break;
      }

      case 'add_workspace':
        if (op.workspace?.syncId && !state.workspaces.some(w => w.syncId === op.workspace.syncId)) {
          state.workspaces.push(op.workspace);
        }
        break;

      case 'remove_workspace': {
        const removed = state.workspaces.find(w => w.syncId === op.syncId);
        if (removed) op.workspace = removed;
        state.workspaces = state.workspaces.filter(w => w.syncId !== op.syncId);
        break;
      }

      case 'update_workspace': {
        const ws = state.workspaces.find(w => w.syncId === op.syncId);
        if (ws && op.changes) {
          Object.assign(ws, pick(op.changes, WS_PROPS));
        }
        break;
      }

      case 'add_tab': {
        const ws = state.workspaces.find(w => w.syncId === op.workspaceSyncId);
        if (ws && op.tab?.syncId) {
          const list = op.pinned ? (ws.pinnedTabs ??= []) : (ws.tabs ??= []);
          if (!list.some(t => t.syncId === op.tab.syncId)
              && !list.some(t => t.url === op.tab.url)) {
            list.push(op.tab);
            list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          }
        }
        break;
      }

      case 'remove_tab': {
        const ws2 = state.workspaces.find(w => w.syncId === op.workspaceSyncId);
        if (ws2) {
          ws2.tabs = (ws2.tabs || []).filter(t => t.syncId !== op.syncId);
          ws2.pinnedTabs = (ws2.pinnedTabs || []).filter(t => t.syncId !== op.syncId);
        }
        break;
      }

      case 'update_tab': {
        const ws3 = state.workspaces.find(w => w.syncId === op.workspaceSyncId);
        if (ws3 && op.changes) {
          const safe = pick(op.changes, TAB_PROPS);
          for (const list of [ws3.tabs || [], ws3.pinnedTabs || []]) {
            const t = list.find(t => t.syncId === op.syncId);
            if (t) Object.assign(t, safe);
          }
        }
        break;
      }

      case 'add_folder':
        if (op.folder?.syncId
            && !(state.folders || []).some(f => f.syncId === op.folder.syncId)
            && !(state.folders || []).some(f => f.name === op.folder.name)) {
          (state.folders ??= []).push(op.folder);
        }
        break;

      case 'remove_folder':
        state.folders = (state.folders || []).filter(f => f.syncId !== op.syncId);
        break;

      case 'update_folder': {
        const folder = (state.folders || []).find(f => f.syncId === op.syncId);
        if (folder && op.changes) {
          if (op.changes.name !== undefined) folder.name = op.changes.name;
          if (op.changes.collapsed !== undefined) folder.collapsed = op.changes.collapsed;
          if (op.changes.userIcon !== undefined) folder.userIcon = op.changes.userIcon;
          if (op.changes.workspaceName !== undefined) folder.workspaceName = op.changes.workspaceName;
          if (op.changes.tabUrls !== undefined) folder.tabUrls = op.changes.tabUrls;
        }
        break;
      }
    }
  }
}
