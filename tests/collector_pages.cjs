'use strict';
// 单页签纪律验收：两个采集器经 resolveBotPage 与 observe/act/peak 共用常驻页签——
// 同域复用零导航、空空间才创建首个页签、库存/建页失败如实失败（绝不盲建）、重复调用幂等。
// 被测源码走 fixture 内的生产副本，只执行到首个 API 调用（采集主体由各自套件覆盖）。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {dispatchSource,mockEgo}=require('./ego_fixture.cjs');
const {PY}=require('./env.cjs');
process.env.PY_BIN=PY; // 被测源码经 process.env.PY_BIN 解析解释器（占位符守卫依赖它）
const {chooseBaseline}=require('../scripts/verified_window.cjs');
const ROOT=path.join(__dirname,'..'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const PARK_URL='https://backpack.exchange/portfolio/balances/assets';
async function run(kind,mode){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-collector-page-'));
 try{
  fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json')));cfg.watch={spaceId:7,page:'p1'};
  const identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'},put=(f,x)=>fs.writeFileSync(path.join(d,f),JSON.stringify(x));
  put('config.json',cfg);put('state/account_identity.json',identity);put('state/observed.json',{gridRows:[]});
  const rows=[{accountKey:identity.accountKey,at:new Date(Date.now()-3600000).toISOString(),equity:500},{accountKey:identity.accountKey,at:new Date(Date.now()-600000).toISOString(),equity:600}];
  put('state/verified_window.json',chooseBaseline(rows,identity));fs.writeFileSync(path.join(d,'state/equity_curve.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  // 页签世界：healthy/repeat=已有 p1 且同域；fresh-space/create-failure=空空间
  // （前者首建+停车，后者建页失败如实抛错）；inventory-failure=库存读不到
  const labels=(mode==='fresh-space'||mode==='create-failure')?[]:['p1'];
  let created=0;const navigations=[],used=[];
  const makePage=label=>({label,
    url:async()=>(mode==='healthy'||mode==='repeat')?PARK_URL:'about:blank',
    async goto(u){navigations.push(u);},async waitForTimeout(){}});
  const task={spaceId:7,page:label=>{used.push(label);return makePage(label);},
    async pages(){if(mode==='inventory-failure')throw Error('fixture inventory failure');return labels.map(label=>({label}));},
    async newPage(){if(mode==='create-failure')throw Error('fixture page creation failure');created++;labels.push('p1');return makePage('p1');}};
  const name=kind==='history'?'collect_history.mjs':'collect_verified_window.mjs';
  let source=dispatchSource(fs.readFileSync(path.join(ROOT,'scripts',name),'utf8'),d);
  const marker=kind==='history'?'await checkAccount();':'await accountCheck();';
  source=source.slice(0,source.indexOf(marker));
  const invoke=()=>new AsyncFunction('ego','taskSpace','console',source)(mockEgo(d),async()=>task,{log(){}});
  let error=null;try{await invoke();if(mode==='repeat')await invoke();}catch(e){error=e.message;}
  return{kind,mode,error,created,navigations,used};
 }finally{fs.rmSync(d,{recursive:true,force:true});}
}
(async()=>{
 const evidence=process.argv.includes('--evidence'),results=[];let count=0;
 for(const kind of ['history','accounting'])for(const mode of ['healthy','fresh-space','repeat','inventory-failure','create-failure']){
  const r=await run(kind,mode);results.push(r);if(evidence)continue;
  if(mode==='healthy'){assert.equal(r.error,null);assert.equal(r.created,0);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.used,['p1']);}
  else if(mode==='fresh-space'){assert.equal(r.error,null);assert.equal(r.created,1);assert.deepEqual(r.navigations,[PARK_URL]);assert.deepEqual(r.used,[]);} // 新建页签由 newPage 直接返回，不经 task.page()
  else if(mode==='repeat'){assert.equal(r.error,null);assert.equal(r.created,0);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.used,['p1','p1']);}
  else if(mode==='inventory-failure'){assert.match(r.error,/inventory/);assert.equal(r.created,0);assert.equal(r.navigations.length,0);}
  else if(mode==='create-failure'){assert.match(r.error,/fixture page creation/);assert.equal(r.navigations.length,0);}
  count++;console.log('PASS single shared tab: '+kind+' '+mode);
 }
 if(evidence)console.log(JSON.stringify(results,null,2));else console.log(count+' single shared tab scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
