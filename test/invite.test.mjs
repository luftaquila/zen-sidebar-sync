// Invite string parsing / building. The invite is the whole device-setup
// flow, so a malformed accept (or a dropped token) is a real bug.
//
//   node test/invite.test.mjs
import { parseInvite, buildInvite } from '../extension/common/invite.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}`); }
}
const eq = (a, b, label) => assert(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);

console.log('parse:');
eq(parseInvite('zensync://sync.example.com/?t=abc123'),
   { serverUrl: 'wss://sync.example.com', token: 'abc123', deviceName: null },
   'wss implied by default');

eq(parseInvite('zensync://localhost:9223/?t=abc123&s=0'),
   { serverUrl: 'ws://localhost:9223', token: 'abc123', deviceName: null },
   's=0 means plaintext ws');

eq(parseInvite('zensync://sync.example.com/?t=abc123&n=My%20Laptop'),
   { serverUrl: 'wss://sync.example.com', token: 'abc123', deviceName: 'My Laptop' },
   'device name hint carried');

eq(parseInvite('zensync://host.example/zen/?t=tok'),
   { serverUrl: 'wss://host.example/zen', token: 'tok', deviceName: null },
   'reverse-proxy path preserved');

eq(parseInvite('  zensync://sync.example.com/?t=abc123  '),
   { serverUrl: 'wss://sync.example.com', token: 'abc123', deviceName: null },
   'surrounding whitespace tolerated');

// A full ws(s):// URL may be pasted directly; credentials are stripped out
// of the stored server URL.
eq(parseInvite('wss://sync.example.com/?t=abc123'),
   { serverUrl: 'wss://sync.example.com/', token: 'abc123', deviceName: null },
   'raw wss URL accepted, token removed from url');

eq(parseInvite('zensync://sync.example.com/#tok3n'),
   { serverUrl: 'wss://sync.example.com', token: 'tok3n', deviceName: null },
   'token may ride in the fragment');

console.log('reject:');
for (const [bad, why] of [
  ['', 'empty'],
  ['   ', 'whitespace only'],
  ['not-a-url', 'not a url'],
  ['https://sync.example.com/?t=abc', 'wrong scheme (https)'],
  ['zensync://sync.example.com/', 'no token'],
  ['zensync:///?t=abc', 'no host'],
]) {
  assert(parseInvite(bad) === null, `rejects ${why}`);
}

console.log('build + round-trip:');
eq(buildInvite({ serverUrl: 'wss://sync.example.com', token: 'abc123' }),
   'zensync://sync.example.com/?t=abc123', 'builds secure invite');
eq(buildInvite({ serverUrl: 'ws://localhost:9223', token: 'abc123' }),
   'zensync://localhost:9223/?t=abc123&s=0', 'builds plaintext invite with s=0');
assert(buildInvite({ serverUrl: '', token: 'x' }) === null, 'no url → null');
assert(buildInvite({ serverUrl: 'wss://h', token: '' }) === null, 'no token → null');

for (const cfg of [
  { serverUrl: 'wss://sync.example.com', token: 'tok' },
  { serverUrl: 'ws://localhost:9223', token: 'tok' },
  { serverUrl: 'wss://host.example/zen', token: 'tok' },
]) {
  const back = parseInvite(buildInvite(cfg));
  assert(back?.serverUrl === cfg.serverUrl && back?.token === cfg.token,
    `round-trip ${cfg.serverUrl}`);
}

console.log(failures === 0 ? '\nALL INVITE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
