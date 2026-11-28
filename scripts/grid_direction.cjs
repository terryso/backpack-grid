'use strict';
// grid_direction.cjs — 手动方向指令：用户指定新格的挂单方向，管线其余逻辑
// （评分/建区/预算/门控/确认）全部不变。语义（validate 探针实测）：
//   Neutral = 双向（现状，下方买单+上方卖单）
//   Long    = 只在现价下方挂买单——跌下来单边接多
//   Short   = 只在现价上方挂卖单——反弹时单边压空
// 分链快照存在时，只有有效、未过期且生态映射明确的市场才允许新建。
// 快照尚未接入时保留单市场 > 全局 > Neutral 的旧协议。
// CLI:
//   node scripts/grid_direction.cjs set '*' Short       # 无分链快照时的全局回退
//   node scripts/grid_direction.cjs set ETH-PERP Long  # 无分链快照时的单市场覆盖
//   node scripts/grid_direction.cjs clear '*'          # 清全局指令（回到 Neutral）
//   node scripts/grid_direction.cjs show [ETH-PERP]     # 展示快照与指定市场的实际方向
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
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function validChainSnapshot(snapshot) {
  const chains = snapshot?.chains;
  const at = typeof snapshot?.asOf === 'string' ? Date.parse(snapshot.asOf) : NaN;
  return typeof snapshot?.id === 'string' && !!snapshot.id
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(snapshot?.asOf || '')
    && Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === snapshot.asOf.slice(0, 19)
    && chains && typeof chains === 'object' && !Array.isArray(chains)
    && Object.keys(chains).length === CHAIN_NAMES.size
    && [...CHAIN_NAMES].every(chain => {
      const entry = chains[chain];
      return entry && typeof entry === 'object' && typeof entry.judgment === 'string'
        && Object.hasOwn(JUDGMENTS, entry.judgment) && JUDGMENTS[entry.judgment] === entry.direction;
    });
}

function readRegistry(root, accountKey) {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(path.join(root, "state/direction_override.json"), "utf8")); }
  catch (error) { return { reg:null, invalid:error.code !== 'ENOENT' }; }
  if (!reg || reg.schemaVersion !== 1 || reg.accountKey !== accountKey || !reg.directions ||
      Array.isArray(reg.directions) || typeof reg.directions !== "object") return { reg:null, invalid:true };
  return { reg, invalid:false };
}

function loadRegistry(root, accountKey) {
  return readRegistry(root, accountKey).reg;
}

function loadDirections(root, accountKey) {
  const reg = loadRegistry(root, accountKey);
  if (!reg) return {};
  const out = {};
  for (const [mkt, d] of Object.entries(reg.directions)) if (VALID.has(d)) out[mkt] = d;
  return out;
}

// Never infer an ecosystem from an incomplete, malformed or ambiguous config.
// Extra ecosystems may exist for concentration limits, but cannot supply a chain.
function ecosystemChains(cfg) {
  const ecosystems = cfg?.ecosystems;
  if (!ecosystems || typeof ecosystems !== 'object' || Array.isArray(ecosystems)) return null;
  const seen = new Set(), mapping = new Map();
  for (const [eco, list] of Object.entries(ecosystems)) {
    if (!Array.isArray(list) || !list.length) return null;
    for (const value of list) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9]+$/.test(value)) return null;
      const base = value.toUpperCase();
      if (seen.has(base)) return null;
      seen.add(base);
      if (Object.hasOwn(ECO_CHAIN, eco)) mapping.set(base, ECO_CHAIN[eco]);
    }
  }
  for (const [eco, chain] of Object.entries(ECO_CHAIN)) {
    if (!Array.isArray(ecosystems[eco]) || !ecosystems[eco].some(value => value.toUpperCase() === chain)) return null;
  }
  return mapping;
}

function snapshotGuard(root, reg, cfg, now) {
  if (reg && Object.hasOwn(reg, 'chainAuthority') && reg.chainAuthority !== true) {
    return { active:true, blocked:true, reason:'invalid-direction-state' };
  }
  // An accepted newer event that is waiting for clock recovery must not
  // silently fall back to the previous snapshot or a legacy global override.
  if (reg?.lastCloudEvent?.status === 'deferred') return { active:true, blocked:true, reason:'pending-snapshot' };
  if (reg?.chainAuthority === true && !Object.hasOwn(reg, 'chainSnapshot')) return { active:true, blocked:true, reason:'missing-snapshot' };
  if (!reg || !Object.hasOwn(reg, 'chainSnapshot')) return { active:false, blocked:false, reason:null };
  const snapshot = reg.chainSnapshot;
  if (!validChainSnapshot(snapshot)) return { active:true, blocked:true, reason:'invalid-snapshot' };
  const age = now - Date.parse(snapshot.asOf);
  if (!Number.isFinite(age) || age < -MAX_CLOCK_SKEW_MS) return { active:true, blocked:true, reason:'future-snapshot', asOf:snapshot.asOf };
  if (age > MAX_SNAPSHOT_AGE_MS) return { active:true, blocked:true, reason:'expired-snapshot', asOf:snapshot.asOf };
  if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { cfg = {}; } }
  const mapping = ecosystemChains(cfg);
  if (!mapping) return { active:true, blocked:true, reason:'invalid-ecosystems', asOf:snapshot.asOf };
  return { active:true, blocked:false, reason:null, asOf:snapshot.asOf, mapping };
}

// Decision includes a hard veto so stale/unmapped inputs cannot create even if
// requireDirection is disabled. It never affects existing-grid exit rules.
function directionDecision(root, accountKey, market, cfg, now = Date.now()) {
  const { reg, invalid } = readRegistry(root, accountKey);
  if (invalid) return { direction:'Neutral', source:'unavailable', blocked:true, reason:'invalid-direction-state' };
  const guard = snapshotGuard(root, reg, cfg, now);
  if (guard.active) {
    if (guard.blocked) return { direction:'Neutral', source:'chain', blocked:true, reason:guard.reason };
    const base = String(market).replace(/-PERP$|_USDC_PERP$/, '').toUpperCase();
    const chain = CHAIN_NAMES.has(base) ? base : guard.mapping.get(base);
    if (!chain) return { direction:'Neutral', source:'chain', blocked:true, reason:'unmapped-market' };
    return { direction:reg.chainSnapshot.chains[chain].direction, source:'chain', blocked:false, reason:null, chain };
  }
  const d = reg?.directions || {};
  return { direction:VALID.has(d[market]) ? d[market] : VALID.has(d["*"]) ? d["*"] : "Neutral",
    source:'legacy', blocked:false, reason:null };
}

function directionHealth(root, accountKey, cfg, now = Date.now()) {
  const { reg, invalid } = readRegistry(root, accountKey);
  if (invalid) return { active:true, blocked:true, reason:'invalid-direction-state' };
  const { mapping, ...health } = snapshotGuard(root, reg, cfg, now);
  return health;
}

function directionFor(root, accountKey, market, cfg, now = Date.now()) {
  return directionDecision(root, accountKey, market, cfg, now).direction;
}

function setDirection(root, accountKey, market, direction, now = Date.now()) {
  if (!market || !VALID.has(direction)) throw Error('invalid direction or market');
  directionTransaction(root, { op: 'manual', accountKey, market, direction, at: new Date(now).toISOString() });
  const effective = directionDecision(root, accountKey, market);
  if (effective.source !== 'legacy') {
    const health = directionHealth(root, accountKey);
    const current = market === '*' ? (health.blocked ? `new grids blocked (${health.reason}); global override inactive` : 'global override inactive')
      : effective.blocked ? `new grids blocked (${effective.reason})` : `effective ${effective.direction} from ${effective.chain} snapshot`;
    const stored = direction === 'Neutral' ? 'override cleared' : `stored as ${direction}`;
    console.log(`direction ${market} ${stored}; ${current}; ${effective.source === 'chain' ? 'snapshot takes precedence' : 'direction state unavailable'}`);
  } else console.log(`direction ${market} -> ${direction === 'Neutral' ? 'Neutral (default)' : direction}`);
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

module.exports = { loadDirections, directionFor, directionDecision, directionHealth, setDirection, directionTransaction, directionSnapshot, VALID };

if (require.main === module) {
  const [cmd, target, dir] = process.argv.slice(2);
  const root = process.env.BG_ROOT || path.join(__dirname, "..");
  const { expectedIdentity } = require("./contracts.cjs");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  const identity = expectedIdentity(root, cfg);
  const key = identity.accountKey;
  if (cmd === "set" && target && dir) setDirection(root, key, target, dir);
  else if (cmd === "clear") setDirection(root, key, target || "*", "Neutral");
  else if (cmd === "show") {
    const d = loadDirections(root, key);
    const reg = loadRegistry(root, key);
    const health = directionHealth(root, key, cfg);
    const detail = target ? directionDecision(root, key, target, cfg) : null;
    console.log(JSON.stringify({ "*": d["*"] || "Neutral", markets: Object.fromEntries(Object.entries(d).filter(([k]) => k !== "*")),
      authority: health.reason === 'invalid-direction-state' ? 'unavailable' : health.active ? 'chain_snapshot' : 'legacy', snapshotHealth:health,
      chainSnapshot:reg?.chainSnapshot || null, ...(target ? { market:target, effective:detail } : {}) }, null, 1));
  }
  else { console.log("usage: grid_direction.cjs set <market|*> <Long|Short|Neutral> | clear [<market|*>] | show [market]"); process.exitCode = 2; }
}
