'use strict';
// Target-behavior regressions for all eight audited findings, executing production entries.
// Every external I/O is mocked; all state lives in disposable temporary directories.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json')));
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-reaudit-'));
const rows = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(parent, 'fixture-')); fs.mkdirSync(path.join(dir, 'state')); put(dir, 'config.json', cfg); put(dir,'state/account_identity.json',{userId:'fixture',subaccountId:3,accountKey:'fixture-3'}); fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true }); return dir; };
const put = (dir, file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
const get = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const record = (id, details) => { rows.push({id,passed:true,...details}); console.log('PASS',id); };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function actualAct(mode) {
  const dir = fixture(), at = new Date().toISOString();
  const localCfg = mode === 'identity-mismatch' ? { ...cfg, userId: 'expected-owner' } : cfg;
  put(dir, 'config.json', localCfg);
  const identity={userId:mode==='identity-mismatch'?'expected-owner':'fixture',subaccountId:3,accountKey:mode==='identity-mismatch'?'expected-owner-3':'fixture-3'};
  put(dir,'state/account_identity.json',identity);
  const runId='safety-'+mode,planId='plan-'+mode;put(dir,'state/run_context.json',{runId,identity,startedAt:at,ownerPid:process.pid,ownerStart:require('../scripts/execution_lease.cjs').ownerStart(process.pid)});fs.writeFileSync(path.join(dir,'state/last_round_status'),'running');
  const actions = mode==='identity-stop'?[{act:'stop',market:'ETH-PERP',reason:'SL'}]:mode==='identity-protect'?[{act:'protect',market:'ETH-PERP',tp:10,sl:6,closeOnStop:true}]:[{ act: 'create', market: 'ETH-PERP', lower: 90, upper: 110, count: 20, value: 500 }];
  if(mode==='final-liquidating')actions.push({act:'create',market:'BTC-PERP',lower:90,upper:110,count:20,value:500});
  const hash = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  put(dir, 'state/actions.json', actions);
  put(dir, 'state/actions_meta.json', { at, runId,planId,identity, configHash: hash(localCfg), actionsHash: hash(actions), subaccountId: cfg.subaccountId || 3, riskWriteOk: true });
  put(dir, 'state/risk.json', { peakEquity: 1000, paused: null });
  put(dir, 'state/pending_stops.json', {});
  if(mode.startsWith('pending-'))put(dir,'state/pending_stops.json',{'OLD-PERP':{reason:'old intent',at,...(mode==='pending-foreign'?{accountKey:'other-3'}:{})}});
  if(mode==='manual-global')put(dir,'state/manual_pauses.json',{'*':{accountKey:identity.accountKey,intent:'hold',at}});
  let autos = mode.startsWith('live-') ? [{ symbol: 'OLD_USDC_PERP', allocationUsd: '1000', priceLow: '90', priceHigh: '110', levels: 20, enabled: true, direction: 'Neutral', stopLossPercentage: 6, takeProfitPercentage: 10, closePositionsOnStop: true }] : [];
  let writes = 0;
  const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async (url, options = {}) => {
    const u = new URL(url), method = options.method || 'GET';
    if (method === 'POST') {if(mode==='config-after-validate')put(dir,'config.json',{...localCfg,minScore:localCfg.minScore+1});return { status: 200, body: '{}' };}
    if (method === 'PATCH') {
      writes++;
      const e = JSON.parse(options.body).params.symbols[0];
      autos = autos.filter((g) => g.symbol !== e.symbol);
      if (e.operation !== 'Delete') autos.push({ ...e,
        ...(mode === 'stored-allocation' ? { allocationUsd: '100000' } : {}),
        ...(mode === 'stored-upper' ? { priceHigh: '150' } : {}) });
      if(mode==='stored-direction'&&e.operation!=='Delete')autos.at(-1).direction='Long';
      if(mode==='stored-disabled'&&e.operation!=='Delete')autos.at(-1).enabled=false;
      if(mode==='kick-drift'&&writes===3)autos.at(-1).allocationUsd='100000';
      return { status: 200, body: '{}' };
    }
    let data;
    if (u.pathname.endsWith('/automation')) data = { params: { symbols: autos } };
    else if (u.pathname.endsWith('/position')) data = mode==='final-orphan'&&writes===1?[{symbol:'ORPHAN_USDC_PERP',netQuantity:'1',markPrice:'100',estLiquidationPrice:'0'}]:mode.startsWith('live-') && autos.some(g=>g.symbol==='OLD_USDC_PERP'&&g.enabled) ? [{ symbol: 'OLD_USDC_PERP', netQuantity: mode === 'live-unknown' ? null : '1', markPrice: '100', estLiquidationPrice: mode==='live-liq-unknown'?null:'99' }] : [];
    else if (u.pathname.endsWith('/collateral')) data = { [mode.startsWith('identity-') ? 'different-owner-3' : 'fixture-3']: { netEquity:'1000',netEquityAvailable:'500' } };
    else if (u.pathname.endsWith('/markPrices')) data = [{ symbol: 'ETH_USDC_PERP', markPrice: '100' }];
    else if(u.pathname.endsWith('/account')) data={leverageLimit:'10',liquidating:mode==='account-unknown'?null:mode==='final-liquidating'&&writes===1?true:false};
    else if(u.pathname.endsWith('/markets')) data=['ETH','BTC'].map(m=>({symbol:m+'_USDC_PERP',imfFunction:{type:'sqrt',base:'.02',factor:'.00001'}}));
    else if (u.pathname.endsWith('/orders')) {data = mode==='kick-drift'&&writes<3?[]:Array.from({ length: 20 }, () => ({ symbol: 'ETH_USDC_PERP' }));if(mode==='final-drift')autos.find(g=>g.symbol==='ETH_USDC_PERP').allocationUsd='100000';}
    else throw new Error('unexpected mock endpoint ' + u.pathname);
    return { status: 200, body: JSON.stringify(data) };
  } };
  const source = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8').replace('const ROOT = "/Users/nick/CascadeProjects/backpack_grid";', 'const ROOT = ' + JSON.stringify(dir) + ';');
  let exit = 0;let clock=Date.now();class Clock extends Date{static now(){return clock+=1000;}}
  try { await new AsyncFunction('taskSpace', 'console', 'process', 'Date', source)(async () => ({ page: () => page }), { log() {} }, { exit: (code) => { throw Object.assign(new Error('mock exit'), { exit: code }); } },Clock); }
  catch (e) { if (e.exit === undefined) {if(mode!=='config-after-validate')throw e;assert.match(e.message,/CONFIG_CHANGED/);exit=2;}else exit = e.exit; }
  const result = get(dir, 'state/act_results.json');
  if(mode==='final-liquidating')assert(result.results.some(r=>r.market==='BTC-PERP'&&r.skipped));
  if(mode==='healthy') {assert.equal(exit,0);assert(result.results.some(r=>r.act==='create'&&r.done));} else {assert.notEqual(exit,0);assert(!result.results.some(r=>r.act==='create'&&r.done));}
  const applied = autos.find((g) => g.symbol === 'ETH_USDC_PERP');
  return { exit, writes, result: result.results, applied, pendingCleared: Object.keys(get(dir,'state/pending_stops.json')).length===0 };
}
async function main() {
  let r=await actualAct('healthy');record('healthy_create_positive_control',r);
  r=await actualAct('stored-allocation');assert(!r.applied);record('N01a_applied_allocation_drift_is_cleaned_up',r);
  r=await actualAct('stored-upper');assert(!r.applied);record('N01b_applied_upper_drift_is_cleaned_up',r);
  for(const mode of ['stored-direction','stored-disabled','final-drift','kick-drift','final-orphan','final-liquidating']){r=await actualAct(mode);assert(!r.applied);record('N01_full_and_final_config_'+mode,r);}
  r=await actualAct('live-danger');assert.equal(r.writes>0,true);assert(!r.applied);record('N02a_fresh_liquidation_danger_exits_before_create',r);
  r=await actualAct('live-unknown');assert.equal(r.writes,0);record('N02b_unknown_quantity_blocks_all_new_writes',r);
  r=await actualAct('live-liq-unknown');assert.equal(r.writes,0);record('N02c_unknown_liquidation_price_blocks_create',r);
  r=await actualAct('identity-mismatch');assert.equal(r.writes,0);record('N08_foreign_identity_blocks_all_mutations',r);
  for(const mode of ['identity-stop','identity-protect','pending-unbound','pending-foreign','manual-global','config-after-validate','account-unknown']){r=await actualAct(mode);assert.equal(r.writes,0);record('actor_veto_'+mode,r);}
  // run_events copies a previous result file into a newly started run without binding.
  let dir = fixture(); const oldAt = '2026-10-01T00:00:00Z';
  put(dir, 'state/act_results.json', { at: oldAt, results: [{ act: 'stop', market: 'OLD-PERP', done: true }] });
  const pin=get(dir,'state/account_identity.json');
  for (const args of [['start'], ['actions', 'phase1'], ['end', 'act_failed']]) {
    if(args[0]==='actions'){const ctx=get(dir,'state/run_context.json');put(dir,'state/actions_meta.json',{runId:ctx.runId,planId:'new',identity:pin});put(dir,'state/act_results.json',{at:oldAt,runId:'old',planId:'old',identity:pin,results:[{act:'stop',market:'OLD-PERP',done:true}]});}
    const p = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_events.cjs'), ...args], { env: { ...process.env, BG_ROOT: dir }, encoding: 'utf8' }); assert.equal(p.status, 0);
  }
  const events = fs.readFileSync(path.join(dir, 'state/run_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const actionEvent=events.find(e=>e.type==='actions');assert.deepEqual(actionEvent.results,[]);assert.equal(actionEvent.resultStatus,'unconfirmed');assert.equal(events.at(-1).status,'act_failed');
  record('N03_old_results_rejected_by_run_binding', { oldResultAt: oldAt, events });
  const { collectHistory, summarizeHistory, START } = require(path.join(ROOT, 'scripts/history_core.cjs'));
  const fill = (id, timestamp, fee) => ({ id, timestamp, price: '100', quantity: '1', fee: String(fee), feeSymbol: 'USDC', isMaker: true });
  const until = START + 10000;
  let h = await collectHistory({ symbols: {} }, ['X'], until, async () => [fill('one', START + 1, .1), fill('one', START + 1, .2)]);
  assert.equal(h.incomplete,true);assert.equal(Object.keys(h.symbols.X.fills).length,0);assert.match(h.symbols.X.error,/conflicting/);
  record('N04a_conflicting_batch_ids_rejected', { feeUsd: summarizeHistory(h).symbols.X.feeUsd, retainedFills: Object.keys(h.symbols.X.fills).length, cursor: h.symbols.X.lastTo, incomplete: h.incomplete });
  await assert.rejects(()=>collectHistory({symbols:{X:{from:START,lastTo:until+86400000,fills:{}}}},['X'],until,async()=>[]),/invalid history cursor/);
  record('N04b_future_cursor_is_rejected',{});
  h = await collectHistory({ symbols: {} }, ['X'], until, async () => []);
  const late = fill('late', START + 9000, .1); let queryFrom;
  h = await collectHistory(h, ['X'], until + 10000, async (s, lo, hi) => { queryFrom = lo; return late.timestamp >= lo && late.timestamp <= hi ? [late] : []; });
  assert.equal(Object.keys(h.symbols.X.fills).length, 1);
  record('N04c_late_fills_captured_by_overlap', { queryFrom, lateTimestamp: late.timestamp, fees: summarizeHistory(h).symbols.X.feeUsd, incomplete: h.incomplete, boundary: 'mocked delayed history indexing; not evidence it happened live' });
  // Incremental importer re-tags foreign-account records as the current account.
  dir = fixture(); const cov = { cashflow: { from: '2026-09-30T00:00:00Z', through: '2026-10-03T00:00:00Z', source: 'fixture-reconciled' } };
  put(dir, 'state/attribution_ledger.json', { subaccountId: 2, events: [{ id: 'foreign-deposit', type: 'cashflow', amountUsd: 100, at: '2026-10-01T00:00:00Z', source: 'account-2-export' }], coverage: cov });
  put(dir, 'input.json', { accountKey:'fixture-3',subaccountId: cfg.subaccountId || 3, events: [], coverage: cov });
  const p = spawnSync(process.execPath, [path.join(ROOT, 'scripts/import_ledger.cjs'), path.join(dir, 'input.json')], { env: { ...process.env, BG_ROOT: dir }, encoding: 'utf8' });
  assert.notEqual(p.status,0);const imported=get(dir,'state/attribution_ledger.json');assert.equal(imported.subaccountId,2);
  record('N05_foreign_old_ledger_is_not_retagged',{imported});
  // A changed liquidity threshold is ignored while an old analysis is still fresh.
  dir = fixture(); const changedCfg = { ...cfg, minQvol24h: 5000000 }; put(dir, 'config.json', changedCfg);
  const fresh = new Date().toISOString();
  put(dir, 'state/observed.json', { identity:get(dir,'state/account_identity.json'),at: fresh, gridRows: [], positions: [], ledger: [], margin: { totalEquity: '1000', availableEquity: '500', openPnl: '0' } });
  put(dir, 'state/risk.json', { peakEquity: 1000, paused: null }); put(dir, 'state/pending_stops.json', {});
  put(dir, 'state/analysis.json', { schemaVersion:2,accountKey:'fixture-3',configHash:require('../scripts/contracts.cjs').analysisConfigHash(changedCfg),generatedAt: fresh, top: [{ symbol: 'ETH_USDC_PERP', score: 10, chop: 10, range24: 5, qvol24: 1000000, fundingRate: 0, grid: { lower: 90, upper: 110, count: 20 } }], directional: [] });
  put(dir, 'state/tickers.json', [{ symbol: 'ETH_USDC_PERP', lastPrice: '100', quoteVolume: '1000000' }]);
  const decision = spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...process.env, BG_ROOT: dir, BG_OFFLINE: '0', BG_TICKERS_FILE: path.join(dir, 'state/tickers.json') }, encoding: 'utf8', timeout: 15000 });
  assert.equal(decision.status, 0); const planned = get(dir, 'state/actions.json'); assert(!planned.some((a)=>a.act==='create'));
  record('N06_updated_liquidity_threshold_enforced', { configuredMinQuoteVolume: 5000000, cachedQuoteVolume: 1000000, latestQuoteVolume: 1000000, actions: planned });
  // Public mark prices are display data here, but their failure aborts account risk observation.
  dir = fixture(); const previousObservation = { identity:get(dir,'state/account_identity.json'),at: new Date().toISOString(), gridRows: [], positions: [], margin: { totalEquity: '1000', availableEquity: '500', openPnl: '0' } };
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
  await new AsyncFunction('taskSpace','console','process',observeSource)(async()=>({page:()=>page}),{log(){}},{exit:c=>{throw Error('exit '+c)}});
  const degraded=get(dir,'state/observed.json');assert.equal(degraded.marketDataAvailable,false);assert.equal(degraded.margin.totalEquity,'$100.00');
  const d=spawnSync(process.execPath,[path.join(ROOT,'scripts/decide.cjs')],{env:{...process.env,BG_ROOT:dir,BG_OFFLINE:'1'},encoding:'utf8'});
  assert.equal(d.status,0);assert(get(dir,'state/risk.json').paused);assert(get(dir,'state/actions.json').some(a=>a.act==='stop'));
  record('N07_public_market_failure_preserves_breaker_and_exits',{paused:true,stop:true});
  marksHealthy = true;
  await new AsyncFunction('taskSpace', 'console', 'process', observeSource)(async () => ({ page: () => page }), { log() {} }, { exit: (c) => { throw Error('mock exit ' + c); } });
  const healthyDecision = spawnSync(process.execPath, [path.join(ROOT, 'scripts/decide.cjs')], { env: { ...process.env, BG_ROOT: dir, BG_OFFLINE: '1' }, encoding: 'utf8' });
  assert.equal(healthyDecision.status, 0); assert(get(dir, 'state/risk.json').paused); assert(get(dir, 'state/actions.json').some((a) => a.act === 'stop' && a.market === 'OLD-PERP'));
  rows.at(-1).healthyContrast = { pausedPersisted: true, stopDispatched: true, onlyPublicMarksResponseChanged: true };
  console.log(`${rows.length} new safety scenarios passed`);

}
main().finally(() => fs.rmSync(parent, { recursive: true, force: true })).catch((e) => { console.error(e); process.exitCode = 1; });
