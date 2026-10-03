// Read-only raw source acquisition. No assumed zero cashflows or fabricated coverage.
const fs=await import('node:fs/promises'),path=await import('node:path'),{createRequire}=await import('node:module');
const ROOT='/Users/nick/CascadeProjects/backpack_grid';const requireLocal=createRequire(path.join(ROOT,'scripts/collect_attribution.mjs'));
const {expectedIdentity,collateralFor,atomic}=requireLocal('./contracts.cjs');
const {collectSource}=requireLocal('./attribution_sources.cjs');
const cfg=JSON.parse(await fs.readFile(path.join(ROOT,'config.json'),'utf8')),identity=expectedIdentity(ROOT,cfg);
const browser=JSON.parse(await fs.readFile(path.join(ROOT,'state/history_browser.json'),'utf8'));const task=await taskSpace(browser.spaceId);const page=task.page(browser.page);
async function accountCheck(){const r=await page.fetch('https://api.backpack.exchange/wapi/v1/portfolio/collateral',{credentials:'include',timeout:15000});if(r.status!==200)throw Error('account read unavailable');collateralFor(JSON.parse(r.body),identity);}
const asOf=new Date().toISOString(),sources={};
for(const [kind,endpoint] of Object.entries({funding:'/wapi/v1/history/funding',interest:'/wapi/v1/history/interest',positions:'/wapi/v1/history/position',deposits:'/wapi/v1/capital/deposits',withdrawals:'/wapi/v1/capital/withdrawals'})) {
 const source=await collectSource(identity,async offset=>{
   const r=await page.fetch(`https://api.backpack.exchange${endpoint}?subaccountId=${identity.subaccountId}&limit=1000&offset=${offset}&sortDirection=Asc`,{credentials:'include',timeout:15000});
   if(r.status!==200)throw Error('HTTP '+r.status);return JSON.parse(r.body);
 },accountCheck);
 sources[kind]={endpoint,...source};
}
await accountCheck(); // Never replace a valid export after losing the pinned session.
atomic(path.join(ROOT,'state/attribution_sources.json'),{identity,asOf,sources});
console.log({rawHistoricalSourcesSaved:true,asOf,counts:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,{rows:v.rows.length,complete:v.complete,error:v.error,scopeVerifiedInRows:v.scopeVerifiedInRows}])),cashflowCoverageDeclared:false,baselineTimeRequired:true});
