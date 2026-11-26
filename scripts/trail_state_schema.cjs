'use strict';
const { plainObject, finiteNumber } = require('./state_schema.cjs');
const { isPositionRef } = require('./position_ref.cjs');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function trailEntryOk(entry) {
  if (!plainObject(entry)) return false;
  const hasRef = own(entry, 'positionRef'), hasPeak = own(entry, 'peak'), hasLegacy = own(entry, 'unboundLegacyPeak');
  if (hasRef && !isPositionRef(entry.positionRef)) return false;
  if (hasPeak && (!finiteNumber(entry.peak) || Number(entry.peak) <= 0 || !validTime(entry.since))) return false;
  if (hasLegacy) {
    const old = entry.unboundLegacyPeak;
    if (!plainObject(old) || !finiteNumber(old.peak) || Number(old.peak) <= 0 || !(old.since === null || validTime(old.since))) return false;
  }
  return hasPeak || (hasRef && hasLegacy);
}
function trailStateOk(state, accountKey) {
  return plainObject(state) && state.accountKey === accountKey && plainObject(state.markets)
    && Object.values(state.markets).every(trailEntryOk);
}
module.exports = { trailEntryOk, trailStateOk };
