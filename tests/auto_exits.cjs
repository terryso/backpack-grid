'use strict';
// auto_exits.cjs — gated planner for dwell range-exits + position-level SL/TP.
// Covered here: gate defaults, config validation, SL/TP thresholds, dwell timers,
// recovery resets, dedupe vs existing stops, manual/pending holds, corrupt state,
// mark-price fallback, clock-skew clamping, and prune of unconfigured markets.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { planAutoExits, defaultsFor } = require('../scripts/auto_exits.cjs');
const { validateConfig } = require('../scripts/contracts.cjs');

let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
const iso = (offsetMin, base = Date.UTC(2026, 9, 8, 12, 0, 0)) => new Date(base + offsetMin * 60000).toISOString();

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-auto-exits-'));
  fs.mkdirSync(path.join(dir, 'state'));
  return { dir, ...overrides };
}
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
const baseCfg = {
  autoExitsEnabled: true, breachDwellMin: 10, breachBufferPct: 0.5,
  positionStopLossPct: 150, positionTakeProfitPct: 150, accountFloorUsd: 500,
  takeProfitPct: 10, stopLossPct: 6, exitBufferPct: 1, riskBudgetPct: 80, warnDrawdownPct: 40,
};
const gridZ = (price) => ({ market: 'ZEC-PERP', symbol: 'ZEC_USDC_PERP', price, range: ['1228.81225', '1417.02775'], status: 'Triggered', allocationRaw: 2250, pnlPct: 0 });
const posZ = (pnlPct, mark) => ({ market: 'ZEC-PERP', pnl: '-1.00', pnlPct, mark: String(mark) });
const obsOf = (grids, positions, atMin) => ({ at: iso(atMin), identity, gridRows: grids, positions, margin: { totalEquity: '500', availableEquity: '200' } });

function run(dir, cfg, obs, grids, actions = [], lines = [], heldByUser = () => false) {
  planAutoExits({ ROOT: dir, identity, cfg, obs, grids, pending: {}, heldByUser, manualCorrupt: false, actions, lines });
  return actions;
}
const dwellFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'breach_dwell.json'), 'utf8'));

// ---------- gate & defaults ----------
check('defaults: documented fallbacks when keys missing', () => {
  const d = defaultsFor({});
  assert.deepEqual(d, { dwellMin: 10, bufferPct: 0.5, posSl: 150, posTp: 150 });
});
check('defaults: explicit config wins', () => {
  assert.equal(defaultsFor({ breachDwellMin: 30 }).dwellMin, 30);
  assert.equal(defaultsFor({ positionTakeProfitPct: 0 }).posTp, 0);
});
check('validateConfig accepts the auto-exits block', () => {
  validateConfig({ ...baseCfg, maxGrids: 4, maxPerEcosystem: 2, gridValueUsd: 2500, leverageCap: 10, minQvol24h: 0, liqDangerPct: 12, analysisMaxAgeMin: 30, exitCostBufferUsd: 15, minScore: 5 });
});
check('validateConfig rejects bad auto-exits values', () => {
  for (const bad of [{ autoExitsEnabled: 'yes' }, { breachDwellMin: 0 }, { breachDwellMin: 2000 }, { breachBufferPct: -1 }, { positionStopLossPct: 0 }, { positionTakeProfitPct: -5 }, { accountFloorUsd: -1 }]) {
    assert.throws(() => validateConfig({ ...baseCfg, ...bad, maxGrids: 4, maxPerEcosystem: 2, gridValueUsd: 2500, leverageCap: 10, minQvol24h: 0, liqDangerPct: 12, analysisMaxAgeMin: 30, exitCostBufferUsd: 15, minScore: 5 }), /invalid config/, bad.autoExitsEnabled || Object.keys(bad)[0]);
  }
});

// ---------- position-level SL ----------
check('AUTO_SL fires at or below the position threshold, ignores inside', () => {
  const { dir } = fixture();
  const cfg = { ...baseCfg };
  const g = [gridZ(1100)];
  assert.equal(run(dir, cfg, obsOf(g, [posZ(-150.0, 1100)], 0), g).length, 1);
  assert.equal(run(dir, cfg, obsOf(g, [posZ(-150.1, 1100)], 0), g).length, 1);
  assert.equal(run(dir, cfg, obsOf(g, [posZ(-149.9, 1100)], 0), g).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('AUTO_SL reason names the threshold', () => {
  const { dir } = fixture();
  const g = [gridZ(1100)];
  const a = run(dir, { ...baseCfg }, obsOf(g, [posZ(-200, 1100)], 0), g);
  assert.match(a[0].reason, /AUTO_SL: position pnl -200\.0% <= -150%/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- position-level TP ----------
check('AUTO_TP fires at or above threshold and is disabled at 0', () => {
  const { dir } = fixture();
  const g = [gridZ(1400)];
  assert.equal(run(dir, { ...baseCfg }, obsOf(g, [posZ(150, 1400)], 0), g).length, 1);
  assert.equal(run(dir, { ...baseCfg }, obsOf(g, [posZ(149.9, 1400)], 0), g).length, 0);
  assert.equal(run(dir, { ...baseCfg, positionTakeProfitPct: 0 }, obsOf(g, [posZ(999, 1400)], 0), g).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('AUTO_SL outranks AUTO_TP (SL checked first)', () => {
  const { dir } = fixture();
  const g = [gridZ(1100)];
  const a = run(dir, { ...baseCfg }, obsOf(g, [posZ(-500, 1100)], 0), g);
  assert.match(a[0].reason, /AUTO_SL/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- dwell range exit ----------
check('breach below low edge: first round starts the timer, no stop', () => {
  const { dir } = fixture();
  const g = [gridZ(1221)]; // low edge = 1228.81225 * 0.995 = 1222.67 → 1221 is breached
  const lines = [];
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 0), g, [], lines);
  assert.equal(a.length, 0);
  assert.ok(lines.some((l) => /AUTO DWELL ZEC-PERP/.test(l)), lines.join('\n'));
  const st = dwellFile(dir);
  assert.equal(st.markets['ZEC-PERP'].side, 'low');
  assert.equal(st.accountKey, identity.accountKey);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('dwell past breachDwellMin plans the range exit', () => {
  const { dir } = fixture();
  const g = [gridZ(1221)];
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g); // t0: start timer
  const lines = [];
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 11), g, [], lines); // t+11m >= 10m
  assert.equal(a.length, 1);
  assert.match(a[0].reason, /AUTO_RANGE_EXIT.*for 11m >= 10m/);
  assert.ok(lines.some((l) => /AUTO RANGE EXIT ZEC-PERP/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
check('recovery inside the range clears the dwell timer', () => {
  const { dir } = fixture();
  const g = [gridZ(1221)];
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  const recovered = [gridZ(1240)]; // price back inside range (grids === obs.gridRows in production)
  run(dir, { ...baseCfg }, obsOf(recovered, [], 5), recovered);
  assert.equal(dwellFile(dir).markets['ZEC-PERP'], undefined);
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 8), g); // re-breach: timer restarts
  assert.equal(a.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('breach above high edge also tracked', () => {
  const { dir } = fixture();
  const g = [gridZ(1425)]; // high edge = 1417.02775 * 1.005 = 1424.11 → 1425 breached
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  assert.equal(dwellFile(dir).markets['ZEC-PERP'].side, 'high');
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 10), g);
  assert.equal(a.length, 1);
  assert.match(a[0].reason, /beyond high edge/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('ticker outage simulation: grid price used with no positions and no tickers', () => {
  const { dir } = fixture();
  const g = [gridZ(1221)]; // g.price present; pos list empty — no tickers anywhere
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 12), g);
  assert.equal(a.length, 0); // cold start: timer begins at first sighting (cannot know prior duration)
  const a2 = run(dir, { ...baseCfg }, obsOf(g, [], 24), g);
  assert.equal(a2.length, 1); // dwell satisfied using grid price alone → stop planned
  assert.match(a2[0].reason, /AUTO_RANGE_EXIT/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('falls back to positions.mark when grid price missing', () => {
  const { dir } = fixture();
  const g = [{ ...gridZ(undefined) }];
  const obs1 = obsOf(g, [posZ(0, 1221)], 12); // grid price undefined → mark 1221 is the only price
  run(dir, { ...baseCfg }, obs1, g); // cold start: timer starts from mark price
  const obs2 = obsOf(g, [posZ(0, 1221)], 24); // same breach 12m later
  const a = run(dir, { ...baseCfg }, obs2, g);
  assert.equal(a.length, 1);
  assert.match(a[0].reason, /AUTO_RANGE_EXIT/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('clock skew (obs.at earlier than timer start) clamps to zero, never stops early', () => {
  const { dir } = fixture();
  const g = [gridZ(1221)];
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  const lines = [];
  const a = run(dir, { ...baseCfg }, obsOf(g, [], -30), g, [], lines); // 30 min in the past
  assert.equal(a.length, 0);
  assert.ok(lines.some((l) => /for 0\.0m/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- interaction with the rest of decide ----------
check('never duplicates an already-planned stop for the same market', () => {
  const { dir } = fixture();
  const g = [gridZ(1100)];
  const existing = [{ act: 'stop', market: 'ZEC-PERP', range: g[0].range, reason: 'circuit breaker' }];
  const a = run(dir, { ...baseCfg }, obsOf(g, [posZ(-999, 1100)], 0), g, existing);
  assert.equal(a.length, 1);
  assert.match(a[0].reason, /circuit breaker/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('manually held and pending grids are skipped', () => {
  const { dir } = fixture();
  const g = [gridZ(1100), { ...gridZ(1100), market: 'SOL-PERP', symbol: 'SOL_USDC_PERP' }];
  const obs = obsOf(g, [posZ(-999, 1100), { ...posZ(-999, 1100), market: 'SOL-PERP' }], 0);
  let called = 0;
  const heldByUser = (m) => (m === 'ZEC-PERP' ? (called++, true) : false);
  const lines = [];
  const a = run(dir, { ...baseCfg }, obs, g, [], lines, heldByUser);
  assert.equal(a.filter((x) => x.market === 'ZEC-PERP').length, 0); // held → untouched
  assert.equal(a.filter((x) => x.market === 'SOL-PERP').length, 1); // not held → SL fires
  assert.ok(called >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('Disabled (manually paused) grids: SL, TP and range exit all leave untouched', () => {
  const { dir } = fixture();
  // worst case stacked: deep-water position AND price below the low edge (dwould-be dwell)
  const paused = [{ ...gridZ(1100), status: 'Disabled' }];
  const a = run(dir, { ...baseCfg }, obsOf(paused, [posZ(-999, 1100)], 0), paused);
  assert.equal(a.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'breach_dwell.json')), 'no dwell timer may start for a paused grid');
  // the same fixture live (Triggered) is exit-worthy — proves the skip is the status gate
  const live = [{ ...gridZ(1100), status: 'Triggered' }];
  const a2 = run(dir, { ...baseCfg }, obsOf(live, [posZ(-999, 1100)], 0), live);
  assert.equal(a2.length, 1);
  assert.match(a2[0].reason, /AUTO_SL/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('dwell timers for unconfigured markets are pruned', () => {
  const { dir } = fixture();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'breach_dwell.json'), JSON.stringify({ accountKey: identity.accountKey, markets: { 'ETH-PERP': { side: 'low', edge: 90, since: iso(0) } } }));
  const g = [gridZ(1240)];
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  assert.equal(dwellFile(dir).markets['ETH-PERP'], undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('corrupt dwell state starts fresh instead of crashing', () => {
  const { dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state', 'breach_dwell.json'), '{not json');
  const g = [gridZ(1221)];
  const a = run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  assert.equal(a.length, 0); // timer restarted, no crash
  assert.equal(dwellFile(dir).accountKey, identity.accountKey);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('invalid since is repaired on disk and the dwell clock then completes', () => {
  const { dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state', 'breach_dwell.json'), JSON.stringify({
    accountKey: identity.accountKey,
    markets: { 'ZEC-PERP': { side: 'low', edge: 1222.668, since: 'invalid-time' } },
  }));
  const g = [gridZ(1221)];
  const a1 = run(dir, { ...baseCfg }, obsOf(g, [], 30), g); // timer restarts at 0 — no stop yet
  assert.equal(a1.length, 0);
  const st = dwellFile(dir);
  assert.ok(Number.isFinite(Date.parse(st.markets['ZEC-PERP'].since)), 'repaired since must be persisted, not recomputed every round');
  const a2 = run(dir, { ...baseCfg }, obsOf(g, [], 41), g); // 11 minutes later the threshold is met
  assert.equal(a2.length, 1);
  assert.match(a2[0].reason, /AUTO_RANGE_EXIT/);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('account mismatch resets dwell state', () => {
  const { dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state', 'breach_dwell.json'), JSON.stringify({ accountKey: 'other-0', markets: { 'ZEC-PERP': { side: 'low', edge: 1, since: iso(0) } } }));
  const g = [gridZ(1221)];
  run(dir, { ...baseCfg }, obsOf(g, [], 0), g);
  assert.equal(dwellFile(dir).accountKey, identity.accountKey);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`${count} auto exits scenarios passed`);
