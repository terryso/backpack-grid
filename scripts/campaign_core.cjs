'use strict';
// Pure period/state contracts. No network or filesystem writes.
const { plainObject, finiteNumber } = require('./state_schema.cjs');
const nonnegative = v => finiteNumber(v) && Number(v) >= 0;
function parseCampaignConfig(history) {
  const c = history?.current;
  if (!plainObject(c) || typeof c.startsAt!=='string' || typeof c.endsAt!=='string' || !finiteNumber(c.campaignId) || !Number.isSafeInteger(Number(c.campaignId)) || Number(c.campaignId) <= 0
    || !Number.isFinite(Date.parse(c.startsAt)) || !Number.isFinite(Date.parse(c.endsAt)) || Date.parse(c.startsAt) >= Date.parse(c.endsAt)
    || !Array.isArray(c.tiers) || !c.tiers.length || !c.tiers.every((v,i,a) => finiteNumber(v) && Number(v)>0 && (i===0 || Number(v)>Number(a[i-1])))) throw Error('CAMPAIGN CONFIG INVALID');
  return { campaignId:Number(c.campaignId), startsAt:c.startsAt, endsAt:c.endsAt, tiers:c.tiers.map(Number) };
}
function validateState(s, accountKey) {
  if (typeof accountKey!=='string' || !accountKey || !plainObject(s) || s.schemaVersion !== 2 || s.accountKey !== accountKey || !plainObject(s.periods) || !Array.isArray(s.legacy)) throw Error('CAMPAIGN STATE INVALID OR OWNER MISMATCH');
  for (const [key,p] of Object.entries(s.periods)) {
    if (!plainObject(p) || String(p.campaignId)!==key || !Number.isSafeInteger(p.campaignId) || p.campaignId<=0
      || typeof p.startsAt!=='string' || typeof p.endsAt!=='string' || !Number.isFinite(Date.parse(p.startsAt)) || !Number.isFinite(Date.parse(p.endsAt)) || Date.parse(p.startsAt)>=Date.parse(p.endsAt)
      || !plainObject(p.last) || !Object.values(p.last).every(nonnegative) || !nonnegative(p.ledgerDeltaSinceBaseline)
      || !['unknown','official','estimated'].includes(p.source)
      || (p.campaignVolume!==null && !nonnegative(p.campaignVolume))
      || (p.source==='unknown' && (p.campaignVolume!==null || p.officialAt!==null))
      || (p.source!=='unknown' && (!nonnegative(p.campaignVolume) || typeof p.officialAt!=='string' || !Number.isFinite(Date.parse(p.officialAt)) || Date.parse(p.officialAt)<Date.parse(p.startsAt) || Date.parse(p.officialAt)>Date.parse(p.endsAt)))
      || (p.updatedAt!==undefined && (typeof p.updatedAt!=='string' || !Number.isFinite(Date.parse(p.updatedAt))))) throw Error('CAMPAIGN PERIOD STATE INVALID');
  }
  return s;
}
function prepareState(previous, accountKey, at) {
  if(previous!=null && !plainObject(previous))throw Error('CAMPAIGN STATE STRUCTURE INVALID');
  if (previous?.schemaVersion===2) { validateState(previous,accountKey); return JSON.parse(JSON.stringify(previous)); }
  // A legacy timestamp cannot prove period ownership. Keep every old field
  // privately, without relabelling its volume as the current campaign.
  return { schemaVersion:2, accountKey, activeCampaignId:null, periods:{}, legacy:previous==null?[]:[{at,reason:'legacy record without verified period ownership',record:previous}] };
}
function periodMatches(p,c) { return p?.campaignId===c.campaignId && p.startsAt===c.startsAt && p.endsAt===c.endsAt; }
function unknownView(c) { return {campaignId:c?.campaignId??null,campaignVolume:null,source:'unknown',officialAt:null,tier1:c?.tiers?.[0]??null,tier1Secured:false}; }
function campaignView(state,c,accountKey) {
  if (!c || !state) return unknownView(c);
  try { validateState(state,accountKey); const p=state.periods[String(c.campaignId)]; if(!periodMatches(p,c))return unknownView(c);
    return {campaignId:c.campaignId,campaignVolume:p.campaignVolume===null?null:Number(p.campaignVolume),source:p.source,officialAt:p.officialAt,tier1:c.tiers[0],tier1Secured:p.source==='official' && p.campaignVolume!==null && Number(p.campaignVolume)>=c.tiers[0]};
  } catch { return unknownView(c); }
}
function updateCampaign(previous,c,obs,accountKey) {
  const at=obs.at,t=Date.parse(at); if(!Number.isFinite(t))throw Error('CAMPAIGN OBSERVATION TIME INVALID');
  const state=prepareState(previous,accountKey,at);
  if(t<Date.parse(c.startsAt)||t>Date.parse(c.endsAt))return {state:previous,view:campaignView(previous,c,accountKey),active:false};
  const key=String(c.campaignId);let p=state.periods[key];
  if(p && !periodMatches(p,c)){state.legacy.push({at,reason:'campaign boundaries changed',record:p});p=null;}
  if(!p)p={campaignId:c.campaignId,startsAt:c.startsAt,endsAt:c.endsAt,campaignVolume:null,source:'unknown',officialAt:null,last:{},ledgerDeltaSinceBaseline:0};
  if(p.campaignVolume!==null)p.campaignVolume=Number(p.campaignVolume);
  p.ledgerDeltaSinceBaseline=Number(p.ledgerDeltaSinceBaseline);
  if(p.updatedAt && t<Date.parse(p.updatedAt))throw Error('CAMPAIGN OBSERVATION OUT OF ORDER');
  let delta=0;
  for(const l of Array.isArray(obs.ledger)?obs.ledger:[]) {
    if(!plainObject(l)||typeof l.symbol!=='string'||!/^[A-Za-z0-9]+_USDC_PERP$/.test(l.symbol)||!nonnegative(l.vol))continue;
    const v=Number(l.vol),prev=p.last[l.symbol];if(prev!==undefined&&v>=Number(prev))delta+=v-Number(prev);
    p.last[l.symbol]=v;
  }
  p.ledgerDeltaSinceBaseline+=delta;
  if(finiteNumber(obs.officialCampaignId) && Number(obs.officialCampaignId)===c.campaignId && nonnegative(obs.officialCampaignVolume)) {
    p.campaignVolume=Number(obs.officialCampaignVolume);p.source='official';p.officialAt=at;
  } else if(p.campaignVolume!==null) {p.campaignVolume+=delta;p.source='estimated';}
  p.updatedAt=at;state.periods[key]=p;state.activeCampaignId=c.campaignId;
  return {state,view:campaignView(state,c,accountKey),active:true};
}
module.exports={parseCampaignConfig,validateState,prepareState,updateCampaign,campaignView,unknownView};
