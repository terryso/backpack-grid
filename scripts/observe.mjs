// observe.mjs — runs INSIDE ego-browser (ESM). Reads account state via Backpack's
// session-authenticated web APIs (page.fetch with credentials) instead of DOM parsing.
// Output shape matches the previous DOM-based version so decide.cjs/act.mjs are unchanged.
// Fail-loud: shape-validate everything; on any mismatch write error and exit 1.
const fs = await import("node:fs/promises");
const path = await import("node:path");
const ROOT = "__BG_ROOT__"; // placeholder injected by ego_dispatch.sh (ego-browser does not inherit cwd/env)
const { createRequire } = await import("node:module");
const requireLocal = createRequire(path.join(ROOT, "scripts/observe.mjs"));
const { expectedIdentity, collateralFor, validateConfig } = requireLocal("./contracts.cjs");
const { finiteNumber, positionListOk } = createRequire(path.join(ROOT, "scripts/observe.mjs"))("./state_schema.cjs");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
validateConfig(cfg);
const identity = expectedIdentity(ROOT, cfg);
const SUB = cfg.subaccountId ?? 3;
const API = "https://api.backpack.exchange";

const task = await taskSpace(cfg.watch.spaceId);
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
const col = collateralFor(collateralAll, identity);
let markAll = [], marketDataAvailable = true;
try { markAll = await jget(`/api/v1/markPrices`); if (!Array.isArray(markAll)) throw Error("invalid mark prices"); }
catch { marketDataAvailable = false; markAll = []; }

// --- grids from automation snapshot ---
// grid pnl ledger: pnl = (soldValue - boughtValue) + netPosition*mark - fees  (verified vs UI)
if (!Array.isArray(auto.params?.symbols) || !Array.isArray(auto.snapshot?.symbols) || !Array.isArray(positionsRaw)) throw new Error("invalid account response structure");
const params = auto.params.symbols;
if(!positionListOk(positionsRaw))throw Error("position response malformed or duplicate symbol");
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
    const ledgerFieldsOk = ["soldValue", "boughtValue", "netPosition", "quoteAssetFees"].every((k) => finiteNumber(pnlLedger[k]));
    if (snapFound && !ledgerFieldsOk) dataIssues.push("ledger pnl fields missing/invalid for " + g.symbol);
    const netPosition = ledgerFieldsOk ? Number(pnlLedger.netPosition) : 0;
    const posEntry = positionsRaw.find((p) => p.symbol === g.symbol);
    // 跨接口一致性：账本有净持仓但持仓接口无条目 → 数据不完整，fail-loud（不用公共价掩盖）
    if (netPosition !== 0 && !posEntry) dataIssues.push("net position " + netPosition + " in ledger but no position entry for " + g.symbol);
    if (posEntry && !finiteNumber(posEntry.netQuantity)) dataIssues.push("invalid netQuantity for " + g.symbol);
    if (pnlLedger.baseAssetFees != null && !finiteNumber(pnlLedger.baseAssetFees)) dataIssues.push("invalid baseAssetFees for " + g.symbol);
    const hasLivePosition = posEntry && finiteNumber(posEntry.netQuantity) && Number(posEntry.netQuantity) !== 0;
    const markRaw = posEntry ? Number(posEntry.markPrice) : NaN;
    if ((hasLivePosition || netPosition !== 0) && (!finiteNumber(posEntry?.markPrice) || markRaw <= 0)) {
      // a live position without a valid mark would turn its inventory PnL into garbage —
      // fail loud instead of reading it as zero
      dataIssues.push("live position without valid mark price for " + g.symbol);
    }
    const mark = isFinite(markRaw) && markRaw > 0 ? markRaw : 0;
    const fees = Number(pnlLedger.quoteAssetFees || 0) + Number(pnlLedger.baseAssetFees || 0) * mark;
    const pnl =
      (Number(pnlLedger.soldValue || 0) - Number(pnlLedger.boughtValue || 0)) +
      netPosition * mark - fees;
    const allocation = Number(g.allocationUsd);
    if (!finiteNumber(g.allocationUsd) || allocation <= 0) dataIssues.push("invalid allocation for " + g.symbol);
    const market = g.symbol.replace("_USDC_PERP", "-PERP");
    const posForFunding = positionsRaw.find((p) => p.symbol === g.symbol);
    const fundingRaw = posForFunding ? Number(posForFunding.cumulativeFundingPayment) || 0 : 0;
    const effPnlPct = allocation ? +((pnl + fundingRaw) / allocation * 100).toFixed(2) : 0;
    const px = markAll.find((m) => m.symbol === g.symbol);
    return {
      market, symbol: g.symbol,
      price: px ? Number(px.markPrice) : null,
      effPnlPct,
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
  if(!finiteNumber(p.estLiquidationPrice)||Number(p.estLiquidationPrice)<0)dataIssues.push("invalid liquidation price for "+p.symbol);
  if((p.userId!=null&&String(p.userId)!==identity.userId)||(p.subaccountId!=null&&Number(p.subaccountId)!==identity.subaccountId))dataIssues.push("position account mismatch for "+p.symbol);
  if (!["netQuantity", "markPrice", "breakEvenPrice", "netExposureNotional", "imf", "cumulativeFundingPayment"].every((k) => finiteNumber(p[k]))) dataIssues.push("invalid position fields for " + p.symbol);
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
const netEquity = Number(col.netEquity);
const netEquityAvailable = Number(col.netEquityAvailable);
const margin = {
  totalEquity: "$" + netEquity.toFixed(2),
  availableEquity: "$" + netEquityAvailable.toFixed(2),
  openPnl: (positions.reduce((s, p) => s + (Number(p.pnl.replace(/[$,]/g, "")) || 0), 0) < 0 ? "-$" : "$") + Math.abs(positions.reduce((s, p) => s + (Number(p.pnl.replace(/[$,]/g, "")) || 0), 0)).toFixed(2),
  initMarginPct: Math.round(((netEquity - netEquityAvailable) / netEquity) * 100) + "%",
};
const badges = { "持仓": positions.length, "当前委托": Number(account.limitOrders), "网格": gridRows.length };
// 策略累计盈亏：当前权益相对系统接管基线（config.strategyBaselineUsd = 接管日首次观测权益）
// 口径含已落袋（已删除网格）+ 浮动 + 资金费 + 借贷利息 —— 唯一不随网格删除而失真的总账
const curEquity = netEquity;
const strategyEquity = {
  baseline: Number(cfg.strategyBaselineUsd || 0),
  baselineAt: cfg.strategyStartAt || null,
  equityChange: +(curEquity - Number(cfg.strategyBaselineUsd || 0)).toFixed(2),
  totalPnl: null, // cash-flow coverage is required before calling equity change strategy PnL
};

// 官方活动量（Mystery Box 1011，与官网弹窗同源，每小时更新）；失败为 null，回退账本增量口径
let officialCampaignVolume = null;
try {
  const cv = await page.fetch("https://api.backpack.exchange/wapi/v1/campaigns/1011/volume", { credentials: "include", timeout: 15000 });
  const v = Number(JSON.parse(cv.body)?.totalVolume);
  if (Number.isFinite(v) && v >= 0) officialCampaignVolume = v;
} catch {}

const observed = {
  at: new Date().toISOString(), source: "api", identity, marketDataAvailable,
  url: API, ...{ gridRows, margin, badges, positions }, strategyEquity, accountLeverageLimit: finiteNumber(account.leverageLimit) ? Number(account.leverageLimit) : null,
  // per-symbol strategy ledger volumes (bought+sold) for campaign volume tracking
  ledger: snapshot.map((s) => ({
    symbol: s.symbol,
    vol: Number(s.pnl?.boughtValue || 0) + Number(s.pnl?.soldValue || 0),
  })),
  officialCampaignVolume,
};

// --- validation --- zero grids is a legal state (all rotated out / deliberately empty)
const bad = [];
if (dataIssues.length) bad.push(...dataIssues);
for (const g of gridRows) {
  if (!isFinite(Number(g.range[0])) || !isFinite(Number(g.range[1]))) bad.push("range " + g.market);
  if (!isFinite(g.pnlPct)) bad.push("pnlPct " + g.market);
  if (g.pnlPct === null) bad.push("pnl null " + g.market);
}
if (!finiteNumber(col.netEquityAvailable)) bad.push("availableEquity invalid");
if (!finiteNumber(col.netEquity)) bad.push("netEquity " + netEquity);
// 孤儿持仓（无网格的仓位）由 decide 警告 + 禁止新增风险，不再阻断观察
observed.liquidating = account.liquidating === true; // legal risk state: decide must stop, not abort observation
if (bad.length) {
  observed.error = "validation: " + bad.join("; ");
  await fs.writeFile(path.join(ROOT, "state/observed.json.tmp"), JSON.stringify(observed, null, 2));
  await fs.rename(path.join(ROOT, "state/observed.json.tmp"), path.join(ROOT, "state/observed.json"));
  console.log(JSON.stringify({ error: observed.error }));
  process.exit(1);
}
await fs.writeFile(path.join(ROOT, "state/observed.json.tmp"), JSON.stringify(observed, null, 2));
  await fs.rename(path.join(ROOT, "state/observed.json.tmp"), path.join(ROOT, "state/observed.json"));

// Historical fills are collected by collect_history.mjs in a separate scheduled job.

console.log(JSON.stringify({
  at: observed.at, badges, margin,
  grids: gridRows.map((g) => `${g.market} ${g.direction} ${g.range.join("~")} x${g.count} ${g.value} pnl=${g.pnl} (${g.pnlPct}%)`),
  positions: positions.map((p) => `${p.market} ${p.side} size=${p.size} mark=${p.mark} liq=${p.liq} pnl=${p.pnl} (${p.pnlPct}%)`),
}, null, 1));
