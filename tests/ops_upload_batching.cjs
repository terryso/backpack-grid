'use strict';
// Actual upload shell with a disposable root, fake network and synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-ops-upload-batch-'));
const state = path.join(base, 'state');
fs.mkdirSync(state); fs.mkdirSync(path.join(base, 'scripts')); fs.mkdirSync(path.join(base, 'bin')); fs.mkdirSync(path.join(base, 'tmp'));
for (const name of ['upload_dashboard.sh', 'contracts.cjs', 'state_schema.cjs', 'ops_upload_policy.cjs']) {
  const src = path.join(ROOT, 'scripts', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(base, 'scripts', name));
}
fs.writeFileSync(path.join(state, 'dashboard.env'), "DASH_URL='https://fixture.invalid'\nDASH_WRITE_TOKEN='fixture-only'\n");
fs.writeFileSync(path.join(state, 'account_identity.json'), JSON.stringify({ userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' }));
const fixturePath = path.join(state, 'fixture.json');
const logPath = path.join(state, 'mock-http.jsonl');
fs.writeFileSync(path.join(base, 'scripts', 'dashboard_data.cjs'), `const fs=require('fs');const f=JSON.parse(fs.readFileSync('state/fixture.json'));fs.writeFileSync('state/dashboard.json',JSON.stringify(f.dashboard));`);
fs.writeFileSync(path.join(base, 'scripts', 'ops_data.cjs'), `const fs=require('fs'),{hash}=require('./contracts.cjs');const f=JSON.parse(fs.readFileSync('state/fixture.json'));if(f.failBuild)process.exit(2);const data={ops:f.ops,fills:f.fills,rounds:f.rounds,dataAsOf:f.dataAsOf,fillsAsOf:null,ledgerAsOf:f.ledgerAsOf,collection:f.collection};fs.writeFileSync('state/ops.json',JSON.stringify({...data,updatedAt:f.dashboard.generatedAt}));fs.writeFileSync('state/ops_content_hash',hash(data));`);
fs.writeFileSync(path.join(base, 'bin', 'curl'), `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2),f=JSON.parse(fs.readFileSync('state/fixture.json'));const u=a.find(v=>v.startsWith('https://fixture.invalid/'));if(!u)process.exit(2);const p=new URL(u).pathname,method=a.includes('-X')?a[a.indexOf('-X')+1]:'GET',out=a[a.indexOf('-o')+1];let code=method==='POST'&&p==='/api/ops'&&f.failOps?(f.failOps==='network'?0:500):method==='POST'&&p==='/api/snapshot'&&f.failSnapshot?500:200;let body=null;if(method==='POST'){const raw=a[a.indexOf('--data-binary')+1];body=JSON.parse(fs.readFileSync(raw.slice(1),'utf8'));}fs.appendFileSync('state/mock-http.jsonl',JSON.stringify({method,path:p,status:code,body})+'\\n');fs.writeFileSync(out,method==='GET'?fs.readFileSync('state/dashboard.json'):'ok');if(a.includes('-w'))process.stdout.write(code===0?'000':String(code));if(code===0)process.exit(7);`, { mode: 0o755 });
const fixture = { dashboard: { updatedAt: '2026-11-27T00:00:00Z', generatedAt: '2026-11-27T00:00:00Z', lastRoundStatus: 'ok', dataValid: true, identityValid: true, riskStateValid: true, riskWriteValid: true, manualPauseValid: true, pendingCorrupt: false, riskPaused: false, pending: [], orphans: [], marketDataAvailable: true, autoExits: { trailEnabled: true, trailReady: true } }, ops: [], fills: [], rounds: [], dataAsOf: null, ledgerAsOf: new Date(Date.now() - 21 * 60000).toISOString(), collection: { ok: true, incomplete: false, forwardIncomplete: false, auditIncomplete: false, checkedAt: '2026-11-27T00:00:00Z' }, failOps: false };
function put() { fs.writeFileSync(fixturePath, JSON.stringify(fixture)); }
function run({ routine = true } = {}) {
  put(); const env = { ...process.env, BG_ROOT: base, BG_PROXY: '', BG_LOCKED: routine ? '1' : '', TMPDIR: path.join(base, 'tmp'), PY_BIN: '/Users/nick/.browser-use-env/bin/python3', PATH: path.join(base, 'bin') + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) };
  const r = spawnSync('/bin/bash', [path.join(base, 'scripts', 'upload_dashboard.sh')], { cwd: base, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(fs.readdirSync(path.join(base, 'tmp')), [], 'temporary payloads must be removed'); return fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
}
function addRound(n) { fixture.rounds.unshift({ at: `2026-11-27T00:${String(n).padStart(2, '0')}:00Z`, line: `routine ${n}` }); fixture.dataAsOf = fixture.rounds[0].at; fixture.dashboard.updatedAt = fixture.rounds[0].at; fixture.dashboard.generatedAt = fixture.rounds[0].at; }
function posts(log, endpoint) { return log.filter(x => x.method === 'POST' && x.path === endpoint); }
function checkpoint() { return JSON.parse(fs.readFileSync(path.join(state, 'ops_upload_checkpoint.json'), 'utf8')); }
function setCheckpoint(v) { fs.writeFileSync(path.join(state, 'ops_upload_checkpoint.json'), typeof v === 'string' ? v : JSON.stringify(v)); }
function passed(name) { console.log('PASS ' + name); }

try {
  addRound(0); let log = run(); assert.equal(posts(log, '/api/snapshot').length, 1); assert.equal(posts(log, '/api/ops').length, 1);
  addRound(5); run(); addRound(10); run();
  assert.equal(posts(run(), '/api/snapshot').length, 4, 'snapshot must still publish every round');
  assert.equal(posts(run(), '/api/ops').length, 1, 'routine history should be batched');
  passed('ordinary rounds keep snapshot cadence while batching history');
  let cp = checkpoint(); cp.lastSuccessAt = new Date(Date.now() - 16 * 60000).toISOString(); setCheckpoint(cp);
  addRound(15); log = run(); let ops = posts(log, '/api/ops'); assert.equal(ops.length, 2); assert.equal(ops.at(-1).body.rounds.length, fixture.rounds.length);
  passed('elapsed interval uploads the accumulated full history');
  fixture.ops.unshift({ at: '2026-11-27T00:16:00Z', act: 'stop', market: 'TEST-PERP', done: true }); addRound(16); log = run(); assert.equal(posts(log, '/api/ops').length, 3);
  fixture.fills.unshift({ t: '2026-11-27T00:17:00Z', s: 'TEST', q: '1' }); addRound(17); log = run(); assert.equal(posts(log, '/api/ops').length, 4);
  passed('new trade action and newly collected fill bypass batching');
  fixture.dashboard.lastRoundStatus = 'observe_failed'; fixture.dashboard.dataValid = false; addRound(18); log = run(); assert.equal(posts(log, '/api/ops').length, 5);
  fixture.dashboard.lastRoundStatus = 'ok'; fixture.dashboard.dataValid = true; addRound(19); log = run(); assert.equal(posts(log, '/api/ops').length, 6);
  passed('fault and recovery bypass batching');
  const beforeSnapshotFailure = posts(log, '/api/ops').length; fixture.failSnapshot = true; addRound(20); log = run();
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'dashboard_upload.json'))).ok, false); assert.equal(posts(log, '/api/ops').length, beforeSnapshotFailure + 1);
  fixture.failSnapshot = false; addRound(21); log = run(); assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'dashboard_upload.json'))).ok, true); assert.equal(posts(log, '/api/ops').length, beforeSnapshotFailure + 2);
  passed('snapshot upload failure and recovery immediately publish changed history');
  fixture.fills.unshift({ t: '2026-11-27T00:20:00Z', s: 'TEST', q: '2' }); fixture.failOps = true; addRound(20); log = run(); assert.equal(posts(log, '/api/ops').at(-1).status, 500); const beforeRetry = checkpoint();
  fixture.failOps = false; log = run(); assert.equal(posts(log, '/api/ops').at(-1).status, 200); assert.notDeepEqual(checkpoint(), beforeRetry);
  passed('failed urgent upload retries without advancing successful checkpoint');
  const count = posts(log, '/api/ops').length; addRound(21); log = run({ routine: false }); assert.equal(posts(log, '/api/ops').length, count + 1);
  passed('manual dashboard upload keeps immediate history refresh');
  setCheckpoint('{broken'); addRound(22); log = run(); assert.equal(posts(log, '/api/ops').length, count + 2);
  cp = checkpoint(); cp.lastSuccessAt = new Date(Date.now() + 3600000).toISOString(); setCheckpoint(cp); addRound(23); log = run(); assert.equal(posts(log, '/api/ops').length, count + 3);
  passed('corrupt or future checkpoint fails open to immediate upload');
  const preNetwork = checkpoint(); fixture.fills.unshift({ t: '2026-11-27T00:24:00Z', s: 'TEST', q: '3' }); fixture.failOps = 'network'; addRound(24); log = run();
  assert.equal(posts(log, '/api/ops').at(-1).status, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'ops_upload.json'))).httpStatus, 0); assert.deepEqual(checkpoint(), preNetwork);
  fixture.failOps = false; log = run(); assert.equal(posts(log, '/api/ops').at(-1).status, 200);
  passed('network failure records valid status and the next round retries');
  const helper = path.join(base, 'scripts', 'ops_upload_policy.cjs'); fs.renameSync(helper, helper + '.disabled');
  const priorFallback = posts(log, '/api/ops').length; addRound(25); log = run(); assert.equal(posts(log, '/api/ops').length, priorFallback + 1); fs.renameSync(helper + '.disabled', helper);
  passed('missing policy falls back to the existing immediate hash gate');
  const mark = path.join(state, 'lock-held'); const lock = spawn('/bin/bash', ['-c', '( /usr/bin/lockf -s -t 0 9 || exit 2; printf ready > state/lock-held; /bin/sleep 3; rm -f state/lock-held ) 9>>state/ops_upload.lock'], { cwd: base, stdio: 'ignore' });
  const wait = (predicate, ms) => { const deadline = Date.now() + ms, sleeper = new Int32Array(new SharedArrayBuffer(4)); while (!predicate() && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20); assert(predicate(), 'fixture lock wait timed out'); };
  wait(() => fs.existsSync(mark), 3000); const beforeBusyOps = posts(log, '/api/ops').length, beforeBusySnapshots = posts(log, '/api/snapshot').length;
  fixture.ops.unshift({ at: '2026-11-27T00:26:00Z', act: 'create', market: 'TEST-PERP', done: true }); addRound(26); log = run();
  assert.equal(posts(log, '/api/ops').length, beforeBusyOps); assert.equal(posts(log, '/api/snapshot').length, beforeBusySnapshots + 1);
  wait(() => !fs.existsSync(mark), 6000); log = run(); assert.equal(posts(log, '/api/ops').length, beforeBusyOps + 1); assert.equal(posts(log, '/api/ops').at(-1).body.ops[0].act, 'create'); lock.kill();
  passed('concurrent history upload never delays snapshot and retries the new action');
  const beforeIdentity = posts(log, '/api/ops').length; fs.writeFileSync(path.join(state, 'account_identity.json'), JSON.stringify({ userId: 'fixture2', subaccountId: 3, accountKey: 'fixture2-3' })); addRound(27); log = run(); assert.equal(posts(log, '/api/ops').length, beforeIdentity + 1);
  passed('changed account cannot inherit another account batching checkpoint');
  assert.doesNotMatch(JSON.stringify(checkpoint()), /fixture|TEST-PERP/);
  const beforeUnchangedFault = posts(log, '/api/ops').length; fixture.dashboard.lastRoundStatus = 'observe_failed'; fixture.dashboard.dataValid = false; log = run();
  assert.equal(posts(log, '/api/ops').length, beforeUnchangedFault); assert.equal(posts(log, '/api/snapshot').at(-1).body.lastRoundStatus, 'observe_failed');
  fixture.dashboard.lastRoundStatus = 'ok'; fixture.dashboard.dataValid = true; log = run();
  passed('unchanged history adds no duplicate write while the live snapshot reports failure');
  const beforeBuildOps = posts(log, '/api/ops').length, beforeBuildSnapshots = posts(log, '/api/snapshot').length; fixture.failBuild = true; addRound(28); log = run();
  assert.equal(posts(log, '/api/ops').length, beforeBuildOps); assert.equal(posts(log, '/api/snapshot').length, beforeBuildSnapshots + 1);
  fixture.failBuild = false; fixture.ops.unshift({ at: '2026-11-27T00:28:00Z', act: 'stop', market: 'TEST-PERP', done: true }); log = run(); assert.equal(posts(log, '/api/ops').length, beforeBuildOps + 1);
  passed('history build failure cannot block snapshot and later action retries');
  const beforeCollection = posts(log, '/api/ops').length; fixture.collection.checkedAt = '2026-11-27T00:30:00Z'; addRound(30); log = run(); assert.equal(posts(log, '/api/ops').length, beforeCollection);
  fixture.ledgerAsOf = new Date().toISOString(); addRound(31); log = run(); assert.equal(posts(log, '/api/ops').length, beforeCollection + 1);
  assert.equal(posts(log, '/api/ops').at(-1).body.ledgerAsOf, fixture.ledgerAsOf);
  passed('new collection watermark uploads before the displayed coverage becomes stale');
  fixture.collection.ok = false; addRound(32); log = run(); assert.equal(posts(log, '/api/ops').length, beforeCollection + 2);
  fixture.collection.ok = true; addRound(33); log = run(); assert.equal(posts(log, '/api/ops').length, beforeCollection + 3);
  passed('collector watermark alone batches; collector failure and recovery upload immediately');
  fs.writeFileSync(path.join(state, 'ops_upload.json'), '{broken'); const beforeUnknownAttempt = posts(log, '/api/ops').length; addRound(34); log = run(); assert.equal(posts(log, '/api/ops').length, beforeUnknownAttempt + 1);
  passed('unreadable last upload status fails open');
  // Exercise the real locked runner in DRYRUN with fixture-only observation and
  // decision stubs, so batching is proven to receive the production BG_LOCKED marker.
  for (const name of ['run_round.sh', 'with_lock.py']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(base, 'scripts', name));
  fs.writeFileSync(path.join(base, 'scripts', 'ego_dispatch.sh'), '#!/bin/bash\n[ "$1" = scripts/observe.mjs ] || exit 9\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(base, 'scripts', 'decide.cjs'), "require('fs').writeFileSync('state/actions.json','[]');\n");
  fs.writeFileSync(path.join(base, 'scripts', 'run_events.cjs'), "if(process.argv[2]==='start')require('fs').writeFileSync('state/last_round_status','running');\n");
  fs.symlinkSync(process.execPath, path.join(base, 'bin', 'node'));
  const beforeRunnerOps = posts(log, '/api/ops').length, beforeRunnerSnapshots = posts(log, '/api/snapshot').length;
  for (const minute of [28, 29]) {
    addRound(minute); put();
    const env = { ...process.env, BG_ROOT: base, BG_PROXY: '', BG_LOCKED: '', DRYRUN: '1', TMPDIR: path.join(base, 'tmp'), PY_BIN: '/Users/nick/.browser-use-env/bin/python3', NODE_BIN: path.join(base, 'bin', 'node'),
      PATH: path.join(base, 'bin') + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) };
    const runner = spawnSync('/bin/bash', [path.join(base, 'scripts', 'run_round.sh')], { cwd: base, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(runner.status, 0, runner.stderr); assert.equal(fs.readFileSync(path.join(state, 'last_round_status'), 'utf8').trim(), 'dryrun');
  }
  log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(posts(log, '/api/snapshot').length, beforeRunnerSnapshots + 2); assert.equal(posts(log, '/api/ops').length, beforeRunnerOps);
  passed('real locked DRYRUN runner passes batching marker without changing snapshot cadence');
  const { decide } = require('../scripts/ops_upload_policy.cjs');
  const now = Date.parse('2026-11-27T01:00:00Z'), digest = 'a'.repeat(64), newer = 'b'.repeat(64);
  const sample = { accountHash: digest, contentHash: newer, importantHash: digest, unhealthy: false, coverageAt: new Date(now - 60000).toISOString() };
  const baseCheckpoint = { version: 1, accountHash: digest, contentHash: digest, importantHash: digest, lastSuccessAt: new Date(now - 5 * 60000).toISOString() };
  const decideAt = coverageAt => decide({ view: sample, checkpoint: { ...baseCheckpoint, coverageAt }, legacyHash: null, lastAttempt: { httpStatus: 200 }, routine: true, now });
  assert.equal(decideAt(new Date(now - 10 * 60000).toISOString()).upload, false);
  assert.equal(decideAt(new Date(now - 21 * 60000).toISOString()).reason, 'coverage-headroom');
  assert.equal(decideAt(null).reason, 'coverage-headroom');
  const noAdvance = { ...sample, coverageAt: new Date(now - 21 * 60000).toISOString() };
  assert.equal(decide({ view: noAdvance, checkpoint: { ...baseCheckpoint, coverageAt: noAdvance.coverageAt }, legacyHash: null, lastAttempt: { httpStatus: 200 }, routine: true, now }).upload, false);
  passed('coverage headroom only accelerates a newer usable watermark');
  for (const coverageAt of [null, new Date(now - 12 * 60000).toISOString()]) {
    const regressed = { ...sample, coverageAt };
    assert.equal(decide({ view: regressed, checkpoint: { ...baseCheckpoint, coverageAt: new Date(now - 10 * 60000).toISOString() }, legacyHash: null, lastAttempt: { httpStatus: 200 }, routine: true, now }).reason, 'coverage-regressed');
  }
  passed('coverage regression or loss is published immediately');
  const timing = minutes => decide({ view: sample, checkpoint: { ...baseCheckpoint, coverageAt: new Date(now - 10 * 60000).toISOString(), lastSuccessAt: new Date(now - minutes * 60000).toISOString() }, legacyHash: null, lastAttempt: { httpStatus: 200 }, routine: true, now });
  assert.equal(timing(13.9).upload, false); assert.equal(timing(14.5).reason, 'interval-or-clock');
  passed('one minute timing grace prevents a routine five-minute round slipping to twenty minutes');
} finally { fs.rmSync(base, { recursive: true, force: true }); }
