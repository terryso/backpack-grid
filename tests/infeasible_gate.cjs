'use strict';
// 不可行市场降级门控验收：infeasible.cjs 单元语义（身份绑定/过期/损坏/剪枝）+
// act/decide 接线的源码形状断言。act 侧行为测试见 browser_alignment 的
// infeasible-create 场景（mock validate 422，全流程断言注册表与 pending 无污染）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const { loadInfeasible, writeDemotion, COOLOFF_HOURS } = require('../scripts/infeasible.cjs');
let count = 0; const test = (name, fn) => { fn(); count++; console.log('PASS', name); };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-infeasible-'));
const fixture = () => { const d = fs.mkdtempSync(path.join(base, 'case-')); fs.mkdirSync(path.join(d, 'state')); return d; };
const HOUR = 3600000;

test('missing table reads as empty', () => {
  const d = fixture();
  assert.deepEqual(loadInfeasible(d, 'acct-3'), {});
});
test('write then load roundtrips entry with reason and until', () => {
  const d = fixture(), now = Date.now();
  const e = writeDemotion(d, 'acct-3', 'KPEPE-PERP', 'infeasible: allocation_usd: below minimum of 20080', now);
  assert.match(e.until, /^20\d\d-/);
  const got = loadInfeasible(d, 'acct-3', now);
  assert.equal(got['KPEPE-PERP'].reason, 'infeasible: allocation_usd: below minimum of 20080');
  assert.equal(Date.parse(got['KPEPE-PERP'].until), now + COOLOFF_HOURS * HOUR);
});
test('expired entries are not enforced and get pruned on next write', () => {
  const d = fixture(), now = Date.now();
  writeDemotion(d, 'acct-3', 'OLD-PERP', 'stale wall', now - 25 * HOUR);
  assert.deepEqual(loadInfeasible(d, 'acct-3', now), {}); // 过期即失效
  writeDemotion(d, 'acct-3', 'NEW-PERP', 'wall', now); // 写入顺带剪枝
  const raw = JSON.parse(fs.readFileSync(path.join(d, 'state/infeasible_markets.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw.markets), ['NEW-PERP']); // OLD 已被清理
});
test('foreign account table is ignored entirely', () => {
  const d = fixture(), now = Date.now();
  writeDemotion(d, 'other-3', 'KPEPE-PERP', 'wall', now);
  assert.deepEqual(loadInfeasible(d, 'acct-3', now), {});
});
test('corrupt table reads as empty and is self-healed by next write', () => {
  const d = fixture(), now = Date.now();
  fs.writeFileSync(path.join(d, 'state/infeasible_markets.json'), '{broken');
  assert.deepEqual(loadInfeasible(d, 'acct-3', now), {}); // 坏表绝不阻断规划
  writeDemotion(d, 'acct-3', 'KPEPE-PERP', 'wall', now);
  assert(loadInfeasible(d, 'acct-3', now)['KPEPE-PERP']); // 原子写自愈覆盖
});
test('identity drift invalidates the whole table (never reuse wrong-account conclusions)', () => {
  const d = fixture(), now = Date.now();
  writeDemotion(d, 'acct-3', 'KPEPE-PERP', 'wall', now);
  const raw = JSON.parse(fs.readFileSync(path.join(d, 'state/infeasible_markets.json'), 'utf8'));
  raw.accountKey = 'drifted-3';
  fs.writeFileSync(path.join(d, 'state/infeasible_markets.json'), JSON.stringify(raw));
  assert.deepEqual(loadInfeasible(d, 'acct-3', now), {});
});
test('atomic write leaves no tmp residue', () => {
  const d = fixture();
  writeDemotion(d, 'acct-3', 'X-PERP', 'wall');
  assert(!fs.existsSync(path.join(d, 'state/infeasible_markets.json.tmp')));
});

// ---- 接线形状：act 降级在 write-ahead intent 之前（validate 拒绝不得留下 pending）----
const actSrc = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8');
test('act demotes only on definitive validate rejection, inside the vErr branch', () => {
  assert(/if \(vErr\) \{\s*writeDemotion\(ROOT, identity\.accountKey, a\.market, vErr\)/.test(actSrc));
  assert(actSrc.includes('if (vb.errorField)')); // 200+errorField 也算确定性拒绝
  assert(actSrc.includes('validate response unreadable')); // 200 但 body 不可解析 → 不降级、不放行
});
test('act demotion precedes the write-ahead create intent', () => {
  const demote = actSrc.indexOf('writeDemotion(ROOT');
  const intent = actSrc.indexOf('WRITE-AHEAD create intent');
  assert(demote !== -1 && intent !== -1 && demote < intent);
});
test('decide skips demoted markets before any other candidate gate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/decide.cjs'), 'utf8');
  assert(src.includes('loadInfeasible(ROOT, identity.accountKey)'));
  const skip = src.indexOf('infeasible until');
  const liquidity = src.indexOf('liquidity below configured minimum');
  assert(skip !== -1 && liquidity !== -1 && skip < liquidity); // 降级市场不消耗任何检查
});
console.log(count + ' infeasible gate scenarios passed');
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
