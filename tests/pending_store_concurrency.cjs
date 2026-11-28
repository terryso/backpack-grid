'use strict';
// Exercise the real interprocess lock and pending transaction using only files
// in temporary fixtures. No browser or exchange access is involved.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {PY}=require('./env.cjs');
const ROOT=path.join(__dirname,'..'),accountKey='fixture-3',market='UNI-PERP';
const prepared={kind:'create',phase:'prepared',accountKey,intentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  planId:'fixture-plan',runId:'fixture-run',at:new Date().toISOString(),reason:'not yet sent'};
const hash=raw=>createHash('sha256').update(raw).digest('hex');

function transaction(dir,request){
  return new Promise((resolve,reject)=>{
    const child=spawn(PY,[path.join(ROOT,'scripts/with_lock.py'),'--name','pending','--wait','5',
      process.execPath,path.join(ROOT,'scripts/pending_store.cjs')],{env:{...process.env,BG_ROOT:dir},stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    child.on('error',reject);child.on('close',status=>{
      try{resolve({status,result:JSON.parse(out),err});}catch(e){reject(Error('bad transaction response: '+err));}
    });child.stdin.end(JSON.stringify(request));
  });
}

(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bg-pending-concurrency-'));
  try{
    fs.mkdirSync(path.join(dir,'state'));
    const file=path.join(dir,'state/pending_stops.json');
    for(let i=0;i<12;i++){
      const raw=JSON.stringify({[market]:prepared});fs.writeFileSync(file,raw);
      const expected={intentId:prepared.intentId,planId:prepared.planId,runId:prepared.runId};
      const [clear,issue]=await Promise.all([
        transaction(dir,{op:'save',version:hash(raw),pending:{},accountKey}),
        transaction(dir,{op:'issue',market,expected,accountKey}),
      ]);
      assert.equal(Number(clear.result.ok)+Number(issue.result.ok),1);
      const ledger=JSON.parse(fs.readFileSync(file));
      if(issue.result.ok){assert.equal(clear.result.code,'PENDING_CONFLICT');assert.equal(ledger[market].phase,'issued');}
      else{assert.equal(issue.result.code,'PENDING_CONFLICT');assert.deepEqual(ledger,{});}
    }
    console.log('PASS competing cleanup and issue have exactly one winner without losing an issued intent');

    const raw='{}';fs.writeFileSync(file,raw);
    const makeEntry=reason=>({accountKey,reason,at:new Date().toISOString()});
    const [a,b]=await Promise.all([
      transaction(dir,{op:'save',version:hash(raw),pending:{'A-PERP':makeEntry('A')},accountKey}),
      transaction(dir,{op:'save',version:hash(raw),pending:{'B-PERP':makeEntry('B')},accountKey}),
    ]);
    assert.equal(Number(a.result.ok)+Number(b.result.ok),1);
    assert.equal((a.result.ok?b:a).result.code,'PENDING_CONFLICT');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file))).length,1);
    console.log('PASS concurrent stale ledger writers cannot overwrite each other');

    fs.writeFileSync(file,'{bad json');const corruptVersion=hash('{bad json');
    fs.writeFileSync(file,JSON.stringify({[market]:prepared}));
    const stale=await transaction(dir,{op:'quarantine',version:corruptVersion});
    assert.equal(stale.result.code,'PENDING_CONFLICT');
    assert.equal(JSON.parse(fs.readFileSync(file))[market].phase,'prepared');
    assert(!fs.existsSync(path.join(dir,'state/pending_corrupt.json')));
    console.log('PASS a stale corrupt read cannot quarantine a newer valid ledger');

    fs.writeFileSync(file,'{bad json');
    fs.mkdirSync(path.join(dir,'state/pending_corrupt.json.tmp'));
    const flagFailure=await transaction(dir,{op:'quarantine',version:hash('{bad json')});
    assert.equal(flagFailure.result.ok,false);assert.equal(fs.readFileSync(file,'utf8'),'{bad json');
    console.log('PASS corrupt ledger remains in place if its persistent block cannot be written');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
