'use strict';
// Evidence of observed defects at 56d0cde, not target-behavior regression tests.
// Every external I/O is mocked; all state lives in disposable temporary directories.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json')));
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-reaudit-'));
const rows = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(parent, 'fixture-')); fs.mkdirSync(path.join(dir, 'state')); put(dir, 'config.json', cfg); fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true }); return dir; };
const put = (dir, file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
const get = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const record = (id, details) => { rows.push({ id, reproduced: true, ...details }); console.log('REPRODUCED', id); };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function actualAct(mode) {
  const dir = fixture(), at = new Date().toISOString();
  const localCfg = mode === 'identity-mismatch' ? { ...cfg, userId: 'expected-owner' } : cfg;
  put(dir, 'config.json', localCfg);
  const actions = [{ act: 'create', market: 'ETH-PERP', lower: 90, upper: 110, count: 20, value: 500 }];
  const hash = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  put(dir, 'state/actions.json', actions);
  put(dir, 'state/actions_meta.json', { at, configHash: hash(localCfg), actionsHash: hash(actions), subaccountId: cfg.subaccountId || 3, riskWriteOk: true });
  put(dir, 'state/risk.json', { peakEquity: 1000, paused: null });
  put(dir, 'state/pending_stops.json', {});
  let autos = mode.startsWith('live-') ? [{ symbol: 'OLD_USDC_PERP', allocationUsd: '1000', priceLow: '90', priceHigh: '110', levels: 20, enabled: true, direction: 'Neutral', stopLossPercentage: 6, takeProfitPercentage: 10, closePositionsOnStop: true }] : [];
  let writes = 0;
  const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async (url, options = {}) => {
    const u = new URL(url), method = options.method || 'GET';
    if (method === 'POST') return { status: 200, body: '{}' };
    if (method === 'PATCH') {
      writes++;
      const e = JSON.parse(options.body).params.symbols[0];
      autos = autos.filter((g) => g.symbol !== e.symbol);
      if (e.operation !== 'Delete') autos.push({ ...e,
        ...(mode === 'stored-allocation' ? { allocationUsd: '100000' } : {}),
        ...(mode === 'stored-upper' ? { priceHigh: '150' } : {}) });
      return { status: 200, body: '{}' };
    }
    let data;
    if (u.pathname.endsWith('/automation')) data = { params: { symbols: autos } };
    else if (u.pathname.endsWith('/position')) data = mode.startsWith('live-') ? [{ symbol: 'OLD_USDC_PERP', netQuantity: mode === 'live-unknown' ? null : '1', markPrice: '100', estLiquidationPrice: '99' }] : [];
    else if (u.pathname.endsWith('/collateral')) data = { [mode === 'identity-mismatch' ? 'different-owner-3' : 'fixture-3']: { netEquity: '1000' } };
    else if (u.pathname.endsWith('/markPrices')) data = [{ symbol: 'ETH_USDC_PERP', markPrice: '100' }];
    else if (u.pathname.endsWith('/orders')) data = Array.from({ length: 20 }, () => ({ symbol: 'ETH_USDC_PERP' }));
    else throw new Error('unexpected mock endpoint ' + u.pathname);
    return { status: 200, body: JSON.stringify(data) };
  } };
  const source = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8').replace('const ROOT = "/Users/nick/CascadeProjects/backpack_grid";', 'const ROOT = ' + JSON.stringify(dir) + ';');
  let exit = 0;
  try { await new AsyncFunction('taskSpace', 'console', 'process', source)(async () => ({ page: () => page }), { log() {} }, { exit: (code) => { throw Object.assign(new Error('mock exit'), { exit: code }); } }); }
  catch (e) { if (e.exit === undefined) throw e; exit = e.exit; }
  const result = get(dir, 'state/act_results.json');
  assert.equal(exit, 0); assert(result.results.some((r) => r.act === 'create' && r.done === true));
  assert.deepEqual(get(dir, 'state/pending_stops.json'), {});
  const applied = autos.find((g) => g.symbol === 'ETH_USDC_PERP');
  return { exit, writes, result: result.results, applied, pendingCleared: true };
}
async function main() {
  let r = await actualAct('stored-allocation');
  assert.equal(Number(r.applied.allocationUsd), 100000);
  record('N01a_config_confirmation_ignores_actual_allocation', { requestedValue: 500, storedValue: 100000, storedSlRisk: 6000, accountBudgetBeforeBuffer: 800, ...r });
  r = await actualAct('stored-upper'); assert.equal(r.applied.priceHigh, '150');
  record('N01b_config_confirmation_ignores_upper_bound', { requestedUpper: 110, ...r });
  r = await actualAct('live-danger'); record('N02a_live_liquidation_danger_does_not_veto_create', { mark: 100, liq: 99, distancePct: 1, configuredDangerPct: cfg.liqDangerPct, ...r });
  r = await actualAct('live-unknown'); record('N02b_live_unknown_quantity_does_not_veto_create', { freshQuantity: null, ...r });
  r = await actualAct('identity-mismatch'); record('N08_expected_user_identity_is_not_checked_against_live_collateral_owner', { configuredUserId: 'expected-owner', liveCollateralKey: 'different-owner-3', ...r });
  // run_events copies a previous result file into a newly started run without binding.
  let dir = fixture(); const oldAt = '2026-10-01T00:00:00Z';
  put(dir, 'state/act_results.json', { at: oldAt, results: [{ act: 'stop', market: 'OLD-PERP', done: true }] });
  for (const args of [['start'], ['actions', 'phase1'], ['end', 'act_failed']]) {
    const p = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_events.cjs'), ...args], { env: { ...process.env, BG_ROOT: dir }, encoding: 'utf8' }); assert.equal(p.status, 0);
  }
  const events = fs.readFileSync(path.join(dir, 'state/run_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(events[0].results[0].done); assert.equal(events[1].status, 'act_failed');
  record('N03_old_act_results_relabelled_as_current_run_successful_stop', { oldResultAt: oldAt, events });
  const { collectHistory, summarizeHistory, START } = require(path.join(ROOT, 'scripts/history_core.cjs'));
  const fill = (id, timestamp, fee) => ({ id, timestamp, price: '100', quantity: '1', fee: String(fee), feeSymbol: 'USDC', isMaker: true });
  const until = START + 10000;
  let h = await collectHistory({ symbols: {} }, ['X'], until, async () => [fill('one', START + 1, .1), fill('one', START + 1, .2)]);
  assert.equal(h.incomplete, false); assert.equal(Object.keys(h.symbols.X.fills).length, 1);
  record('N04a_conflicting_duplicate_ids_in_same_page_silently_overwrite', { feeUsd: summarizeHistory(h).symbols.X.feeUsd, retainedFills: Object.keys(h.symbols.X.fills).length, cursor: h.symbols.X.lastTo, incomplete: h.incomplete });
  h = await collectHistory({ symbols: { X: { from: START, lastTo: until + 86400000, fills: {} } } }, ['X'], until, async () => { throw new Error('must not be queried'); });
  assert.equal(h.incomplete, false);
  record('N04b_future_cursor_is_reported_caught_up', { acquiredAt: h.acquiredAt, futureCursor: h.symbols.X.lastTo, incomplete: h.incomplete });
  h = await collectHistory({ symbols: {} }, ['X'], until, async () => []);
  const late = fill('late', START + 9000, .1); let queryFrom;
  h = await collectHistory(h, ['X'], until + 10000, async (s, lo, hi) => { queryFrom = lo; return late.timestamp >= lo && late.timestamp <= hi ? [late] : []; });
  assert.equal(Object.keys(h.symbols.X.fills).length, 0);
  record('N04c_late_indexed_fill_is_never_revisited', { queryFrom, lateTimestamp: late.timestamp, fees: summarizeHistory(h).symbols.X.feeUsd, incomplete: h.incomplete, boundary: 'mocked delayed history indexing; not evidence it happened live' });
  // Incremental importer re-tags foreign-account records as the current account.
  dir = fixture(); const cov = { cashflow: { from: '2026-09-30T00:00:00Z', through: '2026-10-03T00:00:00Z', source: 'fixture-reconciled' } };
  put(dir, 'state/attribution_ledger.json', { subaccountId: 2, events: [{ id: 'foreign-deposit', type: 'cashflow', amountUsd: 100, at: '2026-10-01T00:00:00Z', source: 'account-2-export' }], coverage: cov });
  put(dir, 'input.json', { subaccountId: cfg.subaccountId || 3, events: [], coverage: cov });
  const p = spawnSync(process.execPath, [path.join(ROOT, 'scripts/import_ledger.cjs'), path.join(dir, 'input.json')], { env: { ...process.env, BG_ROOT: dir }, encoding: 'utf8' });
  assert.equal(p.status, 0); const imported = get(dir, 'state/attribution_ledger.json'); assert.equal(imported.subaccountId, 3); assert.equal(imported.events.length, 1);
  const attributed = require(path.join(ROOT, 'scripts/accounting.cjs')).attribution(imported, '2026-09-30T00:00:00Z', '2026-10-03T00:00:00Z', 110);
  assert.equal(attributed.strategyPnl, 10);
  record('N05_import_retains_foreign_account_events_under_current_account', { imported, attributed });
  // A changed liquidity threshold is ignored while an old analysis is still fresh.
  dir = fixture(); const changedCfg = { ...cfg, minQvol24h: 5000000 }; put(dir, 'config.json', changedCfg);
  const fresh = new Date().toISOString();
  put(dir, 'state/observed.json', { at: fresh, gridRows: [], positions: [], ledger: [], margin: { totalEquity: '1000', availableEquity: '500', openPnl: '0' } });
  put(dir, 'state/risk.json', { peakEquity: 1000, paused: null }); put(dir, 'state/pending_stops.json', {});
  put(dir, 'state/analysis.json', { generatedAt: fresh, top: [{ symbol: 'ETH_USDC_PERP', score: 10, chop: 10, range24: 5, qvol24: 1000000, fundingRate: 0, grid: { lower: 90, upper: 110, count: 20 } }], directional: [] });
  put(dir, 'state/tickers.json', [{ symbol: 'ETH_USDC_PERP', lastPrice: '100', quoteVolume: '1000000' }]);
  const decision = spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...process.env, BG_ROOT: dir, BG_OFFLINE: '0', BG_TICKERS_FILE: path.join(dir, 'state/tickers.json') }, encoding: 'utf8', timeout: 15000 });
  assert.equal(decision.status, 0); const planned = get(dir, 'state/actions.json'); assert(planned.some((a) => a.act === 'create'));
  record('N06_cached_analysis_bypasses_changed_liquidity_gate', { configuredMinQuoteVolume: 5000000, cachedQuoteVolume: 1000000, latestQuoteVolume: 1000000, actions: planned });
  // Public mark prices are display data here, but their failure aborts account risk observation.
  dir = fixture(); const previousObservation = { at: new Date().toISOString(), gridRows: [], positions: [], margin: { totalEquity: '1000', availableEquity: '500', openPnl: '0' } };
  put(dir, 'state/observed.json', previousObservation);
  put(dir, 'state/risk.json', { peakEquity: 1000, paused: null });
  let marksHealthy = false;
  const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async (url) => {
    const u = new URL(url); let data;
    if (u.pathname.endsWith('/automation')) data = { params: { symbols: [{ symbol: 'OLD_USDC_PERP', allocationUsd: '1000', priceLow: '90', priceHigh: '110', levels: 20, enabled: true, direction: 'Neutral', takeProfitPercentage: 10, stopLossPercentage: 6, closePositionsOnStop: true }] }, snapshot: { symbols: [{ symbol: 'OLD_USDC_PERP', pnl: { soldValue: '0', boughtValue: '0', netPosition: '0', quoteAssetFees: '0' } }] } };
    else if (u.pathname.endsWith('/position')) data = [];
    else if (u.pathname.endsWith('/account')) data = { limitOrders: 0, liquidating: false };
    else if (u.pathname.endsWith('/collateral')) data = { 'fixture-3': { netEquity: '100', netEquityAvailable: '50' } };
    else if (u.pathname.endsWith('/markPrices')) { if (!marksHealthy) return { status: 503, body: 'market data unavailable' }; data = []; }
    else throw new Error('unexpected mock endpoint ' + u.pathname);
    return { status: 200, body: JSON.stringify(data) };
  } };
  const observeSource = fs.readFileSync(path.join(ROOT, 'scripts/observe.mjs'), 'utf8').replace('const ROOT = "/Users/nick/CascadeProjects/backpack_grid";', 'const ROOT = ' + JSON.stringify(dir) + ';');
  let observedError;
  try { await new AsyncFunction('taskSpace', 'console', 'process', observeSource)(async () => ({ page: () => page }), { log() {} }, { exit: (c) => { throw Error('mock exit ' + c); } }); }
  catch (e) { observedError = e.message; }
  assert.match(observedError, /markPrices.*503/); assert.deepEqual(get(dir, 'state/observed.json'), previousObservation);
  record('N07_public_mark_price_outage_aborts_account_risk_snapshot', { error: observedError, newestFetchedEquity: 100, previousObservedEquity: 1000, previouslyKnownPeak: 1000, drawdownPct: 90, budgetPct: cfg.riskBudgetPct, snapshotUnchanged: true, effect: 'run_round exits OBSERVE_FAILED before decide can latch/dispatch the account breaker' });
  marksHealthy = true;
  await new AsyncFunction('taskSpace', 'console', 'process', observeSource)(async () => ({ page: () => page }), { log() {} }, { exit: (c) => { throw Error('mock exit ' + c); } });
  const healthyDecision = spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...process.env, BG_ROOT: dir, BG_OFFLINE: '1' }, encoding: 'utf8' });
  assert.equal(healthyDecision.status, 0); assert(get(dir, 'state/risk.json').paused); assert(get(dir, 'state/actions.json').some((a) => a.act === 'stop' && a.market === 'OLD-PERP'));
  rows.at(-1).healthyContrast = { pausedPersisted: true, stopDispatched: true, onlyPublicMarksResponseChanged: true };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ baseline: '56d0cde', codeHashes: Object.fromEntries(['act.mjs', 'observe.mjs', 'run_events.cjs', 'history_core.cjs', 'import_ledger.cjs', 'decide.cjs', 'accounting.cjs'].map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'scripts', f))).digest('hex')])), rows, boundary: 'Production code executed with simulated session I/O and temporary BG_ROOT files. No real account writes, no trading, no service restart, no deployment.' }, null, 2));
}
main().finally(() => fs.rmSync(parent, { recursive: true, force: true })).catch((e) => { console.error(e); process.exitCode = 1; });
