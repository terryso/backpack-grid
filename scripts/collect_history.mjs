// Read-only history collector. Separate browser space and lock from risk exits.
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { createRequire } = await import("node:module");
const ROOT = "/Users/nick/CascadeProjects/backpack_grid";
const { collectHistory, summarizeHistory } = createRequire(path.join(ROOT, "scripts/collect_history.mjs"))("./history_core.cjs");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId || 3;
const observed = JSON.parse(await fs.readFile(path.join(ROOT, "state/observed.json"), "utf8"));
const file = path.join(ROOT, "state/trade_history.json");
let state = { symbols: {} };
try { state = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
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
state = await collectHistory(state, symbols, Date.now(), async (symbol, from, to) => {
  const r = await page.fetch(`https://api.backpack.exchange/wapi/v1/history/fills?subaccountId=${SUB}&symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=1000`, { credentials: "include", timeout: 15000 });
  if (r.status !== 200) throw new Error(`history HTTP ${r.status}`);
  return JSON.parse(r.body);
});
async function atomic(p, data) { await fs.writeFile(p + ".tmp", JSON.stringify(data, null, 2)); await fs.rename(p + ".tmp", p); }
await atomic(file, state);
await atomic(path.join(ROOT, "state/fees.json"), summarizeHistory(state));
console.log("history collection", state.incomplete ? "incomplete (will resume)" : "caught up");
