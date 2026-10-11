'use strict';
// grid_age.cjs — 网格时长：以最近一次成功的建格动作（run_events 里 act=create 且
// done=true、账户匹配）为该网格的「开始」时刻。按事件流顺序维护锚点：已确认停止
// 清除旧锚点，只有新的成功建格才重新起算，避免同币种手动重建后沿用已停止网格的时间。
// 没有可绑定的建格记录时，如实显示未知。

function latestCreates(events, accountKey) {
  const created = {};
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.type !== "actions" || !Array.isArray(e.results)) continue;
    if (!e.identity || e.identity.accountKey !== accountKey) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    for (const r of Array.isArray(e.results) ? e.results : []) {
      if (!r || r.done !== true || typeof r.market !== "string" || !r.market) continue;
      if (r.act === "create") created[r.market] = at;
      else if (r.act === "stop") delete created[r.market];
    }
  }
  return created;
}

function formatAgeMin(min) {
  if (min == null) return null; // 先校验原始值：Number(null) 是 0，不是「未知」
  const v = Number(min);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < 60) return Math.round(v) + " 分钟";
  if (v < 60 * 48) return (v / 60).toFixed(1) + " 小时";
  return Math.floor(v / 1440) + " 天 " + Math.round((v / 60) % 24) + " 小时";
}

module.exports = { latestCreates, formatAgeMin };
