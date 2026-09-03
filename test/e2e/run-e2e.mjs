// Two-profile end-to-end test against a real Zen build.
//
//   ZEN_BIN="/path/to/Twilight.app/Contents/MacOS/zen" node test/e2e/run-e2e.mjs
//
// Spawns the sync server + a tiny http server, launches two throwaway Zen
// profiles with Marionette, installs the extension temporarily, provisions
// it via extensions.zenSidebarSync.* prefs (A: autoInitial=push, B:
// autoInitial=replace), then walks the milestone gates:
//   M1  ids stable / records reach the server with correct kinds
//   M2  upload quiescence (no put churn while idle)
//   M3  echo-free materialization (B applies everything, uploads nothing)
//   M4  realtime matrix: open/close/navigate/pin/unpin/space-rename/folder
//   M5  final quiescence (no A↔B ping-pong)
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, rmSync, createWriteStream, readFileSync, existsSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { Marionette } from './marionette.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(repoRoot, 'server/package.json'));
const WebSocket = require_('ws').WebSocket;

const ZEN_BIN = process.env.ZEN_BIN;
if (!ZEN_BIN || !existsSync(ZEN_BIN)) {
  console.error('Set ZEN_BIN to a Zen binary (Twilight 1.22t+), e.g. .../Twilight.app/Contents/MacOS/zen');
  process.exit(2);
}

const SYNC_PORT = 9444;
const HTTP_PORT = 9445;
const TOKEN = 'e2etoken';
const WORK = process.env.E2E_WORK || join(tmpdir(), `zen-sync-e2e-${Date.now()}`);
mkdirSync(WORK, { recursive: true });
console.log(`workdir: ${WORK}`);

const children = [];
let failures = 0;
const results = [];

function ok(label, extra = '') {
  results.push(`  ok    ${label}${extra ? ` (${extra})` : ''}`);
  console.log(results[results.length - 1]);
}
function fail(label, extra = '') {
  failures++;
  results.push(`  FAIL  ${label}${extra ? ` (${extra})` : ''}`);
  console.log(results[results.length - 1]);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitUntil(fn, { timeout = 30000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (e) {
      value = null;
    }
    if (value) return { value, elapsed: Date.now() - start };
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(interval);
  }
}

// --- sync server + http server ---

const serverData = join(WORK, 'server');
mkdirSync(serverData, { recursive: true });
writeFileSync(
  join(serverData, 'tokens.json'),
  JSON.stringify({ [createHash('sha256').update(TOKEN).digest('hex')]: { name: 'e2e', createdAt: 0 } })
);
const serverLog = createWriteStream(join(WORK, 'server.log'), { flags: 'a' });
let serverProc = null;
function startSyncServer() {
  serverProc = spawn(process.execPath, [join(repoRoot, 'server/server.js')], {
    env: { ...process.env, DATA_DIR: serverData, PORT: String(SYNC_PORT) },
  });
  serverProc.stdout.pipe(serverLog);
  serverProc.stderr.pipe(serverLog);
  children.push(serverProc);
  return serverProc;
}
function stopSyncServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.once('exit', resolve);
    serverProc.kill('SIGKILL');
  });
}
startSyncServer();

const httpServer = http.createServer((req, res) => {
  const n = req.url.split('/').pop() || '0';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Page ${n}</title><h1>Page ${n}</h1>`);
});
httpServer.listen(HTTP_PORT);
const page = (n) => `http://127.0.0.1:${HTTP_PORT}/p/${n}`;

// --- observer: mirrors server state, logs broadcasts ---

class Observer {
  records = new Map();
  version = 0;
  broadcasts = [];
  #ws;
  #ready;

  connect() {
    this.#ws = new WebSocket(`ws://127.0.0.1:${SYNC_PORT}`);
    this.#ready = new Promise((resolve, reject) => {
      this.#ws.on('open', () => {
        this.#ws.send(JSON.stringify({ type: 'auth', token: TOKEN, deviceId: 'observer', deviceName: 'observer' }));
      });
      this.#ws.on('error', reject);
      this.#ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        switch (msg.type) {
          case 'auth_ok':
            this.records = new Map(msg.records.map((r) => [r.id, r]));
            this.version = msg.version;
            resolve();
            break;
          case 'records_update':
            for (const r of msg.records) this.records.set(r.id, r);
            for (const id of msg.deleted) this.records.delete(id);
            this.version = msg.version;
            this.broadcasts.push({ at: Date.now(), source: msg.sourceDevice, ids: msg.records.map((r) => r.id), deleted: msg.deleted });
            break;
          case 'state_records':
            this.records = new Map(msg.records.map((r) => [r.id, r]));
            this.version = msg.version;
            this.broadcasts.push({ at: Date.now(), source: msg.sourceDevice || 'replace', ids: msg.records.map((r) => r.id), deleted: [] });
            break;
        }
      });
    });
    return this.#ready;
  }

  tab(id) {
    const r = this.records.get(id);
    return r?.kind === 'tab' ? r.data : null;
  }

  counts() {
    const c = { space: 0, tab: 0, folder: 0, split: 0, layout: 0, container: 0 };
    for (const [, r] of this.records) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }

  broadcastsSince(t) {
    return this.broadcasts.filter((b) => b.at >= t);
  }

  // Raw put from the observer (used to simulate a poisoned/foreign writer).
  put(records, deleted, { force = false } = {}) {
    this.#ws.send(JSON.stringify({ type: 'put_records', records, deleted, reqId: `obs-${Date.now()}`, force, deviceId: 'observer' }));
  }

  requestState() {
    this.#ws.send(JSON.stringify({ type: 'request_state' }));
  }

  close() {
    try { this.#ws.close(); } catch {}
  }
}

// --- profiles ---

function makeProfile(name, marionettePort, autoInitial) {
  const dir = join(WORK, `profile-${name}`);
  mkdirSync(dir, { recursive: true });
  const prefs = [
    ['marionette.port', marionettePort],
    ['browser.shell.checkDefaultBrowser', false],
    ['app.update.disabledForTesting', true],
    ['datareporting.policy.dataSubmissionEnabled', false],
    ['toolkit.telemetry.reportingpolicy.firstRun', false],
    ['browser.sessionstore.resume_from_crash', false],
    ['browser.aboutwelcome.enabled', false],
    ['startup.homepage_welcome_url', ''],
    ['startup.homepage_override_url', ''],
    ['zen.welcome-screen.seen', true],
    ['xpinstall.signatures.required', false],
    ['extensions.experiments.enabled', true],
    ['services.sync.engine.spaces', false],
    // Single-string invite (exercises the same path a user pastes into the
    // popup); the serverUrl/token pair is the legacy fallback.
    ['extensions.zenSidebarSync.invite', `zensync://127.0.0.1:${SYNC_PORT}/?t=${TOKEN}&s=0`],
    ['extensions.zenSidebarSync.deviceName', name],
    ['extensions.zenSidebarSync.enabled', true],
    ['extensions.zenSidebarSync.autoInitial', autoInitial],
  ];
  writeFileSync(
    join(dir, 'user.js'),
    prefs.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')
  );
  return dir;
}

async function launchZen(name, profileDir, marionettePort) {
  const log = createWriteStream(join(WORK, `${name}.log`));
  const proc = spawn(ZEN_BIN, ['--marionette', '--remote-allow-system-access', '-no-remote', '-profile', profileDir], {
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' },
  });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  children.push(proc);
  const mar = await Marionette.connect(marionettePort, { timeoutMs: 120000 });
  // 'ignore' keeps unexpected dialogs open so aborts can capture their text.
  await mar.newSession({ capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } } });
  await mar.setContext('chrome');
  return { proc, mar, name };
}

async function installExtension(mar) {
  return mar.installAddon(join(repoRoot, 'extension'), true);
}

async function dumpConsole(mar, name) {
  try {
    const alert = await mar.alertText();
    if (alert !== null) {
      console.log(`--- ${name} OPEN DIALOG: ${JSON.stringify(alert)} ---`);
      await mar.dismissAlert();
    }
    const lines = await mar.executeScript(`
      const msgs = Services.console.getMessageArray().map(m => {
        try {
          if (m instanceof Ci.nsIScriptError) {
            return "[err] " + m.errorMessage + " @ " + (m.sourceName || "?") + ":" + m.lineNumber;
          }
          return m.message || String(m);
        } catch (e) { return String(m); }
      });
      const ours = msgs.filter(s => s.includes('ZenSync') || s.includes('ZenSidebarSync') || s.includes('zen-sidebar-sync'));
      const errs = msgs.filter(s => s.startsWith('[err]')).slice(-15);
      return [...ours.slice(-40), '--- last errors ---', ...errs];
    `);
    console.log(`--- ${name} console ---`);
    for (const line of lines || []) console.log(`  ${line}`);
  } catch (e) {
    console.log(`(console dump failed for ${name}: ${e.message})`);
  }
}

// --- teardown ---

let browsers = [];
async function teardown() {
  for (const { mar } of browsers) {
    try {
      await mar.executeScript('Services.startup.quit(Services.startup.eForceQuit);');
    } catch {}
    try { mar.close(); } catch {}
  }
  await sleep(1500);
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
  }
  httpServer.close();
}
process.on('SIGINT', async () => { await teardown(); process.exit(130); });

// =====================================================================
// scenario
// =====================================================================

let observer = new Observer();

function waitProcExit(proc, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('process did not exit')), timeout);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

try {
  await sleep(800);
  await observer.connect();
  ok('server up, observer connected');

  // --- Device A ---
  const profileA = makeProfile('e2e-a', 2830, 'push');
  let a = await launchZen('zen-a', profileA, 2830);
  browsers.push(a);
  ok('Zen A launched (marionette ready)');

  // Seed content BEFORE the extension exists: 3 normal tabs, then pin one
  // and make one essential. Ids are assigned by Zen's queued TabOpen
  // handler, so read them after a settle delay.
  const seeded = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const { gBrowser, gZenPinnedTabManager } = window;
    const t1 = gBrowser.addTrustedTab(${JSON.stringify(page(1))}, { inBackground: true });
    const t2 = gBrowser.addTrustedTab(${JSON.stringify(page(2))}, { inBackground: true });
    const t3 = gBrowser.addTrustedTab(${JSON.stringify(page(3))}, { inBackground: true });
    setTimeout(() => {
      gBrowser.pinTab(t2);
      gZenPinnedTabManager.addToEssentials(t3);
      setTimeout(() => done({ t1: t1.id, t2: t2.id, t3: t3.id, ws: window.gZenWorkspaces.activeWorkspace }), 1000);
    }, 1500);
  `);
  if (!seeded?.t1 || !seeded?.t2 || !seeded?.t3) throw new Error(`seeding failed: ${JSON.stringify(seeded)}`);
  ok('A seeded: 1 normal + 1 pinned + 1 essential tab', `ids ${seeded.t1}/${seeded.t2}/${seeded.t3}`);

  await installExtension(a.mar);
  ok('extension installed on A (temporary)');

  // A autoInitial=push → replace_state → server populated.
  const push = await waitUntil(
    () => observer.tab(seeded.t1) && observer.tab(seeded.t2) && observer.tab(seeded.t3),
    { timeout: 90000, label: 'A initial push' }
  );
  ok('M1: A pushed initial state', `${push.elapsed}ms`);

  const t1r = observer.tab(seeded.t1);
  const t2r = observer.tab(seeded.t2);
  const t3r = observer.tab(seeded.t3);
  t1r && !t1r.pinned && !t1r.essential && t1r.url === page(1)
    ? ok('M1: normal tab record correct')
    : fail('M1: normal tab record', JSON.stringify(t1r));
  t2r && t2r.pinned && !t2r.essential
    ? ok('M1: pinned tab record correct')
    : fail('M1: pinned tab record', JSON.stringify(t2r));
  t3r && t3r.essential
    ? ok('M1: essential tab record correct')
    : fail('M1: essential tab record', JSON.stringify(t3r));
  const c0 = observer.counts();
  c0.space >= 1 && c0.layout === 1
    ? ok('M1: space + layout records present', JSON.stringify(c0))
    : fail('M1: space/layout records', JSON.stringify(c0));

  // --- M2: quiescence on an idle device ---
  await sleep(12000); // allow the self-heal window to settle
  const vQuiet = observer.version;
  await sleep(15000);
  observer.version === vQuiet
    ? ok('M2: idle quiescence (no put churn in 15s)')
    : fail('M2: idle quiescence', `version ${vQuiet} → ${observer.version}`);

  // --- Device B ---
  const profileB = makeProfile('e2e-b', 2831, 'replace');
  const b = await launchZen('zen-b', profileB, 2831);
  browsers.push(b);
  ok('Zen B launched');
  await installExtension(b.mar);
  ok('extension installed on B (temporary)');

  const checkB = (id, expr) => b.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    return ${expr};
  `);

  const mat = await waitUntil(
    async () =>
      (await checkB(seeded.t1, 'true')) &&
      (await checkB(seeded.t2, 'el.pinned === true')) &&
      (await checkB(seeded.t3, 'el.hasAttribute("zen-essential")')),
    { timeout: 120000, label: 'B materialization' }
  );
  ok("M3: B materialized A's state with identical ids", `${mat.elapsed}ms`);

  const bWs = await b.mar.executeScript('return window.gZenWorkspaces.getWorkspaces().map(w => w.uuid);');
  bWs.includes(seeded.ws)
    ? ok('M3: workspace uuid adopted verbatim on B')
    : fail('M3: workspace uuid adoption', JSON.stringify(bWs));

  // --- M3: echo-free (B applied everything, uploads nothing) ---
  await sleep(8000);
  const echoWindowStart = Date.now();
  const vEcho = observer.version;
  await sleep(15000);
  const echoes = observer.broadcastsSince(echoWindowStart);
  observer.version === vEcho && echoes.length === 0
    ? ok('M3: echo-free materialization (no puts from B in 15s)')
    : fail('M3: echo-free materialization', `version ${vEcho}→${observer.version}, broadcasts ${JSON.stringify(echoes)}`);

  // --- M4: realtime matrix ---

  // (a) open on A → appears on B
  const t4id = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const tab = window.gBrowser.addTrustedTab(${JSON.stringify(page(4))}, { inBackground: true });
    setTimeout(() => done(tab.id), 800);
  `);
  const open4 = await waitUntil(() => checkB(t4id, 'true'), { timeout: 15000, label: 'tab open propagation' });
  ok('M4: tab open A→B', `${open4.elapsed + 800}ms`);

  // (b) close on B → disappears on A
  await b.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(t4id)});
    if (el) window.gBrowser.removeTab(el);
  `);
  const close4 = await waitUntil(
    async () => (await a.mar.executeScript(`return window.document.getElementById(${JSON.stringify(t4id)}) ? null : true;`)),
    { timeout: 15000, label: 'tab close propagation' }
  );
  ok('M4: tab close B→A', `${close4.elapsed}ms`);

  // (c1) navigate a tab whose copy on B is UNLOADED (never activated there)
  // → B retargets its session state without loading anything.
  const t5id = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const tab = window.gBrowser.addTrustedTab(${JSON.stringify(page(5))}, { inBackground: true });
    setTimeout(() => done(tab.id), 800);
  `);
  await waitUntil(() => checkB(t5id, 'true'), { timeout: 15000, label: 't5 propagation' });
  await a.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(t5id)});
    el.linkedBrowser.loadURI(Services.io.newURI(${JSON.stringify(page(6))}), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  `);
  const sessionUrlIs = (id, url) => checkB(id, `(() => {
    try {
      const state = JSON.parse(window.SessionStore.getTabState(el));
      const entries = state.entries || [];
      return entries.length && entries[entries.length - 1].url === ${JSON.stringify(url)} ? true : null;
    } catch (e) { return null; }
  })()`);
  const nav = await waitUntil(() => sessionUrlIs(t5id, page(6)), { timeout: 20000, label: 'navigation retarget' });
  ok('M4: navigation A→B (unloaded copy retargeted, never loaded)', `${nav.elapsed}ms`);

  // (c2) a copy that IS loaded on B (t1 became B's selected tab during the
  // initial replace) must NOT be navigated: the remote URL is held, and
  // convergence happens when the tab unloads.
  await a.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(seeded.t1)});
    el.linkedBrowser.loadURI(Services.io.newURI(${JSON.stringify(page(7))}), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  `);
  await sleep(6000); // give sync time; B must NOT have navigated
  const t1Loaded = await checkB(seeded.t1, `({
    stillOld: (() => { try { return el.linkedBrowser?.currentURI?.spec === ${JSON.stringify(page(1))}; } catch (e) { return false; } })(),
    loaded: !!el.linkedPanel,
  })`);
  t1Loaded?.loaded && t1Loaded?.stillOld
    ? ok('M4: loaded tab on B NOT navigated (remote URL held)')
    : fail('M4: loaded-tab hold', JSON.stringify(t1Loaded));
  // Unload it on B (select another tab first) → the hold resolves by
  // retargeting the now-unloaded copy.
  await b.mar.executeScript(`
    const t1 = window.document.getElementById(${JSON.stringify(seeded.t1)});
    const other = window.document.getElementById(${JSON.stringify(seeded.t3)});
    if (other) window.gBrowser.selectedTab = other;
    window.gBrowser.discardBrowser(t1);
  `);
  const holdResolve = await waitUntil(() => sessionUrlIs(seeded.t1, page(7)), { timeout: 25000, label: 'hold resolution on unload' });
  ok('M4: hold resolved on unload (converged without navigating the user)', `${holdResolve.elapsed}ms`);

  // (d) pin/unpin round trip
  await a.mar.executeScript(`window.gBrowser.pinTab(window.document.getElementById(${JSON.stringify(seeded.t1)}));`);
  const pin = await waitUntil(() => checkB(seeded.t1, 'el.pinned === true'), { timeout: 15000, label: 'pin propagation' });
  ok('M4: pin A→B', `${pin.elapsed}ms`);
  await a.mar.executeScript(`window.gBrowser.unpinTab(window.document.getElementById(${JSON.stringify(seeded.t1)}));`);
  const unpin = await waitUntil(() => checkB(seeded.t1, 'el.pinned === false ? true : null'), { timeout: 15000, label: 'unpin propagation' });
  ok('M4: unpin A→B (no remove+add)', `${unpin.elapsed}ms`);

  // (e) space rename
  await a.mar.executeScript(`
    const ws = { ...window.gZenWorkspaces.getActiveWorkspaceFromCache() };
    ws.name = 'Renamed E2E';
    window.gZenWorkspaces.saveWorkspace(ws);
  `);
  const rename = await waitUntil(
    async () => {
      const names = await b.mar.executeScript('return window.gZenWorkspaces.getWorkspaces().map(w => w.name);');
      return names?.includes('Renamed E2E') ? true : null;
    },
    { timeout: 15000, label: 'space rename propagation' }
  );
  ok('M4: space rename A→B', `${rename.elapsed}ms`);

  // (f) folder create with member
  const folderId = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const t2 = window.document.getElementById(${JSON.stringify(seeded.t2)});
    const folder = window.gZenFolders.createFolder([t2], { label: 'E2E Folder' });
    setTimeout(() => done(folder?.id || null), 500);
  `);
  if (!folderId) {
    fail('M4: folder create on A returned no id');
  } else {
    const folder = await waitUntil(
      () => checkB(folderId, `el.isZenFolder && window.document.getElementById(${JSON.stringify(seeded.t2)})?.group?.id === ${JSON.stringify(folderId)} ? true : null`),
      { timeout: 20000, label: 'folder propagation' }
    );
    ok('M4: folder create + membership A→B (same folder id)', `${folder.elapsed}ms`);
  }

  const checkOn = (mar, id, expr) => mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    return ${expr};
  `);

  // (g) kind transition chain on one record: normal → pinned → essential →
  // normal, always the same id (never remove+add).
  await a.mar.executeScript(`window.gBrowser.pinTab(window.document.getElementById(${JSON.stringify(t5id)}));`);
  const k1 = await waitUntil(() => checkB(t5id, 'el.pinned === true'), { timeout: 15000, label: 'transition normal→pinned' });
  await a.mar.executeScript(`window.gZenPinnedTabManager.addToEssentials(window.document.getElementById(${JSON.stringify(t5id)}));`);
  const k2 = await waitUntil(() => checkB(t5id, 'el.hasAttribute("zen-essential") ? true : null'), { timeout: 15000, label: 'transition pinned→essential' });
  await a.mar.executeScript(`window.gZenPinnedTabManager.removeEssentials(window.document.getElementById(${JSON.stringify(t5id)}), true);`);
  const k3 = await waitUntil(
    () => checkB(t5id, '!el.hasAttribute("zen-essential") && !el.pinned ? true : null'),
    { timeout: 15000, label: 'transition essential→normal' }
  );
  ok('M4: kind transitions normal→pinned→essential→normal, same id', `${k1.elapsed}/${k2.elapsed}/${k3.elapsed}ms`);

  // (h) reorder normal tabs. First force a KNOWN pre-state on both sides
  // (t5 after t1), so the assertion genuinely measures the move rather than
  // passing on incidental ordering left over from the kind-transition churn.
  const orderIndex = (id, otherId) => checkB(id, `(() => {
    const other = window.document.getElementById(${JSON.stringify(otherId)});
    if (!other || other.parentNode !== el.parentNode) return null;
    const kids = [...el.parentNode.children];
    return kids.indexOf(el) < kids.indexOf(other) ? "before" : "after";
  })()`);
  await a.mar.executeScript(`
    const t1 = window.document.getElementById(${JSON.stringify(seeded.t1)});
    const t5 = window.document.getElementById(${JSON.stringify(t5id)});
    if (t1.parentNode === t5.parentNode) {
      window.gBrowser.zenHandleTabMove(t5, () => t1.after(t5)); // t5 AFTER t1
    }
  `);
  await waitUntil(() => (async () => (await orderIndex(t5id, seeded.t1)) === 'after' ? true : null)(),
    { timeout: 15000, label: 'reorder pre-state (t5 after t1)' });
  const preOk = (await orderIndex(t5id, seeded.t1)) === 'after';
  // Now move t5 BEFORE t1 and require B to flip.
  await a.mar.executeScript(`
    const t1 = window.document.getElementById(${JSON.stringify(seeded.t1)});
    const t5 = window.document.getElementById(${JSON.stringify(t5id)});
    if (t1.parentNode === t5.parentNode) {
      window.gBrowser.zenHandleTabMove(t5, () => t1.parentNode.insertBefore(t5, t1));
    }
  `);
  const reorder = await waitUntil(
    () => (async () => (await orderIndex(t5id, seeded.t1)) === 'before' ? true : null)(),
    { timeout: 15000, label: 'normal-section reorder' }
  );
  preOk
    ? ok('M4: normal-tab reorder A→B (verified flip after→before)', `${reorder.elapsed}ms`)
    : fail('M4: normal-tab reorder — pre-state not established');

  // (i) split view create → same group id on B; unsplit → group gone, tabs kept.
  const splitId = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const t1 = window.document.getElementById(${JSON.stringify(seeded.t1)});
    const t5 = window.document.getElementById(${JSON.stringify(t5id)});
    window.gZenViewSplitter.splitTabs([t1, t5], "grid");
    setTimeout(() => done(t1.group?.id || null), 800);
  `);
  if (!splitId) {
    fail('M4: split create on A returned no group id');
  } else {
    const split = await waitUntil(
      () => checkB(splitId, `el.hasAttribute("split-view-group") &&
        window.document.getElementById(${JSON.stringify(seeded.t1)})?.group?.id === ${JSON.stringify(splitId)} &&
        window.document.getElementById(${JSON.stringify(t5id)})?.group?.id === ${JSON.stringify(splitId)} ? true : null`),
      { timeout: 20000, label: 'split propagation' }
    );
    ok('M4: split view A→B (same group id, both members)', `${split.elapsed}ms`);
    await a.mar.executeScript(`
      const idx = window.gZenViewSplitter._data.findIndex(g => g.groupId === ${JSON.stringify(splitId)});
      if (idx >= 0) window.gZenViewSplitter.removeGroup(idx);
    `);
    const unsplit = await waitUntil(
      async () => {
        const gone = await b.mar.executeScript(`return window.document.getElementById(${JSON.stringify(splitId)}) ? null : true;`);
        return gone && (await checkB(seeded.t1, 'true')) && (await checkB(t5id, 'true')) ? true : null;
      },
      { timeout: 20000, label: 'unsplit propagation' }
    );
    ok('M4: unsplit A→B (group gone, member tabs kept)', `${unsplit.elapsed}ms`);
  }

  // (j) nested folder: child folder inside the earlier folder.
  const childFolderId = folderId
    ? await a.mar.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        const parent = window.document.getElementById(${JSON.stringify(folderId)});
        const child = window.gZenFolders.createFolder([], { label: 'E2E Child', workspaceId: ${JSON.stringify(seeded.ws)} });
        window.gBrowser.zenHandleTabMove(child, () => {
          if (parent.tabs.length) parent.tabs[0].after(child);
          else parent.appendChild(child);
        });
        setTimeout(() => done(child?.id || null), 500);
      `)
    : null;
  if (!childFolderId) {
    fail('M4: nested folder create on A failed');
  } else {
    const nested = await waitUntil(
      () => checkB(childFolderId, `el.isZenFolder && el.group?.id === ${JSON.stringify(folderId)} ? true : null`),
      { timeout: 20000, label: 'nested folder propagation' }
    );
    ok('M4: nested folder A→B (parent edge intact)', `${nested.elapsed}ms`);
  }

  // (k) container (contextual identity) sync through the GUID map.
  await a.mar.executeScript(`
    const { ContextualIdentityService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
    ContextualIdentityService.create("E2E Container", "briefcase", "blue");
  `);
  const container = await waitUntil(
    async () => {
      const found = await b.mar.executeScript(`
        const { ContextualIdentityService } = ChromeUtils.importESModule(
          "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
        return ContextualIdentityService.getPublicIdentities().some(i => i.name === "E2E Container") ? true : null;
      `);
      return found;
    },
    { timeout: 20000, label: 'container propagation' }
  );
  ok('M4: container create A→B', `${container.elapsed}ms`);

  // (l) navigation inside a PINNED tab must not churn its record (identity
  // is the pin target, not the live page).
  const pinnedNavStart = Date.now();
  await a.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(seeded.t2)});
    el.linkedBrowser.loadURI(Services.io.newURI(${JSON.stringify(page(8))}), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  `);
  await sleep(6000);
  const t2rec = observer.tab(seeded.t2);
  const t2touched = observer.broadcastsSince(pinnedNavStart).some(
    (bc) => bc.ids.includes(seeded.t2) || bc.deleted.includes(seeded.t2)
  );
  t2rec?.url === page(2) && !t2touched
    ? ok('M4: pinned-tab navigation causes zero record churn (pin target kept)')
    : fail('M4: pinned-tab navigation churn', `url=${t2rec?.url}, touched=${t2touched}`);

  // --- M6: space create / remote delete with confirmation modal ---
  const ws2 = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    window.gZenWorkspaces.createAndSaveWorkspace('Second Space', undefined, true)
      .then(ws => done(ws?.uuid || null)).catch(() => done(null));
  `);
  if (!ws2) {
    fail('M6: space create on A failed');
  } else {
    const spaceProp = await waitUntil(
      async () => {
        const names = await b.mar.executeScript('return window.gZenWorkspaces.getWorkspaces().map(w => w.uuid);');
        return names?.includes(ws2) ? true : null;
      },
      { timeout: 20000, label: 'space create propagation' }
    );
    ok('M6: space create A→B (uuid verbatim)', `${spaceProp.elapsed}ms`);

    await a.mar.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      Promise.resolve(window.gZenWorkspaces.removeWorkspace(${JSON.stringify(ws2)})).then(() => done(true), () => done(false));
    `);
    // B must show the deferred confirmation modal (never auto-delete a space).
    let alertText = null;
    const modal = await waitUntil(
      async () => {
        alertText = await b.mar.alertText();
        return alertText !== null ? true : null;
      },
      { timeout: 30000, label: 'remote space-delete modal on B' }
    );
    ok('M6: remote space deletion held behind modal on B', `${modal.elapsed}ms, "${String(alertText).slice(0, 60)}"`);
    await b.mar.acceptAlert();
    const spaceGone = await waitUntil(
      async () => {
        const names = await b.mar.executeScript('return window.gZenWorkspaces.getWorkspaces().map(w => w.uuid);');
        return names && !names.includes(ws2) ? true : null;
      },
      { timeout: 20000, label: 'space delete after confirm' }
    );
    ok('M6: confirmed space deletion applied on B', `${spaceGone.elapsed}ms`);
  }

  // --- M5: final quiescence (no ping-pong) ---
  await sleep(10000); // settle
  const finalStart = Date.now();
  const vFinal = observer.version;
  await sleep(15000);
  const finalB = observer.broadcastsSince(finalStart);
  observer.version === vFinal && finalB.length === 0
    ? ok('M5: matrix quiescence — no A↔B ping-pong')
    : fail('M5: matrix quiescence', `version ${vFinal}→${observer.version}, ${JSON.stringify(finalB)}`);

  // --- M7: browser restart — ids survive, zero puts, sync stays alive ---
  await a.mar.executeScript('Services.startup.quit(Services.startup.eForceQuit);').catch(() => {});
  a.mar.close();
  await waitProcExit(a.proc);
  a = await launchZen('zen-a', profileA, 2830);
  browsers[0] = a;
  await installExtension(a.mar);
  const restarted = await waitUntil(
    async () =>
      (await checkOn(a.mar, seeded.t1, 'true')) &&
      (await checkOn(a.mar, seeded.t2, 'el.pinned === true')) &&
      (await checkOn(a.mar, seeded.t3, 'el.hasAttribute("zen-essential")')) &&
      (await checkOn(a.mar, folderId, 'el.isZenFolder ? true : null')),
    { timeout: 90000, label: 'A restart with intact ids' }
  );
  ok('M7: A restarted — record ids survive the restart', `${restarted.elapsed}ms`);
  await sleep(10000); // engine ready + reconnectMerge settle
  const vRestart = observer.version;
  const restartWindow = Date.now();
  await sleep(15000);
  observer.version === vRestart && observer.broadcastsSince(restartWindow).length === 0
    ? ok('M7: zero puts after restart (echo-free restart)')
    : fail('M7: restart quiescence', `version ${vRestart}→${observer.version}`);

  // --- M8: offline edits on both sides reconcile on reconnect ---
  await sleep(2500); // let the server flush its debounced save
  await stopSyncServer();
  const oxId = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const tab = window.gBrowser.addTrustedTab(${JSON.stringify(page(20))}, { inBackground: true, createLazyBrowser: true, lazyTabTitle: "OX" });
    setTimeout(() => done(tab.id), 800);
  `);
  await a.mar.executeScript(`
    const el = window.document.getElementById(${JSON.stringify(t5id)});
    if (el) window.gBrowser.removeTab(el);
  `);
  const oyId = await b.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const tab = window.gBrowser.addTrustedTab(${JSON.stringify(page(21))}, { inBackground: true, createLazyBrowser: true, lazyTabTitle: "OY" });
    setTimeout(() => done(tab.id), 800);
  `);
  await sleep(4000); // captures run while disconnected
  startSyncServer();
  await sleep(1200);
  observer = new Observer();
  await observer.connect();
  const offline = await waitUntil(
    () => observer.tab(oxId) && observer.tab(oyId) && !observer.records.has(t5id) ? true : null,
    { timeout: 120000, label: 'offline reconciliation on server' }
  );
  ok('M8: offline edits reconciled on server (new tabs up, offline close propagated)', `${offline.elapsed}ms`);
  const offlinePeers = await waitUntil(
    async () =>
      (await checkB(oxId, 'true')) &&
      (await checkOn(a.mar, oyId, 'true')) &&
      (await a.mar.executeScript(`return window.document.getElementById(${JSON.stringify(t5id)}) ? null : true;`)) &&
      (await b.mar.executeScript(`return window.document.getElementById(${JSON.stringify(t5id)}) ? null : true;`)),
    { timeout: 60000, label: 'offline reconciliation across peers' }
  );
  ok('M8: both peers converged (no resurrection, no loss)', `${offlinePeers.elapsed}ms`);

  // --- M9: scale — 60 tabs at once ---
  const scaleIds = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const ids = [];
    const tabs = [];
    for (let i = 0; i < 60; i++) {
      tabs.push(window.gBrowser.addTrustedTab("http://127.0.0.1:${HTTP_PORT}/p/" + (100 + i), {
        inBackground: true, createLazyBrowser: true, skipAnimation: true, lazyTabTitle: "S" + i,
      }));
    }
    setTimeout(() => done(tabs.map(t => t.id).filter(Boolean)), 1500);
  `);
  scaleIds?.length === 60 ? ok('M9: 60 tabs opened on A') : fail('M9: scale seeding', `got ${scaleIds?.length}`);
  const scaleUp = await waitUntil(
    () => (scaleIds.every((id) => observer.tab(id)) ? true : null),
    { timeout: 120000, label: 'scale upload' }
  );
  ok('M9: all 60 tab records reached the server', `${scaleUp.elapsed}ms`);
  const scaleDown = await waitUntil(
    async () => {
      const count = await b.mar.executeScript(`
        const ids = arguments[0];
        return ids.filter(id => !!window.document.getElementById(id)).length;
      `, [scaleIds]);
      return count === 60 ? true : null;
    },
    { timeout: 120000, label: 'scale materialization on B' }
  );
  ok('M9: all 60 tabs materialized on B', `${scaleDown.elapsed}ms`);

  // --- M10: apply-side mass-deletion guard — a poisoned batch must be
  // withheld on every client, and sync must keep working afterwards ---
  const kill = scaleIds.slice(0, 55);
  // force:true bypasses the SERVER guard (that path is unit-tested); the goal
  // here is the CLIENT apply-side guard. The server applies + broadcasts the
  // 55 deletions to A and B, which must WITHHOLD them.
  observer.put([], kill, { force: true });
  // Confirm the server actually dropped them (re-request since the server
  // never broadcasts a put back to its sender).
  await waitUntil(() => {
    observer.requestState();
    return kill.every((id) => !observer.records.has(id)) ? true : null;
  }, { timeout: 15000, interval: 1000, label: 'server applied forced poison batch' });
  await sleep(8000); // let the broadcast reach + the guard withhold on both clients
  const sample = [kill[0], kill[13], kill[27], kill[40], kill[54]];
  const intactA = await a.mar.executeScript(
    `const ids = arguments[0]; return ids.filter(id => !!window.document.getElementById(id)).length;`, [sample]);
  const intactB = await b.mar.executeScript(
    `const ids = arguments[0]; return ids.filter(id => !!window.document.getElementById(id)).length;`, [sample]);
  intactA === 5 && intactB === 5
    ? ok('M10: apply-side guard withheld a 55-record purge on BOTH clients (tabs survived)')
    : fail('M10: apply-side mass-deletion guard', `intact A=${intactA}/5 B=${intactB}/5`);
  // Sync must not be wedged by the pending guard.
  const aliveId = await a.mar.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const tab = window.gBrowser.addTrustedTab(${JSON.stringify(page(99))}, { inBackground: true, createLazyBrowser: true, lazyTabTitle: "alive" });
    setTimeout(() => done(tab.id), 800);
  `);
  const alive = await waitUntil(() => checkB(aliveId, 'true'), { timeout: 20000, label: 'sync alive after guard' });
  ok('M10: sync still flows while the guard awaits confirmation', `${alive.elapsed}ms`);

  // Sanity dumps.
  await dumpConsole(a.mar, 'A');
  await dumpConsole(b.mar, 'B');
} catch (e) {
  failures++;
  console.error(`\nE2E ABORTED: ${e.message}`);
  for (const { mar, name } of browsers) {
    try { await dumpConsole(mar, name || 'browser'); } catch {}
    try {
      const sidebar = await mar.executeScript(`
        const { ZenSessionStore } = ChromeUtils.importESModule("resource:///modules/zen/ZenSessionManager.sys.mjs");
        const s = ZenSessionStore.getSidebarData() || {};
        return {
          lastCollected: s.lastCollected,
          age: Date.now() - (s.lastCollected || 0),
          tabs: (s.tabs || []).map(t => ({
            id: t.zenSyncId, ws: t.zenWorkspace, pin: !!t.pinned, ess: !!t.zenEssential,
            empty: !!t.zenIsEmpty, url: t.entries?.[t.entries.length - 1]?.url || null,
          })),
        };
      `);
      console.log(`--- ${name} sidebar snapshot ---`);
      console.log(JSON.stringify(sidebar, null, 1));
    } catch (err) {
      console.log(`(sidebar dump failed: ${err.message})`);
    }
  }
} finally {
  observer.close();
  await teardown();
}

console.log('\n=== E2E SUMMARY ===');
for (const line of results) console.log(line);
console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : `\n${failures} FAILURES (logs in ${WORK})`);
process.exit(failures === 0 ? 0 : 1);
