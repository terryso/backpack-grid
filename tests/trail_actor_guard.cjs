'use strict';
// Production stop core with mocked identity checks, pending state and exchange I/O.
const assert = require('node:assert/strict');
const { makeStopGrid } = require('../scripts/act_core.cjs');
const A = 'a'.repeat(64), B = 'b'.repeat(64), market = 'TEST-PERP';
const known = ref => ({ state: 'known', ref });
const flat = { state: 'flat' }, unknown = { state: 'unknown' };
const reason = 'AUTO_TRAIL: fixture';

function fixture({ refs = [], initialPending = {}, gridPresent = true } = {}) {
  let pending = structuredClone(initialPending), grid = gridPresent, positionFlat = false, index = 0;
  let patches = [], saves = 0, guardCalls = 0;
  const io = {
    assertAccount: async () => {},
    loadPending: async () => ({ pending: structuredClone(pending), corrupt: false }),
    savePending: async value => { saves++; pending = structuredClone(value); },
    getTrailPositionRef: async () => { guardCalls++; return refs[Math.min(index++, refs.length - 1)] || unknown; },
    getAutomation: async () => ({ params: { symbols: grid ? [{ symbol: 'TEST_USDC_PERP', enabled: true }] : [] } }),
    jget: async () => positionFlat ? [] : [{ symbol: 'TEST_USDC_PERP', netQuantity: '1' }],
    jpatch: async (_path, body, beforeSend) => {
      if (beforeSend) await beforeSend();
      const operation = body.params.symbols[0].operation; patches.push(operation);
      if (operation === 'Upsert') positionFlat = true;
      if (operation === 'Delete') grid = false;
      return { status: 200, body: '{}' };
    },
    waitFor: async fn => Boolean(await fn()), sleep: async () => {},
  };
  return { stop: makeStopGrid(io), read: () => ({ pending: structuredClone(pending), patches: [...patches], saves, guardCalls }) };
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
(async () => {
  await check('matching trail position can stop and clear its pending intent', async () => {
    const f = fixture({ refs: [known(A), known(A), flat] }), results = [];
    const r = await f.stop(market, [90, 110], reason, results, { trailPositionRef: A });
    assert.equal(r.done, true); assert.deepEqual(f.read().patches, ['Upsert', 'Delete']);
    assert.deepEqual(f.read().pending, {}); assert(f.read().guardCalls >= 3);
  });
  await check('a different live position is refused before writing an intent', async () => {
    const f = fixture({ refs: [known(B)] });
    await assert.rejects(f.stop(market, null, reason, [], { trailPositionRef: A }), /trail position/i);
    assert.equal(f.read().saves, 0); assert.deepEqual(f.read().patches, []); assert.deepEqual(f.read().pending, {});
  });
  await check('unknown live position identity is refused before writing an intent', async () => {
    const f = fixture({ refs: [unknown] });
    await assert.rejects(f.stop(market, null, reason, [], { trailPositionRef: A }), /trail position/i);
    assert.equal(f.read().saves, 0); assert.deepEqual(f.read().patches, []);
  });
  await check('a replacement before the disable request leaves guarded pending state and sends no patch', async () => {
    const f = fixture({ refs: [known(A), known(B)] });
    await assert.rejects(f.stop(market, null, reason, [], { trailPositionRef: A }), /trail position/i);
    assert.deepEqual(f.read().patches, []); assert.equal(f.read().pending[market].trailPositionRef, A);
    assert.equal(f.read().pending[market].trailPhase, 'prepared');
  });
  await check('an issued trailing stop never retries against a different position', async () => {
    const f = fixture({ refs: [known(B)], initialPending: { [market]: { reason, trailPositionRef: A, trailPhase: 'issued' } } });
    await assert.rejects(f.stop(market, null, 'pending stop retry (' + reason + ')', [], { trailPositionRef: A }), /trail position/i);
    assert.deepEqual(f.read().patches, []); assert.equal(f.read().pending[market].trailPositionRef, A);
  });
  await check('a prepared trailing intent is cleared without a patch if the position is already flat', async () => {
    const f = fixture({ refs: [flat], initialPending: { [market]: { reason, trailPositionRef: A, trailPhase: 'prepared' } } });
    const result = await f.stop(market, null, 'pending stop retry (' + reason + ')', [], { trailPositionRef: A });
    assert.equal(result.skipped, true); assert.deepEqual(f.read().patches, []); assert.deepEqual(f.read().pending, {});
  });
  await check('a prepared trailing intent is cleared without a patch for a replacement position', async () => {
    const f = fixture({ refs: [known(B)], initialPending: { [market]: { reason, trailPositionRef: A, trailPhase: 'prepared' } } });
    const result = await f.stop(market, null, 'pending stop retry (' + reason + ')', [], { trailPositionRef: A });
    assert.equal(result.skipped, true); assert.deepEqual(f.read().patches, []); assert.deepEqual(f.read().pending, {});
  });
  await check('an issued trailing stop can complete cleanup after the original position is flat', async () => {
    const f = fixture({ refs: [flat, flat, flat], initialPending: { [market]: { reason, trailPositionRef: A, trailPhase: 'issued' } } });
    const result = await f.stop(market, null, 'pending stop retry (' + reason + ')', [], { trailPositionRef: A });
    assert.equal(result.done, true); assert.deepEqual(f.read().patches, ['Upsert', 'Delete']); assert.deepEqual(f.read().pending, {});
  });
  await check('a new position appearing before deletion blocks deletion and retains pending state', async () => {
    const f = fixture({ refs: [known(A), known(A), known(B)] });
    await assert.rejects(f.stop(market, null, reason, [], { trailPositionRef: A }), /trail position/i);
    assert.deepEqual(f.read().patches, ['Upsert']); assert.equal(f.read().pending[market].trailPositionRef, A);
  });
  await check('legacy trailing pending without an identity is not executed blindly', async () => {
    const f = fixture({ initialPending: { [market]: { reason } } });
    await assert.rejects(f.stop(market, null, 'pending stop retry (' + reason + ')', []), /trail position/i);
    assert.deepEqual(f.read().patches, []); assert(f.read().pending[market]);
  });
  await check('an independent circuit breaker is not blocked by a stale trailing identity', async () => {
    const f = fixture({ initialPending: { [market]: { reason, trailPositionRef: A, trailPhase: 'issued' } } });
    const result = await f.stop(market, null, 'circuit breaker: account drawdown beyond budget', []);
    assert.equal(result.done, true); assert.deepEqual(f.read().patches, ['Upsert', 'Delete']); assert.equal(f.read().guardCalls, 0);
  });
  await check('an issued trailing risk stop completes while retaining an unknown create outcome', async () => {
    const pending = { kind:'create',phase:'issued',accountKey:'fixture-3',reason:'create outcome unknown',
      trailPositionRef:A,trailPhase:'issued',riskStop:{status:'pending',reason,at:new Date().toISOString()} };
    const f = fixture({ refs:[flat,flat,flat], initialPending:{[market]:pending} });
    const result = await f.stop(market,null,'pending risk stop retry ('+reason+')',[],{trailPositionRef:A,independentRisk:true});
    assert.equal(result.done,true);assert.deepEqual(f.read().patches,['Upsert','Delete']);
    assert.equal(f.read().pending[market].phase,'issued');assert.equal(f.read().pending[market].riskStop.status,'completed');
    assert.equal(f.read().pending[market].trailPositionRef,undefined);
  });
  await check('a cancelled prepared trail keeps unknown create but releases its old position binding', async () => {
    const pending = { kind:'create',phase:'issued',accountKey:'fixture-3',reason:'create outcome unknown',
      trailPositionRef:A,trailPhase:'prepared',riskStop:{status:'pending',reason,at:new Date().toISOString()} };
    const f = fixture({ refs:[known(B),known(B),known(B),flat], initialPending:{[market]:pending} });
    const first=await f.stop(market,null,'pending risk stop retry ('+reason+')',[],{trailPositionRef:A,independentRisk:true});
    assert.equal(first.skipped,true);assert.deepEqual(f.read().patches,[]);
    assert.equal(f.read().pending[market].riskStop.status,'cancelled');assert.equal(f.read().pending[market].trailPositionRef,undefined);
    const second=await f.stop(market,null,reason,[],{trailPositionRef:B,independentRisk:true});
    assert.equal(second.done,true);assert.deepEqual(f.read().patches,['Upsert','Delete']);
    assert.equal(f.read().pending[market].phase,'issued');assert.equal(f.read().pending[market].riskStop.status,'completed');
    assert.equal(f.read().pending[market].trailPositionRef,undefined);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
