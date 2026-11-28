'use strict';
// Production Worker + Durable Object + account-bound transaction, with fixture I/O only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { directionFor, directionSnapshot, directionTransaction, setDirection } = require('../scripts/grid_direction.cjs');
const patterns = require('../cloudflare/patterns.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-chain-snapshot-'));
const key = 'fixture-3';
fs.mkdirSync(path.join(root, 'state'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.example.json')));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
const source = fs.readFileSync(path.join(__dirname, '../cloudflare/direction_mailbox.js'), 'utf8')
  .replace('export class DirectionMailbox', 'class DirectionMailbox') + '\nglobalThis.Mailbox = DirectionMailbox;';
const ctx = { Date, crypto: webcrypto, Response, URL };
vm.runInNewContext(source, ctx);
let data = null, serial = Promise.resolve(), failNextWrite = false;
const storage = {
  storage: { get: async () => structuredClone(data), put: async (_, value) => {
    if (failNextWrite) { failNextWrite = false; throw Error('fixture storage outage'); }
    data = structuredClone(value);
  } },
  blockConcurrencyWhile(fn) { const next = serial.then(fn); serial = next.catch(() => {}); return next; },
};
const mailbox = new ctx.Mailbox(storage);
const workerSource = fs.readFileSync(path.join(__dirname, '../cloudflare/worker.js'), 'utf8')
  .replace(/^export \{.*$/gm, '').replace(/^import .*$/gm, '')
  .replace('export default {', 'const worker = {') + '\nglobalThis.worker = worker;';
const wc = { patterns, Date, crypto: webcrypto, Response, Request, URL, TextEncoder, AbortSignal,
  fetch: async () => { throw Error('unexpected network call'); }, console };
vm.runInNewContext(workerSource, wc);
const kv = new Map();
const env = { DASH_WRITE_TOKEN: 'fixture-only',
  DASH: { get: async k => kv.get(k) || null, put: async (k, v) => kv.set(k, v) },
  DIRECTION: { idFromName: n => n, get: () => ({ fetch: (url, init) => mailbox.fetch(new Request(url, init)) }) },
};
const send = (pathname, method = 'GET', body, token = 'fixture-only') => wc.worker.fetch(new Request('https://fixture.invalid' + pathname, {
  method, headers: { 'x-token': token, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}), env);
const asOf = offset => new Date(Date.now() + offset).toISOString();
const values = { BTC: '偏多', ETH: '中性', SOL: '中性偏空', BNB: '中性偏多', SUI: '偏空', HYPE: 'Long', TRX: 'Neutral' };
const payload = (time, entries = values) => ({ asOf: time, chains: entries });
const apply = event => directionTransaction(root, { op: 'cloud', accountKey: key, event });
const snapUpload = () => ({ updatedAt: asOf(0), dataValid: true, direction: directionSnapshot(root, key) });
(async () => {
  try {
    const time = asOf(-10000), first = payload(time);
    assert.equal((await send('/api/direction-snapshot', 'POST', first, 'wrong')).status, 403);
    assert.equal(data, null);
    assert.equal((await send('/api/direction-snapshot', 'POST', '{')).status, 400);
    for (const bad of [
      { asOf: time, chains: { BTC: 'Long' } },
      payload('2026-02-31T00:00:00Z'),
      payload(asOf(120000)), payload(asOf(-7201000)),
      payload(time, { ...values, BTC: { judgment: '偏多', direction: 'Short' } }),
      payload(time, { ...values, ETH: 'Sideways' }),
      payload(time, { ...values, OTHER: 'Long' }),
    ]) assert.equal((await send('/api/direction-snapshot', 'POST', bad)).status, 400);
    assert.equal((await send('/api/direction-snapshot', 'POST', 'x'.repeat(9000))).status, 413);
    assert.equal(data, null);
    failNextWrite = true;
    await assert.rejects(send('/api/direction-snapshot', 'POST', first), /fixture storage outage/);
    assert.equal(data, null);
    let response = await send('/api/direction-snapshot', 'POST', first);
    assert.equal(response.status, 200);
    const state = await response.json(), event = state.pending;
    assert.deepEqual(Object.fromEntries(Object.entries(event.chains).map(([k, v]) => [k, v.direction])),
      { BTC: 'Long', ETH: 'Neutral', SOL: 'Short', BNB: 'Long', SUI: 'Short', HYPE: 'Long', TRX: 'Neutral' });
    assert.equal(event.chains.BTC.judgment, '偏多');
    assert.equal((await (await send('/api/direction-event')).json()).advice.snapshot.id, event.id);
    assert.equal((await (await send('/api/direction-advice')).json()).snapshot.id, event.id);
    assert.equal((await send('/api/judge-cloud/run', 'POST', {})).status, 404);
    assert.equal((await (await send('/api/direction-snapshot', 'POST', first)).json()).pending.id, event.id);
    assert.equal((await send('/api/direction-snapshot', 'POST', payload(time, { ...values, BTC: 'Short' }))).status, 409);
    assert.equal((await send('/api/direction-snapshot', 'POST', payload(asOf(-20000)))).status, 409);
    console.log('PASS authenticated snapshot validation, mapping, idempotency and monotonicity');

    setDirection(root, key, '*', 'Short');
    setDirection(root, key, 'ETH-PERP', 'Long');
    assert.equal(apply(event).status, 'applied');
    const cases = { 'BTC-PERP': 'Long', 'ETH-PERP': 'Neutral', 'AAVE_USDC_PERP': 'Neutral',
      'SOL-PERP': 'Short', 'PENGU-PERP': 'Short', 'SUI-PERP': 'Short', 'DEEP-PERP': 'Short',
      'BNB-PERP': 'Long', 'CAKE-PERP': 'Long', 'HYPE-PERP': 'Long', 'PURR-PERP': 'Long',
      'TRX-PERP': 'Neutral', 'JST-PERP': 'Neutral', 'OTHER-PERP': 'Short' };
    for (const [market, expected] of Object.entries(cases)) assert.equal(directionFor(root, key, market, cfg), expected, market);
    assert.deepEqual(apply(event), { id: event.id, status: 'applied' });
    assert.equal(directionFor(root, 'foreign-account', 'BTC-PERP', cfg), 'Neutral');
    const altered = structuredClone(event); altered.id = 'malformed'; altered.chains.BTC.direction = 'Short';
    assert.throws(() => apply(altered), /transaction failed/);
    assert.equal(directionFor(root, key, 'BTC-PERP', cfg), 'Long');
    const registryFile = path.join(root, 'state/direction_override.json'), original = fs.readFileSync(registryFile);
    const corrupt = JSON.parse(original); delete corrupt.chainSnapshot.chains.ETH;
    fs.writeFileSync(registryFile, JSON.stringify(corrupt));
    assert.equal(directionFor(root, key, 'PENGU-PERP', cfg), 'Neutral');
    assert.throws(() => directionSnapshot(root, key), /invalid chain direction snapshot/);
    fs.writeFileSync(registryFile, original);
    console.log('PASS atomic chain application and ecosystem inheritance, including Neutral over global');

    // Snapshot upload acknowledges the applied event, and a failed ack can retry.
    failNextWrite = true;
    assert.equal((await send('/api/snapshot', 'POST', snapUpload())).status, 200);
    assert.equal(data.pending.id, event.id);
    assert.equal((await send('/api/snapshot', 'POST', snapUpload())).status, 200);
    assert.equal(data.pending, null);
    assert.equal(data.lastAcknowledged.status, 'applied');
    assert.equal((await (await send('/api/direction-advice')).json()).snapshot.id, event.id);
    // Restored local state can apply the retained advice even after acknowledgment.
    const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-chain-restored-'));
    try {
      fs.mkdirSync(path.join(restored, 'state'));
      assert.equal(directionTransaction(restored, { op: 'cloud', accountKey: key, event: data.advice.snapshot }).status, 'applied');
      assert.equal(directionFor(restored, key, 'AAVE-PERP', cfg), 'Neutral');
    } finally { fs.rmSync(restored, { recursive: true, force: true }); }
    assert.equal((await (await send('/api/direction-snapshot', 'POST', first)).json()).pending, null);
    console.log('PASS acknowledgment retry and recovery from retained advice');

    const second = payload(asOf(-5000), { ...values, SOL: { judgment: '偏多', direction: 'Long' } });
    response = await send('/api/direction-snapshot', 'POST', second);
    assert.equal(response.status, 200); const next = (await response.json()).pending;
    // An acknowledgment for the superseded ID cannot erase a newer event.
    assert.equal((await send('/api/snapshot', 'POST', snapUpload())).status, 200);
    assert.equal(data.pending.id, next.id);
    assert.equal(apply(next).status, 'applied');
    assert.equal(directionFor(root, key, 'PENGU-PERP', cfg), 'Long');
    const oldReplay = { ...event, id: 'old-replay' };
    assert.equal(apply(oldReplay).status, 'conflict');
    assert.equal(directionFor(root, key, 'PENGU-PERP', cfg), 'Long');
    const expired = { ...event, id: 'expired', at: asOf(-7201000), asOf: asOf(-7201000) };
    assert.equal(apply(expired).status, 'expired');
    assert.equal(directionFor(root, key, 'PENGU-PERP', cfg), 'Long');
    console.log('PASS newer snapshots supersede older pending and stale local replays cannot roll back');

    // Real decide reads the same Worker response via a fixture curl. Four
    // existing short grids remain subject only to their ordinary exit rules.
    const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-chain-mac-'));
    try {
      fs.mkdirSync(path.join(mac, 'state')); fs.mkdirSync(path.join(mac, 'bin'));
      const put = (name, value) => fs.writeFileSync(path.join(mac, name), typeof value === 'string' ? value : JSON.stringify(value));
      const identity = { userId:'fixture', subaccountId:3, accountKey:key };
      const grids = ['SOL', 'BTC', 'ETH', 'HYPE'].map(symbol => ({
        market:symbol + '-PERP', symbol:symbol + '_USDC_PERP', direction:'Short', range:[90,110],
        allocationRaw:600, pnlRaw:0, pnlPct:0, status:'Triggered', nativeTP:cfg.takeProfitPct,
        nativeSL:cfg.stopLossPct, nativeCloseOnStop:true,
      }));
      put('config.json', { ...cfg, maxGrids:4, requireDirection:true, autoExitsEnabled:false });
      put('state/account_identity.json', identity);
      put('state/observed.json', { at:asOf(0), identity, gridRows:grids, positions:[], ledger:[],
        margin:{ totalEquity:'500', availableEquity:'400', openPnl:'0' } });
      put('state/tickers.json', grids.map(g => ({ symbol:g.symbol, lastPrice:'100', quoteVolume:'100000000' })));
      put('state/dashboard.env', 'DASH_URL=https://fixture.invalid\n');
      put('mailbox.json', { advice:data.advice, pending:next });
      fs.writeFileSync(path.join(mac, 'bin/curl'), '#!/bin/sh\ncat "$BG_CLOUD_FIXTURE"\n', { mode:0o755 });
      const childEnv = { ...process.env, BG_ROOT:mac, BG_OFFLINE:'0', BG_TICKERS_FILE:path.join(mac,'state/tickers.json'),
        BG_CLOUD_FIXTURE:path.join(mac,'mailbox.json'), PATH:path.join(mac,'bin') + ':/usr/bin:/bin' };
      const decide = dry => spawnSync(process.execPath, [path.join(__dirname, '../scripts/decide.cjs')],
        { env:{ ...childEnv, DRYRUN:dry ? '1' : '0' }, encoding:'utf8', timeout:15000 });
      let run = decide(true);
      assert.equal(run.status, 0, run.stderr); assert.equal(directionSnapshot(mac, key).chainSnapshot, null);
      run = decide(false); assert.equal(run.status, 0, run.stderr);
      assert.equal(directionSnapshot(mac, key).chainSnapshot.id, next.id);
      assert.equal(directionFor(mac, key, 'SOL-PERP', cfg), 'Long');
      assert(!JSON.parse(fs.readFileSync(path.join(mac, 'state/actions.json'))).some(a => a.act === 'stop'));
      const dashboard = spawnSync(process.execPath, [path.join(__dirname, '../scripts/dashboard_data.cjs')],
        { env:childEnv, encoding:'utf8', timeout:15000 });
      assert.equal(dashboard.status, 0, dashboard.stderr);
      const shown = JSON.parse(fs.readFileSync(path.join(mac, 'state/dashboard.json'))).direction;
      assert.equal(shown.chainSnapshot.id, next.id); assert.equal(shown.reportedSnapshotId, next.id);
      assert.equal(shown.chainSnapshot.chains.SOL.direction, 'Long');
    } finally { fs.rmSync(mac, { recursive:true, force:true }); }
    console.log('PASS Worker-to-decide application, dry run, existing grids and dashboard projection');

    const older = payload(asOf(3000)), newer = payload(asOf(6000), { ...values, BTC:'Short' });
    const concurrent = await Promise.all([
      send('/api/direction-snapshot', 'POST', newer), send('/api/direction-snapshot', 'POST', older),
    ]);
    assert.equal(concurrent[0].status, 200);
    assert([200, 409].includes(concurrent[1].status));
    assert.equal(data.advice.snapshot.asOf, newer.asOf);
    assert.equal(data.advice.snapshot.chains.BTC.direction, 'Short');
    console.log('PASS concurrent writers retain the newest snapshot');

    // A pre-cutover legacy event can still be acknowledged by the regular upload.
    data = { advice: { at: asOf(0) }, pending: { id: 'old-legacy', at: asOf(0), from: 'Short', to: 'Long' } };
    const ack = snapUpload(); ack.direction.lastCloudEvent = { id: 'old-legacy', status: 'applied' };
    assert.equal((await send('/api/snapshot', 'POST', ack)).status, 200);
    assert.equal(data.pending, null); assert.equal(data.advice.switchLog[0].via, 'cloud');
    assert(!fs.readFileSync(path.join(__dirname, '../cloudflare/wrangler.toml'), 'utf8').includes('11 * * * *'));
    assert(fs.readFileSync(path.join(__dirname, '../cloudflare/wrangler.toml'), 'utf8').includes('*/5 * * * *'));
    console.log('PASS legacy acknowledgment and sentinel-only schedule');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
