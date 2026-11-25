'use strict';
// Real planner and stop executor; all state and I/O below are disposable fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sourceRoot = process.env.BG_TEST_SOURCE_ROOT || path.join(__dirname, '..');
const { planAutoExits } = require(path.join(sourceRoot, 'scripts/auto_exits.cjs'));
const { makeStopGrid } = require(path.join(sourceRoot, 'scripts/act_core.cjs'));
const identity = { userId: 'fixture', subaccountId: 1, accountKey: 'fixture-1' };
const cfg = { autoExitsEnabled: true, trailArmPct: 10, trailGivebackPct: 4,
  positionStopLossPct: 100, positionTakeProfitPct: 0, breachDwellMin: 10, breachBufferPct: 0.5 };
const grid = { market: 'TEST-PERP', symbol: 'TEST_USDC_PERP', range: ['90', '110'], price: 100, status: 'Triggered' };

async function checkFailureBeforeIntent(failAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-trail-actor-'));
  fs.mkdirSync(path.join(root, 'state'));
  function plan(pnlPct, at) {
    const actions = [], lines = [];
    planAutoExits({ ROOT: root, identity, cfg, obs: { at, positions: [{ market: grid.market, pnlPct, mark: '100' }] },
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
      loadPending: async () => ({ pending: {}, corrupt: false }),
      savePending: async () => { pendingWrites++; if (failAt === 'intent') throw Error('fixture intent write failed'); },
      getAutomation: async () => { throw Error('unexpected automation request'); },
      jpatch: async () => { exchangeWrites++; throw Error('unexpected exchange write'); },
    });
    await assert.rejects(stop(grid.market, grid.range, first[0].reason, []), /fixture (account unavailable|intent write failed)/);
    assert.equal(pendingWrites, failAt === 'intent' ? 1 : 0); assert.equal(exchangeWrites, 0);
    const retry = plan(8.9, '2026-11-25T11:30:00Z');
    assert.equal(retry.length, 1); assert.match(retry[0].reason, /AUTO_TRAIL/);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/trail_peak.json'), 'utf8'));
    assert.equal(state.markets[grid.market].peak, 13);
    console.log(`PASS AUTO_TRAIL retries after ${failAt} failure before a stop intent exists`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => { await checkFailureBeforeIntent('account'); await checkFailureBeforeIntent('intent'); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
