'use strict';
// ops 页验收。前置数据一律经生产 API 创建与清理：
//   账本 → history_store.py save（账户绑定）；轮次事件 → run_events.cjs CLI（start →
//   act_results → actions → end，runId/planId 绑定校验在生产写入器内完成）；
//   清理 → 夹具临时目录 finally 整体移除。
// 对抗注入行（外账户轮次、过期 runId）刻意保留手写：生产写入器会拒绝或丢弃它们，
// 读取侧过滤器必须同样排除——这是被测行为的一部分。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'), PY = require('./env.cjs').PY;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-ops-'));
let count = 0; const test = (name, f) => { f(); count++; console.log('PASS', name); };
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
function fixture() {
  const d = fs.mkdtempSync(path.join(base, 'case-'));
  fs.mkdirSync(path.join(d, 'state'));
  fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(d, 'config.json'), '{}'); // run_events 需要（子账户缺省 3 与身份一致）
  fs.cpSync(path.join(ROOT, 'cloudflare'), path.join(d, 'cloudflare'), { recursive: true });
  fs.rmSync(path.join(d, 'cloudflare/public'), { recursive: true, force: true });
  return d;
}
const run = (d, script) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { env: { ...process.env, BG_ROOT: d, PY_BIN: PY }, encoding: 'utf8', timeout: 20000 });
const read = (d, p) => JSON.parse(fs.readFileSync(path.join(d, p), 'utf8'));
const store = (d, command, v) => spawnSync(PY, [path.join(ROOT, 'scripts/history_store.py'), command], { env: { ...process.env, BG_ROOT: d }, input: v ? JSON.stringify(v) : undefined, encoding: 'utf8', timeout: 15000 });
function seedFills(d, fills) {
  const now = Date.parse('2026-10-09T05:00:00Z');
  const lag = Date.parse('2026-10-06T05:00:00Z'); // laggard symbol — aggregate coverage ends here
  const h = { accountKey: identity.accountKey, symbols: {
    MET_USDC_PERP: { from: now - 86400000, lastTo: now, fills, auditedThrough: now, incomplete: false },
    ZEC_USDC_PERP: { from: lag - 86400000, lastTo: lag, fills: {}, auditedThrough: lag, incomplete: false } },
    acquiredAt: new Date(now).toISOString(), asOf: new Date(now).toISOString(), incomplete: false };
  const r = store(d, 'save', h);
  assert.equal(r.status, 0, r.stderr);
}
// 经生产 CLI 创建一轮动作事件（start → act_results → actions → end）。
// staleRunId=true 时 act_results 携带过期 runId：生产写入器判 unconfirmed 并丢弃 results。
// 返回本轮 startedAt（供归属窗口断言使用）。
function round(d, { dryrun = false, status = 'complete', results, staleRunId = false } = {}) {
  const env = { ...process.env, BG_ROOT: d, ...(dryrun ? { DRYRUN: '1' } : {}) };
  const spawn = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_events.cjs'), ...args], { env, encoding: 'utf8' });
  const r1 = spawn(['start']);
  assert.equal(r1.status, 0, r1.stderr);
  const ctx = JSON.parse(fs.readFileSync(path.join(d, 'state/run_context.json'), 'utf8'));
  const result = { at: new Date().toISOString(), runId: staleRunId ? 'stale-run-id' : ctx.runId, planId: 'plan-' + ctx.runId.slice(0, 8), identity, status, results };
  fs.writeFileSync(path.join(d, 'state/act_results.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(d, 'state/actions_meta.json'), JSON.stringify({ runId: result.runId, planId: result.planId, identity }));
  const r2 = spawn(['actions', 'risk']);
  assert.equal(r2.status, 0, r2.stderr);
  const r3 = spawn(['end', 'ok']);
  assert.equal(r3.status, 0, r3.stderr);
  return ctx.startedAt;
}
async function main() {
  const d = fixture();
  const mkFill = (id, ts, price) => ({ id, timestamp: ts, price, quantity: '92', fee: '0.006', feeSymbol: 'USDC', isMaker: true, side: 'Ask', symbol: 'MET_USDC_PERP', orderId: 'o-' + id, clientId: 'c-' + id, tradeId: 't-' + id });
  // 前置数据（经生产 API）：账本入账
  seedFills(d, { 'f1': mkFill('f1', '2026-10-08T20:00:00.000', '0.42'), 'f2': mkFill('f2', '2026-10-09T04:17:01.331', '0.43') });
  // 轮 1（complete）：建 MET + 仓位止盈 NEAR
  const s1 = round(d, { results: [
    { act: 'create', market: 'MET-PERP', why: 'score=<script>alert(1)</script>', done: true },
    { act: 'stop', market: 'NEAR-PERP', reason: 'AUTO_TP: position pnl 168.1% >= 150%', done: true },
  ] });
  // 对抗注入：外账户轮次（生产写入器会拒绝；读取侧过滤必须排除）。start 切割时间线。
  const foreignStart = new Date().toISOString();
  fs.appendFileSync(path.join(d, 'state/run_events.jsonl'), JSON.stringify({ at: foreignStart, type: 'start', identity: { userId: 'other', subaccountId: 3, accountKey: 'other-3' } }) + '\n');
  fs.appendFileSync(path.join(d, 'state/run_events.jsonl'), JSON.stringify({ at: foreignStart, type: 'actions', identity: { userId: 'other', subaccountId: 3, accountKey: 'other-3' }, resultStatus: 'complete', results: [{ act: 'stop', market: 'FOREIGN-PERP', reason: 'other account round', done: true }] }) + '\n');
  // 轮 2（DRYRUN，止损未成交）
  const s2 = round(d, { dryrun: true, results: [{ act: 'stop', market: 'X-PERP', reason: 'r', done: false }] });
  // 轮 3（runId 过期 → unconfirmed，results 被生产写入器丢弃）
  const s3 = round(d, { staleRunId: true, results: [{ act: 'stop', market: 'STALE-PERP', reason: 'stale run', done: true }] });
  // 轮次日志按实测窗口构造：锚点取相邻真实事件时刻的中点——严格落在对应窗口内，
  // 且永无未来时间戳（注入的未来戳会与真实轮次时间线相交，搅乱归属）。
  const tPre = new Date(Date.parse(s1) - 3600000).toISOString();
  const ownA = new Date((Date.parse(s1) + Date.parse(foreignStart)) / 2).toISOString();
  const foreignLine = new Date((Date.parse(foreignStart) + Date.parse(s2)) / 2).toISOString();
  const ownB = new Date((Date.parse(s2) + Date.parse(s3)) / 2).toISOString();
  fs.writeFileSync(path.join(d, 'state/log.md'), [
    'noise line',
    `[${tPre}] grids=0 pre-witness era line`,
    '[2026-10-08T00:00:00Z] grids=0 pre-ledger line',
    `[${ownA}] grids=1 pnl=X actions=none`,
    `[${foreignLine}] grids=9 foreign-round line`,
    `[${ownB}] grids=4 actions=stop:NEAR-PERP`,
  ].join('\n') + '\n');
  const r = run(d, 'ops_data.cjs');
  assert.equal(r.status, 0, r.stderr);
  const ops = read(d, 'state/ops.json');
  test('grid decisions flatten newest-first with reason and status', () => {
    assert.equal(ops.ops.length, 3);
    assert.equal(ops.ops[0].act, 'stop'); assert.equal(ops.ops[0].market, 'X-PERP'); assert.equal(ops.ops[0].dry, true); assert.equal(ops.ops[0].status, 'complete');
    assert.equal(ops.ops[1].reason, 'AUTO_TP: position pnl 168.1% >= 150%');
    assert.equal(ops.ops[2].act, 'create'); assert.equal(ops.ops[2].status, 'complete');
  });
  test('unconfirmed results are discarded by the production writer, never published', () => {
    assert.equal(ops.ops.some((o) => o.status === 'unconfirmed'), false);
    assert.equal(ops.ops.some((o) => o.market === 'STALE-PERP'), false);
  });
  test('round summaries parse newest-first and ignore noise', () => {
    if (process.env.DEBUG_ROUNDS) {
      const lines = fs.readFileSync(path.join(d, 'state/log.md'), 'utf8').split('\n').filter(Boolean);
      const evs = fs.readFileSync(path.join(d, 'state/run_events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { const e = JSON.parse(l); return { at: e.at, type: e.type, acct: e.identity?.accountKey ?? null }; } catch { return null; } }).filter(Boolean);
      console.log('LOG LINES:', JSON.stringify(lines));
      console.log('EVENTS:', JSON.stringify(evs));
      console.log('ROUNDS:', JSON.stringify(ops.rounds));
    }
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
  test('log lines are owned by their round window: foreign rounds excluded, pre-witness excluded', () => {
    // 外账户 start（foreignStart）切割时间线：其后的 foreign-round 行按归属排除
    assert.equal(ops.rounds.some((r) => /foreign-round/.test(r.line)), false);
    assert.equal(ops.rounds.some((r) => /pre-witness era/.test(r.line)), false); // 首个本轮 start 之前 → 不可归属
    assert.equal(ops.rounds.some((r) => /pre-ledger/.test(r.line)), false);
    assert.equal(ops.rounds.length, 2); // 两条自有窗口内的行
    assert.match(ops.rounds[0].line, /stop:NEAR-PERP/);
    assert.match(ops.rounds[1].line, /actions=none/);
  });
  test('dataAsOf is the newest record, kept separate from per-source times', () => {
    assert.equal(ops.dataAsOf, ops.rounds[0].at); // newest record = the latest in-window round log line
    assert.equal(ops.ledgerAsOf, '2026-10-06T05:00:00.000Z'); // laggard symbol ends here — aggregate coverage ends with it
    assert.equal(ops.fillsAsOf, '2026-10-09T04:17:01.331Z'); // last actual trade — informational only
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
    assert.equal(s.coverageFrom, Date.parse('2026-10-05T05:00:00Z')); // min across symbols
    assert.equal(s.coverageTo, Date.parse('2026-10-06T05:00:00Z')); // laggard, not the fast symbol
  });
  test('collector status is tri-state: success, failure and unknown stay distinct', () => {
    const build = () => { const r = run(d, 'ops_data.cjs'); assert.equal(r.status, 0, r.stderr); return read(d, 'state/ops.json').collection; };
    fs.writeFileSync(path.join(d, 'state/history_status.json'), JSON.stringify({ at: '2026-10-09T05:10:00Z', ok: false }));
    assert.deepEqual(build(), { ok: false, checkedAt: '2026-10-09T05:10:00Z', incomplete: false, fillCount: 2 });
    fs.writeFileSync(path.join(d, 'state/history_status.json'), JSON.stringify({ at: '2026-10-09T05:11:00Z', ok: true }));
    assert.equal(build().ok, true);
    fs.writeFileSync(path.join(d, 'state/history_status.json'), '{corrupt');
    assert.deepEqual(build(), { ok: null, checkedAt: null, incomplete: false, fillCount: 2 });
    fs.rmSync(path.join(d, 'state/history_status.json'));
    assert.deepEqual(build(), { ok: null, checkedAt: null, incomplete: false, fillCount: 2 });
  });
  test('content hash is stable across rebuilds and moves when data moves', () => {
    const h1 = fs.readFileSync(path.join(d, 'state/ops_content_hash'), 'utf8').trim();
    const j1 = fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8');
    const r2 = run(d, 'ops_data.cjs');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(path.join(d, 'state/ops_content_hash'), 'utf8').trim(), h1); // same data → same hash
    assert.notEqual(fs.readFileSync(path.join(d, 'state/ops.json'), 'utf8'), j1); // even though updatedAt churns
    fs.appendFileSync(path.join(d, 'state/run_events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type: 'actions', identity, resultStatus: 'complete', results: [{ act: 'stop', market: 'BTC-PERP', reason: 'hash moves', done: true }] }) + '\n');
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
