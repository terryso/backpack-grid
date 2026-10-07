'use strict';
// Read-only baseline proof and pure candidate proof. No account or exchange I/O.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const {finiteNumber}=require(path.join(root,'scripts/state_schema.cjs'));
const {parseCampaignConfig,updateCampaign}=require(path.join(root,'scripts/campaign_core.cjs'));
const r=spawnSync('git',['show','0642745:scripts/decide.cjs'],{cwd:root,encoding:'utf8'});assert.equal(r.status,0);
const start=r.stdout.indexOf('  // ---------- campaign volume tracking'),end=r.stdout.indexOf('  // ---------- equity curve',start);
const current={campaignId:1012,startsAt:'2026-10-07T00:00:00Z',endsAt:'2026-10-13T23:59:59Z',tiers:[10000,50000,150000]},legacy={last:{FAKE_USDC_PERP:1000},campaignVolume:64000,officialAt:'2026-10-06T22:00:00Z'};
const obs={at:'2026-10-07T12:00:00Z',officialCampaignId:1012,officialCampaignVolume:null,ledger:[{symbol:'FAKE_USDC_PERP',vol:1200}]};
const files=new Map([['/fixture/cloudflare/assets/campaign-history.json',JSON.stringify({current})],['/fixture/state/campaign.json',JSON.stringify(legacy)]]);
vm.runInNewContext(r.stdout.slice(start,end),{ROOT:'/fixture',path,fs:{readFileSync:p=>files.get(p)},obs,finiteNumber,Date,lines:[],writeAtomic:(p,v)=>files.set(p,v)});
const before=JSON.parse(files.get('/fixture/state/campaign.json'));
const after=updateCampaign(legacy,parseCampaignConfig({current}),obs,'fixture-3');
assert.equal(before.campaignVolume,64200);assert.equal(after.view.campaignVolume,null);assert.deepEqual(after.state.legacy[0].record,legacy);
console.log(JSON.stringify({baseline:'0642745',before:{volume:before.campaignVolume},after:{volume:after.view.campaignVolume,source:after.view.source,legacyPreserved:true},filesystemWrites:false,exchangeCalls:false},null,2));
