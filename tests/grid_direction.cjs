'use strict';
// 手动方向指令验收：指令文件语义（默认 Neutral/全局/单市场优先/外账户忽略/坏文件退化/
// 非法方向拒绝/Neutral 即清除）+ decide/act/contracts 接线形状断言。
// act 侧行为测试见 browser_alignment 的 directional-create 场景（Short 指令端到端建格）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const { loadDirections, directionFor, setDirection } = require('../scripts/grid_direction.cjs');
let count = 0; const test = (name, fn) => { fn(); count++; console.log('PASS', name); };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-gdir-'));
const fixture = () => { const d = fs.mkdtempSync(path.join(base, 'case-')); fs.mkdirSync(path.join(d, 'state')); return d; };

test('no directive file reads as Neutral everywhere', () => {
  const d = fixture();
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Neutral');
  assert.deepEqual(loadDirections(d, 'acct-3'), {});
});
test('global * directive applies to every market', () => {
  const d = fixture();
  setDirection(d, 'acct-3', '*', 'Short');
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Short');
  assert.equal(directionFor(d, 'acct-3', 'BNB-PERP'), 'Short');
});
test('per-market directive beats the global one', () => {
  const d = fixture();
  setDirection(d, 'acct-3', '*', 'Short');
  setDirection(d, 'acct-3', 'ETH-PERP', 'Long');
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Long');
  assert.equal(directionFor(d, 'acct-3', 'SOL-PERP'), 'Short');
});
test('set Neutral on a market removes only that entry (global stays)', () => {
  const d = fixture();
  setDirection(d, 'acct-3', '*', 'Short');
  setDirection(d, 'acct-3', 'ETH-PERP', 'Long');
  setDirection(d, 'acct-3', 'ETH-PERP', 'Neutral');
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Short'); // 回落继承全局
  assert.equal(directionFor(d, 'acct-3', '*'), 'Short');
});
test('foreign account table ignored entirely', () => {
  const d = fixture();
  setDirection(d, 'other-3', '*', 'Short');
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Neutral');
});
test('corrupt file degrades to Neutral', () => {
  const d = fixture();
  fs.writeFileSync(path.join(d, 'state/direction_override.json'), '{broken');
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Neutral');
  setDirection(d, 'acct-3', '*', 'Long'); // 原子写自愈覆盖
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Long');
});
test('invalid direction refused, table untouched', () => {
  const d = fixture();
  setDirection(d, 'acct-3', '*', 'Short');
  assert.throws(() => setDirection(d, 'acct-3', 'ETH-PERP', 'up'), /invalid direction/);
  assert.equal(directionFor(d, 'acct-3', 'ETH-PERP'), 'Short');
});
test('atomic write leaves no tmp residue', () => {
  const d = fixture();
  setDirection(d, 'acct-3', '*', 'Long');
  assert(!fs.existsSync(path.join(d, 'state/direction_override.json.tmp')));
});

// ---- 接线形状 ----
const actSrc = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8');
test('act reads the directive at execution time and no longer hardcodes Neutral', () => {
  assert(actSrc.includes('directionFor(ROOT, identity.accountKey, a.market)'));
  assert(actSrc.includes('direction: a.direction'));
  assert(!actSrc.includes('direction: "Neutral"'));
});
const decSrc = fs.readFileSync(path.join(ROOT, 'scripts/decide.cjs'), 'utf8');
test('decide stamps the directive into create actions', () => {
  assert(decSrc.includes('direction: dir'));
  assert(decSrc.includes('dir=${dir}')); // PLAN 行可见，ops 页可审计
});
const conSrc = fs.readFileSync(path.join(ROOT, 'scripts/contracts.cjs'), 'utf8');
test('confirmation compares against the planned direction, not a literal Neutral', () => {
  assert(conSrc.includes('entry.direction===(plan.direction||\'Neutral\')'));
  assert(!/entry\.direction==='Neutral'/.test(conSrc));
});
console.log(`${count} grid direction scenarios passed`);
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
