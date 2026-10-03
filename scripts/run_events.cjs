#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {ownerStart}=require('./execution_lease.cjs');
const {atomic,expectedIdentity,assertIdentity}=require('./contracts.cjs');
const ROOT=process.env.BG_ROOT||path.join(__dirname,'..'),p=s=>path.join(ROOT,'state',s);
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));
const identity=expectedIdentity(ROOT,cfg),command=process.argv[2];
fs.mkdirSync(p(''),{recursive:true});
if(command==='start') {
  try {const previous=JSON.parse(fs.readFileSync(p('act_results.json'),'utf8'));if(Array.isArray(previous.results)&&previous.results.length&&(!previous.identity||previous.identity.accountKey===identity.accountKey))atomic(p('last_action.json'),{...previous,legacy:!previous.identity});}catch(e){if(e.code!=='ENOENT')console.error('previous action summary unavailable');}
  const context={ownerPid:process.ppid,ownerStart:ownerStart(process.ppid),runId:randomUUID(),startedAt:new Date().toISOString(),dryrun:process.env.DRYRUN==='1',identity};
  atomic(p('run_context.json'),context);atomic(p('last_round_status'),'running');
  atomic(p('act_results.json'),{at:context.startedAt,runId:context.runId,planId:null,identity,status:'not_started',results:[]});
  fs.appendFileSync(p('run_events.jsonl'),JSON.stringify({...context,at:context.startedAt,type:'start'})+'\n');
} else {
  const context=JSON.parse(fs.readFileSync(p('run_context.json'),'utf8'));assertIdentity(identity,context.identity);
  const event={...context,at:new Date().toISOString(),type:command};
  if(command==='end')event.status=process.argv[3];
  if(command==='actions') {
    const result=JSON.parse(fs.readFileSync(p('act_results.json'),'utf8'));
    const meta=JSON.parse(fs.readFileSync(p('actions_meta.json'),'utf8'));
    assertIdentity(identity,result.identity);assertIdentity(identity,meta.identity);
    if(result.runId!==context.runId||meta.runId!==context.runId||result.planId!==meta.planId||Date.parse(result.at)<Date.parse(context.startedAt)) {
      event.results=[];event.resultStatus='unconfirmed';event.reason='result does not belong to current run/plan';
    } else {event.results=result.results;event.resultStatus=result.status;event.planId=meta.planId;}
    event.phase=process.argv[3];
    if(event.results?.length)atomic(p("last_action.json"),result);
  }
  fs.appendFileSync(p('run_events.jsonl'),JSON.stringify(event)+'\n');
}
