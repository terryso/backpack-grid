"use strict";
const { plainObject, finiteNumber } = require('./state_schema.cjs');
const TYPES = ['cashflow', 'funding', 'interest', 'reward'];
function validateLedger(v) {
  if (!plainObject(v) || !Array.isArray(v.events) || !plainObject(v.coverage)) throw new Error('invalid attribution ledger');
  const ids = new Set();
  for (const e of v.events) {
    if (!plainObject(e) || typeof e.id !== 'string' || !e.id || ids.has(e.id)
      || !TYPES.includes(e.type) || !finiteNumber(e.amountUsd) || !Number.isFinite(Date.parse(e.at))
      || typeof e.source !== 'string' || !e.source) throw new Error('invalid or duplicate ledger event');
    ids.add(e.id);
  }
  for (const [kind, c] of Object.entries(v.coverage)) {
    if (!TYPES.includes(kind) || !plainObject(c) || !Number.isFinite(Date.parse(c.from))
      || !Number.isFinite(Date.parse(c.through)) || Date.parse(c.through) < Date.parse(c.from)
      || typeof c.source !== 'string' || !c.source) throw new Error('invalid coverage declaration');
  }
  return v;
}
function attribution(ledger, baselineAt, nowAt, equityChange) {
  const out = { complete: false, netCashflow: null, strategyPnl: null, funding: null, interest: null, reward: null };
  if (!ledger) return out;
  validateLedger(ledger);
  const start = Date.parse(baselineAt), end = Date.parse(nowAt);
  if (typeof baselineAt !== 'string' || !baselineAt.includes('T') || !Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (const type of TYPES) {
    const c = ledger.coverage[type];
    if (!c || Date.parse(c.from) > start || Date.parse(c.through) < end) continue;
    const sum = ledger.events.filter((e) => e.type === type && Date.parse(e.at) > start && Date.parse(e.at) <= end)
      .reduce((n, e) => n + Number(e.amountUsd), 0);
    if (type === 'cashflow') out.netCashflow = sum;
    else out[type] = sum;
  }
  if (out.netCashflow !== null && finiteNumber(equityChange)) out.strategyPnl = Number(equityChange) - out.netCashflow;
  out.complete = out.strategyPnl !== null && TYPES.every((t) => t === 'cashflow' ? out.netCashflow !== null : out[t] !== null);
  if (out.complete) out.tradingPnl = out.strategyPnl - out.funding - out.interest - out.reward;
  return out;
}
module.exports = { validateLedger, attribution };
