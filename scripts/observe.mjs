// observe.mjs — runs INSIDE ego-browser (ESM). Reads account state via Backpack's
// session-authenticated web APIs (page.fetch with credentials) instead of DOM parsing.
// Output shape matches the previous DOM-based version so decide.cjs/act.mjs are unchanged.
// Fail-loud: shape-validate everything; on any mismatch write error and exit 1.
const fs = await import("node:fs/promises");
const path = await import("node:path");
const ROOT = "/Users/nick/CascadeProjects/backpack_grid"; // ego-browser does not inherit cwd/env
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId || 3;
const API = "https://api.backpack.exchange";

let task;
try { task = await taskSpace(cfg.watch.spaceId); }
catch {
  task = await taskSpace("backpack grid bot");
  cfg.watch.spaceId = task.spaceId;
  await fs.writeFile(path.join(ROOT, "config.json"), JSON.stringify(cfg, null, 2));
}
const page = task.page(cfg.watch.page);
// any backpack.exchange page provides the session origin; trade page also lets us
// cross-check the DOM when needed
await page.goto(cfg.tradeUrlBase + "SOL_USD_PERP");
await page.waitForTimeout(4000);

async function jget(pathname) {
  const r = await page.fetch(API + pathname, { credentials: "include", timeout: 15000 });
  if (r.status !== 200) throw new Error(`GET ${pathname} -> ${r.status} ${String(r.body).slice(0, 120)}`);
  return JSON.parse(r.body);
}

const auto = await jget(`/wapi/v1/subaccount/${SUB}/automation`);
const positionsRaw = await jget(`/api/v1/position?subaccountId=${SUB}`);
const account = await jget(`/api/v1/account?subaccountId=${SUB}`);
const collateralAll = await jget(`/wapi/v1/portfolio/collateral`);

// --- grids from automation snapshot ---
// grid pnl ledger: pnl = (soldValue - boughtValue) + netPosition*mark - fees  (verified vs UI)
const params = (auto.params && auto.params.symbols) || [];
const snapshot = (auto.snapshot && auto.snapshot.symbols) || [];
const markOf = new Map(positionsRaw.map((p) => [p.symbol, Number(p.markPrice)]));
const posBy = new Map(positionsRaw.map((p) => [p.symbol, p]));
const DIR = { Neutral: "中性", Long: "开多", Short: "开空" };

  const dataIssues = []; // fail-loud: incomplete data must never be read as zero
  const gridRows = params.map((g) => {
    const snapFound = snapshot.find((s) => s.symbol === g.symbol);
    if (!snapFound) dataIssues.push("no ledger snapshot for configured grid " + g.symbol);
    const snap = snapFound || { pnl: {} };
    const pnlLedger = snap.pnl || {};
    const netPosition = Number(pnlLedger.netPosition || 0);
    const posEntry = positionsRaw.find((p) => p.symbol === g.symbol);
    const hasLivePosition = posEntry && Number(posEntry.netQuantity) !== 0;
    const markRaw = posEntry ? Number(posEntry.markPrice) : NaN;
    if (hasLivePosition && (!isFinite(markRaw) || markRaw <= 0)) {
      // a live position without a valid mark would turn its inventory PnL into garbage —
      // fail loud instead of reading it as zero
      dataIssues.push("live position without valid mark price for " + g.symbol);
    }
    const mark = isFinite(markRaw) && markRaw > 0 ? markRaw : 0;
    const fees = Number(pnlLedger.quoteAssetFees || 0) + Number(pnlLedger.baseAssetFees || 0) * mark;
    const pnl =
      (Number(pnlLedger.soldValue || 0) - Number(pnlLedger.boughtValue || 0)) +
      netPosition * mark - fees;
    const allocation = Number(g.allocationUsd || 0);
    const market = g.symbol.replace("_USDC_PERP", "-PERP");
    return {
      market, symbol: g.symbol,
      direction: DIR[g.direction] || g.direction,
      range: [String(g.priceLow), String(g.priceHigh)],
      count: Number(g.levels),
      value: "$" + allocation.toFixed(2),
      allocationRaw: allocation,
      pnlRaw: pnl,
      pnl: (pnl < 0 ? "-" : "") + "$" + Math.abs(pnl).toFixed(2),
      pnlPct: allocation ? +((pnl / allocation) * 100).toFixed(2) : 0,
      status: g.enabled === false ? "Disabled" : "Triggered",
      control: g.enabled === false ? "关闭" : "开启",
      // native backstops as stored on the exchange (reconciliation source of truth)
      nativeTP: g.takeProfitPercentage === null || g.takeProfitPercentage === undefined ? null : Number(g.takeProfitPercentage),
      nativeSL: g.stopLossPercentage === null || g.stopLossPercentage === undefined ? null : Number(g.stopLossPercentage),
      nativeCloseOnStop: g.closePositionsOnStop === true,
    };
  });

// --- positions ---
const positions = positionsRaw.map((p) => {
  const netQty = Number(p.netQuantity);
  const mark = Number(p.markPrice);
  const breakeven = Number(p.breakEvenPrice);
  const pnl = (mark - breakeven) * netQty; // matches UI position pnl incl. sign for shorts
  return {
    market: p.symbol.replace("_USDC_PERP", "-PERP"), symbol: p.symbol,
    side: netQty >= 0 ? "long" : "short",
    size: String(Math.abs(netQty)),
    value: "$" + (Number(p.netExposureNotional)).toFixed(2),
    breakeven: String(breakeven), mark: String(mark),
    liq: String(Number(p.estLiquidationPrice)),
    initMargin: "$" + (Number(p.netExposureNotional) * Number(p.imf)).toFixed(2),
    funding: (Number(p.cumulativeFundingPayment) >= 0 ? "$" : "-$") + Math.abs(Number(p.cumulativeFundingPayment)).toFixed(2),
    fundingRaw: Number(p.cumulativeFundingPayment),
    pnl: (pnl < 0 ? "-$" : "$") + Math.abs(pnl).toFixed(2),
    pnlPct: +(pnl / (Number(p.netExposureNotional) * Number(p.imf)) * 100).toFixed(2),
  };
});

// --- margin: pick this subaccount's collateral entry ---
const colKey = Object.keys(collateralAll).find((k) => k.endsWith("-" + SUB)) || String(cfg.userId || "") + "-" + SUB;
const col = collateralAll[colKey];
if (!col) throw new Error("collateral entry not found for subaccount " + SUB + " (keys: " + Object.keys(collateralAll).join(",") + ")");
const netEquity = Number(col.netEquity);
const netEquityAvailable = Number(col.netEquityAvailable);
const margin = {
  totalEquity: "$" + netEquity.toFixed(2),
  availableEquity: "$" + netEquityAvailable.toFixed(2),
  openPnl: (positions.reduce((s, p) => s + (Number(p.pnl.replace(/[$,]/g, "")) || 0), 0) < 0 ? "-$" : "$") + Math.abs(positions.reduce((s, p) => s + (Number(p.pnl.replace(/[$,]/g, "")) || 0), 0)).toFixed(2),
  initMarginPct: Math.round(((netEquity - netEquityAvailable) / netEquity) * 100) + "%",
};
const badges = { "持仓": positions.length, "当前委托": Number(account.limitOrders), "网格": gridRows.length };
const observed = {
  at: new Date().toISOString(), source: "api",
  url: API, ...{ gridRows, margin, badges, positions },
  // per-symbol strategy ledger volumes (bought+sold) for campaign volume tracking
  ledger: snapshot.map((s) => ({
    symbol: s.symbol,
    vol: Number(s.pnl?.boughtValue || 0) + Number(s.pnl?.soldValue || 0),
  })),
};

// --- validation --- zero grids is a legal state (all rotated out / deliberately empty)
const bad = [];
if (dataIssues.length) bad.push(...dataIssues);
for (const g of gridRows) {
  if (!isFinite(Number(g.range[0])) || !isFinite(Number(g.range[1]))) bad.push("range " + g.market);
  if (!isFinite(g.pnlPct)) bad.push("pnlPct " + g.market);
  if (g.pnlPct === null) bad.push("pnl null " + g.market);
}
if (!isFinite(netEquity) || netEquity <= 0) bad.push("netEquity " + netEquity);
if (positions.length > gridRows.length) bad.push("more positions than grids (manual positions?)");
if (account.liquidating) bad.push("ACCOUNT LIQUIDATING");
if (bad.length) {
  observed.error = "validation: " + bad.join("; ");
  await fs.writeFile(path.join(ROOT, "state/observed.json"), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({ error: observed.error }));
  process.exit(1);
}
await fs.writeFile(path.join(ROOT, "state/observed.json"), JSON.stringify(observed, null, 2));
console.log(JSON.stringify({
  at: observed.at, badges, margin,
  grids: gridRows.map((g) => `${g.market} ${g.direction} ${g.range.join("~")} x${g.count} ${g.value} pnl=${g.pnl} (${g.pnlPct}%)`),
  positions: positions.map((p) => `${p.market} ${p.side} size=${p.size} mark=${p.mark} liq=${p.liq} pnl=${p.pnl} (${p.pnlPct}%)`),
}, null, 1));
