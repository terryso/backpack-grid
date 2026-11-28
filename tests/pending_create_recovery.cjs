'use strict';
// Execute production decide/act over isolated fixtures. All exchange I/O is mocked.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {PY}=require('./env.cjs');
const {dispatchSource,mockEgo,fixtureTask}=require('./ego_fixture.cjs');
const {run:firstRound}=require('./browser_alignment.cjs');
const {ownerStart}=require('../scripts/execution_lease.cjs');
const {makeStopGrid}=require('../scripts/act_core.cjs');
const {positionRef}=require('../scripts/position_ref.cjs');
const ROOT=path.join(__dirname,'..'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const market='UNI-PERP',symbol='UNI_USDC_PERP',identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'};

function fixture(intent,{present=true,risk=false,autoRisk=false,stopTimeoutOnce=false,keepPositionOnTimeout=false,stopResponseLostOnce=false,deleteResponseLostOnce=false,replaceBeforeDelete=false,positionId='current',tripBreaker=false}={}) {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-create-recovery-'));
  fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
  const cfg={...JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json'))),autoExitsEnabled:autoRisk,
    positionStopLossPct:100,positionTakeProfitPct:0,accountFloorUsd:0,...(tripBreaker?{riskBudgetPct:60,warnDrawdownPct:40}:{})};
  const put=(name,value)=>fs.writeFileSync(path.join(d,name),JSON.stringify(value));
  put('config.json',cfg);put('state/account_identity.json',identity);
  put('state/risk.json',{accountKey:identity.accountKey,peakEquity:tripBreaker?3000:1000,paused:null});
  put('state/pending_stops.json',{[market]:intent});
  const grid={market,symbol,direction:'Short',range:[90,110],price:'100',status:'Triggered',allocationRaw:1000,
    pnlRaw:risk?-100:0,pnlPct:risk?-10:0,nativeTP:cfg.takeProfitPct,nativeSL:cfg.stopLossPct,nativeCloseOnStop:true};
  const observed={at:new Date().toISOString(),identity,gridRows:present?[grid]:[],
    positions:present?[{market,symbol,size:'-1',mark:'100',liq:'150',pnlPct:autoRisk?-101:0,fundingRaw:0}]:[],
    ledger:[],margin:{totalEquity:'1000',availableEquity:'500',openPnl:'0'}};
  put('state/observed.json',observed);
  let automation=present?[{symbol,enabled:true,allocationUsd:'1000',priceLow:'90',priceHigh:'110',levels:20,
    direction:'Short',takeProfitPercentage:cfg.takeProfitPct,stopLossPercentage:cfg.stopLossPct,closePositionsOnStop:true}]:[];
  let positions=present?[{symbol,netQuantity:'-1',markPrice:'100',estLiquidationPrice:'150',
    userId:identity.userId,subaccountId:identity.subaccountId,...(positionId ? {positionId} : {})}]:[];
  if(positions[0]) observed.positionRefs={[market]:positionRef(identity,positions[0])};
  const patches=[];let round=0,failWait=stopTimeoutOnce,lostStop=stopResponseLostOnce,lostDelete=deleteResponseLostOnce,afterDisableReads=0;
  const page={async url(){return 'https://backpack.exchange/portfolio/balances/assets';},async goto(){},async waitForTimeout(){
      if(failWait){failWait=false;if(!keepPositionOnTimeout)positions=[];throw Error('fixture poll timeout');}
    },
    async fetch(url,options={}){
      const u=new URL(url),method=options.method||'GET';let body;
      if(method==='PATCH'){
        const op=JSON.parse(options.body).params.symbols[0];
        patches.push({operation:op.operation,enabled:op.enabled,closePositionsOnStop:op.closePositionsOnStop});
        if(op.operation==='Delete'){automation=[];if(lostDelete){lostDelete=false;throw Error('fixture delete response lost');}}
        else if(op.operation==='Upsert'&&op.enabled===false){
          if(lostStop){lostStop=false;throw Error('fixture disable response lost');}
          automation=[op];if(!failWait)positions=[];
        }
        else throw Error('unexpected mocked exchange write');
        return{status:200,body:'{}'};
      }
      if(u.pathname.endsWith('/collateral'))body={'fixture-3':{netEquity:'1000',netEquityAvailable:'500'}};
      else if(u.pathname.endsWith('/automation'))body={params:{symbols:structuredClone(automation)}};
      else if(u.pathname.endsWith('/position')){
        if(replaceBeforeDelete&&patches.some(p=>p.operation==='Upsert')&&++afterDisableReads===2){
          replaceBeforeDelete=false;positions=[{symbol,positionId:'third-position',netQuantity:'-1',markPrice:'100',
            estLiquidationPrice:'150',userId:identity.userId,subaccountId:identity.subaccountId}];
          observed.positions=[{market,symbol,size:'-1',mark:'100',liq:'150',pnlPct:0,fundingRaw:0}];
          observed.positionRefs={[market]:positionRef(identity,positions[0])};
        }
        body=structuredClone(positions);
      }
      else throw Error('unexpected mocked exchange read: '+u.pathname);
      return{status:200,body:JSON.stringify(body)};
    }};
  async function execute({diskFailure=false,mutateAfterPlan=false,concurrentIssue=false,afterPlan=null}={}) {
    const at=new Date().toISOString(),runId='recovery-'+(++round);
    observed.at=at;put('state/observed.json',observed);
    put('state/run_context.json',{runId,identity,startedAt:at,ownerPid:process.pid,ownerStart:ownerStart(process.pid)});
    fs.writeFileSync(path.join(d,'state/last_round_status'),'running');
    const p=spawnSync(process.execPath,[path.join(ROOT,'scripts/decide.cjs')],{
      env:{...process.env,BG_ROOT:d,BG_OFFLINE:'1'},encoding:'utf8',timeout:20000,
    });
    assert.equal(p.status,0,p.stderr);
    const actions=JSON.parse(fs.readFileSync(path.join(d,'state/actions.json')));
    if(mutateAfterPlan){
      const current=JSON.parse(fs.readFileSync(path.join(d,'state/pending_stops.json')));
      if(mutateAfterPlan==='issued')current[market].phase='issued';else current[market].intentId='replacement-intent';
      put('state/pending_stops.json',current);
    }
    if(afterPlan)await afterPlan();
    const tmp=path.join(d,'state/pending_stops.json.tmp');
    if(diskFailure)fs.mkdirSync(tmp);
    const before=patches.length;let source=dispatchSource(fs.readFileSync(path.join(ROOT,'scripts/act.mjs'),'utf8'),d);
    let concurrentDispatches=0;
    if(concurrentIssue){
      const needle='delete ledger.pending[a.market];\n          try { await savePending(ledger.pending); }';
      assert(source.includes(needle));
      source=source.replace(needle,'delete ledger.pending[a.market];\n          await concurrentDispatch();\n          try { await savePending(ledger.pending); }');
    }
    const concurrentDispatch=async()=>{
      const expected={intentId:intent.intentId,planId:intent.planId,runId:intent.runId};
      const child=spawnSync(PY,[path.join(d,'scripts/with_lock.py'),'--name','pending','--wait','5',
        process.execPath,path.join(d,'scripts/pending_store.cjs')],{
        input:JSON.stringify({op:'issue',market,expected,accountKey:identity.accountKey}),encoding:'utf8',
        env:{...process.env,BG_ROOT:d},timeout:10000});
      assert.equal(child.status,0,child.stdout+child.stderr);
      concurrentDispatches++; // simulated other executor sends after its real issued transition
    };
    let exit=0,error=null;
    try{
      await new AsyncFunction('ego','taskSpace','process','console','concurrentDispatch',source)(mockEgo(d),async()=>fixtureTask(d,page),
        {exit:code=>{throw Object.assign(Error('fixture exit'),{exit:code});}},{log(){}},concurrentDispatch);
    }catch(e){if(e.exit!==undefined)exit=e.exit;else error=e.message;}
    const result=JSON.parse(fs.readFileSync(path.join(d,'state/act_results.json')));
    const pending=JSON.parse(fs.readFileSync(path.join(d,'state/pending_stops.json')));
    if(diskFailure)fs.rmSync(tmp,{recursive:true,force:true});
    return{actions,exit,error,result,pending,patches:patches.slice(before),concurrentDispatches};
  }
  return{execute,clearRisk:()=>{if(observed.gridRows[0]){observed.gridRows[0].pnlRaw=0;observed.gridRows[0].pnlPct=0;}
      if(observed.positions[0])observed.positions[0].pnlPct=0;},
    setGridProfit:()=>{if(observed.gridRows[0]){observed.gridRows[0].pnlRaw=200;observed.gridRows[0].pnlPct=20;}},
    replacePosition:(id,{gridLoss=false,positionLoss=false}={})=>{
      positions=[{symbol,netQuantity:'-1',markPrice:'100',estLiquidationPrice:'150',userId:identity.userId,
        subaccountId:identity.subaccountId,...(id ? {positionId:id} : {})}];
      observed.positions=[{market,symbol,size:'-1',mark:'100',liq:'150',pnlPct:positionLoss?-101:0,fundingRaw:0}];
      observed.positionRefs={[market]:positionRef(identity,positions[0])};
      if(observed.gridRows[0]){observed.gridRows[0].pnlRaw=gridLoss?-100:0;observed.gridRows[0].pnlPct=gridLoss?-10:0;}
    },
    refreshObserved:()=>{if(!automation.length)observed.gridRows=[];if(!positions.length){observed.positions=[];observed.positionRefs={};}},
    recreateLiveGrid:()=>{automation=[{symbol,enabled:true,allocationUsd:'1000',priceLow:'90',priceHigh:'110',levels:20,
      direction:'Short',takeProfitPercentage:cfg.takeProfitPct,stopLossPercentage:cfg.stopLossPct,closePositionsOnStop:true}];},
    replaceIntent:value=>put('state/pending_stops.json',{[market]:value}),
    failDurableWrites:()=>{const file=path.join(d,'scripts/pending_store.cjs');const source=fs.readFileSync(file,'utf8');
      fs.writeFileSync(file,source.replace('function write(data, durable) {',
        "function write(data, durable) { if(durable) throw Object.assign(Error('fixture write failure'),{code:'EIO'});"));},
    failDurableAfterRenameOnce:()=>{const file=path.join(d,'scripts/pending_store.cjs');const source=fs.readFileSync(file,'utf8');
      const hook="function write(data, durable) { if(durable && !fs.existsSync(path.join(ROOT,'state/fixture-fsync-failed'))) { const real=fs.fsyncSync;let calls=0;fs.fsyncSync=fd=>{const result=real(fd);if(++calls===2){fs.writeFileSync(path.join(ROOT,'state/fixture-fsync-failed'),'1');throw Object.assign(Error('fixture fsync failure'),{code:'EIO'});}return result;}; }";
      fs.writeFileSync(file,source.replace('function write(data, durable) {',hook));},
    revokeLeaseDuringIssuedFsync:()=>{const file=path.join(d,'scripts/pending_store.cjs');const source=fs.readFileSync(file,'utf8');
      const hook="function write(data, durable) { if(durable && data.includes('\\\"phase\\\": \\\"disable-issued\\\"') && !fs.existsSync(path.join(ROOT,'state/fixture-lease-revoked'))) { const real=fs.fsyncSync;let calls=0;fs.fsyncSync=fd=>{const result=real(fd);if(++calls===2){fs.writeFileSync(path.join(ROOT,'state/fixture-lease-revoked'),'1');fs.writeFileSync(path.join(ROOT,'state/last_round_status'),'aborted');}return result;}; }";
      fs.writeFileSync(file,source.replace('function write(data, durable) {',hook));},
    close:()=>fs.rmSync(d,{recursive:true,force:true})};
}

async function check(name,fn){await fn();console.log('PASS '+name);}
if(require.main===module)(async()=>{
  const failed=await firstRound('snapshot-cleanup-failure');
  assert.equal(failed.patches,0);assert.equal(failed.pending[market].phase,'prepared');
  assert.match(failed.pending[market].reason,/not yet sent/);
  const prepared=failed.pending[market];
  await check('cleanup failure retries locally across rounds without stopping a matching grid',async()=>{
    const f=fixture(prepared);
    try{
      const first=await f.execute({diskFailure:true});
      assert.equal(first.error,null);assert.equal(first.exit,2);assert.equal(first.patches.length,0);
      assert(first.actions.some(a=>a.act==='clear-prepared-create'));assert(!first.actions.some(a=>a.act==='stop'));
      assert.equal(first.pending[market].phase,'prepared');
      const retry=await f.execute();assert.equal(retry.error,null);assert.equal(retry.exit,0);
      assert.deepEqual(retry.pending,{});assert.equal(retry.patches.length,0);
    }finally{f.close();}
  });
  await check('known-unsent intent clears without exchange writes even when no grid exists',async()=>{
    const f=fixture(prepared,{present:false});try{const r=await f.execute();assert.equal(r.exit,0);assert.deepEqual(r.pending,{});assert.equal(r.patches.length,0);}finally{f.close();}
  });
  await check('lease revocation leaves prepared intent for a later safe local cleanup',async()=>{
    const first=await firstRound('snapshot-lease-failure');
    assert.equal(first.patches,0);assert.match(first.actError,/EXECUTION_CONFIG_CHANGED/);assert.equal(first.pending[market].phase,'prepared');
    const f=fixture(first.pending[market]);try{const r=await f.execute();assert.equal(r.exit,0);assert.deepEqual(r.pending,{});assert.equal(r.patches.length,0);}finally{f.close();}
  });
  for(const mode of ['lease-revoked-during-issue','config-changed-during-issue']){
    await check(mode+' blocks dispatch and remains unknown across rounds',async()=>{
      const first=await firstRound(mode);assert.equal(first.patches,0);assert.equal(first.pending[market].phase,'issued');
      const f=fixture(first.pending[market]);try{const r=await f.execute();
        assert.equal(r.exit,2);assert.equal(r.patches.length,0);assert.equal(r.pending[market].phase,'issued');
        assert(r.result.results.some(x=>x.manualRequired));
      }finally{f.close();}
    });
  }
  for(const [mode,code,phase] of [['snapshot-crash-after-prepare',47,'prepared'],['crash-after-issued',48,'issued']]){
    await check(mode+' survives a process crash without stopping an independent grid',async()=>{
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bg-create-crash-')),keep=path.join(temp,'fixture-path'),sent=path.join(temp,'patch-sent');
      let retained=null;
      try{
        const child=spawnSync(process.execPath,['-e',
          "require(process.argv[1]).run(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1})",
          path.join(ROOT,'tests/browser_alignment.cjs'),mode],{
          env:{...process.env,BG_TEST_KEEP_FIXTURE_FILE:keep,BG_TEST_PATCH_MARKER:sent},encoding:'utf8',timeout:20000,
        });
        assert.equal(child.status,code,child.stderr);assert(!fs.existsSync(sent));
        retained=fs.readFileSync(keep,'utf8');assert(retained.startsWith(path.join(os.tmpdir(),'bg-browser-alignment-')));
        const intent=JSON.parse(fs.readFileSync(path.join(retained,'state/pending_stops.json')))[market];
        assert.equal(intent.phase,phase);
        const f=fixture(intent);try{
          const r=await f.execute();assert.equal(r.patches.length,0);
          if(phase==='prepared'){assert.equal(r.exit,0);assert.deepEqual(r.pending,{});}
          else{assert.equal(r.exit,2);assert.equal(r.pending[market].phase,'issued');assert(r.result.results.some(x=>x.manualRequired));}
        }finally{f.close();}
      }finally{if(retained)fs.rmSync(retained,{recursive:true,force:true});fs.rmSync(temp,{recursive:true,force:true});}
    });
  }
  await check('a changed prepared intent is not deleted by an older plan',async()=>{
    const f=fixture(prepared);try{const r=await f.execute({mutateAfterPlan:true});assert.equal(r.exit,2);assert.equal(r.pending[market].intentId,'replacement-intent');assert.equal(r.patches.length,0);}finally{f.close();}
  });
  await check('a prepared intent that becomes issued is preserved for manual review',async()=>{
    const f=fixture(prepared);try{
      const first=await f.execute({mutateAfterPlan:'issued'});assert.equal(first.exit,2);
      assert.equal(first.pending[market].phase,'issued');assert.equal(first.patches.length,0);
      const retry=await f.execute();assert.equal(retry.exit,2);assert.equal(retry.patches.length,0);
      assert.equal(retry.pending[market].phase,'issued');assert(retry.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('concurrent issued transition defeats stale cleanup and survives the next round',async()=>{
    const f=fixture(prepared);try{
      const first=await f.execute({concurrentIssue:true});
      assert.equal(first.concurrentDispatches,1);assert.equal(first.exit,2);assert.equal(first.patches.length,0);
      assert.equal(first.pending[market].phase,'issued');assert(first.result.results.some(x=>x.done===false));
      const retry=await f.execute();assert.equal(retry.exit,2);assert.equal(retry.patches.length,0);
      assert.equal(retry.pending[market].phase,'issued');assert(retry.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  for(const mode of ['create-response-lost','issue-fsync-failure']){
    await check(mode+' remains uncertain and does not stop an independent grid',async()=>{
      const first=await firstRound(mode),intent=first.pending[market];
      assert.equal(intent.phase,'issued');assert.equal(first.patches,mode==='create-response-lost'?1:0);
      assert.match(intent.reason,/outcome unconfirmed/);
      const f=fixture(intent);try{
        const r=await f.execute();assert.equal(r.error,null);assert.equal(r.exit,2);assert.equal(r.patches.length,0);
        assert.equal(r.pending[market].phase,'issued');assert(r.actions.some(a=>a.act==='hold-unknown-create'));
        assert(r.result.results.some(x=>x.act==='hold-unknown-create'&&x.manualRequired===true));
      }finally{f.close();}
    });
  }
  await check('legacy issued and malformed prepared intents remain blocked for manual review',async()=>{
    for(const intent of [{kind:'create',phase:'issued',accountKey:identity.accountKey,reason:'legacy'},
      {kind:'create',phase:'prepared',accountKey:identity.accountKey,reason:'unbound'},
      {...prepared,intentId:'not-a-uuid'}]){
      const f=fixture(intent,{present:false});try{const r=await f.execute();assert.equal(r.exit,2);assert.equal(r.patches.length,0);
        assert(r.pending[market]);assert(r.result.results.some(x=>x.manualRequired===true));}finally{f.close();}
    }
  });
  await check('independent stop-loss proceeds while an unsent create is pending',async()=>{
    const f=fixture(prepared,{risk:true});try{
      const r=await f.execute();assert.equal(r.error,null);assert.equal(r.exit,0);
      assert(r.actions.some(a=>a.act==='stop'&&a.independentRisk===true&&a.reason.startsWith('SL:')));
      assert.deepEqual(r.patches.map(p=>p.operation),['Upsert','Delete']);assert.deepEqual(r.pending,{});
    }finally{f.close();}
  });
  await check('independent stop-loss and automatic exit preserve an unknown create outcome',async()=>{
    for(const options of [{risk:true},{autoRisk:true}]){
      const intent={...prepared,phase:'issued'},f=fixture(intent,options);try{
        const r=await f.execute();assert.equal(r.error,null);assert.equal(r.exit,2);
        assert(r.actions.some(a=>a.act==='stop'&&a.independentRisk===true));
        assert.deepEqual(r.patches.map(p=>p.operation),['Upsert','Delete']);
        assert.equal(r.pending[market].phase,'issued');assert.equal(r.pending[market].riskStop.status,'completed');
        assert(r.result.results.some(x=>x.act==='hold-unknown-create'&&x.manualRequired===true));
      }finally{f.close();}
    }
  });
  await check('fresh grid and position stop-loss override an older issued trail retry',async()=>{
    for(const options of [{risk:true},{autoRisk:true}]){
      let saved={[market]:{...prepared,phase:'issued'}},writes=0;const oldRef='a'.repeat(64);
      const oldStop=makeStopGrid({loadPending:async()=>({pending:structuredClone(saved),corrupt:false}),
        savePending:async p=>{saved=structuredClone(p);},getTrailPositionRef:async()=>({state:'known',ref:oldRef}),
        getAutomation:async()=>({params:{symbols:[{symbol,enabled:true}]}}),
        jpatch:async(_url,_body,before)=>{await before();writes++;throw Error('fixture lost trailing response');}});
      await assert.rejects(oldStop(market,null,'AUTO_TRAIL: old position',[],{independentRisk:true,trailPositionRef:oldRef}),/lost trailing response/);
      assert.equal(writes,1);assert.equal(saved[market].trailPhase,'issued');
      const f=fixture(saved[market],options);try{
        const r=await f.execute();assert.equal(r.error,null);assert.equal(r.exit,2);
        const stop=r.actions.find(a=>a.act==='stop');assert(stop.independentRisk);
        assert.match(stop.reason,options.risk?/^SL:/ : /^AUTO_SL:/);
        assert.deepEqual(r.patches.map(p=>p.operation),['Upsert','Delete']);
        assert.equal(r.pending[market].phase,'issued');assert.equal(r.pending[market].riskStop.status,'completed');
        assert.equal(r.pending[market].previousRiskStops.length,1);
        assert.equal(r.pending[market].previousRiskStops[0].trailPositionRef,oldRef);
        assert.equal(r.pending[market].previousRiskStops[0].trailPhase,'issued');
        assert.equal(r.pending[market].trailPositionRef,undefined);
        assert(r.result.results.some(x=>x.manualRequired));
      }finally{f.close();}
    }
  });
  await check('old trailing retry remains bound when no fresh risk exit exists',async()=>{
    const oldRef='a'.repeat(64),f=fixture({...prepared,phase:'issued',trailPositionRef:oldRef,trailPhase:'issued',
      riskStop:{at:new Date().toISOString(),reason:'AUTO_TRAIL: old position',status:'pending'}});
    try{const r=await f.execute();const stop=r.actions.find(a=>a.act==='stop');
      assert.equal(stop.retryPendingRisk,true);assert.equal(stop.trailPositionRef,oldRef);
      assert.equal(r.patches.length,0);assert.equal(r.pending[market].trailPositionRef,oldRef);
    }finally{f.close();}
  });
  await check('an incomplete independent risk stop is retried without clearing the unknown create',async()=>{
    const f=fixture({...prepared,phase:'issued'},{risk:true,stopTimeoutOnce:true});
    try{
      const first=await f.execute();assert.equal(first.exit,2);
      assert.deepEqual(first.patches.map(p=>p.operation),['Upsert']);
      assert.equal(first.pending[market].phase,'issued');assert.equal(first.pending[market].riskStop.status,'pending');
      f.clearRisk();
      const retry=await f.execute();assert.equal(retry.exit,2);
      assert(retry.actions.some(a=>a.act==='stop'&&a.independentRisk===true&&a.reason.startsWith('pending risk stop retry')));
      assert.deepEqual(retry.patches.map(p=>p.operation),['Upsert','Delete']);
      assert.equal(retry.pending[market].phase,'issued');assert.equal(retry.pending[market].riskStop.status,'completed');
    }finally{f.close();}
  });
  await check('acknowledged create recovery retains the existing verified stop path',async()=>{
    const f=fixture({...prepared,phase:'acknowledged'});try{const r=await f.execute();
      assert.equal(r.exit,0);assert.deepEqual(r.patches.map(p=>p.operation),['Upsert','Delete']);assert.deepEqual(r.pending,{});
    }finally{f.close();}
  });
  await check('stale stop plans cannot stop an unresolved create intent',async()=>{
    for(const intent of [prepared,{...prepared,phase:'issued'}]){
      let pending={[market]:structuredClone(intent)},writes=0;
      const io={loadPending:async()=>({pending,corrupt:false}),savePending:async p=>{pending=p;},
        getAutomation:async()=>({params:{symbols:[{symbol,enabled:true}]}}),jpatch:async()=>{writes++;return{status:200,body:'{}'}}};
      const results=[],r=await makeStopGrid(io)(market,null,'pending stop retry (old plan)',results);
      assert.equal(writes,0);
      if(intent.phase==='prepared'){assert.equal(r.done,true);assert.deepEqual(pending,{});assert.equal(results[0].act,'clear-prepared-create');}
      else{assert.equal(r.done,false);assert(pending[market]);assert(results[0].manualRequired);assert.equal(results[0].act,'hold-unknown-create');}
    }
  });
})().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,market,symbol,identity};
