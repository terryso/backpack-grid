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
  const actions=[{act:'stop',market:'ETH-PERP',range:[90,110],reason:'fixture risk exit'}];
  put('config.json',cfg);put('state/account_identity.json',identity);put('state/risk.json',{peakEquity:1000,paused:null,accountKey:identity.accountKey});
  put('state/run_context.json',{runId,identity,startedAt:at,ownerPid:process.pid,ownerStart:ownerStart(process.pid)});put('state/last_round_status','running');put('state/actions.json',actions);
  put('state/actions_meta.json',{runId,planId:'plan-'+mode,identity,at,configHash:hash(cfg),actionsHash:hash(actions),riskWriteOk:true,subaccountId:3});
  const sid=mode==='replaced-space'?9:7,labels=mode==='missing-primary'?['p4']:mode==='empty-space'?[]:['p1'];
  let deletes=0,patches=0,created=0,autos=[{symbol:'ETH_USDC_PERP',enabled:true,allocationUsd:100,priceLow:90,priceHigh:110,levels:20,direction:'Neutral',takeProfitPercentage:10,stopLossPercentage:6,closePositionsOnStop:true}];const navigation=[];
  const pageFor=label=>({label,async url(){return 'https://backpack.exchange/portfolio/balances/assets';},async goto(){if(!labels.includes(label))throw Error('page label not found: '+label);navigation.push(label);},async waitForTimeout(){},async fetch(url,options={}){
   if(!labels.includes(label))throw Error('page label not found: '+label);
   const u=new URL(url);let body;
   if(options.method==='PATCH'){patches++;const op=JSON.parse(options.body).params.symbols[0];if(op.operation==='Delete'){deletes++;autos=[];}else autos=[op];return{status:200,body:'{}'};}
   if(u.pathname.endsWith('/collateral'))body=mode==='foreign-owner'?{'other-3':{netEquity:1000}}:{'fixture-3':{netEquity:1000,netEquityAvailable:500}};
   else if(u.pathname.endsWith('/automation'))body={params:{symbols:structuredClone(autos)}};
   else if(u.pathname.endsWith('/position'))body=[];
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
  return{mode,observationSpace:sid,observationPage:observation.page.label,actError,exit,peakError,patches,deletes,created,navigation,status:results.status,done:results.results.some(r=>r.act==='stop'&&r.done===true)};
 }finally{fs.rmSync(d,{recursive:true,force:true});}
}
(async()=>{
 const evidence=process.argv.includes('--evidence'),rows=[];let count=0;
 for(const mode of ['healthy','missing-primary','replaced-space','empty-space','foreign-owner']){
  const r=await run(mode);rows.push(r);if(evidence)continue;
  assert.equal(r.actError,null);assert.equal(r.peakError,null);
  if(mode==='foreign-owner'){assert.equal(r.exit,2);assert.equal(r.patches,0);assert.equal(r.done,false);}
  else{assert.equal(r.exit,0);assert.equal(r.deletes,1);assert.equal(r.done,true);assert.equal(r.status,'complete');}
  assert(r.navigation.every(label=>label===r.observationPage));assert.equal(r.created,mode==='empty-space'?1:0);count++;console.log('PASS production execution browser alignment: '+mode);
 }
 if(evidence)console.log(JSON.stringify(rows,null,2));else console.log(count+' execution browser alignment scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
