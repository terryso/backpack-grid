'use strict';
// Real planner and stop executor; all state and I/O below are disposable fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sourceRoot = process.env.BG_TEST_SOURCE_ROOT || path.join(__dirname, '..');
const { planAutoExits } = require(path.join(sourceRoot, 'scripts/auto_exits.cjs'));
const { makeStopGrid } = require(path.join(sourceRoot, 'scripts/act_core.cjs'));
const identity = { userId: 'fixture', subaccountId: 1, accountKey: 'fixture-1' };
const cfg = { autoExitsEnabled: true, trailArmPct: 10, trailGivebackPct: 4,
  positionStopLossPct: 100, positionTakeProfitPct: 0, breachDwellMin: 10, breachBufferPct: 0.5 };
const grid = { market: 'TEST-PERP', symbol: 'TEST_USDC_PERP', range: ['90', '110'], price: 100, status: 'Triggered' };
const positionReference = 'a'.repeat(64);

async function checkFailureBeforeIntent(failAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-trail-actor-'));
  fs.mkdirSync(path.join(root, 'state'));
  function plan(pnlPct, at) {
    const actions = [], lines = [];
    planAutoExits({ ROOT: root, identity, cfg, obs: { at, positions: [{ market: grid.market, pnlPct, mark: '100' }],
      positionRefs: { [grid.market]: positionReference } },
      grids: [grid], pending: {}, heldByUser: () => false, manualCorrupt: false, actions, lines });
    return actions;
  }
  try {
    assert.equal(plan(13, '2026-11-25T11:00:00Z').length, 0);
    const first = plan(8.9, '2026-11-25T11:15:00Z');
    assert.equal(first.length, 1); assert.match(first[0].reason, /AUTO_TRAIL/);
    let pendingWrites = 0, exchangeWrites = 0;
    const stop = makeStopGrid({
      assertAccount: async () => { if (failAt === 'account') throw Error('fixture account unavailable'); },
      getTrailPositionRef: async () => ({ state: 'known', ref: positionReference }),
      loadPending: async () => ({ pending: {}, corrupt: false }),
      savePending: async () => { pendingWrites++; if (failAt === 'intent') throw Error('fixture intent write failed'); },
      getAutomation: async () => { throw Error('unexpected automation request'); },
      jpatch: async () => { exchangeWrites++; throw Error('unexpected exchange write'); },
    });
    await assert.rejects(stop(grid.market, grid.range, first[0].reason, [], { trailPositionRef: first[0].trailPositionRef }), /fixture (account unavailable|intent write failed)/);
    assert.equal(pendingWrites, failAt === 'intent' ? 1 : 0); assert.equal(exchangeWrites, 0);
    const retry = plan(8.9, '2026-11-25T11:30:00Z');
    assert.equal(retry.length, 1); assert.match(retry[0].reason, /AUTO_TRAIL/);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/trail_peak.json'), 'utf8'));
    assert.equal(state.markets[grid.market].peak, 13);
    console.log(`PASS AUTO_TRAIL retries after ${failAt} failure before a stop intent exists`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function checkLegacyAbsentGrid() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-trail-legacy-pending-'));
  fs.mkdirSync(path.join(root, 'state'));
  const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  try {
    const config = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config.example.json')));
    const owner = { userId: 'fixture', subaccountId: config.subaccountId ?? 3, accountKey: 'fixture-' + (config.subaccountId ?? 3) };
    const at = new Date().toISOString();
    put('config.json', config); put('state/account_identity.json', owner);
    put('state/observed.json', { at, identity: owner, gridRows: [], positions: [], margin: { totalEquity: '500', availableEquity: '400' } });
    put('state/risk.json', { accountKey: owner.accountKey, peakEquity: 500, paused: null });
    const legacy = { 'TEST-PERP': { accountKey: owner.accountKey, at, reason: 'AUTO_TRAIL: legacy without position reference' } };
    put('state/pending_stops.json', legacy);
    const run = spawnSync(process.execPath, [path.join(sourceRoot, 'scripts/decide.cjs')], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, BG_ROOT: root, BG_OFFLINE: '1', PY_BIN: '/Users/nick/.browser-use-env/bin/python3',
        NODE_OPTIONS: '--require ' + JSON.stringify(path.join(sourceRoot, 'tests/no_network.cjs')) } });
    assert.equal(run.status, 0, run.stderr);
    const action = JSON.parse(fs.readFileSync(path.join(root, 'state/actions.json'), 'utf8')).find(a => a.market === 'TEST-PERP' && a.act === 'stop');
    assert(action); assert.match(action.reason, /grid absent/);
    assert.equal(Object.prototype.hasOwnProperty.call(action, 'trailPositionRef'), true, 'legacy trailing retry must carry the trailing guard');
    let patches = 0;
    const stop = makeStopGrid({ assertAccount: async () => {}, loadPending: async () => ({ pending: structuredClone(legacy) }),
      getAutomation: async () => ({ params: { symbols: [{ symbol: 'TEST_USDC_PERP', enabled: true }] } }),
      getTrailPositionRef: async () => ({ state: 'known', ref: positionReference }),
      savePending: async () => {}, jpatch: async () => { patches++; return { status: 200 }; } });
    await assert.rejects(stop(action.market, action.range, action.reason, [], { trailPositionRef: action.trailPositionRef }), /trail position identity unavailable/);
    assert.equal(patches, 0);
    console.log('PASS legacy trailing pending stays guarded when grid reappears after planning');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => { await checkFailureBeforeIntent('account'); await checkFailureBeforeIntent('intent'); await checkLegacyAbsentGrid(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
