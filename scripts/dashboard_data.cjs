#!/usr/bin/env node
// dashboard_data.cjs — assemble a compact dashboard snapshot from state/ files.
// Writes state/dashboard.json (upload artifact). --preview writes state/dashboard_preview.html
// with the snapshot inlined (no server needed).
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const read = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return null; } };
const cfg = read("config.json") || {};

const obs = read("state/observed.json") || {};
const campaign = read("state/campaign.json") || {};
const risk = read("state/risk.json") || {};
const pending = read("state/pending_stops.json") || {};
const actResults = read("state/act_results.json") || {};

const num = (s) => { const n = Number(String(s == null ? "" : s).replace(/[$,%\s,]/g, "")); return isFinite(n) ? n : 0; };
const grids = obs.gridRows || [];
const positions = obs.positions || [];
const orphans = positions.filter((p) => !grids.some((g) => g.market === p.market)).map((p) => p.market);

// equity curve: last 400 rounds
let curve = [];
try {
  const lines = fs.readFileSync(path.join(ROOT, "state/equity_curve.jsonl"), "utf8").trim().split("\n").slice(-400);
  curve = lines.map((l) => { try { const r = JSON.parse(l); return [r.at, num(r.equity), Math.round(num(r.campaignVolume))]; } catch { return null; } }).filter(Boolean);
} catch {}

const lastActionEntry = (actResults.results || []).slice(-1)[0] || null;
let lastAction = null;
let lastActionNote = null;
// stale entries (>24h, e.g. old test cleanups) must not present themselves as "最近动作"
const actAgeH = actResults.at ? (Date.now() - new Date(actResults.at).getTime()) / 3600000 : Infinity;
if (lastActionEntry && actAgeH < 24) {
  const when = (actResults.at || "").replace("T", " ").slice(5, 16);
  const wrapReason = (r) => (r && String(r).trim() ? `（${String(r).slice(0, 80)}）` : "");
  if (lastActionEntry.done === false) { lastAction = `${lastActionEntry.act} 失败`; lastActionNote = `${when} · ${lastActionEntry.act} ${lastActionEntry.market || ""} 失败：${String(lastActionEntry.error || "").slice(0, 120)}`; }
  else if (lastActionEntry.act === "stop") { lastAction = `停止 ${lastActionEntry.market || ""}`; lastActionNote = `${when} · 停止 ${lastActionEntry.market}${wrapReason(lastActionEntry.reason)}`; }
  else if (lastActionEntry.act === "create") { lastAction = `创建 ${lastActionEntry.market || ""}`; lastActionNote = `${when} · 创建 ${lastActionEntry.market} ${lastActionEntry.lower}~${lastActionEntry.upper} x${lastActionEntry.count}`; }
  else if (lastActionEntry.act === "protect") { lastAction = `保护修复 ${lastActionEntry.market || ""}`; lastActionNote = `${when} · 恢复 ${lastActionEntry.market} 原生 TP/SL`; }
}

const strategy = obs.strategyEquity || null;
const feesStats = obs.feesStats || null;
// 运行统计：天数（自策略基线日）、巡检轮次（equity_curve 行数）、自动换仓次数（log 中 stop 动作计数）
let runDays = null, rounds = 0, rotations = 0, change24h = null, change24hPct = null, maxDD = null;
try {
  const startAt = (strategy && strategy.baselineAt) || (obs.strategyEquity && obs.strategyEquity.baselineAt);
  if (startAt) runDays = +((Date.now() - new Date(startAt).getTime()) / 86400000).toFixed(1);
  const cur = num(obs.margin && obs.margin.totalEquity);
  const curveLines = fs.readFileSync(path.join(ROOT, "state/equity_curve.jsonl"), "utf8").trim().split("\n");
  rounds = curveLines.length;
  // 权益曲线采样点 + 24h 变化 + 历史最大回撤（滚动峰值法）
  try {
    const pts = curveLines.map((l) => { try { const r = JSON.parse(l); return { t: new Date(r.at).getTime(), eq: num(r.equity) }; } catch { return null; } }).filter(Boolean);
    // 追加当前权益作为最后一个点（实时性）
    if (isFinite(cur)) pts.push({ t: Date.now(), eq: cur });
    const now = Date.now();
    const dayAgo = now - 86400000;
    let ref = null;
    for (const p of pts) if (p.t <= dayAgo && (!ref || p.t > ref.t)) ref = p;
    if (ref) { change24h = +(cur - ref.eq).toFixed(2); change24hPct = +((cur - ref.eq) / ref.eq * 100).toFixed(2); }
    let pk = 0;
    for (const p of pts) {
      if (p.eq > pk) pk = p.eq;
      const dd = pk > 0 ? (pk - p.eq) / pk * 100 : 0;
      if (maxDD === null || dd > maxDD) maxDD = +dd.toFixed(2);
    }
  } catch {}
  const logText = fs.readFileSync(path.join(ROOT, "state/log.md"), "utf8");
  for (const line of logText.split("\n")) {
    const m = line.match(/actions=([^\n]*)/);
    if (m) rotations += (m[1].match(/stop:/g) || []).length;
  }
} catch {}
const snapshot = {
  updatedAt: obs.at || new Date().toISOString(),
  equity: num(obs.margin && obs.margin.totalEquity),
  available: num(obs.margin && obs.margin.availableEquity),
  strategyTotalPnl: strategy && strategy.totalPnl != null ? strategy.totalPnl : null,
  strategyBaseline: strategy ? strategy.baseline : null,
  strategyBaselineAt: strategy ? strategy.baselineAt : null,
  fees: feesStats && !feesStats.error ? { feeUsd: +feesStats.feeUsd.toFixed(2), makerPct: feesStats.makerPct, fills: feesStats.fills } : null,
  runStats: { days: runDays, rounds, rotations },
  change24h, change24hPct,
  maxDrawdown: maxDD,
  drawdownPct: Math.max(0, risk.peakEquity ? ((risk.peakEquity - num(obs.margin && obs.margin.totalEquity)) / risk.peakEquity) * 100 : 0),
  riskPaused: !!(risk.paused),
  campaignVolume: Math.round(num(campaign.campaignVolume)),
  tier1: 50000,
  tier1Secured: num(campaign.campaignVolume) >= 50000,
  grids: grids.map((g) => ({
    market: g.market, direction: g.direction,
    range: `${g.range[0]} ~ ${g.range[1]}`, count: g.count,
    value: num(g.value), pnl: num(g.pnl), pnlPct: num(g.pnlPct), status: g.status,
    price: g.price, nativeSL: g.nativeSL,
  })),
  tpPct: cfg.takeProfitPct, slPct: cfg.stopLossPct,
  positions: positions.map((p) => ({ market: p.market, side: p.side, size: p.size, mark: p.mark, pnl: p.pnl })),
  pending: Object.keys(pending),
  orphans,
  lastAction, lastActionNote,
  curve,
};

fs.writeFileSync(path.join(ROOT, "state/dashboard.json"), JSON.stringify(snapshot));

if (process.argv.includes("--preview")) {
  const html = fs.readFileSync(path.join(ROOT, "cloudflare/dashboard.html"), "utf8")
    .replaceAll("__TOKEN__", "PREVIEW")
    .replace("const TOKEN = \"PREVIEW\";", `const TOKEN = "PREVIEW";\nwindow.__INLINE__ = ${JSON.stringify(snapshot)};`)
    .replace("const r = await fetch(`/api/snapshot?k=${encodeURIComponent(TOKEN)}`);\n    if (!r.ok) throw new Error(r.status);\n    render(await r.json());",
      "if (window.__INLINE__) { render(window.__INLINE__); return; }\n    const r = await fetch(`/api/snapshot?k=${encodeURIComponent(TOKEN)}`);\n    if (!r.ok) throw new Error(r.status);\n    render(await r.json());");
  fs.writeFileSync(path.join(ROOT, "state/dashboard_preview.html"), html);
  console.log("preview written: state/dashboard_preview.html");
} else {
  console.log("dashboard.json written");
}
