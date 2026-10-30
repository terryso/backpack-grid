'use strict';
// infeasible.cjs — 不可行市场降级表。act 在建格前置 validate 被交易所「确定性拒绝」
// （422 不透明拒绝 / 200+errorField 结构化错误，如 kPEPE minAllocation 墙）后写入；
// decide 降级期内跳过该市场，期满自动重试——可行则自然恢复，仍不可行则续降。
// 身份绑定：只认本账户的表，身份漂移时旧表整体失效（宁可多试一次，不用错账户的旧结论）。
const fs = require("node:fs");
const path = require("node:path");
const COOLOFF_HOURS = 24;

// 只返回未过期条目；读侧任何失败（缺失/损坏/IO）一律视为空表——降级是优化不是正确性
// 依赖，坏表绝不能阻断规划；外账户的表同样视为空（宁可多试一次，不用错账户的旧结论）。
function loadInfeasible(root, accountKey, now = Date.now()) {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(path.join(root, "state/infeasible_markets.json"), "utf8")); }
  catch {}
  if (!reg || reg.schemaVersion !== 1 || reg.accountKey !== accountKey || !reg.markets || typeof reg.markets !== "object") return {};
  const live = {};
  for (const [mkt, e] of Object.entries(reg.markets)) {
    const untilMs = Date.parse(e && e.until);
    if (Number.isFinite(untilMs) && untilMs > now) live[mkt] = { reason: String(e.reason || "infeasible"), until: e.until }; // 保留 ISO 串：decide 日志直接可读
  }
  return live;
}

// 仅确定性拒绝可调用；网络抖动/5xx 写进来会把偶发故障当永久不可行。写入时顺带清理
// 其它已过期条目，保持表面收敛。原子写（tmp+rename），与仓内其它状态文件一致。
function writeDemotion(root, accountKey, market, reason, now = Date.now()) {
  const file = path.join(root, "state/infeasible_markets.json");
  let markets = {};
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    if (old && old.schemaVersion === 1 && old.accountKey === accountKey && old.markets && typeof old.markets === "object") markets = old.markets;
  } catch {} // 损坏的旧表直接放弃继承，本次原子写会自愈覆盖
  const entry = { reason: String(reason).slice(0, 200), until: new Date(now + COOLOFF_HOURS * 3600000).toISOString(), checkedAt: new Date(now).toISOString() };
  markets[market] = entry;
  for (const [mkt, e] of Object.entries(markets)) {
    const u = Date.parse(e && e.until);
    if (!Number.isFinite(u) || u <= now) delete markets[mkt];
  }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, accountKey, markets }, null, 2));
  fs.renameSync(tmp, file);
  console.log(`DEMOTE ${market}: ${entry.reason} — decide skips until ${entry.until}`);
  return entry;
}

module.exports = { loadInfeasible, writeDemotion, COOLOFF_HOURS };
