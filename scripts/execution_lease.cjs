'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {assertIdentity,hash}=require('./contracts.cjs');
function ownerStart(pid) { const r=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000,env:{...process.env,LC_ALL:'C'}});return r.status===0?r.stdout.trim():null; }
function verifyLease(root,meta,identity) {
  const context=JSON.parse(fs.readFileSync(path.join(root,'state/run_context.json'),'utf8'));
  const plan=JSON.parse(fs.readFileSync(path.join(root,'state/actions_meta.json'),'utf8'));
  const status=fs.readFileSync(path.join(root,'state/last_round_status'),'utf8').trim();
  assertIdentity(identity,context.identity);assertIdentity(identity,plan.identity);
  const age=Date.now()-Date.parse(meta.at);
  if(context.runId!==meta.runId||plan.runId!==meta.runId||plan.planId!==meta.planId||plan.configHash!==meta.configHash||plan.actionsHash!==meta.actionsHash||status!=='running'||!context.ownerPid||!context.ownerStart||ownerStart(context.ownerPid)!==context.ownerStart||!Number.isFinite(age)||age< -60000||age>10*60000)throw Error('EXECUTION_LEASE_REVOKED');
  if(meta.configHash&&hash(JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')))!==meta.configHash)throw Error('EXECUTION_CONFIG_CHANGED');
}
module.exports={ownerStart,verifyLease};
