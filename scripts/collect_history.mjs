// Read-only history collector. Separate browser space and lock from risk exits.
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { createRequire } = await import("node:module");
const ROOT = "__BG_ROOT__"; // placeholder injected by ego_dispatch.sh
const { collectHistory, auditHistory } = createRequire(path.join(ROOT, "scripts/collect_history.mjs"))("./history_core.cjs");
const { expectedIdentity, collateralFor } = createRequire(path.join(ROOT,"scripts/collect_history.mjs"))("./contracts.cjs");
const { spawnSync } = await import("node:child_process");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const identity=expectedIdentity(ROOT,cfg);
const SUB = cfg.subaccountId ?? 3;
const observed = JSON.parse(await fs.readFile(path.join(ROOT, "state/observed.json"), "utf8"));
const file = path.join(ROOT, "state/trade_history.json");
const PY = process.env.PY_BIN || "__PY_BIN__"; // placeholder injected by ego_dispatch.sh
if (PY.startsWith("__")) throw Error("PY_BIN not injected — dispatch via collect_history.sh (ego_dispatch.sh)");
function store(command, input) { const r=spawnSync(PY,[path.join(ROOT,"scripts/history_store.py"),command],{env:{...process.env,BG_ROOT:ROOT},input:input?JSON.stringify(input):undefined,encoding:"utf8",timeout:15000});if(r.status!==0)throw Error("history store failed: "+String(r.stderr).slice(0,150));return JSON.parse(r.stdout); }
let state = store("load");
const symbols = new Set([...(observed.gridRows || []).map((g) => g.symbol), ...Object.keys(state.symbols)]);
// Include recorded historical grid names, including deleted grids absent from fees.
try {
  const log = await fs.readFile(path.join(ROOT, "state/log.md"), "utf8");
  for (const market of log.match(/\b[A-Za-z0-9]+-PERP\b/g) || []) symbols.add(market.replace("-PERP", "_USDC_PERP"));
} catch {}
// Include legacy fee symbols to backfill grids which have already been deleted.
try { const old = JSON.parse(await fs.readFile(path.join(ROOT, "state/fees.json"), "utf8")); Object.keys(old.symbols || {}).forEach((s) => symbols.add(s)); } catch {}
const task = await taskSpace(cfg.watch.spaceId);
const browserFile = path.join(ROOT, "state/history_browser.json");
let browser;
try { browser = JSON.parse(await fs.readFile(browserFile, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
let page;
if (browser && browser.spaceId === task.spaceId) page = task.page(browser.page);
else {
  page = await task.newPage();
  await fs.writeFile(browserFile, JSON.stringify({ spaceId: task.spaceId, page: page.label }));
}
await page.goto(cfg.tradeUrlBase + "SOL_USD_PERP");
await page.waitForTimeout(2500);
async function checkAccount() { const r=await page.fetch("https://api.backpack.exchange/wapi/v1/portfolio/collateral",{credentials:"include",timeout:15000});if(r.status!==200)throw Error("collateral unavailable");collateralFor(JSON.parse(r.body),identity); }
await checkAccount();
const sampledAt=Date.now();
const fetchPage = async (symbol, from, to) => {
  await checkAccount();
  const r = await page.fetch(`https://api.backpack.exchange/wapi/v1/history/fills?subaccountId=${SUB}&symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=1000`, { credentials: "include", timeout: 15000 });
  if (r.status !== 200) throw new Error(`history HTTP ${r.status}`);
  return JSON.parse(r.body);
};
state = await collectHistory(state,symbols,sampledAt,fetchPage,30,{overlapMs:3600000,safetyLagMs:60000});
if(!state.incomplete) {
  for(const rec of Object.values(state.symbols)) if(!rec.auditedThrough)rec.auditedThrough=Date.parse(state.asOf);
}
state = await auditHistory(state,symbols,Date.parse(state.asOf),fetchPage,10);
await checkAccount();
async function atomic(p, data) { await fs.writeFile(p + ".tmp", JSON.stringify(data, null, 2)); await fs.rename(p + ".tmp", p); }
const summary = store("save",state);
try { const legacy = await fs.readFile(file,"utf8");if(!JSON.parse(legacy).storage) await fs.writeFile(path.join(ROOT,"state/trade_history.pre-binding.json"),legacy,{flag:"wx"}); } catch(e) {if(e.code!=="ENOENT"&&e.code!=="EEXIST")throw e;}
await atomic(file,{accountKey:identity.accountKey,storage:"history.sqlite",acquiredAt:state.acquiredAt,asOf:state.asOf,incomplete:state.incomplete,symbols:Object.fromEntries(Object.entries(state.symbols).map(([s,r])=>[s,{...r,fills:undefined}]))});
await atomic(path.join(ROOT,"state/fees.json"),summary);
console.log("history collection", state.incomplete ? "incomplete (will resume)" : "caught up");
