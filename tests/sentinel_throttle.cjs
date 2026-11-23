'use strict';
// Execute the actual Worker entrypoints with fake KV, clock and network only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../cloudflare/worker.js'), 'utf8')
  .replace(/^export \{.*$/gm, '').replace(/^import .*$/gm, '')
  .replace('export default {', 'const worker = {') + '\nglobalThis.worker = worker; globalThis.runSentinel = runSentinel;';
const initial = Date.parse('2026-11-22T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
  let now = initial, saved = clone(overrides.state ?? {
    monitoringStatus: 'healthy', activeTriggers: [], lastRunAt: iso(initial), lastPersistedAt: iso(initial),
    lastDetail: { liveMarks: true }, lastPushed: [],
  });
  let latest = overrides.latest === undefined ? { updatedAt: iso(initial), positions: [{ symbol: 'BTC_USDC_PERP' }] } : overrides.latest;
  let triggers = [], markPrice = 100, marketFails = false, marketEmpty = false, barkMode = 'ok', failPut = false, failStateRead = false, failLatestRead = false, failEvaluation = false, invalidEvaluation = false, evaluations = 0, marketRequests = 0, barkRequests = 0;
  const writes = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const patterns = {
    SENTINEL: { COOLDOWN_MS: 60 * 60000, BLIND_MIN: 30 },
    evaluate(_latest, marks) { evaluations++; if (failEvaluation) throw Error('fixture evaluation failed'); if (invalidEvaluation) return { triggers: null, detail: {} }; return overrides.realPatterns ? require('../cloudflare/patterns.js').evaluate(_latest, marks, now) : { triggers: clone(triggers), detail: { liveMarks: Boolean(marks), fixture: true } }; },
  };
  const env = {
    DASH_WRITE_TOKEN: 'fixture-only', BARK_KEY: 'fixture-only',
    DASH: {
      async get(key) { if (key === 'sentinel_state') { if (failStateRead) throw Error('fixture state read failed'); return JSON.stringify(saved); } if (key === 'latest') { if (failLatestRead) throw Error('fixture snapshot read failed'); return JSON.stringify(latest); } throw Error('unexpected key'); },
      async put(key, value) { assert.equal(key, 'sentinel_state'); if (failPut) throw Error('fixture KV write failed'); saved = JSON.parse(value); writes.push(clone(saved)); },
    },
  };
  const fetch = async url => {
    if (String(url).includes('/markPrices')) { marketRequests++; if (marketFails) throw Error('fixture market failed'); return { ok: true, json: async () => marketEmpty ? [] : [{ symbol: 'BTC_USDC_PERP', markPrice: String(markPrice) }] }; }
    if (String(url).includes('api.day.app')) { barkRequests++; if (barkMode === 'throw' || barkMode === 'second-throw' && barkRequests === 2) throw Error('fixture push failed'); return { status: barkMode === 'error' ? 503 : 200, text: async () => 'fixture' }; }
    throw Error('unexpected network');
  };
  const context = { patterns, Date: Clock, fetch, Response, Request, URL, AbortSignal, setTimeout, clearTimeout };
  vm.runInNewContext(source, context, { filename: 'cloudflare/worker.js' });
  return {
    env, context, writes,
    setNow(ms) { now = ms; }, advance(ms) { now += ms; }, setTriggers(value) { triggers = value; },
    setMarketFails(value) { marketFails = value; }, setMarketEmpty(value) { marketEmpty = value; }, setMarkPrice(value) { markPrice = value; }, setBarkMode(value) { barkMode = value; },
    setLatest(value) { latest = value; }, setFailPut(value) { failPut = value; },
    setFailStateRead(value) { failStateRead = value; }, setFailLatestRead(value) { failLatestRead = value; }, setFailEvaluation(value) { failEvaluation = value; }, setInvalidEvaluation(value) { invalidEvaluation = value; },
    read() { return clone(saved); }, counts() { return { evaluations, marketRequests, barkRequests }; },
    run() { return context.runSentinel(env); },
    scheduled() { return context.worker.scheduled({ cron: '*/5 * * * *' }, env, {}); },
  };
}
const alert = type => ({ type, title: 'fixture alert', body: 'fixture', level: 'active' });
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS', name); }

(async () => {
  await check('quiet checks continue every five minutes and persist at thirty minutes', async () => {
    const h = harness();
    for (const minutes of [5, 10, 15, 20, 25]) { h.setNow(initial + minutes * 60000); await h.scheduled(); }
    assert.equal(h.writes.length, 0); assert.equal(h.counts().evaluations, 5); assert.equal(h.read().lastRunAt, iso(initial));
    h.setNow(initial + 30 * 60000); await h.scheduled();
    assert.equal(h.writes.length, 1); assert.equal(h.read().lastRunAt, iso(initial + 30 * 60000));
    assert.equal(h.read().lastPersistedAt, iso(initial + 30 * 60000)); assert.equal(h.read().statusWriteIntervalSeconds, 1800);
  });
  await check('a full quiet day keeps 288 evaluations and writes 48 heartbeats', async () => {
    const h = harness({ state: { monitoringStatus: 'healthy', activeTriggers: [], lastPersistedAt: iso(initial - 30 * 60000), lastRunAt: iso(initial - 30 * 60000) } });
    for (let i = 0; i < 288; i++) { const at = initial + i * 5 * 60000; h.setNow(at); if (i % 3 === 0) h.setLatest({ updatedAt: iso(at), positions: [{ symbol: 'BTC_USDC_PERP' }] }); await h.scheduled(); }
    assert.equal(h.counts().evaluations, 288); assert.equal(h.counts().marketRequests, 288); assert.equal(h.writes.length, 48);
  });
  await check('alerts persist immediately, retain cooldown, and clearing persists immediately', async () => {
    const h = harness(); h.setTriggers([alert('A')]); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.counts().barkRequests, 1); assert.equal(h.read().A.lastAt, iso(initial + 5 * 60000));
    h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 2); assert.equal(h.counts().barkRequests, 1);
    h.setTriggers([]); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 3); assert.deepEqual(h.read().activeTriggers, []);
    h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 3);
    h.setTriggers([alert('A')]); h.advance(5 * 60000); await h.run(); assert.equal(h.counts().barkRequests, 1); assert.equal(h.read().A.lastAt, iso(initial + 5 * 60000));
  });
  await check('real risk evaluation still triggers and persists a near-stop alert', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'short', breakeven: 100, mark: 100 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 0);
    h.setMarkPrice(104.5); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.counts().barkRequests, 1); assert.equal(h.read().activeTriggers[0], 'A');
  });
  await check('a long position near the estimated stop triggers an alert', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven: 100, mark: 100 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 0);
    h.setMarkPrice(95); h.advance(5 * 60000); await h.run();
    assert.equal(h.read().activeTriggers[0], 'A'); assert.equal(h.counts().barkRequests, 1);
    assert.equal(h.read().lastDetail.positionsEvaluated, 1); assert(h.read().lastDetail.worst.distPct > 0 && h.read().lastDetail.worst.distPct < 2);
  });
  await check('a long position past its estimated stop remains alerting', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven: 100, mark: 100 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.setMarkPrice(93); h.advance(5 * 60000); await h.run();
    assert.equal(h.read().activeTriggers[0], 'A'); assert(h.read().lastDetail.worst.distPct < 0);
  });
  await check('the alert states that its reference price is not the exchange stop price', async () => {
    const risk = require('../cloudflare/patterns.js').evaluate({ updatedAt: iso(initial), slPct: 6,
      positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven: 100, mark: 95 }] }, { BTC_USDC_PERP: 95 }, initial);
    const a = risk.triggers.find(t => t.type === 'A');
    assert(a); assert(a.body.includes('并非交易所止损价'));
  });
  await check('a stale snapshot near a long estimated stop raises the blind-window alert', async () => {
    const latest = { updatedAt: iso(initial - 31 * 60000), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven: 100, mark: 95 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.setMarkPrice(95); await h.run();
    assert(h.read().activeTriggers.includes('A')); assert(h.read().activeTriggers.includes('B'));
    assert(h.read().monitoringReasons.includes('snapshot-stale'));
  });
  await check('a long position with invalid breakeven is not treated as healthy', async () => {
    for (const breakeven of [0, true, [100], 'Infinity']) {
      const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven, mark: 100 }], direction: { streak: 0 } };
      const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run();
      assert.equal(h.read().monitoringStatus, 'degraded'); assert(h.read().monitoringReasons.includes('risk-data-incomplete'));
    }
  });
  await check('a long position without a live mark degrades while preserving the snapshot fallback', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'ETH_USDC_PERP', side: 'long', breakeven: 100, mark: 95 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run();
    assert.equal(h.read().monitoringStatus, 'degraded'); assert(h.read().monitoringReasons.includes('market-data'));
    assert.equal(h.read().lastDetail.positionsEvaluated, 1); assert.equal(h.read().activeTriggers[0], 'A');
  });
  await check('mixed long and short positions select the closest stop', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [
      { symbol: 'BTC_USDC_PERP', side: 'short', breakeven: 100, mark: 104.5 },
      { symbol: 'ETH_USDC_PERP', side: 'long', breakeven: 100, mark: 94.5 },
    ], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.setMarkPrice(104.5); h.advance(5 * 60000); await h.run();
    assert.equal(h.read().lastDetail.positionsEvaluated, 2); assert.equal(h.read().lastDetail.worst.symbol, 'ETH_USDC_PERP');
    assert.equal(h.read().activeTriggers[0], 'A'); assert(h.read().monitoringReasons.includes('market-data'));
  });
  await check('an invalid long stop percentage does not become a healthy estimate', async () => {
    for (const slPct of [null, false, [], '', '  ', 0, -1, 100, 150, 'Infinity']) {
      const latest = { updatedAt: iso(initial), slPct, positions: [{ symbol: 'BTC_USDC_PERP', side: 'long', breakeven: 100, mark: 100 }], direction: { streak: 0 } };
      const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run();
      assert.equal(h.read().monitoringStatus, 'degraded'); assert(h.read().monitoringReasons.includes('risk-data-incomplete'));
    }
  });
  await check('a short position that cannot be evaluated is not treated as a quiet healthy check', async () => {
    const latest = { updatedAt: iso(initial), slPct: 6, positions: [{ symbol: 'BTC_USDC_PERP', side: 'short', breakeven: 0, mark: 100 }], direction: { streak: 0 } };
    const h = harness({ latest, realPatterns: true }); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.read().monitoringStatus, 'degraded'); assert.deepEqual(h.read().monitoringReasons, ['risk-data-incomplete']);
  });
  await check('market failure and recovery are persisted immediately', async () => {
    const h = harness(); h.setMarketFails(true); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.read().monitoringStatus, 'degraded'); assert.equal(h.read().lastDetail.liveMarks, false);
    h.setMarketFails(false); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 2); assert.equal(h.read().monitoringStatus, 'healthy'); assert.equal(h.read().lastDetail.liveMarks, true);
  });
  await check('empty market data uses the snapshot and is recorded as degraded', async () => {
    const h = harness(); h.setMarketEmpty(true); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.read().monitoringStatus, 'degraded'); assert.equal(h.read().lastDetail.liveMarks, false);
  });
  await check('a missing live mark for a short position is recorded as degraded', async () => {
    const latest = { updatedAt: iso(initial), positions: [{ symbol: 'BTC_USDC_PERP', side: 'short' }, { symbol: 'ETH_USDC_PERP', side: 'short' }] };
    const h = harness({ latest }); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.read().monitoringStatus, 'degraded'); assert.equal(h.read().lastDetail.liveMarks, true);
  });
  await check('stale, invalid and future snapshots are recorded immediately and recovery is recorded', async () => {
    const h = harness();
    for (const latest of [
      { updatedAt: iso(initial - 31 * 60000), positions: [{ symbol: 'BTC_USDC_PERP' }] },
      { updatedAt: 'invalid', positions: [{ symbol: 'BTC_USDC_PERP' }] },
      { updatedAt: iso(initial + 60000), positions: [{ symbol: 'BTC_USDC_PERP' }] },
      { updatedAt: iso(initial), dataValid: false, positions: [{ symbol: 'BTC_USDC_PERP' }] },
    ]) {
      h.setLatest(latest); await h.run(); assert.equal(h.read().monitoringStatus, 'degraded');
    }
    assert.equal(h.writes.length, 4);
    h.setLatest({ updatedAt: iso(initial), dataValid: true, positions: [{ symbol: 'BTC_USDC_PERP' }] }); await h.run();
    assert.equal(h.writes.length, 5); assert.equal(h.read().monitoringStatus, 'healthy');
  });
  await check('snapshot freshness keeps the existing strict thirty-minute threshold', async () => {
    const h = harness(); h.setNow(initial + 30 * 60000); await h.run(); assert.equal(h.read().monitoringStatus, 'healthy');
    h.setNow(initial + 30 * 60000 + 1); await h.run(); assert.equal(h.read().monitoringStatus, 'degraded'); assert.deepEqual(h.read().monitoringReasons, ['snapshot-stale']);
  });
  await check('missing or empty snapshots retain immediate skip recording', async () => {
    const h = harness({ latest: null }); h.advance(5 * 60000); await h.run(); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 2); assert.equal(h.read().monitoringStatus, 'skipped');
    h.setLatest({ updatedAt: iso(initial), positions: [] }); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 3);
  });
  await check('push HTTP failures persist, and thrown failures persist before being rethrown', async () => {
    const h = harness(); h.setTriggers([alert('B')]); h.setBarkMode('error'); h.advance(5 * 60000); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.read().B_err.result.status, 503); assert.equal(h.read().monitoringStatus, 'degraded');
    h.setBarkMode('throw'); h.advance(5 * 60000); await assert.rejects(h.run(), /fixture push failed/);
    assert.equal(h.writes.length, 2); assert.equal(h.read().B_err.result.status, 0); assert.equal(h.read().B_err.result.error, 'notification request failed'); assert.equal(h.read().lastFailure.stage, 'notification');
  });
  await check('a later push failure preserves an earlier successful alert cooldown', async () => {
    const h = harness(); h.setTriggers([alert('A'), alert('B')]); h.setBarkMode('second-throw'); h.advance(5 * 60000);
    await assert.rejects(h.run(), /fixture push failed/);
    assert.equal(h.writes.length, 1); assert.equal(h.read().A.lastAt, iso(initial + 5 * 60000)); assert.deepEqual(h.read().lastPushed, ['A']);
    h.setBarkMode('ok'); h.advance(5 * 60000); await h.run();
    assert.equal(h.counts().barkRequests, 3); assert.equal(h.read().A.lastAt, iso(initial + 5 * 60000)); assert.equal(h.read().B.lastAt, iso(initial + 10 * 60000));
  });
  await check('snapshot and evaluation errors are recorded immediately and recovery is recorded', async () => {
    const h = harness(); h.setFailLatestRead(true); h.advance(5 * 60000);
    await assert.rejects(h.run(), /fixture snapshot read failed/); assert.equal(h.writes.length, 1); assert.equal(h.read().lastFailure.stage, 'snapshot-read');
    h.setFailLatestRead(false); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 2); assert.equal(h.read().monitoringStatus, 'healthy');
    h.setFailEvaluation(true); h.advance(5 * 60000); await assert.rejects(h.run(), /fixture evaluation failed/);
    assert.equal(h.writes.length, 3); assert.equal(h.read().lastFailure.stage, 'risk-evaluation');
    h.setFailEvaluation(false); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 4); assert.equal(h.read().monitoringStatus, 'healthy');
    h.setInvalidEvaluation(true); h.advance(5 * 60000); await assert.rejects(h.run(), /invalid sentinel evaluation/);
    assert.equal(h.writes.length, 5); assert.equal(h.read().lastFailure.stage, 'risk-evaluation');
  });
  await check('a failed state read never overwrites unknown cooldown data', async () => {
    const h = harness(); h.setFailStateRead(true); await assert.rejects(h.run(), /fixture state read failed/); assert.equal(h.writes.length, 0);
  });
  await check('failure status write outages do not hide the original failure', async () => {
    const h = harness(); h.setFailLatestRead(true); h.setFailPut(true);
    await assert.rejects(h.run(), /fixture snapshot read failed/); assert.equal(h.writes.length, 0);
  });
  await check('legacy or invalid timestamps force an initial state write', async () => {
    for (const state of [{}, { monitoringStatus: 'healthy', activeTriggers: [], lastPersistedAt: 'invalid' }, { monitoringStatus: 'healthy', activeTriggers: [], lastPersistedAt: iso(initial + 60000) }]) {
      const h = harness({ state }); await h.run(); assert.equal(h.writes.length, 1);
    }
  });
  await check('KV write failures remain errors and a later check retries', async () => {
    const h = harness({ state: { monitoringStatus: 'healthy', activeTriggers: [], lastPersistedAt: iso(initial - 30 * 60000) } });
    h.setFailPut(true); await assert.rejects(h.run(), /fixture KV write failed/); assert.equal(h.writes.length, 0);
    h.setFailPut(false); h.advance(5 * 60000); await h.run(); assert.equal(h.writes.length, 1);
  });
  await check('authenticated manual runs still persist immediately', async () => {
    const h = harness(); h.advance(5 * 60000);
    const response = await h.context.worker.fetch(new Request('https://fixture.invalid/api/sentinel/run', { method: 'POST', headers: { 'x-token': 'fixture-only' } }), h.env);
    assert.equal(response.status, 200); assert.equal(h.writes.length, 1);
  });
  await check('unauthenticated manual requests do not run or write', async () => {
    const h = harness(); const response = await h.context.worker.fetch(new Request('https://fixture.invalid/api/sentinel/run', { method: 'POST' }), h.env);
    assert.equal(response.status, 403); assert.equal(h.counts().evaluations, 0); assert.equal(h.writes.length, 0);
  });
  console.log(`${checks} sentinel throttle scenarios passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
