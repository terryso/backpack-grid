'use strict';
// position_age.cjs 纯函数回归：锚点的出现/保持/翻向/清除与时长格式化。
const assert = require('node:assert/strict');
const { mergePositionAges, formatAgeMin } = require('../scripts/position_age.cjs');
let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
const NOW = Date.parse('2026-10-10T12:00:00Z');
const pos = (market, side, size = '1') => ({ market, side, size });

check('首次出现：锚点=当前时刻', () => {
  const { ages, next } = mergePositionAges(null, 'acct-3', [pos('MET-PERP', 'long')], NOW);
  assert.equal(ages['MET-PERP'], NOW);
  assert.equal(next.positions['MET-PERP'].since, new Date(NOW).toISOString());
});
check('同向持续持有：锚点保持不变（时长累计）', () => {
  const prev = { accountKey: 'acct-3', positions: { 'MET-PERP': { side: 'long', since: '2026-10-09T00:00:00.000Z' } } };
  const { ages } = mergePositionAges(prev, 'acct-3', [pos('MET-PERP', 'long', '0.8')], NOW);
  assert.equal(ages['MET-PERP'], Date.parse('2026-10-09T00:00:00.000Z'));
});
check('多空翻向：锚点重置', () => {
  const prev = { accountKey: 'acct-3', positions: { 'MET-PERP': { side: 'long', since: '2026-10-09T00:00:00.000Z' } } };
  const { ages } = mergePositionAges(prev, 'acct-3', [pos('MET-PERP', 'short')], NOW);
  assert.equal(ages['MET-PERP'], NOW);
});
check('账户不匹配：全部重置', () => {
  const prev = { accountKey: 'other-3', positions: { 'MET-PERP': { side: 'long', since: '2026-10-01T00:00:00.000Z' } } };
  const { ages } = mergePositionAges(prev, 'acct-3', [pos('MET-PERP', 'long')], NOW);
  assert.equal(ages['MET-PERP'], NOW);
});
check('平仓（持仓列表消失）即清除', () => {
  const prev = { accountKey: 'acct-3', positions: {
    'MET-PERP': { side: 'long', since: '2026-10-09T00:00:00.000Z' },
    'OLD-PERP': { side: 'short', since: '2026-10-08T00:00:00.000Z' } } };
  const { next } = mergePositionAges(prev, 'acct-3', [pos('MET-PERP', 'long')], NOW);
  assert.equal(next.positions['OLD-PERP'], undefined);
  assert.equal(next.positions['MET-PERP'].since, '2026-10-09T00:00:00.000Z');
});
check('数量归零或方向未知不入账', () => {
  const { ages } = mergePositionAges(null, 'acct-3', [pos('A-PERP', 'long', '0'), pos('B-PERP', 'sideways')], NOW);
  assert.deepEqual(Object.keys(ages), []);
});
check('时长格式化：分钟/小时/天与非法值', () => {
  assert.equal(formatAgeMin(30), '30 分钟');
  assert.equal(formatAgeMin(90), '1.5 小时');
  assert.equal(formatAgeMin(60 * 72), '3 天 0 小时');
  assert.equal(formatAgeMin(-1), null);
  assert.equal(formatAgeMin(null), null);
});
console.log(`${count} position age scenarios passed`);
