'use strict';
// cloud_sync.cjs — 方向判定云端同步（cutover 11-21：权威源 = Cloudflare Worker 每小时判定）。
// 纯决策与取数在此（可单测、无副作用）；执行（spawnSync set / 镜像写）留在 decide.cjs。
// 铁律：云端永不持有交易 key——switchingObserved=true 只代表"云端判定该切换了"，
// 实际 set 由 Mac 端代为执行；拉取失败一律让调用方保旧值（数据失败不计数精神）。

// 从 dashboard.env 提取 DASH_URL（无 token 需求：/api/direction-advice 是公开只读路由）。
function dashUrlOf(file, fsMod, pathMod) {
  try {
    const line = fsMod.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("DASH_URL="));
    return line ? line.slice("DASH_URL=".length).trim() || null : null;
  } catch { return null; }
}

// GET /api/direction-advice（公开只读）。best effort：任何失败返回 null，调用方保旧值。
function fetchCloudAdvice(base, curlBin, timeoutMs) {
  try {
    const r = curlBin.spawnSync("curl", ["-fsS", "-m", String(Math.max(3, Math.ceil((timeoutMs || 10000) / 1000))), `${base}/api/direction-advice`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout);
  } catch {}
  return null;
}

// 同步决策：云端 advice + 本地当前指令 → 下一步动作。
//   apply-switch  云端已判 streak>=5 该切换且目标 ≠ 本地 → Mac 代执行 set
//   mirror-only   无切换事件 → 仅镜像最新判定到本地
//   none          无数据/过期 → 什么都不做（保旧值）
function planCloudSync(cloud, localDirective, nowMs, maxAgeMs = 2 * 3600000) {
  if (!cloud || typeof cloud !== "object" || typeof cloud.at !== "string" || !Number.isFinite(Date.parse(cloud.at))) return { action: "none", reason: "no-advice" };
  if (nowMs - Date.parse(cloud.at) > maxAgeMs) return { action: "none", reason: "stale" };
  if (cloud.switchingObserved === true && ["Long", "Short", "Neutral"].includes(cloud.rec) && cloud.rec !== localDirective)
    return { action: "apply-switch", switchTo: cloud.rec };
  return { action: "mirror-only" };
}

module.exports = { dashUrlOf, fetchCloudAdvice, planCloudSync };
