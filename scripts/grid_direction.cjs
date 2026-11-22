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
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
  if (!market || !VALID.has(direction)) throw Error('invalid direction or market');
  directionTransaction(root, { op: 'manual', accountKey, market, direction, at: new Date(now).toISOString() });
  console.log(`direction ${market} -> ${direction === 'Neutral' ? 'Neutral (default)' : direction}`);
  return loadDirections(root, accountKey);
}

function directionTransaction(root, request) {
  const python = process.env.PY_BIN || '/Users/nick/.browser-use-env/bin/python3';
  if (!python || !path.isAbsolute(python)) throw Error('absolute PY_BIN required');
  const r = spawnSync(python, [path.join(__dirname, 'direction_state.py')], {
    env: { ...process.env, BG_ROOT: root }, input: JSON.stringify(request), encoding: 'utf8', timeout: 5000,
  });
  if (r.status !== 0) throw Error('direction transaction failed: ' + String(r.stderr || r.error || '').slice(-300));
  return JSON.parse(r.stdout);
}

function directionSnapshot(root, accountKey) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, 'state/direction_override.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; raw = null; }
  let reg = null;
  if (raw) { reg = JSON.parse(raw); if (!reg || reg.schemaVersion !== 1 || reg.accountKey !== accountKey || !reg.directions || Array.isArray(reg.directions) || typeof reg.directions !== 'object') throw Error('direction state invalid'); }
  const direction = reg && Object.prototype.hasOwnProperty.call(reg.directions, '*') ? reg.directions['*'] : 'Neutral';
  if (!VALID.has(direction)) throw Error('invalid global direction');
  return { directive: direction, version: crypto.createHash('sha256').update(accountKey).update(Buffer.from([0])).update(raw || Buffer.from('<missing>')).digest('hex'), lastCloudEvent: reg?.lastCloudEvent || null };
}

module.exports = { loadDirections, directionFor, setDirection, directionTransaction, directionSnapshot, VALID };

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
