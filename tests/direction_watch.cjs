'use strict';
// direction_watch.cjs 回归：metrics 边界 / judge 强证据优先全分支 / streak 计数与切换 /
// 入口接线形状。纯逻辑单测（网络禁入环境无 IO）；IO 壳的原子写模式与
// grid_direction.setDirection 同款、已由其测试覆盖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { metrics, judge, nextAdvice, SWITCH_THRESHOLD } = require('../scripts/direction_watch.cjs');
let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };

// 构造 337 根收盘价的辅助：全部等于 base，再把指定下标（从末尾倒数）改成值
function series(base, overrides = {}) {
  const cs = Array(337).fill(base);
  for (const [back, v] of Object.entries(overrides)) cs[337 - 1 - Number(back)] = v;
  return cs;
}

check('metrics：数据不足 25 根 → null', () => {
  assert.equal(metrics([1, 2, 3]), null);
  assert.equal(metrics(undefined), null);
});
check('metrics：337 根全量指标有效', () => {
  const m = metrics(series(100, { 24: 96, 168: 90, 336: 80 }));
  assert.ok(Number.isFinite(m.t24) && Number.isFinite(m.t7) && Number.isFinite(m.t14));
  assert.equal(m.t24.toFixed(2), ((100 / 96 - 1) * 100).toFixed(2));
  assert.equal(m.t14.toFixed(2), ((100 / 80 - 1) * 100).toFixed(2));
});
check('metrics：非有限收盘被过滤不炸', () => {
  const m = metrics([100, NaN, undefined, null, 100, ...Array(30).fill(100)]);
  assert.ok(m && Number.isFinite(m.t24));
});
check('metrics：零宽度横盘 → rangePos 0.5、bounce/drop 0', () => {
  const m = metrics(Array(337).fill(55.5));
  assert.equal(m.rangePos, 0.5);
  assert.equal(m.bounce, 0);
  assert.equal(m.drop, 0);
});
check('metrics：bounce/drop 分别是距低点反弹与距高点回落', () => {
  const m = metrics(series(100, { 335: 80, 168: 120 })); // 14d 窗口内：低 80 高 120 现 100
  assert.equal(m.bounce.toFixed(2), ((100 / 80 - 1) * 100).toFixed(2));
  assert.equal(m.drop.toFixed(2), ((1 - 100 / 120) * 100).toFixed(2));
  assert.equal(m.rangePos.toFixed(2), (0.5).toFixed(2));
});

// ---- judge：Short 指令（强证据优先） ----
check('judge Short：t7<-3 维持', () => {
  assert.equal(judge({ t7: -4, t14: -10, rangePos: 0.6, bounce: 1, drop: 1 }, 'Short'), 'Short');
});
check('judge Short：贴区间底（pos<1/3）维持——即使 t7 微正', () => {
  assert.equal(judge({ t7: 1, t14: -5, rangePos: 0.2, bounce: 3, drop: 1 }, 'Short'), 'Short');
});
check('judge Short：t7>+6 且 t14 翻正 → 强反转 Long', () => {
  assert.equal(judge({ t7: 6.1, t14: 1, rangePos: 0.6, bounce: 12, drop: 1 }, 'Short'), 'Long');
});
check('judge Short：t7=+4 且 t14 翻正 → 弱反转 Neutral（强反转差一口气）', () => {
  assert.equal(judge({ t7: 4, t14: 1, rangePos: 0.6, bounce: 9, drop: 1 }, 'Short'), 'Neutral');
});
check('judge Short：t7=+4 t14 负 → Neutral', () => {
  assert.equal(judge({ t7: 4, t14: -2, rangePos: 0.6, bounce: 1, drop: 1 }, 'Short'), 'Neutral');
});
check('judge Short：反弹>8% → Neutral（t7 未过 3 也算）', () => {
  assert.equal(judge({ t7: 1, t14: -2, rangePos: 0.5, bounce: 9, drop: 1 }, 'Short'), 'Neutral');
});
check('judge Short：无命中 → 维持', () => {
  assert.equal(judge({ t7: 2, t14: -2, rangePos: 0.5, bounce: 5, drop: 1 }, 'Short'), 'Short');
});
check('judge Short：t7 正好 +5 不满足强反转（严格大于）→ 落弱反转 Neutral', () => {
  assert.equal(judge({ t7: 5, t14: 1, rangePos: 0.6, bounce: 2, drop: 1 }, 'Short'), 'Neutral');
});

// ---- judge：Long 指令（镜像） ----
check('judge Long：t7>+3 维持', () => {
  assert.equal(judge({ t7: 4, t14: 10, rangePos: 0.4, bounce: 1, drop: 1 }, 'Long'), 'Long');
});
check('judge Long：区间顶（pos>2/3）维持', () => {
  assert.equal(judge({ t7: 1, t14: 5, rangePos: 0.8, bounce: 1, drop: 3 }, 'Long'), 'Long');
});
check('judge Long：t7<-6 且 t14 翻负 → 强反转 Short', () => {
  assert.equal(judge({ t7: -6.1, t14: -1, rangePos: 0.4, bounce: 1, drop: 12 }, 'Long'), 'Short');
});
check('judge Long：t7=-4 → 弱反转 Neutral；回落>8% 同样 Neutral', () => {
  assert.equal(judge({ t7: -4, t14: 2, rangePos: 0.4, bounce: 1, drop: 1 }, 'Long'), 'Neutral');
  assert.equal(judge({ t7: 1, t14: 2, rangePos: 0.5, bounce: 1, drop: 9 }, 'Long'), 'Neutral');
});
check('judge Long：无命中 → 维持', () => {
  assert.equal(judge({ t7: -2, t14: 2, rangePos: 0.5, bounce: 1, drop: 5 }, 'Long'), 'Long');
});

// ---- judge：Neutral 指令 ----
check('judge Neutral：t7>+5 顺势 Long、t7<-5 顺势 Short', () => {
  assert.equal(judge({ t7: 6, t14: 1, rangePos: 0.5, bounce: 1, drop: 1 }, 'Neutral'), 'Long');
  assert.equal(judge({ t7: -6, t14: -1, rangePos: 0.5, bounce: 1, drop: 1 }, 'Neutral'), 'Short');
});
check('judge Neutral：|t7|<=5 维持 Neutral', () => {
  assert.equal(judge({ t7: 4.9, t14: 9, rangePos: 0.9, bounce: 9, drop: 9 }, 'Neutral'), 'Neutral');
});

// ---- judge：数据不完整 → 维持当前指令 ----
check('judge：metrics null / t7 NaN → 维持指令', () => {
  assert.equal(judge(null, 'Short'), 'Short');
  assert.equal(judge({ t7: NaN, t14: 1, rangePos: 0.9, bounce: 9, drop: 9 }, 'Neutral'), 'Neutral');
});

// ---- nextAdvice：streak 计数与切换 ----
check('nextAdvice：首轮（无存档）异向 → streak 1 不切换', () => {
  const { advice, switching } = nextAdvice({}, 'Long', 'Short', 'T1');
  assert.equal(advice.streak, 1);
  assert.equal(switching, false);
});
check('nextAdvice：与指令一致 → streak 清零', () => {
  const { advice } = nextAdvice({ rec: 'Long', streak: 3, directive: 'Short' }, 'Short', 'Short', 'T2');
  assert.equal(advice.streak, 0);
});
check('nextAdvice：同向累积', () => {
  const { advice } = nextAdvice({ rec: 'Long', streak: 2, directive: 'Short' }, 'Long', 'Short', 'T3');
  assert.equal(advice.streak, 3);
});
check('nextAdvice：判定方向变化 → 重置 1', () => {
  const { advice } = nextAdvice({ rec: 'Neutral', streak: 3, directive: 'Short' }, 'Long', 'Short', 'T4');
  assert.equal(advice.streak, 1);
});
check('nextAdvice：手动变更指令 → 计数器清零重数', () => {
  const { advice } = nextAdvice({ rec: 'Long', streak: 4, lastDirective: 'Short' }, 'Long', 'Neutral', 'T5');
  assert.equal(advice.streak, 0);
});
check(`nextAdvice：第 ${SWITCH_THRESHOLD} 次同向异指令 → switching 且 streak 归零`, () => {
  const { advice, switching } = nextAdvice({ rec: 'Long', streak: 4, directive: 'Short', lastDirective: 'Short' }, 'Long', 'Short', 'T6');
  assert.equal(switching, true);
  assert.equal(advice.streak, 0);
});
check('nextAdvice：streak 已是阈值但 rec 回到指令 → 不切换且清零', () => {
  const { advice, switching } = nextAdvice({ rec: 'Long', streak: 5, directive: 'Short' }, 'Short', 'Short', 'T7');
  assert.equal(switching, false);
  assert.equal(advice.streak, 0);
});

// ---- 接线形状 ----
const ROOT = path.join(__dirname, '..');
check('接线：入口走 with_lock --name direction 且导出 BG_PROXY', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts/direction_watch.sh'), 'utf8');
  assert.ok(sh.includes('--name direction'));
  assert.ok(sh.includes('export BG_PROXY'));
});
check('接线：launchd JOBS 注册 direction 每小时', () => {
  const py = fs.readFileSync(path.join(ROOT, 'scripts/install_launch_agents.py'), 'utf8');
  assert.ok(py.includes('"com.backpack-grid-direction.plist", "direction_watch.sh", 3600'));
});
check('接线：with_lock 白名单含 direction', () => {
  const py = fs.readFileSync(path.join(ROOT, 'scripts/with_lock.py'), 'utf8');
  assert.ok(py.includes('"round", "history", "research", "ledger", "direction"'));
});
check('接线：主流程切换经 grid_direction 版本事务', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/direction_watch.cjs'), 'utf8');
  assert.ok(src.includes('grid_direction.cjs'));
  assert.ok(src.includes('applyLocalSwitch(ROOT, key, directionBase, rec, advice.at)'));
  assert.ok(src.includes("directionTransaction(root, { op: 'local'"));
  assert.ok(src.includes('streak >= SWITCH_THRESHOLD'));
});
console.log(`${count} direction watch scenarios passed`);
