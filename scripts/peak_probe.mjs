// 轻量峰值采样：只调权益接口，经唯一写入通道 risk_write.py 棘轮更新 peakEquity。
// 独立于 15 分钟巡检，采样粒度 1 分钟；risk.json 的事务互斥由 risk_write.py 的
// 内核 flock 保证（采样可与巡检重叠，提交窗口互斥），无需再检查轮次锁。
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { spawnSync } = await import("node:child_process");
const ROOT = "__BG_ROOT__"; // placeholder injected by ego_dispatch.sh
const RISK = path.join(ROOT, "state/risk.json");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const SUB = cfg.subaccountId ?? 3;

// 采样前的本地快检：损坏/形状非法时不采样也不写（与 risk_write.py 的拒写规则一致）
let risk = null, fileState = "missing";
try { risk = JSON.parse(await fs.readFile(RISK, "utf8")); fileState = "present"; }
catch (e) { fileState = e.code === "ENOENT" ? "missing" : "corrupt"; }
if (fileState === "corrupt") { console.log("risk.json corrupt — probe skips (manual recovery)"); process.exit(0); }
if (fileState === "missing") risk = { peakEquity: 0, paused: null };
// 与 decide 同级的结构校验：null/布尔/空串不得经 Number() 洗白
const { createRequire } = await import("node:module");
const { expectedIdentity, collateralFor } = createRequire(path.join(ROOT, "scripts/peak_probe.mjs"))("./contracts.cjs");
const identity = expectedIdentity(ROOT, cfg);
const { riskStructOk, finiteNumber } = createRequire(path.join(ROOT, "scripts/peak_probe.mjs"))("./state_schema.cjs");
if (!riskStructOk(risk)) { console.log("risk.json invalid shape — probe skips (manual recovery)"); process.exit(0); }
const pkNum = Number(risk.peakEquity);

const task = await taskSpace(cfg.watch?.spaceId || 8);
const page = task.page(cfg.watch?.page || "p1");
// 确保会话 origin（页面可能被其它流程导航走）
await page.goto("https://backpack.exchange/portfolio/balances/assets", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => page.waitForTimeout(3000).then(() => page.goto("https://backpack.exchange/portfolio/balances/assets", { waitUntil: "domcontentloaded", timeout: 25000 }))); // 资产总览页：有会话 origin，比交易页轻
await page.waitForTimeout(2500);
const r = await page.fetch(`https://api.backpack.exchange/wapi/v1/portfolio/collateral`, { credentials: "include", timeout: 15000 });
const col = JSON.parse(r.body);
if(r.status!==200)throw Error("collateral unavailable");
const entry = collateralFor(col, identity);
const eq = Number(entry?.netEquity);
if (!finiteNumber(entry?.netEquity)) { console.log("bad equity:", eq); process.exit(0); }

// 提交走唯一写入通道：flock 事务内重读磁盘最新值，峰值取 max（较低采样不回退）、
// paused 逐字保留最新——重读之后发生的熔断写入不可能被本进程覆盖
const PY = process.env.PY_BIN || "__PY_BIN__"; // placeholder injected by ego_dispatch.sh
if (PY.startsWith("__")) throw Error("PY_BIN not injected — dispatch via peak_probe.sh (ego_dispatch.sh)");
const w = spawnSync(PY, [path.join(ROOT, "scripts", "risk_write.py"), JSON.stringify({ peakEquity: Math.max(0,eq), accountKey: identity.accountKey, assessment:{equity:eq,budgetPct:cfg.riskBudgetPct,at:new Date().toISOString()} })], { encoding: "utf8", timeout: 8000 });
if (w.status !== 0) { console.log("risk write refused (status", w.status, ") — kept for manual recovery"); process.exit(1); }
const merged = JSON.parse(String(w.stdout).trim());
console.log("peak:", pkNum, "->", merged.peakEquity, "| paused 保留:", JSON.stringify(merged.paused), "| equity:", eq);
