'use strict';
const {plainObject,finiteNumber}=require('./state_schema.cjs');
const {hash,stable}=require('./contracts.cjs');
// Raw source pagination is evidence collection, not a declaration of reconciled coverage.
async function collectSource(identity,fetchBatch,checkAccount,maxRows=20000) {
  const rows=[],pages=new Set();let complete=false,error=null;
  try {
    for(let offset=0;offset<maxRows;offset+=1000) {
      await checkAccount();const batch=await fetchBatch(offset);
      if(!Array.isArray(batch)||batch.length>1000)throw Error('history shape invalid');
      if(batch.some(x=>!plainObject(x)
        ||(x.subaccountId!=null&&(!finiteNumber(x.subaccountId)||Number(x.subaccountId)!==identity.subaccountId))
        ||(x.userId!=null&&String(x.userId)!==identity.userId)))throw Error('history owner mismatch');
      const fingerprint=hash(stable(batch));
      if(batch.length===1000&&pages.has(fingerprint))throw Error('history pagination made no progress');
      pages.add(fingerprint);rows.push(...batch);
      if(batch.length<1000){complete=true;break;}
    }
    if(!complete)throw Error('history pagination limit reached');
    await checkAccount();
  } catch(e) {complete=false;error=String(e.message);}
  return {complete,error,rows,requestedSubaccountId:identity.subaccountId,
    scopeVerifiedInRows:rows.length>0&&rows.every(x=>finiteNumber(x.subaccountId)&&Number(x.subaccountId)===identity.subaccountId)};
}
module.exports={collectSource};
