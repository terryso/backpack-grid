'use strict';
const assert = require('node:assert/strict');
const { positionRef } = require('../scripts/position_ref.cjs');
const owner = { accountKey: 'fixture-account' };
const position = { symbol: 'TEST_USDC_PERP', positionId: '42', netQuantity: '1.5', markPrice: '100' };
const ref = positionRef(owner, position);
assert.match(ref, /^[a-f0-9]{64}$/);
assert.equal(positionRef(owner, { ...position, netQuantity: '2', markPrice: '110' }), ref);
assert.notEqual(positionRef(owner, { ...position, positionId: '43' }), ref);
assert.notEqual(positionRef(owner, { ...position, symbol: 'OTHER_USDC_PERP' }), ref);
assert.notEqual(positionRef({ accountKey: 'other-account' }, position), ref);
assert.notEqual(positionRef(owner, { ...position, netQuantity: '-1' }), ref);
for (const bad of [undefined, null, '', '  ', false, [], {}, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
  assert.equal(positionRef(owner, { ...position, positionId: bad }), null);
}
for (const bad of [undefined, null, '', false, [], {}, 0, '0', Infinity]) {
  assert.equal(positionRef(owner, { ...position, netQuantity: bad }), null);
}
assert.equal(positionRef({ accountKey: '' }, position), null);
assert.equal(positionRef(owner, { ...position, symbol: '' }), null);
console.log('PASS position reference binds account, market, position lifetime and side');
console.log('PASS position reference rejects missing or malformed identity and flat positions');
