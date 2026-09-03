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

// v3 record protocol. v2 shipped schemaVersion 3 on the wire, so 4 forces
// old clients into the reset path.
const SCHEMA_VERSION = 4;

const RECORD_KINDS = new Set(['container', 'space', 'tab', 'folder', 'split', 'layout']);
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 1024;
const MAX_ICON_LENGTH = 128 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;

// --- Canonical digest (matches the client's sorted-key serialization) ---

function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortedClone(value[k]);
    return out;
  }
  return value === undefined ? null : value;
}

function recordDigest(kind, data) {
  return createHash('sha256').update(JSON.stringify(sortedClone({ kind, data }))).digest('base64');
}

// --- Validation ---

function isSyncableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'));
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') return 'not an object';
  if (typeof record.id !== 'string' || !record.id || record.id.length > MAX_ID_LENGTH) return 'bad id';
  if (!RECORD_KINDS.has(record.kind)) return `unknown kind ${record.kind}`;
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return 'bad data';
  if (record.kind === 'tab') {
    if (!isSyncableUrl(record.data.url)) return 'tab url must be http(s)';
    if (typeof record.data.title === 'string' && record.data.title.length > MAX_TITLE_LENGTH) {
      record.data.title = record.data.title.slice(0, MAX_TITLE_LENGTH);
    }
  }
  // Icon fields on any kind (tab image, folder userIcon, space icon) are
  // capped — one oversized data: blob would otherwise bloat every future
  // auth_ok/state_records replay.
  if (typeof record.data.icon === 'string' && record.data.icon.length > MAX_ICON_LENGTH) {
    record.data.icon = '';
  }
  if (JSON.stringify(record.data).length > MAX_RECORD_BYTES) return 'record too large';
  return null;
}

// --- State ---

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    generation: randomBytes(8).toString('hex'),
    version: 0,
    records: {},
    tombstones: {},
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
      parsed.records ||= {};
      parsed.tombstones ||= {};
      return parsed;
    }
  } catch (e) {
    console.error('Corrupt state file, resetting:', e.message);
  }
  return emptyState();
}

function gcTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  let dropped = 0;
  for (const [id, t] of Object.entries(state.tombstones)) {
    if ((t.deletedAt || 0) < cutoff) {
      delete state.tombstones[id];
      dropped++;
    }
  }
  if (dropped) {
    console.log(`[gc] dropped ${dropped} expired tombstones`);
    scheduleSave();
  }
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
gcTombstones();
setInterval(gcTombstones, 24 * 60 * 60 * 1000).unref();

// --- Logging ---

function countsByKind() {
  const counts = {};
  for (const rec of Object.values(state.records)) {
    counts[rec.kind] = (counts[rec.kind] || 0) + 1;
  }
  return counts;
}

function logState(label) {
  const c = countsByKind();
  const tombs = Object.keys(state.tombstones).length;
  console.log(
    `[state] ${label} | v${state.version} gen=${state.generation} | ` +
    `spaces:${c.space || 0} folders:${c.folder || 0} tabs:${c.tab || 0} ` +
    `splits:${c.split || 0} containers:${c.container || 0} tombstones:${tombs}`
  );
}

function describeRecord(record) {
  const d = record.data || {};
  switch (record.kind) {
    case 'tab': {
      const kind = d.essential ? 'essential' : d.pinned ? 'pinned' : 'normal';
      return `tab(${kind}) ${(d.url || '').slice(0, 70)}`;
    }
    case 'space': return `space "${d.name}"`;
    case 'folder': return `folder "${d.name}" ws=${d.workspaceUuid}`;
    case 'split': return `split ${d.tabs?.length ?? 0} tabs`;
    case 'container': return `container "${d.name}"`;
    case 'layout': return `layout ${d.spaces?.length ?? 0} spaces`;
    default: return record.kind;
  }
}

// --- Tokens ---

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

// --- Record operations ---

function recordsPayload() {
  return Object.entries(state.records).map(([id, rec]) => ({ id, kind: rec.kind, data: rec.data }));
}

/**
 * Applies a put_records message. Idempotent per record: a payload whose
 * digest equals the stored one is a no-op (no seq bump, no broadcast) so
 * ack-lost re-uploads never echo through the fleet.
 */
function applyPut(msg, deviceId) {
  const changed = [];
  const removed = [];
  const accepted = [];
  const rejected = [];

  for (const record of msg.records || []) {
    const problem = validateRecord(record);
    if (problem) {
      rejected.push({ id: record?.id ?? '?', problem });
      continue;
    }
    accepted.push(record.id);
    const digest = recordDigest(record.kind, record.data);
    const existing = state.records[record.id];
    if (existing && existing.digest === digest) {
      continue; // no-op re-upload
    }
    state.version++;
    state.records[record.id] = {
      kind: record.kind,
      data: record.data,
      digest,
      seq: state.version,
      deviceId,
      lastModified: Date.now(),
    };
    // An update after a deletion recreates the record (last writer wins).
    delete state.tombstones[record.id];
    changed.push({ id: record.id, kind: record.kind, data: record.data });
  }

  const upsertedIds = new Set(changed.map(r => r.id));
  const deleteRecord = (id) => {
    state.version++;
    delete state.records[id];
    state.tombstones[id] = { seq: state.version, deletedAt: Date.now() };
    removed.push(id);
  };

  for (const id of msg.deleted || []) {
    if (typeof id !== 'string' || !id || id === 'layout') continue;
    accepted.push(id);
    if (!state.records[id]) continue;
    const wasSpace = state.records[id].kind === 'space';
    deleteRecord(id);
    if (wasSpace) {
      // Cascade: a racing update can otherwise durably orphan records that
      // reference the deleted space (deleting locally closes owned tabs, so
      // the deleting client's tombstones normally cover these — this is the
      // race repair). Records upserted in the SAME message keep their new
      // placement.
      for (const [rid, rec] of Object.entries(state.records)) {
        if (!upsertedIds.has(rid) && rec.data?.workspaceUuid === id) {
          deleteRecord(rid);
        }
      }
    }
  }

  return { changed, removed, accepted, rejected };
}

// --- WebSocket server ---

const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 * 1024 });
const clients = new Map();

console.log(`Zen Sidebar Sync server listening on ws://0.0.0.0:${PORT} (schema v${SCHEMA_VERSION})`);
logState('startup');

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
          generation: state.generation,
          version: state.version,
          records: recordsPayload(),
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
        case 'put_records': {
          const putCount = (msg.records || []).length;
          // Mass-removal guard: second line of defense behind the client
          // capture guard. Only deletions that would actually remove an
          // existing record count — an ack-lost replay of an already-applied
          // deletion batch must pass, not wedge sync forever. The client can
          // re-send with force after explicit user confirmation.
          const effectiveDel = (msg.deleted || []).filter(id => state.records[id]).length;
          const currentCount = Object.keys(state.records).length;
          if (!msg.force && currentCount > 30 && effectiveDel > currentCount * 0.9) {
            console.warn(`[${deviceId}] REJECTED put_records: ${effectiveDel}/${currentCount} deletions (>90%)`);
            ws.send(JSON.stringify({
              type: 'put_rejected',
              reqId: msg.reqId,
              reason: 'mass_delete',
              wouldDelete: effectiveDel,
              current: currentCount,
            }));
            break;
          }
          const delCount = (msg.deleted || []).length;

          const result = applyPut(msg, deviceId);
          console.log(`[${deviceId}] ← put_records (${putCount} records, ${delCount} deleted)`);
          for (const rec of result.changed) console.log(`  upsert ${describeRecord(rec)}`);
          for (const id of result.removed) console.log(`  delete ${id}`);
          for (const rej of result.rejected) console.warn(`  rejected ${rej.id}: ${rej.problem}`);

          if (result.changed.length || result.removed.length) {
            state.lastModified = Date.now();
            scheduleSave();
            logState('after put_records');
          }

          ws.send(JSON.stringify({
            type: 'records_accepted',
            reqId: msg.reqId,
            ids: result.accepted,
            rejected: result.rejected,
            version: state.version,
          }));
          if (result.changed.length || result.removed.length) {
            broadcast(ws, {
              type: 'records_update',
              records: result.changed,
              deleted: result.removed,
              version: state.version,
              sourceDevice: deviceId,
            });
          }
          break;
        }

        case 'request_state': {
          ws.send(JSON.stringify({
            type: 'state_records',
            generation: state.generation,
            version: state.version,
            records: recordsPayload(),
          }));
          break;
        }

        case 'replace_state': {
          // Initial "Push local": caller asserts authority. Compare-and-swap
          // on version so two devices choosing "push local" within seconds
          // can't silently clobber each other — the loser re-prompts.
          if (typeof msg.baseVersion === 'number' && msg.baseVersion !== state.version) {
            console.warn(`[${deviceId}] replace_state CONFLICT (base ${msg.baseVersion} != v${state.version})`);
            ws.send(JSON.stringify({
              type: 'replace_conflict',
              version: state.version,
              counts: countsByKind(),
            }));
            break;
          }
          const incoming = [];
          for (const record of msg.records || []) {
            const problem = validateRecord(record);
            if (problem) {
              console.warn(`  replace_state rejected record ${record?.id}: ${problem}`);
              continue;
            }
            incoming.push(record);
          }
          state.records = {};
          state.tombstones = {};
          for (const record of incoming) {
            state.version++;
            state.records[record.id] = {
              kind: record.kind,
              data: record.data,
              digest: recordDigest(record.kind, record.data),
              seq: state.version,
              deviceId,
              lastModified: Date.now(),
            };
          }
          state.lastModified = Date.now();
          scheduleSave();
          console.log(`[${deviceId}] ← replace_state (${incoming.length} records)`);
          logState('after replace_state');

          ws.send(JSON.stringify({
            type: 'replace_accepted',
            ids: incoming.map(r => r.id),
            generation: state.generation,
            version: state.version,
          }));
          broadcast(ws, {
            type: 'state_records',
            generation: state.generation,
            version: state.version,
            records: recordsPayload(),
            sourceDevice: deviceId,
          });
          break;
        }

        case 'admin_reset_state': {
          // Wipe the server state (NEW generation — clients must re-run the
          // initial-sync direction prompt) AND force every connected device
          // off, so the admin client's own capture loop can't silently
          // repopulate the state seconds later.
          state = emptyState();
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
