'use strict';
// grid_age.cjs 纯函数回归：建格时刻的提取（最新覆盖、账户过滤、done 校验）与时长格式化。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { latestCreates, formatAgeMin } = require('../scripts/grid_age.cjs');
let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
const ev = (at, results, identity = { accountKey: 'acct-3' }) => ({ at, type: 'actions', identity, results });

check('取每市场最近一次成功建格（后者覆盖前者）', () => {
  const created = latestCreates([
    ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'MET-PERP', done: true }]),
    ev('2026-10-09T00:00:00Z', [{ act: 'stop', market: 'MET-PERP', done: true }]),
    ev('2026-10-10T00:00:00Z', [{ act: 'create', market: 'MET-PERP', done: true }]),
  ], 'acct-3');
  assert.equal(created['MET-PERP'], Date.parse('2026-10-10T00:00:00Z'));
});
check('未完成/外账户/非 actions 事件不计入', () => {
  const created = latestCreates([
    ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'A-PERP', done: false }]),
    ev('2026-10-08T01:00:00Z', [{ act: 'create', market: 'B-PERP', done: true }], { accountKey: 'other-3' }),
    { at: '2026-10-08T02:00:00Z', type: 'start', identity: { accountKey: 'acct-3' } },
    ev('2026-10-08T03:00:00Z', [{ act: 'create', market: 'C-PERP', done: true }]),
  ], 'acct-3');
  assert.deepEqual(Object.keys(created), ['C-PERP']);
});
check('已确认停止清除旧锚点，同币种手动重建不能继承旧时长', () => {
  const created = latestCreates([
    ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'MET-PERP', done: true }]),
    ev('2026-10-10T00:00:00Z', [{ act: 'stop', market: 'MET-PERP', done: true }]),
  ], 'acct-3');
  assert.equal(created['MET-PERP'], undefined);
});
check('未完成或外账户的停止不会清除本账户的建格锚点', () => {
  const created = latestCreates([
    ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'MET-PERP', done: true }]),
    ev('2026-10-09T00:00:00Z', [{ act: 'stop', market: 'MET-PERP', done: false }]),
    ev('2026-10-10T00:00:00Z', [{ act: 'stop', market: 'MET-PERP', done: true }], { accountKey: 'other-3' }),
  ], 'acct-3');
  assert.equal(created['MET-PERP'], Date.parse('2026-10-08T00:00:00Z'));
});
check('畸形行不抛错', () => {
  const created = latestCreates([null, { type: 'actions' }, 'junk', ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'D-PERP', done: true }])], 'acct-3');
  assert.equal(created['D-PERP'], Date.parse('2026-10-08T00:00:00Z'));
});
check('时长格式化：分钟/小时/天与未知值', () => {
  assert.equal(formatAgeMin(30), '30 分钟');
  assert.equal(formatAgeMin(90), '1.5 小时');
  assert.equal(formatAgeMin(60 * 72), '3 天 0 小时'); assert.equal(formatAgeMin(60 * 71.9), '3 天 0 小时');
  assert.equal(formatAgeMin(null), null);
  assert.equal(formatAgeMin(-5), null);
});

// Exercise the production data boundary as well as the pure helper. All output stays
// in a disposable fixture; no production state or exchange calls are involved.
const ROOT = path.join(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-grid-age-'));
try {
  fs.mkdirSync(path.join(fixture, 'state'));
  const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
  const now = Date.now();
  const put = (name, value) => fs.writeFileSync(path.join(fixture, name), JSON.stringify(value));
  put('config.json', JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')));
  put('state/account_identity.json', identity);
  put('state/observed.json', { at: new Date(now).toISOString(), identity,
    gridRows: [{ market: 'MET-PERP', status: 'Triggered', range: ['90', '110'], value: '100', pnl: '0', pnlPct: 0 }],
    positions: [], margin: { totalEquity: '1000', availableEquity: '500' } });
  const event = (at, act) => JSON.stringify({ at: new Date(at).toISOString(), type: 'actions', identity,
    resultStatus: 'complete', results: [{ act, market: 'MET-PERP', done: true }] });
  const history = event(now - 72 * 3600000, 'create') + '\n' + event(now - 3600000, 'stop') + '\n';
  const file = path.join(fixture, 'state/run_events.jsonl');
  fs.writeFileSync(file, history);
  const build = () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dashboard_data.cjs')], {
      env: { ...process.env, BG_ROOT: fixture }, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(fixture, 'state/dashboard.json'), 'utf8'));
  };
  check('生产快照：已停旧网格后同币种无新建格记录，时长未知且原事件不改写', () => {
    assert.equal(build().grids[0].gridAgeLabel, null);
    assert.equal(fs.readFileSync(file, 'utf8'), history);
  });
  check('生产快照：同币种新建格后重新起算，正常路径仍显示新时长', () => {
    fs.appendFileSync(file, event(now - 10 * 60000, 'create') + '\n');
    assert.equal(build().grids[0].gridAgeLabel, '10 分钟');
  });
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(`${count} grid age scenarios passed`);
