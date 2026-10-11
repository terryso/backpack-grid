'use strict';
// position_age.cjs — 网格持仓时长。Backpack 持仓数据没有开仓时间戳，锚点由本地自建：
// 仓位首次出现（或多空翻向）时起算，同方向持续持有期间保持锚点，平仓（持仓列表消失或
// 数量归零）即清除。首次部署时既有仓位的时钟从部署时刻起算——诚实的限制。

function mergePositionAges(prev, accountKey, positions, nowMs) {
  const clean = prev && prev.accountKey === accountKey && prev.positions && typeof prev.positions === "object"
    ? prev : { accountKey, positions: {} };
  const next = { accountKey, positions: {} };
  const ages = {};
  for (const p of Array.isArray(positions) ? positions : []) {
    if (!p || typeof p.market !== "string" || !p.market) continue;
    const size = Number(p.size);
    if (!Number.isFinite(size) || size === 0) continue; // 数量归零视为空仓
    const side = p.side === "long" || p.side === "short" ? p.side : null;
    if (!side) continue; // 方向未知不入账（宁缺毋滥）
    const cur = clean.positions[p.market];
    // 同方向持续持有 → 保持原锚点；新出现或翻向 → 重置
    const since = cur && cur.side === side && Number.isFinite(Date.parse(cur.since))
      ? cur.since : new Date(nowMs).toISOString();
    next.positions[p.market] = { side, since };
    ages[p.market] = Date.parse(since);
  }
  return { ages, next };
}

function formatAgeMin(min) {
  if (min == null) return null; // 先校验原始值：Number(null) 是 0，不是「未知」
  const v = Number(min);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < 60) return Math.round(v) + " 分钟";
  if (v < 60 * 48) return (v / 60).toFixed(1) + " 小时";
  return Math.floor(v / 1440) + " 天 " + Math.round((v / 60) % 24) + " 小时";
}

module.exports = { mergePositionAges, formatAgeMin };
