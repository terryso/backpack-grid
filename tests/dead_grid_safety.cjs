'use strict';
// Production decide with disposable state, no network, no exchange executor.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ROOT, PY } = require('./env.cjs');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json')));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-dead-grid-'));
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
function scenario(options = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-')); fs.mkdirSync(path.join(dir, 'state'));
  const put = (rel, x) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(x));
  const grid = { market: 'CALM-PERP', symbol: 'CALM_USDC_PERP', direction: '中性', range: ['100', '107'], count: 20, value: '1000', allocationRaw: 1000, pnlRaw: options.tp ? 120 : 0, pnlPct: options.tp ? 12 : 0, status: options.disabled ? 'Disabled' : 'Triggered', nativeTP: options.protect ? 11 : 10, nativeSL: 6, nativeCloseOnStop: true };
  const now = Date.now(), vol = options.historyVol ?? 100;
  const normalHistory = { vol, samples: [{ at: now - 50 * 3600000, vol }, { at: now - 3600000, vol }] };
  put('config.json', cfg); put('state/account_identity.json', identity);
  put('state/risk.json', { peakEquity: 1000, paused: null, accountKey: identity.accountKey });
  put('state/observed.json', { at: new Date().toISOString(), identity, gridRows: [grid], positions: [], badges: {}, margin: { totalEquity: options.trip ? '100' : '1000', availableEquity: '100', openPnl: '0' }, ledger: options.missingLedger ? [] : [{ symbol: grid.symbol, vol: Object.hasOwn(options, 'ledgerVol') ? options.ledgerVol : vol }] });
  if (options.historyDirectory) fs.mkdirSync(path.join(dir, 'state/grid_activity.json'));
  else put('state/grid_activity.json', { [grid.symbol]: Object.hasOwn(options, 'history') ? options.history : normalHistory });
  if (options.manualCorrupt) fs.writeFileSync(path.join(dir, 'state/manual_pauses.json'), '{broken');
  if (options.manualHold) put('state/manual_pauses.json', { [grid.market]: { accountKey: identity.accountKey, intent: 'hold', at: new Date().toISOString() } });
  if (options.pending) put('state/pending_stops.json', { [grid.market]: { accountKey: identity.accountKey, at: new Date().toISOString(), reason: 'fixture cleanup' } });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...process.env, PY_BIN: PY, BG_ROOT: dir, BG_OFFLINE: '1', BG_PHASE: '', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) }, encoding: 'utf8', timeout: 15000 });
  let actions = null; try { actions = JSON.parse(fs.readFileSync(path.join(dir, 'state/actions.json'))); } catch {}
  return { status: r.status, actions, stdout: r.stdout, stderr: r.stderr };
}
const isDead = a => a.act === 'stop' && /DEAD_GRID/.test(a.reason || '');
function run() {
  let count = 0;
  const check = (name, options, assertion) => { const r = scenario(options); assert.equal(r.status, 0, r.stderr); assert(Array.isArray(r.actions)); assertion(r); count++; console.log('PASS', name); };
  check('active mature flat grid retains existing rotation', {}, r => assert(r.actions.some(isDead)));
  check('Disabled within TP/SL is preserved despite mature flat history', { disabled: true }, r => assert(!r.actions.some(isDead)));
  check('corrupt manual registry vetoes optional dead-grid rotation', { manualCorrupt: true }, r => assert(!r.actions.some(isDead)));
  check('explicit manual hold is preserved', { manualHold: true }, r => assert(!r.actions.some(isDead)));
  check('missing sample array cannot discard a TP stop', { tp: true, history: { vol: 100 } }, r => assert(r.actions.some(a => /TP:/.test(a.reason || ''))));
  check('bad activity history cannot discard account breaker stops', { trip: true, history: { vol: 100 } }, r => assert(r.actions.some(a => a.act === 'stop')));
  check('bad activity history cannot discard pending retries', { pending: true, history: { vol: 100 } }, r => assert(r.actions.some(a => a.act === 'stop')));
  check('activity storage I/O error cannot discard a TP stop', { tp: true, historyDirectory: true }, r => { assert(r.actions.some(a => /TP:/.test(a.reason || ''))); assert(r.stdout.includes('GRID ACTIVITY WRITE FAILED')); });
  check('dead-grid stop supersedes same-market protection repair', { protect: true }, r => { assert(r.actions.some(isDead)); assert(!r.actions.some(a => a.act === 'protect')); });
  check('missing current ledger is unknown, not a zero-fill observation', { missingLedger: true }, r => assert(!r.actions.some(isDead)));
  for (const v of [null, false, '', '  ', [], {}, '0x0']) check('invalid current ledger cannot confirm dead grid: ' + JSON.stringify(v), { ledgerVol: v, historyVol: 0 }, r => assert(!r.actions.some(isDead)));
  const now = Date.now();
  for (const history of [{ vol: 100, samples: [null] }, { vol: 100, samples: [{ at: now - 50 * 3600000, vol: null }] }, { vol: 100, samples: [{ at: false, vol: 100 }] }, { vol: 100, samples: [{ at: now + 3600000, vol: 100 }] }, { vol: 100, samples: [{ at: now - 3600000, vol: 100 }, { at: now - 50 * 3600000, vol: 100 }] }, 'bad']) {
    check('invalid history restarts warmup instead of confirming rotation #' + count, { history }, r => assert(!r.actions.some(isDead)));
  }
  console.log(count + ' dead-grid safety cases passed');
}
try {
  if (process.argv.includes('--probe')) {
    console.log(JSON.stringify(Object.fromEntries([
      ['disabled', { disabled: true }], ['manualRegistryCorrupt', { manualCorrupt: true }], ['tpStopWithBadHistory', { tp: true, history: { vol: 100 } }], ['tpStopWithStorageError', { tp: true, historyDirectory: true }], ['deadStopWithProtect', { protect: true }],
    ].map(([name, options]) => { const r = scenario(options); return [name, { status: r.status, acts: r.actions?.map(a => ({ act: a.act, reason: a.reason })), error: (r.stderr + '\n' + r.stdout).split('\n').find(l => /DECIDE FAILED|TypeError|EISDIR|Error:/.test(l)) }]; })), null, 2));
  } else run();
} catch (e) { console.error(e); process.exitCode = 1; }
finally { fs.rmSync(base, { recursive: true, force: true }); }
