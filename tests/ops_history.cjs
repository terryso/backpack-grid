'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'), PY = require('./env.cjs').PY;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-ops-'));
let count = 0; const test = (name, f) => { f(); count++; console.log('PASS', name); };
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
function fixture() {
  const d = fs.mkdtempSync(path.join(base, 'case-'));
  fs.mkdirSync(path.join(d, 'state'));
  fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify(identity));
  fs.cpSync(path.join(ROOT, 'cloudflare'), path.join(d, 'cloudflare'), { recursive: true });
  fs.rmSync(path.join(d, 'cloudflare/public'), { recursive: true, force: true });
  return d;
}
const run = (d, script) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { env: { ...process.env, BG_ROOT: d, PY_BIN: PY }, encoding: 'utf8', timeout: 20000 });
const read = (d, p) => JSON.parse(fs.readFileSync(path.join(d, p), 'utf8'));
const store = (d, command, v) => spawnSync(PY, [path.join(ROOT, 'scripts/history_store.py'), command], { env: { ...process.env, BG_ROOT: d }, input: v ? JSON.stringify(v) : undefined, encoding: 'utf8', timeout: 15000 });
function seedFills(d, fills) {
  const now = Date.parse('2026-10-09T05:00:00Z');
  const h = { accountKey: identity.accountKey, symbols: { MET_USDC_PERP: { from: now - 86400000, lastTo: now, fills, auditedThrough: now, incomplete: false } }, acquiredAt: new Date(now).toISOString(), asOf: new Date(now).toISOString(), incomplete: false };
  const r = store(d, 'save', h);
  assert.equal(r.status, 0, r.stderr);
}
async function main() {
  const d = fixture();
  const ev = (at, type, extra) => JSON.stringify({ at, type, identity, ...extra });
  const mkFill = (id, ts, price) => ({ id, timestamp: ts, price, quantity: '92', fee: '0.006', feeSymbol: 'USDC', isMaker: true, side: 'Ask', symbol: 'MET_USDC_PERP', orderId: 'o-' + id, clientId: 'c-' + id, tradeId: 't-' + id });
  fs.writeFileSync(path.join(d, 'state/run_events.jsonl'), [
    ev('2026-10-08T20:00:00Z', 'start', {}),
    ev('2026-10-08T20:01:00Z', 'heartbeat', {}),
    ev('2026-10-08T20:02:00Z', 'actions', { resultStatus: 'complete', results: [{ act: 'create', market: 'MET-PERP', why: 'score=<script>alert(1)</script>', done: true }] }),
    ev('2026-10-08T20:03:00Z', 'end', { status: 'ok' }),
    ev('2026-10-08T21:00:00Z', 'actions', { identity: { userId: 'other', subaccountId: 3, accountKey: 'other-3' }, resultStatus: 'complete', results: [{ act: 'stop', market: 'FOREIGN-PERP', reason: 'other account round', done: true }] }),
    ev('2026-10-08T23:48:04Z', 'actions', { resultStatus: 'complete', results: [{ act: 'stop', market: 'NEAR-PERP', reason: 'AUTO_TP: position pnl 168.1% >= 150%', done: true }] }),
    ev('2026-10-08T23:49:00Z', 'actions', { resultStatus: 'unconfirmed', results: [{ act: 'stop', market: 'X-PERP', reason: 'r' }], dryrun: true }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'state/log.md'), ['noise line', '[2026-10-08T20:00:00Z] grids=1 pnl=X actions=none', '[2026-10-08T23:47:47Z] grids=4 actions=stop:NEAR-PERP'].join('\n') + '\n');
  seedFills(d, { 'f1': mkFill('f1', '2026-10-08T20:00:00.000', '0.42'), 'f2': mkFill('f2', '2026-10-09T04:17:01.331', '0.43') });
  const r = run(d, 'ops_data.cjs');
  assert.equal(r.status, 0, r.stderr);
  const ops = read(d, 'state/ops.json');
  test('grid decisions flatten newest-first with reason and status', () => {
    assert.equal(ops.ops.length, 3);
    assert.equal(ops.ops[0].act, 'stop'); assert.equal(ops.ops[0].market, 'X-PERP'); assert.equal(ops.ops[0].dry, true); assert.equal(ops.ops[0].status, 'unconfirmed');
    assert.equal(ops.ops[1].reason, 'AUTO_TP: position pnl 168.1% >= 150%');
    assert.equal(ops.ops[2].act, 'create'); assert.equal(ops.ops[2].status, 'complete');
  });
  test('round summaries parse newest-first and ignore noise', () => {
    assert.equal(ops.rounds.length, 2);
    assert.match(ops.rounds[0].line, /stop:NEAR-PERP/);
    assert.match(ops.rounds[1].line, /actions=none/);
  });
  test('fills export newest-first, sanitized, UTC-normalized', () => {
    assert.equal(ops.fills.length, 2);
    assert.equal(ops.fills[0].p, '0.43'); assert.equal(ops.fills[0].s, 'MET_USDC_PERP'); assert.equal(ops.fills[0].side, 'sell'); assert.equal(ops.fills[0].mk, true);
    assert.ok(ops.fills[0].t.endsWith('Z'));
    for (const f of ops.fills) for (const key of ['orderId', 'clientId', 'tradeId', 'id']) assert(!(key in f), 'leaked ' + key);
  });
  test('rounds from other accounts are never published', () => {
    assert.equal(ops.ops.some((o) => o.market === 'FOREIGN-PERP'), false);
  });
  test('dataAsOf is the newest record, kept separate from the build time', () => {
    assert.equal(ops.dataAsOf, '2026-10-09T04:17:01.331Z'); // newest fill, not the build moment
    assert.ok(new Date(ops.updatedAt) >= new Date(ops.dataAsOf));
    assert.equal(ops.collection.fillCount, 2);
    assert.equal(ops.collection.incomplete, false);
  });
  test('history_store status exposes coverage and audit flags', () => {
    const r = spawnSync(PY, [path.join(ROOT, 'scripts/history_store.py'), 'status'], { env: { ...process.env, BG_ROOT: d }, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.incomplete, false);
    assert.equal(s.fillCount, 2);
    assert.equal(typeof s.fillsMaxTs, 'number');
  });
  test('content hash is stable across rebuilds and moves when data moves', () => {
    const h1 = fs.readFileSync(path.join(d, 'state/ops_content_hash'), 'utf8').trim();
    const j1 = fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8');
    const r2 = run(d, 'ops_data.cjs');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(path.join(d, 'state/ops_content_hash'), 'utf8').trim(), h1); // same data → same hash
    assert.notEqual(fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8'), j1); // even though updatedAt churns
    fs.appendFileSync(path.join(d, 'state/run_events.jsonl'), JSON.stringify({ at: '2026-10-09T05:30:00Z', type: 'actions', identity, resultStatus: 'complete', results: [{ act: 'stop', market: 'BTC-PERP', reason: 'hash moves', done: true }] }) + '\n');
    const r3 = run(d, 'ops_data.cjs');
    assert.equal(r3.status, 0, r3.stderr);
    assert.notEqual(fs.readFileSync(path.join(d, 'state/ops_content_hash'), 'utf8').trim(), h1);
  });
  test('history_store fills command honors explicit cap', () => {
    const r = spawnSync(PY, [path.join(ROOT, 'scripts/history_store.py'), 'fills', '1'], { env: { ...process.env, BG_ROOT: d }, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 1);
  });
  test('failed source read keeps last good ops.json', () => {
    const before = fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8');
    fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify({ userId: 'other', subaccountId: 3, accountKey: 'other-3' }));
    assert.notEqual(run(d, 'ops_data.cjs').status, 0);
    assert.equal(fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8'), before);
    fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify(identity));
  });
  test('static build embeds escaped ops fallback and homepage button', () => {
    const b = run(d, 'build_dashboard.cjs');
    assert.equal(b.status, 0, b.stderr);
    const pub = path.join(d, 'cloudflare/public');
    const opsHtml = fs.readFileSync(path.join(pub, 'ops.html'), 'utf8');
    assert.ok(opsHtml.includes('window.__OPS_FALLBACK__'));
    assert.ok(opsHtml.includes('/api/ops'));
    assert.ok(!/<script>alert/.test(opsHtml), 'unescaped payload reached the page');
    assert.ok(opsHtml.includes('\\u003cscript>alert'));
    const indexHtml = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/ops.html"'));
    assert.ok(fs.existsSync(path.join(pub, 'backpack-icon.png')));
  });
  console.log('Ops history acceptance: ' + count + ' passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
