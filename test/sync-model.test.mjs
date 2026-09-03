// Unit test for sync-model.js: loads the chrome script in a vm context with
// shimmed chrome globals and exercises projection, digest diff, the
// confirmed-absence tombstone invariant, the noteApplied echo-prevention
// baseline, pending-navigation holds, and sent-payload markUploaded.
//
//   node test/sync-model.test.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const MODEL_PATH = process.env.MODEL_PATH
  || join(dirname(fileURLToPath(import.meta.url)), '../extension/experiments/zenInternals/sync-model.js');

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}`); }
}

// --- fixtures / stubs ---

let sidebar = null;
const domIds = new Set();          // ids getElementById resolves
let workspaces = [];               // live gZenWorkspaces list

const fakeWindow = {
  document: { getElementById: (id) => (domIds.has(id) ? { id } : null) },
  gZenWorkspaces: { getWorkspaces: () => workspaces },
};

class FakeJSONFile {
  constructor({ dataPostProcessor }) { this._d = dataPostProcessor({}); }
  ensureDataReady() {}
  get data() { return this._d; }
  saveSoon() {}
}

const moduleStubs = {
  'resource:///modules/zen/ZenSessionManager.sys.mjs': { ZenSessionStore: { getSidebarData: () => sidebar } },
  'resource:///modules/zen/ZenWindowSync.sys.mjs': { ZenWindowSync: { get firstSyncedWindow() { return fakeWindow; } } },
  'resource:///modules/zen/ZenLiveFoldersManager.sys.mjs': { ZenLiveFoldersManager: { getSyncableFolderData: () => null } },
  'resource://gre/modules/JSONFile.sys.mjs': { JSONFile: FakeJSONFile },
  'resource:///modules/sessionstore/SessionSaver.sys.mjs': { SessionSaver: { run() {}, runDelayed() {} } },
  'resource://gre/modules/E10SUtils.sys.mjs': { E10SUtils: { serializePrincipal: () => 'p' } },
  'resource:///modules/sessionstore/TabStateCache.sys.mjs': { TabStateCache: { update() {} } },
  'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs': {
    ContextualIdentityService: { getPublicIdentities: () => [], getPublicIdentityFromId: () => null },
  },
};

const context = vm.createContext({
  console,
  TextEncoder,
  URLSearchParams,
  ChromeUtils: { importESModule: (url) => { if (!(url in moduleStubs)) throw new Error(`no stub: ${url}`); return moduleStubs[url]; } },
  Services: {
    io: { newURI: (s) => ({ query: s.split('?').slice(1).join('?') }) },
    uuid: { generateUUID: () => `{gen-${Math.random().toString(36).slice(2, 10)}}` },
  },
  PathUtils: { join: (...p) => p.join('/'), profileDir: '/tmp/fake-profile' },
});

vm.runInContext(readFileSync(MODEL_PATH, 'utf-8'), context, { filename: 'sync-model.js' });
const model = context.ZenSyncModel;
const statics = context.ZenSyncModelStatics;

// --- fixture sidebar ---

const T = (id, { url, pinned = false, essential = false, ws = 'space-1', groupId = null, entries = true, initial = null }) => ({
  zenSyncId: id,
  pinned: pinned || essential,
  zenEssential: essential,
  zenWorkspace: essential ? null : ws,
  groupId,
  userContextId: 0,
  entries: entries ? [{ url, title: 'Title of ' + id }] : [],
  index: 1,
  image: '',
  _zenPinnedInitialState: initial,
});

function fixture() {
  return {
    lastCollected: Date.now() + Math.random(),
    spaces: [
      { uuid: 'space-1', name: 'Work', icon: null, theme: null, containerTabId: 0 },
      { uuid: 'space-2', name: 'Play', icon: null, theme: null, containerTabId: 0 },
    ],
    folders: [
      // prevSiblingInfo names the folder's previous sibling → spliced after it.
      { id: 'fld-1', name: 'Folder', collapsed: false, parentId: null, workspaceId: 'space-1', userIcon: null, isLiveFolder: false, prevSiblingInfo: { type: 'tab', id: 'pin-1' } },
    ],
    splitViewData: [],
    groups: [],
    tabs: [
      T('ess-1', { url: 'https://mail.example/', essential: true, initial: { entry: { url: 'https://mail.example/', title: 'Mail' }, image: '' } }),
      T('pin-1', { url: 'https://pinned.example/live-navigated', pinned: true, initial: { entry: { url: 'https://pinned.example/', title: 'Pin' }, image: '' } }),
      T('pin-2', { url: 'https://infolder.example/', pinned: true, groupId: 'fld-1' }),
      T('norm-1', { url: 'https://normal.example/a' }),
      T('norm-2', { url: 'https://normal.example/b' }),
      T('norm-3', { url: 'https://other.example/', ws: 'space-2' }),
      T('lazy-1', { url: '', entries: false }),                 // no identity → pending
      T('scheme-1', { url: 'about:config' }),                   // non-http → pending
      { zenSyncId: '', pinned: false, entries: [{ url: 'https://noid.example/' }] }, // no id → invisible
      T('glance-1', { url: 'https://glance.example/' }),
    ],
  };
}
const fx = fixture();
fx.tabs.find(t => t.zenSyncId === 'glance-1').zenIsGlance = true;
sidebar = fx;
for (const t of fx.tabs) if (t.zenSyncId) domIds.add(t.zenSyncId);
domIds.add('fld-1');
workspaces = fx.spaces;

// --- projection ---

console.log('projection:');
model.invalidate();
const map = model.projections();
assert(map.get('space-1')?.kind === 'space', 'space projected');
assert(map.get('pin-1')?.data.url === 'https://pinned.example/', 'pinned tab identity = pin target, not live url');
assert(map.get('pin-1')?.data.pinned === true, 'pinned flag set');
assert(map.get('norm-1')?.data.url === 'https://normal.example/a', 'normal tab identity = session entry');
assert(map.get('norm-1')?.data.pinned === false && map.get('norm-1')?.data.essential === false, 'normal tab flags');
assert(map.get('ess-1')?.data.essential === true && map.get('ess-1')?.data.workspaceUuid === null, 'essential tab: no workspace');
assert(map.get('pin-2')?.data.folderId === 'fld-1', 'folder membership projected');
assert(!map.has('lazy-1') && model.pendingIds().has('lazy-1'), 'entry-less tab pending, not projected');
assert(!map.has('scheme-1') && model.pendingIds().has('scheme-1'), 'non-http tab pending, not projected');
assert(!map.has('glance-1'), 'glance tab excluded');
const space1 = map.get('space-1').data;
assert(JSON.stringify(space1.children) === JSON.stringify(['pin-1', 'fld-1']), `pinned children ordered (got ${JSON.stringify(space1.children)})`);
assert(JSON.stringify(space1.normalChildren) === JSON.stringify(['norm-1', 'norm-2']), `normalChildren ordered (got ${JSON.stringify(space1.normalChildren)})`);
assert(JSON.stringify(map.get('space-2').data.normalChildren) === JSON.stringify(['norm-3']), 'space-2 normalChildren');
assert(JSON.stringify(map.get('fld-1').data.children) === JSON.stringify(['pin-2']), 'folder children');
const layout = map.get('layout').data;
assert(JSON.stringify(layout.spaces) === JSON.stringify(['space-1', 'space-2']), 'layout space order');
assert(JSON.stringify(layout.essentials.default) === JSON.stringify(['ess-1']), 'layout essentials');

// --- digest diff / baseline ---

console.log('digest diff:');
let changes = model.computeChanges();
assert(changes.changed.length === map.size && changes.deleted.length === 0, 'everything changed on first diff');
model.markUploaded({ records: changes.changed.map(c => ({ id: c.id, kind: c.kind, data: c.data })), deleted: changes.deleted });
model.invalidate();
changes = model.computeChanges();
assert(changes.changed.length === 0 && changes.deleted.length === 0, 'quiescent after markUploaded');

// Idempotence golden test: projections re-projected → identical digests.
const digestsA = changes; // quiescent already proves it, but double-check via canonicalJSON
const again = model.projections();
assert(statics.canonicalJSON([...again.values()]) === statics.canonicalJSON([...model.projections().values()]), 'projection stable');

// --- R1: deletion requires confirmed absence ---

console.log('tombstone invariant:');
// Tab vanishes from projection but its DOM element still exists (transient
// capture gap) → must NOT be a deletion.
sidebar = fixture();
sidebar.tabs = sidebar.tabs.filter(t => t.zenSyncId !== 'norm-2');
model.invalidate();
changes = model.computeChanges();
assert(!changes.deleted.includes('norm-2'), 'projection-missing but DOM-present tab is NOT deleted');
assert(changes.changed.some(c => c.id === 'space-1'), 'space children change still emitted');
// Now the DOM element is gone too → real deletion.
domIds.delete('norm-2');
model.invalidate();
changes = model.computeChanges();
assert(changes.deleted.includes('norm-2'), 'DOM-absent tab IS deleted');
// Pending tab (lazy, no identity) present in uploaded must never delete.
assert(!changes.deleted.includes('lazy-1') && !changes.deleted.includes('scheme-1'), 'pending ids never deleted');
domIds.add('norm-2');

// --- noteApplied echo prevention ---

console.log('noteApplied echo:');
sidebar = fixture();
model.invalidate();
const rec = model.projectRecord('norm-1');
model.noteApplied('norm-1', { kind: rec.kind, data: rec.data });
changes = model.computeChanges();
assert(!changes.changed.some(c => c.id === 'norm-1'), 'faithful materialization emits nothing');
// Divergent materialization re-uploads local truth.
model.noteApplied('norm-1', { kind: 'tab', data: { ...rec.data, url: 'https://remote-different.example/' } });
changes = model.computeChanges();
assert(changes.changed.some(c => c.id === 'norm-1'), 'divergent materialization self-heals');

// --- holds excluded from diff ---

console.log('holds:');
model.setHold('norm-1', { url: 'https://remote-different.example/', title: '', icon: '', localUrl: 'https://normal.example/a' });
changes = model.computeChanges();
assert(!changes.changed.some(c => c.id === 'norm-1'), 'held id excluded from outgoing diff');
model.dropHold('norm-1');
changes = model.computeChanges();
assert(changes.changed.some(c => c.id === 'norm-1'), 'dropped hold re-enters diff');

// --- title canonicalization ---

console.log('canonicalization:');
sidebar = fixture();
sidebar.tabs.find(t => t.zenSyncId === 'norm-1').entries[0].title = 'https://normal.example/a';
model.invalidate();
assert(model.projectRecord('norm-1').data.title === '', 'mid-load title (== url) canonicalized to empty');

// --- ghost prevention: baseline advances from the SENT payload ---

console.log('markUploaded from sent payload:');
sidebar = fixture();
model.invalidate();
const sentRec = model.projectRecord('norm-3');
// The tab closes while its upload is in flight...
sidebar = fixture();
sidebar.tabs = sidebar.tabs.filter(t => t.zenSyncId !== 'norm-3');
domIds.delete('norm-3');
model.invalidate();
// ...then the ack arrives. The baseline must be advanced from what was
// SENT, so the closed tab still gets its tombstone on the next diff.
model.markUploaded({ records: [{ id: 'norm-3', kind: sentRec.kind, data: sentRec.data }], deleted: [] });
changes = model.computeChanges();
assert(changes.deleted.includes('norm-3'), 'in-flight-closed tab still emits its tombstone (no server ghost)');
domIds.add('norm-3');

console.log(failures === 0 ? '\nALL MODEL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
