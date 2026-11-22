"use strict";
const { same } = require("./contracts.cjs");
const { finiteNumber, plainObject } = require("./state_schema.cjs");
const START = Date.UTC(2026, 8, 30);
const SIX_HOURS = 6 * 3600 * 1000;
const AUDIT_WINDOW = 7 * 24 * 3600 * 1000;
const AUDIT_INTERVAL = 24 * 3600 * 1000;
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
  const windowMs = options.windowMs ?? SIX_HOURS;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("invalid history window");
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
        let hi = Math.min(lo + windowMs, asOf);
        if (options.persistPendingWindow && rec.pendingWindowEnd != null) {
          if (!Number.isSafeInteger(rec.pendingWindowEnd) || rec.pendingWindowEnd <= lo || rec.pendingWindowEnd > hi) throw new Error("invalid pending history window");
          hi = rec.pendingWindowEnd;
        }
        let fills;
        while (requests < maxRequests) {
          requests++;
          try { fills = await fetchPage(symbol, lo, hi); }
          catch (e) {
            // Some deployments may impose an undocumented range limit. Shrink
            // only explicit client/range errors; never skip the failed window.
            if (options.rangeFallback && /\bhistory HTTP (?:400|413|422)\b/.test(String(e?.message || e)) && hi - lo > SIX_HOURS) {
              hi = lo + Math.max(SIX_HOURS, Math.floor((hi - lo) / 2));
              if (options.persistPendingWindow) rec.pendingWindowEnd = hi;
              continue;
            }
            throw e;
          }
          if (!Array.isArray(fills)) throw new Error("fills response is not an array");
          if (fills.length < 1000) break;
          if (hi - lo <= 1) throw new Error("saturated timestamp; pagination required");
          hi = Math.floor((hi + lo) / 2);
          if (options.persistPendingWindow) rec.pendingWindowEnd = hi;
        }
        if (!fills || fills.length >= 1000) break;
        // Validate the ENTIRE page before applying any part of it.
        const batch = new Map();
        for (const f of fills) {
          const id = f.id ?? f.tradeId;
          const timestamp = fillTimestamp(f.timestamp);
          const owner = options.identity;
          const ownerOk = !owner || ((!Object.prototype.hasOwnProperty.call(f, 'userId') ||
            ((typeof f.userId === 'string' && f.userId.trim() !== '' || Number.isSafeInteger(f.userId)) && String(f.userId) === owner.userId)) &&
            (!Object.prototype.hasOwnProperty.call(f, 'subaccountId') ||
              (finiteNumber(f.subaccountId) && Number.isSafeInteger(Number(f.subaccountId)) && Number(f.subaccountId) === owner.subaccountId)));
          if (!((typeof id === "string" && id !== "") || Number.isSafeInteger(id)) || typeof f.symbol !== 'string' || f.symbol !== symbol || !ownerOk
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
        if (options.persistPendingWindow) delete rec.pendingWindowEnd;
      }
    } catch (e) { rec.error = String(e.message); }
    rec.incomplete = rec.lastTo < asOf || !!rec.error;
    state.symbols[symbol] = rec;
  }
  state.acquiredAt = new Date(now).toISOString();
  state.asOf = new Date(asOf).toISOString();
  state.forwardIncomplete = Object.values(state.symbols).some((r) => r.incomplete);
  state.incomplete = state.forwardIncomplete;
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
  return { symbols, acquiredAt: state.acquiredAt, asOf: state.asOf, incomplete: state.incomplete,
    forwardIncomplete: state.forwardIncomplete, auditIncomplete: state.auditIncomplete, source: "raw-fill-ledger" };
}
module.exports = { collectHistory, summarizeHistory, fillTimestamp, START };

// Bounded deep audit across rounds catches arrivals older than the overlap window.
async function auditHistory(state, symbols, now, fetchPage, maxRequests=10, options={}) {
  if (!plainObject(state) || !plainObject(state.symbols) || !Number.isSafeInteger(now)) throw new Error("invalid audit state");
  let remaining=maxRequests;
  const target=now;
  const names = [...new Set([...symbols, ...Object.keys(state.symbols)])].filter(symbol => state.symbols[symbol]);
  const due = rec => rec.auditTarget != null || !!rec.auditError || !finiteNumber(rec.auditedThrough) || Number(rec.auditedThrough) < START
    || Number(rec.auditedThrough) > target || target - Number(rec.auditedThrough) >= AUDIT_INTERVAL;
  // Oldest attempt first: a slow or failing market cannot monopolize every round.
  const attemptAt = rec => finiteNumber(rec.auditLastAttempt) && Number(rec.auditLastAttempt) >= START && Number(rec.auditLastAttempt) <= target ? Number(rec.auditLastAttempt) : 0;
  names.sort((a,b) => attemptAt(state.symbols[a]) - attemptAt(state.symbols[b]) || String(a).localeCompare(String(b)));
  for(const symbol of names) {
    if(remaining<=0)break;
    const rec=state.symbols[symbol];if(!rec)continue;
    if(!due(rec))continue;
    if(rec.auditTarget == null) {rec.auditTarget=target;rec.auditCursor=START;}
    if (!Number.isSafeInteger(rec.auditTarget) || rec.auditTarget < START || rec.auditTarget > target) throw new Error("invalid audit target");
    const auditRec={from:START,lastTo:rec.auditCursor,fills:rec.fills};
    if(rec.auditPendingEnd != null)auditRec.pendingWindowEnd=rec.auditPendingEnd;
    const audit={symbols:{[symbol]:auditRec}};
    let used=0;
    await collectHistory(audit,[symbol],rec.auditTarget,async (...args)=>{used++;return fetchPage(...args);},remaining,
      {overlapMs:0,windowMs:AUDIT_WINDOW,persistPendingWindow:true,rangeFallback:true,identity:options.identity});
    remaining-=used;
    if(used>0)rec.auditLastAttempt=target;
    Object.assign(rec.fills,audit.symbols[symbol].fills);rec.auditCursor=audit.symbols[symbol].lastTo;
    if(audit.symbols[symbol].pendingWindowEnd != null)rec.auditPendingEnd=audit.symbols[symbol].pendingWindowEnd;
    else delete rec.auditPendingEnd;
    if(audit.symbols[symbol].error) {
      rec.auditError=audit.symbols[symbol].error;
      if(rec.incomplete !== true)rec.error=rec.auditError;
    } else {
      delete rec.auditError;
      if(rec.incomplete !== true)rec.error=null;
    }
    if(!audit.symbols[symbol].incomplete){rec.auditedThrough=rec.auditTarget;delete rec.auditTarget;delete rec.auditCursor;delete rec.auditPendingEnd;}
  }
  state.auditIncomplete=names.some(symbol=>due(state.symbols[symbol]));
  state.forwardIncomplete=typeof state.forwardIncomplete === 'boolean' ? state.forwardIncomplete : state.incomplete === true;
  state.incomplete=state.forwardIncomplete || state.auditIncomplete;
  return state;
}
module.exports.auditHistory=auditHistory;
