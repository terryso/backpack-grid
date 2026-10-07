'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const asset=JSON.parse(fs.readFileSync(path.join(root,'cloudflare/assets/campaign-history.json')));
const modes={unknown:{campaignVolume:null,campaignSource:'unknown'},estimated:{campaignVolume:15200,campaignSource:'estimated'},official:{campaignVolume:15200,campaignSource:'official'},mismatch:{campaignId:1011,campaignVolume:64000,campaignSource:'official'}};
const server=http.createServer((req,res)=>{
 let route=new URL(req.url,'http://localhost').pathname;
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(route==='/api/snapshot'){
  const mode=new URL(req.headers.referer||'http://localhost/unknown').pathname.slice(1),extra=modes[mode]||modes.unknown;
  const data={updatedAt:new Date().toISOString(),generatedAt:new Date().toISOString(),equity:1000,dataValid:true,identityValid:true,riskStateValid:true,riskWriteValid:true,pendingCorrupt:false,lastRoundStatus:'ok',drawdownPct:0,riskPaused:false,grids:[],positions:[],pending:[],curve:[],campaignId:1012,campaignOfficialAt:new Date(Date.now()-15*60000).toISOString(),...extra};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(route==='/campaign-history.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(asset));return;}
 if(route==='/api/likes'){res.setHeader('content-type','application/json');res.end(JSON.stringify({likes:0,alreadyLiked:true}));return;}
 if(route.endsWith('.png')){const file=path.join(root,'cloudflare/assets',path.basename(route));if(fs.existsSync(file)){res.setHeader('content-type','image/png');res.end(fs.readFileSync(file));return;}res.writeHead(404);res.end();return;}
 res.setHeader('content-type','text/html');res.end(fs.readFileSync(path.join(root,'cloudflare/dashboard.html')));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,fixtureOnly:true})));
