'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { plainObject, finiteNumber, positionListOk } = require('./state_schema.cjs');
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stable = (v) => Array.isArray(v) ? v.map(stable) : plainObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const same = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
function atomic(file, data) { const tmp = file + `.${process.pid}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data,null,2)); fs.renameSync(tmp,file); } finally { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); } }
function validateConfig(c) {
  const ranges = { maxGrids:[0,20],gridValueUsd:[1,1e9],takeProfitPct:[.001,100],stopLossPct:[.001,100],exitBufferPct:[0,100],liqDangerPct:[0,100],leverageCap:[1,100],minQvol24h:[0,1e15],analysisMaxAgeMin:[1,1440],riskBudgetPct:[.001,100],warnDrawdownPct:[0,100],minScore:[0,1e9],maxPerEcosystem:[1,20],exitCostBufferUsd:[0,1e9] };
  for(const [k,[lo,hi]] of Object.entries(ranges)) if(typeof c[k] !== 'number' || !finiteNumber(c[k]) || c[k]<lo || c[k]>hi) throw Error('invalid config: '+k);
  if(c.warnDrawdownPct>=c.riskBudgetPct || !Number.isInteger(c.maxGrids) || !Number.isInteger(c.maxPerEcosystem)) throw Error('invalid risk/cap configuration');
  const sub=c.subaccountId??3;if(!Number.isSafeInteger(sub)||sub<0)throw Error('invalid subaccountId');
  // optional auto-exits keys (feature gate autoExitsEnabled): validated only when present
  if(c.autoExitsEnabled!==undefined && typeof c.autoExitsEnabled!=='boolean') throw Error('invalid config: autoExitsEnabled');
  const autoRanges={breachDwellMin:[1,1440],breachBufferPct:[0,100],positionStopLossPct:[1,10000],positionTakeProfitPct:[0,10000],accountFloorUsd:[0,1e9]};
  for(const [k,[lo,hi]] of Object.entries(autoRanges))
    if(c[k]!==undefined && (typeof c[k]!=='number' || !finiteNumber(c[k]) || c[k]<lo || c[k]>hi)) throw Error('invalid config: '+k);
  return c;
}
function identityOk(i) { return plainObject(i) && typeof i.userId==='string' && i.userId.trim()!=='' && Number.isSafeInteger(i.subaccountId) && i.subaccountId>=0 && i.accountKey===(i.subaccountId===0?i.userId:`${i.userId}-${i.subaccountId}`); }
function expectedIdentity(root,cfg) {
  const i=JSON.parse(fs.readFileSync(path.join(root,'state/account_identity.json'),'utf8'));
  if(!identityOk(i) || i.subaccountId!==(cfg.subaccountId??3) || (cfg.userId!=null && String(cfg.userId)!==i.userId)) throw Error('account identity pin/config mismatch');
  return i;
}
function assertIdentity(expected, actual) { if(!identityOk(expected)||!identityOk(actual)||expected.accountKey!==actual.accountKey) throw Error('ACCOUNT_IDENTITY_MISMATCH'); }
function manualPausesFor(root, identity) {
  let holds;
  try { holds=JSON.parse(fs.readFileSync(path.join(root,'state/manual_pauses.json'),'utf8')); }
  catch(e) { if(e.code==='ENOENT')return {};throw Error('MANUAL_PAUSE_REGISTRY_INVALID'); }
  if(!plainObject(holds) || Object.entries(holds).some(([market,p])=>
    (market!=='*'&&!/^[A-Z0-9]+-PERP$/.test(market)) || !plainObject(p) || p.accountKey!==identity.accountKey
    || p.intent!=='hold' || !Number.isFinite(Date.parse(p.at))))throw Error('MANUAL_PAUSE_REGISTRY_INVALID');
  return holds;
}
function collateralFor(all,expected) {
  if(!plainObject(all)||!identityOk(expected)||!Object.prototype.hasOwnProperty.call(all,expected.accountKey)||!plainObject(all[expected.accountKey])) throw Error('ACCOUNT_IDENTITY_MISMATCH');
  return all[expected.accountKey];
}
function positionsRisk(positions,cfg,expected) {
  if(!positionListOk(positions)) return {blocked:true,reason:'position response malformed or duplicate symbol'};
  for(const p of positions) {
    if(!plainObject(p)||typeof p.symbol!=='string'||!finiteNumber(p.netQuantity)) return {blocked:true,reason:'position identity/quantity unknown'};
    if(expected && ((p.userId!=null&&String(p.userId)!==expected.userId)||(p.subaccountId!=null&&Number(p.subaccountId)!==expected.subaccountId)))return {blocked:true,reason:'position account mismatch'};
    if(Number(p.netQuantity)===0)continue;
    if(!finiteNumber(p.markPrice)||Number(p.markPrice)<=0||!finiteNumber(p.estLiquidationPrice)||Number(p.estLiquidationPrice)<0)return {blocked:true,reason:'position mark/liquidation unknown'};
    const mark=Number(p.markPrice),liq=Number(p.estLiquidationPrice);
    if(liq>0 && Math.abs(mark-liq)/mark*100<cfg.liqDangerPct) return {blocked:true,reason:'LIQ_DANGER '+p.symbol,market:p.symbol.replace('_USDC_PERP','-PERP')};
  }
  return {blocked:false};
}
function gridConfigConfirmed(entry,plan) {
  return plainObject(entry) && entry.symbol===plan.market.replace('-PERP','_USDC_PERP')
    && ['allocationUsd','priceLow','priceHigh','levels'].every(k=>finiteNumber(entry[k]))
    && Number(entry.allocationUsd)===Number(plan.value) && Number(entry.priceLow)===Number(plan.lower) && Number(entry.priceHigh)===Number(plan.upper)
    && Number(entry.levels)===Number(plan.count) && entry.enabled===true && entry.direction==='Neutral';
}
function gridConfirmed(entry,plan,cfg) { return gridConfigConfirmed(entry,plan)
    && finiteNumber(entry.takeProfitPercentage)&&finiteNumber(entry.stopLossPercentage)
    && Number(entry.takeProfitPercentage)===cfg.takeProfitPct && Number(entry.stopLossPercentage)===cfg.stopLossPct && entry.closePositionsOnStop===true; }
function forwardRisk(symbols,equity,cfg) {
  if(!Array.isArray(symbols)||!finiteNumber(equity))throw Error('risk premise unknown');
  let risk=0;
  for(const g of symbols){if(!finiteNumber(g.allocationUsd)||Number(g.allocationUsd)<=0||!finiteNumber(g.stopLossPercentage)||Number(g.stopLossPercentage)<=0||g.closePositionsOnStop!==true)throw Error('stored grid risk unknown');risk+=Number(g.allocationUsd)*Math.max(Number(g.stopLossPercentage),cfg.stopLossPct)/100;}
  return risk+cfg.exitCostBufferUsd<=Number(equity)*cfg.riskBudgetPct/100;
}
// Only strategy-affecting fields belong in research fingerprints; browser migration does not invalidate samples.
const analysisConfigHash = c => hash({gridValueUsd:c.gridValueUsd,minQvol24h:c.minQvol24h,minScore:c.minScore,stopLossPct:c.stopLossPct,ecosystems:c.ecosystems,schema:2});
module.exports={hash,stable,same,atomic,validateConfig,identityOk,expectedIdentity,assertIdentity,manualPausesFor,collateralFor,positionsRisk,gridConfigConfirmed,gridConfirmed,forwardRisk,analysisConfigHash};

function marginEstimate(value,cfg,imfFunction,existingNotional=0) {
  if(!finiteNumber(value)||Number(value)<=0)throw Error('invalid allocation');
  let fraction=1/cfg.leverageCap;
  if(imfFunction){if(imfFunction.type!=='sqrt'||!finiteNumber(imfFunction.base)||!finiteNumber(imfFunction.factor)||Number(imfFunction.base)<=0||Number(imfFunction.factor)<0)throw Error('market IMF unavailable');fraction=Math.max(fraction,Number(imfFunction.base),Number(imfFunction.factor)*Math.sqrt(Math.max(0,existingNotional)+Number(value)));}
  return Number(value)*fraction;
}
module.exports.marginEstimate=marginEstimate;
