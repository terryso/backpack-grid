'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{webcrypto}=require('node:crypto');
const ROOT=process.env.REVIEW_PROJECT_ROOT||process.cwd();
const OUTPUT=process.env.REVIEW_OUTPUT_DIR||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'backpack-review-output-'));
fs.mkdirSync(OUTPUT,{recursive:true});
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const reports=[];
const record=(id,details)=>{reports.push({id,...details});console.log(JSON.stringify(reports.at(-1)))};
const grid=(base,extra={})=>({market:base+'-PERP',symbol:base+'_USDC_PERP',range:['90','110'],allocationRaw:1000,pnlRaw:0,pnlPct:0,status:'Triggered',nativeTP:10,nativeSL:6,nativeCloseOnStop:true,direction:'Neutral',...extra});
async function observation(mode,previousFees){
 const fixedMs=Date.parse('2026-10-02T12:00:00Z'),startMs=Date.UTC(2026,8,30);
 class ReviewDate extends Date{constructor(...args){args.length?super(...args):super(fixedMs)}static now(){return fixedMs}}
 const files=new Map(),requests=[];
 const position={symbol:'OLD_USDC_PERP',netQuantity:'1',markPrice:'100',breakEvenPrice:'100',netExposureNotional:'100',estLiquidationPrice:'50',imf:'0.1',cumulativeFundingPayment:'0'};
 const orphan=mode==='orphan';const positions=mode==='missing-mark'||mode==='history-gap'||mode==='history-cap'?[]:[position];
 const auto={params:{symbols:orphan?[]:[{symbol:'OLD_USDC_PERP',enabled:true,allocationUsd:'500',priceLow:'90',priceHigh:'110',levels:20,direction:'Neutral',takeProfitPercentage:10,stopLossPercentage:6,closePositionsOnStop:true}]},snapshot:{symbols:[{symbol:'OLD_USDC_PERP',pnl:mode==='missing-ledger-fields'?{}:{netPosition:'1',boughtValue:'100',soldValue:'0',quoteAssetFees:'0'}}]}};
 const src=fs.readFileSync(path.join(ROOT,'scripts/observe.mjs'),'utf8');
 const initialFees=previousFees||{symbols:{}};if(mode==='history-cap')initialFees.symbols.OLD_USDC_PERP={lastTo:fixedMs-2*3600e3,feeUsd:0,makerVol:0,takerVol:0,makerN:0,takerN:0};
 const mockfs={readFile:async()=>JSON.stringify(initialFees),writeFile:async(p,v)=>files.set(p,v)};
 const fill={price:'100',quantity:'1',fee:'0.1',feeSymbol:'USDC',isMaker:true};
 const page={fetch:async u=>{const url=new URL(u);requests.push({from:Number(url.searchParams.get('from')),to:Number(url.searchParams.get('to')),limit:Number(url.searchParams.get('limit'))});const fills=mode==='same-ts'?Array.from({length:1000},(_,i)=>({...fill,tradeId:'id'+i,timestamp:new Date(Number(url.searchParams.get('from'))).toISOString()})):mode==='history-cap'?Array.from({length:1000},()=>fill):mode==='history-gap'&&Number(url.searchParams.get('from'))>startMs?[fill]:[];return {status:200,body:JSON.stringify(fills)}}};
 const env={auto,positionsRaw:positions,account:{limitOrders:20,liquidating:false},collateralAll:{'fixture-3':{netEquity:'500',netEquityAvailable:'300'}},markAll:[{symbol:'OLD_USDC_PERP',markPrice:'100'}],cfg,SUB:3,ROOT,API:'mock',path,fs:mockfs,page,Date:ReviewDate,console:{log:()=>{}},process:{exit:n=>{throw Error('exit '+n)}}};
 let error=null;try{await new AsyncFunction(...Object.keys(env),src.slice(src.indexOf('// --- grids from automation snapshot ---')))(...Object.values(env))}catch(e){error=e.message}
 return {error,observed:JSON.parse(files.get(path.join(ROOT,'state/observed.json'))),fees:JSON.parse(files.get(path.join(ROOT,'state/fees.json'))||'{"symbols":{}}'),requests,fixedMs,startMs};
}
async function peakRace(){
 const riskPath=path.join(ROOT,'state/risk.json'),files=new Map([[path.join(ROOT,'config.json'),JSON.stringify(cfg)],[riskPath,JSON.stringify({peakEquity:600,paused:null})]]);let tripped;
 const mockfs={access:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'})},readFile:async p=>files.get(p),writeFile:async(p,v)=>files.set(p,v),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a)}};
 const page={goto:async()=>{},waitForTimeout:async()=>{},fetch:async()=>{tripped={peakEquity:600,paused:{at:'test',reason:'drawdown 83.3%'},lastEquity:100};files.set(riskPath,JSON.stringify(tripped));return{status:200,body:JSON.stringify({'fixture-3':{netEquity:650}})}}};
 const env={ROOT,path,fs:mockfs,taskSpace:async()=>({page:()=>page}),console:{log:()=>{}},process:{exit:n=>{throw Error('exit '+n)}}};
 await new AsyncFunction(...Object.keys(env),fs.readFileSync(path.join(ROOT,'scripts/peak_probe.mjs'),'utf8').slice(fs.readFileSync(path.join(ROOT,'scripts/peak_probe.mjs'),'utf8').indexOf('const RISK')))(...Object.values(env));return{before:tripped,after:JSON.parse(files.get(riskPath))};
}
async function plan(phase){
 const files=new Map(),at=new Date().toISOString(),candidate={symbol:'NEW_USDC_PERP',score:10,chop:10,range24:5,qvol24:1e6,grid:{lower:90,upper:110,count:20}};
 const init={'config.json':cfg,'state/observed.json':{at,gridRows:[grid('OLD')],positions:[{market:'OLD-PERP',size:'1',mark:'100',liq:'99',fundingRaw:0}],margin:{totalEquity:'1000',availableEquity:'400',openPnl:'0'},ledger:[]},'state/risk.json':{peakEquity:1000,paused:null},'state/pending_stops.json':{},'state/analysis.json':{generatedAt:at,top:[candidate],directional:[]}};
 for(const [p,v]of Object.entries(init))files.set(path.join(ROOT,p),JSON.stringify(v));
 const mockfs={existsSync:p=>files.has(p),readFileSync:p=>{if(!files.has(p))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return files.get(p)},writeFileSync:(p,v)=>files.set(p,v),renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a)},appendFileSync:(p,v)=>files.set(p,(files.get(p)||'')+v)};
 const ctx={__dirname:path.join(ROOT,'scripts'),require:n=>n==='node:fs'?mockfs:n==='node:path'?path:n==='./api.cjs'?{getTickers:async()=>[{symbol:'OLD_USDC_PERP',lastPrice:'100'}]}:(()=>{throw Error('blocked dependency '+n)})(),process:{env:{BG_PHASE:phase},exit:n=>{throw Error('exit '+n)}},console:{log:()=>{},error:()=>{}}};
 await vm.runInNewContext(fs.readFileSync(path.join(ROOT,'scripts/decide.cjs'),'utf8'),ctx);return JSON.parse(files.get(path.join(ROOT,'state/actions.json')));
}
async function dashboard(){
 const files=new Map(),at=new Date().toISOString();
 const init={'config.json':cfg,'state/observed.json':{at,error:'validation: incomplete ledger',gridRows:[],positions:[],margin:{totalEquity:'500',availableEquity:'300'}},'state/risk.json':'{broken','state/pending_stops.json':{},'state/pending_corrupt.json':{note:'blocked'},'state/equity_curve.jsonl':''};
 for(const [p,v]of Object.entries(init))files.set(path.join(ROOT,p),typeof v==='string'?v:JSON.stringify(v));
 const mockfs={readFileSync:p=>{if(!files.has(p))throw Error('ENOENT');return files.get(p)},writeFileSync:(p,v)=>files.set(p,v)};
 vm.runInNewContext(fs.readFileSync(path.join(ROOT,'scripts/dashboard_data.cjs'),'utf8'),{__dirname:path.join(ROOT,'scripts'),require:n=>n==='node:fs'?mockfs:path,process:{argv:[]},console:{log:()=>{}}});
 const snap=JSON.parse(files.get(path.join(ROOT,'state/dashboard.json')));const elems=new Map();const document={getElementById:id=>{if(!elems.has(id))elems.set(id,{classList:{remove:()=>{}},textContent:'',innerHTML:''});return elems.get(id)}};
 const html=fs.readFileSync(path.join(ROOT,'cloudflare/dashboard.html'),'utf8');const part=html.match(/<script>([\s\S]*?)<\/script>/)[1].split('async function load()')[0];vm.runInNewContext(part+'\nrender(reviewSnapshot)',{document,reviewSnapshot:snap});
 return{riskPaused:snap.riskPaused,pending:snap.pending,includesObservationError:Object.hasOwn(snap,'error'),greenNormal:elems.get('content').innerHTML.includes('风控正常')};
}
async function likes(){
 const kv=new Map();const module={exports:{}};const src=fs.readFileSync(path.join(ROOT,'cloudflare/worker.js'),'utf8').replace('import html from "./dashboard.html";','const html = "mock";').replace('export default','module.exports =');
 new Function('module','Response','Request','URL','crypto','TextEncoder',src)(module,Response,Request,URL,webcrypto,TextEncoder);const env={DASH_WRITE_TOKEN:'fixture-only',DASH:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v)}};
 const req=()=>new Request('https://review.invalid/api/like',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1'}});
 await module.exports.fetch(req(),env);await module.exports.fetch(req(),env);return Number(kv.get('likes'));
}
async function lockRace(){
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'review-lock-')),sync=path.join(dir,'sync');fs.mkdirSync(sync);fs.mkdirSync(path.join(dir,'state/lock'),{recursive:true});fs.writeFileSync(path.join(dir,'state/lock/pid'),'99999999');
 const shell=fs.readFileSync(path.join(ROOT,'scripts/run_round.sh'),'utf8');const block=shell.slice(shell.indexOf('mkdir -p state'),shell.indexOf('upload_dashboard()'));const children=[];
 const acquire=name=>new Promise((resolve,reject)=>{const prefix='kill(){ touch "$REVIEW_SYNC/$REVIEW_NAME"; while [ ! -f "$REVIEW_SYNC/A" ] || [ ! -f "$REVIEW_SYNC/B" ]; do sleep 0.01; done; return 1; }\n';const child=spawn('/bin/bash',['-c',prefix+block+'\ntrap release_lock EXIT\nprintf "READY\\n"\nread -r release\n'],{cwd:dir,env:{...process.env,REVIEW_SYNC:sync,REVIEW_NAME:name},stdio:['pipe','pipe','pipe']});children.push(child);child.exited=new Promise(r=>child.once('close',r));let out='';const timer=setTimeout(()=>reject(Error('lock probe timeout')),3000);child.stdout.on('data',d=>{out+=d;if(out.includes('READY')){clearTimeout(timer);resolve(child)}});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',()=>{clearTimeout(timer);if(!out.includes('READY'))reject(Error(out))})});
 try{const [a,b]=await Promise.all([acquire('A'),acquire('B')]);return{twoLiveOwners:a.exitCode===null&&b.exitCode===null,finalPid:fs.readFileSync(path.join(dir,'state/lock/pid'),'utf8').trim(),boundary:'Original lock block; dead-holder checks synchronized to expose a valid concurrent takeover interleaving. Only temporary files and subprocesses.'}}finally{for(const c of children)if(c.exitCode===null)c.stdin.end('release\n');await Promise.all(children.map(c=>c.exited))}
}

(async()=>{
 let r=await peakRace();assert(r.before.paused&&!r.after.paused);record('F01_still_clears_latch',r);
 r=await observation('missing-mark');assert.equal(r.error,null);assert.equal(r.observed.gridRows[0].pnlPct,-20);record('F02_inventory_without_position_still_false_pnl',{error:r.error,pnlPct:r.observed.gridRows[0].pnlPct});
 r=await observation('missing-ledger-fields');assert(r.error);record('C02_empty_ledger_now_rejected',{error:r.error});
 const core=require(path.join(ROOT,'scripts/act_core.cjs'));let pending={},deleted=false;const stop=core.makeStopGrid({loadPending:async()=>({pending,corrupt:false}),savePending:async p=>{pending=JSON.parse(JSON.stringify(p))},getAutomation:async()=>({params:{symbols:deleted?[]:[{symbol:'OLD_USDC_PERP',enabled:true}]}}),jget:async()=>[{symbol:'OLD_USDC_PERP',netQuantity:null}],jpatch:async(p,b)=>{if(b.params.symbols[0].operation==='Delete')deleted=true;return{status:200}},waitFor:async f=>await f(),sleep:async()=>{}});const stopped=await stop('OLD-PERP',null,'null quantity review',[]);assert(stopped.done&&deleted);record('F02_null_quantity_still_flat',{done:stopped.done,deleted,pending});
 const a=await plan(''),b=await plan('creates');assert(a.some(x=>x.act==='stop'));assert(b.some(x=>x.act==='stop'));assert(!a.some(x=>x.act==='create'));assert(!b.some(x=>x.act==='create'));record('C03_both_phases_recheck_and_defer',{phase1:a,phase2:b});
 r=await observation('orphan');assert(r.error);record('F05_orphan_still_blocks_observe',{error:r.error,detail:r.observed.error});
 r=await observation('history-gap');assert(r.fees.symbols.OLD_USDC_PERP.lastTo===r.fixedMs);record('C06_partial_history_cursor_is_preserved',{requests:r.requests,lastTo:r.fees.symbols.OLD_USDC_PERP.lastTo});
 const first=await observation('same-ts'),second=await observation('same-ts',first.fees);assert.equal(first.fees.symbols.OLD_USDC_PERP.lastTo,second.fees.symbols.OLD_USDC_PERP.lastTo);assert(Math.abs(second.fees.symbols.OLD_USDC_PERP.feeUsd-first.fees.symbols.OLD_USDC_PERP.feeUsd*2)<1e-6);record('F06_same_timestamp_page_counted_again_next_round',{firstFee:first.fees.symbols.OLD_USDC_PERP.feeUsd,secondFee:second.fees.symbols.OLD_USDC_PERP.feeUsd,cursor:first.fees.symbols.OLD_USDC_PERP.lastTo});
 const dashboardSrc=fs.readFileSync(path.join(ROOT,'scripts/dashboard_data.cjs'),'utf8'),obs=JSON.parse(fs.readFileSync(path.join(ROOT,'state/observed.json'),'utf8')),zec=obs.gridRows.find(x=>x.market==='ZEC-PERP');
 if(zec){const formatted={range:zec.range.join(' ~ '),price:zec.price,pnlPct:zec.pnlPct,effPnlPct:zec.effPnlPct};const script=fs.readFileSync(path.join(ROOT,'cloudflare/dashboard.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].split('function render(')[0];const ctx={item:formatted,config:cfg};vm.runInNewContext(script+'\nresult=healthRow(item,{tpPct:config.takeProfitPct,slPct:config.stopLossPct});',ctx);const [lo,hi]=zec.range.map(Number);record('F07_ZEC_display_parses_characters_as_range',{snapshotAt:obs.at,range:zec.range,price:zec.price,actuallyInside:zec.price>=lo&&zec.price<=hi,html:ctx.result});assert(zec.price>=lo&&zec.price<=hi);assert(ctx.result.includes('出界')&&ctx.result.includes('-99'));}
 fs.writeFileSync(path.join(OUTPUT,'results.json'),JSON.stringify({baseline:require('node:child_process').spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),reports,boundary:'Current working tree including user uncommitted changes, memory-only API and state I/O, no live trades or deployment.'},null,2));console.log('RESULT '+path.join(OUTPUT,'results.json'));
})().catch(e=>{console.error(e);process.exitCode=1});
