// 轻量峰值采样：只调权益接口，棘轮更新 state/risk.json 的 peakEquity。
// 独立于 15 分钟巡检（巡检进行中自动避让），让回撤指标的采样粒度从 15 分钟提升到 1 分钟。
const fs = await import("node:fs/promises");
const path = await import("node:path");
const ROOT = "/Users/nick/CascadeProjects/backpack_grid";
const RISK = path.join(ROOT, "state/risk.json");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId || 3;

// 巡检轮次进行中 → 避让（防止与 decide 的 risk.json 写入竞争）
const lockExists = await fs.access(path.join(ROOT, "state/lock")).then(() => true).catch(() => false);
if (lockExists) { console.log("round in progress — probe skips"); process.exit(0); }

let risk = null, fileState = "missing";
try { risk = JSON.parse(await fs.readFile(RISK, "utf8")); fileState = "present"; }
catch (e) { fileState = e.code === "ENOENT" ? "missing" : "corrupt"; }
if (fileState === "corrupt") { console.log("risk.json corrupt — probe skips (manual recovery)"); process.exit(0); }
if (fileState === "missing") risk = { peakEquity: 0, paused: null };
// 与 decide 同级的结构校验：null/布尔/空串不得经 Number() 洗白
const pk = risk ? risk.peakEquity : undefined;
const pkTypeOk = typeof pk === "number" || (typeof pk === "string" && String(pk).trim() !== "");
const pkNum = pkTypeOk ? Number(pk) : NaN;
if (!pkTypeOk || !Number.isFinite(pkNum) || pkNum < 0 || (risk.paused !== null && typeof risk.paused !== "object")) {
  console.log("risk.json invalid shape — probe skips (manual recovery)");
  process.exit(0);
}
risk.peakEquity = pkNum;

const task = await taskSpace(cfg.watch?.spaceId || 8);
const page = task.page(cfg.watch?.page || "p1");
// 确保会话 origin（页面可能被其它流程导航走）
await page.goto(cfg.tradeUrlBase + "SOL_USD_PERP");
await page.waitForTimeout(2500);
const r = await page.fetch(`https://api.backpack.exchange/wapi/v1/portfolio/collateral`, { credentials: "include", timeout: 15000 });
const col = JSON.parse(r.body);
const entry = col[Object.keys(col).find((k) => k.endsWith("-" + SUB))];
const eq = Number(entry?.netEquity);
if (!isFinite(eq) || eq <= 0) { console.log("bad equity:", eq); process.exit(0); }

// 提交前重读最新 risk（网络等待期间巡检可能已写入熔断锁存）：
// 峰值取 max（探测采样, 磁盘最新）、paused 逐字保留最新值——消除丢失更新窗口
const latest = JSON.parse(await fs.readFile(RISK, "utf8")); // rename 原子性保证读到完整文件
const { mergeProbe } = await import(path.join(ROOT, "scripts", "peak_merge.cjs").replace("file://", ""));
const merged = mergeProbe(latest, eq);
if (JSON.stringify(merged) !== JSON.stringify(latest)) {
  await fs.writeFile(RISK + ".probe." + process.pid + ".tmp", JSON.stringify(merged, null, 2)).then(() => fs.rename(RISK + ".probe." + process.pid + ".tmp", RISK));
  console.log("peak merged:", latest.peakEquity, "->", merged.peakEquity, "| paused 保留:", JSON.stringify(merged.paused));
} else {
  console.log("peak unchanged:", merged.peakEquity, "| equity:", eq);
}
