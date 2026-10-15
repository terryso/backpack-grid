'use strict';
// Mirror ego_dispatch placeholder expansion without invoking the real browser.
const fs=require('node:fs'),path=require('node:path');
function dispatchSource(source,root){return source.replace(/(["'])__BG_ROOT__\1/g,()=>JSON.stringify(root));}
function mockEgo(root){
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json')));
 return {async listTaskSpaces(){return {taskSpaces:[{id:cfg.watch.spaceId,name:'backpack-bot'}]};},async createTaskSpace(){throw Error('Unexpected fixture space creation');}};
}
function fixtureTask(root,page){
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'))),label=cfg.watch.page;
 return {spaceId:cfg.watch.spaceId,async pages(){return [{label}];},page(requested){if(requested!==label)throw Error('Unexpected fixture page');return page;},async newPage(){throw Error('Unexpected fixture page creation');}};
}
module.exports={dispatchSource,mockEgo,fixtureTask};
