// act_core.cjs — production control flow for grid stop/create gating, with injected I/O
// so the REAL logic can be executed under Node with mocked exchange access (regression
// suite). act.mjs wires the live io (page.fetch based) into makeStopGrid().
"use strict";

// Shared pending-ledger structure rule with decide.cjs (canary string must stay aligned:
// "invalid pending ledger structure").
function pendingStructOk(parsed) {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.values(parsed).every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
}

// io: {
//   jget(pathname), jpatch(pathname, body),      — session-authenticated exchange access
//   getAutomation(),                             — GET automation config
//   sleep(ms), waitFor(cond, ms),                — timing
//   loadPending(), savePending(pending),         — pending ledger (corrupt handling in wrapper)
// }
function makeStopGrid(io) {
  return async function stopGrid(market, range, reason, results) {
    const symbol = String(market).replace("-PERP", "_USDC_PERP");
    const loaded = await io.loadPending();
    const pending = loaded.pending;
    // WRITE-AHEAD: persist the stop intent BEFORE any exchange write, so a lost response
    // can never leave the grid stopped on-exchange with an empty pending ledger
    if (!pending[market]) {
      pending[market] = { at: new Date().toISOString(), reason };
      await io.savePending(pending);
    }
    const auto1 = await io.getAutomation();
    const entry = (auto1.params?.symbols || []).find((s) => s.symbol === symbol);
    if (!entry) {
      // grid gone from config — cleanup may still be needed if residue exists.
      // A malformed position response is UNKNOWN, not flat: keep the intent, retry later.
      const pos = await io.jget(`/api/v1/position`);
      if (!Array.isArray(pos)) {
        pending[market] = { at: new Date().toISOString(), reason: reason + " (position response malformed)" };
        await io.savePending(pending);
        results.push({ act: "stop", market, done: false, unconfirmed: true });
        console.log(`STOP ${market}: position response malformed — cannot confirm flat; intent kept, retry next round`);
        return { done: false };
      }
      const p = pos.find((x) => x.symbol === symbol);
      if (p) {
        const nq = Number(p.netQuantity);
        // 平仓判定只接受明确的数值 0：null/缺失/非有限值 = 未知，不得当作已平仓
        if (!Number.isFinite(nq)) {
          pending[market] = { at: new Date().toISOString(), reason: reason + " (netQuantity unreadable)" };
          await io.savePending(pending);
          results.push({ act: "stop", market, done: false, unconfirmed: true });
          console.log(`STOP ${market}: netQuantity unreadable — treated as unknown, intent kept, retry next round`);
          return { done: false };
        }
        if (nq !== 0) throw new Error(`stop ${market}: grid gone but position ${nq} remains — manual intervention`);
      }
      delete pending[market];
      delete pending[market];
      await io.savePending(pending);
      results.push({ act: "stop", market, done: true, note: "already deleted" });
      return { done: true };
    }
    // 1) ensure disabled with close-positions-on-stop
    const r1 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
      active: true,
      params: { strategyType: "Grid", symbols: [{ ...entry, enabled: false, closePositionsOnStop: true, operation: "Upsert" }] },
    });
    if (r1.status !== 200) throw new Error(`stop ${market}: disable failed ${r1.status} ${r1.body}`);
    // 2) wait for the bot position to close — HARD GATE. Polling errors count as
    //    "unconfirmed" (pending intent is already persisted; retry happens next round)
    let posGone = false;
    try {
      posGone = await io.waitFor(async () => {
        const pos = await io.jget(`/api/v1/position`);
        if (!Array.isArray(pos)) return false; // malformed = unknown, never "flat"
        const p = pos.find((x) => x.symbol === symbol);
        if (!p) return true; // 条目消失 = 无持仓
        const nq = Number(p.netQuantity);
        return Number.isFinite(nq) && nq === 0; // null/缺失/非有限 = 未知，不得视为已平仓
      }, 20000);
    } catch { posGone = false; }
    if (!posGone) {
      pending[market] = { at: new Date().toISOString(), reason };
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, timedOut: true });
      console.log(`STOP ${market}: position still open after timeout — persisted to pending_stops.json, will retry next round (no delete/create this round)`);
      return { done: false };
    }
    // 3) flat -> delete the grid entry, retry once if the PATCH itself fails
    let r2 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
      params: { strategyType: "Grid", symbols: [{ operation: "Delete", symbol }] },
    });
    if (r2.status !== 200) {
      await io.sleep(2000);
      r2 = await io.jpatch(`/wapi/v1/subaccount/automation`, {
        params: { strategyType: "Grid", symbols: [{ operation: "Delete", symbol }] },
      });
    }
    if (r2.status !== 200) {
      pending[market] = { at: new Date().toISOString(), reason: reason + " (delete failed)" };
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, deleteFailed: true });
      console.log(`STOP ${market}: position flat but delete failed ${r2.status} — persisted, retry next round`);
      return { done: false };
    }
    const gone = await io.waitFor(async () => {
      const auto2 = await io.getAutomation();
      return !(auto2.params?.symbols || []).some((s) => s.symbol === symbol);
    }, 10000);
    if (!gone) {
      pending[market] = { at: new Date().toISOString(), reason: reason + " (delete unconfirmed)" };
      await io.savePending(pending);
      results.push({ act: "stop", market, done: false, deleteUnconfirmed: true });
      console.log(`STOP ${market}: delete accepted but not confirmed — persisted, retry next round`);
      return { done: false };
    }
    delete pending[market];
    await io.savePending(pending);
    results.push({ act: "stop", market, done: true });
    console.log(`STOPPED ${market} — ${reason}`);
    return { done: true };
  };
}

// create gate: unified veto policy. flags: {stopIncomplete, protectIncomplete,
// unresolvedCleanup}; pendingKeys: live ledger market names; corruptFlag: persistent
// corrupt-ledger flag file presence (decide/act block new risk while it exists).
function evaluateCreateGate(flags, pendingKeys, corruptFlag) {
  if (flags.stopIncomplete) return { blocked: true, why: "unresolved stop" };
  if (flags.unresolvedCleanup) return { blocked: true, why: "unresolved emergency cleanup" };
  if (flags.protectIncomplete) return { blocked: true, why: "unresolved protect repair (budget premise unverified)" };
  if (corruptFlag) return { blocked: true, why: "corrupt pending ledger flag present" };
  if (pendingKeys.length > 0) return { blocked: true, why: `pending ledger not empty (${pendingKeys.join(", ")})` };
  return { blocked: false, why: null };
}

module.exports = { pendingStructOk, makeStopGrid, evaluateCreateGate };
