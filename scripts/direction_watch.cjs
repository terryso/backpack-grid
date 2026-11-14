'use strict';
// direction_watch.cjs — 每小时方向判定 + 受约束自动切换（原 ZCode 每小时定时任务的脚本化迁移）。
// 节奏与规则与原任务一致（每小时判定一次、连续 5 次同向且与指令不一致才自动切换）；
// 唯一修正：判定优先级按「强证据优先」实现——原提示词按字面顺序（维持→转Neutral→转Long）
// 会让转 Long 分支永不可达（t7>+5% 也命中 t7>+3%），这里是还原 agent 实际的判断方式。
// 硬性约束（与原任务相同）：
//   - 写指令的唯一合法路径：streak>=5 且 rec!=当前指令 → grid_direction.cjs set '*' <rec>
//   - 数据拉取失败：不更新计数器（本次无判断），日志如实记录（失败小时按协议不计数）
//   - BTC 为主锚，在跑网格市场仅为参考存档
// 防挂死：整体硬 deadline 120s——launchd StartInterval 单实例语义下实例挂死会吞掉全部
// 后续触发（11-14 14:06 事故：一个挂死实例占位 6h+、25 轮触发被吞）。
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadDirections } = require("./grid_direction.cjs");
const { expectedIdentity } = require("./contracts.cjs");

const DEADLINE_MS = 120000;
const SWITCH_THRESHOLD = 5;

// ---------- 纯逻辑（导出便于测试，无 IO） ----------

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

// streak 计数器与切换判定。返回 { advice, switching }；切换发生时 streak 归零由调用方
// 在切换指令写入成功后落盘（失败时保留 streak 让下一轮重试，见主流程）。
function nextAdvice(prev, rec, directive, at) {
  const p = prev && typeof prev === "object" ? prev : {};
  const manual = p.lastDirective !== undefined && p.lastDirective !== directive;
  let streak;
  if (manual) streak = 0; // 用户手动改指令 → 计数器重置
  else if (rec === directive) streak = 0; // 与指令一致 → 清零
  else if (rec === p.rec) streak = (Number(p.streak) || 0) + 1; // 同向累积
  else streak = 1;
  const switching = streak >= SWITCH_THRESHOLD && rec !== directive;
  return { advice: { ...p, at, directive, rec, streak: switching ? 0 : streak, lastDirective: directive }, switching };
}

// ---------- IO 壳 ----------

if (require.main === module) {
  // 硬 deadline：到点强杀，绝不占住 launchd 单实例槽
  const deadlineTimer = setTimeout(() => {
    console.error(`direction_watch exceeded ${DEADLINE_MS}ms deadline — exiting`);
    process.exit(9);
  }, DEADLINE_MS);

  const ROOT = process.env.BG_ROOT || path.join(__dirname, "..");
  const stateDir = path.join(ROOT, "state");
  const log = (line) => fs.appendFileSync(path.join(stateDir, "direction_watch.log"), line + "\n");
  const nowISO = () => new Date().toISOString();
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8")); } catch { return null; } };

  (async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const identity = expectedIdentity(ROOT, cfg);
    const key = identity.accountKey;
    const directive = loadDirections(ROOT, key)["*"] || "Neutral";

    const obs = readJson("observed.json");
    const running = Array.isArray(obs?.gridRows) ? [...new Set(obs.gridRows.map((g) => g.symbol).filter(Boolean))] : [];
    const symbols = [...new Set(["BTC_USDC_PERP", ...running])];

    const { getKlines } = require("./api.cjs");
    const fetchCloses = async (sym) => {
      for (let attempt = 1; attempt <= 2; attempt++) { // 代理链路间歇抖动：先重试再定性
        try {
          const kl = await getKlines(sym, "1h", 340, 400); // 336h 跨度需 337 根才够算 t14，多取缓冲
          const closes = Array.isArray(kl) ? kl.map((k) => Number(k.close)).filter((c) => Number.isFinite(c)) : [];
          if (closes.length >= 25) return closes;
        } catch {}
        if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
      }
      return null;
    };

    const series = {};
    for (const sym of symbols) series[sym] = await fetchCloses(sym);

    const btcM = metrics(series.BTC_USDC_PERP);
    if (!btcM) {
      const line = `${nowISO()} DATA_FAIL ${symbols.filter((s) => !series[s]).join(",") || "unknown"} — no judgement, streak untouched`;
      log(line);
      console.error(line);
      process.exitCode = 1;
      return;
    }
    const refSym = running.find((s) => s !== "BTC_USDC_PERP") || null;
    const refM = refSym ? metrics(series[refSym]) : null;

    const prev = readJson("direction_advice.json");
    const rec = judge(btcM, directive);
    const { advice, switching } = nextAdvice(prev, rec, directive, nowISO());

    let switchError = null;
    if (switching) {
      const set = spawnSync(process.execPath, [path.join(ROOT, "scripts", "grid_direction.cjs"), "set", "*", rec], { encoding: "utf8", timeout: 30000 });
      if (set.status === 0) {
        advice.switchLog = [...(Array.isArray(prev?.switchLog) ? prev.switchLog : []).slice(-49),
          { at: advice.at, from: directive, to: rec, streakObserved: SWITCH_THRESHOLD, evidence: `btc t7=${btcM.t7?.toFixed(1)}% t14=${btcM.t14?.toFixed(1)}% pos=${btcM.rangePos?.toFixed(2)}` }];
      } else {
        // 切换指令写入失败：保留 streak 让下一轮重试，本次不清零
        advice.streak = SWITCH_THRESHOLD;
        switchError = String(set.stderr || set.error || "set failed").slice(0, 120);
      }
    }
    advice.verdict = rec === directive ? `维持 ${directive}` : `${rec} (streak ${advice.streak}/${SWITCH_THRESHOLD})`;
    advice.note = `btc t7=${btcM.t7?.toFixed(1)}% t14=${Number.isFinite(btcM.t14) ? btcM.t14.toFixed(1) + "%" : "n/a"} pos=${btcM.rangePos.toFixed(2)} bounce=${btcM.bounce.toFixed(1)}%`;
    if (refM) advice.ref = { symbol: refSym, t7: refM.t7, t14: refM.t14, rangePos: refM.rangePos };
    delete advice.btc; delete advice.eth; // ZCode 时代的参考块（会陈旧误导），参考数据由 ref 承担

    const tmp = path.join(stateDir, "direction_advice.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(advice, null, 1));
    fs.renameSync(tmp, path.join(stateDir, "direction_advice.json"));

    const line = `${advice.at} ${directive} -> ${rec} streak=${advice.streak}/${SWITCH_THRESHOLD} ${advice.note}${switching && !switchError ? " ⚡SWITCHED" : ""}${switchError ? " SWITCH_SET_FAILED " + switchError : ""}`;
    log(line);
    console.log(line);
    if (switchError) process.exitCode = 1;
  })().catch((e) => {
    log(`${nowISO()} ERROR ${String(e && e.message || e).slice(0, 160)}`);
    console.error(e);
    process.exitCode = 1;
  }).finally(() => clearTimeout(deadlineTimer));
}

module.exports = { metrics, judge, nextAdvice, SWITCH_THRESHOLD };
