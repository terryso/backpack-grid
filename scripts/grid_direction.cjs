'use strict';
// grid_direction.cjs — 手动方向指令：用户指定新格的挂单方向，管线其余逻辑
// （评分/建区/预算/门控/确认）全部不变。语义（validate 探针实测）：
//   Neutral = 双向（现状，下方买单+上方卖单）
//   Long    = 只在现价下方挂买单——跌下来单边接多
//   Short   = 只在现价上方挂卖单——反弹时单边压空
// 优先级：单市场指令 > 全局指令(*) > 默认 Neutral。身份绑定：只认本账户的表；
// 读侧任何失败（缺失/损坏/外账户）一律退回 Neutral（指令是观点输入，不是安全依赖）。
// CLI:
//   node scripts/grid_direction.cjs set '*' Short      # 全局新格一律做空头格
//   node scripts/grid_direction.cjs set ETH-PERP Long  # 单市场覆盖
//   node scripts/grid_direction.cjs clear '*'          # 清全局指令（回到 Neutral）
//   node scripts/grid_direction.cjs show
const fs = require("node:fs");
const path = require("node:path");
const VALID = new Set(["Long", "Short", "Neutral"]);

function loadDirections(root, accountKey) {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(path.join(root, "state/direction_override.json"), "utf8")); } catch {}
  if (!reg || reg.schemaVersion !== 1 || reg.accountKey !== accountKey || !reg.directions || typeof reg.directions !== "object") return {};
  const out = {};
  for (const [mkt, d] of Object.entries(reg.directions)) if (VALID.has(d)) out[mkt] = d;
  return out;
}

// act/decide 的唯一取值入口；指令只影响「新格」，存量网格不受影响。
function directionFor(root, accountKey, market) {
  const d = loadDirections(root, accountKey);
  return d[market] || d["*"] || "Neutral";
}

function setDirection(root, accountKey, market, direction, now = Date.now()) {
  if (!market) throw Error("market or '*' required");
  const file = path.join(root, "state/direction_override.json");
  let directions = {};
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    if (old && old.schemaVersion === 1 && old.accountKey === accountKey && old.directions && typeof old.directions === "object") directions = old.directions;
  } catch {} // 损坏/外账户旧表直接放弃继承，本次原子写覆盖
  if (direction === "Neutral") delete directions[market];
  else {
    if (!VALID.has(direction)) throw Error(`invalid direction: ${direction} (Long|Short|Neutral)`);
    directions[market] = direction;
  }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, accountKey, directions, updatedAt: new Date(now).toISOString() }, null, 2));
  fs.renameSync(tmp, file);
  console.log(`direction ${market} -> ${direction === "Neutral" ? "Neutral (default)" : direction}`);
  return directions;
}

module.exports = { loadDirections, directionFor, setDirection, VALID };

if (require.main === module) {
  const [cmd, target, dir] = process.argv.slice(2);
  const root = process.env.BG_ROOT || path.join(__dirname, "..");
  const { expectedIdentity } = require("./contracts.cjs");
  const identity = expectedIdentity(root, JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")));
  const key = identity.accountKey;
  if (cmd === "set" && target && dir) setDirection(root, key, target, dir);
  else if (cmd === "clear") setDirection(root, key, target || "*", "Neutral");
  else if (cmd === "show") {
    const d = loadDirections(root, key);
    console.log(JSON.stringify({ "*": d["*"] || "Neutral", markets: Object.fromEntries(Object.entries(d).filter(([k]) => k !== "*")) }, null, 1));
  }
  else { console.log("usage: grid_direction.cjs set <market|*> <Long|Short|Neutral> | clear [<market|*>] | show"); process.exitCode = 2; }
}
