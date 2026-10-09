'use strict';
// auto_exits.cjs — gated auto stop-loss / take-profit planner, called from decide.cjs
// when cfg.autoExitsEnabled is true. With the gate off, decide behaves exactly as before.
//
// Why this exists (2026-10-08 post-mortem): during the crash the per-grid rules missed
// every exit for three stacked reasons —
//   1. OUT_OF_RANGE needs tickers; getTickers() was failing (ECONNRESET) so the
//      price-based exit never ran. This module reads gridRows[].price and
//      positions[].mark straight from observed.json — no second network call.
//   2. The grid-level SL (pnl <= -stopLossPct of allocation) is masked by earlier
//      realized TP profits: the ZEC grid showed -4.4% while its live position was -170%.
//      Here the SL keys off positions[].pnlPct (exchange, margin-relative, funding incl.).
//   3. A single-round breach check misses sustained breakdowns when rounds are skipped
//      (OBSERVE_FAILED gaps). Breaches here accumulate dwell time across rounds and stop
//      once cfg.breachDwellMin is exceeded.
//
// Ordering per grid: AUTO_SL > AUTO_TP > AUTO_RANGE_EXIT; existing stop actions
// (breaker / pending retries / per-grid rules) always win — this module never duplicates.

const fs = require('node:fs');
const path = require('node:path');
const { plainObject, finiteNumber } = require('./state_schema.cjs');

function defaultsFor(cfg) {
  return {
    dwellMin: finiteNumber(cfg.breachDwellMin) ? Number(cfg.breachDwellMin) : 10,
    bufferPct: cfg.breachBufferPct === undefined ? 0.5 : Number(cfg.breachBufferPct),
    posSl: finiteNumber(cfg.positionStopLossPct) ? Number(cfg.positionStopLossPct) : 150,
    posTp: cfg.positionTakeProfitPct === undefined ? 150 : Number(cfg.positionTakeProfitPct),
  };
}

function loadDwellState(ROOT, identity, lines) {
  const file = path.join(ROOT, 'state', 'breach_dwell.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = plainObject(parsed) && parsed.accountKey === identity.accountKey && plainObject(parsed.markets);
    if (ok) return { file, accountKey: identity.accountKey, markets: parsed.markets, dirty: false };
    lines.push('AUTO EXITS dwell state invalid shape: starting fresh');
    return { file, accountKey: identity.accountKey, markets: {}, dirty: true };
  } catch (e) {
    if (e.code !== 'ENOENT') lines.push('AUTO EXITS dwell state unreadable: starting fresh');
    return { file, accountKey: identity.accountKey, markets: {}, dirty: fs.existsSync(file) };
  }
}

function saveDwellState(state) {
  try {
    const tmp = state.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ accountKey: state.accountKey, markets: state.markets }, null, 2));
    fs.renameSync(tmp, state.file);
  } catch (e) {
    throw new Error('dwell state write failed: ' + e.message);
  }
}

function planAutoExits({ ROOT, identity, cfg, obs, grids, pending, heldByUser, manualCorrupt, actions, lines }) {
  try {
    const d = defaultsFor(cfg);
    const nowMs = Date.parse(obs.at);
    if (!Number.isFinite(nowMs)) throw new Error('observed.at is not a timestamp');
    const state = loadDwellState(ROOT, identity, lines);
    let dirty = state.dirty;

    for (const g of Array.isArray(grids) ? grids : []) {
      if (pending[g.market] || heldByUser(g.market) || manualCorrupt) continue;
      // Manual-pause contract (mirrors the per-grid rule in decide.cjs): a Disabled grid
      // belongs to the user — never auto-stopped from here, whether it carries a
      // deep-water position or sits outside its range. Only pending-stop retries and
      // the account breaker may touch those.
      if (g.status === "Disabled") continue;
      if (actions.some((a) => a.market === g.market && a.act === 'stop')) continue;

      const pos = (obs.positions || []).find((pp) => pp.market === g.market);
      const pnlPct = pos && finiteNumber(pos.pnlPct) ? Number(pos.pnlPct) : NaN;

      // 1) position-level hard stop-loss — exchange margin-relative %, funding included
      if (Number.isFinite(pnlPct) && pnlPct <= -d.posSl) {
        actions.push({ act: 'stop', market: g.market, range: g.range,
          reason: `AUTO_SL: position pnl ${pnlPct.toFixed(1)}% <= -${d.posSl}%` });
        lines.push(`AUTO SL ${g.market}: position pnl ${pnlPct.toFixed(1)}% <= -${d.posSl}% — stop planned`);
        continue;
      }
      // 2) position-level take-profit (0 disables; realizes via the standard stop path)
      if (d.posTp > 0 && Number.isFinite(pnlPct) && pnlPct >= d.posTp) {
        actions.push({ act: 'stop', market: g.market, range: g.range,
          reason: `AUTO_TP: position pnl ${pnlPct.toFixed(1)}% >= ${d.posTp}%` });
        lines.push(`AUTO TP ${g.market}: position pnl ${pnlPct.toFixed(1)}% >= ${d.posTp}% — realize via stop`);
        continue;
      }
      // 3) dwell-tracked range breach — snapshot prices only, survives ticker outages
      const lo = Number(g.range?.[0]);
      const hi = Number(g.range?.[1]);
      let price = Number(g.price);
      if (!Number.isFinite(price) || price <= 0) price = pos && finiteNumber(pos.mark) ? Number(pos.mark) : NaN;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(price) || price <= 0) continue;

      const lowEdge = lo * (1 - d.bufferPct / 100);
      const highEdge = hi * (1 + d.bufferPct / 100);
      const side = price < lowEdge ? 'low' : price > highEdge ? 'high' : null;
      if (!side) {
        if (state.markets[g.market]) { delete state.markets[g.market]; dirty = true; } // recovered: reset timer
        continue;
      }
      const edge = side === 'low' ? lowEdge : highEdge;
      const prev = plainObject(state.markets[g.market]) && state.markets[g.market].side === side
        ? state.markets[g.market] : null;
      const sinceOk = !!prev && Number.isFinite(Date.parse(prev.since));
      const since = sinceOk ? prev.since : obs.at;
      // Rebuild AND persist: an unreadable timestamp must not restart the dwell clock
      // every round forever — that would never reach the stop threshold.
      if (!prev || !sinceOk) { state.markets[g.market] = { side, edge, since }; dirty = true; }
      const dwellMin = Math.max(0, nowMs - Date.parse(since)) / 60000; // clamp: clock skew never counts as dwell
      if (dwellMin >= d.dwellMin) {
        actions.push({ act: 'stop', market: g.market, range: g.range,
          reason: `AUTO_RANGE_EXIT: price ${price} beyond ${side} edge ${edge} for ${dwellMin.toFixed(0)}m >= ${d.dwellMin}m` });
        lines.push(`AUTO RANGE EXIT ${g.market}: price ${price} beyond ${side} edge ${edge} for ${dwellMin.toFixed(0)}m — stop planned`);
        delete state.markets[g.market]; // stop handed to act; no stale timer if act retries
        dirty = true;
      } else {
        lines.push(`AUTO DWELL ${g.market}: breach beyond ${side} edge for ${dwellMin.toFixed(1)}m (stop at ${d.dwellMin}m)`);
      }
    }

    // prune timers for markets no longer configured
    for (const k of Object.keys(state.markets)) {
      if (!grids.some((g) => g.market === k)) { delete state.markets[k]; dirty = true; }
    }
    if (dirty) saveDwellState(state);
  } catch (e) {
    lines.push(`AUTO EXITS failed: ${String(e.message).slice(0, 140)} — no auto actions this round`);
  }
}

module.exports = { planAutoExits, defaultsFor };
