#!/usr/bin/env node
// Serialized through the same kernel wrapper; no unbound/cross-account imports.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {validateLedger}=require('./accounting.cjs');
const {atomic,expectedIdentity,same}=require('./contracts.cjs');
const ROOT=process.env.BG_ROOT||path.join(__dirname,'..');
if(!process.argv[2])throw Error('usage: import_ledger.cjs <reconciled-export.json>');
if(process.env.BG_LEDGER_LOCKED!=='1') {
  const r=spawnSync('/Users/nick/.browser-use-env/bin/python3',[path.join(ROOT,'scripts/with_lock.py'),'--name','ledger','--wait','5',process.execPath,__filename,path.resolve(process.argv[2])],{env:{...process.env,BG_ROOT:ROOT,BG_LEDGER_LOCKED:'1'},encoding:'utf8',timeout:10000});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
}
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8')),identity=expectedIdentity(ROOT,cfg);
const incoming=validateLedger(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
if(incoming.subaccountId!==identity.subaccountId||incoming.accountKey!==identity.accountKey)throw Error('ledger account mismatch');
const target=path.join(ROOT,'state/attribution_ledger.json');let old={accountKey:identity.accountKey,subaccountId:identity.subaccountId,events:[],coverage:{}};
try{old=validateLedger(JSON.parse(fs.readFileSync(target,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
if(old.subaccountId!==identity.subaccountId||old.accountKey!==identity.accountKey)throw Error('existing ledger account mismatch');
const events=new Map(old.events.map(e=>[e.id,e]));
for(const e of incoming.events){if(events.has(e.id)&&!same(events.get(e.id),e))throw Error('immutable event ID conflict');events.set(e.id,e);}
const coverage={...old.coverage};
for(const [kind,c]of Object.entries(incoming.coverage)){
  const previous=coverage[kind];if(!previous){coverage[kind]=c;continue;}
  const gap=Date.parse(c.from)>Date.parse(previous.through)||Date.parse(previous.from)>Date.parse(c.through);
  if(gap)throw Error('coverage gap: '+kind);
  coverage[kind]={from:new Date(Math.min(Date.parse(previous.from),Date.parse(c.from))).toISOString(),through:new Date(Math.max(Date.parse(previous.through),Date.parse(c.through))).toISOString(),source:[...new Set([previous.source,c.source])].join('; ')};
}
const merged=validateLedger({...old,events:[...events.values()],coverage});atomic(target,merged);
console.log('ledger imported:',events.size,'events; reconciled source coverage retained');
