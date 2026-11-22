'use strict';
// Exercise the production snapshot and the production dashboard renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-drawdown-ui-'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' };
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS', name); };

function snapshot(config, equity = 500, peak = 1000) {
  const dir = fs.mkdtempSync(path.join(base, 'case-')), at = new Date().toISOString();
  fs.mkdirSync(path.join(dir, 'state'));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write('config.json', config);
  write('state/account_identity.json', identity);
  write('state/observed.json', { identity, at, gridRows: [], positions: [], ledger: [], margin: { totalEquity: equity, availableEquity: equity } });
  write('state/risk.json', { accountKey: identity.accountKey, peakEquity: peak, paused: null });
  write('state/risk_write_status.json', { at, ok: true });
  fs.writeFileSync(path.join(dir, 'state/last_round_status'), 'ok');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dashboard_data.cjs')],
    { env: { ...process.env, BG_ROOT: dir }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(path.join(dir, 'state/dashboard.json'), 'utf8'));
}

const html = fs.readFileSync(path.join(ROOT, 'cloudflare/dashboard.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('function markLiked()')[0];
function render(value) {
  const elements = new Map();
  const document = { hidden: true, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { remove() {}, toggle() {} } });
    return elements.get(id);
  } };
  const context = { document, window: {}, fetch: async () => ({ ok: false }), snapshot: value };
  vm.runInNewContext(script + '\nrender(snapshot);', context);
  return elements.get('content').innerHTML;
}

try {
  const configured = { ...cfg, subaccountId: 3, riskBudgetPct: 100, warnDrawdownPct: 90 };
  const healthy = snapshot(configured);
  check('snapshot carries the validated account-bound warning threshold', () => assert.equal(healthy.warnDrawdownPct, 90));
  check('50% drawdown does not trigger a 90% strategy warning', () => {
    const text = render(healthy); assert.match(text, /风控正常/); assert.doesNotMatch(text, /回撤预警 50/);
  });
  check('threshold boundary triggers the configured warning', () => {
    const text = render(snapshot(configured, 100)); assert.match(text, /回撤预警 90\.0%（阈值 90\.0%）/);
  });
  check('zero warning threshold remains an explicit valid threshold', () => {
    const s = snapshot({ ...configured, warnDrawdownPct: 0 }, 1000); assert.equal(s.warnDrawdownPct, 0); assert.match(render(s), /回撤预警 0\.0%/);
  });
  for (const invalid of [undefined, null, false, '', '90', 101]) check('invalid threshold is unknown: ' + String(invalid), () => {
    const s = snapshot({ ...configured, warnDrawdownPct: invalid }); assert.equal(s.warnDrawdownPct, null);
    const text = render(s); assert.match(text, /回撤预警状态待核对/); assert.doesNotMatch(text, /风控正常/);
  });
  check('foreign configuration cannot advertise a warning threshold', () => assert.equal(snapshot({ ...configured, userId: 'other' }).warnDrawdownPct, null));
  check('legacy snapshot without the threshold remains unknown', () => {
    const s = { ...healthy }; delete s.warnDrawdownPct; assert.match(render(s), /回撤预警状态待核对/);
  });
  check('missing drawdown or latch does not become healthy', () => {
    for (const s of [{ ...healthy, drawdownPct: null }, { ...healthy, riskPaused: null }]) {
      const text = render(s); assert.match(text, /回撤预警状态待核对/); assert.doesNotMatch(text, /风控正常/);
    }
  });
  check('latched breaker retains priority even when the threshold is unknown', () => assert.match(render({ ...healthy, riskPaused: true, warnDrawdownPct: null }), /风控熔断已锁/));
  console.log(`${count} drawdown display scenarios passed`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
