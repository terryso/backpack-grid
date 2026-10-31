'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {dispatchSource}=require('./ego_fixture.cjs'),{resolveBotPage}=require('../scripts/ego_space.cjs');
const {hash}=require('../scripts/contracts.cjs'),{ownerStart}=require('../scripts/execution_lease.cjs');
const ROOT=path.join(__dirname,'..'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function run(mode){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-browser-alignment-'));
 try{
  fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json')));cfg.watch={spaceId:7,page:'p1'};
  const identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'},at=new Date().toISOString(),runId='alignment-'+mode;
  const put=(n,v)=>fs.writeFileSync(path.join(d,n),typeof v==='string'?v:JSON.stringify(v));
  const actions=mode==='infeasible-create'
    ?[{act:'create',market:'kPEPE-PERP',urlSymbol:'kPEPE_USD_PERP',lower:0.0042,upper:0.0058,count:38,value:850,why:'fixture infeasible create'}]
    :(mode==='infeasible-create-soft'||mode==='valid-create')
    ?[{act:'create',market:'UNI-PERP',urlSymbol:'UNI_USD_PERP',lower:6.6,upper:7.7,count:38,value:2500,why:'fixture create'}]
    :[{act:'stop',market:'ETH-PERP',range:[90,110],reason:'fixture risk exit'}];
  put('config.json',cfg);put('state/account_identity.json',identity);put('state/risk.json',{peakEquity:1000,paused:null,accountKey:identity.accountKey});
  put('state/run_context.json',{runId,identity,startedAt:at,ownerPid:process.pid,ownerStart:ownerStart(process.pid)});put('state/last_round_status','running');put('state/actions.json',actions);put('state/manual_pauses.json',{});
  put('state/actions_meta.json',{runId,planId:'plan-'+mode,identity,at,configHash:hash(cfg),actionsHash:hash(actions),riskWriteOk:true,subaccountId:3});
  const sid=mode==='replaced-space'?9:7,labels=mode==='missing-primary'?['p4']:mode==='empty-space'?[]:['p1'];
  let deletes=0,patches=0,created=0,autos=[{symbol:'ETH_USDC_PERP',enabled:true,allocationUsd:100,priceLow:90,priceHigh:110,levels:20,direction:'Neutral',takeProfitPercentage:10,stopLossPercentage:6,closePositionsOnStop:true}];const navigation=[];
  const pageFor=label=>({label,async url(){return 'https://backpack.exchange/portfolio/balances/assets';},async goto(){if(!labels.includes(label))throw Error('page label not found: '+label);navigation.push(label);},async waitForTimeout(){},async fetch(url,options={}){
   if(!labels.includes(label))throw Error('page label not found: '+label);
   const u=new URL(url);let body;
   if(options.method==='PATCH'){patches++;const op=JSON.parse(options.body).params.symbols[0];if(op.operation==='Delete'){deletes++;autos=[];}else autos=[op];return{status:200,body:'{}'};}
   if(options.method==='POST'&&u.pathname.endsWith('/automation/validate')){
     if(mode==='infeasible-create')return{status:422,body:JSON.stringify({code:'INVALID_CLIENT_REQUEST',message:'Invalid parameters'})}; // kPEPE 形态：不透明确定性拒绝
     if(mode==='infeasible-create-soft'||mode==='valid-create'){
       // 真实响应形态（UNI 探针实测 ~2000 字符）：echo 字段+挂单在前，errorField 若有则在尾部
       const orders=Array.from({length:38},(_,i)=>({amount:'9.2',price:String(6.6+i*0.0289),side:i<19?'Bid':'Ask'}));
       const echo={gridStep:'0.0289',initialPrice:'7.11055',maxAllocation:'3593',maxLevels:199,minAllocation:'50',minGridStep:'0.0026',minLevels:4,orders,profitPerLevelUsd:'0.24',startPrice:'7.1106',strategyType:'Grid',symbol:'UNI_USDC_PERP'};
       if(mode==='valid-create')return{status:200,body:JSON.stringify(echo)};
       return{status:200,body:JSON.stringify({...echo,errorField:'allocation_usd',errorMessage:'Allocation amount is below minimum of 20080'})}; // errorField 远在截断点之后——截断回归会在此失败
     }
     throw Error('Unexpected validate call in mode '+mode);
   }
   if(u.pathname.endsWith('/collateral'))body=mode==='foreign-owner'?{'other-3':{netEquity:1000}}:{'fixture-3':{netEquity:1000,netEquityAvailable:500}};
   else if(u.pathname.endsWith('/automation'))body={params:{symbols:structuredClone(autos)}};
   else if(u.pathname.endsWith('/position'))body=[];
   else if(u.pathname.endsWith('/account'))body={leverageLimit:'10',liquidating:false};
   else if(u.pathname.endsWith('/markets'))body=[{symbol:mode==='infeasible-create'?'kPEPE_USDC_PERP':'UNI_USDC_PERP',imfFunction:{type:'sqrt',base:'0.02',factor:'0.00001'}}];
   else if(u.pathname.endsWith('/markPrices'))body=[mode==='infeasible-create'
     ?{symbol:'kPEPE_USDC_PERP',markPrice:'0.0048'} // 区间 0.0042~0.0058 内
     :{symbol:'UNI_USDC_PERP',markPrice:'7.12'}]; // 区间 6.6~7.7 内
   else if(u.pathname.endsWith('/orders'))body=autos.flatMap(g=>Array.from({length:Math.ceil((Number(g.levels)||38)*0.9)},()=>({symbol:g.symbol}))); // 建格后挂单验证（≥count*0.8）
   else throw Error('Unexpected mock endpoint '+u.pathname);
   return{status:200,body:JSON.stringify(body)};
  }});
  const task={spaceId:sid,async pages(){return labels.map(label=>({label}));},page:pageFor,async newPage(){created++;labels.push('p1');return pageFor('p1');}};
  const ego={async listTaskSpaces(){return{taskSpaces:[{id:sid,name:'backpack-bot'}]};},async createTaskSpace(){throw Error('Unexpected fixture space creation');}};
  const taskSpace=async id=>{if(id!==sid)throw Error('task space not found: '+id);return task;};
  // Observation uses this exact shared production resolver before generating its plan.
  const observation=await resolveBotPage(ego,taskSpace,cfg.watch.page);
  let actError=null,exit=0;
  try{await new AsyncFunction('ego','taskSpace','process','console',dispatchSource(fs.readFileSync(path.join(ROOT,'scripts/act.mjs'),'utf8'),d))(ego,taskSpace,{exit(c){throw Object.assign(Error('fixture exit'),{exit:c});}},{log(){}});}catch(e){if(e.exit!==undefined)exit=e.exit;else actError=e.message;}
  let peakError=null;
  let peak=dispatchSource(fs.readFileSync(path.join(ROOT,'scripts/peak_probe.mjs'),'utf8'),d);
  // Only peak startup/navigation is exercised: never invoke its risk writer.
  peak=peak.slice(0,peak.indexOf('const r = await page.fetch'));
  try{await new AsyncFunction('ego','taskSpace','process','console',peak)(ego,taskSpace,{exit(c){throw Error('Unexpected peak exit '+c);}},{log(){}});}catch(e){peakError=e.message;}
  const results=JSON.parse(fs.readFileSync(path.join(d,'state/act_results.json')));
  const registryFile=path.join(d,'state/infeasible_markets.json');
  return{mode,observationSpace:sid,observationPage:observation.page.label,actError,exit,peakError,patches,deletes,created,navigation,status:results.status,done:results.results.some(r=>r.act==='stop'&&r.done===true),
    create:results.results.find(r=>r.act==='create')||null,
    registry:fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):null,
    pendingWritten:fs.existsSync(path.join(d,'state/pending_stops.json')),
    pending:fs.existsSync(path.join(d,'state/pending_stops.json'))?JSON.parse(fs.readFileSync(path.join(d,'state/pending_stops.json'),'utf8')):null};
 }finally{fs.rmSync(d,{recursive:true,force:true});}
}
(async()=>{
 const evidence=process.argv.includes('--evidence'),rows=[];let count=0;
 for(const mode of ['healthy','missing-primary','replaced-space','empty-space','foreign-owner','infeasible-create','infeasible-create-soft','valid-create']){
  const r=await run(mode);rows.push(r);if(evidence)continue;
  assert.equal(r.actError,null);assert.equal(r.peakError,null);
  if(mode==='foreign-owner'){assert.equal(r.exit,2);assert.equal(r.patches,0);assert.equal(r.done,false);}
  else if(mode==='infeasible-create'){
   assert.equal(r.exit,2);assert.equal(r.patches,0);assert.equal(r.deletes,0);
   assert.match(r.status,/fail/i);assert(r.create&&r.create.done===false);
   assert.match(r.create.error,/validate rejected 422/);
   assert(r.registry&&r.registry.markets['kPEPE-PERP']); // 降级表已写
   assert.match(r.registry.markets['kPEPE-PERP'].reason,/validate rejected 422/);
   assert.equal(r.pending,null); // validate 拒绝先于 write-ahead intent，不得留 pending
  }
  else if(mode==='infeasible-create-soft'){
   assert.equal(r.exit,2);assert.equal(r.patches,0);
   assert.match(r.status,/fail/i);assert(r.create&&r.create.done===false);
   assert.match(r.create.error,/infeasible: allocation_usd/); // 完整解析出 errorField，而非 unreadable
   assert(r.registry&&r.registry.markets['UNI-PERP']);
   assert.match(r.registry.markets['UNI-PERP'].reason,/allocation_usd/);
   assert.equal(r.pending,null);
  }
  else if(mode==='valid-create'){
   assert.equal(r.exit,0);assert.equal(r.patches,1);assert.equal(r.status,'complete');
   assert(r.create&&r.create.done===true);
   assert.equal(r.registry,null); // 合法市场不得降级
   assert.deepEqual(r.pending,{}); // 意图确认后释放
  }
  else{assert.equal(r.exit,0);assert.equal(r.deletes,1);assert.equal(r.done,true);assert.equal(r.status,'complete');}
  assert(r.navigation.every(label=>label===r.observationPage));assert.equal(r.created,mode==='empty-space'?1:0);count++;console.log('PASS production execution browser alignment: '+mode);
 }
 if(evidence)console.log(JSON.stringify(rows,null,2));else console.log(count+' execution browser alignment scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
