const fs=require('node:fs'),path=require('node:path');const {atomic}=require('./contracts.cjs');
const root=process.env.BG_ROOT||path.join(__dirname,'..');atomic(path.join(root,'state/history_status.json'),{at:new Date().toISOString(),ok:process.argv[2]==='ok'});
