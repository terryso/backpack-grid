'use strict';
const { plainObject, finiteNumber } = require('./state_schema.cjs');
const { isPositionRef } = require('./position_ref.cjs');
const { trailStateOk } = require('./trail_state_schema.cjs');

// Public status contains no position references. Reuse the executor's exact
// state and reference validators so unknown identity is never shown as ready.
function trailStatus({ cfg, obs, identity, snapshotValid, manualHolds, manualValid, pending, pendingValid, state, stateExists }) {
  const enabled = cfg?.autoExitsEnabled === true && finiteNumber(cfg.trailArmPct) && Number(cfg.trailArmPct) > 0
    && finiteNumber(cfg.trailGivebackPct) && Number(cfg.trailGivebackPct) > 0;
  if (!enabled) return { enabled: false, ready: null, reason: null };
  const notReady = reason => ({ enabled: true, ready: false, reason });
  if (!snapshotValid || !plainObject(identity) || !Array.isArray(obs?.positions) || !Array.isArray(obs?.gridRows)) return notReady('snapshot');
  if (!manualValid || !pendingValid || !Array.isArray(manualHolds) || !plainObject(pending)) return notReady('control_state');
  if (stateExists && !trailStateOk(state, identity.accountKey)) return notReady('peak_state');
  const markets = stateExists ? state.markets : {};
  if (Object.values(markets).some(entry => entry.unboundLegacyPeak || (finiteNumber(entry.peak) && !isPositionRef(entry.positionRef))))
    return notReady('legacy_peak');
  const refs = plainObject(obs.positionRefs) ? obs.positionRefs : {};
  for (const pos of obs.positions) {
    if (!plainObject(pos) || typeof pos.market !== 'string' || !pos.market) return notReady('snapshot');
    if (finiteNumber(pos.size) && Number(pos.size) === 0) continue;
    const grid = obs.gridRows.find(g => g && g.market === pos.market);
    if (!grid || grid.status === 'Disabled' || manualHolds.includes('*') || manualHolds.includes(pos.market) || pending[pos.market]) continue;
    if (!isPositionRef(refs[pos.market])) return notReady('position_identity');
    const entry = markets[pos.market];
    if (entry && isPositionRef(entry.positionRef) && entry.positionRef !== refs[pos.market]) return notReady('position_changed');
  }
  return { enabled: true, ready: true, reason: null };
}
module.exports = { trailStatus };
