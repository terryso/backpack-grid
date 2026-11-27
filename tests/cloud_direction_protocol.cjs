'use strict';
// Production Durable Object and real local transaction, isolated mock storage only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const patterns = require('../cloudflare/patterns.js');
const { setDirection, directionSnapshot, directionTransaction } = require('../scripts/grid_direction.cjs');
const { fetchCloudMailbox } = require('../scripts/cloud_sync.cjs');
const { applyLocalSwitch } = require('../scripts/direction_watch.cjs');
const source = fs.readFileSync(path.join(__dirname, '../cloudflare/direction_mailbox.js'), 'utf8')
  .replace(/^import .*$/m, '').replace('export class DirectionMailbox', 'class DirectionMailbox') + '\nglobalThis.Mailbox = DirectionMailbox;';
let clock = Date.now();
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
const context = { patterns, Date: Clock, crypto: webcrypto, Response };
vm.runInNewContext(source, context);
let data = null, serial = Promise.resolve(), failNextWrite = false;
const ctx = {
  storage: { get: async () => structuredClone(data), put: async (_, v) => {
    if (failNextWrite) { failNextWrite = false; throw Error('mock storage outage'); }
    data = structuredClone(v);
  } },
  blockConcurrencyWhile: fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; },
};
const mailbox = new context.Mailbox(ctx);
const call = async body => (await mailbox.fetch({ method: 'POST', json: async () => body })).json();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-direction-protocol-'));
fs.mkdirSync(path.join(root, 'state'));
const key = 'fixture-3', metrics = { t7: 8, t14: 10, rangePos: .8, bounce: 10, drop: 1 };
const snapshot = () => ({ updatedAt: new Date(clock).toISOString(), dataValid: true, direction: directionSnapshot(root, key) });
const eventAt = at => new Date(at).toISOString();
function transactParallel(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PY_BIN, [path.join(__dirname, '../scripts/direction_state.py')], { env: { ...process.env, BG_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(Error(err)));
    child.stdin.end(JSON.stringify(request));
  });
}

// Invoke the production Worker judgment and routes against a fake DO binding.
const workerSource = fs.readFileSync(path.join(__dirname, '../cloudflare/worker.js'), 'utf8')
  .replace(/^export \{.*$/gm, '').replace(/^import .*$/gm, '')
  .replace('export default {', 'const worker = {') + '\nglobalThis.worker = worker; globalThis.judge = runShadowJudge;';
let workerSnapshot = () => snapshot();
const workerEnv = {
  DASH_WRITE_TOKEN: 'fixture-only',
  DASH: { get: async key => key === 'latest' ? JSON.stringify(workerSnapshot()) : null, put: async () => {} },
  DIRECTION: { idFromName: name => name, get: () => ({ fetch: async (url, options = {}) => mailbox.fetch({ method: options.method || 'GET', json: async () => JSON.parse(options.body || '{}') }) }) },
};
const workerContext = { patterns, Date: Clock, crypto: webcrypto, Response, Request, URL, AbortSignal,
  fetch: async () => ({ ok: true, json: async () => Array.from({ length: 340 }, (_, i) => ({ close: 100 + i / 5 })) }),
  setTimeout, clearTimeout,
};
vm.runInNewContext(workerSource, workerContext);

(async () => {
  try {
    setDirection(root, key, '*', 'Short');
    const original = snapshot();
    for (let i = 0; i < 4; i++) {
      const state = await call({ snapshot: snapshot(), metrics });
      assert.equal(state.pending, null);
      clock += 3600000;
    }
    failNextWrite = true;
    await assert.rejects(call({ snapshot: snapshot(), metrics }), /mock storage outage/);
    assert.equal(data.pending, null); assert.equal(data.advice.streak, 4);
    await call({ snapshot: snapshot(), metrics }); clock += 3600000;
    assert(data.pending); const event = structuredClone(data.pending);
    await Promise.all([call({ snapshot: snapshot(), metrics }), call({ snapshot: snapshot(), metrics })]);
    assert.equal(data.pending.id, event.id);
    event.at = eventAt(Date.now());
    const applied = directionTransaction(root, { op: 'cloud', accountKey: key, event });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(directionTransaction(root, { op: 'cloud', accountKey: key, event }), applied);
    assert.equal(directionSnapshot(root, key).directive, 'Long');
    setDirection(root, key, '*', 'Neutral');
    assert.deepEqual(directionTransaction(root, { op: 'cloud', accountKey: key, event }), applied);
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    failNextWrite = true;
    await assert.rejects(call({ snapshot: snapshot() }), /mock storage outage/);
    assert.equal(data.pending.id, event.id);
    const ack = await call({ snapshot: snapshot() });
    assert.equal(ack.resolved, true); assert.equal(data.pending, null);
    assert.equal(data.advice.switchLog.length, 1); assert.equal(data.advice.switchLog[0].via, 'cloud');
    // The independently scheduled local watcher uses the same revision lock.
    // Its writes must never destroy the cloud acknowledgment awaiting upload.
    const acknowledged = directionSnapshot(root, key).lastCloudEvent;
    const localBase = directionSnapshot(root, key);
    assert.equal(applyLocalSwitch(root, key, localBase, 'Long', eventAt(Date.now())).status, 'applied');
    assert.deepEqual(directionSnapshot(root, key).lastCloudEvent, acknowledged);
    const staleLocal = directionSnapshot(root, key);
    setDirection(root, key, '*', 'Neutral');
    assert.equal(applyLocalSwitch(root, key, staleLocal, 'Short', eventAt(Date.now())).status, 'conflict');
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    assert.deepEqual(directionSnapshot(root, key).lastCloudEvent, acknowledged);
    // Kill the real transaction process immediately after rename but before
    // it can return: retry must not overwrite a subsequent manual instruction.
    setDirection(root, key, '*', 'Short');
    const crashEvent = { id: 'crash-after-rename', at: eventAt(Date.now()), from: 'Short', to: 'Long', version: directionSnapshot(root, key).version };
    const injectDir = path.join(root, 'crash-inject'); fs.mkdirSync(injectDir);
    fs.writeFileSync(path.join(injectDir, 'sitecustomize.py'), `import os\n_original = os.replace\ndef _crash_after_replace(src, dst):\n    _original(src, dst)\n    if os.environ.get('BG_TEST_CRASH') == '1' and str(dst).endswith('/direction_override.json'):\n        os._exit(47)\nos.replace = _crash_after_replace\n`);
    const crashed = spawnSync(process.env.PY_BIN, [path.join(__dirname, '../scripts/direction_state.py')], {
      env: { ...process.env, BG_ROOT: root, BG_TEST_CRASH: '1', PYTHONPATH: injectDir },
      input: JSON.stringify({ op: 'cloud', accountKey: key, event: crashEvent }), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(crashed.status, 47); assert.equal(directionSnapshot(root, key).directive, 'Long');
    setDirection(root, key, '*', 'Neutral');
    assert.equal(directionTransaction(root, { op: 'cloud', accountKey: key, event: crashEvent }).status, 'applied');
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    const before = directionSnapshot(root, key);
    setDirection(root, key, '*', 'Neutral');
    const conflict = { id: 'conflict', at: eventAt(Date.now()), from: 'Neutral', to: 'Short', version: before.version };
    assert.equal(directionTransaction(root, { op: 'cloud', accountKey: key, event: conflict }).status, 'conflict');
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    const current = directionSnapshot(root, key);
    assert.equal(directionTransaction(root, { op: 'cloud', accountKey: key, event: { id: 'old', at: eventAt(Date.now() - 7200001), from: 'Neutral', to: 'Short', version: current.version } }).status, 'expired');
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    // Competing real processes share flock: manual input wins in either order.
    setDirection(root, key, '*', 'Short');
    const competing = { id: 'parallel', at: eventAt(Date.now()), from: 'Short', to: 'Long', version: directionSnapshot(root, key).version };
    const [manual, automatic] = await Promise.all([
      transactParallel({ op: 'manual', accountKey: key, market: '*', direction: 'Neutral' }),
      transactParallel({ op: 'cloud', accountKey: key, event: competing }),
    ]);
    assert.equal(manual.status, 'manual'); assert(['applied', 'conflict'].includes(automatic.status));
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    assert.equal(fetchCloudMailbox('https://fixture.invalid', { spawnSync: () => ({ status: 1 }) }), null);
    assert.equal(fetchCloudMailbox('https://fixture.invalid', { spawnSync: () => ({ status: 0, stdout: '{"switchingObserved":true}' }) }), null);
    const invalidSnapshot = { ...original, dataValid: false };
    assert.equal((await call({ snapshot: invalidSnapshot, metrics })).skipped, 'versioned snapshot unavailable');
    for (const invalid of [null, false, '', []]) {
      const file = path.join(root, 'state/direction_override.json');
      const validContents = fs.readFileSync(file);
      const corrupt = JSON.parse(validContents); corrupt.directions['*'] = invalid;
      fs.writeFileSync(file, JSON.stringify(corrupt));
      assert.throws(() => directionSnapshot(root, key), /invalid global direction/);
      fs.writeFileSync(file, validContents);
    }
    // Full Worker -> mailbox with the SAME snapshot for five offline hours.
    data = null; clock = Date.now() - 5 * 3600000;
    setDirection(root, key, '*', 'Short');
    const offlineSnapshot = snapshot();
    workerSnapshot = () => offlineSnapshot;
    for (let i = 0; i < 5; i++) { await workerContext.judge(workerEnv); clock += 3600000; }
    const pending = structuredClone(data.pending); assert(pending);
    assert.match(data.advice.note, /^btc t7=/);
    await workerContext.judge(workerEnv); assert.equal(data.pending.id, pending.id);
    // Drive the real mailbox endpoint; it must expose the retained event.
    const reply = await workerContext.worker.fetch(new Request('https://fixture.invalid/api/direction-event'), workerEnv);
    assert.equal((await reply.json()).pending.id, pending.id);
    // The event was created one hour before reconnection and remains applicable.
    assert.equal(directionTransaction(root, { op: 'cloud', accountKey: key, event: pending }).status, 'applied');
    workerSnapshot = () => snapshot();
    await workerContext.judge(workerEnv); assert.equal(data.pending, null);
    // A much older event is acknowledged without execution.
    const beforeExpired = directionSnapshot(root, key);
    const staleEvent = { id: 'expired-worker-event', at: eventAt(Date.now() - 7200001),
      from: beforeExpired.directive, to: 'Short', version: beforeExpired.version };
    data.pending = staleEvent;
    assert.equal(directionTransaction(root, { op: 'cloud', accountKey: key, event: staleEvent }).status, 'expired');
    await workerContext.judge(workerEnv); assert.equal(data.pending, null);

    // Exercise the real decide and dashboard entrypoints with fixture-only I/O.
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.example.json'), 'utf8'));
    cfg.subaccountId = 3; delete cfg.userId;
    const identity = { userId: 'fixture', subaccountId: 3, accountKey: key };
    const observed = { at: eventAt(Date.now()), source: 'fixture', identity, gridRows: [], positions: [],
      margin: { totalEquity: '$500.00', availableEquity: '$400.00', openPnl: '$0.00', initMarginPct: '0%' }, badges: {}, ledger: [] };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...cfg, requireDirection: false }));
    fs.writeFileSync(path.join(root, 'state/account_identity.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(root, 'state/observed.json'), JSON.stringify(observed));
    fs.writeFileSync(path.join(root, 'state/risk.json'), '[]'); // invalid fixture: no risk-writer subprocess
    fs.writeFileSync(path.join(root, 'state/dashboard.env'), 'DASH_URL=https://fixture.invalid\n');
    const fakeBin = path.join(root, 'bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\ncat "$BG_CLOUD_FIXTURE"\n', { mode: 0o755 });
    const fixturePath = path.join(root, 'mailbox.json');
    const env = { ...process.env, BG_ROOT: root, BG_OFFLINE: '1', BG_CLOUD_FIXTURE: fixturePath,
      PY_BIN: process.env.PY_BIN, PATH: fakeBin + ':/usr/bin:/bin', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'no_network.cjs')) };
    const decide = dryrun => spawnSync(process.execPath, [path.join(__dirname, '../scripts/decide.cjs')],
      { env: { ...env, DRYRUN: dryrun ? '1' : '0' }, encoding: 'utf8', timeout: 15000 });
    setDirection(root, key, '*', 'Short');
    const entryEvent = { id: 'entrypoint', at: eventAt(Date.now()), from: 'Short', to: 'Long', version: directionSnapshot(root, key).version };
    fs.writeFileSync(fixturePath, JSON.stringify({ pending: entryEvent, advice: { at: eventAt(Date.now()), directive: 'Short', rec: 'Long' } }));
    let execution = decide(true);
    assert.equal(execution.status, 0, execution.stderr); assert.equal(directionSnapshot(root, key).directive, 'Short');
    execution = decide(false);
    assert.equal(execution.status, 0, execution.stderr); assert.equal(directionSnapshot(root, key).directive, 'Long');
    const dashboard = spawnSync(process.execPath, [path.join(__dirname, '../scripts/dashboard_data.cjs')], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(dashboard.status, 0, dashboard.stderr);
    const published = JSON.parse(fs.readFileSync(path.join(root, 'state/dashboard.json'), 'utf8'));
    assert.equal(published.dataValid, true); assert.equal(published.direction.directive, 'Long');
    assert.equal(published.direction.lastCloudEvent.id, entryEvent.id);
    assert.equal(published.direction.lastCloudEvent.status, 'applied');
    setDirection(root, key, '*', 'Neutral');
    execution = decide(false); assert.equal(execution.status, 0, execution.stderr);
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');

    // Exercise the live local watch entry with mock prices and a manual edit
    // injected after it reads the direction, but before it decides to switch.
    const mockApi = path.join(root, 'mock-api.cjs');
    fs.writeFileSync(mockApi, `const M = require('node:module'); const original = M._load; let injected = false;
M._load = function (name, parent, main) {
  if (name === './api.cjs' && parent.filename.endsWith('/scripts/direction_watch.cjs')) return {
    getKlines: async () => { if (!injected && process.env.BG_TEST_INTERFERE === '1') {
      injected = true; require(process.env.BG_TEST_DIRECTION_MODULE).setDirection(process.env.BG_ROOT, 'fixture-3', '*', 'Neutral');
    } return Array.from({length: 340}, (_, i) => ({close: 100 + i / 5})); }
  }; return original.apply(this, arguments);
};`);
    const watch = (interfere, authority = '') => spawnSync(process.execPath, [path.join(__dirname, '../scripts/direction_watch.cjs')],
      { env: { ...env, BG_DIRECTION_AUTHORITY: authority, BG_TEST_INTERFERE: interfere ? '1' : '0', BG_TEST_DIRECTION_MODULE: path.join(__dirname, '../scripts/grid_direction.cjs'),
        NODE_OPTIONS: env.NODE_OPTIONS + ' --require ' + JSON.stringify(mockApi) }, encoding: 'utf8', timeout: 15000 });
    const prepareWatch = () => {
      setDirection(root, key, '*', 'Short');
      fs.writeFileSync(path.join(root, 'state/direction_advice.json'), JSON.stringify({ rec: 'Long', streak: 4, lastDirective: 'Short' }));
      fs.writeFileSync(path.join(root, 'state/direction_shadow_advice.json'), JSON.stringify({ rec: 'Long', streak: 4, lastDirective: 'Short' }));
    };
    const cloudAck = directionSnapshot(root, key).lastCloudEvent;
    prepareWatch(); let watched = watch(false);
    assert.equal(watched.status, 0, watched.stderr); assert.match(watched.stdout, /SHADOW_ONLY/);
    assert.equal(directionSnapshot(root, key).directive, 'Short');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/direction_shadow_advice.json'), 'utf8')).wouldSwitch, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/direction_advice.json'), 'utf8')).streak, 4);
    prepareWatch(); watched = watch(false, 'local');
    assert.equal(watched.status, 0, watched.stderr); assert.match(watched.stdout, /SHADOW_ONLY/);
    fs.unlinkSync(path.join(root, 'state/dashboard.env'));
    prepareWatch(); watched = watch(false);
    assert.equal(watched.status, 0, watched.stderr); assert.match(watched.stdout, /SHADOW_ONLY/);
    prepareWatch(); watched = watch(false, 'local');
    assert.equal(watched.status, 0, watched.stderr); assert.equal(directionSnapshot(root, key).directive, 'Long');
    assert.deepEqual(directionSnapshot(root, key).lastCloudEvent, cloudAck);
    prepareWatch(); watched = watch(true, 'local');
    assert.equal(watched.status, 1, watched.stderr); assert.match(watched.stdout, /SWITCH_SET_FAILED conflict/);
    assert.equal(directionSnapshot(root, key).directive, 'Neutral');
    assert.deepEqual(directionSnapshot(root, key).lastCloudEvent, cloudAck);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/direction_advice.json'), 'utf8')).streak, 0);
    console.log('PASS durable event, replay, conflict, stale and compatibility behaviors');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
