// Read-only accounting; independent of trading observation and risk exits.
const fs=await import('node:fs/promises'),path=await import('node:path'),{createRequire}=await import('node:module');
const ROOT='__BG_ROOT__',req=createRequire(path.join(ROOT,'scripts/collect_verified_window.mjs')); // placeholder injected by ego_dispatch.sh
const {expectedIdentity,assertIdentity,collateralFor,atomic,hash}=req('./contracts.cjs');
const {validateWindow,chooseCheckpoint,collectPeriod,reconcile}=req('./verified_window.cjs');
const cfg=JSON.parse(await fs.readFile(path.join(ROOT,'config.json'),'utf8')),identity=expectedIdentity(ROOT,cfg);
const window=validateWindow(JSON.parse(await fs.readFile(path.join(ROOT,'state/verified_window.json'),'utf8')),identity);
const curve=(await fs.readFile(path.join(ROOT,'state/equity_curve.jsonl'),'utf8')).split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean);
const checkpoint=chooseCheckpoint(curve,window);
const task=await taskSpace(cfg.watch.spaceId),browserFile=path.join(ROOT,'state/accounting_browser.json');let browser;
try{browser=JSON.parse(await fs.readFile(browserFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
let page;if(browser&&browser.spaceId===task.spaceId)page=task.page(browser.page);else{page=await task.newPage();atomic(browserFile,{spaceId:task.spaceId,page:page.label});}
await page.goto(cfg.tradeUrlBase+'SOL_USD_PERP');
async function get(url){const r=await page.fetch('https://api.backpack.exchange'+url,{credentials:'include',timeout:15000});if(r.status!==200)throw Error('accounting source HTTP '+r.status);return JSON.parse(r.body);}
async function accountCheck(){collateralFor(await get('/wapi/v1/portfolio/collateral'),identity);}
await accountCheck();
const proofFile=path.join(ROOT,'state/window_routing_proof.json');let proof;
try{proof=JSON.parse(await fs.readFile(proofFile,'utf8'));assertIdentity(identity,proof.identity);}catch(e){if(e.code!=='ENOENT')throw e;}
if(proof&&(!Number.isFinite(Date.parse(proof.at))||Date.parse(proof.at)>Date.now()+60000
  ||['deposits','interest'].some(k=>!proof.checks?.[k]||!/^[a-f0-9]{64}$/.test(proof.checks[k].targetHash)
    ||!/^[a-f0-9]{64}$/.test(proof.checks[k].unscopedHash)
    ||proof.checks[k].routingDistinct!==(proof.checks[k].targetHash!==proof.checks[k].unscopedHash))))throw Error('account routing proof invalid');
if(!proof||Date.now()-Date.parse(proof.at)>86400000){
  const checks={};
  for(const [kind,endpoint]of Object.entries({deposits:'/wapi/v1/capital/deposits',interest:'/wapi/v1/history/interest'})){
    await accountCheck();const scoped=await get(endpoint+'?subaccountId='+identity.subaccountId+'&limit=10&sortDirection=Desc');
    const unscoped=await get(endpoint+'?limit=10&sortDirection=Desc');
    checks[kind]={targetHash:hash(scoped),unscopedHash:hash(unscoped),routingDistinct:hash(scoped)!==hash(unscoped)};
  }
  await accountCheck();proof={identity,at:new Date().toISOString(),checks};atomic(proofFile,proof);
}
const sources={},from=Date.parse(window.baseline.at),through=Date.parse(checkpoint.at);
for(const [kind,endpoint,timeField]of [
  ['funding','/wapi/v1/history/funding','intervalEndTimestamp'],
  ['interest','/wapi/v1/history/interest','timestamp'],
  ['deposits','/wapi/v1/capital/deposits','createdAt'],
  ['withdrawals','/wapi/v1/capital/withdrawals','createdAt'],
  ['platformCredits','/wapi/v1/capital/deposits/all','createdAt']]){
  const scope=kind==='platformCredits'?'user-wide-inclusive':'target-subaccount';
  const query=kind==='platformCredits'?'':'subaccountId='+identity.subaccountId+'&';
  const src=await collectPeriod(from,through,async offset=>{await accountCheck();return get(endpoint+'?'+query+'limit=1000&offset='+offset+'&sortDirection=Desc');},r=>r[timeField]);
  sources[kind]={...src,scope,endpoint,routingVerified:proof.checks[kind]?.routingDistinct===true};
}
await accountCheck();
const capturedAt=new Date().toISOString(),capture={identity,asOf:checkpoint.at,equityAt:checkpoint.at,equity:Number(checkpoint.equity),capturedAt,sources};
capture.captureHash=hash(capture);
atomic(path.join(ROOT,'state/window_sources.json'),capture); // private source rows never copied into dashboard/docs
async function optional(file){try{return JSON.parse(await fs.readFile(path.join(ROOT,'state',file),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const previousSnapshot=await optional('window_accounting.json');
if(previousSnapshot)assertIdentity(identity,previousSnapshot.identity);
if(previousSnapshot&&previousSnapshot.windowBaselineHash!==hash(window.baseline))throw Error('accounting baseline changed; separate window required');
const output=reconcile(window,capture,await optional('attribution_ledger.json'),previousSnapshot?.ledger);
// One commit contains matching coverage, events and report; UI never mixes versions.
atomic(path.join(ROOT,'state/window_accounting.json'),{identity,windowBaselineHash:hash(window.baseline),captureHash:capture.captureHash,capturedAt,capture,...output});
atomic(path.join(ROOT,'state/window_status.json'),{at:capturedAt,ok:true});
console.log({accountingPeriodThrough:checkpoint.at,baselineAt:window.baseline.at,netPnl:output.report.netPnl,
  cashflowComplete:output.report.cashflowComplete,decompositionComplete:output.report.decompositionComplete,issues:output.report.issues});
