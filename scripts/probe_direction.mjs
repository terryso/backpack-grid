// 一次性只读探针：用 automation/validate 揭示 Backpack 方向网格的真实语义——
// direction: Neutral/Long/Short 各生成什么方向的挂单（orders[].side）。
const fs = await import("node:fs/promises");
const path = await import("node:path");
const ROOT = "__BG_ROOT__";
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId ?? 3;
const { resolveBotPage } = await import("file://" + "__BG_ROOT__" + "/scripts/ego_space.cjs");
const { page } = await resolveBotPage(ego, taskSpace, cfg.watch.page, () => {});
async function validate(direction, mark) {
  const params = { params: { strategyType: "Grid", symbol: "ETH_USDC_PERP", priceLow: String(mark * 0.94), priceHigh: String(mark * 1.06), levels: 10, allocationUsd: "1000", closePositionsOnStop: true, direction, takeProfitPercentage: cfg.takeProfitPct, stopLossPercentage: cfg.stopLossPct, enabled: true } };
  const r = await page.fetch(`https://api.backpack.exchange/wapi/v1/subaccount/${SUB}/automation/validate`, {
    method: "POST", credentials: "include", timeout: 15000,
    headers: { "content-type": "application/json" }, body: JSON.stringify(params),
  });
  const b = JSON.parse(r.body);
  const orders = b.orders || [];
  const bids = orders.filter(o => o.side === "Bid").length, asks = orders.filter(o => o.side === "Ask").length;
  return { status: r.status, direction, orders: orders.length, bids, asks, sample: orders.slice(0, 3).map(o => `${o.side}@${o.price}×${o.amount}`), errorField: b.errorField || null, startPrice: b.startPrice, error: String(r.body).slice(0, 120) };
}
const r0 = await page.fetch("https://api.backpack.exchange/api/v1/markPrices", { credentials: "include", timeout: 15000 });
const mark = Number(JSON.parse(r0.body).find(m => m.symbol === "ETH_USDC_PERP")?.markPrice) || 2300;
console.log("ETH mark:", mark);
for (const d of ["Neutral", "Long", "Short"]) {
  const r = await validate(d, mark);
  console.log(JSON.stringify(r));
}
