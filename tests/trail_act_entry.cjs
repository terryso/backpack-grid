'use strict';
// Actual act.mjs with a disposable account fixture and mock session I/O.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { dispatchSource, mockEgo, fixtureTask } = require('./ego_fixture.cjs');
const { hash } = require('../scripts/contracts.cjs');
const { positionRef } = require('../scripts/position_ref.cjs');
const { ownerStart } = require('../scripts/execution_lease.cjs');
const ROOT = path.join(__dirname, '..'), AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

async function run(mode) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-trail-act-entry-'));
  try {
    fs.mkdirSync(path.join(d, 'state')); fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true });
    if(mode==='issued-fsync-failure'){
      const file=path.join(d,'scripts/pending_store.cjs'),source=fs.readFileSync(file,'utf8');
      const hook="function write(data, durable) { if(durable && data.includes('\\\"trailPhase\\\": \\\"issued\\\"')) { const real=fs.fsyncSync;let calls=0;fs.fsyncSync=fd=>{const result=real(fd);if(++calls===2)throw Object.assign(Error('fixture fsync failure'),{code:'EIO'});return result;}; }";
      fs.writeFileSync(file,source.replace('function write(data, durable) {',hook));
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'))); cfg.watch = { spaceId: 7, page: 'p1' };
    const identity = { userId: 'fixture', subaccountId: 3, accountKey: 'fixture-3' }, at = new Date().toISOString(), runId = 'trail-' + mode;
    const original = { symbol: 'TEST_USDC_PERP', positionId: 'fixture-A', netQuantity: '1', markPrice: '100', estLiquidationPrice: '1' };
    const replacement = { ...original, positionId: 'fixture-B' }, expectedRef = positionRef(identity, original);
    const pendingMode = ['issued-replacement','prepared-flat','legacy-prepared-flat','legacy-midflight','breaker'].includes(mode);
    const action = { act: 'stop', market: 'TEST-PERP', range: [90, 110],
      reason: mode === 'breaker' ? 'circuit breaker: fixture' : 'AUTO_TRAIL: fixture',
      ...(mode === 'breaker' ? {} : { trailPositionRef: expectedRef }) };
    const put = (name, value) => fs.writeFileSync(path.join(d, name), typeof value === 'string' ? value : JSON.stringify(value));
    put('config.json', cfg); put('state/account_identity.json', identity); put('state/manual_pauses.json', {});
    put('state/run_context.json', { runId, identity, startedAt: at, ownerPid: process.pid, ownerStart: ownerStart(process.pid) });
    put('state/last_round_status', 'running'); put('state/actions.json', [action]);
    put('state/actions_meta.json', { runId, planId: 'plan-' + mode, identity, at, configHash: hash(cfg), actionsHash: hash([action]), riskWriteOk: true, subaccountId: 3 });
    if (pendingMode) put('state/pending_stops.json', { 'TEST-PERP': { accountKey: identity.accountKey, at, reason: 'AUTO_TRAIL: fixture',
      trailPositionRef: expectedRef, trailPhase: ['prepared-flat','legacy-prepared-flat','legacy-midflight'].includes(mode) ? 'prepared' : 'issued',
      ...(mode === 'prepared-flat' ? {trailIntentVersion:2} : {}) } });
    let grid = [{ symbol: original.symbol, enabled: true }], position = mode === 'replacement' || mode === 'issued-replacement' || mode === 'breaker' ? [replacement]
      : mode === 'missing-id' ? [{ ...original, positionId: undefined }] : ['prepared-flat','legacy-prepared-flat'].includes(mode) ? [] : [original];
    let positionReads = 0, patches = 0, deletes = 0;
    const page = { url: async () => 'https://backpack.exchange/portfolio/balances/assets', goto: async () => {}, waitForTimeout: async () => {},
      fetch: async (url, options = {}) => {
        const name = new URL(url).pathname; let body;
        if (options.method === 'PATCH') {
          patches++; const op = JSON.parse(options.body).params.symbols[0];
          if (op.operation === 'Delete') { deletes++; grid = []; }
          else { grid = [op]; position = []; }
          return { status: 200, body: '{}' };
        }
        if (name.endsWith('/collateral')) body = { 'fixture-3': { netEquity: 500, netEquityAvailable: 400 } };
        else if (name.endsWith('/automation')) body = { params: { symbols: structuredClone(grid) } };
        else if (name.endsWith('/position')) {
          positionReads++;
          if (['midflight-replacement','legacy-midflight'].includes(mode) && positionReads >= 2) position = [replacement];
          body = structuredClone(position);
        } else throw Error('unexpected fixture endpoint');
        return { status: 200, body: JSON.stringify(body) };
      } };
    let exit = 0, error = null;
    try {
      const source = dispatchSource(fs.readFileSync(path.join(ROOT, 'scripts/act.mjs'), 'utf8'), d);
      await new AsyncFunction('ego', 'taskSpace', 'process', 'console', source)(mockEgo(d), async () => fixtureTask(d, page),
        { exit(c) { throw Object.assign(Error('fixture exit'), { exit: c }); } }, { log() {} });
    } catch (e) { if (e.exit !== undefined) exit = e.exit; else error = e.message; }
    const resultText = fs.readFileSync(path.join(d, 'state/act_results.json'), 'utf8');
    const pendingFile = path.join(d, 'state/pending_stops.json');
    return { exit, error, patches, deletes, pending: fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile)) : null,
      result: JSON.parse(resultText), referenceLeakedIntoResults: resultText.includes(expectedRef) };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

(async () => {
  for (const mode of ['match', 'replacement', 'missing-id', 'midflight-replacement', 'issued-replacement', 'prepared-flat', 'legacy-prepared-flat', 'legacy-midflight', 'issued-fsync-failure', 'breaker']) {
    const r = await run(mode); assert.equal(r.error, null); assert.equal(r.referenceLeakedIntoResults, false);
    if (mode === 'match' || mode === 'breaker') {
      assert.equal(r.exit, 0); assert.equal(r.patches, 2); assert.equal(r.deletes, 1); assert.deepEqual(r.pending, {});
    } else {
      assert.equal(r.exit, 2); assert.equal(r.patches, 0); assert.equal(r.deletes, 0);
      if (mode === 'midflight-replacement') assert.equal(r.pending['TEST-PERP'].trailPhase, 'prepared');
      if (mode === 'issued-replacement') assert.equal(r.pending['TEST-PERP'].trailPhase, 'issued');
      if (mode === 'prepared-flat') assert.deepEqual(r.pending, {});
      if (mode === 'legacy-prepared-flat') assert.equal(r.pending['TEST-PERP'].trailPhase,'prepared');
      if (mode === 'legacy-midflight') { assert.equal(r.pending['TEST-PERP'].trailPhase,'issued');assert.equal(r.pending['TEST-PERP'].trailIntentVersion,undefined); }
      if (mode === 'issued-fsync-failure') { assert.equal(r.pending['TEST-PERP'].trailPhase,'issued');assert.equal(r.pending['TEST-PERP'].trailIntentVersion,2); }
      if (mode === 'replacement' || mode === 'missing-id') assert.equal(r.pending, null);
    }
    console.log('PASS actual act entrypoint trailing identity: ' + mode);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
