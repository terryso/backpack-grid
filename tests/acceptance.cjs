'use strict';
// Production behavior tests. All exchange/browser/cloud I/O is mocked; no live grid actions.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'), PY = '/Users/nick/.browser-use-env/bin/python3';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-acceptance-'));
let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS', name); }
const json = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const put = (dir, f, data) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), JSON.stringify(data)); };
function fixture(eq = 1000, risk = { peakEquity: 1000, paused: null }, grids = []) {
  const dir = fs.mkdtempSync(path.join(tmp, 'fixture-')), at = new Date().toISOString();
  const files = { 'config.json': cfg, 'state/observed.json': { at, gridRows: grids, positions: [], ledger: [], margin: { totalEquity: String(eq), availableEquity: '500', openPnl: '0' } }, 'state/risk.json': risk, 'state/pending_stops.json': {}, 'state/tickers.json': [{ symbol: 'ETH_USDC_PERP', lastPrice: '100' }], 'state/analysis.json': { generatedAt: at, top: [{ symbol: 'ETH_USDC_PERP', score: 10, chop: 10, range24: 5, qvol24: 1e6, minQuantity: .1, grid: { lower: 90, upper: 110, count: 100 } }], directional: [] } };
  for (const [f, v] of Object.entries(files)) put(dir, f, v);
  const identity={userId:'fixture',subaccountId:cfg.subaccountId??3,accountKey:'fixture-'+(cfg.subaccountId??3)};
  put(dir,'state/account_identity.json',identity);
  const o=JSON.parse(fs.readFileSync(path.join(dir,'state/observed.json')));o.identity=identity;put(dir,'state/observed.json',o);
  const a=JSON.parse(fs.readFileSync(path.join(dir,'state/analysis.json')));Object.assign(a,{schemaVersion:2,accountKey:identity.accountKey,configHash:require('../scripts/contracts.cjs').analysisConfigHash(cfg)});put(dir,'state/analysis.json',a);
  const ts=JSON.parse(fs.readFileSync(path.join(dir,'state/tickers.json')));ts.forEach(t=>t.quoteVolume='100000000');put(dir,'state/tickers.json',ts);
  return dir;
}
const env = (d) => ({ ...process.env, BG_ROOT: d, BG_TICKERS_FILE: path.join(d, 'state/tickers.json'), BG_OFFLINE: '0' });
const decide = (d, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...env(d), ...extra }, encoding: 'utf8', timeout: 15000 });
const writer = (d, payload) => spawnSync(PY, [path.join(ROOT, 'scripts/risk_write.py'), JSON.stringify({accountKey:json(d,'state/account_identity.json').accountKey,...payload})], { env: env(d), encoding: 'utf8', timeout: 10000 });
const grid = { market: 'OLD-PERP', symbol: 'OLD_USDC_PERP', range: ['90', '110'], allocationRaw: 1000, pnlRaw: 0, pnlPct: 0, status: 'Triggered', nativeTP: 10, nativeSL: 6, nativeCloseOnStop: true };
const { riskStructOk, pendingStructOk, finiteNumber } = require('../scripts/state_schema.cjs');
const { collectHistory, summarizeHistory, fillTimestamp, START } = require('../scripts/history_core.cjs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function observedCase(mode) {
  const files = new Map();
  const pos = { symbol: 'OLD_USDC_PERP', netQuantity: '1', markPrice: '100', breakEvenPrice: '100', netExposureNotional: '100', imf: '.1', cumulativeFundingPayment: '0', estLiquidationPrice: '50' };
  const auto = { params: { symbols: mode === 'orphan' ? [] : [{ symbol: pos.symbol, enabled: true, allocationUsd: '500', priceLow: '90', priceHigh: '110', levels: 20, direction: 'Neutral', takeProfitPercentage: 10, stopLossPercentage: 6, closePositionsOnStop: true }] }, snapshot: { symbols: [{ symbol: pos.symbol, pnl: { soldValue: '0', boughtValue: '100', netPosition: '1', quoteAssetFees: '0' } }] } };
  if (mode === 'null-ledger') auto.snapshot.symbols[0].pnl.soldValue = null;
  if (mode === 'false-position') pos.netQuantity = false;
  if (mode === 'unknown-liquidation') pos.estLiquidationPrice = null;
  if (mode === 'zero-liquidation') pos.estLiquidationPrice = '0';
  if (mode === 'ledger-live-position-zero') {pos.netQuantity='0';pos.markPrice=null;}
  const inputs = { auto, positionsRaw: mode === 'missing-position' ? [] : [pos], account: { limitOrders: 0, liquidating: false }, collateralAll: { 'fixture-3': { netEquity: '500', netEquityAvailable: '300' } }, markAll: [], cfg, identity:{userId:'fixture',subaccountId:3,accountKey:'fixture-3'},marketDataAvailable:true,col:{netEquity:'500',netEquityAvailable:'300'}, SUB: 3, ROOT: '/fixture', API: 'mock', path, finiteNumber,
    positionListOk: require('../scripts/state_schema.cjs').positionListOk,
    fs: { writeFile: async (p, s) => files.set(p, s), rename: async (a, b) => files.set(b, files.get(a)) },
    console: { log: () => {} }, process: { exit: (n) => { throw new Error('exit:' + n); } } };
  let error = null;
  try { await new AsyncFunction(...Object.keys(inputs), fs.readFileSync(path.join(ROOT, 'scripts/observe.mjs'), 'utf8').split('// --- grids from automation snapshot ---')[1])(...Object.values(inputs)); } catch (e) { error = e.message; }
  return { error, obs: JSON.parse(files.get('/fixture/state/observed.json')) };
}
async function main() {
  for (const bad of [null, false, '', '  ', [], {}]) check('strict numeric rejects ' + JSON.stringify(bad), () => assert.equal(finiteNumber(bad), false));
  for (const pk of [null, false, '', [], -1]) {
    const r = { peakEquity: pk };
    const d = fixture(1000, r), before = fs.readFileSync(path.join(d, 'state/risk.json'), 'utf8');
    check('JS/Python risk validator rejects ' + JSON.stringify(pk), () => { assert.equal(riskStructOk(r), false); assert.equal(writer(d, { peakEquity: 1100 }).status, 2); assert.equal(fs.readFileSync(path.join(d, 'state/risk.json'), 'utf8'), before); });
  }
  check('paused arrays rejected and pending structures agree', () => { assert.equal(riskStructOk({ peakEquity: 1, paused: [] }), false); for (const p of [[], null, { X: false }]) assert.equal(pendingStructOk(p), false); });
  let d = fixture(); let result = decide(d);
  check('healthy production decide creates positive control', () => { assert.equal(result.status, 0); assert(json(d, 'state/actions.json').some((a) => a.act === 'create')); });
  d = fixture(); fs.mkdirSync(path.join(d, 'state/risk.lock')); result = decide(d);
  check('writer failure forbids new risk', () => { assert.equal(result.status, 0); assert(result.stdout.includes('RISK WRITE FAILED')); assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')); assert.equal(json(d, 'state/risk_write_status.json').ok, false); });
  d = fixture(100, { peakEquity: 1000 }, [grid]); result = decide(d);
  check('missing paused permits persistent new trip', () => { assert.equal(result.status, 0); assert(json(d, 'state/risk.json').paused); assert(json(d, 'state/actions.json').some((a) => a.act === 'stop')); });
  let obs = json(d, 'state/observed.json'); obs.margin.totalEquity = '1000'; obs.gridRows = []; put(d, 'state/observed.json', obs); decide(d);
  check('equity recovery never clears persisted latch', () => assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')));
  d = fixture(100, { peakEquity: 1000 }, [grid]); fs.mkdirSync(path.join(d, 'state/risk.lock')); decide(d);
  check('failed trip commit leaves durable write-ahead latch', () => assert(json(d, 'state/risk_write_pending.json').paused));
  fs.rmdirSync(path.join(d, 'state/risk.lock')); obs = json(d, 'state/observed.json'); obs.margin.totalEquity = '1000'; obs.gridRows = []; put(d, 'state/observed.json', obs); decide(d);
  check('retry after recovery commits earlier failed trip and blocks create', () => { assert(json(d, 'state/risk.json').paused); assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')); assert(!fs.existsSync(path.join(d, 'state/risk_write_pending.json'))); });
  for (const equity of [0, -10]) {
    d = fixture(equity, { peakEquity: 1000 }, [grid]); result = decide(d);
    check('zero/negative equity still dispatches risk exits: ' + equity, () => { assert.equal(result.status, 0); assert(json(d, 'state/risk.json').paused); assert(json(d, 'state/actions.json').some((a) => a.act === 'stop')); });
  }
  d = fixture(); put(d, 'state/risk_write_pending.json', []); const original = fs.readFileSync(path.join(d, 'state/risk.json'), 'utf8'); decide(d);
  check('corrupt risk write intent refuses mutation and create', () => { assert.equal(fs.readFileSync(path.join(d, 'state/risk.json'), 'utf8'), original); assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')); });
  for (const value of [null, false, 0, '']) {
    d = fixture(); put(d, 'state/risk_write_pending.json', value); decide(d);
    check('invalid persisted risk intent blocks create: ' + JSON.stringify(value), () => assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')));
  }
  d = fixture(1000, { peakEquity: 1000 }, [grid]); put(d, 'state/tickers.json', [{ symbol: 'OLD_USDC_PERP', lastPrice: false }, { symbol: 'ETH_USDC_PERP', lastPrice: '100' }]); decide(d);
  check('false ticker cannot trigger false out-of-range stop', () => assert(!json(d, 'state/actions.json').some((a) => a.act === 'stop')));
  d = fixture(); put(d, 'state/tickers.json', []); decide(d);
  check('empty ticker response blocks new risk', () => assert(!json(d, 'state/actions.json').some((a) => a.act === 'create')));
  d = fixture(); const latch = { at: 'original', reason: 'trip' }; writer(d, { peakEquity: 1000, paused: latch });
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(PY, [path.join(ROOT, 'scripts/risk_write.py'), JSON.stringify({accountKey:json(d,'state/account_identity.json').accountKey, peakEquity: 1000 + i * 10 })], { env: env(d), stdio: 'ignore' }); p.on('error', reject); p.on('close', (c) => c === 0 ? resolve() : reject(new Error('writer exit ' + c)));
  })));
  check('12 genuinely concurrent writers keep highest peak and original latch', () => { assert.equal(json(d, 'state/risk.json').peakEquity, 1110); assert.deepEqual(json(d, 'state/risk.json').paused, latch); });
  for (const phase of ['', 'creates']) {
    d = fixture(1000, { peakEquity: 1000 }, [grid]); obs = json(d, 'state/observed.json'); obs.positions = [{ market: 'OLD-PERP', size: '1', mark: '100', liq: '99', fundingRaw: 0 }]; put(d, 'state/observed.json', obs); decide(d, { BG_PHASE: phase });
    check('new danger blocks create in phase ' + (phase || 'risk'), () => { const a = json(d, 'state/actions.json'); assert(a.some((r) => r.act === 'stop')); assert(!a.some((r) => r.act === 'create')); });
  }
  for (const mode of ['null-ledger', 'false-position', 'missing-position', 'orphan','unknown-liquidation','zero-liquidation','ledger-live-position-zero']) {
    const r = await observedCase(mode);
    check('production observe data contract: ' + mode, () => ['orphan','zero-liquidation'].includes(mode) ? assert.equal(r.error, null) : assert(r.obs.error));
  }
  const fill = (id, timestamp, feeSymbol = 'USDC') => ({ id, timestamp, price: '100', quantity: '1', fee: '.1', feeSymbol, isMaker: true });
  check('WAPI ISO timestamp without timezone parses as UTC', () => assert.equal(fillTimestamp('2026-09-30T04:56:59.848'), Date.parse('2026-09-30T04:56:59.848Z')));
  const end = START + 12 * 3600e3;
  let history = await collectHistory({ symbols: {} }, ['X'], end, async (symbol, lo, hi) => [fill('boundary', START + 6 * 3600e3)].filter((f) => f.timestamp >= lo && f.timestamp <= hi));
  check('inclusive boundary deduplicates raw fill and fee', () => { assert.equal(Object.keys(history.symbols.X.fills).length, 1); assert.equal(summarizeHistory(history).symbols.X.feeUsd, .1); assert.equal(history.incomplete, false); });
  history = await collectHistory(history, ['X'], end, async () => { throw new Error('should not refetch completed range'); });
  check('completed history restart preserves fees', () => assert.equal(summarizeHistory(history).symbols.X.feeUsd, .1));
  history = await collectHistory({ symbols: {} }, ['X'], end, async () => Array.from({ length: 1000 }, (_, i) => fill(String(i), START)), 5);
  check('full pages and exhausted budget keep cursor and mark incomplete', () => { assert.equal(history.symbols.X.lastTo, START); assert.equal(Object.keys(history.symbols.X.fills).length, 0); assert.equal(history.incomplete, true); });
  history = await collectHistory({ symbols: {} }, ['X'], end, async (s, lo, hi) => hi - lo > 3 * 3600e3 ? Array(1000).fill(fill('capped', lo)) : [fill(String(lo), lo)]);
  check('adaptive shrink progresses through dense complete intervals', () => { assert.equal(history.incomplete, false); assert(history.symbols.X.lastTo === end); });
  history = await collectHistory({ symbols: {} }, ['X'], START + 1, async () => Array(1000).fill(fill('a', START)));
  check('saturated millisecond is explicit pagination error', () => assert.match(history.symbols.X.error, /pagination/));
  history = await collectHistory({ symbols: {} }, ['X'], end, async () => { throw new Error('HTTP 500'); });
  check('history HTTP error preserves cursor and incomplete status', () => { assert.equal(history.symbols.X.lastTo, START); assert.match(history.symbols.X.error, /500/); });
  history = await collectHistory({ symbols: {} }, ['X'], end, async (s, lo) => [fill('non-usdc', lo, 'SOL')]);
  check('non-USDC fees retained without false USD conversion', () => { const s = summarizeHistory(history).symbols.X; assert.equal(s.feeUsd, 0); assert.equal(s.otherFees.SOL, .1); });
  const { sizeGrid, tickDecimals } = require('../scripts/grid_sizing.cjs');
  check('final reduced allocation resizes count at conservative upper price', () => { const g = sizeGrid({ minQuantity: 1, grid: { lower: 90, upper: 110, count: 100 } }, 500); assert.equal(g.count, 4); assert(g.perOrderUsd >= 121); assert.equal(tickDecimals(.25), 2); assert.equal(tickDecimals(1e-8), 8); });
  const { attribution } = require('../scripts/accounting.cjs');
  const start = '2026-09-30T00:00:00Z', now = '2026-10-03T00:00:00Z';
  const ledger = { events: [{ id: 'deposit', type: 'cashflow', amountUsd: 100, at: '2026-10-01T00:00:00Z', source: 'fixture-export' }], coverage: { cashflow: { from: start, through: now, source: 'fixture-reconciled' } } };
  check('deposit-adjusted PnL and missing funding stay distinct', () => { const a = attribution(ledger, start, now, 110); assert.equal(a.strategyPnl, 10); assert.equal(a.funding, null); assert.equal(a.complete, false); assert.equal(attribution(null, start, now, 110).strategyPnl, null); });
  check('date-only baseline cannot fabricate cashflow-adjusted return', () => assert.equal(attribution(ledger, '2026-09-30', now, 110).strategyPnl, null));
  d = fixture(); put(d, 'state/risk.json', { peakEquity: null }); put(d, 'state/pending_stops.json', []); put(d, 'state/act_results.json', { at: new Date().toISOString(), results: [{ act: 'protect', market: 'X', done: false, error: 'bad' }, { act: 'stop', market: 'Y', done: true }] });
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/dashboard_data.cjs')], { env: env(d), encoding: 'utf8' }); let snap = json(d, 'state/dashboard.json');
  check('dashboard refuses malformed state and aggregates prior failure', () => { assert.equal(snap.riskStateValid, false); assert.equal(snap.pendingCorrupt, true); assert.equal(snap.drawdownPct, null); assert.match(snap.lastAction, /失败/); assert.equal(snap.strategyTotalPnl, null); });
  fs.unlinkSync(path.join(d, 'state/observed.json')); spawnSync(process.execPath, [path.join(ROOT, 'scripts/dashboard_data.cjs')], { env: env(d) }); snap = json(d, 'state/dashboard.json');
  check('missing observation remains unknown, not fresh zero equity', () => { assert.equal(snap.updatedAt, null); assert.equal(snap.equity, null); assert.equal(snap.dataValid, false); });
  // Run the actual shell orchestrator with mock ego and upload commands in a disposable checkout.
  for (const failCall of [2, 3, 0]) {
    d = fixture(1000, { peakEquity: 1000 }, [grid]); fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
    obs = json(d, 'state/observed.json'); obs.gridRows[0].pnlRaw = -100; put(d, 'state/observed.json', obs);
    fs.mkdirSync(path.join(d, '.local/bin'), { recursive: true }); fs.symlinkSync(process.execPath, path.join(d, '.local/bin/node'));
    fs.writeFileSync(path.join(d, '.local/bin/ego-browser'), `#!${process.execPath}\nconst fs=require('fs');const text=fs.readFileSync(0,'utf8');if(text.includes('// observe.mjs')){let n=Number(fs.existsSync('state/observe_calls')?fs.readFileSync('state/observe_calls','utf8'):0)+1;fs.writeFileSync('state/observe_calls',String(n));if(n===${failCall})process.exit(1);if(n>1){let o=JSON.parse(fs.readFileSync('state/observed.json'));o.gridRows=[];o.at=new Date().toISOString();fs.writeFileSync('state/observed.json',JSON.stringify(o));}}else{fs.appendFileSync('state/act_calls','act\\n');fs.writeFileSync('state/act_results.json',JSON.stringify({at:new Date().toISOString(),...JSON.parse(fs.readFileSync('state/actions_meta.json')),status:'complete',results:[{act:'stop',market:'OLD-PERP',done:true}]}));}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(d, 'scripts/upload_dashboard.sh'), '#!/bin/bash\necho upload >> state/upload_calls\n');
    const run = spawnSync('/bin/bash', [path.join(d, 'scripts/run_round.sh')], { env: { ...env(d), HOME: d, DRYRUN: '0', BG_LOCKED: '0' }, encoding: 'utf8', timeout: 15000 });
    check('runner refresh failure/status and upload: ' + failCall, () => { assert.equal(run.status, failCall ? 1 : 0, run.stderr); assert.equal(fs.readFileSync(path.join(d, 'state/last_round_status'), 'utf8').trim(), failCall === 2 ? 'observe_failed_post_exit' : failCall === 3 ? 'observe_failed_confirm' : 'ok'); assert(fs.existsSync(path.join(d, 'state/upload_calls'))); if (failCall === 2) assert.equal(fs.readFileSync(path.join(d, 'state/act_calls'), 'utf8').trim().split('\n').length, 1); });
  }
  // Dashboard lifetime metrics are independent of the 400-point display window.
  const { historyMetrics, confirmedRuns } = require('../scripts/dashboard_metrics.cjs');
  const historyRows = Array.from({ length: 502 }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 30) + i * 900000).toISOString(), equity: i === 0 ? 200 : 100 }));
  const hm = historyMetrics(historyRows, null);
  check('all historical drawdown survives the chart display limit', () => { assert.equal(hm.maxDrawdown, 50); assert.equal(hm.count, 502); assert.equal(hm.curve.length, 400); });
  check('sample counts deduplicate timestamps and exclude identified dryrun', () => assert.equal(historyMetrics([...historyRows, historyRows[0], { at: '2026-11-01T00:00:00Z', equity: 1, dryrun: true }]).count, 502));
  check('failed and dryrun events never inflate successful confirmations', () => { const r = confirmedRuns([{ type: 'end', dryrun: false, runId: 'ok', status: 'ok', startedAt: '2026-10-03T00:00:00Z' }, { type: 'end', dryrun: false, runId: 'bad', status: 'observe_failed', startedAt: '2026-10-03T00:00:01Z' }, { type: 'end', dryrun: true, runId: 'dry', status: 'dryrun' }]); assert.equal(r.successful, 1); assert.equal(r.failed, 1); });
  d = fixture(); const historyText = historyRows.map(JSON.stringify).join('\n') + '\n{partial\n';
  fs.writeFileSync(path.join(d, 'state/equity_curve.jsonl'), historyText);
  put(d, 'state/run_events.jsonl', null); // overwritten with actual JSONL below
  const eventText = JSON.stringify({ type: 'end', dryrun: false, runId: 'one', status: 'ok', startedAt: new Date().toISOString() }) + '\n';
  fs.writeFileSync(path.join(d, 'state/run_events.jsonl'), eventText);
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/dashboard_data.cjs')], { env: env(d), encoding: 'utf8' });
  const metricsSnapshot = json(d, 'state/dashboard.json');
  check('dashboard preserves original histories and tolerates a partial line', () => { assert.equal(metricsSnapshot.runStats.records, 502); assert.equal(metricsSnapshot.runStats.rounds, 1); assert.equal(metricsSnapshot.maxDrawdown, 50); assert.equal(fs.readFileSync(path.join(d, 'state/equity_curve.jsonl'), 'utf8'), historyText); assert.equal(fs.readFileSync(path.join(d, 'state/run_events.jsonl'), 'utf8'), eventText); });
  check('run days are rounded at the data boundary', () => assert.equal(Number.isInteger(metricsSnapshot.runStats.days * 10), true));
  // Execute the ENTIRE production act entry with mocked session I/O, real filesystem,
  // and real anchored core imports. Includes intent/gate/cleanup interactions.
  for (const mode of ['success', 'upsert-lost', 'protect-read-fails', 'cleanup-incomplete', 'budget-changed', 'stale-plan']) {
    d = fixture(); fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
    const actions = ['ETH', 'BTC'].map((m) => ({ act: 'create', market: m + '-PERP', lower: 90, upper: 110, count: 20, value: 500 }));
    const { createHash } = require('node:crypto'); const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const identity=json(d,'state/account_identity.json');const runId='accept-'+mode;put(d,'state/run_context.json',{runId,identity,startedAt:new Date().toISOString(),ownerPid:process.pid,ownerStart:require('../scripts/execution_lease.cjs').ownerStart(process.pid)});fs.writeFileSync(path.join(d,'state/last_round_status'),'running');
    put(d, 'state/actions.json', actions); put(d, 'state/actions_meta.json', { planId:'plan-'+mode,runId,identity, at: mode === 'stale-plan' ? '2020-01-01' : new Date().toISOString(), configHash: h(cfg), actionsHash: h(actions), riskWriteOk: true, subaccountId: cfg.subaccountId || 3 });
    let autos = [], writes = 0, clock = Date.now(), firstProtectionRead = false;
    class Clock extends Date { static now() { return clock += 1000; } }
    const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async (url, options = {}) => {
      const u = new URL(url), method = options.method || 'GET';
      if (method === 'POST') return { status: 200, body: '{}' }; // validate
      if (method === 'PATCH') {
        writes++;
        const e = JSON.parse(options.body).params.symbols[0];
        if (e.operation === 'Delete') autos = autos.filter((g) => g.symbol !== e.symbol);
        else { autos = autos.filter((g) => g.symbol !== e.symbol); autos.push({ ...e, ...(mode === 'cleanup-incomplete' ? { stopLossPercentage: null } : {}) }); }
        if (mode === 'upsert-lost' && writes === 1) throw new Error('response lost');
        return { status: 200, body: '{}' };
      }
      let data;
      if (u.pathname.endsWith('/automation')) {
        if (mode === 'protect-read-fails' && autos.length && !firstProtectionRead && writes === 1) { firstProtectionRead = true; } // config confirmation succeeds once
        else if (mode === 'protect-read-fails' && autos.length && writes === 1 && firstProtectionRead) { writes++; throw new Error('protection read failure'); }
        data = { params: { symbols: structuredClone(autos) } };
      } else if (u.pathname.endsWith('/position')) data = mode === 'cleanup-incomplete' && autos.length ? [{ symbol: autos[0].symbol, netQuantity: null }] : [];
      else if (u.pathname.endsWith('/collateral')) data = { 'fixture-3': { netEquity: mode === 'budget-changed' ? '1' : '1000',netEquityAvailable:'500' } };
      else if (u.pathname.endsWith('/markPrices')) data = ['ETH', 'BTC'].map((m) => ({ symbol: m + '_USDC_PERP', markPrice: '100' }));
      else if(u.pathname.endsWith('/account')) data={leverageLimit:'10',liquidating:false};
      else if(u.pathname.endsWith('/markets')) data=['ETH','BTC'].map(m=>({symbol:m+'_USDC_PERP',imfFunction:{type:'sqrt',base:'.02',factor:'.00001'}}));
      else if (u.pathname.endsWith('/orders')) data = autos.flatMap((g) => Array.from({ length: 20 }, () => ({ symbol: g.symbol })));
      else throw new Error('unknown mock endpoint ' + u.pathname);
      return { status: 200, body: JSON.stringify(data) };
    } };
    let exit = 0;
    const source = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8').replace('const ROOT = "/Users/nick/CascadeProjects/backpack_grid";', 'const ROOT = ' + JSON.stringify(d) + ';');
    try { await new AsyncFunction('taskSpace', 'process', 'Date', 'console', source)(async () => ({ page: () => page }), { exit: (c) => { throw Object.assign(new Error('mock exit'), { exit: c }); } }, Clock, { log: () => {} }); }
    catch (e) { if (e.exit !== undefined) exit = e.exit; else if (mode !== 'stale-plan') throw e; else exit = 2; }
    check('production act lifecycle: ' + mode, () => {
      if (mode === 'success') { assert.equal(exit, 0); assert.equal(autos.length, 2); assert.deepEqual(json(d, 'state/pending_stops.json'), {}); }
      else if (mode === 'stale-plan' || mode === 'budget-changed') { assert.equal(writes, 0); assert.notEqual(exit, 0); }
      else if (mode === 'protect-read-fails') { assert.notEqual(exit, 0); assert(!autos.some((g) => g.symbol === 'ETH_USDC_PERP')); }
      else { assert.notEqual(exit, 0); assert(json(d, 'state/pending_stops.json')['ETH-PERP']); assert(json(d, 'state/act_results.json').results.some((r) => r.market === 'BTC-PERP' && r.skipped)); }
    });
  }
  // The actual production UI must visibly degrade when dynamic APIs fail.
  const html = fs.readFileSync(path.join(ROOT, 'cloudflare/dashboard.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('function markLiked()')[0];
  const elements = new Map();
  const document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { remove() {} } }); return elements.get(id); } };
  const degraded = { updatedAt: new Date().toISOString(), equity: 500, riskStateValid: true, riskWriteValid: true, dataValid: true, lastRoundStatus: 'ok', riskPaused: false, drawdownPct: 0, grids: [], positions: [], pending: [], curve: [] };
  const context = { document, window: { __SNAPSHOT_FALLBACK__: degraded }, fetch: async () => ({ ok: false, status: 429 }) };
  await vm.runInNewContext(script + '\nload();', context);
  check('production UI quota fallback is dated and never healthy', () => { const content = elements.get('content').innerHTML; assert.match(content, /部署时的历史快照/); assert(!content.includes('风控正常')); });
  const uiContext = { document, window: {} };
  vm.runInNewContext(script, uiContext);
  const display = { ...degraded, quotaExceeded: false, equityChange: 12.5, strategyBaselineAt: '2026-09-30', runStats: { days: 3.0336669444444446, records: 256, rounds: 17, since: '2026-10-03T00:00:00Z' }, maxDrawdown: 6 };
  uiContext.snapshot = display; vm.runInNewContext('render(snapshot)', uiContext);
  check('production UI rounds days and labels history in plain language', () => { assert.match(elements.get('runStats').textContent, /3\.0 天/); assert.match(elements.get('runStats').textContent, /256 条/); const output = elements.get('content').innerHTML; assert.match(output, /历史总盈亏/); assert.match(output, /出入金也会影响此值/); assert(!output.includes('最近 400 点')); assert.match(output, /从高点回落的最大幅度/); assert.match(output, /完成 17 轮/); });
  // Production Durable Object with a serializing mock storage gate.
  const src = fs.readFileSync(path.join(ROOT, 'cloudflare/likes.js'), 'utf8').replace('export class', 'class');
  const LikeCounter = new Function('Response', src + '\nreturn LikeCounter;')(Response);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  let tail = Promise.resolve();
  const sql = { exec(query, ...bindings) { const statement = db.prepare(query); const rows = /^SELECT/.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []); return { toArray: () => rows }; } };
  const ctx = { storage: { sql, get: async () => null, transactionSync(f) { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }, blockConcurrencyWhile: (f) => { const r = tail.then(f); tail = r.catch(() => {}); return r; } };
  const state = () => sql.exec('SELECT * FROM counter WHERE id=1').toArray()[0];
  const likes = new LikeCounter(ctx, { DASH: { get: async () => '7' } });
  const req = (visitor, day = '2026-10-03') => new Request('https://mock.invalid', { method: 'POST', body: JSON.stringify({ visitor: visitor.toString(16).padStart(64, '0'), day, increment: true }) });
  await Promise.all(Array.from({ length: 20 }, () => likes.fetch(req(1))));
  check('20 concurrent same-visitor likes count once with legacy seed', () => assert.equal(state().likes, 8));
  await Promise.all(Array.from({ length: 20 }, (_, i) => likes.fetch(req(i + 2))));
  check('20 different concurrent visitors lose no increments', () => assert.equal(state().likes, 28));
  await likes.fetch(req(1, '2026-10-04')); await likes.fetch(req(1, '2026-10-03'));
  check('day rollover expires markers; delayed old day cannot reset state', () => { assert.equal(state().likes, 29); assert.equal(state().day, '2026-10-04'); assert.equal(sql.exec('SELECT hash FROM visitors').toArray().length, 1); });
  db.close();
  console.log(`${count} production acceptance cases passed`);
}
main().then(() => fs.rmSync(tmp, { recursive: true, force: true })).catch((e) => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1; });
