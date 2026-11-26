// act_core.cjs — production control flow for grid stop/create gating, with injected I/O
// so the REAL logic can be executed under Node with mocked exchange access (regression
// suite). act.mjs wires the live io (page.fetch based) into makeStopGrid().
"use strict";

const { pendingStructOk, finiteNumber, plainObject, positionListOk } = require("./state_schema.cjs");
const { isPositionRef } = require("./position_ref.cjs");

// io: {
//   jget(pathname), jpatch(pathname, body),      — session-authenticated exchange access
//   getAutomation(),                             — GET automation config
//   sleep(ms), waitFor(cond, ms),                — timing
//   loadPending(), savePending(pending),         — pending ledger (corrupt handling in wrapper)
// }
function makeStopGrid(io) {
  return async function stopGrid(market, range, reason, results, options = {}) {
    if(io.assertAccount) await io.assertAccount();
    const symbol = String(market).replace("-PERP", "_USDC_PERP");
    const loaded = await io.loadPending();
    const pending = loaded.pending;
    const existing = pending[market];
    const isTrail = Object.prototype.hasOwnProperty.call(options, 'trailPositionRef') || /AUTO_TRAIL/.test(String(reason || ''));
    let trailRef = null;
    if (isTrail) {
      const requested = options.trailPositionRef;
      const stored = existing?.trailPositionRef;
      if ((requested != null && !isPositionRef(requested)) || (stored != null && !isPositionRef(stored))
          || (requested && stored && requested !== stored)) throw new Error('trail position identity invalid');
      trailRef = requested || stored;
      if (!isPositionRef(trailRef) || typeof io.getTrailPositionRef !== 'function') throw new Error('trail position identity unavailable');
      if (existing?.trailPhase != null && !['prepared', 'issued'].includes(existing.trailPhase)) throw new Error('trail position phase invalid');
    }
    const trailState = async () => {
      const current = await io.getTrailPositionRef(symbol);
      if (current?.state === 'flat') return 'flat';
      if (current?.state === 'known' && isPositionRef(current.ref)) return current.ref === trailRef ? 'known' : 'changed';
      return 'unknown';
    };
    const skipPrepared = async message => {
      if (pending[market]) { delete pending[market]; await io.savePending(pending); }
      results.push({ act: 'stop', market, done: false, skipped: true, error: message });
      return { done: false, skipped: true };
    };
    if (isTrail) {
      const current = await trailState();
      if (current === 'unknown') throw new Error('trail position identity unavailable');
      if ((current === 'flat' || current === 'changed') && existing?.trailPhase === 'prepared')
        return await skipPrepared('trailing position changed before any exchange request');
      if (current === 'flat' && !existing) return await skipPrepared('trailing position already flat');
      if (current === 'changed') throw new Error('trail position identity changed');
    }
    // WRITE-AHEAD: persist the stop intent BEFORE any exchange write, so a lost response
    // can never leave the grid stopped on-exchange with an empty pending ledger
    if (!pending[market]) {
      pending[market] = { at: new Date().toISOString(), reason,
        ...(isTrail ? { trailPositionRef: trailRef, trailPhase: 'prepared' } : {}) };
      await io.savePending(pending);
    }
    const updatePending = nextReason => {
      const prior = pending[market] || {};
      pending[market] = { at: new Date().toISOString(), reason: nextReason,
        ...(isPositionRef(prior.trailPositionRef) ? { trailPositionRef: prior.trailPositionRef, trailPhase: prior.trailPhase || 'issued' } : {}) };
    };
    const auto1 = await io.getAutomation();
    if (!Array.isArray(auto1.params?.symbols)) throw new Error("automation response malformed; intent retained");
    const entry = auto1.params.symbols.find((s) => s.symbol === symbol);
    if (!entry) {
      if(pending[market]?.kind==="create" && pending[market]?.phase==="issued") {
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
      if (wasPrepared) { pending[market].trailPhase = 'issued'; await io.savePending(pending); }
      try {
        const current = await trailState();
        if (current === 'unknown' || current === 'changed' || (current === 'flat' && wasPrepared))
          throw new Error('trail position changed or unavailable before disable');
      } catch (e) {
        // This callback has not returned to jpatch, so no exchange request was
        // sent by this attempt; keep a prepared intent if that state can be saved.
        if (wasPrepared) { pending[market].trailPhase = 'prepared'; await io.savePending(pending); }
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
    delete pending[market];
    await io.savePending(pending);
    results.push({ act: "stop", market, reason, done: true });
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
