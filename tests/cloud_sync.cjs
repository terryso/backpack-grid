'use strict';
// cloud_sync.cjs 回归：同步决策全分支 / DASH_URL 解析 / 拉取失败保旧值 / 接线形状。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dashUrlOf, fetchCloudAdvice, planCloudSync } = require('../scripts/cloud_sync.cjs');
let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
const NOW = Date.parse('2026-11-21T12:00:00Z');
const fresh = (mins) => new Date(NOW - mins * 60000).toISOString();

check('planCloudSync：无数据/坏数据 → none(no-advice)', () => {
  assert.deepEqual(planCloudSync(null, 'Short', NOW), { action: 'none', reason: 'no-advice' });
  assert.deepEqual(planCloudSync({}, 'Short', NOW).reason, 'no-advice');
  assert.deepEqual(planCloudSync({ at: 'not-a-date' }, 'Short', NOW).reason, 'no-advice');
});
check('planCloudSync：超过 2h 过期 → none(stale)', () => {
  const r = planCloudSync({ at: fresh(121), rec: 'Long', switchingObserved: true }, 'Short', NOW);
  assert.deepEqual(r, { action: 'none', reason: 'stale' });
});
check('planCloudSync：新鲜无切换事件 → mirror-only', () => {
  const r = planCloudSync({ at: fresh(30), directive: 'Short', rec: 'Short', streak: 0 }, 'Short', NOW);
  assert.equal(r.action, 'mirror-only');
});
check('planCloudSync：switchingObserved + rec≠本地 → apply-switch', () => {
  const r = planCloudSync({ at: fresh(30), rec: 'Long', switchingObserved: true }, 'Short', NOW);
  assert.deepEqual(r, { action: 'apply-switch', switchTo: 'Long' });
});
check('planCloudSync：rec==本地（已代执行）→ mirror-only 幂等防重', () => {
  const r = planCloudSync({ at: fresh(30), rec: 'Long', switchingObserved: true }, 'Long', NOW);
  assert.equal(r.action, 'mirror-only');
});
check('planCloudSync：rec 非法值不放行切换', () => {
  const r = planCloudSync({ at: fresh(30), rec: 'SIDEWAYS', switchingObserved: true }, 'Short', NOW);
  assert.equal(r.action, 'mirror-only');
});
check('planCloudSync：maxAgeMs 可调（1h 窗口下 90min 即过期）', () => {
  const r = planCloudSync({ at: fresh(90), rec: 'Long', switchingObserved: true }, 'Short', NOW, 3600000);
  assert.deepEqual(r, { action: 'none', reason: 'stale' });
});

check('dashUrlOf：解析 DASH_URL；缺文件/缺行 → null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-cs-'));
  const f = path.join(d, 'dashboard.env');
  fs.writeFileSync(f, 'CF_ACCOUNT_ID=x\nDASH_URL=https://grid.example.dev\nDASH_WRITE_TOKEN=t\n');
  assert.equal(dashUrlOf(f, fs, path), 'https://grid.example.dev');
  fs.writeFileSync(f, 'DASH_WRITE_TOKEN=t\n');
  assert.equal(dashUrlOf(f, fs, path), null);
  assert.equal(dashUrlOf(path.join(d, 'missing.env'), fs, path), null);
});
check('fetchCloudAdvice：不可达地址 → null（保旧值语义）', () => {
  assert.equal(fetchCloudAdvice('http://127.0.0.1:1', require('node:child_process'), 2000), null);
});

// 接线形状：decide 集成同步 + 镜像写；Worker 双写权威 key
const ROOT = path.join(__dirname, '..');
check('接线：decide 拉云端/代执行切换/镜像写 direction_advice.json', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/decide.cjs'), 'utf8');
  assert.ok(src.includes('cloud_sync.cjs'));
  assert.ok(src.includes('CLOUD SWITCH'));
  assert.ok(src.includes('state/direction_advice.json'));
  assert.ok(src.includes('switchingObserved = true')); // 失败保留标记下轮重试
});
check('接线：Worker 影子判定双写 advice（权威）+ advice_cloud（兼容）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cloudflare/worker.js'), 'utf8');
  assert.ok(src.includes('DASH.put("advice"'));
  assert.ok(src.includes('DASH.put("advice_cloud"'));
  assert.ok(src.includes('source: "cloud"'));
});
console.log(`${count} cloud sync scenarios passed`);
