'use strict';
// End-to-end production decide/act logic against temporary state and a mocked
// exchange; no browser session or network access is used.
const assert=require('node:assert/strict');
const {fixture,market,symbol,identity}=require('./pending_create_recovery.cjs');
const {positionRef}=require('../scripts/position_ref.cjs');
const {makeStopGrid}=require('../scripts/act_core.cjs');
const oldRef=positionRef(identity,{symbol,positionId:'old-position',netQuantity:'-1'});
const oldTrail=phase=>({accountKey:identity.accountKey,at:new Date().toISOString(),reason:'AUTO_TRAIL: old position',
  trailPositionRef:oldRef,trailPhase:phase,trailIntentVersion:2});
const stops=r=>r.actions.filter(a=>a.act==='stop');
const operations=r=>r.patches.map(p=>p.operation);
async function check(name,fn){await fn();console.log('PASS '+name);}

(async()=>{
  for(const phase of ['prepared','issued'])for(const options of [{risk:true},{autoRisk:true}]){
    await check(`fresh ${options.risk?'grid':'position'} stop-loss supersedes ${phase} ordinary trail`,async()=>{
      const f=fixture(oldTrail(phase),options);
      try{const r=await f.execute();assert.equal(r.error,null);assert.equal(stops(r).length,1);
        assert.match(stops(r)[0].reason,options.risk?/^SL:/ : /^AUTO_SL:/);
        assert.equal(stops(r)[0].reviewStop,true);assert.deepEqual(operations(r),['Upsert','Delete']);
        if(phase==='prepared'){assert.equal(r.exit,0);assert.deepEqual(r.pending,{});}
        else{assert.equal(r.exit,2);const held=r.pending[market];assert.equal(held.kind,'stop_review');
          assert.equal(held.riskStop.status,'completed');assert.equal(held.previousRiskStops[0].outcome,'unknown');
          assert.equal(held.previousRiskStops[0].entry.trailPositionRef,oldRef);
          assert(r.result.results.some(x=>x.manualRequired));}
      }finally{f.close();}
    });
  }
  await check('old issued trail cannot stop the replacement when no fresh risk exists',async()=>{
    const f=fixture(oldTrail('issued'));try{const r=await f.execute();
      assert.equal(stops(r).length,1);assert.match(stops(r)[0].reason,/^pending stop retry/);
      assert.equal(stops(r)[0].trailPositionRef,oldRef);assert.deepEqual(operations(r),[]);
      assert.equal(r.pending[market].trailPositionRef,oldRef);
    }finally{f.close();}
  });
  await check('ordinary trailing retry is not replaced by a fresh take-profit alone',async()=>{
    const f=fixture(oldTrail('issued'));try{f.setGridProfit();const r=await f.execute();
      assert.equal(stops(r).length,1);assert.match(stops(r)[0].reason,/^pending stop retry/);assert.deepEqual(operations(r),[]);
    }finally{f.close();}
  });
  await check('ordinary trailing retry still completes for the same original position',async()=>{
    const f=fixture(oldTrail('issued'),{positionId:'old-position'});try{const r=await f.execute();
      assert.equal(r.exit,0);assert.match(stops(r)[0].reason,/^pending stop retry/);
      assert.deepEqual(operations(r),['Upsert','Delete']);assert.deepEqual(r.pending,{});
    }finally{f.close();}
  });
  await check('the account breaker still proceeds when the position changes after planning',async()=>{
    const f=fixture(oldTrail('issued'),{tripBreaker:true});try{
      const r=await f.execute({afterPlan:()=>f.replacePosition('third-position')});
      assert.equal(r.exit,2);assert.match(stops(r)[0].reason,/^circuit breaker:/);
      assert.deepEqual(operations(r),['Upsert','Delete']);assert.equal(r.pending[market].kind,'stop_review');
    }finally{f.close();}
  });
  await check('a known-unsent old trail recovers a timed-out new stop on the same position',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true,stopTimeoutOnce:true,keepPositionOnTimeout:true});try{
      const first=await f.execute();assert.equal(first.exit,2);assert.deepEqual(operations(first),['Upsert']);
      assert.equal(first.pending[market].riskStop.phase,'disable-acknowledged');
      f.clearRisk();const next=await f.execute();assert.equal(next.exit,0);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.equal(stops(next)[0].retryPendingRisk,true);assert.deepEqual(next.pending,{});
    }finally{f.close();}
  });
  await check('lost disable response retries only the same position and retains both unknown outcomes',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true,stopResponseLostOnce:true});try{
      const first=await f.execute();assert.equal(first.exit,2);assert.deepEqual(operations(first),['Upsert']);
      assert.equal(first.pending[market].riskStop.phase,'disable-issued');f.clearRisk();
      const next=await f.execute();assert.equal(next.exit,2);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.equal(stops(next)[0].retryPendingRisk,true);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unknown','unknown']);
      assert.equal(next.pending[market].riskStop.status,'completed');assert(next.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('a second replacement is held without replaying the earlier unknown stop',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true,stopResponseLostOnce:true});try{
      const first=await f.execute();assert.equal(first.pending[market].riskStop.phase,'disable-issued');
      f.replacePosition('third-position');const next=await f.execute();
      assert.equal(next.exit,2);assert.deepEqual(operations(next),[]);assert.equal(stops(next).length,0);
      assert.equal(next.pending[market].riskStop.phase,'disable-issued');assert(next.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('a second replacement with fresh loss is stopped without discarding earlier uncertainty',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true,stopResponseLostOnce:true});try{
      await f.execute();f.replacePosition('third-position',{gridLoss:true});const next=await f.execute();
      assert.equal(next.exit,2);assert.match(stops(next)[0].reason,/^SL:/);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unknown','unknown']);
      assert.equal(next.pending[market].riskStop.status,'completed');
    }finally{f.close();}
  });
  await check('an acknowledged but unsettled stop is retained if the position is replaced',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true,stopTimeoutOnce:true,keepPositionOnTimeout:true});try{
      const first=await f.execute();assert.equal(first.pending[market].riskStop.phase,'disable-acknowledged');
      f.replacePosition('third-position',{gridLoss:true});const next=await f.execute();
      assert.equal(next.exit,2);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unsent','unknown']);
    }finally{f.close();}
  });
  await check('a lost delete response is checked read-only across rounds and remains unknown',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true,deleteResponseLostOnce:true});try{
      const first=await f.execute();assert.equal(first.exit,2);assert.deepEqual(operations(first),['Upsert','Delete']);
      assert.equal(first.pending[market].riskStop.phase,'delete-issued');f.refreshObserved();
      const next=await f.execute();assert.equal(next.exit,2);assert.deepEqual(operations(next),[]);
      assert.equal(stops(next)[0].verifyOnly,true);assert.equal(next.pending[market].riskStop.status,'completed');
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unsent','unknown']);
    }finally{f.close();}
  });
  await check('read-only recovery refuses a grid that reappears after planning',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true,deleteResponseLostOnce:true});try{
      await f.execute();f.refreshObserved();const next=await f.execute({afterPlan:()=>f.recreateLiveGrid()});
      assert.equal(next.exit,2);assert.equal(stops(next)[0].verifyOnly,true);assert.deepEqual(operations(next),[]);
      assert.equal(next.pending[market].riskStop.phase,'delete-issued');assert(next.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('a replacement after planning invalidates the risk stop before any write',async()=>{
    const original=oldTrail('issued'),f=fixture(original,{risk:true});try{
      const r=await f.execute({afterPlan:()=>f.replacePosition('third-position')});
      assert.equal(r.exit,2);assert.deepEqual(operations(r),[]);assert.deepEqual(r.pending[market],original);
    }finally{f.close();}
  });
  await check('a replacement after retry planning prevents the stale retry',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true,stopResponseLostOnce:true});try{
      await f.execute();f.clearRisk();const next=await f.execute({afterPlan:()=>f.replacePosition('third-position')});
      assert.equal(stops(next)[0].retryPendingRisk,true);assert.equal(next.exit,2);assert.deepEqual(operations(next),[]);
      assert.equal(next.pending[market].riskStop.phase,'disable-issued');
    }finally{f.close();}
  });
  await check('a replacement before delete is never deleted and its later loss is reevaluated',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true,replaceBeforeDelete:true});try{
      const first=await f.execute();assert.equal(first.exit,2);assert.deepEqual(operations(first),['Upsert']);
      assert.equal(first.pending[market].riskStop.phase,'disable-acknowledged');
      f.clearRisk();const held=await f.execute();assert.equal(held.exit,2);assert.deepEqual(operations(held),[]);
      f.replacePosition('third-position',{gridLoss:true});const next=await f.execute();
      assert.equal(next.exit,2);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unsent','unknown']);
    }finally{f.close();}
  });
  await check('a changed pending record invalidates an older risk plan',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true}),replacement={...oldTrail('issued'),reason:'AUTO_TRAIL: newer intent'};
    try{const r=await f.execute({afterPlan:()=>f.replaceIntent(replacement)});
      assert.equal(r.exit,2);assert.deepEqual(operations(r),[]);assert.deepEqual(r.pending[market],replacement);
    }finally{f.close();}
  });
  await check('failed durable persistence sends no stop and leaves the original trail intact',async()=>{
    const original=oldTrail('issued'),f=fixture(original,{risk:true});try{
      const r=await f.execute({afterPlan:()=>f.failDurableWrites()});
      assert.equal(r.exit,2);assert.deepEqual(operations(r),[]);assert.deepEqual(r.pending[market],original);
    }finally{f.close();}
  });
  await check('failure after durable rename remains unsent and safely recovers next round',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true});try{
      const first=await f.execute({afterPlan:()=>f.failDurableAfterRenameOnce()});
      assert.equal(first.exit,2);assert.deepEqual(operations(first),[]);
      assert.equal(first.pending[market].kind,'stop_review');assert.equal(first.pending[market].riskStop.phase,'prepared');
      assert.equal(first.pending[market].previousRiskStops[0].outcome,'unknown');
      const next=await f.execute();assert.equal(next.exit,2);assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unknown','unsent']);
      assert.equal(next.pending[market].riskStop.status,'completed');
    }finally{f.close();}
  });
  await check('lease loss during stop persistence prevents dispatch and preserves uncertainty',async()=>{
    const f=fixture(oldTrail('prepared'),{risk:true});try{
      const first=await f.execute({afterPlan:()=>f.revokeLeaseDuringIssuedFsync()});
      assert.match(first.error,/EXECUTION_LEASE_REVOKED/);assert.deepEqual(operations(first),[]);
      assert.equal(first.pending[market].riskStop.phase,'disable-issued');
      f.clearRisk();const next=await f.execute();assert.equal(next.exit,2);
      assert.deepEqual(operations(next),['Upsert','Delete']);
      assert.deepEqual(next.pending[market].previousRiskStops.map(x=>x.outcome),['unsent','unknown']);
      assert.equal(next.pending[market].riskStop.status,'completed');
    }finally{f.close();}
  });
  await check('an unbound unknown stop is held instead of blindly retried',async()=>{
    const f=fixture(oldTrail('issued'),{risk:true,positionId:null,stopResponseLostOnce:true});try{
      const first=await f.execute();assert.equal(first.exit,2);assert.equal(first.pending[market].riskStop.positionRef,undefined);
      f.clearRisk();const next=await f.execute();assert.equal(next.exit,2);assert.deepEqual(operations(next),[]);
      assert.equal(stops(next).length,0);assert(next.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('legacy unbound prepared trail remains unknown after a fresh stop-loss',async()=>{
    const legacy={accountKey:identity.accountKey,at:new Date().toISOString(),reason:'AUTO_TRAIL: legacy',trailPhase:'prepared'};
    const f=fixture(legacy,{risk:true});try{const r=await f.execute();assert.equal(r.exit,2);
      assert.deepEqual(operations(r),['Upsert','Delete']);assert.equal(r.pending[market].previousRiskStops[0].outcome,'unknown');
    }finally{f.close();}
  });
  await check('legacy bound prepared trail remains uncertain after a fresh stop-loss',async()=>{
    const legacy=oldTrail('prepared');delete legacy.trailIntentVersion;
    const f=fixture(legacy,{risk:true});try{const r=await f.execute();assert.equal(r.exit,2);
      assert.deepEqual(operations(r),['Upsert','Delete']);assert.equal(r.pending[market].previousRiskStops[0].outcome,'unknown');
    }finally{f.close();}
  });
  await check('legacy prepared trail is not cleared when the position was replaced',async()=>{
    const legacy=oldTrail('prepared');delete legacy.trailIntentVersion;
    const f=fixture(legacy);try{const r=await f.execute();assert.equal(r.exit,2);
      assert.deepEqual(operations(r),[]);assert.deepEqual(r.pending[market],legacy);
    }finally{f.close();}
  });
  await check('malformed pending risk does not authorize an automatic retry',async()=>{
    const invalid={kind:'stop_review',accountKey:identity.accountKey,previousRiskStops:[],
      riskStop:{status:'pending',phase:'prepared',positionRef:oldRef}};
    const f=fixture(invalid,{positionId:'old-position'});try{const r=await f.execute();
      assert.equal(r.exit,2);assert.equal(stops(r).length,0);assert.deepEqual(operations(r),[]);
      assert.deepEqual(r.pending[market],invalid);assert(r.result.results.some(x=>x.manualRequired));
    }finally{f.close();}
  });
  await check('a stale ordinary stop plan cannot execute against a stop-review record',async()=>{
    const pending={[market]:{kind:'stop_review',accountKey:identity.accountKey,previousRiskStops:[],riskStop:{status:'pending'}}};
    let writes=0;const results=[];
    const stop=makeStopGrid({loadPending:async()=>({pending,corrupt:false}),savePending:async()=>{},
      getAutomation:async()=>{writes++;},jpatch:async()=>{writes++;}});
    const result=await stop(market,null,'pending stop retry (AUTO_TRAIL: old)',results,{trailPositionRef:oldRef});
    assert.equal(result.done,false);assert.equal(writes,0);assert(results[0].manualRequired);
  });
})().catch(error=>{console.error(error);process.exitCode=1;});
