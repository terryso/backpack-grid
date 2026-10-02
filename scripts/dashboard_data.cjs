#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { money: num, riskStructOk, pendingStructOk } = require('./state_schema.cjs');
const { attribution } = require('./accounting.cjs');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
const file = (p) => path.join(ROOT, p);
const read = (p) => { try { return JSON.parse(fs.readFileSync(file(p), 'utf8')); } catch { return null; } };
const jsonl = (p) => { try { return fs.readFileSync(file(p), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const cfg = read('config.json') || {};
const obs = read('state/observed.json');
const risk = read('state/risk.json');
const pending = read('state/pending_stops.json');
const campaign = read('state/campaign.json');
const results = read('state/act_results.json');
const writeState = read('state/risk_write_status.json');
const grids = Array.isArray(obs?.gridRows) ? obs.gridRows : [];
const positions = Array.isArray(obs?.positions) ? obs.positions : [];
const equity = num(obs?.margin?.totalEquity);
const age = obs?.at ? (Date.now() - Date.parse(obs.at)) / 1000 : null;
const dataValid = !!obs && !obs.error && age !== null && Number.isFinite(age) && age >= -60 && age <= 20 * 60
  && equity !== null && Array.isArray(obs.gridRows) && Array.isArray(obs.positions);
const riskStateValid = riskStructOk(risk);
const pendingValid = pendingStructOk(pending) || (!fs.existsSync(file('state/pending_stops.json')));
const pendingCorrupt = !pendingValid || fs.existsSync(file('state/pending_corrupt.json'));
let lastRoundStatus = null;
try { lastRoundStatus = fs.readFileSync(file('state/last_round_status'), 'utf8').trim() || null; } catch {}
let lastAction = null, lastActionNote = null;
if (results && Array.isArray(results.results) && Date.now() - Date.parse(results.at) < 86400000) {
  const failures = results.results.filter((r) => r.done !== true);
  const done = results.results.filter((r) => r.done === true);
  lastAction = failures.length ? `${failures.length} 个动作失败／跳过` : `${done.length} 个动作完成`;
  lastActionNote = results.results.map((r) => `${r.act} ${r.market || ''}: ${r.done === true ? '已确认' : r.error || '未完成'}`).join('；').slice(0, 600);
}
const events = jsonl('state/run_events.jsonl');
const completed = new Map(events.filter((e) => e.type === 'end' && !e.dryrun).map((e) => [e.runId, e]));
const exits = new Set();
for (const e of events.filter((e) => e.type === 'actions' && !e.dryrun)) {
  for (const r of e.results || []) if (r.act === 'stop' && r.done === true && r.note !== 'already deleted') exits.add(`${e.runId}|${e.phase}|${r.market}`);
}
const points = jsonl('state/equity_curve.jsonl').filter((r) => Number.isFinite(Date.parse(r.at)) && num(r.equity) !== null && !r.dryrun)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const curve = [...new Map(points.map((r) => [r.at, [r.at, num(r.equity), num(r.campaignVolume)]])).values()].slice(-400);
let maxDD = null, peak = 0, change24h = null, change24hPct = null;
for (const p of curve) { peak = Math.max(peak, p[1]); if (peak > 0) maxDD = Math.max(maxDD ?? 0, (peak - p[1]) / peak * 100); }
const ref = points.filter((r) => Date.parse(r.at) <= Date.now() - 86400000).slice(-1)[0];
if (ref && equity !== null && num(ref.equity) > 0) { change24h = equity - num(ref.equity); change24hPct = change24h / num(ref.equity) * 100; }
const baseline = num(obs?.strategyEquity?.baseline ?? cfg.strategyBaselineUsd);
const baselineAt = obs?.strategyEquity?.baselineAt || cfg.strategyStartAt || null;
const equityChange = equity !== null && baseline !== null ? equity - baseline : null;
let accounting = { complete: false, strategyPnl: null };
try {
  const ledger = read('state/attribution_ledger.json');
  if (ledger && ledger.subaccountId !== (cfg.subaccountId || 3)) throw new Error('ledger account mismatch');
  accounting = attribution(ledger, baselineAt, obs?.at, equityChange);
} catch (e) { accounting.error = String(e.message); }
const f = read('state/fees.json');
let fees = null;
if (f?.symbols && typeof f.symbols === 'object' && !Array.isArray(f.symbols)) {
  let feeUsd = 0, maker = 0, total = 0, fills = 0;
  for (const r of Object.values(f.symbols)) { feeUsd += num(r.feeUsd) || 0; maker += num(r.makerVol) || 0; total += (num(r.makerVol) || 0) + (num(r.takerVol) || 0); fills += (num(r.makerN) || 0) + (num(r.takerN) || 0); }
  fees = { feeUsd, makerPct: total > 0 ? maker / total * 100 : null, fills, acquiredAt: f.acquiredAt, incomplete: f.incomplete !== false || !Number.isFinite(Date.parse(f.acquiredAt)) || Date.now() - Date.parse(f.acquiredAt) > 30 * 60000, source: f.source || 'legacy-aggregates', otherFeeCurrencies: [...new Set(Object.values(f.symbols).flatMap((r) => Object.keys(r.otherFees || {})))] };
}
const snapshot = {
  updatedAt: obs?.at || null, generatedAt: new Date().toISOString(), snapshotAge: Number.isFinite(age) ? age : null,
  equity, available: num(obs?.margin?.availableEquity), dataValid, riskStateValid, pendingCorrupt, lastRoundStatus,
  riskWriteValid: writeState?.ok === true && Number.isFinite(Date.parse(writeState.at)) && Date.parse(writeState.at) <= Date.parse(obs?.at) && Date.parse(writeState.at) >= Date.parse(obs?.at) - 10 * 60000,
  strategyTotalPnl: accounting.strategyPnl, equityChange, accounting,
  strategyBaseline: baseline, strategyBaselineAt: baselineAt,
  fees, runStats: { days: baselineAt ? (Date.now() - Date.parse(baselineAt)) / 86400000 : null, rounds: completed.size, exits: exits.size, since: events[0]?.startedAt || null },
  change24h, change24hPct, maxDrawdown: maxDD, maxDrawdownScope: 'last-400-observation-samples',
  drawdownPct: riskStateValid && equity !== null && Number(risk.peakEquity) > 0 ? Math.max(0, (Number(risk.peakEquity) - equity) / Number(risk.peakEquity) * 100) : null,
  riskPaused: riskStateValid ? !!risk.paused : null, campaignVolume: num(campaign?.campaignVolume), tier1: 50000, tier1Secured: num(campaign?.campaignVolume) >= 50000 && num(campaign?.campaignVolume) !== null,
  grids: grids.map((g) => ({ market: g.market, direction: g.direction, rangeLow: num(g.range?.[0]), rangeHigh: num(g.range?.[1]), count: g.count, value: num(g.value), pnl: num(g.pnl), pnlPct: num(g.pnlPct), status: g.status, price: num(g.price), nativeSL: g.nativeSL, effPnlPct: num(g.effPnlPct) })),
  tpPct: cfg.takeProfitPct, slPct: cfg.stopLossPct, positions,
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
