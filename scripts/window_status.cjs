const path=require('node:path'),{atomic}=require('./contracts.cjs');
const root=process.env.BG_ROOT||path.join(__dirname,'..');
atomic(path.join(root,'state/window_status.json'),{at:new Date().toISOString(),ok:process.argv[2]==='ok'});
