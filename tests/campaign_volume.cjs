'use strict';
// Executes production observe and decide with temporary files and mocked session I/O.
// No browser, exchange requests, or production state is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ROOT, PY } = require('./env.cjs');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json')));

// Pin the knobs these mechanics-tests were written against — the live values are
// user-tunable (10-08: TP 5, warn 90, budget 100) and must not shift assertions.
Object.assign(cfg, { takeProfitPct: 10, stopLossPct: 6, riskBudgetPct: 80, warnDrawdownPct: 40 });

const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-campaign-'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let count = 0;
const put = (d, rel, x) => fs.writeFileSync(path.join(d, rel), JSON.stringify(x));
const get = (d, rel) => JSON.parse(fs.readFileSync(path.join(d, rel)));
function fixture() {
  const d = fs.mkdtempSync(path.join(base, 'case-'));
  fs.mkdirSync(path.join(d, 'state'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
  // Hermetic campaign identity: observe.mjs and decide.cjs both read this file for the
  // campaign id / window — without it the id defaults to the LATEST campaign (1012),
  // which this suite's mocks (1011) would reject.
  fs.mkdirSync(path.join(d, 'cloudflare', 'assets'), { recursive: true });
  put(d, 'cloudflare/assets/campaign-history.json', { current: { name: 'Mystery Box 活动 · 第 1 期', startsAt: '2026-09-30T00:00:00Z', endsAt: '2026-10-06T23:59:59Z', tiers: [50000], campaignId: 1011 } });
  put(d, 'config.json', cfg); put(d, 'state/account_identity.json', identity);
  return d;
}
async function observe(response) {
  const d = fixture();
  const page = { goto: async () => {}, waitForTimeout: async () => {}, fetch: async (url) => {
    const pathname = new URL(url).pathname;
    let data;
    if (pathname.endsWith('/campaigns/1011/volume')) {
      if (response instanceof Error) throw response;
      return response;
    }
    if (pathname.endsWith('/automation')) data = { params: { symbols: [] }, snapshot: { symbols: [] } };
    else if (pathname.endsWith('/position') || pathname.endsWith('/markPrices')) data = [];
    else if (pathname.endsWith('/account')) data = { limitOrders: 0, liquidating: false, leverageLimit: 10 };
    else if (pathname.endsWith('/collateral')) data = { 'fixture-3': { netEquity: '500', netEquityAvailable: '400' } };
    else throw new Error('unexpected mock endpoint ' + pathname);
    return { status: 200, body: JSON.stringify(data) };
  } };
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/observe.mjs'), 'utf8');
  assert(raw.includes('const ROOT = "__BG_ROOT__";'), 'fixture root must replace production placeholder');
  const source = raw.replace('const ROOT = "__BG_ROOT__";', 'const ROOT = ' + JSON.stringify(d) + ';');
  await new AsyncFunction('taskSpace', 'console', 'process', source)(async () => ({ page: () => page }), { log() {} }, { exit(c) { throw Error('unexpected observe exit ' + c); } });
  return get(d, 'state/observed.json');
}
function decide(official) {
  const d = fixture();
  put(d, 'state/observed.json', {
    at: '2026-10-04T12:00:00Z', identity, gridRows: [], positions: [], badges: {},
    margin: { totalEquity: '500', availableEquity: '400', openPnl: '0' },
    ledger: [{ symbol: 'ETH_USDC_PERP', vol: 1100 }], officialCampaignVolume: official,
  });
  put(d, 'state/campaign.json', { last: { ETH_USDC_PERP: 1000 }, campaignVolume: 60000, officialAt: '2026-10-04T00:00:00Z' });
  // Inject a deterministic clock, without modifying any production source.
  const clock = path.join(d, 'clock.cjs');
  fs.writeFileSync(clock, 'const RealDate = Date; const at = RealDate.parse("2026-10-04T12:00:00Z"); global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };');
  const r = spawnSync(process.execPath, ['--require', clock, path.join(ROOT, 'scripts/decide.cjs')], {
    env: { ...process.env, PY_BIN: PY, BG_ROOT: d, BG_OFFLINE: '1', BG_PHASE: '', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr); assert(!r.stdout.includes('RISK WRITE FAILED'));
  return get(d, 'state/campaign.json');
}
function check(name, fn) { fn(); count++; console.log('PASS', name); }
async function main() {
  // Production counter previously converted a collection failure (null) to zero.
  check('failed official collection preserves ledger fallback and last official timestamp', () => {
    const c = decide(null); assert.equal(c.campaignVolume, 60100); assert.equal(c.officialAt, '2026-10-04T00:00:00Z');
  });
  for (const v of [undefined, false, '', '  ', [], {}, -1, 'NaN', 'Infinity', '0x10']) {
    check('invalid official value keeps fallback: ' + JSON.stringify(v), () => assert.equal(decide(v).campaignVolume, 60100));
  }
  for (const v of [0, '0', 63668.0314, '63668.0314']) {
    check('valid official value overrides fallback: ' + JSON.stringify(v), () => {
      const c = decide(v); assert.equal(c.campaignVolume, Number(v)); assert.notEqual(c.officialAt, '2026-10-04T00:00:00Z');
    });
  }
  const body = (v) => JSON.stringify({ totalVolume: v });
  for (const response of [new Error('timeout'), { status: 503, body: body(12) }, { status: 401, body: body(0) }, { status: 200, body: 'broken json' }, ...[null, false, '', '  ', [], {}, -1, 'NaN', '0x10'].map(v => ({ status: 200, body: body(v) }))]) {
    const o = await observe(response);
    check('observe rejects failed or malformed official response #' + count, () => { assert.equal(o.officialCampaignVolume, null); assert(!o.error); });
  }
  for (const v of [0, '0', 63668.0314, '63668.0314']) {
    const o = await observe({ status: 200, body: body(v) });
    check('observe accepts genuine official value: ' + v, () => assert.equal(o.officialCampaignVolume, Number(v)));
  }
  console.log('Campaign volume acceptance: ' + count + ' passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
