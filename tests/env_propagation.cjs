'use strict';
// Full launchd entry -> kernel lock -> runner -> decide -> real risk writer.
// Browser and upload are mocked; all files live in a disposable fixture.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ROOT, PY } = require('./env.cjs');
const quote = v => "'" + v.replace(/'/g, "'\\''") + "'";
function run() {
  assert.equal(PY, '/Users/nick/.browser-use-env/bin/python3');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-interpreter-'));
  let count = 0;
  const check = (name, fn) => { fn(); count++; console.log('PASS', name); };
  try {
    for (const trip of [false, true]) {
      const dir = path.join(base, trip ? 'trip' : 'healthy');
      fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
      const put = (name, x) => fs.writeFileSync(path.join(dir, name), JSON.stringify(x));
      const get = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
      put('config.json', JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'))));
      put('state/account_identity.json', { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' });
      put('state/risk.json', { peakEquity: 1000, paused: null, accountKey: 'fixture-3' });
      const nodeBin = path.join(dir, 'bin/node');
      fs.writeFileSync(path.join(dir, '.env'), 'PY_BIN=' + quote(PY) + '\nNODE_BIN=' + quote(nodeBin) + '\n');
      const guard = path.join(dir, 'interpreter_guard.cjs');
      fs.writeFileSync(guard, `
const fs=require('node:fs'),cp=require('node:child_process');
const original=cp.spawnSync;
cp.spawnSync=(command,args,options)=>{
  if(args?.[0]?.endsWith('/risk_write.py')){
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'requested.jsonl'))},JSON.stringify({command,configured:process.env.PY_BIN??null,nodeConfigured:process.env.NODE_BIN??null})+'\\n');
    if(command!==${JSON.stringify(PY)})return {status:1,stderr:'TEST_UNCONFIGURED_INTERPRETER_BLOCKED',stdout:''};
  }
  return original(command,args,options);
};`);
      fs.writeFileSync(nodeBin, '#!/bin/bash\nexec ' + quote(process.execPath) + ' --require ' + quote(guard) + ' "$@"\n', { mode: 0o755 });
      const observe = path.join(dir, 'mock_observe.cjs');
      fs.writeFileSync(observe, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'state/observed.json'))},JSON.stringify({at:new Date().toISOString(),identity:{userId:'fixture',subaccountId:3,accountKey:'fixture-3'},gridRows:[],positions:[],ledger:[],badges:{},margin:{totalEquity:${trip ? "'100'" : "'1000'"},availableEquity:'100',openPnl:'0'}}));`);
      fs.writeFileSync(path.join(dir, 'bin/ego-browser'), '#!/bin/bash\n/bin/cat >/dev/null\nexec ' + quote(process.execPath) + ' ' + quote(observe) + '\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'scripts/upload_dashboard.sh'), '#!/bin/bash\nexit 0\n');
      const env = { ...process.env, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', DRYRUN: '1', BG_OFFLINE: '1', NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'tests/no_network.cjs')) };
      // launchd does not inherit the test harness's already-exported configuration.
      for (const key of ['PY_BIN', 'NODE_BIN', 'BG_ROOT', 'BG_LOCKED', 'BG_PHASE', 'BG_TICKERS_FILE']) delete env[key];
      const result = spawnSync('/bin/bash', ['scripts/round_locked.sh'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
      const requests = fs.readFileSync(path.join(dir, 'requested.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const tag = trip ? 'breaker trip' : 'healthy';
      check('production runner exports configured interpreter: ' + tag, () => { assert.equal(requests.length, 1); assert.equal(requests[0].command, PY); assert.equal(requests[0].configured, PY); assert.equal(requests[0].nodeConfigured, nodeBin); });
      check('configured risk writer commits in fixture: ' + tag, () => { assert.equal(result.status, 0, result.stderr); assert.equal(get('state/risk_write_status.json').ok, true); assert(!result.stdout.includes('RISK WRITE FAILED')); });
      check('runner dry-run and identity-bound plan preserved: ' + tag, () => { assert.equal(fs.readFileSync(path.join(dir, 'state/last_round_status'), 'utf8').trim(), 'dryrun'); assert.equal(get('state/actions_meta.json').identity.accountKey, 'fixture-3'); assert.equal(get('state/act_results.json').status, 'not_started'); });
      check('kernel lock released after runner: ' + tag, () => {
        const lock = spawnSync(PY, [path.join(dir, 'scripts/with_lock.py'), '/usr/bin/true'], { cwd: dir, env: { ...env, BG_ROOT: dir }, encoding: 'utf8', timeout: 10000 });
        assert.equal(lock.status, 0, lock.stderr); assert(fs.existsSync(path.join(dir, 'state/round.lock')));
      });
      if (trip) check('trip latch persists under configured writer', () => assert(get('state/risk.json').paused));
      else check('healthy fixture has no false latch', () => assert.equal(get('state/risk.json').paused, null));
    }
    return count;
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
module.exports = { run };
if (require.main === module) { try { console.log(run() + ' interpreter propagation cases passed'); } catch (e) { console.error(e); process.exitCode = 1; } }
