#!/usr/bin/env node
// Explicit local intention; does not send any exchange order or configuration request.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');const {atomic,expectedIdentity,assertIdentity,manualPausesFor}=require('./contracts.cjs');
const root=process.env.BG_ROOT||path.join(__dirname,'..'),cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'))),identity=expectedIdentity(root,cfg);
const market=process.argv[2],operation=process.argv[3]||'hold';if(!market||!['hold','clear'].includes(operation))throw Error('usage: manual_pause.cjs <MARKET-PERP|*> [hold|clear]');
// The round lock serializes intentions with actors as well as other local edits.
if(process.env.BG_MANUAL_LOCKED!=='1') {
  const r=spawnSync(process.env.PY_BIN||'python3',[path.join(root,'scripts/with_lock.py'),'--wait','45',process.execPath,__filename,market,operation],{env:{...process.env,BG_ROOT:root,BG_MANUAL_LOCKED:'1'},encoding:'utf8',timeout:55000});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
}
const obs=JSON.parse(fs.readFileSync(path.join(root,'state/observed.json')));assertIdentity(identity,obs.identity);
if(market!=='*'&&!/^[A-Z0-9]+-PERP$/.test(market))throw Error('invalid market');
if(operation==='hold'&&market!=='*'&&(!Array.isArray(obs.gridRows)||!obs.gridRows.some(g=>g.market===market)))throw Error('market not configured');
const file=path.join(root,'state/manual_pauses.json'),data=manualPausesFor(root,identity);
if(operation==='clear')delete data[market];else data[market]={accountKey:identity.accountKey,at:new Date().toISOString(),intent:'hold'};
atomic(file,data);console.log('local manual intention updated; exchange settings unchanged');
