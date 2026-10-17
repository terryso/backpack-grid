'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {dispatchSource,mockEgo}=require('./ego_fixture.cjs');
const {PY}=require('./env.cjs');
process.env.PY_BIN=PY; // 被测源码经 process.env.PY_BIN 解析解释器（占位符守卫依赖它）
const {chooseBaseline}=require('../scripts/verified_window.cjs');
const ROOT=path.join(__dirname,'..'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function run(kind,mode){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-collector-page-'));
 try{
  fs.mkdirSync(path.join(d,'state'));fs.cpSync(path.join(ROOT,'scripts'),path.join(d,'scripts'),{recursive:true});
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json')));cfg.watch={spaceId:7,page:'p1'};
  const identity={userId:'fixture',subaccountId:3,accountKey:'fixture-3'},put=(f,x)=>fs.writeFileSync(path.join(d,f),JSON.stringify(x));
  put('config.json',cfg);put('state/account_identity.json',identity);put('state/observed.json',{gridRows:[]});
  const rows=[{accountKey:identity.accountKey,at:new Date(Date.now()-3600000).toISOString(),equity:500},{accountKey:identity.accountKey,at:new Date(Date.now()-600000).toISOString(),equity:600}];
  put('state/verified_window.json',chooseBaseline(rows,identity));fs.writeFileSync(path.join(d,'state/equity_curve.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const cachedLabel=kind==='history'?'p3':'p2',file='state/'+(kind==='history'?'history_browser.json':'accounting_browser.json');
  put(file,{spaceId:mode==='different-space'?6:7,page:mode==='invalid-label'?null:cachedLabel});
  const initial=fs.readFileSync(path.join(d,file),'utf8'),labels=['p1',...(mode==='healthy'?[cachedLabel]:[])];let created=0;const visited=[];
  const makePage=label=>({label,async goto(){if(!labels.includes(label))throw Error('page label not found: '+label);visited.push(label);}});
  const task={spaceId:7,page:makePage,async pages(){if(mode==='inventory-failure')throw Error('fixture inventory failure');return labels.map(label=>({label}));},async newPage(){if(mode==='create-failure')throw Error('fixture page creation failure');created++;labels.push('p4');return makePage('p4');}};
  const name=kind==='history'?'collect_history.mjs':'collect_verified_window.mjs';
  let source=dispatchSource(fs.readFileSync(path.join(ROOT,'scripts',name),'utf8'),d);
  // Execute the real startup and cache handling up to its first navigation. The
  // appended navigation is mocked, and no account/financial API is ever called.
  source=source.slice(0,source.indexOf('await page.goto('))+'await page.goto("https://fixture.invalid/");';
  const invoke=()=>new AsyncFunction('ego','taskSpace','console',source)(mockEgo(d),async()=>task,{log(){}});
  let error=null;try{await invoke();if(mode==='repeat')await invoke();}catch(e){error=e.message;}
  return{kind,mode,error,created,visited,cache:JSON.parse(fs.readFileSync(path.join(d,file))),cacheUnchanged:fs.readFileSync(path.join(d,file),'utf8')===initial};
 }finally{fs.rmSync(d,{recursive:true,force:true});}
}
(async()=>{
 const evidence=process.argv.includes('--evidence'),results=[];let count=0;
 for(const kind of ['history','accounting'])for(const mode of ['healthy','missing-page','different-space','repeat','invalid-label','inventory-failure','create-failure']){
  const r=await run(kind,mode);results.push(r);if(evidence)continue;
  if(['inventory-failure','create-failure'].includes(mode)){assert(r.error?.includes('fixture'));assert(r.cacheUnchanged);assert.equal(r.created,0);}
  else{assert.equal(r.error,null);assert.equal(r.created,mode==='healthy'?0:1);assert.equal(r.cache.spaceId,7);assert.equal(r.cache.page,mode==='healthy'?(kind==='history'?'p3':'p2'):'p4');assert.deepEqual(r.visited,mode==='healthy'?[r.cache.page]:mode==='repeat'?['p4','p4']:['p4']);}
  count++;console.log('PASS production collector page recovery: '+kind+' '+mode);
 }
 if(evidence)console.log(JSON.stringify(results,null,2));else console.log(count+' collector page startup scenarios passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
