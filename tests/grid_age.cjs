'use strict';
// grid_age.cjs 纯函数回归：建格时刻的提取（最新覆盖、账户过滤、done 校验）与时长格式化。
const assert = require('node:assert/strict');
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
check('畸形行不抛错', () => {
  const created = latestCreates([null, { type: 'actions' }, 'junk', ev('2026-10-08T00:00:00Z', [{ act: 'create', market: 'D-PERP', done: true }])], 'acct-3');
  assert.equal(created['D-PERP'], Date.parse('2026-10-08T00:00:00Z'));
});
check('时长格式化：分钟/小时/天与未知值', () => {
  assert.equal(formatAgeMin(30), '30 分钟');
  assert.equal(formatAgeMin(90), '1.5 小时');
  assert.equal(formatAgeMin(60 * 72), '3 天 0 小时');
  assert.equal(formatAgeMin(null), null);
  assert.equal(formatAgeMin(-5), null);
});
console.log(`${count} grid age scenarios passed`);
