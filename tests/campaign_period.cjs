'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {ROOT,PY}=require('./env.cjs');
const {parseCampaignConfig,updateCampaign,campaignView}=require('../scripts/campaign_core.cjs');
const owner='fixture-3',c1={campaignId:1011,startsAt:'2026-09-30T00:00:00Z',endsAt:'2026-10-06T23:59:59Z',tiers:[50000,100000]},c2={campaignId:1012,startsAt:'2026-10-07T00:00:00Z',endsAt:'2026-10-13T23:59:59Z',tiers:[10000,50000,150000]};
const at='2026-10-07T12:00:00Z',clone=v=>JSON.parse(JSON.stringify(v));
const obs=(id=1012,volume=null,ledger=1200)=>({at,officialCampaignId:id,officialCampaignVolume:volume,ledger:[{symbol:'FAKE_USDC_PERP',vol:ledger}]});
function seed(c=c2,volume=60000){return {schemaVersion:2,accountKey:owner,activeCampaignId:c.campaignId,periods:{[c.campaignId]:{campaignId:c.campaignId,startsAt:c.startsAt,endsAt:c.endsAt,campaignVolume:volume,source:'official',officialAt:c===c1?'2026-10-06T22:00:00Z':'2026-10-07T10:00:00Z',last:{FAKE_USDC_PERP:1000},ledgerDeltaSinceBaseline:0}},legacy:[]};}
let n=0;const check=(name,fn)=>{fn();n++;console.log('PASS',name);};
check('campaign config validates canonical period',()=>assert.deepEqual(parseCampaignConfig({current:c2}),c2));
for(const value of [null,false,[],{},''])check('invalid campaign id rejected '+JSON.stringify(value),()=>assert.throws(()=>parseCampaignConfig({current:{...c2,campaignId:value}})));
check('missing start and unordered tiers rejected',()=>{assert.throws(()=>parseCampaignConfig({current:{...c2,startsAt:null}}));assert.throws(()=>parseCampaignConfig({current:{...c2,tiers:[50000,10000]}}));});
const legacy={last:{FAKE_USDC_PERP:1000},campaignVolume:64000,officialAt:'2026-10-06T22:00:00Z',correctionNote:'preserve me'};
check('legacy counter is preserved but not reassigned to new period',()=>{const p=updateCampaign(legacy,c2,obs(),owner);assert.equal(p.view.campaignVolume,null);assert.deepEqual(p.state.legacy[0].record,legacy);assert.equal(p.state.periods['1012'].last.FAKE_USDC_PERP,1200);});
check('legacy timestamp inside current period still cannot prove ownership',()=>assert.equal(updateCampaign({...legacy,officialAt:at},c2,obs(),owner).view.campaignVolume,null));
check('period switch preserves old typed record and restarts baseline',()=>{const s=seed(c1),p=updateCampaign(s,c2,obs(),owner);assert.deepEqual(p.state.periods['1011'],s.periods['1011']);assert.equal(p.view.campaignVolume,null);assert.equal(p.state.periods['1012'].ledgerDeltaSinceBaseline,0);assert.deepEqual(s,seed(c1));});
check('same-period fallback retains correct increment and marks estimate',()=>{const p=updateCampaign(seed(),c2,obs(),owner);assert.equal(p.view.campaignVolume,60200);assert.equal(p.view.source,'estimated');assert.equal(p.view.tier1Secured,false);});
check('official recovery overrides estimates without double counting',()=>{const a=updateCampaign(seed(),c2,obs(),owner);const b=updateCampaign(a.state,c2,obs(1012,2300,1300),owner);assert.equal(b.view.campaignVolume,2300);assert.equal(b.view.source,'official');});
check('genuine official zero establishes valid baseline',()=>{const p=updateCampaign(legacy,c2,obs(1012,0),owner);assert.equal(p.view.campaignVolume,0);assert.equal(p.view.source,'official');});
check('wrong-period response is rejected even when amount is valid',()=>assert.equal(updateCampaign(legacy,c2,obs(1011,64000),owner).view.campaignVolume,null));
check('unbound response cannot establish official baseline',()=>assert.equal(updateCampaign(legacy,c2,obs(null,64000),owner).view.campaignVolume,null));
check('new period remains unknown across failures before first official result',()=>{let p=updateCampaign(legacy,c2,obs(),owner);p=updateCampaign(p.state,c2,obs(1012,null,1400),owner);assert.equal(p.view.campaignVolume,null);assert.equal(p.state.periods['1012'].ledgerDeltaSinceBaseline,200);});
check('replaying same fallback snapshot does not add volume twice',()=>{const a=updateCampaign(seed(),c2,obs(),owner);assert.equal(updateCampaign(a.state,c2,obs(),owner).view.campaignVolume,60200);});
check('ledger reset never subtracts or counts old volume',()=>assert.equal(updateCampaign(seed(),c2,obs(1012,null,5),owner).view.campaignVolume,60000));
check('numeric strings in stored state are normalized before arithmetic',()=>{const s=seed();s.periods['1012'].campaignVolume='60000';s.periods['1012'].ledgerDeltaSinceBaseline='0';assert.equal(updateCampaign(s,c2,obs(),owner).view.campaignVolume,60200);});
check('unknown numerical values cannot enter fallback sums',()=>{for(const v of [null,false,'',[],{}])assert.equal(updateCampaign(seed(),c2,obs(1012,null,v),owner).view.campaignVolume,60000);});
check('owner mismatch is refused without mutating state',()=>{const s=seed(),before=clone(s);assert.throws(()=>updateCampaign(s,c2,obs(),'other-3'));assert.deepEqual(s,before);});
check('corrupt period structure is refused',()=>{const s=seed();s.periods['1012'].last=[];assert.throws(()=>updateCampaign(s,c2,obs(),owner));});
check('boundary edits preserve superseded record, never reuse its total',()=>{const s=seed(),p=updateCampaign(s,{...c2,endsAt:'2026-10-14T23:59:59Z'},obs(),owner);assert.equal(p.view.campaignVolume,null);assert.deepEqual(p.state.legacy[0].record,s.periods['1012']);});
check('inactive periods do not advance ledger or rewrite state',()=>{const s=seed(),p=updateCampaign(s,c2,{...obs(),at:'2026-10-14T00:00:00Z'},owner);assert.equal(p.active,false);assert.strictEqual(p.state,s);});
check('dashboard never projects another period or a legacy unbound total',()=>{assert.equal(campaignView(seed(c1),c2,owner).campaignVolume,null);assert.equal(campaignView(legacy,c2,owner).campaignVolume,null);});
check('only an official value can secure a tier',()=>assert(updateCampaign(seed(),c2,obs(1012,10000),owner).view.tier1Secured));

// Production decide and dashboard entrypoints, with all state in disposable fixtures.
const base=fs.mkdtempSync(path.join(os.tmpdir(),'bg-period-'));
const put=(d,f,x)=>fs.writeFileSync(path.join(d,f),typeof x==='string'?x:JSON.stringify(x));
function fixture(state,response=obs()){
 const d=fs.mkdtempSync(path.join(base,'case-'));fs.mkdirSync(path.join(d,'state'));fs.mkdirSync(path.join(d,'cloudflare/assets'),{recursive:true});
 put(d,'config.json',JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json'))));put(d,'state/account_identity.json',{userId:'fixture',subaccountId:3,accountKey:owner});
 put(d,'cloudflare/assets/campaign-history.json',{current:c2});if(state!==undefined)put(d,'state/campaign.json',state);
 put(d,'state/observed.json',{...response,identity:{userId:'fixture',subaccountId:3,accountKey:owner},gridRows:[],positions:[],badges:{},margin:{totalEquity:'500',availableEquity:'400',openPnl:'0'}});
 put(d,'clock.cjs','const R=Date;const t=R.parse("'+at+'");global.Date=class extends R{constructor(...a){super(...(a.length?a:[t]));}static now(){return t;}};');
 return d;
}
function entry(d,name){const r=spawnSync(process.execPath,['--require',path.join(d,'clock.cjs'),path.join(ROOT,'scripts',name)],{env:{...process.env,PY_BIN:PY,BG_ROOT:d,BG_OFFLINE:'1',NODE_OPTIONS:'--require '+JSON.stringify(path.join(ROOT,'tests/no_network.cjs'))},encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return r;}
try{
 check('production decide migrates legacy without cross-period fallback',()=>{const d=fixture(legacy);entry(d,'decide.cjs');const s=JSON.parse(fs.readFileSync(path.join(d,'state/campaign.json')));assert.equal(s.periods['1012'].campaignVolume,null);assert.deepEqual(s.legacy[0].record,legacy);const curve=JSON.parse(fs.readFileSync(path.join(d,'state/equity_curve.jsonl'),'utf8').trim());assert.equal(curve.campaignVolume,null);});
 check('production decide uses tagged official response',()=>{const d=fixture(legacy,obs(1012,2300));entry(d,'decide.cjs');assert.equal(JSON.parse(fs.readFileSync(path.join(d,'state/campaign.json'))).periods['1012'].campaignVolume,2300);});
 check('production dashboard hides unbound legacy amount',()=>{const d=fixture(legacy);entry(d,'dashboard_data.cjs');const x=JSON.parse(fs.readFileSync(path.join(d,'state/dashboard.json')));assert.equal(x.campaignVolume,null);assert.equal(x.tier1,10000);assert.equal(x.tier1Secured,false);});
 check('public campaign projection omits private owner and archived records',()=>{const d=fixture(seed());entry(d,'dashboard_data.cjs');const text=fs.readFileSync(path.join(d,'state/dashboard.json'),'utf8'),x=JSON.parse(text);assert.equal(x.campaignVolume,60000);assert.equal(x.campaignSource,'official');assert(!text.includes('fixture-3'));assert(!text.includes('legacy record'));});
 check('broken campaign JSON preserves bytes and existing risk stop plan',()=>{const d=fixture('{broken');const o=JSON.parse(fs.readFileSync(path.join(d,'state/observed.json')));o.margin.totalEquity='100';o.gridRows=[{market:'FAKE-PERP',symbol:'FAKE_USDC_PERP',range:[100,110],status:'Triggered',nativeTP:10,nativeSL:6,nativeCloseOnStop:true,allocationRaw:1000,pnlRaw:0,pnlPct:0}];put(d,'state/observed.json',o);put(d,'state/risk.json',{accountKey:owner,peakEquity:1000,paused:null});entry(d,'decide.cjs');assert.equal(fs.readFileSync(path.join(d,'state/campaign.json'),'utf8'),'{broken');assert(JSON.parse(fs.readFileSync(path.join(d,'state/actions.json'))).some(a=>a.act==='stop'));});
 check('JSON null state is not silently replaced',()=>{const d=fixture('null');entry(d,'decide.cjs');assert.equal(fs.readFileSync(path.join(d,'state/campaign.json'),'utf8'),'null');});
 check('JSON array state is not silently replaced',()=>{const d=fixture('[]');entry(d,'decide.cjs');assert.equal(fs.readFileSync(path.join(d,'state/campaign.json'),'utf8'),'[]');});
 check('bad campaign config cannot block pending verification',()=>{const d=fixture(seed());put(d,'cloudflare/assets/campaign-history.json','{broken');put(d,'state/pending_stops.json',{'FAKE-PERP':{accountKey:owner,at,reason:'fixture cleanup'}});entry(d,'decide.cjs');assert(JSON.parse(fs.readFileSync(path.join(d,'state/actions.json'))).some(a=>a.act==='stop'));});
 check('rebased dashboard retains campaign projection, grid age and auto-exit settings together',()=>{
  const d=fixture(seed()),cfg=JSON.parse(fs.readFileSync(path.join(d,'config.json'))),o=JSON.parse(fs.readFileSync(path.join(d,'state/observed.json')));
  cfg.autoExitsEnabled=true;cfg.positionStopLossPct=175;cfg.positionTakeProfitPct=125;put(d,'config.json',cfg);
  o.gridRows=[{market:'FAKE-PERP',status:'Triggered',range:[90,110],value:1000,pnl:10,pnlPct:1}];put(d,'state/observed.json',o);
  put(d,'state/run_events.jsonl',JSON.stringify({at:'2026-10-07T11:50:00Z',type:'actions',identity:o.identity,results:[{act:'create',market:'FAKE-PERP',done:true}]})+'\n');
  entry(d,'dashboard_data.cjs');const x=JSON.parse(fs.readFileSync(path.join(d,'state/dashboard.json')));
  assert.equal(x.campaignVolume,60000);assert.equal(x.campaignSource,'official');assert.equal(x.grids[0].gridAgeLabel,'10 分钟');
  assert.equal(x.autoExits.enabled,true);assert.equal(x.autoExits.posSl,175);assert.equal(x.autoExits.posTp,125);
 });
 check('legacy correction metadata survives migration while current official volume establishes a new baseline',()=>{
  const prior={...legacy,correctedAt:'2026-10-07T09:00:00Z',correctionNote:'fixture manual correction, retained privately'};
  const d=fixture(prior,obs(1012,2300));entry(d,'decide.cjs');const x=JSON.parse(fs.readFileSync(path.join(d,'state/campaign.json')));
  assert.deepEqual(x.legacy[0].record,prior);assert.equal(x.periods['1012'].campaignVolume,2300);assert.equal(x.periods['1012'].source,'official');
  entry(d,'dashboard_data.cjs');const text=fs.readFileSync(path.join(d,'state/dashboard.json'),'utf8');assert(!text.includes('fixture manual correction'));
 });
}finally{fs.rmSync(base,{recursive:true,force:true});}

// Execute the production renderer, including source labels and mismatched static assets.
const html=fs.readFileSync(path.join(ROOT,'cloudflare/dashboard.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1].split('function markLiked()')[0];
const elements=new Map(),document={getElementById:id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',classList:{remove(){},toggle(){}}});return elements.get(id);}};
// The active-campaign fixture must not expire when the wall clock passes Oct 13.
class CampaignClock extends Date{constructor(...args){super(...(args.length?args:[Date.parse(at)]));}static now(){return Date.parse(at);}}
const ctx={document,window:{},Date:CampaignClock,fetch:async()=>({ok:false,status:404})};vm.runInNewContext(script,ctx);ctx.h={current:c2,history:[]};vm.runInNewContext('HIST=h',ctx);
function render(id,volume,source){ctx.s={updatedAt:new Date().toISOString(),equity:500,grids:[],positions:[],pending:[],curve:[],campaignId:id,campaignVolume:volume,campaignSource:source};vm.runInNewContext('render(s)',ctx);return elements.get('content').innerHTML;}
check('unknown campaign displays pending instead of a false official zero',()=>{const h=render(1012,null,'unknown');assert(h.includes('活动量待核对'));assert(!h.includes('已锁定'));assert(!h.includes('累计 0 USD'));assert(!h.includes('class="bar"'),'unknown progress must not appear complete');});
check('estimate does not claim official data or secured rewards',()=>{const h=render(1012,10200,'estimated');assert(h.includes('网格账本估算'));assert(!h.includes('已锁定'));assert(!h.includes(' ✓'));});
check('official values retain tier display (live campaign)',()=>{ctx.h={current:{...c2,endsAt:'2026-12-31T23:59:59Z'},history:[]};vm.runInNewContext('HIST=h',ctx);const h=render(1012,10200,'official');assert(h.includes('已锁定 1 盲盒'));assert(h.includes('Backpack 官方接口数据'));assert(h.includes('class="bar"'),'known progress must remain visible');});
check('stale frontend period cannot display another campaign total',()=>{const h=render(1011,64000,'official');assert(h.includes('活动量待核对'));assert(!h.includes('64,000'));assert(!h.includes('class="bar"'),'mismatched period has no verified progress');});
check('numeric-string static period id matches the canonical numeric snapshot id',()=>{ctx.h={current:{...c2,campaignId:'1012',endsAt:'2026-12-31T23:59:59Z'},history:[]};vm.runInNewContext('HIST=h',ctx);assert(render(1012,10200,'official').includes('已锁定 1 盲盒'));});
console.log(n+' campaign period cases passed');
