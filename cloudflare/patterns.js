'use strict';
// patterns.js — 持仓风险哨兵触发评估（无 IO）。
// 旧 streak 告警仅保留给切换期的旧快照。

const SWITCH_THRESHOLD = 5;

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

module.exports = { SENTINEL, evaluate };
