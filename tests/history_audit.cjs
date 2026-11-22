'use strict';
// Real history core and SQLite store against synthetic, network-free fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { dispatchSource, mockEgo } = require('./ego_fixture.cjs');
const ROOT = path.join(__dirname, '..'), PY = require('./env.cjs').PY;
const { collectHistory, auditHistory, START } = require('../scripts/history_core.cjs');
const HOUR = 3600000, DAY = 24 * HOUR;
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-audit-'));
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('PASS', name); }
const rec = (now, extra = {}) => ({ from: START, lastTo: now, fills: {}, auditedThrough: START, incomplete: false, ...extra });
const state = (now, symbols) => ({ accountKey: identity.accountKey, symbols, acquiredAt: new Date(now).toISOString(),
  asOf: new Date(now).toISOString(), forwardIncomplete: false, auditIncomplete: false, incomplete: false });
function fixture() {
  const d = fs.mkdtempSync(path.join(base, 'db-')); fs.mkdirSync(path.join(d, 'state'));
  fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify(identity)); return d;
}
function store(d, command, input) {
  const r = spawnSync(PY, [path.join(ROOT, 'scripts/history_store.py'), command],
    { env: { ...process.env, BG_ROOT: d }, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
  return { ...r, value: r.status === 0 ? JSON.parse(r.stdout) : null };
}

const opsHtml = fs.readFileSync(path.join(ROOT, 'cloudflare/ops.html'), 'utf8');
const opsScript = opsHtml.match(/<script>([\s\S]*?)<\/script>/)[1].split('async function load()')[0];
function renderFlags(collection) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', classList: { remove() {}, toggle() {} }, addEventListener() {} });
    return elements.get(id);
  }, querySelectorAll() { return []; } };
  const at = new Date().toISOString();
  const context = { document, fixtureData: { updatedAt: at, dataAsOf: at, ledgerAsOf: at, ops: [], fills: [], rounds: [], collection } };
  vm.runInNewContext(opsScript + '\nDATA=fixtureData;render();', context);
  return elements.get('staleChips').innerHTML;
}

async function main() {
  await check('unstarted overdue audit cannot be reported complete', async () => {
    const now = START + 48 * HOUR;
    const s = state(now, { A: rec(now, { auditTarget: START + 6 * HOUR, auditCursor: START }), B: rec(now) });
    await auditHistory(s, ['A', 'B'], now, async () => [], 1);
    assert.equal(s.symbols.B.auditTarget, undefined); assert.equal(s.auditIncomplete, true); assert.equal(s.incomplete, true);
  });
  await check('all 21 markets receive fair audit work over repeated rounds', async () => {
    const start = START + 53 * DAY, names = Array.from({ length: 21 }, (_, i) => `M${String(i).padStart(2, '0')}`);
    const s = state(start, Object.fromEntries(names.map(n => [n, rec(start, { auditedThrough: start - 25 * HOUR })])));
    const calls = Object.fromEntries(names.map(n => [n, 0]));
    for (let i = 0; i < 7 * 96; i++) {
      const now = start + i * 15 * 60000;
      await auditHistory(s, names, now, async symbol => { calls[symbol]++; return []; }, 10);
      const due = Object.values(s.symbols).some(v => v.auditTarget != null || now - v.auditedThrough >= DAY);
      assert.equal(s.auditIncomplete, due);
    }
    const values = Object.values(calls); assert(values.every(n => n > 0)); assert(Math.max(...values) - Math.min(...values) <= 2);
  });
  await check('sparse audits complete without changing the request budget', async () => {
    const start = START + 14 * DAY, names = Array.from({ length: 21 }, (_, i) => `M${i}`);
    const s = state(start, Object.fromEntries(names.map(n => [n, rec(start)])));
    let calls = 0, rounds = 0;
    do { const now = start + rounds * 15 * 60000; let roundCalls = 0;
      await auditHistory(s, names, now, async () => { calls++; roundCalls++; return []; }, 10);
      assert(roundCalls <= 10); rounds++;
    } while (s.auditIncomplete && rounds < 20);
    assert.equal(s.auditIncomplete, false); assert.equal(s.incomplete, false); assert(rounds <= 6); assert(calls <= 63);
  });
  await check('delayed fills and exclusive window boundary remain complete', async () => {
    const now = START + 14 * DAY, s = state(now, { X: rec(now) });
    const fills = [START + 3 * DAY, START + 7 * DAY].map((timestamp, i) => ({ id: 'f' + i, symbol: 'X', timestamp, price: '1', quantity: '2', fee: '0.1', feeSymbol: 'USDC', isMaker: true }));
    await auditHistory(s, ['X'], now, async (_, from, to) => fills.filter(f => f.timestamp >= from && f.timestamp < to), 10);
    assert.deepEqual(Object.keys(s.symbols.X.fills).sort(), ['f0', 'f1']); assert.equal(s.auditIncomplete, false);
  });
  await check('invalid audit page leaves existing fills and cursor untouched', async () => {
    const now = START + 2 * DAY, existing = { id: 'old', symbol: 'X', timestamp: START + 1, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true };
    const s = state(now, { X: rec(now, { fills: { old: existing } }) });
    await auditHistory(s, ['X'], now, async (_, from, to) => [
      { id: 'good', symbol: 'X', timestamp: from + 1, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true },
      { id: 'bad', symbol: 'X', timestamp: to + 1, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true },
    ], 10);
    assert.deepEqual(Object.keys(s.symbols.X.fills), ['old']); assert.equal(s.symbols.X.auditCursor, START);
    assert.match(s.symbols.X.auditError, /invalid fill fields/); assert.equal(s.auditIncomplete, true);
  });
  await check('foreign or missing market and mismatched account fields fail closed', async () => {
    const now = START + HOUR;
    const baseFill = { id: 'row', symbol: 'X', timestamp: START + 1, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true };
    for (const bad of [{ ...baseFill, symbol: 'Y' }, { ...baseFill, symbol: undefined },
      { ...baseFill, userId: 'other' }, { ...baseFill, userId: null },
      { ...baseFill, subaccountId: 2 }, { ...baseFill, subaccountId: null }]) {
      const s = await collectHistory({ symbols: {} }, ['X'], now, async () => [bad], 10, { overlapMs: 0, identity });
      assert.equal(s.symbols.X.lastTo, START); assert.deepEqual(s.symbols.X.fills, {}); assert.equal(s.incomplete, true);
    }
    const good = await collectHistory({ symbols: {} }, ['X'], now, async () => [{ ...baseFill, userId: 'fixture', subaccountId: '3' }], 10, { overlapMs: 0, identity });
    assert.equal(good.incomplete, false); assert.equal(Object.keys(good.symbols.X.fills).length, 1);
    const audit = state(now + DAY, { X: rec(now + DAY) });
    await auditHistory(audit, ['X'], now + DAY, async () => [{ ...baseFill, symbol: 'Y' }], 10, { identity });
    assert.equal(audit.auditIncomplete, true); assert.deepEqual(audit.symbols.X.fills, {});
  });
  await check('dense pages preserve narrowing across rounds instead of restarting', async () => {
    const now = START + 7 * DAY, s = state(now, { X: rec(now, { auditTarget: now, auditCursor: START }) });
    const full = Array(1000).fill({}); let lastEnd = Infinity, progressed = false;
    for (let i = 0; i < 12 && !progressed; i++) {
      await auditHistory(s, ['X'], now + i, async (_, from, to) => to - from > 1000 ? full : [], 3);
      const r = s.symbols.X;
      if (r.auditCursor > START || r.auditedThrough === now) progressed = true;
      else { assert(r.auditPendingEnd < lastEnd); lastEnd = r.auditPendingEnd; }
    }
    assert(progressed, 'dense interval never made progress');
  });
  await check('explicit range rejection narrows safely without skipping time', async () => {
    const now = START + 2 * DAY, s = state(now, { X: rec(now) }), covered = [];
    for (let i = 0; i < 10 && (i === 0 || s.auditIncomplete); i++) {
      await auditHistory(s, ['X'], now + i, async (_, from, to) => {
        if (to - from > DAY) throw Error('history HTTP 400');
        covered.push([from, to]); return [];
      }, 1);
    }
    assert.equal(s.auditIncomplete, false); assert.equal(covered[0][0], START);
    for (let i = 1; i < covered.length; i++) assert.equal(covered[i - 1][1], covered[i][0]);
    assert.equal(covered.at(-1)[1], now);
  });
  await check('a failing market is retried without starving another market', async () => {
    const now = START + 2 * DAY, s = state(now, { A: rec(now), B: rec(now) }), called = [];
    await auditHistory(s, ['A', 'B'], now, async name => { called.push(name); if (name === 'A') throw Error('fixture failure'); return []; }, 1);
    await auditHistory(s, ['A', 'B'], now + 1, async name => { called.push(name); return []; }, 1);
    assert.deepEqual(called, ['A', 'B']); assert.equal(s.auditIncomplete, true);
  });
  await check('future scheduling metadata cannot starve an overdue market', async () => {
    const now = START + 2 * DAY, s = state(now, { A: rec(now, { auditLastAttempt: now + DAY }), B: rec(now, { auditLastAttempt: now - 1 }) });
    const called = []; await auditHistory(s, ['A', 'B'], now, async name => { called.push(name); return []; }, 1);
    assert.deepEqual(called, ['A']);
  });
  await check('successful retry clears the audit error without hiding forward errors', async () => {
    const now = START + 2 * DAY, s = state(now, { X: rec(now) });
    await auditHistory(s, ['X'], now, async () => { throw Error('audit failure'); }, 1);
    assert.equal(s.symbols.X.auditError, 'audit failure');
    await auditHistory(s, ['X'], now + 1, async () => [], 10);
    assert.equal(s.symbols.X.error, null); assert.equal(s.symbols.X.auditError, undefined); assert.equal(s.auditIncomplete, false);
    const both = state(now, { X: rec(now, { incomplete: true, error: 'forward failure' }) });
    both.forwardIncomplete = true; both.incomplete = true;
    await auditHistory(both, ['X'], now, async () => { throw Error('audit failure'); }, 1);
    assert.equal(both.symbols.X.error, 'forward failure'); assert.equal(both.symbols.X.auditError, 'audit failure');
    assert.equal(both.forwardIncomplete, true); assert.equal(both.incomplete, true);
  });
  await check('a saturated single timestamp stays incomplete without cursor advance', async () => {
    const now = START + DAY, s = state(now, { X: rec(now, { auditTarget: START + 1, auditCursor: START }) });
    await auditHistory(s, ['X'], now, async () => Array(1000).fill({}), 10);
    assert.equal(s.symbols.X.auditCursor, START); assert.match(s.symbols.X.error, /saturated timestamp/);
    assert.equal(s.auditIncomplete, true); assert.equal(s.incomplete, true);
  });
  await check('corrupt audit target fails loudly', async () => {
    const now = START + DAY, s = state(now, { X: rec(now, { auditTarget: now + 1, auditCursor: START }) });
    await assert.rejects(() => auditHistory(s, ['X'], now, async () => [], 1), /invalid audit target/);
  });
  await check('SQLite persists retry window, fairness and truthful completeness atomically', async () => {
    const now = START + 7 * DAY, d = fixture(), s = state(now, { X: rec(now, { auditTarget: now, auditCursor: START }) });
    await auditHistory(s, ['X'], now, async () => Array(1000).fill({}), 2);
    assert.equal(s.forwardIncomplete, false); assert.equal(s.auditIncomplete, true); assert.equal(s.incomplete, true);
    const saved = store(d, 'save', s); assert.equal(saved.status, 0, saved.stderr);
    const loaded = store(d, 'load'); assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.value.symbols.X.auditPendingEnd, s.symbols.X.auditPendingEnd);
    assert.equal(loaded.value.symbols.X.auditLastAttempt, s.symbols.X.auditLastAttempt);
    await auditHistory(loaded.value, ['X'], now + 1, async () => Array(1000).fill({}), 2);
    assert(loaded.value.symbols.X.auditPendingEnd < s.symbols.X.auditPendingEnd, 'reload restarted narrowing');
    const before = store(d, 'status').value;
    assert.equal(before.forwardIncomplete, false); assert.equal(before.auditIncomplete, true); assert.equal(before.incomplete, true);
    const rejected = store(d, 'save', { ...s, incomplete: false }); assert.notEqual(rejected.status, 0);
    const forgedAudit = store(d, 'save', { ...s, incomplete: false, auditIncomplete: false }); assert.notEqual(forgedAudit.status, 0);
    const overdue = { ...s.symbols.X }; delete overdue.auditTarget; delete overdue.auditCursor; delete overdue.auditPendingEnd;
    const forgedOverdue = store(d, 'save', { ...s, incomplete: false, auditIncomplete: false, symbols: { X: overdue } });
    assert.notEqual(forgedOverdue.status, 0); assert.match(forgedOverdue.stderr, /audit completeness contradicts cursor/);
    const forgedForward = store(d, 'save', { ...s, symbols: { X: { ...s.symbols.X, incomplete: true } } }); assert.notEqual(forgedForward.status, 0);
    const forgedCursor = store(d, 'save', { ...s, symbols: { X: { ...s.symbols.X, auditCursor: s.symbols.X.auditTarget + 1 } } });
    assert.notEqual(forgedCursor.status, 0); assert.match(forgedCursor.stderr, /audit cursor invalid/);
    assert.deepEqual(store(d, 'status').value, before);
  });
  await check('legacy completeness metadata stays explicitly unknown', async () => {
    const now = START + DAY, d = fixture(), s = state(now, { X: rec(now) });
    delete s.forwardIncomplete; delete s.auditIncomplete;
    assert.equal(store(d, 'save', s).status, 0);
    const status = store(d, 'status').value;
    assert.equal(status.incomplete, false); assert.equal(status.forwardIncomplete, null); assert.equal(status.auditIncomplete, null);
  });
  await check('SQLite rejects foreign fills and rolls back the whole batch', async () => {
    const now = START + 2 * DAY, d = fixture();
    const fill = (id, extra = {}) => ({ id, symbol: 'X', timestamp: START + 1, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true, ...extra });
    const initial = state(now, { X: rec(now, { fills: { old: fill('old') } }) }); initial.auditIncomplete = true; initial.incomplete = true;
    assert.equal(store(d, 'save', initial).status, 0); const before = store(d, 'status').value;
    for (const bad of [fill('bad', { symbol: 'Y' }), fill('bad', { symbol: undefined }), fill('other-id'),
      fill('bad', { userId: 'other' }), fill('bad', { userId: null }), fill('bad', { subaccountId: 2 }),
      fill('bad', { subaccountId: null }), fill('bad', { subaccountId: false }), fill('bad', { subaccountId: '0x3' })]) {
      const candidate = { ...initial, symbols: { X: { ...initial.symbols.X, fills: { new: fill('new'), bad } } } };
      assert.notEqual(store(d, 'save', candidate).status, 0);
      assert.deepEqual(store(d, 'status').value, before);
    }
    const good = { ...initial, symbols: { X: { ...initial.symbols.X, fills: { good: fill('good', { userId: 'fixture', subaccountId: '3' }) } } } };
    assert.equal(store(d, 'save', good).status, 0); assert.equal(store(d, 'status').value.fillCount, 2);
  });
  await check('replaying an old fill through SQLite does not duplicate fees or records', async () => {
    const now = START + 14 * DAY, d = fixture();
    const fill = { id: 'old-fill', symbol: 'X', timestamp: START + 3 * DAY, price: '2', quantity: '3', fee: '0.1', feeSymbol: 'USDC', isMaker: true };
    const initial = state(now, { X: rec(now, { fills: { 'old-fill': fill } }) });
    initial.auditIncomplete = true; initial.incomplete = true;
    assert.equal(store(d, 'save', initial).status, 0);
    for (let i = 0; i < 2; i++) {
      const loaded = store(d, 'load').value; loaded.symbols.X.auditedThrough = START;
      loaded.acquiredAt = new Date(now + i).toISOString(); loaded.asOf = new Date(now + i).toISOString();
      await auditHistory(loaded, ['X'], now + i, async (_, from, to) => fill.timestamp >= from && fill.timestamp < to ? [fill] : [], 10);
      const saved = store(d, 'save', loaded); assert.equal(saved.status, 0, saved.stderr);
      assert.equal(saved.value.symbols.X.feeUsd, 0.1); assert.equal(store(d, 'status').value.fillCount, 1);
    }
  });
  await check('dense multi-market audits preserve every fill across SQLite restarts', async () => {
    const start = START + 14 * DAY, d = fixture(), names = ['A', 'B', 'C'];
    const rows = Object.fromEntries(names.map(name => [name, Array.from({ length: 1500 }, (_, i) => ({
      id: `${name}-${i}`, symbol: name, timestamp: START + DAY + Math.floor(i * (6 * HOUR - 1) / 1500),
      price: '2', quantity: '3', fee: '0.01', feeSymbol: 'USDC', isMaker: true,
    }))]));
    const initial = state(start, Object.fromEntries(names.map(name => [name, rec(start)])));
    initial.auditIncomplete = true; initial.incomplete = true;
    assert.equal(store(d, 'save', initial).status, 0);
    let complete = false, finalSummary = null;
    for (let round = 0; round < 60 && !complete; round++) {
      const now = start + round * 15 * 60000, loaded = store(d, 'load').value;
      loaded.acquiredAt = new Date(now).toISOString(); loaded.asOf = new Date(now).toISOString();
      await auditHistory(loaded, names, now, async (name, from, to) => rows[name].filter(f => f.timestamp >= from && f.timestamp < to).slice(0, 1000), 2);
      const saved = store(d, 'save', loaded); assert.equal(saved.status, 0, saved.stderr);
      finalSummary = saved.value;
      complete = !saved.value.incomplete;
    }
    assert(complete, 'dense audit did not complete');
    const all = store(d, 'fills').value;
    assert.equal(all.length, 4500); assert.equal(new Set(all.map(x => x.id)).size, 4500);
    for (const name of names) assert(Math.abs(finalSummary.symbols[name].feeUsd - 15) < 1e-8);
  });
  await check('production collector completes a fixture audit without losing existing fills', async () => {
    const now = Date.now(), d = fixture(), cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    cfg.watch = { spaceId: 7, page: 'p1' };
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(cfg));
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
    const names = ['X_USDC_PERP', 'Y_USDC_PERP'];
    fs.writeFileSync(path.join(d, 'state/observed.json'), JSON.stringify({ gridRows: names.map(symbol => ({ symbol })) }));
    const target = now - 2 * 60000;
    const originalFill = { id: 'fixture-old', symbol: 'X_USDC_PERP', timestamp: START + 1000, price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true };
    const seeded = state(target, Object.fromEntries(names.map((name, i) => [name, rec(target, {
      fills: i === 0 ? { 'fixture-old': originalFill } : {}, auditedThrough: target - 25 * HOUR,
      auditTarget: target, auditCursor: target - 14 * DAY,
    })])));
    seeded.auditIncomplete = true; seeded.incomplete = true;
    assert.equal(store(d, 'save', seeded).status, 0);
    const requests = []; let injectForeign = false;
    const page = { url: async () => 'https://backpack.exchange/portfolio/balances/assets', async goto() {}, async waitForTimeout() {},
      async fetch(url) {
        if (url.includes('/portfolio/collateral')) return { status: 200, body: JSON.stringify({ 'fixture-3': {} }) };
        const u = new URL(url); assert.match(u.pathname, /history\/fills/);
        requests.push({ from: Number(u.searchParams.get('from')), to: Number(u.searchParams.get('to')) });
        if (injectForeign && u.searchParams.get('symbol') === names[0]) return { status: 200, body: JSON.stringify([{
          id: 'foreign-row', symbol: names[1], timestamp: Number(u.searchParams.get('from')) + 1,
          price: '1', quantity: '1', fee: '0.1', feeSymbol: 'USDC', isMaker: true,
        }]) };
        return { status: 200, body: '[]' };
      } };
    const task = { spaceId: 7, page: () => page, async pages() { return [{ label: 'p1' }]; }, async tabs() { return []; } };
    const source = dispatchSource(fs.readFileSync(path.join(ROOT, 'scripts/collect_history.mjs'), 'utf8'), d);
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const previous = process.env.PY_BIN; process.env.PY_BIN = PY;
    const runCollector = () => new AsyncFunction('ego', 'taskSpace', 'console', source)(mockEgo(d), async () => task, { log() {} });
    try { await runCollector(); }
    finally { if (previous === undefined) delete process.env.PY_BIN; else process.env.PY_BIN = previous; }
    const result = store(d, 'status').value;
    assert.equal(result.forwardIncomplete, false); assert.equal(result.auditIncomplete, false); assert.equal(result.incomplete, false);
    assert.equal(result.fillCount, 1); assert(requests.some(x => x.to - x.from > 6 * HOUR));
    assert(requests.every(x => x.to - x.from <= 7 * DAY));
    const summary = JSON.parse(fs.readFileSync(path.join(d, 'state/fees.json'), 'utf8'));
    assert.equal(summary.forwardIncomplete, false); assert.equal(summary.auditIncomplete, false); assert.equal(summary.incomplete, false);
    injectForeign = true; process.env.PY_BIN = PY;
    try { await runCollector(); }
    finally { if (previous === undefined) delete process.env.PY_BIN; else process.env.PY_BIN = previous; }
    const afterForeign = store(d, 'status').value;
    assert.equal(afterForeign.forwardIncomplete, true); assert.equal(afterForeign.incomplete, true); assert.equal(afterForeign.fillCount, 1);
  });
  await check('history status UI distinguishes forward lag, audit and legacy unknown', async () => {
    let html = renderFlags({ ok: true, incomplete: true, forwardIncomplete: false, auditIncomplete: true });
    assert.match(html, /历史深度核对未完成/); assert.doesNotMatch(html, /前向采集未追平/);
    html = renderFlags({ ok: true, incomplete: true, forwardIncomplete: true, auditIncomplete: false });
    assert.match(html, /前向采集未追平/); assert.doesNotMatch(html, /深度核对未完成/);
    assert.match(renderFlags({ ok: true, incomplete: false }), /历史核对状态待更新/);
    assert.match(renderFlags({ ok: true, incomplete: true }), /成交流水采集不完整/);
    assert.match(renderFlags({ ok: true, incomplete: false, forwardIncomplete: false, auditIncomplete: true }), /采集完整性状态异常/);
    assert.equal(renderFlags({ ok: true, incomplete: false, forwardIncomplete: false, auditIncomplete: false }), '');
  });
  console.log(`${count} history audit scenarios passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
