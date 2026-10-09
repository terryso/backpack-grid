#!/usr/bin/env node
// Builds state/ops.json for the public operations-history page from local records:
// grid decisions (run_events.jsonl), trade fills (history.sqlite via history_store.py),
// and round summaries (log.md). Public payload is sanitized — no order/account IDs.
// Any source read failure aborts the write so the last good file stays live.
//
// Freshness is per-source and honest (10-09 reviews F4/R2/R2'): updatedAt is the BUILD
// time, dataAsOf is the newest record across all sources, ledgerAsOf is the collection
// watermark (advances on every successful collection, trade or not), fillsAsOf is the
// last actual trade (informational only — quiet markets are not staleness). collection
// mirrors the collector's live report from state/history_status.json, tri-state
// (null = no/unreadable report, shown as unknown, never as success), plus the ledger's
// saved audit flags. ops_content_hash covers the data only — never updatedAt — so the
// uploader can skip unchanged payloads across quiet rounds (F6). log.md carries no
// account identity: a line is published only inside an identity-bound round window
// witnessed by run_events (10-09 reviews R1/R1'); unattributable lines stay local.
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
function runEvents(acct) {
  // Single pass over run_events.jsonl: identity-bound action rows for the page, plus
  // the timestamps of identity-bound round starts — those windows are the only witness
  // that a log.md line belongs to this account (log.md itself carries no identity).
  const rows = [], starts = [];
  try {
    for (const line of fs.readFileSync(p('run_events.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.identity || e.identity.accountKey !== acct) continue; // foreign/legacy rounds stay private
      const ts = Date.parse(e.at);
      if (e.type === 'start' && Number.isFinite(ts)) starts.push(ts);
      if (e.type !== 'actions' || !Array.isArray(e.results)) continue;
      for (const x of e.results) rows.push({
        at: e.at, act: x.act, market: x.market || '',
        reason: x.reason || x.why || '', done: x.done === true,
        status: e.resultStatus || '', ...(e.dryrun ? { dry: true } : {}),
      });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { rows: rows.slice(-CAPS.ops).reverse(), starts: starts.sort((a, b) => a - b) };
}
// A log.md line is publishable only inside an identity-bound round window
// [start_i, min(start_{i+1}, start_i + 30min)) — time-window filtering alone cannot
// bind authorship (10-09 re-reviews R1/R1'); unattributable lines stay local.
function witnessed(starts, ts) {
  let lo = 0, hi = starts.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  if (ans < 0) return false;
  const cap = starts[ans] + 30 * 60 * 1000;
  const next = ans + 1 < starts.length ? starts[ans + 1] : cap;
  return ts < Math.min(next, cap);
}
function rounds(coverageMs, starts) {
  const rows = [];
  if (!starts || !starts.length) return rows; // no identity-bound witness → nothing attributable
  const epoch = starts[0]; // first identity-bound round start: run_events began 10-02 with identity-less events
  try {
    for (const line of fs.readFileSync(p('log.md'), 'utf8').split('\n')) {
      const m = line.match(/^\[(.+?)\] (.+)$/);
      const ts = m ? Date.parse(m[1]) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (Number.isFinite(coverageMs) && coverageMs > 0 && ts < coverageMs) continue;
      // Witnessed era: strict per-round windows. Pre-witness era (before the first
      // identity event ever recorded): grandfathered via the account-bound ledger's
      // coverage window — the only attribution evidence that era's schema produced.
      if (ts >= epoch && !witnessed(starts, ts)) continue;
      rows.push({ at: m[1], line: m[2] });
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
const { rows: opsRows, starts } = runEvents(acct);
const roundRows = rounds(Number(store.coverageFrom), starts);
const hist = collectorStatus();
const fillsMax = Number(store.fillsMaxTs) > 0 ? Number(store.fillsMaxTs) : 0;
const fillsAsOf = fillsMax > 0 ? new Date(fillsMax).toISOString() : null;
const covMs = Number(store.coverageTo) > 0 ? Number(store.coverageTo) : 0;
// ledger coverage watermark: advances to asOf on every successful collection even with
// zero trades — the collection freshness signal (fillsAsOf alone would false-alarm on
// quiet markets, 10-09 re-review R2')
const ledgerAsOf = covMs > 0 ? new Date(covMs).toISOString() : null;
const newest = Math.max(0,
  covMs, fillsMax,
  ...fillRows.map((f) => Date.parse(f.t) || 0),
  ...opsRows.map((o) => Date.parse(o.at) || 0),
  ...roundRows.map((r) => Date.parse(r.at) || 0));
const dataAsOf = newest > 0 ? new Date(newest).toISOString() : null;
// collection.ok is tri-state: true/false from the collector report, null = no report or
// unreadable — unknown must never be displayed as success (10-09 re-review R3')
const data = { ops: opsRows, fills: fillRows, rounds: roundRows, dataAsOf, fillsAsOf, ledgerAsOf,
  collection: { ok: hist ? hist.ok === true : null, checkedAt: hist ? hist.at : null,
                incomplete: store.incomplete === true, fillCount: store.fillCount } };
atomic(p('ops.json'), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }));
// written after ops.json on purpose: a failed data write must never poison the hash
atomic(p('ops_content_hash'), hash(data));
console.log('ops history built:', fillRows.length, 'fills; data as of', dataAsOf || 'n/a',
  '; ledger as of', ledgerAsOf || 'n/a', '; rounds', roundRows.length);
