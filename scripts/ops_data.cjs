#!/usr/bin/env node
// Builds state/ops.json for the public operations-history page from local records:
// grid decisions (run_events.jsonl), trade fills (history.sqlite via history_store.py),
// and round summaries (log.md). Public payload is sanitized — no order/account IDs.
// Any source read failure aborts the write so the last good file stays live.
//
// Freshness is per-source and honest (10-09 reviews F4/R2): updatedAt is the BUILD
// time, dataAsOf is the newest record across all sources, fillsAsOf is the fill
// ledger's own coverage (a fresh round summary can never mask a stale ledger), and
// collection mirrors the collector's live state from state/history_status.json (same
// semantics dashboard_data uses) plus the ledger's saved audit flags. The page renders
// them apart. ops_content_hash covers the data only — never updatedAt — so the
// uploader can skip unchanged payloads across quiet rounds (F6). log.md carries no
// account identity: rounds are published only inside the account-bound ledger's
// coverage window (10-09 re-audit R1); older/unattributable lines stay local.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { atomic, hash } = require('./contracts.cjs');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..'), p = (s) => path.join(ROOT, 'state', s);
const PY = process.env.PY_BIN || 'python3';
const CAPS = { ops: 1000, fills: 5000, rounds: 2000 };

function accountKey() {
  return String(JSON.parse(fs.readFileSync(p('account_identity.json'), 'utf8')).accountKey || '');
}
function py(command, args) {
  const r = spawnSync(PY, [path.join(__dirname, 'history_store.py'), command, ...(args || [])],
    { env: { ...process.env, BG_ROOT: ROOT }, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw Error('history store ' + command + ' failed: ' + String(r.stderr).slice(0, 150));
  return JSON.parse(r.stdout);
}
function fills() {
  return py('fills', [String(CAPS.fills)]).map((f) => ({
    t: String(f.timestamp).endsWith('Z') ? f.timestamp : f.timestamp + 'Z',
    s: f.symbol, side: f.side === 'Bid' ? 'buy' : 'sell',
    p: f.price, q: f.quantity, fee: f.fee, fs: f.feeSymbol, mk: !!f.isMaker,
  }));
}
function ops(acct) {
  const rows = [];
  try {
    for (const line of fs.readFileSync(p('run_events.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'actions' || !Array.isArray(e.results)) continue;
      if (!e.identity || e.identity.accountKey !== acct) continue; // foreign/legacy rounds stay private
      for (const x of e.results) rows.push({
        at: e.at, act: x.act, market: x.market || '',
        reason: x.reason || x.why || '', done: x.done === true,
        status: e.resultStatus || '', ...(e.dryrun ? { dry: true } : {}),
      });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return rows.slice(-CAPS.ops).reverse();
}
function rounds(coverageMs) {
  const rows = [];
  if (!Number.isFinite(coverageMs) || coverageMs <= 0) return rows; // no ledger anchor → nothing attributable
  try {
    for (const line of fs.readFileSync(p('log.md'), 'utf8').split('\n')) {
      const m = line.match(/^\[(.+?)\] (.+)$/);
      const ts = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(ts) && ts >= coverageMs) rows.push({ at: m[1], line: m[2] });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return rows.slice(-CAPS.rounds).reverse();
}
function collectorStatus() {
  // Live collector report written by history_status.cjs after every collection run;
  // same signal dashboard_data consumes. Missing/unreadable = unknown → treated as ok.
  try {
    const v = JSON.parse(fs.readFileSync(p('history_status.json'), 'utf8'));
    if (v && typeof v === 'object' && typeof v.ok === 'boolean') return v;
  } catch {}
  return null;
}

const acct = accountKey(); // identity read failure aborts before any write
const fillRows = fills();
const store = py('status');
const opsRows = ops(acct), roundRows = rounds(Number(store.coverageFrom));
const hist = collectorStatus();
const fillsMax = Number(store.fillsMaxTs) > 0 ? Number(store.fillsMaxTs) : 0;
const fillsAsOf = fillsMax > 0 ? new Date(fillsMax).toISOString() : null;
const newest = Math.max(0,
  fillsMax,
  ...fillRows.map((f) => Date.parse(f.t) || 0),
  ...opsRows.map((o) => Date.parse(o.at) || 0),
  ...roundRows.map((r) => Date.parse(r.at) || 0));
const dataAsOf = newest > 0 ? new Date(newest).toISOString() : null;
const data = { ops: opsRows, fills: fillRows, rounds: roundRows, dataAsOf, fillsAsOf,
  collection: { ok: hist ? hist.ok !== false : true, checkedAt: hist ? hist.at : null,
                incomplete: store.incomplete === true, fillCount: store.fillCount } };
atomic(p('ops.json'), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }));
// written after ops.json on purpose: a failed data write must never poison the hash
atomic(p('ops_content_hash'), hash(data));
console.log('ops history built:', fillRows.length, 'fills; data as of', dataAsOf || 'n/a',
  '; fills as of', fillsAsOf || 'n/a', '; rounds', roundRows.length);
