#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const {expectedIdentity,atomic,hash}=require('./contracts.cjs'),{chooseBaseline,validateWindow}=require('./verified_window.cjs');
const root=process.env.BG_ROOT||path.join(__dirname,'..'),identity=expectedIdentity(root,JSON.parse(fs.readFileSync(path.join(root,'config.json'))));
const file=path.join(root,'state/verified_window.json');let window;
const rows=fs.readFileSync(path.join(root,'state/equity_curve.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean);
try{window=JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;}
if(window&&!window.sourceRecord){
  const record=rows.find(r=>hash(r)===window.baseline?.recordHash&&r.accountKey===identity.accountKey&&r.at===window.baseline.at&&Number(r.equity)===Number(window.baseline.equity));
  if(!record)throw Error('baseline source evidence missing');
  window={...window,sourceRecord:record};validateWindow(window,identity);atomic(file,window);
}
if(!window){window=chooseBaseline(rows,identity);atomic(file,window);}else validateWindow(window,identity);
console.log({baselineAt:window.baseline.at,baselineEquity:window.baseline.equity,originalHistoryPreserved:true});
