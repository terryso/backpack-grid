'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {stopBudgetUsage}=require('../scripts/dashboard_metrics.cjs');
const cfg={riskBudgetPct:80,stopLossPct:6,exitCostBufferUsd:15};
const grid=(value,sl=6)=>({allocationRaw:value,nativeSL:sl,nativeCloseOnStop:true});
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS',name);};
check('normal configured portfolio includes exit reserve once',()=>{const s=stopBudgetUsage([grid(1500),grid(1500),grid(2500),grid(2250)],600,cfg);assert.equal(s.usedUsd,480);assert.equal(s.budgetUsd,480);assert.equal(s.pct,100);assert.equal(s.remainingUsd,0);assert.equal(s.overBudget,false);});
check('actual looser SL consumes the larger stop amount',()=>assert.equal(stopBudgetUsage([grid(1000,8)],1000,cfg).usedUsd,95));
check('configuration is the conservative floor when actual SL is tighter',()=>assert.equal(stopBudgetUsage([grid(1000,4)],1000,cfg).usedUsd,75));
check('disabled configured grid still reserves its stop budget',()=>assert.equal(stopBudgetUsage([{...grid(1000),status:'Disabled'}],1000,cfg).usedUsd,75));
check('valid zero exit reserve is honored',()=>assert.equal(stopBudgetUsage([grid(1000)],1000,{...cfg,exitCostBufferUsd:0}).usedUsd,60));
check('empty configured portfolio retains only configured reserve',()=>assert.equal(stopBudgetUsage([],1000,cfg).usedUsd,15));
check('unknown protection is not zero risk',()=>{for(const g of [{...grid(1000),nativeSL:null},{...grid(1000),nativeCloseOnStop:false},{...grid(1000),allocationRaw:false}])assert.equal(stopBudgetUsage([g],1000,cfg).pct,null);});
check('zero and invalid equity never produce infinite or zero utilization',()=>{for(const eq of [0,-1,null,false,NaN])assert.equal(stopBudgetUsage([grid(1000)],eq,cfg).valid,false);});
check('invalid budget configuration is not silently defaulted',()=>assert.equal(stopBudgetUsage([grid(1000)],1000,{...cfg,riskBudgetPct:'80'}).valid,false));
check('over-budget utilization remains above 100 percent',()=>{const s=stopBudgetUsage([grid(1000)],50,cfg);assert.equal(s.pct,187.5);assert.equal(s.remainingUsd,-35);assert(s.overBudget);});
check('arithmetic overflow cannot produce a confirmed metric',()=>assert.equal(stopBudgetUsage([grid(1e308,100)],1000,cfg).valid,false));
const root=path.join(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bg-stop-budget-'));fs.mkdirSync(path.join(dir,'state'));
try{
 const identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'};
 const put=(p,v)=>fs.writeFileSync(path.join(dir,p),JSON.stringify(v));
 put('config.json',{...JSON.parse(fs.readFileSync(path.join(root,'config.json'))),...cfg});put('state/account_identity.json',identity);
 const obs={at:new Date().toISOString(),identity,gridRows:[{...grid(1000),market:'ETH-PERP',range:['90','110']}],positions:[],margin:{totalEquity:'1000',availableEquity:'500'}};put('state/observed.json',obs);
 const build=()=>{const p=spawnSync(process.execPath,[path.join(root,'scripts/dashboard_data.cjs')],{env:{...process.env,BG_ROOT:dir},encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(fs.readFileSync(path.join(dir,'state/dashboard.json')));};
 check('production snapshot publishes correctly derived budget',()=>assert.equal(build().stopBudget.pct,9.375));
 put('state/observed.json',{...obs,at:'2020-01-01T00:00:00Z'});
 check('stale observation removes risk-budget confirmation',()=>{const s=build();assert.equal(s.stopBudget.pct,null);assert.equal(s.stopBudget.valid,false);});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log(`${count} stop budget scenarios passed`);
