'use strict';
// Actual observation and dashboard builders with disposable state and mock I/O.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { dispatchSource, mockEgo, fixtureTask } = require('./ego_fixture.cjs');
const { PY } = require('./env.cjs');
const ROOT = path.join(__dirname, '..'), AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const rawId = 'fixture-private-position-id';

async function run(withId) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-position-ref-observe-'));
  try {
    fs.mkdirSync(path.join(d, 'state')); fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(d, 'cloudflare/assets'), { recursive: true });
    const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json')));
    cfg.watch = { spaceId: 7, page: 'p1' };
    cfg.autoExitsEnabled = true; cfg.trailArmPct = 10; cfg.trailGivebackPct = 4;
    const put = (name, value) => fs.writeFileSync(path.join(d, name), JSON.stringify(value));
    put('config.json', cfg); put('state/account_identity.json', identity);
    put('state/risk.json', { accountKey: identity.accountKey, peakEquity: 500, paused: null });
    put('cloudflare/assets/campaign-history.json', { current: { campaignId: 1012, startsAt: '2026-10-07T00:00:00Z', endsAt: '2026-10-13T23:59:59Z', tiers: [10000, 50000] } });
    const position = { symbol: 'TEST_USDC_PERP', netQuantity: '1', markPrice: '100', breakEvenPrice: '99',
      netExposureNotional: '100', imf: '0.1', cumulativeFundingPayment: '0', estLiquidationPrice: '1',
      ...(withId ? { positionId: rawId } : {}) };
    const grid = { symbol: position.symbol, enabled: true, direction: 'Long', allocationUsd: '1000',
      priceLow: '90', priceHigh: '110', levels: 20, takeProfitPercentage: 10, stopLossPercentage: 6, closePositionsOnStop: true };
    const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async url => {
      const name = new URL(url).pathname; let body;
      if (name.endsWith('/automation')) body = { params: { symbols: [grid] }, snapshot: { symbols: [{ symbol: position.symbol, pnl: { soldValue: 0, boughtValue: 99, netPosition: 1, quoteAssetFees: 0, baseAssetFees: 0 } }] } };
      else if (name.endsWith('/position')) body = [position];
      else if (name.endsWith('/account')) body = { limitOrders: 0, liquidating: false, leverageLimit: 10 };
      else if (name.endsWith('/collateral')) body = { 'fixture-3': { netEquity: 500, netEquityAvailable: 400 } };
      else if (name.endsWith('/markPrices')) body = [{ symbol: position.symbol, markPrice: 100 }];
      else if (name.endsWith('/campaigns/1012/volume')) body = { totalVolume: 0 };
      else throw Error('unexpected fixture endpoint');
      return { status: 200, body: JSON.stringify(body) };
    } };
    const source = dispatchSource(fs.readFileSync(path.join(ROOT, 'scripts/observe.mjs'), 'utf8'), d);
    await new AsyncFunction('ego', 'taskSpace', 'console', 'process', source)(mockEgo(d), async () => fixtureTask(d, page), { log() {} }, { exit(c) { throw Error('unexpected observe exit ' + c); } });
    const observedText = fs.readFileSync(path.join(d, 'state/observed.json'), 'utf8'), observed = JSON.parse(observedText);
    const ref = observed.positionRefs['TEST-PERP'];
    assert.equal(observedText.includes(rawId), false);
    if (withId) assert.match(ref, /^[a-f0-9]{64}$/); else assert.equal(ref, null);
    const build = () => {
      const built = spawnSync(process.execPath, [path.join(d, 'scripts/dashboard_data.cjs')],
        { env: { ...process.env, BG_ROOT: d, PY_BIN: PY, NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) }, encoding: 'utf8', timeout: 15000 });
      assert.equal(built.status, 0, built.stderr);
      const dashboardText = fs.readFileSync(path.join(d, 'state/dashboard.json'), 'utf8');
      assert.equal(dashboardText.includes(rawId), false);
      if (ref) assert.equal(dashboardText.includes(ref), false);
      const data = JSON.parse(dashboardText);
      assert.equal(data.positions.length, 1);
      return data;
    };
    const initial = build();
    assert.equal(initial.autoExits.trailEnabled, true);
    assert.equal(initial.autoExits.trailReady, withId);
    assert.equal(initial.autoExits.trailReason, withId ? null : 'position_identity');
    if (withId) {
      const peakPath = 'state/trail_peak.json';
      put(peakPath, { accountKey: identity.accountKey, markets: { 'TEST-PERP': { positionRef: ref, peak: 14, since: observed.at } } });
      assert.equal(build().autoExits.trailReady, true);
      put(peakPath, { accountKey: identity.accountKey, markets: { 'TEST-PERP': { peak: 14, since: observed.at } } });
      assert.equal(build().autoExits.trailReason, 'legacy_peak');
      put(peakPath, { accountKey: 'different-account', markets: {} });
      assert.equal(build().autoExits.trailReason, 'peak_state');
      fs.writeFileSync(path.join(d, peakPath), '{broken');
      assert.equal(build().autoExits.trailReason, 'peak_state');
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
(async () => {
  await run(true); console.log('PASS observation hashes the position ID and dashboard omits the reference');
  await run(false); console.log('PASS missing position ID stays unknown without exposing account data');
})().catch(error => { console.error(error); process.exitCode = 1; });
