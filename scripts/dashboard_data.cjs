#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { money: num, riskStructOk, pendingStructOk } = require('./state_schema.cjs');
const { attribution } = require('./accounting.cjs');
const { historyMetrics, confirmedRuns, stopBudgetUsage } = require('./dashboard_metrics.cjs');
const { trailStatus } = require('./trail_status.cjs');
const {identityOk,manualPausesFor,validateConfig,expectedIdentity}=require('./contracts.cjs');
const {validateWindow,reconcile}=require('./verified_window.cjs');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
const file = (p) => path.join(ROOT, p);
const read = (p) => { try { return JSON.parse(fs.readFileSync(file(p), 'utf8')); } catch { return null; } };
const jsonl = (p) => { try { return fs.readFileSync(file(p), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const cfg = read('config.json') || {};
const obs = read('state/observed.json');
const identity=read('state/account_identity.json');
const identityValid=identityOk(identity)&&identityOk(obs?.identity)&&obs.identity.accountKey===identity.accountKey;
// Use the same validated, account-bound threshold as the decision layer.
let warnDrawdownPct = null;
try { validateConfig(cfg); if (identityValid && expectedIdentity(ROOT, cfg).accountKey === identity.accountKey) warnDrawdownPct = cfg.warnDrawdownPct; } catch {}
const risk = read('state/risk.json');
const pending = read('state/pending_stops.json');
const campaign = read('state/campaign.json');
const {parseCampaignConfig,campaignView,unknownView}=require('./campaign_core.cjs');
let campaignPublic=unknownView(null);
try{campaignPublic=campaignView(campaign,parseCampaignConfig(read('cloudflare/assets/campaign-history.json')),identityValid?identity.accountKey:null);}catch{}
const activeResults=read('state/act_results.json');
const results=Array.isArray(activeResults?.results)&&activeResults.results.length?activeResults:read('state/last_action.json');
const writeState = read('state/risk_write_status.json');
const grids = Array.isArray(obs?.gridRows) ? obs.gridRows : [];
// 方向任务状态（本机 launchd direction_watch 每小时判定 + 5 连同向自动切换）：
// healthy=最近判定 ≤2h；failed=最近 24 行日志含失败标记
const advice = read('state/direction_advice.json');
let direction = null;
if (advice && Number.isFinite(Date.parse(advice.at))) {
  let failed = false;
  try {
    const tail = fs.readFileSync(file('state/direction_watch.log'), 'utf8').trim().split('\n').filter(Boolean).slice(-24);
    failed = tail.some((l) => /DATA_FAIL|SWITCH_SET_FAILED|ERROR/.test(l));
  } catch {}
  const ageMs = Date.now() - Date.parse(advice.at);
  direction = {
    directive: advice.directive || null, rec: advice.rec || null, streak: Number(advice.streak) || 0, threshold: 5,
    verdict: advice.verdict || null, judgedAt: advice.at, judgedAgeMin: Math.round(ageMs / 60000),
    healthy: ageMs <= 2 * 3600000, failed,
    note: advice.note || null,
    lastSwitch: Array.isArray(advice.switchLog) && advice.switchLog.length ? advice.switchLog[advice.switchLog.length - 1] : null,
  };
}
// The mailbox compares this exact revision with the file under the local lock.
// Invalid/foreign direction state must never be advertised as a valid version.
try {
  if (identityValid) {
    const current = require('./grid_direction.cjs').directionSnapshot(ROOT, identity.accountKey);
    direction = { ...(direction || {}), ...current };
  }
} catch { direction = null; }
// ⚡ 显示守卫：lastSwitch 只在切换目标 === 当前指令时有效。stale KV 副本的旧切换
// 不能挂在已变化的指令上——11-27 指令已切 Neutral 而副本 switchLog 末条仍是
// to=Short，页面会显示"指令 Neutral · ⚡已自动切至 Short"自相矛盾。
if (direction && direction.lastSwitch && direction.lastSwitch.to !== direction.directive) direction.lastSwitch = null;
const positions = Array.isArray(obs?.positions) ? obs.positions : [];
// 网格时长（网格卡「网格时长」）：最近一次成功建格动作 = 当前网格的开始时刻
const { latestCreates, formatAgeMin } = require('./grid_age.cjs');
const gridNowMs = Date.now();
const gridCreatedAt = latestCreates(jsonl('state/run_events.jsonl'), identity?.accountKey);
const equity = num(obs?.margin?.totalEquity);
const age = obs?.at ? (Date.now() - Date.parse(obs.at)) / 1000 : null;
const dataValid = identityValid && !!obs && !obs.error && age !== null && Number.isFinite(age) && age >= -60 && age <= 20 * 60
  && equity !== null && Array.isArray(obs.gridRows) && Array.isArray(obs.positions);
const riskStateValid = riskStructOk(risk)&&(!risk.accountKey||risk.accountKey===identity?.accountKey);
const pendingValid = (pendingStructOk(pending)&&Object.values(pending).every(p=>p.accountKey===identity?.accountKey)) || (!fs.existsSync(file('state/pending_stops.json')));
const pendingCorrupt = !pendingValid || fs.existsSync(file('state/pending_corrupt.json'));
let manualPauses=[],manualPauseValid=true;
try{manualPauses=Object.keys(manualPausesFor(ROOT,identity));}catch{manualPauseValid=false;}
// A missing peak file is a fresh state; unreadable files and broken symlinks are
// unknown, not fresh. Never publish position references or saved peak values.
let trailStateExists = true;
try { fs.lstatSync(file('state/trail_peak.json')); } catch (e) { if (e.code === 'ENOENT') trailStateExists = false; }
const trail = trailStatus({ cfg, obs, identity, snapshotValid: dataValid, manualHolds: manualPauses,
  manualValid: manualPauseValid, pending: pending || {}, pendingValid: !pendingCorrupt,
  state: read('state/trail_peak.json'), stateExists: trailStateExists });
let lastRoundStatus = null;
try { lastRoundStatus = fs.readFileSync(file('state/last_round_status'), 'utf8').trim() || null; } catch {}
let lastAction = null, lastActionNote = null;
if (results && Array.isArray(results.results) && results.results.length && Date.now() - Date.parse(results.at) < 86400000) {
  const failures = results.results.filter((r) => r.done !== true);
  const done = results.results.filter((r) => r.done === true);
  lastAction = failures.length ? `${failures.length} 个动作失败／跳过` : `${done.length} 个动作完成`;
  lastActionNote = results.results.map((r) => `${r.act} ${r.market || ''}: ${r.done === true ? '已确认' : r.error || '未完成'}`).join('；').slice(0, 600);
}
const events = jsonl('state/run_events.jsonl');
const confirmed = confirmedRuns(events);
const exits = new Set();
for (const e of events.filter((e) => e.type === 'actions' && !e.dryrun)) {
  for (const r of e.results || []) if (r.act === 'stop' && r.done === true && r.note !== 'already deleted') exits.add(`${e.runId}|${e.phase}|${r.market}`);
}
const history = historyMetrics(jsonl('state/equity_curve.jsonl').filter(r=>!r.accountKey||r.accountKey===identity?.accountKey), dataValid ? { at: obs.at, equity } : null);
const points = history.points;
const curve = history.curve;
const maxDD = history.maxDrawdown;
let change24h = null, change24hPct = null;
const ref = points.filter((r) => Date.parse(r.at) <= Date.now() - 86400000).slice(-1)[0];
if (ref && equity !== null && num(ref.equity) > 0) { change24h = equity - num(ref.equity); change24hPct = change24h / num(ref.equity) * 100; }
const baseline = num(obs?.strategyEquity?.baseline ?? cfg.strategyBaselineUsd);
const baselineAt = obs?.strategyEquity?.baselineAt || cfg.strategyStartAt || null;
const equityChange = equity !== null && baseline !== null ? equity - baseline : null;
let accounting = { complete: false, strategyPnl: null };
let netDeclaredCashflow = null;
try {
  const ledger = read('state/attribution_ledger.json');
  if (ledger && (ledger.subaccountId !== (cfg.subaccountId ?? 3) || ledger.accountKey !== read('state/account_identity.json')?.accountKey)) throw new Error('ledger account mismatch');
  accounting = attribution(ledger, baselineAt, obs?.at, equityChange);
  // 已声明的净出入金（用户核对后导入的 cashflow 事件）：入金不算赚、出金不算亏
  netDeclaredCashflow = (Array.isArray(ledger?.events) ? ledger.events : [])
    .filter((e) => e.type === 'cashflow' && Number.isFinite(Number(e.amountUsd)))
    .reduce((s, e) => s + Number(e.amountUsd), 0);
  if (!netDeclaredCashflow) netDeclaredCashflow = null;
} catch (e) { accounting.error = String(e.message); }
const f = read('state/fees.json');
let verifiedWindow=null;
try{
  const window=read('state/verified_window.json'),accounted=read('state/window_accounting.json'),status=read('state/window_status.json');
  if(window){validateWindow(window,identity);verifiedWindow={baselineAt:window.baseline.at,baselineEquity:window.baseline.equity,netPnl:null,cashflowComplete:false,decompositionComplete:false,dataFresh:false};
    if(accounted&&accounted.identity?.accountKey===identity.accountKey&&accounted.windowBaselineHash===require('./contracts.cjs').hash(window.baseline)){
      if(!accounted.capture)throw Error('accounting proof unavailable');
      const raw={...accounted.capture};delete raw.captureHash;
      if(require('./contracts.cjs').hash(raw)!==accounted.captureHash)throw Error('accounting proof hash mismatch');
      const replay=reconcile(window,accounted.capture,read('state/attribution_ledger.json'),accounted.ledger);
      if(!require('./contracts.cjs').same(replay.report,accounted.report))throw Error('accounting result replay mismatch');
      const mature=Date.parse(accounted.report.asOf),captureAt=Date.parse(accounted.capturedAt);
      // 30-minute collector + 15-minute observations + 2-minute indexing buffer.
      const fresh=status?.ok===true&&Number.isFinite(mature)&&Number.isFinite(captureAt)&&Date.now()-mature>=0&&Date.now()-mature<=60*60000&&Date.now()-captureAt>=0&&Date.now()-captureAt<=40*60000;
      verifiedWindow={...verifiedWindow,...accounted.report,dataFresh:fresh};
      if(!fresh){verifiedWindow.netPnl=null;verifiedWindow.cashflowComplete=false;verifiedWindow.decompositionComplete=false;}
    }
  }
}catch{verifiedWindow={netPnl:null,cashflowComplete:false,decompositionComplete:false,dataFresh:false,error:'accounting window unavailable'};}
const historyStatus=read('state/history_status.json');
let fees = null;
if (f?.symbols && typeof f.symbols === 'object' && !Array.isArray(f.symbols)) {
  let feeUsd = 0, maker = 0, total = 0, fills = 0;
  for (const r of Object.values(f.symbols)) { feeUsd += num(r.feeUsd) || 0; maker += num(r.makerVol) || 0; total += (num(r.makerVol) || 0) + (num(r.takerVol) || 0); fills += (num(r.makerN) || 0) + (num(r.takerN) || 0); }
  fees = { feeUsd, makerPct: total > 0 ? maker / total * 100 : null, fills, acquiredAt: f.acquiredAt, incomplete: (f.accountKey&&f.accountKey!==identity?.accountKey) || historyStatus?.ok===false || f.incomplete !== false || !Number.isFinite(Date.parse(f.acquiredAt)) || Date.now() - Date.parse(f.acquiredAt) > 30 * 60000, source: f.source || 'legacy-aggregates', otherFeeCurrencies: [...new Set(Object.values(f.symbols).flatMap((r) => Object.keys(r.otherFees || {})))] };
}
const snapshot = {
  updatedAt: obs?.at || null, generatedAt: new Date().toISOString(), snapshotAge: Number.isFinite(age) ? age : null,
  equity, available: num(obs?.margin?.availableEquity), dataValid, identityValid, manualPauses, manualPauseValid, riskStateValid, pendingCorrupt, lastRoundStatus,
  stopBudget:dataValid?stopBudgetUsage(grids,equity,cfg):{valid:false,pct:null,reason:'账户快照待核对'},
  riskWriteValid: writeState?.ok === true && Number.isFinite(Date.parse(writeState.at)) && Date.parse(writeState.at) <= Date.parse(obs?.at) && Date.parse(writeState.at) >= Date.parse(obs?.at) - 10 * 60000,
  // 历史总盈亏：优先完整会计口径（strategyPnl）；无完整口径但有已声明出入金时，
  // 用「权益变化 − 净出入金」修正——2026-11-26 入金 180 后用户纠偏：裸 equityChange
  // 把新本金吞成"亏损"。两者皆无 → null（页面层回退显示，语义=未知而非零）。
  strategyTotalPnl: accounting.strategyPnl ?? (equityChange != null && netDeclaredCashflow != null ? equityChange - netDeclaredCashflow : null),
  netDeclaredCashflow, equityChange, accounting, verifiedWindow,
  strategyBaseline: baseline, strategyBaselineAt: baselineAt,
  fees, runStats: { days: baselineAt && Number.isFinite(Date.parse(baselineAt)) ? +Math.max(0, (Date.now() - Date.parse(baselineAt)) / 86400000).toFixed(1) : null, records: history.count, recordsSince: history.since, rounds: confirmed.successful, failedRounds: confirmed.failed, exits: exits.size, since: confirmed.since },
  change24h, change24hPct, maxDrawdown: maxDD, maxDrawdownScope: 'all-recorded-observation-samples', historySince: history.since,
  drawdownPct: riskStateValid && equity !== null && Number(risk.peakEquity) > 0 ? Math.max(0, (Number(risk.peakEquity) - equity) / Number(risk.peakEquity) * 100) : null, warnDrawdownPct,
  riskPaused: riskStateValid ? !!risk.paused : null, campaignVolume: campaignPublic.campaignVolume, campaignId:campaignPublic.campaignId, campaignSource:campaignPublic.source, campaignOfficialAt:campaignPublic.officialAt, tier1:campaignPublic.tier1, tier1Secured:campaignPublic.tier1Secured,
  grids: grids.map((g) => ({ market: g.market, direction: g.direction, rangeLow: num(g.range?.[0]), rangeHigh: num(g.range?.[1]), count: g.count, value: num(g.value), pnl: num(g.pnl), pnlPct: num(g.pnlPct), status: g.status, price: num(g.price), nativeSL: g.nativeSL, effPnlPct: num(g.effPnlPct), gridAgeLabel: formatAgeMin(gridCreatedAt[g.market] != null ? (gridNowMs - gridCreatedAt[g.market]) / 60000 : null) })),
  marketDataAvailable:obs?.marketDataAvailable!==false,
  tpPct: cfg.takeProfitPct, slPct: cfg.stopLossPct, positions,
  autoExits: { enabled: cfg.autoExitsEnabled === true, trailEnabled: trail.enabled, trailReady: trail.ready, trailReason: trail.reason,
    // effective values: mirror auto_exits.cjs defaultsFor so the UI shows what the
    // executor will actually do when a key is omitted (posTp omitted = 150 ENABLED,
    // only an explicit 0 disables take-profit)
    posSl: cfg.positionStopLossPct === undefined ? 150 : num(cfg.positionStopLossPct),
    posTp: cfg.positionTakeProfitPct === undefined ? 150 : num(cfg.positionTakeProfitPct),
    dwellMin: cfg.breachDwellMin === undefined ? 10 : num(cfg.breachDwellMin),
    bufferPct: cfg.breachBufferPct === undefined ? 0.5 : num(cfg.breachBufferPct) },
  direction,
  pending: pendingValid ? Object.keys(pending || {}) : null,
  orphans: positions.filter((p) => !grids.some((g) => g.market === p.market)).map((p) => p.market),
  lastAction, lastActionNote, curve,
};
fs.mkdirSync(file('state'), { recursive: true });
fs.writeFileSync(file('state/dashboard.json.tmp'), JSON.stringify(snapshot));
fs.renameSync(file('state/dashboard.json.tmp'), file('state/dashboard.json'));
if (process.argv.includes('--preview')) {
  const html = fs.readFileSync(file('cloudflare/dashboard.html'), 'utf8').replace('async function load() {', `async function load() { render(${JSON.stringify(snapshot).replace(/</g, '\\u003c')}); return;`);
  fs.writeFileSync(file('state/dashboard_preview.html'), html);
}
console.log('dashboard.json written');
