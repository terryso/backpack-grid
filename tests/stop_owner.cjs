'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const ROOT=path.join(__dirname,'..');
const assert=require('node:assert/strict');
// Production act source executes only in disposable fixtures with mock session I/O.
// The normal test runner also preloads no_network.cjs.
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {hash}=require(path.join(ROOT,'scripts/contracts.cjs')),{ownerStart}=require(path.join(ROOT,'scripts/execution_lease.cjs'));
async function run(mode){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-stop-owner-')),identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'};
 fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
 const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json'))),at=new Date().toISOString(),runId='owner-'+mode,actions=[{act:'stop',market:'ETH-PERP',reason:'fixture risk exit',range:['90','110']}];
 const put=(n,x)=>fs.writeFileSync(path.join(d,n),typeof x==='string'?x:JSON.stringify(x));
 put('config.json',cfg);put('state/account_identity.json',identity);put('state/run_context.json',{runId,identity,startedAt:at,ownerPid:process.pid,ownerStart:ownerStart(process.pid)});put('state/last_round_status','running');put('state/actions.json',actions);put('state/actions_meta.json',{runId,planId:'plan-'+mode,identity,at,configHash:hash(cfg),actionsHash:hash(actions),riskWriteOk:true,subaccountId:3});
 const grid={symbol:'ETH_USDC_PERP',enabled:true,allocationUsd:'100',priceLow:'90',priceHigh:'110',levels:20,direction:'Neutral',takeProfitPercentage:10,stopLossPercentage:6,closePositionsOnStop:true};let symbols=mode==='absent-foreign'?[]:[grid],deleteCount=0,patchCount=0,clock=Date.now();
 if(mode==='absent-foreign')put('state/pending_stops.json',{'ETH-PERP':{accountKey:identity.accountKey,at,reason:'cleanup'}});
 const page={goto:async()=>{},waitForTimeout:async()=>{},fetch:async(url,options={})=>{
  const u=new URL(url),method=options.method||'GET';let data;
  if(method==='PATCH'){patchCount++;const op=JSON.parse(options.body).params.symbols[0];if(op.operation==='Delete'){deleteCount++;symbols=[];}else symbols=[op];return{status:200,body:'{}'};}
  if(u.pathname.endsWith('/collateral'))data={[identity.accountKey]:{netEquity:'1000',netEquityAvailable:'500'}};
  else if(u.pathname.endsWith('/automation'))data={params:{symbols:structuredClone(symbols)}};
  else if(u.pathname.endsWith('/position')){
   const foreignUser=mode==='foreign';
   const foreignSub=mode==='foreign-sub'||mode==='absent-foreign'||(mode==='final-foreign'&&deleteCount>0);
   data=[{symbol:grid.symbol,netQuantity:'0',...(mode==='owner-fields-absent'?{}:{userId:foreignUser?'other-user':identity.userId,subaccountId:foreignSub?4:3})}];
   if(mode==='other-near-liquidation')data.push({symbol:'BTC_USDC_PERP',netQuantity:'1',markPrice:'100',estLiquidationPrice:'99',userId:identity.userId,subaccountId:3});
  } else throw Error('Unexpected mock endpoint '+u.pathname);
  return{status:200,body:JSON.stringify(data)};
 }};
 class Clock extends Date{static now(){clock+=1000;return clock;}}
 let exit=0,error=null;const source=fs.readFileSync(path.join(ROOT,'scripts/act.mjs'),'utf8').replace('const ROOT = "__BG_ROOT__";','const ROOT = '+JSON.stringify(d)+';');
 const oldLog=console.log;console.log=()=>{};
 try{await new AsyncFunction('taskSpace','process','Date','console',source)(async()=>({page:()=>page}),{exit:code=>{throw Object.assign(Error('mock exit'),{exit:code});}},Clock,{log:()=>{}});}catch(e){if(e.exit!==undefined)exit=e.exit;else error=e.message;}finally{console.log=oldLog;}
 const pending=fs.existsSync(path.join(d,'state/pending_stops.json'))?JSON.parse(fs.readFileSync(path.join(d,'state/pending_stops.json'))):{};const result=JSON.parse(fs.readFileSync(path.join(d,'state/act_results.json')));
 fs.rmSync(d,{recursive:true,force:true});return{mode,exit,error,patchCount,deleteCount,pendingCount:Object.keys(pending).length,resultStatus:result.status,doneResults:result.results.map(r=>({act:r.act,done:r.done,unconfirmed:r.unconfirmed}))};
}
(async()=>{
 let count=0;
 for(const mode of ['healthy','foreign','foreign-sub','absent-foreign','final-foreign','owner-fields-absent','other-near-liquidation']){
  const r=await run(mode);assert.equal(r.error,null,r.error);
  if(['healthy','owner-fields-absent','other-near-liquidation'].includes(mode)){
   assert.equal(r.exit,0);assert.equal(r.deleteCount,1);assert.equal(r.pendingCount,0);assert.equal(r.resultStatus,'complete');
  }else{
   assert.equal(r.exit,2);assert.equal(r.pendingCount,1);assert.equal(r.resultStatus,'failed');
   assert.equal(r.deleteCount,mode==='final-foreign'?1:0);
   assert(r.doneResults.every(x=>x.done!==true),'must not confirm cleanup from another account');
  }
  count++;console.log('PASS production stop owner binding: '+mode);
 }
 console.log(count+' stop owner binding scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
