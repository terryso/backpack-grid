'use strict';
// Whole production observe -> decide, mocked session I/O and disposable state only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {ROOT,PY}=require('./env.cjs');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function run(leverage,pnl=10,notional=100,options={}){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-roi-'));
 try{
  fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(d,'cloudflare/assets'),{recursive:true});
  const identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'};
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json')));
  Object.assign(cfg,{maxGrids:1,gridValueUsd:10000,leverageCap:10,takeProfitPct:10,stopLossPct:6,autoExitsEnabled:true,positionStopLossPct:100,positionTakeProfitPct:75,accountFloorUsd:0});
  const put=(f,v)=>fs.writeFileSync(path.join(d,f),JSON.stringify(v));
  put('config.json',cfg);put('state/account_identity.json',identity);
  put('cloudflare/assets/campaign-history.json',{current:{campaignId:1012,startsAt:'2026-10-07T00:00:00Z',endsAt:'2026-10-13T23:59:59Z',tiers:[10000,50000]}});
  const mark=options.mark??100;
  const position={symbol:'ETH_USDC_PERP',netQuantity:1,markPrice:mark,breakEvenPrice:mark-pnl,netExposureNotional:notional,imf:0.1,cumulativeFundingPayment:0,estLiquidationPrice:1};
  const grid={symbol:position.symbol,enabled:true,direction:'Neutral',allocationUsd:10000,priceLow:90,priceHigh:110,levels:20,takeProfitPercentage:10,stopLossPercentage:6,closePositionsOnStop:true};
  const page={goto:async()=>{},waitForTimeout:async()=>{},fetch:async(url)=>{
   const p=new URL(url).pathname;let body;
   if(p.endsWith('/automation'))body={params:{symbols:[grid]},snapshot:{symbols:[{symbol:position.symbol,pnl:{soldValue:0,boughtValue:mark-pnl,netPosition:1,quoteAssetFees:0,baseAssetFees:0}}]}};
   else if(p.endsWith('/position'))body=[position];
   else if(p.endsWith('/account'))body={limitOrders:0,liquidating:options.liquidating===true,...(leverage===undefined?{}:{leverageLimit:leverage})};
   else if(p.endsWith('/collateral'))body={'fixture-3':{netEquity:5000,netEquityAvailable:4000}};
   else if(p.endsWith('/markPrices'))body=[{symbol:position.symbol,markPrice:mark}];
   else if(p.endsWith('/campaigns/1012/volume'))body={totalVolume:0};
   else throw Error('Unexpected fixture endpoint '+p);
   return{status:200,body:JSON.stringify(body)};
  }};
  const source=fs.readFileSync(path.join(ROOT,'scripts/observe.mjs'),'utf8').replace('const ROOT = "__BG_ROOT__";','const ROOT = '+JSON.stringify(d)+';');
  await new AsyncFunction('taskSpace','console','process',source)(async()=>({page:()=>page}),{log(){}},{exit(c){throw Error('Unexpected fixture observe exit '+c);}});
  const observed=JSON.parse(fs.readFileSync(path.join(d,'state/observed.json')));
  if(options.matureBreach)put('state/breach_dwell.json',{accountKey:identity.accountKey,markets:{'ETH-PERP':{side:'low',since:new Date(Date.parse(observed.at)-15*60000).toISOString()}}});
  const result=spawnSync(process.execPath,[path.join(ROOT,'scripts/decide.cjs')],{env:{...process.env,PY_BIN:PY,BG_ROOT:d,BG_OFFLINE:'1',BG_PHASE:'',NODE_OPTIONS:'--require '+JSON.stringify(path.join(ROOT,'tests/no_network.cjs'))},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const actions=JSON.parse(fs.readFileSync(path.join(d,'state/actions.json')));
  const risk=JSON.parse(fs.readFileSync(path.join(d,'state/risk.json')));
  return{inputLeverage:leverage===undefined?'missing':leverage,pnl,notional,observedError:observed.error||null,accountLeverage:observed.accountLeverageLimit,roi:observed.positions[0].pnlPct,initMargin:observed.positions[0].initMargin,pausedReason:risk.paused?.reason??null,actions:actions.map(a=>({act:a.act,reason:a.reason}))};
 }finally{fs.rmSync(d,{recursive:true,force:true});}
}
const controls=[{leverage:10,pnl:5,roi:50,exit:null},{leverage:5,pnl:10,roi:50,exit:null},{leverage:'5',pnl:10,roi:50,exit:null},{leverage:10,pnl:10,roi:100,exit:'AUTO_TP'},{leverage:10,pnl:-10,roi:-100,exit:'AUTO_SL'}];
const invalid=[undefined,null,false,true,0,-20,'','  ',[],[20],{},'garbage','0x10','Infinity'];
(async()=>{
 const evidence=process.argv.includes('--evidence');const rows=[];let count=0;
 for(const c of controls){const r=await run(c.leverage,c.pnl);rows.push(r);if(evidence)continue;
  assert.equal(r.observedError,null);assert.equal(r.roi,c.roi);assert.equal(r.actions.length,c.exit?1:0);if(c.exit)assert(r.actions[0].reason.startsWith(c.exit));count++;console.log('PASS production ROI valid control '+JSON.stringify(c));}
 for(const leverage of invalid){const r=await run(leverage);rows.push(r);if(evidence)continue;
  assert.equal(r.observedError,null,'unrelated account and grid risk data must survive');assert.equal(r.roi,null,'unknown leverage cannot establish ROI');assert.equal(r.initMargin,null,'unknown leverage cannot establish margin');assert.equal(r.actions.length,0,'unknown ROI cannot manufacture AUTO_SL/TP');count++;console.log('PASS production ROI unknown leverage '+JSON.stringify(r.inputLeverage));}
 for(const notional of [0,-100]){const r=await run(10,10,notional);rows.push(r);if(evidence)continue;
  assert.equal(r.roi,null);assert.equal(r.initMargin,null);assert.equal(r.actions.length,0);count++;console.log('PASS production ROI non-positive denominator '+notional);}
 for(const c of [{options:{mark:80,matureBreach:true},reason:'AUTO_RANGE_EXIT'},{options:{liquidating:true},reason:'circuit breaker:'}]){
  const r=await run(undefined,10,100,c.options);rows.push(r);if(evidence)continue;
  assert.equal(r.observedError,null);assert.equal(r.roi,null);assert(r.actions.some(a=>a.act==='stop'&&a.reason.startsWith(c.reason)),JSON.stringify(r.actions));if(c.options.liquidating)assert.equal(r.pausedReason,'account liquidating');count++;console.log('PASS other risk exit survives unknown ROI: '+c.reason);
 }
 if(evidence)console.log(JSON.stringify(rows,null,2));else console.log(count+' position ROI production scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
