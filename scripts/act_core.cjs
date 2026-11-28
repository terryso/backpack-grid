// act_core.cjs — production control flow for grid stop/create gating, with injected I/O
// so the REAL logic can be executed under Node with mocked exchange access (regression
// suite). act.mjs wires the live io (page.fetch based) into makeStopGrid().
"use strict";

const { pendingStructOk, finiteNumber, plainObject, positionListOk } = require("./state_schema.cjs");
const { isPositionRef } = require("./position_ref.cjs");
const { createIntentState } = require("./pending_create.cjs");
const { isStopReview, hasDurablePreparedTrail } = require('./pending_stop.cjs');
const { makeReviewStopGrid } = require('./review_stop.cjs');

// io: {
//   jget(pathname), jpatch(pathname, body),      — session-authenticated exchange access
//   getAutomation(),                             — GET automation config
//   sleep(ms), waitFor(cond, ms),                — timing
//   loadPending(), savePending(pending),         — pending ledger (corrupt handling in wrapper)
// }
function makeStopGrid(io) {
  const reviewStopGrid = makeReviewStopGrid(io);
  return async function stopGrid(market, range, reason, results, options = {}) {
    if (options.reviewStop === true) return reviewStopGrid(market, range, reason, results, options);
    if(io.assertAccount) await io.assertAccount();
    const symbol = String(market).replace("-PERP", "_USDC_PERP");
    const loaded = await io.loadPending();
    const pending = loaded.pending;
    const existing = pending[market];
    if (isStopReview(existing)) {
      results.push({act:'hold-unknown-stop',market,done:false,manualRequired:true,unconfirmed:true,
        error:'stop outcome requires review; stale stop plan refused'});
      return {done:false};
    }
    const createState = createIntentState(existing);
    if (createState && options.independentRisk !== true) {
      if (createState === 'prepared') {
        delete pending[market];
        await io.savePending(pending);
        results.push({ act:'clear-prepared-create', market, done:true, note:'unissued create intent cleared without exchange write' });
        return { done:true };
      }
      results.push({ act:'hold-unknown-create', market, done:false, unconfirmed:true, manualRequired:true,
        error:'create outcome unknown; no automatic stop without an independent risk exit' });
      return { done:false };
    }
    const unknownCreate = createState === 'unknown';
    const retryingRisk = options.retryPendingRisk === true || /^pending risk stop retry \(/.test(String(reason || ''));
    const supersedingRisk = unknownCreate && existing?.riskStop?.status === 'pending' && !retryingRisk;
    const isTrail = Object.prototype.hasOwnProperty.call(options, 'trailPositionRef') || /AUTO_TRAIL/.test(String(reason || ''));
    let trailRef = null;
    if (isTrail) {
      const requested = options.trailPositionRef;
      const stored = supersedingRisk ? null : existing?.trailPositionRef;
      if ((requested != null && !isPositionRef(requested)) || (stored != null && !isPositionRef(stored))
          || (requested && stored && requested !== stored)) throw new Error('trail position identity invalid');
      trailRef = requested || stored;
      if (!isPositionRef(trailRef) || typeof io.getTrailPositionRef !== 'function') throw new Error('trail position identity unavailable');
      if (!supersedingRisk && existing?.trailPhase != null && !['prepared', 'issued'].includes(existing.trailPhase)) throw new Error('trail position phase invalid');
    }
    const trailState = async () => {
      const current = await io.getTrailPositionRef(symbol);
      if (current?.state === 'flat') return 'flat';
      if (current?.state === 'known' && isPositionRef(current.ref)) return current.ref === trailRef ? 'known' : 'changed';
      return 'unknown';
    };
    const skipPrepared = async message => {
      // A newly planned trail that is already stale cannot cancel an older,
      // possibly issued risk stop before its replacement is persisted.
      if (pending[market] && !supersedingRisk) {
        if (unknownCreate) {
          const { trailPositionRef, trailPhase, trailIntentVersion, ...create } = pending[market];
          pending[market] = { ...create, riskStop:{ at:new Date().toISOString(), reason:message, status:'cancelled' } };
        }
        else delete pending[market];
        await io.savePending(pending, {durable:true});
      }
      results.push({ act: 'stop', market, done: false, skipped: true, error: message });
      return { done: false, skipped: true };
    };
    if (isTrail) {
      const current = await trailState();
      if (current === 'unknown') throw new Error('trail position identity unavailable');
      const priorTrailPhase = supersedingRisk ? null : existing?.trailPhase;
      const knownUnsent = !supersedingRisk && hasDurablePreparedTrail(existing);
      if ((current === 'flat' || current === 'changed') && knownUnsent)
        return await skipPrepared('trailing position changed before any exchange request');
      if (current === 'flat' && priorTrailPhase === 'prepared' && !knownUnsent)
        throw new Error('legacy trailing outcome unknown; manual review required');
      if (current === 'flat' && (!existing || (createState && priorTrailPhase !== 'issued'))) return await skipPrepared('trailing position already flat');
      if (current === 'changed') throw new Error('trail position identity changed');
    }
    // WRITE-AHEAD: persist the stop intent BEFORE any exchange write, so a lost response
    // can never leave the grid stopped on-exchange with an empty pending ledger
    if (createState === 'prepared') {
      // An independent risk exit may replace a definitely-unsent create, but
      // only after its own stop intent has been persisted.
      pending[market] = { at:new Date().toISOString(), reason,
        ...(isTrail ? { trailPositionRef:trailRef, trailPhase:'prepared', trailIntentVersion:2 } : {}) };
      await io.savePending(pending, isTrail ? {durable:true} : undefined);
    } else if (unknownCreate) {
      // Do not discard an unknown create outcome when independently managing risk.
      let retained = existing;
      const reuseTrail = isTrail && !supersedingRisk && existing?.trailPositionRef === trailRef && existing?.trailPhase != null;
      if (supersedingRisk) {
        const { trailPositionRef, trailPhase, trailIntentVersion, ...create } = existing;
        const history = Array.isArray(existing.previousRiskStops) ? existing.previousRiskStops
          : existing.previousRiskStops == null ? [] : [{ unrecognizedHistory:existing.previousRiskStops }];
        retained = { ...create, previousRiskStops:[...history,
          { ...existing.riskStop, ...(trailPositionRef != null ? { trailPositionRef } : {}),
            ...(trailPhase != null ? { trailPhase } : {}),
            ...(trailIntentVersion != null ? { trailIntentVersion } : {}), supersededAt:new Date().toISOString() }] };
      }
      pending[market] = { ...retained, riskStop:{ at:new Date().toISOString(), reason, status:'pending' },
        ...(isTrail ? { trailPositionRef:trailRef,
          trailPhase:reuseTrail ? existing.trailPhase : 'prepared',
          ...(reuseTrail ? (existing.trailIntentVersion === 2 ? {trailIntentVersion:2} : {}) : {trailIntentVersion:2}) } : {}) };
      await io.savePending(pending, isTrail ? {durable:true} : undefined);
    } else if (!pending[market]) {
      pending[market] = { at: new Date().toISOString(), reason,
        ...(isTrail ? { trailPositionRef: trailRef, trailPhase: 'prepared', trailIntentVersion:2 } : {}) };
      await io.savePending(pending, isTrail ? {durable:true} : undefined);
    }
    const updatePending = nextReason => {
      const prior = pending[market] || {};
      pending[market] = unknownCreate
        ? { ...prior, riskStop:{ at:new Date().toISOString(), reason:nextReason, status:'pending' } }
        : { at: new Date().toISOString(), reason: nextReason,
          ...(isPositionRef(prior.trailPositionRef) ? { trailPositionRef: prior.trailPositionRef, trailPhase: prior.trailPhase || 'issued',
            ...(prior.trailIntentVersion === 2 ? {trailIntentVersion:2} : {}) } : {}) };
    };
    const auto1 = await io.getAutomation();
    if (!Array.isArray(auto1.params?.symbols)) throw new Error("automation response malformed; intent retained");
    const entry = auto1.params.symbols.find((s) => s.symbol === symbol);
    if (!entry) {
      if (unknownCreate) {
        results.push({act:"stop",market,done:false,unconfirmed:true,manualRequired:true});
        console.log(`STOP ${market}: creation response unknown and config absent; intent remains latched until an applied grid or authoritative rejection is confirmed`);
        return {done:false};
      }
      // grid gone from config — cleanup may still be needed if residue exists.
      // A malformed position response is UNKNOWN, not flat: keep the intent, retry later.
      const pos = await io.jget(`/api/v1/position`);
      if (!positionListOk(pos)) {
        updatePending(reason + " (position response malformed)");
        await io.savePending(pending);
        results.push({ act: "stop", market, done: false, unconfirmed: true });
        console.log(`STOP ${market}: position response malformed — cannot confirm flat; intent kept, retry next round`);
        return { done: false };
      }
      const p = pos.find((x) => x.symbol === symbol);
      if (p) {
        const raw = p.netQuantity;
        // 平仓判定只接受明确的数值 0：先限类型（拒绝 null/布尔/对象/数组），再限数值
        const nqKnown = finiteNumber(raw);
        const nq = nqKnown ? Number(raw) : NaN;
        if (!nqKnown) {
          updatePending(reason + " (netQuantity unreadable)");
          await io.savePending(pending);
          results.push({ act: "stop", market, done: false, unconfirmed: true });
          console.log(`STOP ${market}: netQuantity unreadable — treated as unknown, intent kept, retry next round`);
          return { done: false };
        }
        if (nq !== 0) throw new Error(`stop ${market}: grid gone but position ${nq} remains — manual intervention`);
      }
      delete pending[market];
      await io.savePending(pending);
      results.push({ act: "stop", market, done: true, note: "already deleted" });
      return { done: true };
    }
    // 1) ensure disabled with close-positions-on-stop
    const beforeDisable = isTrail ? async () => {
      const wasPrepared = pending[market]?.trailPhase === 'prepared';
      const knownUnsent = hasDurablePreparedTrail(pending[market]);
      if (wasPrepared) { pending[market].trailPhase = 'issued'; await io.savePending(pending, {durable:true}); }
      try {
        const current = await trailState();
        if (current === 'unknown' || current === 'changed' || (current === 'flat' && wasPrepared))
          throw new Error('trail position changed or unavailable before disable');
      } catch (e) {
        // This callback has not returned to jpatch, so no exchange request was
        // sent by this attempt; keep a prepared intent if that state can be saved.
        if (wasPrepared && knownUnsent) { pending[market].trailPhase = 'prepared'; await io.savePending(pending, {durable:true}); }
        throw e;
      }
    } : undefined;
    const r1 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
      active: true,
      params: { strategyType: "Grid", symbols: [{ ...entry, enabled: false, closePositionsOnStop: true, operation: "Upsert" }] },
    }, beforeDisable);
    if (r1.status !== 200) throw new Error(`stop ${market}: disable failed ${r1.status} ${r1.body}`);
    // 2) wait for the bot position to close — HARD GATE. Polling errors count as
    //    "unconfirmed" (pending intent is already persisted; retry happens next round)
    let posGone = false;
    try {
      posGone = await io.waitFor(async () => {
        const pos = await io.jget(`/api/v1/position`);
        if (!positionListOk(pos)) return false; // malformed = unknown, never "flat"
        const p = pos.find((x) => x.symbol === symbol);
        if (!p) return true; // 条目消失 = 无持仓
        const raw = p.netQuantity;
        const typeOk = finiteNumber(raw);
        if (!typeOk) return false; // 未知 ≠ 已平仓
        const nq = Number(raw);
        return nq === 0;
      }, 20000);
    } catch { posGone = false; }
    if (!posGone) {
      updatePending(reason);
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, timedOut: true });
      console.log(`STOP ${market}: position still open after timeout — persisted to pending_stops.json, will retry next round (no delete/create this round)`);
      return { done: false };
    }
    // 3) flat -> delete the grid entry, retry once if the PATCH itself fails
    const beforeDelete = isTrail ? async () => {
      if (await trailState() !== 'flat') throw new Error('trail position is not flat before delete');
    } : undefined;
    let r2 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
      params: { strategyType: "Grid", symbols: [{ operation: "Delete", symbol }] },
    }, beforeDelete);
    if (r2.status !== 200) {
      await io.sleep(2000);
      r2 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
        params: { strategyType: "Grid", symbols: [{ operation: "Delete", symbol }] },
      }, beforeDelete);
    }
    if (r2.status !== 200) {
      updatePending(reason + " (delete failed)");
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, deleteFailed: true });
      console.log(`STOP ${market}: position flat but delete failed ${r2.status} — persisted, retry next round`);
      return { done: false };
    }
    const gone = await io.waitFor(async () => {
      const auto2 = await io.getAutomation();
      return Array.isArray(auto2.params?.symbols) && !auto2.params.symbols.some((s) => s.symbol === symbol);
    }, 10000);
    if (!gone) {
      updatePending(reason + " (delete unconfirmed)");
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, deleteUnconfirmed: true });
      console.log(`STOP ${market}: delete accepted but not confirmed — persisted, retry next round`);
      return { done: false };
    }
    const finalPositions = await io.jget(`/api/v1/position`);
    const finalPos = Array.isArray(finalPositions) ? finalPositions.find((p) => p.symbol === symbol) : null;
    if (!positionListOk(finalPositions) || (finalPos && (!finiteNumber(finalPos.netQuantity) || Number(finalPos.netQuantity) !== 0))) {
      results.push({ act: "stop", market, done: false, unconfirmed: true });
      return { done: false }; // config disappeared, but final flatness must still be known
    }
    if (unknownCreate) {
      const { trailPositionRef, trailPhase, trailIntentVersion, ...create } = pending[market];
      pending[market] = { ...create, riskStop:{ at:new Date().toISOString(), reason, status:'completed',
        ...(isTrail ? { trailPositionRef:trailRef } : {}) } };
    } else delete pending[market];
    await io.savePending(pending);
    results.push({ act: "stop", market, reason, done: true,
      ...(unknownCreate ? { note:'risk exit completed; create outcome remains unknown' } : {}) });
    console.log(`STOPPED ${market} — ${reason}`);
    return { done: true };
  };
}

// create gate: unified veto policy. flags: {stopIncomplete, protectIncomplete,
// unresolvedCleanup}; pendingKeys: live ledger market names; corruptFlag: persistent
// corrupt-ledger flag file presence (decide/act block new risk while it exists).
function evaluateCreateGate(flags, pendingKeys, corruptFlag) {
  if (flags.riskChanged) return { blocked:true,why:"live risk changed; reobserve and replan" };
  if (flags.stopIncomplete) return { blocked: true, why: "unresolved stop" };
  if (flags.unresolvedCleanup) return { blocked: true, why: "unresolved emergency cleanup" };
  if (flags.protectIncomplete) return { blocked: true, why: "unresolved protect repair (budget premise unverified)" };
  if (corruptFlag) return { blocked: true, why: "corrupt pending ledger flag present" };
  if (pendingKeys.length > 0) return { blocked: true, why: `pending ledger not empty (${pendingKeys.join(", ")})` };
  return { blocked: false, why: null };
}

module.exports = { pendingStructOk, makeStopGrid, evaluateCreateGate };
