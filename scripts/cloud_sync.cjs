'use strict';
// cloud_sync.cjs — 方向判定云端同步（cutover 11-21：权威源 = Cloudflare Worker 每小时判定）。
// 取数在此；待确认事件的版本校验与本地写入留在 decide.cjs 的事务通道。
// 云端不持有交易 key；拉取失败时本地保留现有指令。

// 从 dashboard.env 提取 DASH_URL（无 token 需求：/api/direction-advice 是公开只读路由）。
function dashUrlOf(file, fsMod, pathMod) {
  try {
    const line = fsMod.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("DASH_URL="));
    return line ? line.slice("DASH_URL=".length).trim() || null : null;
  } catch { return null; }
}

// 旧协议的解析器仅保留兼容与回归；生产同步使用 fetchCloudMailbox。
function fetchCloudAdvice(base, curlBin, timeoutMs) {
  try {
    const r = curlBin.spawnSync("curl", ["-fsS", "-m", String(Math.max(3, Math.ceil((timeoutMs || 10000) / 1000))), `${base}/api/direction-advice`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout);
  } catch {}
  return null;
}

// The new mailbox endpoint is deliberately distinct from the legacy advice
// endpoint: a new client must never treat an old transient flag as durable.
function fetchCloudMailbox(base, curlBin, timeoutMs = 10000) {
  try {
    const r = curlBin.spawnSync('curl', ['-fsS', '-m', String(Math.max(3, Math.ceil(timeoutMs / 1000))), `${base}/api/direction-event`], { encoding: 'utf8', timeout: timeoutMs + 2000 });
    if (r.status === 0 && r.stdout) {
      const state = JSON.parse(r.stdout);
      if (state && typeof state === 'object' && !Array.isArray(state) && Object.prototype.hasOwnProperty.call(state, 'pending')) return state;
    }
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

module.exports = { dashUrlOf, fetchCloudAdvice, fetchCloudMailbox, planCloudSync };
