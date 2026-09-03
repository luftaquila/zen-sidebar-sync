// Protocol test for the v3 record server. Self-contained: spawns the
// server with a temp DATA_DIR and a seeded token, runs the suite, kills it.
//
//   cd server && npm install && cd .. && node test/server-protocol.test.mjs
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(join(repoRoot, 'server/package.json'));
const WebSocket = require_('ws').WebSocket;

const PORT = process.env.PORT || '9333';
const TOKEN = 'testtoken';
let failures = 0;

const dataDir = mkdtempSync(join(tmpdir(), 'zen-sync-test-'));
writeFileSync(
  join(dataDir, 'tokens.json'),
  JSON.stringify({ [createHash('sha256').update(TOKEN).digest('hex')]: { name: 'test', createdAt: 0 } })
);
const server = spawn(process.execPath, [join(repoRoot, 'server/server.js')], {
  env: { ...process.env, DATA_DIR: dataDir, PORT },
  stdio: 'ignore',
});
process.on('exit', () => {
  try { server.kill(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
await new Promise((r) => setTimeout(r, 800));

function assert(cond, label) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
}

function connect(deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        inbox.push(msg);
      }
    });
    ws.on('error', reject);
    const client = {
      ws,
      inbox,
      send: (obj) => ws.send(JSON.stringify(obj)),
      expect: (type, timeout = 3000) =>
        new Promise((res, rej) => {
          const idx = inbox.findIndex((m) => m.type === type);
          if (idx !== -1) {
            return res(inbox.splice(idx, 1)[0]);
          }
          const waiter = { type, resolve: res };
          waiters.push(waiter);
          setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at !== -1) {
              waiters.splice(at, 1);
              rej(new Error(`timeout waiting for ${type}`));
            }
          }, timeout);
        }),
    };
    ws.on('open', () => {
      client.send({ type: 'auth', token: TOKEN, deviceId, deviceName: deviceId });
      client.expect('auth_ok').then((msg) => resolve({ client, auth: msg }), reject);
    });
  });
}

const tab = (id, url, extra = {}) => ({
  id,
  kind: 'tab',
  data: { tabId: id, url, title: '', icon: '', containerGuid: null, essential: false, pinned: false,
          workspaceUuid: 'ws-1', folderId: null, staticLabel: null, hasStaticIcon: false, defaultContainer: false, ...extra },
});

const { client: a, auth: authA } = await connect('dev-a');
console.log('auth:');
assert(authA.schemaVersion === 4, 'auth_ok schemaVersion 4');
assert(typeof authA.generation === 'string' && authA.generation.length > 0, 'auth_ok has generation');
assert(Array.isArray(authA.records) && authA.records.length === 0, 'fresh server has no records');

const { client: b } = await connect('dev-b');

console.log('put_records upsert:');
a.send({ type: 'put_records', records: [
  { id: 'ws-1', kind: 'space', data: { uuid: 'ws-1', name: 'Work', icon: null, theme: null, containerGuid: null, children: [], normalChildren: ['t1'] } },
  tab('t1', 'https://example.com/'),
  { id: 'bad1', kind: 'tab', data: { tabId: 'bad1', url: 'javascript:alert(1)' } },
  { id: 'bad2', kind: 'nonsense', data: {} },
], deleted: [] });
const acc1 = await a.expect('records_accepted');
assert(acc1.ids.includes('ws-1') && acc1.ids.includes('t1'), 'valid records accepted');
assert(acc1.rejected.some(r => r.id === 'bad1') && acc1.rejected.some(r => r.id === 'bad2'), 'invalid records rejected');
const upd1 = await b.expect('records_update');
assert(upd1.records.length === 2 && upd1.deleted.length === 0, 'peer got broadcast of 2 upserts');
const v1 = acc1.version;

console.log('idempotent re-upload:');
a.send({ type: 'put_records', records: [tab('t1', 'https://example.com/')], deleted: [] });
const acc2 = await a.expect('records_accepted');
assert(acc2.version === v1, 'no seq bump on identical payload');
let echoed = false;
try { await b.expect('records_update', 500); echoed = true; } catch {}
assert(!echoed, 'no broadcast on identical payload');

console.log('delete + tombstone:');
a.send({ type: 'put_records', records: [], deleted: ['t1'] });
const acc3 = await a.expect('records_accepted');
assert(acc3.ids.includes('t1'), 'delete acknowledged');
const upd2 = await b.expect('records_update');
assert(upd2.deleted.includes('t1'), 'peer got delete broadcast');

console.log('update-after-delete recreates:');
a.send({ type: 'put_records', records: [tab('t1', 'https://example.com/2')], deleted: [] });
await a.expect('records_accepted');
const upd3 = await b.expect('records_update');
assert(upd3.records.some(r => r.id === 't1'), 'recreated record broadcast');

console.log('mass-delete guard:');
const many = [];
for (let i = 0; i < 40; i++) many.push(tab(`m${i}`, `https://example.com/m${i}`));
a.send({ type: 'put_records', records: many, deleted: [] });
await a.expect('records_accepted');
await b.expect('records_update');
a.send({ type: 'put_records', records: [], deleted: many.map(r => r.id).concat(['t1', 'ws-1']), reqId: 'guard-1' });
const rej0 = await a.expect('put_rejected');
assert(rej0.reason === 'mass_delete' && rej0.reqId === 'guard-1', 'guard rejected >90% deletion (structured)');

console.log('replace_state CAS:');
b.send({ type: 'request_state' });
const st = await b.expect('state_records');
b.send({ type: 'replace_state', records: [tab('r1', 'https://replaced.example/')], baseVersion: st.version - 1 });
const conflict = await b.expect('replace_conflict');
assert(typeof conflict.version === 'number', 'stale baseVersion → replace_conflict');
b.send({ type: 'replace_state', records: [tab('r1', 'https://replaced.example/')], baseVersion: st.version });
const racc = await b.expect('replace_accepted');
assert(racc.ids.includes('r1'), 'fresh baseVersion → replace_accepted');
const bstate = await a.expect('state_records');
assert(bstate.records.length === 1 && bstate.records[0].id === 'r1', 'peer got replaced full state');

console.log('reqId echo / guard semantics / cascade / size cap:');
// Seed: 1 space + 99 tabs (+ r1 from the replace) = 101 records.
const seed = [{ id: 'ws-c', kind: 'space', data: { uuid: 'ws-c', name: 'C', icon: null, theme: null, containerGuid: null, children: [], normalChildren: [] } }];
for (let i = 0; i < 99; i++) seed.push(tab(`c${i}`, `https://c.example/${i}`, { workspaceUuid: 'ws-c' }));
a.send({ type: 'put_records', records: seed, deleted: [], reqId: 'req-1' });
const acc4 = await a.expect('records_accepted');
assert(acc4.reqId === 'req-1', 'records_accepted echoes reqId');
await b.expect('records_update');

// 60/101 deletions (59%) pass; ack "lost" → replay the same 60 against the
// 41 remaining records: effective deletions are 0, so the guard must pass
// (the old count-based guard would wedge here forever).
const del60 = [];
for (let i = 0; i < 60; i++) del60.push(`c${i}`);
a.send({ type: 'put_records', records: [], deleted: del60, reqId: 'req-2' });
await a.expect('records_accepted');
await b.expect('records_update');
a.send({ type: 'put_records', records: [], deleted: del60, reqId: 'req-3' });
const acc5 = await a.expect('records_accepted');
assert(acc5.reqId === 'req-3' && acc5.ids.length === 60, 'ack-lost deletion replay passes the guard');

// Deleting everything left (41/41) trips the guard with a structured
// rejection; force (user-confirmed) passes.
const delRest = ['ws-c', 'r1'];
for (let i = 60; i < 99; i++) delRest.push(`c${i}`);
a.send({ type: 'put_records', records: [], deleted: delRest, reqId: 'req-4' });
const rej = await a.expect('put_rejected');
assert(rej.reqId === 'req-4' && rej.reason === 'mass_delete', 'structured put_rejected with reqId');
a.send({ type: 'put_records', records: [], deleted: delRest, reqId: 'req-5', force: true });
const acc6 = await a.expect('records_accepted');
assert(acc6.reqId === 'req-5', 'forced mass delete accepted');
await b.expect('records_update');

// Space deletion cascades to records still referencing it (race repair).
a.send({ type: 'put_records', records: [
  { id: 'ws-d', kind: 'space', data: { uuid: 'ws-d', name: 'D', icon: null, theme: null, containerGuid: null, children: [], normalChildren: [] } },
  tab('d1', 'https://d.example/1', { workspaceUuid: 'ws-d' }),
  tab('d2', 'https://d.example/2', { workspaceUuid: 'ws-d' }),
], deleted: [], reqId: 'req-6' });
await a.expect('records_accepted');
await b.expect('records_update');
b.send({ type: 'put_records', records: [], deleted: ['ws-d'], reqId: 'req-7' });
await b.expect('records_accepted');
const upd5 = await a.expect('records_update');
assert(upd5.deleted.includes('ws-d') && upd5.deleted.includes('d1') && upd5.deleted.includes('d2'),
  'space delete cascades to orphaned members');

// Oversized record rejected.
a.send({ type: 'put_records', records: [
  { id: 'big', kind: 'space', data: { uuid: 'big', name: 'x'.repeat(600 * 1024) } },
], deleted: [], reqId: 'req-8' });
const acc7 = await a.expect('records_accepted');
assert(acc7.rejected.some(r => r.id === 'big'), 'oversized record rejected');

console.log('admin reset:');
a.send({ type: 'admin_reset_state' });
await a.expect('admin_ok');
const fd1 = await a.expect('force_disable');
const fd2 = await b.expect('force_disable');
assert(fd1 && fd2, 'force_disable broadcast to all incl. sender');
const { auth: authC } = await connect('dev-c');
assert(authC.records.length === 0, 'state wiped after reset');
assert(authC.generation !== authA.generation, 'reset produced a NEW generation');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
