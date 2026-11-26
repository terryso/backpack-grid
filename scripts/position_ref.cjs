'use strict';
const { createHash } = require('node:crypto');
const { finiteNumber, plainObject } = require('./state_schema.cjs');

// Keep exchange position IDs out of observed/public payloads. A reference is
// account-bound and changes when the exchange position or exposure side changes.
const isPositionRef = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function positionRef(identity, position) {
  if (!plainObject(identity) || typeof identity.accountKey !== 'string' || !identity.accountKey.trim()
      || !plainObject(position) || typeof position.symbol !== 'string' || !position.symbol.trim()
      || !finiteNumber(position.netQuantity) || Number(position.netQuantity) === 0) return null;
  const raw = position.positionId;
  const id = typeof raw === 'string' && raw.trim() && raw.trim().length <= 256 ? raw.trim()
    : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null;
  if (id === null) return null;
  const side = Number(position.netQuantity) > 0 ? 'long' : 'short';
  return createHash('sha256').update(JSON.stringify(['trail-position-v1', identity.accountKey, position.symbol, id, side])).digest('hex');
}

module.exports = { positionRef, isPositionRef };
