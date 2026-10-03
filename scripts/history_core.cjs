"use strict";
const { same } = require("./contracts.cjs");
const { finiteNumber, plainObject } = require("./state_schema.cjs");
const START = Date.UTC(2026, 8, 30);
function fillTimestamp(raw) {
  if (finiteNumber(raw)) return Number(raw);
  // WAPI returns UTC ISO timestamps, often without a trailing Z. Never let
  // the machine's local timezone move a fill across a requested boundary.
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : raw + "Z");
}
// Inclusive endpoint boundaries are harmless: raw fills are keyed by stable ID.
// Raw fills and cursors are committed together by the caller's atomic snapshot.
async function collectHistory(state, symbols, now, fetchPage, maxRequests = 30, options = {}) {
  if (!plainObject(state) || !plainObject(state.symbols)) throw new Error("invalid history state");
  const asOf = now - (options.safetyLagMs || 0);
  const overlap = options.overlapMs ?? 3600000;
  let requests = 0;
  for (const symbol of symbols) {
    const rec = state.symbols[symbol] || { from: START, lastTo: START, fills: {} };
    if (!plainObject(rec.fills) || !finiteNumber(rec.lastTo) || Number(rec.lastTo) < START || Number(rec.lastTo) > now) throw new Error("invalid history cursor");
    rec.lastTo = Number(rec.lastTo);
    rec.error = null;
    const previousTo = rec.lastTo;
    let lo = previousTo >= asOf ? previousTo : Math.max(START, previousTo - overlap);
    try {
      while (lo < asOf && requests < maxRequests) {
        let hi = Math.min(lo + 6 * 3600 * 1000, asOf);
        let fills;
        while (requests < maxRequests) {
          requests++;
          fills = await fetchPage(symbol, lo, hi);
          if (!Array.isArray(fills)) throw new Error("fills response is not an array");
          if (fills.length < 1000) break;
          if (hi - lo <= 1) throw new Error("saturated timestamp; pagination required");
          hi = Math.floor((hi + lo) / 2);
        }
        if (!fills || fills.length >= 1000) break;
        // Validate the ENTIRE page before applying any part of it.
        const batch = new Map();
        for (const f of fills) {
          const id = f.id ?? f.tradeId;
          const timestamp = fillTimestamp(f.timestamp);
          if (!((typeof id === "string" && id !== "") || Number.isSafeInteger(id))
            || !Number.isFinite(timestamp) || timestamp < lo || timestamp > hi
            || !finiteNumber(f.price) || Number(f.price) <= 0 || !finiteNumber(f.quantity) || Number(f.quantity) <= 0
            || !finiteNumber(f.fee) || typeof f.feeSymbol !== "string" || typeof f.isMaker !== "boolean") throw new Error("invalid fill fields");
          const old = batch.get(String(id)) || rec.fills[String(id)];
          if (old && !same(old, f)) throw new Error("conflicting fill ID");
          batch.set(String(id), f);
        }
        for (const f of fills) rec.fills[String(f.id ?? f.tradeId)] = f;
        lo = hi;
        rec.lastTo = Math.max(previousTo, lo);
      }
    } catch (e) { rec.error = String(e.message); }
    rec.incomplete = rec.lastTo < asOf || !!rec.error;
    state.symbols[symbol] = rec;
  }
  state.acquiredAt = new Date(now).toISOString();
  state.asOf = new Date(asOf).toISOString();
  state.incomplete = Object.values(state.symbols).some((r) => r.incomplete);
  return state;
}
function summarizeHistory(state) {
  const symbols = {};
  for (const [symbol, r] of Object.entries(state.symbols)) {
    const s = { from: r.from, lastTo: r.lastTo, feeUsd: 0, makerVol: 0, takerVol: 0, makerN: 0, takerN: 0, otherFees: {}, incomplete: r.incomplete, error: r.error };
    for (const f of Object.values(r.fills)) {
      if (f.feeSymbol === "USDC") s.feeUsd += Number(f.fee);
      else s.otherFees[f.feeSymbol] = (s.otherFees[f.feeSymbol] || 0) + Number(f.fee);
      const kind = f.isMaker ? "maker" : "taker";
      s[kind + "Vol"] += Number(f.price) * Number(f.quantity);
      s[kind + "N"]++;
    }
    symbols[symbol] = s;
  }
  return { symbols, acquiredAt: state.acquiredAt, asOf: state.asOf, incomplete: state.incomplete, source: "raw-fill-ledger" };
}
module.exports = { collectHistory, summarizeHistory, fillTimestamp, START };

// Bounded deep audit across rounds catches arrivals older than the overlap window.
async function auditHistory(state, symbols, now, fetchPage, maxRequests=10) {
  let remaining=maxRequests;
  const target=now;
  for(const symbol of symbols) {
    if(remaining<=0)break;
    const rec=state.symbols[symbol];if(!rec)continue;
    if(!rec.auditTarget && (!rec.auditedThrough || now-rec.auditedThrough>=86400000)) {rec.auditTarget=target;rec.auditCursor=START;}
    if(!rec.auditTarget)continue;
    const audit={symbols:{[symbol]:{from:START,lastTo:rec.auditCursor,fills:rec.fills}}};
    let used=0;
    await collectHistory(audit,[symbol],rec.auditTarget,async (...args)=>{used++;return fetchPage(...args);},remaining,{overlapMs:0});
    remaining-=used;
    Object.assign(rec.fills,audit.symbols[symbol].fills);rec.auditCursor=audit.symbols[symbol].lastTo;
    if(audit.symbols[symbol].error)rec.error=audit.symbols[symbol].error;
    if(!audit.symbols[symbol].incomplete){rec.auditedThrough=rec.auditTarget;delete rec.auditTarget;delete rec.auditCursor;}
  }
  state.auditIncomplete=Object.values(state.symbols).some(r=>r.auditTarget);
  state.incomplete=state.incomplete||state.auditIncomplete;
  return state;
}
module.exports.auditHistory=auditHistory;
