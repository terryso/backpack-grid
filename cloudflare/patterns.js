'use strict';
// patterns.js — 方向判定纯函数 + 哨兵触发评估（无 IO）。
// metrics/judge/nextAdvice/SWITCH_THRESHOLD 自 scripts/direction_watch.cjs 原样移植，
// 语义零漂移是影子期一致率的前提——改动这里必须与本地版本逐字对齐。

const SWITCH_THRESHOLD = 5;

// 1h 收盘价（时间升序）→ 趋势指标。数据不足的维度为 NaN，由 judge 逐项判可用性。
function metrics(closes) {
  const cs = Array.isArray(closes) ? closes.filter((c) => Number.isFinite(c) && c > 0) : [];
  if (cs.length < 25) return null; // 连 t24 都算不出
  const last = cs[cs.length - 1];
  const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : NaN);
  const t24 = cs.length > 24 ? pct(last, cs[cs.length - 25]) : NaN;
  const t7 = cs.length > 168 ? pct(last, cs[cs.length - 169]) : NaN;
  const t14 = cs.length > 336 ? pct(last, cs[cs.length - 337]) : NaN;
  const win = cs.slice(-Math.min(cs.length, 336)); // 最多看 14d
  const hi = Math.max(...win);
  const lo = Math.min(...win);
  const rangePos = hi > lo ? (last - lo) / (hi - lo) : 0.5; // 零宽度=横盘，中性 0.5
  const bounce = hi > lo ? (last / lo - 1) * 100 : 0; // 距低点反弹%
  const drop = hi > lo ? (1 - last / hi) * 100 : 0;   // 距高点回落%（Long 指令镜像用）
  return { t24, t7, t14, rangePos, bounce, drop };
}

// 判定归一化为 rec（Long/Short/Neutral）。强证据优先：维持 → 强反转 → 弱反转 → 维持。
// 数据不完整（关键指标 NaN）→ 维持当前指令（无判断不作数）。
function judge(m, directive) {
  if (!m || !Number.isFinite(m.t7) || !Number.isFinite(m.rangePos)) return directive;
  const { t7, t14, rangePos: pos, bounce, drop } = m;
  if (directive === "Short") {
    if (Number.isFinite(t7) && t7 < -3) return "Short";
    if (pos < 1 / 3) return "Short";
    if (Number.isFinite(t14) && t14 > 0 && t7 > 5) return "Long";
    if (Number.isFinite(t7) && t7 > 3) return "Neutral";
    if (Number.isFinite(bounce) && bounce > 8) return "Neutral";
    return "Short";
  }
  if (directive === "Long") {
    if (Number.isFinite(t7) && t7 > 3) return "Long";
    if (pos > 2 / 3) return "Long";
    if (Number.isFinite(t14) && t14 < 0 && t7 < -5) return "Short";
    if (Number.isFinite(t7) && t7 < -3) return "Neutral";
    if (Number.isFinite(drop) && drop > 8) return "Neutral";
    return "Long";
  }
  // Neutral 指令：任一锚出现明确趋势才顺势，否则维持
  if (Number.isFinite(t7) && t7 > 5) return "Long";
  if (Number.isFinite(t7) && t7 < -5) return "Short";
  return "Neutral";
}

// streak 计数器与切换判定（与本地 direction_watch 完全同语义）：
// 用户手动改指令 → 清零；与指令一致 → 清零；与上一次判定同向 → 累积；否则从 1 起。
function nextAdvice(prev, rec, directive, at) {
  const p = prev && typeof prev === "object" ? prev : {};
  const manual = p.lastDirective !== undefined && p.lastDirective !== directive;
  let streak;
  if (manual) streak = 0;
  else if (rec === directive) streak = 0;
  else if (rec === p.rec) streak = (Number(p.streak) || 0) + 1;
  else streak = 1;
  const switching = streak >= SWITCH_THRESHOLD && rec !== directive;
  return { advice: { ...p, at, directive, rec, streak: switching ? 0 : streak, lastDirective: directive }, switching };
}

// ---------- 哨兵 ----------

const SENTINEL = {
  SL_NEAR_PCT: 2,          // A：现价距 nativeSL 不足 2%
  BLIND_MIN: 30,           // B：快照超 30 分钟 = 盲窗
  BLIND_SL_PCT: 3,         // B：盲窗 + 距 SL 不足 3% = 挨打
  STREAK_ALERT: 3,         // C：streak ≥ 3（距改写 ≤ 2 次判定）
  STREAK_MAX_AGE_MIN: 120, // C 仅在判定新鲜时触发（stale 判定的 streak 不可信）
  COOLDOWN_MS: 60 * 60000, // 同触发器 1 小时最多推一次
  C_MUTE_UTC_FROM: 15,     // C 夜间静音：UTC 15–24 点 = 北京 23:00–08:00
};

// 按持仓保本价与配置比例计算风险参考价；这不是交易所的止损触发价。
// 距离为正表示尚未越过参考价，为负表示已经越过。
function slDistance(pos, liveMark, slPct) {
  if (!pos || (pos.side !== "short" && pos.side !== "long")) return null;
  const numeric = value => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  const be = numeric(pos.breakeven), mk = numeric(liveMark);
  if (!Number.isFinite(be) || !(be > 0) || !Number.isFinite(mk) || !(mk > 0)) return null;
  const parsedPct = numeric(slPct);
  const pct = pos.side === "short" && !(parsedPct > 0) ? 6 : parsedPct;
  // A long stop at or below zero cannot be estimated from this percentage.
  if (!Number.isFinite(pct) || pct <= 0 || (pos.side === "long" && pct >= 100)) return null;
  const slPrice = be * (1 + (pos.side === "short" ? pct : -pct) / 100);
  const distPct = (pos.side === "short" ? slPrice - mk : mk - slPrice) / mk * 100;
  return { symbol: pos.symbol || pos.market, slPrice, mark: mk, distPct };
}

// 用 KV 快照 + 实时公开行情评估三个触发器。liveMarks 为空时退回快照 mark（降级仍可用）。
function evaluate(latest, liveMarks, nowMs = Date.now()) {
  const positions = Array.isArray(latest?.positions) ? latest.positions : [];
  const rows = [];
  for (const p of positions) {
    const live = liveMarks && Number(liveMarks[p.symbol]);
    const r = slDistance(p, Number.isFinite(live) && live > 0 ? live : p.mark, latest?.slPct);
    if (r) rows.push(r);
  }
  rows.sort((a, b) => a.distPct - b.distPct);
  const worst = rows[0] || null;
  const blindMin = latest?.updatedAt && Number.isFinite(Date.parse(latest.updatedAt))
    ? (nowMs - Date.parse(latest.updatedAt)) / 60000 : null;
  const dir = latest?.direction || {};
  const streak = Number(dir.streak) || 0;
  const judgedAge = Number(dir.judgedAgeMin);
  const utcH = new Date(nowMs).getUTCHours();
  const cMuted = utcH >= SENTINEL.C_MUTE_UTC_FROM;
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : "?");
  const short = (s) => String(s || "").replace("_USDC_PERP", "");
  const triggers = [];
  if (worst && worst.distPct < SENTINEL.SL_NEAR_PCT) {
    triggers.push({
      type: "A", level: "timeSensitive",
      title: `哨兵A ${short(worst.symbol)} 距持仓风险参考价${fmt(worst.distPct)}%`,
      body: `参考价≈${worst.slPrice.toFixed(2)} 现价${worst.mark.toFixed(2)}；按保本价和配置比例估算，并非交易所止损价`,
    });
  }
  if (worst && blindMin !== null && blindMin > SENTINEL.BLIND_MIN && worst.distPct < SENTINEL.BLIND_SL_PCT) {
    triggers.push({
      type: "B", level: "timeSensitive",
      title: `哨兵B 盲窗${Math.round(blindMin)}分 距持仓风险参考价${fmt(worst.distPct)}%`,
      body: `${short(worst.symbol)} Mac无写入 — 建议手机处置`,
    });
  }
  if (streak >= SENTINEL.STREAK_ALERT && Number.isFinite(judgedAge) && judgedAge <= SENTINEL.STREAK_MAX_AGE_MIN && !cMuted) {
    triggers.push({
      type: "C", level: "active",
      title: `哨兵C streak ${streak}/5`,
      body: `${dir.verdict || ""} 再${SWITCH_THRESHOLD - streak}次反向判定将改写指令，考虑介入`,
    });
  }
  return {
    triggers,
    detail: {
      worst, blindMin: blindMin === null ? null : Math.round(blindMin),
      streak, judgedAge: Number.isFinite(judgedAge) ? judgedAge : null,
      cMuted, positionsEvaluated: rows.length, liveMarks: Boolean(liveMarks),
    },
  };
}

module.exports = { metrics, judge, nextAdvice, SWITCH_THRESHOLD, SENTINEL, evaluate };
