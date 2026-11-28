'use strict';
// grid_direction.cjs — 手动方向指令：用户指定新格的挂单方向，管线其余逻辑
// （评分/建区/预算/门控/确认）全部不变。语义（validate 探针实测）：
//   Neutral = 双向（现状，下方买单+上方卖单）
//   Long    = 只在现价下方挂买单——跌下来单边接多
//   Short   = 只在现价上方挂卖单——反弹时单边压空
// 优先级：已应用的分链快照 > 单市场指令 > 全局指令(*) > 默认 Neutral。
// 快照按 config.json ecosystems 继承，不需要写入方枚举所有市场。
// CLI:
//   node scripts/grid_direction.cjs set '*' Short       # 无分链快照时的全局回退
//   node scripts/grid_direction.cjs set ETH-PERP Long  # 无分链快照时的单市场覆盖
//   node scripts/grid_direction.cjs clear '*'          # 清全局指令（回到 Neutral）
//   node scripts/grid_direction.cjs show
const fs = require("node:fs");
const path = require("node:path");
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const VALID = new Set(["Long", "Short", "Neutral"]);
const ECO_CHAIN = { btc: 'BTC', eth_l1: 'ETH', solana: 'SOL', sui: 'SUI',
  bnb: 'BNB', hyperliquid: 'HYPE', tron: 'TRX' };
const CHAIN_NAMES = new Set(Object.values(ECO_CHAIN));
const JUDGMENTS = { '偏多':'Long', '偏空':'Short', '中性':'Neutral', '中性偏空':'Short', '中性偏多':'Long',
  Long:'Long', Short:'Short', Neutral:'Neutral' };

function validChainSnapshot(snapshot) {
  const chains = snapshot?.chains;
  return typeof snapshot?.id === 'string' && !!snapshot.id && typeof snapshot?.asOf === 'string'
    && Number.isFinite(Date.parse(snapshot.asOf)) && chains && typeof chains === 'object' && !Array.isArray(chains)
    && Object.keys(chains).length === CHAIN_NAMES.size
    && [...CHAIN_NAMES].every(chain => {
      const entry = chains[chain];
      return entry && typeof entry === 'object' && typeof entry.judgment === 'string'
        && Object.hasOwn(JUDGMENTS, entry.judgment) && JUDGMENTS[entry.judgment] === entry.direction;
    });
}

function loadRegistry(root, accountKey) {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(path.join(root, "state/direction_override.json"), "utf8")); } catch {}
  if (!reg || reg.schemaVersion !== 1 || reg.accountKey !== accountKey || !reg.directions ||
      Array.isArray(reg.directions) || typeof reg.directions !== "object") return null;
  return reg;
}

function loadDirections(root, accountKey) {
  const reg = loadRegistry(root, accountKey);
  if (!reg) return {};
  const out = {};
  for (const [mkt, d] of Object.entries(reg.directions)) if (VALID.has(d)) out[mkt] = d;
  return out;
}

// act/decide 的唯一取值入口；指令只影响「新格」，存量网格不受影响。
function directionFor(root, accountKey, market, cfg) {
  const reg = loadRegistry(root, accountKey);
  if (reg && Object.hasOwn(reg, 'chainSnapshot')) {
    if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { cfg = {}; } }
    const base = String(market).replace(/-PERP$|_USDC_PERP$/, '').toUpperCase();
    let chain = CHAIN_NAMES.has(base) ? base : null;
    if (!chain) {
      for (const [eco, list] of Object.entries(cfg.ecosystems || {})) {
        if (Object.hasOwn(ECO_CHAIN, eco) && Array.isArray(list) && list.some(symbol => String(symbol).toUpperCase() === base)) {
          chain = ECO_CHAIN[eco]; break;
        }
      }
    }
    // A malformed/incomplete applied snapshot fails closed for known chains.
    if (chain) {
      return validChainSnapshot(reg.chainSnapshot) ? reg.chainSnapshot.chains[chain].direction : 'Neutral';
    }
  }
  const d = reg?.directions || {};
  return VALID.has(d[market]) ? d[market] : VALID.has(d["*"]) ? d["*"] : "Neutral";
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
  if (reg && Object.hasOwn(reg, 'chainSnapshot') && !validChainSnapshot(reg.chainSnapshot)) throw Error('invalid chain direction snapshot');
  return { directive: direction, version: crypto.createHash('sha256').update(accountKey).update(Buffer.from([0])).update(raw || Buffer.from('<missing>')).digest('hex'),
    lastCloudEvent: reg?.lastCloudEvent || null, chainSnapshot: reg?.chainSnapshot || null };
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
