// 轻量峰值采样：只调权益接口，经唯一写入通道 risk_write.py 棘轮更新 peakEquity。
// 独立于 15 分钟巡检，采样粒度 1 分钟；risk.json 的事务互斥由 risk_write.py 的
// 内核 flock 保证（采样可与巡检重叠，提交窗口互斥），无需再检查轮次锁。
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { spawnSync } = await import("node:child_process");
const ROOT = "/Users/nick/CascadeProjects/backpack_grid";
const RISK = path.join(ROOT, "state/risk.json");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId || 3;

// 采样前的本地快检：损坏/形状非法时不采样也不写（与 risk_write.py 的拒写规则一致）
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

// 提交走唯一写入通道：flock 事务内重读磁盘最新值，峰值取 max（较低采样不回退）、
// paused 逐字保留最新——重读之后发生的熔断写入不可能被本进程覆盖
const w = spawnSync("python3", [path.join(ROOT, "scripts", "risk_write.py"), JSON.stringify({ peakEquity: eq })], { encoding: "utf8" });
if (w.status !== 0) { console.log("risk write refused (status", w.status, ") — kept for manual recovery"); process.exit(0); }
const merged = JSON.parse(String(w.stdout).trim());
console.log("peak:", pkNum, "->", merged.peakEquity, "| paused 保留:", JSON.stringify(merged.paused), "| equity:", eq);
