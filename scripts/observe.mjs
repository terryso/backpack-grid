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
const markAll = await jget(`/api/v1/markPrices`);

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
    const ledgerFieldsOk = ["soldValue", "boughtValue", "netPosition", "quoteAssetFees"].every((k) => pnlLedger[k] !== undefined && isFinite(Number(pnlLedger[k])));
    if (snapFound && !ledgerFieldsOk) dataIssues.push("ledger pnl fields missing/invalid for " + g.symbol);
    const netPosition = ledgerFieldsOk ? Number(pnlLedger.netPosition) : 0;
    const posEntry = positionsRaw.find((p) => p.symbol === g.symbol);
    // 跨接口一致性：账本有净持仓但持仓接口无条目 → 数据不完整，fail-loud（不用公共价掩盖）
    if (netPosition !== 0 && !posEntry) dataIssues.push("net position " + netPosition + " in ledger but no position entry for " + g.symbol);
    const hasLivePosition = posEntry && isFinite(Number(posEntry.netQuantity)) && Number(posEntry.netQuantity) !== 0;
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
// 策略累计盈亏：当前权益相对系统接管基线（config.strategyBaselineUsd = 接管日首次观测权益）
// 口径含已落袋（已删除网格）+ 浮动 + 资金费 + 借贷利息 —— 唯一不随网格删除而失真的总账
const curEquity = netEquity;
const strategyEquity = {
  baseline: Number(cfg.strategyBaselineUsd || 0),
  baselineAt: cfg.strategyStartAt || null,
  totalPnl: +(curEquity - Number(cfg.strategyBaselineUsd || 0)).toFixed(2),
};

const observed = {
  at: new Date().toISOString(), source: "api",
  url: API, ...{ gridRows, margin, badges, positions }, strategyEquity,
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
// 孤儿持仓（无网格的仓位）由 decide 警告 + 禁止新增风险，不再阻断观察
if (account.liquidating) bad.push("ACCOUNT LIQUIDATING");
if (bad.length) {
  observed.error = "validation: " + bad.join("; ");
  await fs.writeFile(path.join(ROOT, "state/observed.json"), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({ error: observed.error }));
  process.exit(1);
}
await fs.writeFile(path.join(ROOT, "state/observed.json"), JSON.stringify(observed, null, 2));

// ---- 手续费/maker 统计：独立于风控管线（在快照落盘之后采集，避免拖慢风险数据）----
// 修正版窗口循环：满页(1000)推进到最后一条成交时间戳并用 tradeId 去重；
// 不满页 = 窗口已完整，游标推进到窗口终点。只有确认完整的区间才推进游标。
try {
  const feesPath = path.join(ROOT, "state/fees.json");
  let fees = { symbols: {}, acquiredAt: null, incomplete: false };
  try { fees = JSON.parse(await fs.readFile(feesPath, "utf8")); } catch {}
  fees.incomplete = false;
  const nowMs = Date.now();
  const symbols = new Set([...(auto.params?.symbols || []).map((s) => s.symbol), ...Object.keys(fees.symbols || {})]);
  for (const symbol of symbols) {
    const rec = fees.symbols[symbol] || { lastTo: Date.UTC(2026, 8, 30, 0, 0, 0), feeUsd: 0, makerVol: 0, takerVol: 0, makerN: 0, takerN: 0 };
    // 逐 6h 切片回补：满页(1000)时二分缩窗重取（切片互不重叠，tradeId 兜底去重）；
    // 只有确认完整的切片（<1000）才推进游标；本轮未追平的部分下轮续采
    let lo = Math.max(Number(rec.lastTo) || 0, Date.UTC(2026, 8, 30, 0, 0, 0));
    let guard = 0;
    while (lo < nowMs - 1000 && guard++ < 30) {
      let hi = Math.min(lo + 6 * 3600 * 1000, nowMs);
      let fills = [];
      // 满页则二分缩窗（最多 5 次），确保每个请求都完整
      for (let shrink = 0; shrink < 5; shrink++) {
        const fr = await page.fetch(`https://api.backpack.exchange/wapi/v1/history/fills?subaccountId=${SUB}&symbol=${symbol}&from=${lo}&to=${hi}&limit=1000`, { credentials: "include", timeout: 20000 });
        fills = JSON.parse(fr.body);
        if (fills.length < 1000) break;
        hi = Math.floor((lo + hi) / 2);
        if (hi <= lo) break;
      }
      // F06 修正：满页（可能被 1000 上限截断）不累计不推进，下轮重采本切片
      if (fills.length >= 1000) break;
      for (const f of fills) {
        const vol = Number(f.price) * Number(f.quantity);
        if (f.feeSymbol === "USDC") rec.feeUsd = (rec.feeUsd || 0) + (Number(f.fee) || 0);
        if (f.isMaker) { rec.makerVol += vol; rec.makerN++; } else { rec.takerVol += vol; rec.takerN++; }
      }
      lo = hi; // 切片完整，推进
    }
    if (lo > rec.lastTo) rec.lastTo = lo; // 只推进已确认完整的区间
    fees.symbols[symbol] = rec;
  }
  fees.acquiredAt = new Date().toISOString();
  await fs.writeFile(feesPath, JSON.stringify(fees, null, 2));
} catch (e) {
  console.log("fees stats error (non-fatal):", String(e).slice(0, 120));
}

console.log(JSON.stringify({
  at: observed.at, badges, margin,
  grids: gridRows.map((g) => `${g.market} ${g.direction} ${g.range.join("~")} x${g.count} ${g.value} pnl=${g.pnl} (${g.pnlPct}%)`),
  positions: positions.map((p) => `${p.market} ${p.side} size=${p.size} mark=${p.mark} liq=${p.liq} pnl=${p.pnl} (${p.pnlPct}%)`),
}, null, 1));
