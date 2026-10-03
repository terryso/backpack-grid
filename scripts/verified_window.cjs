'use strict';
const {plainObject,finiteNumber}=require('./state_schema.cjs');
const {assertIdentity,hash,same}=require('./contracts.cjs');
const {fillTimestamp}=require('./history_core.cjs');
const {attribution,validateLedger}=require('./accounting.cjs');
function chooseBaseline(rows,identity,now=Date.now()) {
  const candidates=rows.filter(r=>plainObject(r)&&r.accountKey===identity.accountKey&&r.simulated!==true
    &&Number.isFinite(Date.parse(r.at))&&Date.parse(r.at)<=now&&finiteNumber(r.equity)&&Number(r.equity)>0)
    .sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(!candidates.length)throw Error('no account-bound equity baseline');
  const r=candidates[0];
  return {schemaVersion:1,identity,sourceRecord:r,baseline:{at:r.at,equity:Number(r.equity),precisionUsd:.01,
    source:'account-bound equity_curve; dryrun means real readonly account observation',recordHash:hash(r)},createdAt:new Date(now).toISOString()};
}
function validateWindow(window,identity) {
  if(!plainObject(window)||window.schemaVersion!==1)throw Error('invalid accounting window');
  assertIdentity(identity,window.identity);
  const b=window.baseline;
  if(!plainObject(b)||typeof b.at!=='string'||!b.at.endsWith('Z')||!Number.isFinite(Date.parse(b.at))
    ||!finiteNumber(b.equity)||Number(b.equity)<=0||typeof b.recordHash!=='string'||!/^[a-f0-9]{64}$/.test(b.recordHash))throw Error('invalid accounting baseline');
  const r=window.sourceRecord;
  if(!plainObject(r)||r.accountKey!==identity.accountKey||r.simulated===true||r.at!==b.at
    ||!finiteNumber(r.equity)||Number(r.equity)!==Number(b.equity)||hash(r)!==b.recordHash)throw Error('accounting baseline/source binding invalid');
  return window;
}
function chooseCheckpoint(rows,window,now=Date.now(),lagMs=120000) {
  const matching=rows.filter(r=>plainObject(r)&&r.accountKey===window.identity.accountKey&&r.simulated!==true
    &&finiteNumber(r.equity)&&Date.parse(r.at)>=Date.parse(window.baseline.at)&&Date.parse(r.at)<=now-lagMs)
    .sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(!matching.length||now-Date.parse(matching.at(-1).at)>45*60000)throw Error('no recent mature account checkpoint');
  return matching.at(-1);
}
// Payment histories support descending pagination. Validate ordering before using
// an old timestamp to establish that the entire accounting period was visited.
async function collectPeriod(from,through,fetchBatch,timeOf,maxPages=20) {
  const rows=[];let complete=false,error=null,previous=Infinity;
  try {
    for(let page=0;page<maxPages;page++) {
      const batch=await fetchBatch(page*1000);
      if(!Array.isArray(batch)||batch.length>1000)throw Error('invalid history page');
      for(const row of batch) {
        if(!plainObject(row))throw Error('invalid history row');
        const t=fillTimestamp(timeOf(row));
        if(!Number.isFinite(t)||t>previous)throw Error('history timestamp/order invalid');
        previous=t;
        if(t>from&&t<=through)rows.push(row);
      }
      if(batch.length<1000||previous<=from){complete=true;break;}
    }
    if(!complete)throw Error('history pagination limit reached');
  }catch(e){error=String(e.message);}
  return {from:new Date(from).toISOString(),through:new Date(through).toISOString(),complete,error,rows};
}
function reconcile(window,capture,manual,previous) {
  const identity=window.identity;validateWindow(window,identity);assertIdentity(identity,capture.identity);
  if(!finiteNumber(capture.equity)||!Number.isFinite(Date.parse(capture.equityAt)))throw Error('equity unknown');
  const from=window.baseline.at,through=capture.asOf;
  if(!Number.isFinite(Date.parse(through))||Date.parse(through)<Date.parse(from)||through!==capture.equityAt)throw Error('accounting period/equity boundary mismatch');
  const coverage={},events=[],issues=[];
  const source=name=>{
    const s=capture.sources[name];
    if(!plainObject(s)||s.complete!==true||s.from!==from||s.through!==through||!Array.isArray(s.rows))throw Error(name+' history incomplete');
    const key=name==='funding'?'intervalEndTimestamp':name==='interest'?'timestamp':'createdAt';
    if(s.rows.some(r=>!plainObject(r)||!Number.isFinite(fillTimestamp(r[key]))||fillTimestamp(r[key])<=Date.parse(from)||fillTimestamp(r[key])>Date.parse(through)))throw Error(name+' history boundary invalid');
    return s;
  };
  const add=(kind,id,at,amount)=>events.push({id,accountKey:identity.accountKey,type:kind,at,amountUsd:amount,source:'authenticated Backpack '+kind+' history'});
  const declare=kind=>coverage[kind]={from,through,source:'authenticated, scoped period scan; raw capture '+capture.captureHash};
  for(const kind of ['funding','interest']){
    const begin=events.length;
    try {
      const s=source(kind);
      if(kind==='interest'&&s.routingVerified!==true)throw Error('interest account routing unverified');
      const unique=new Map();
      for(const r of s.rows) {
        const at=kind==='funding'?r.intervalEndTimestamp:r.timestamp;
        if(!finiteNumber(r.quantity))throw Error(kind+' amount invalid');
        let id,amount=Number(r.quantity);
        if(kind==='funding'){
          if(String(r.userId)!==identity.userId||r.subaccountId!==identity.subaccountId||typeof r.symbol!=='string'||!r.symbol.endsWith('_USDC_PERP'))throw Error('funding account/currency unverified');
          id='funding:'+r.symbol+':'+fillTimestamp(at);
        }else{
          if(r.symbol!=='USDC'||!['Lend','Borrow','EntryFee'].includes(r.paymentType)||typeof r.positionId!=='string'||!r.positionId)throw Error('interest currency/type unverified');
          if(r.paymentType==='Lend'&&amount<0)throw Error('lend credit sign invalid');
          if(r.paymentType!=='Lend')amount=-Math.abs(amount);
          id='interest:'+r.positionId+':'+r.paymentType+':'+fillTimestamp(at);
        }
        const normalized={id,at:new Date(fillTimestamp(at)).toISOString(),amount};
        if(unique.has(id)&&!same(unique.get(id),normalized))throw Error('conflicting payment ID');
        unique.set(id,normalized);
      }
      for(const r of unique.values())add(kind,r.id,r.at,r.amount);
      declare(kind);
    }catch(e){events.splice(begin);issues.push(String(e.message));}
  }
  let pendingCashflowRows=null;
  try {
    const d=source('deposits'),w=source('withdrawals'),global=source('platformCredits');
    if(d.routingVerified!==true||global.scope!=='user-wide-inclusive')throw Error('capital history routing unverified');
    if(w.rows.some(r=>r.subaccountId!==identity.subaccountId))throw Error('withdrawal account unverified');
    // A user-wide platform receipt may belong to another subaccount. Never retag
    // it or guess that a gift/reward is external capital. Nonempty periods require
    // an explicitly reconciled same-account cashflow/reward ledger.
    const active=rows=>rows.filter(r=>!['cancelled','failed','rejected'].includes(r.status));
    pendingCashflowRows=active(d.rows).length+active(w.rows).length+active(global.rows).length;
    if(pendingCashflowRows===0){declare('cashflow');declare('reward');}
    else issues.push('capital/platform events need scoped classification');
  }catch(e){issues.push(String(e.message));}
  if(manual){
    validateLedger(manual);
    if(manual.accountKey!==identity.accountKey||manual.subaccountId!==identity.subaccountId)throw Error('manual ledger account mismatch');
    for(const kind of ['cashflow','reward']){
      const c=manual.coverage[kind];
      if(c&&Date.parse(c.from)<=Date.parse(from)&&Date.parse(c.through)>=Date.parse(through)){
        coverage[kind]=c;events.push(...manual.events.filter(e=>e.type===kind&&Date.parse(e.at)>Date.parse(from)&&Date.parse(e.at)<=Date.parse(through)));
      }
    }
  }
  const latest={accountKey:identity.accountKey,subaccountId:identity.subaccountId,events,coverage};
  validateLedger(latest);
  if(previous){
    validateLedger(previous);
    if(previous.accountKey!==identity.accountKey||previous.subaccountId!==identity.subaccountId)throw Error('previous window ledger account mismatch');
    const seen=new Map(previous.events.map(e=>[e.id,e]));
    for(const e of events)if(seen.has(e.id)&&!same(seen.get(e.id),e))throw Error('immutable window payment conflict');
    // All current histories are rescanned from the fixed baseline. A previously
    // confirmed payment disappearing is a reconciliation failure, not zero income.
    for(const e of previous.events)if(coverage[e.type]&&Date.parse(e.at)<=Date.parse(through)&&!events.some(n=>n.id===e.id))throw Error('confirmed window payment disappeared');
    for(const e of previous.events)if(!coverage[e.type]&&!events.some(n=>n.id===e.id))events.push(e);
  }
  validateLedger(latest);
  const equityChange=Number(capture.equity)-Number(window.baseline.equity);
  const result=attribution(latest,from,through,equityChange);
  return {ledger:latest,report:{at:capture.equityAt,baselineAt:from,baselineEquity:Number(window.baseline.equity),asOf:through,
    equity:Number(capture.equity),equityChange,cashflowComplete:result.netCashflow!==null,decompositionComplete:result.complete,
    netCashflow:result.netCashflow,netPnl:result.strategyPnl,funding:result.funding,interest:result.interest,reward:result.reward,
    otherTradingAndValuationPnl:result.complete?result.tradingPnl:null,pendingCashflowRows,issues,
    scope:'account net return; not isolated grid alpha',baselinePrecisionUsd:window.baseline.precisionUsd}};
}
module.exports={chooseBaseline,validateWindow,chooseCheckpoint,collectPeriod,reconcile};
