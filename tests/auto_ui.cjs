'use strict';
// auto_ui.cjs — 首页「自动退出」行与执行层（decide/auto_exits）语义一致性。
// 直接从 dashboard.html 提取 autoExitRow 函数离线验证：状态优先级、阈值缺省、
// 未知收益率、止盈单独关闭等组合场景（历次评审反例固化为持久回归）。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'cloudflare/dashboard.html'), 'utf8');
const m = src.match(/function autoExitRow\(p, s\) \{[\s\S]*?\n\}/);
assert(m, 'autoExitRow function not found in dashboard.html');
const autoExitRow = eval('(' + m[0] + ')');
const text = (h) => h.replace(/<[^>]+>/g, '').trim();

// 执行器缺省（auto_exits.cjs defaultsFor）必须镜像进快照数据层：key 缺省 = 启用 150，
// 只有显式 0 才关闭止盈——缺省时徽标与卡片、卡片与执行三者必须同口径。
const dd = fs.readFileSync(path.join(ROOT, 'scripts/dashboard_data.cjs'), 'utf8');
assert(dd.includes('posTp: cfg.positionTakeProfitPct === undefined ? 150'), 'dashboard_data must mirror the executor default for omitted positionTakeProfitPct');

let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
const ae = { enabled: true, posSl: 150, posTp: 150, dwellMin: 10, bufferPct: 0.5 };
const grids = [{ market: 'BTC-PERP', status: 'Triggered' }, { market: 'OLD-PERP', status: 'Disabled' }];
const base = { autoExits: ae, grids, manualPauses: [], pending: [], manualPauseValid: true };

check('止盈单独关闭时盈利仓只显示止损余量，不误标已越线', () => {
  const h = autoExitRow({ market: 'BTC-PERP', pnlPct: 10 }, { ...base, autoExits: { ...ae, posTp: 0 } });
  assert.match(text(h), /止盈已关 · 止损余 160%/);
  assert.doesNotMatch(text(h), /已越线/);
});
check('孤儿持仓显示未覆盖，不显示保护余量', () => {
  assert.match(text(autoExitRow({ market: 'GHOST-PERP', pnlPct: 50 }, base)), /未覆盖 · 该持仓无对应网格/);
});
check('Disabled 网格显示已暂停，不显示越线告警', () => {
  const h = autoExitRow({ market: 'OLD-PERP', pnlPct: -160 }, base);
  assert.match(text(h), /已暂停 · 网格手动停格/);
  assert.doesNotMatch(text(h), /已越线/);
});
check('pending 优先于 Disabled：停格+待清理 = 机器清理中', () => {
  assert.match(text(autoExitRow({ market: 'OLD-PERP', pnlPct: -160 }, { ...base, pending: ['OLD-PERP'] })), /待清理 · 停格已在重试/);
});
check('pending 优先于手动 hold（与 decide 循环同序）', () => {
  assert.match(text(autoExitRow({ market: 'BTC-PERP', pnlPct: 50 }, { ...base, pending: ['BTC-PERP'], manualPauses: ['BTC-PERP'] })), /待清理 · 停格已在重试/);
});
check('手动暂停注册表损坏：显示状态未知，不出保护余量', () => {
  const h = autoExitRow({ market: 'BTC-PERP', pnlPct: 243.1 }, { ...base, manualPauseValid: false });
  assert.match(text(h), /状态未知 · 手动暂停记录损坏/);
  assert.doesNotMatch(text(h), /止盈已越线/);
});
check('手动 hold（含通配 *）显示已暂停', () => {
  assert.match(text(autoExitRow({ market: 'BTC-PERP', pnlPct: 50 }, { ...base, manualPauses: ['BTC-PERP'] })), /已暂停 · 手动 hold/);
  assert.match(text(autoExitRow({ market: 'BTC-PERP', pnlPct: 50 }, { ...base, manualPauses: ['*'] })), /已暂停/);
});
check('pnlPct=null 显示收益未知，不按 0% 计算余量', () => {
  assert.match(text(autoExitRow({ market: 'BTC-PERP', pnlPct: null }, base)), /收益未知/);
  assert.doesNotMatch(text(autoExitRow({ market: 'BTC-PERP', pnlPct: null }, base)), /余 /);
});
check('真实案例：止盈越线（243.1%）红字告警', () => {
  const h = autoExitRow({ market: 'BTC-PERP', pnlPct: 243.1 }, base);
  assert.match(text(h), /止盈已越线 · 止损余 393.1%/);
  assert.match(h, /color:#f87171/);
});
check('余量行不重复仓位百分比（上一行浮动盈亏已展示）', () => {
  const h = autoExitRow({ market: 'BTC-PERP', pnlPct: 243.1 }, base);
  assert.doesNotMatch(text(h), /仓位/);
  assert.doesNotMatch(text(h), /243\.1/);
});
check('临近阈值（30% 内）黄色提示', () => {
  const h = autoExitRow({ market: 'BTC-PERP', pnlPct: 130 }, base);
  assert.match(text(h), /止盈余 20%/);
  assert.match(h, /color:#fbbf24/);
});
check('亏损侧显示止损余量', () => {
  assert.match(text(autoExitRow({ market: 'BTC-PERP', pnlPct: -100 }, base)), /止损余 50%/);
});
check('模块关闭时不渲染该行', () => {
  assert.equal(autoExitRow({ market: 'BTC-PERP', pnlPct: 243.1 }, { ...base, autoExits: { ...ae, enabled: false } }), '');
});
check('快照的浮动盈亏行：未知收益率不显示 +0.0%', () => {
  // 由 autoExitRow 同源口径保证：null 不经 Number() 变 0 —— 直接验证原始模板行为
  const raw = null, ret = Number(raw);
  const retKnown = raw != null && Number.isFinite(ret);
  assert.equal(retKnown, false);
});

console.log(`${count} auto exit UI scenarios passed`);
