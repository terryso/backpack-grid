'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
function archiveResearch(root,inputs){
  const at=inputs.output?.generatedAt;if(!Number.isFinite(Date.parse(at)))throw Error('research timestamp unknown');
  const raw=JSON.stringify({schemaVersion:1,...inputs}),sha256=crypto.createHash('sha256').update(raw).digest('hex');
  const folder=path.join(root,'state/research_archive',at.slice(0,10));fs.mkdirSync(folder,{recursive:true});
  const name=at.replace(/[:.]/g,'-')+'-'+sha256.slice(0,16)+'.json.gz',file=path.join(folder,name);
  try{fs.writeFileSync(file,zlib.gzipSync(raw),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(zlib.gunzipSync(fs.readFileSync(file)).toString()!==raw)throw Error('immutable research archive conflict');return;}
  fs.appendFileSync(path.join(root,'state/research_archive/index.jsonl'),JSON.stringify({at,file:path.relative(root,file),sha256,configHash:inputs.output.configHash,
    markets:inputs.markets.length,samples:Object.keys(inputs.samples).length,excluded:inputs.output.excluded})+'\n');
}
module.exports={archiveResearch};
