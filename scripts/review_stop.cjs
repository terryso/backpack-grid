'use strict';
// Risk exit that supersedes a position-bound trailing stop. The old outcome is
// retained separately, and retries are bound to the new position where known.
const { hash } = require('./contracts.cjs');
const { finiteNumber, positionListOk } = require('./state_schema.cjs');
const { isPositionRef } = require('./position_ref.cjs');
const { isStopReview, isOrdinaryTrail, trailWasUnsent, validPendingRisk, previousOutcomeNeedsReview, riskAttemptOutcome } = require('./pending_stop.cjs');

function makeReviewStopGrid(io) {
  return async function reviewStopGrid(market, range, reason, results, options) {
    if (options.independentRisk !== true) throw Error('review stop requires an independent risk plan');
    if (io.assertAccount) await io.assertAccount();
    const symbol = String(market).replace('-PERP', '_USDC_PERP');
    const loaded = await io.loadPending(), pending = loaded.pending, prior = pending[market];
    if (loaded.corrupt || !prior || (!isStopReview(prior) && !isOrdinaryTrail(prior)) ||
        typeof options.expectedPendingHash !== 'string' || hash(prior) !== options.expectedPendingHash)
      throw Error('pending stop changed after planning');
    const history = isStopReview(prior)
      ? Array.isArray(prior.previousRiskStops) ? [...prior.previousRiskStops] : [{kind:'invalid',outcome:'unknown',entry:prior.previousRiskStops}]
      : [{kind:'trail',outcome:trailWasUnsent(prior) ? 'unsent' : 'unknown',entry:prior}];
    const priorRisk = isStopReview(prior) ? prior.riskStop : null;
    if (options.retryPendingRisk === true && (!isStopReview(prior) || !validPendingRisk(priorRisk) ||
        !isPositionRef(priorRisk.positionRef) || priorRisk.positionRef !== options.riskPositionRef))
      throw Error('pending risk retry identity changed');

    const positionsFlat = async () => {
      const rows = await io.jget('/api/v1/position');
      if (!positionListOk(rows)) return false;
      const pos = rows.find(p => p.symbol === symbol);
      return !pos || (finiteNumber(pos.netQuantity) && Number(pos.netQuantity) === 0);
    };
    const save = () => io.savePending(pending, {durable:true});
    const archivePriorRisk = () => {
      if (priorRisk != null && !(priorRisk.status === 'completed' && priorRisk.phase === 'completed')) {
        let outcome = riskAttemptOutcome(priorRisk);
        // An accepted disable may still be settling on the exchange. Its
        // effect is only reconciled automatically against the same position.
        if (outcome === 'acknowledged' && (options.verifyOnly === true || !isPositionRef(priorRisk.positionRef)
            || priorRisk.positionRef !== options.riskPositionRef)) outcome = 'unknown';
        history.push({kind:'risk',outcome,entry:priorRisk});
      }
    };
    const finish = async () => {
      const review = pending[market];
      review.riskStop = {...review.riskStop, status:'completed', phase:'completed', completedAt:new Date().toISOString()};
      const manualRequired = previousOutcomeNeedsReview(review);
      if (!manualRequired) delete pending[market];
      await save();
      results.push({act:'stop',market,reason,done:true,
        ...(manualRequired ? {manualRequired:true,unconfirmed:true,note:'risk exit verified; an earlier stop outcome still requires manual review'} : {})});
      return {done:true,manualRequired};
    };

    if (options.verifyOnly === true) {
      if (!isStopReview(prior) || !validPendingRisk(priorRisk)) throw Error('pending risk verification changed');
      const auto = await io.getAutomation();
      if (!Array.isArray(auto.params?.symbols)) throw Error('automation response malformed');
      if (auto.params.symbols.some(s => s.symbol === symbol) || !await positionsFlat()) {
        results.push({act:'stop',market,done:false,skipped:true,error:'grid or position present; verification made no exchange write'});
        return {done:false,skipped:true};
      }
      archivePriorRisk();
      pending[market] = {...prior,previousRiskStops:history,riskStop:{...priorRisk}};
      return finish();
    }

    const bound = isPositionRef(options.riskPositionRef);
    const positionState = async () => {
      if (!bound || typeof io.getTrailPositionRef !== 'function') return 'unknown';
      const current = await io.getTrailPositionRef(symbol);
      if (current?.state === 'flat') return 'flat';
      if (current?.state === 'known' && isPositionRef(current.ref)) return current.ref === options.riskPositionRef ? 'known' : 'changed';
      return 'unknown';
    };
    if (bound && await positionState() !== 'known') throw Error('risk position changed or unavailable before stop');
    if (options.retryPendingRisk === true && !bound) throw Error('unbound risk stop cannot be retried automatically');
    archivePriorRisk();
    pending[market] = {...(isStopReview(prior) ? prior : {}),kind:'stop_review',accountKey:prior.accountKey,at:new Date().toISOString(),
      reason:'earlier trailing stop requires verification',previousRiskStops:history,
      riskStop:{at:new Date().toISOString(),reason,status:'pending',phase:'prepared',
        ...(bound ? {positionRef:options.riskPositionRef} : {})}};
    await save();

    const auto = await io.getAutomation();
    if (!Array.isArray(auto.params?.symbols)) throw Error('automation response malformed; risk intent retained');
    const entry = auto.params.symbols.find(s => s.symbol === symbol);
    if (!entry) {
      results.push({act:'stop',market,done:false,unconfirmed:true,manualRequired:true,error:'grid absent; reobserve before verification'});
      return {done:false};
    }
    const beforeDisable = async () => {
      pending[market].riskStop.phase = 'disable-issued';
      await save();
      try { if (bound && await positionState() !== 'known') throw Error('risk position changed before disable'); }
      catch (error) { pending[market].riskStop.phase = 'prepared'; await save(); throw error; }
    };
    const disabled = await io.jpatch('/wapi/v1/subaccount/automation', {
      active:true,params:{strategyType:'Grid',symbols:[{...entry,enabled:false,closePositionsOnStop:true,operation:'Upsert'}]},
    }, beforeDisable);
    if (disabled.status !== 200) throw Error(`stop ${market}: disable failed ${disabled.status}`);
    pending[market].riskStop.phase = 'disable-acknowledged';
    await save();
    let flat = false;
    try { flat = await io.waitFor(positionsFlat, 20000); } catch {}
    if (!flat) {
      results.push({act:'stop',market,done:false,timedOut:true});
      return {done:false};
    }
    const beforeDelete = async () => {
      if (!await positionsFlat() || (bound && await positionState() !== 'flat')) throw Error('position not flat before delete');
      pending[market].riskStop.phase = 'delete-issued';
      await save();
      try {
        if (!await positionsFlat() || (bound && await positionState() !== 'flat')) throw Error('position changed before delete');
      } catch (error) { pending[market].riskStop.phase = 'disable-acknowledged'; await save(); throw error; }
    };
    const deleted = await io.jpatch('/wapi/v1/subaccount/automation', {
      params:{strategyType:'Grid',symbols:[{operation:'Delete',symbol}]},
    }, beforeDelete);
    if (deleted.status !== 200) throw Error(`stop ${market}: delete failed ${deleted.status}`);
    const gone = await io.waitFor(async () => {
      const next = await io.getAutomation();
      return Array.isArray(next.params?.symbols) && !next.params.symbols.some(s => s.symbol === symbol);
    }, 10000);
    if (!gone || !await positionsFlat()) {
      results.push({act:'stop',market,done:false,unconfirmed:true});
      return {done:false};
    }
    return finish();
  };
}
module.exports = {makeReviewStopGrid};
