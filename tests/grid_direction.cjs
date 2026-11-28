'use strict';
// 手动方向指令验收：指令文件语义（默认 Neutral/全局/单市场优先/外账户忽略/坏文件退化/
// 非法方向拒绝/Neutral 即清除）+ decide/act/contracts 接线形状断言。
// act 侧行为测试见 browser_alignment 的 directional-create 场景（Short 指令端到端建格）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const { loadDirections, directionFor, directionDecision, directionHealth, setDirection } = require('../scripts/grid_direction.cjs');
const { spawnSync } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json')));
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

const chainValues = { BTC:'Long', ETH:'Neutral', SOL:'Short', BNB:'Long', SUI:'Neutral', HYPE:'Short', TRX:'Long' };
function chainFixture(at = new Date().toISOString()) {
  const d = fixture();
  const chains = Object.fromEntries(Object.entries(chainValues).map(([c, v]) => [c, { judgment:v, direction:v }]));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(d, 'state/account_identity.json'), JSON.stringify({userId:'fixture',subaccountId:3,accountKey:'fixture-3'}));
  fs.writeFileSync(path.join(d, 'state/direction_override.json'), JSON.stringify({
    schemaVersion:1, accountKey:'fixture-3', directions:{ '*':'Short' }, chainSnapshot:{id:'fixture',asOf:at,chains},
  }));
  return d;
}
test('all configured ecosystem members inherit the correct chain in both symbol formats', () => {
  const d = chainFixture(), eco = {btc:'BTC',eth_l1:'ETH',solana:'SOL',sui:'SUI',bnb:'BNB',hyperliquid:'HYPE',tron:'TRX'};
  for (const [name, chain] of Object.entries(eco)) for (const symbol of cfg.ecosystems[name]) {
    for (const suffix of ['-PERP','_USDC_PERP']) assert.equal(directionFor(d, 'fixture-3', symbol + suffix, cfg), chainValues[chain], symbol + suffix);
  }
});
test('missing, malformed or ambiguous ecosystems block every new direction', () => {
  const d = chainFixture(), dup = structuredClone(cfg);
  dup.ecosystems.eth_l1.push('PENGU');
  const noRoot = structuredClone(cfg); noRoot.ecosystems.solana = ['PENGU'];
  const badList = structuredClone(cfg); badList.ecosystems.solana = 'SOL';
  const missingGroup = structuredClone(cfg); delete missingGroup.ecosystems.solana;
  for (const c of [{...cfg,ecosystems:undefined},{...cfg,ecosystems:null},dup,noRoot,badList,missingGroup]) {
    assert.equal(directionDecision(d, 'fixture-3', 'PENGU-PERP', c).reason, 'invalid-ecosystems');
    assert.equal(directionDecision(d, 'fixture-3', 'BTC-PERP', c).blocked, true);
  }
});
test('unmapped markets cannot inherit a global or per-market override after a snapshot', () => {
  const d = chainFixture(), c = structuredClone(cfg);
  c.ecosystems.solana = c.ecosystems.solana.filter(s => s !== 'PENGU');
  const state = path.join(d,'state/direction_override.json'), reg = JSON.parse(fs.readFileSync(state));
  reg.directions['PENGU-PERP'] = 'Long'; fs.writeFileSync(state,JSON.stringify(reg));
  assert.deepEqual(directionDecision(d,'fixture-3','PENGU-PERP',c),{direction:'Neutral',source:'chain',blocked:true,reason:'unmapped-market'});
  assert.equal(directionFor(d,'fixture-3','UNKNOWN-PERP',cfg),'Neutral');
});
test('snapshot freshness is enforced at both boundaries and fails closed on corrupt state', () => {
  const time = Date.parse('2026-11-28T12:00:00.000Z'), d = chainFixture(new Date(time).toISOString());
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg,time+7200000).direction,'Long');
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg,time+7200001).reason,'expired-snapshot');
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg,time-60000).direction,'Long');
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg,time-60001).reason,'future-snapshot');
  fs.writeFileSync(path.join(d,'state/direction_override.json'),'{broken');
  assert.equal(directionHealth(d,'fixture-3',cfg).reason,'invalid-direction-state');
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).blocked,true);
});
test('a newer deferred event blocks creates even while the prior snapshot is fresh', () => {
  const d=chainFixture(), file=path.join(d,'state/direction_override.json'),reg=JSON.parse(fs.readFileSync(file));
  reg.lastCloudEvent={id:'newer',status:'deferred',reason:'future-time'};fs.writeFileSync(file,JSON.stringify(reg));
  assert.equal(directionHealth(d,'fixture-3',cfg).reason,'pending-snapshot');
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).blocked,true);
  delete reg.chainSnapshot;fs.writeFileSync(file,JSON.stringify(reg));
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).reason,'pending-snapshot');
  reg.lastCloudEvent={id:'newer',status:'applied'};fs.writeFileSync(file,JSON.stringify(reg));
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).direction,'Short');
  reg.chainAuthority=true;fs.writeFileSync(file,JSON.stringify(reg));
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).reason,'missing-snapshot');
  reg.chainAuthority=false;fs.writeFileSync(file,JSON.stringify(reg));
  assert.equal(directionDecision(d,'fixture-3','BTC-PERP',cfg).reason,'invalid-direction-state');
});
test('manual CLI reports the effective chain direction and does not claim the stored override won', () => {
  const d = chainFixture(), env = {...process.env,BG_ROOT:d};
  const cli = (...args) => spawnSync(process.execPath,[path.join(ROOT,'scripts/grid_direction.cjs'),...args],{env,encoding:'utf8'});
  const set = cli('set','BTC-PERP','Short');
  assert.equal(set.status,0,set.stderr); assert.match(set.stdout,/stored as Short/);
  assert.match(set.stdout,/effective Long from BTC snapshot/); assert.match(set.stdout,/snapshot takes precedence/);
  const show = cli('show','BTC-PERP'); assert.equal(show.status,0,show.stderr);
  const result = JSON.parse(show.stdout);
  assert.equal(result.markets['BTC-PERP'],'Short'); assert.equal(result.authority,'chain_snapshot');
  assert.equal(result.effective.direction,'Long'); assert.equal(result.effective.chain,'BTC');
  assert.equal(result.chainSnapshot.chains.BTC.direction,'Long');
  const clear=cli('clear','BTC-PERP');assert.equal(clear.status,0,clear.stderr);
  assert.match(clear.stdout,/override cleared/);assert.match(clear.stdout,/effective Long from BTC snapshot/);
});
test('manual CLI explains when an applied snapshot is too old for new grids', () => {
  const d=chainFixture(new Date(Date.now()-7201000).toISOString()),env={...process.env,BG_ROOT:d};
  const set=spawnSync(process.execPath,[path.join(ROOT,'scripts/grid_direction.cjs'),'set','BTC-PERP','Short'],{env,encoding:'utf8'});
  assert.equal(set.status,0,set.stderr);assert.match(set.stdout,/new grids blocked \(expired-snapshot\)/);
  const show=spawnSync(process.execPath,[path.join(ROOT,'scripts/grid_direction.cjs'),'show','BTC-PERP'],{env,encoding:'utf8'});
  assert.equal(show.status,0,show.stderr);
  const state=JSON.parse(show.stdout);assert.equal(state.snapshotHealth.reason,'expired-snapshot');
  assert.equal(state.effective.blocked,true);
});

// ---- 接线形状 ----
const actSrc = fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8');
test('act rechecks the directive at execution time', () => {
  assert(actSrc.includes('directionDecision(ROOT, identity.accountKey, action.market, cfg)'));
  assert(actSrc.includes('issuePreparedCreateIntent(a, expectedIntent)'));
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
