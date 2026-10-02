#!/usr/bin/env node
// decide.cjs — pure-node decision step. Reads state/observed.json + config.json,
// checks risk budget, backstop reconciliation, TP/SL/range-exit/liquidation rules,
// plans stop+protect+create actions. NEVER executes anything: writes state/actions.json.
// Ordering invariant: account-risk decisions (breaker, pending stops, protection repair)
// run BEFORE market-data-dependent logic, and a tickers failure only blocks NEW risk.
const fs = require("node:fs");
const path = require("node:path");
const { getTickers } = require("./api.cjs");

const ROOT = process.env.BG_ROOT || path.join(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const cfg = read("config.json");
const obs = read("state/observed.json");
if (obs.error) { console.log("OBSERVE_ERROR: " + obs.error); process.exit(1); }
{
  const obsAgeMin = (Date.now() - new Date(obs.at).getTime()) / 60000;
  if (!isFinite(obsAgeMin) || obsAgeMin > 10) {
    console.error(`STALE OBSERVATION: snapshot at ${obs.at} is ${Number(obsAgeMin).toFixed(1)} min old — refusing to plan`);
    process.exit(1);
  }
}
const PHASE2 = process.env.BG_PHASE === "creates"; // phase 2 evaluates replacement creates only

const num = (s) => (s == null ? NaN : Number(String(s).replace(/[$,%\s,]/g, "")));
const writeAtomic = (p, data) => {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
};

(async () => {
  const actions = [];
  const lines = [];
  const grids = obs.gridRows || [];
  // orphan positions (no grid configured) block new risk but never block pending
  // verification or cleanup — they are a warning + veto, not an observe failure
  const orphanPositions = (obs.positions || []).filter((p) => !grids.some((g) => g.market === p.market));
  const apiSym = (m) => m.replace("-PERP", "") + "_USDC_PERP"; // MON-PERP -> MON_USDC_PERP
  // canonical perp base name, used everywhere ecosystems/counts are compared
  const perpBase = (m) => String(m).replace("-PERP", "").replace("_USDC_PERP", "");

  // ---------- pending stops: persisted cleanup state (survives restarts/timeouts) ----------
  // Entries are removed ONLY by act.stopGrid after verified cleanup (grid gone + position
  // flat). decide never clears them on its own: a vanished grid still gets a stop action
  // so act can confirm no residue before the ledger entry is released.
  const pendPath = path.join(ROOT, "state", "pending_stops.json");
  let pending = {};
  let pendCorrupt = false;
  try {
    const parsedPending = JSON.parse(fs.readFileSync(pendPath, "utf8"));
    // shared structure rule with act.loadPending ("invalid pending ledger structure" is the
    // shared canary): non-null plain object, non-array,
    // every value a non-null plain object (an array ledger silently drops entries on save)
    const structOk = parsedPending !== null && typeof parsedPending === "object" && !Array.isArray(parsedPending)
      && Object.values(parsedPending).every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    if (structOk) pending = parsedPending;
    else pendCorrupt = true;
  } catch (e) {
    if (fs.existsSync(pendPath)) { pendCorrupt = true; pending = {}; }
  }
  if (pendCorrupt) lines.push("PENDING LEDGER INVALID: parse or structure failed — treated as corrupt; new-risk blocked (act archives it on its next stop)");

  // ---------- risk budget: peak equity, warning line, hard breaker (BEFORE tickers) ----------
  const riskPath = path.join(ROOT, "state", "risk.json");
  let risk = null;
  let riskCorrupt = false;
  if (fs.existsSync(riskPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(riskPath, "utf8"));
      // strict type checks BEFORE numeric coercion: Number(null)/Number(true)/Number("")
      // all coerce to plausible numbers and must not pass
      const pk = parsed.peakEquity;
      const pkTypeOk = typeof pk === "number" || (typeof pk === "string" && pk.trim() !== "");
      const pkNum = pkTypeOk ? Number(pk) : NaN;
      const structOk = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && pkTypeOk && Number.isFinite(pkNum) && pkNum >= 0
        && (parsed.paused === null || parsed.paused === undefined || typeof parsed.paused === "object");
      if (structOk) {
        risk = { peakEquity: pkNum, paused: parsed.paused === undefined ? null : parsed.paused };
        if (parsed.lastEquity !== undefined) risk.lastEquity = parsed.lastEquity;
        if (parsed.lastAt !== undefined) risk.lastAt = parsed.lastAt;
      } else {
        riskCorrupt = true; // valid JSON, invalid shape — never overwrite, never reseed
      }
    } catch { riskCorrupt = true; risk = null; }
  }
  if (!risk && !riskCorrupt) risk = { peakEquity: 0, paused: null }; // first-time init only (no file)
  const eq = num(obs.margin.totalEquity);
  if (risk && isFinite(eq) && eq > 0) {
    if (!risk.peakEquity || eq > risk.peakEquity) risk.peakEquity = eq;
    risk.lastEquity = eq;
    risk.lastAt = obs.at;
  }
  const effPeak = risk ? Number(risk.peakEquity) : 0;
  const ddPct = effPeak ? ((effPeak - eq) / effPeak) * 100 : 0;
  let breaker = null; // null | "warn" | "trip" | "paused"
  if (risk && risk.paused) breaker = "paused";
  else if (risk && isFinite(ddPct) && ddPct >= cfg.riskBudgetPct) {
    risk.paused = { at: obs.at, reason: `drawdown ${ddPct.toFixed(1)}% >= budget ${cfg.riskBudgetPct}%`, peakEquity: risk.peakEquity, equity: eq };
    breaker = "trip";
  } else if (risk && isFinite(ddPct) && ddPct >= cfg.warnDrawdownPct) breaker = "warn";
  // persist only when the file was readable/valid; a CORRUPT file is never
  // overwritten — it is kept for manual recovery and blocks new risk until fixed
  if (!riskCorrupt && risk) writeAtomic(riskPath, JSON.stringify(risk, null, 2));
  if (riskCorrupt) {
    breaker = breaker || "warn";
    lines.push(`RISK STATE CORRUPT: state/risk.json unparseable or invalid shape — kept for manual recovery; NO new grids until fixed`);
  }
  if (riskCorrupt) {
    breaker = breaker || "warn";
    lines.push(`RISK STATE CORRUPT: state/risk.json unparseable — kept for manual recovery; NO new grids until fixed`);
  }
  if (breaker === "trip") lines.push(`RISK BREAKER TRIPPED: drawdown ${ddPct.toFixed(1)}% >= ${cfg.riskBudgetPct}% — stopping ALL grids; rotations paused until manual reset`);
  else if (breaker === "paused") lines.push(`RISK PAUSED (latched ${risk.paused.at}) — no new grids; restore state/risk.json (keep peakEquity) and clear paused to resume`);
  else if (breaker === "warn") lines.push(`RISK WARNING: drawdown ${ddPct.toFixed(1)}% >= ${cfg.warnDrawdownPct}% — no new grids until recovery`);

  // ---------- circuit breaker: stop everything, INCLUDING Disabled grids with residue ----------
  if (breaker === "trip" || breaker === "paused") {
    for (const g of grids) {
      if (!actions.some((a) => a.act === "stop" && a.market === g.market)) {
        actions.push({ act: "stop", market: g.market, range: g.range, reason: "circuit breaker: account drawdown beyond budget" });
      }
    }
  }

  // ---------- pending stop retries: highest priority actions, no tickers needed ----------
  for (const [mkt, p] of Object.entries(pending)) {
    const g = grids.find((x) => x.market === mkt);
    if (!g) {
      // grid absent from config — act must confirm no residue before the entry is released
      actions.push({ act: "stop", market: mkt, reason: `pending stop verify (${p.at}): grid absent from config — confirm flat, then clear ledger` });
      lines.push(`PENDING STOP verify planned for ${mkt} (grid absent from config)`);
      continue;
    }
    const pos = (obs.positions || []).find((pp) => pp.market === mkt);
    const hasResidue = pos && Math.abs(num(pos.size)) > 0;
    actions.push({ act: "stop", market: mkt, range: g.range, reason: `pending stop retry (${p.reason})${hasResidue ? " — residue position present" : ""}` });
    lines.push(`PENDING STOP retry planned for ${mkt} (queued ${p.at})`);
  }

  // ---------- market data (degradable): only range/price logic depends on it ----------
  let tmap = null;
  let tickersOk = true;
  // BG_OFFLINE=1    : skip market data entirely (file-level effects stay testable, air-gapped debug)
  // BG_TICKERS_FILE : deterministic ticker JSON — replaces the network call (regression tests)
  const offline = process.env.BG_OFFLINE === "1";
  const tickersFile = process.env.BG_TICKERS_FILE;
  try {
    if (offline) {
      tickersOk = false;
      lines.push("TICKERS OFFLINE (BG_OFFLINE=1) — price-based rules skipped this round; pnl/risk rules still active");
    } else {
      const tickers = tickersFile ? JSON.parse(fs.readFileSync(tickersFile, "utf8")) : await getTickers();
      tmap = new Map(tickers.map((t) => [t.symbol, t]));
    }
  } catch (e) {
    tickersOk = false;
    lines.push(`TICKERS UNAVAILABLE (${String(e.message).slice(0, 60)}) — price-based rules skipped this round; pnl/risk rules still active`);
  }
  const priceOf = (mkt) => {
    if (!tmap) return NaN;
    const t = tmap.get(apiSym(mkt));
    return t ? Number(t.lastPrice) : NaN;
  };
  const fundingOf = (mkt) => {
    const p = (obs.positions || []).find((pp) => pp.market === mkt);
    return p ? (Number(p.fundingRaw) || 0) : 0;
  };

  // ---------- backstop reconciliation: enabled/disabled grids must carry native protection ----------
  const wantTP = Number(cfg.takeProfitPct), wantSL = Number(cfg.stopLossPct);
  for (const g of grids) {
    if (pending[g.market]) continue; // will be deleted anyway
    const bad = g.nativeTP === null || g.nativeSL === null
      || Number(g.nativeTP) !== wantTP || Number(g.nativeSL) !== wantSL
      || g.nativeCloseOnStop !== true;
    if (bad) {
      actions.push({ act: "protect", market: g.market, tp: wantTP, sl: wantSL, closeOnStop: true,
        reason: `backstop missing/mismatch (TP=${g.nativeTP} SL=${g.nativeSL} close=${g.nativeCloseOnStop})` });
      lines.push(`PROTECT ${g.market}: restoring native TP=${wantTP} SL=${wantSL} closeOnStop=true`);
    }
  }

  // ---------- per-grid rules ----------
  for (const g of grids) { // 阶段标签只控制是否规划新增仓位，风控复评两阶段都做
    if (pending[g.market]) continue; // handled by pending-stop retry above
    const [lo, hi] = g.range.map(Number);
    const price = priceOf(g.market);
    const allocRaw = Number(g.allocationRaw || 0);
    const effPct = allocRaw ? ((Number(g.pnlRaw || 0) + fundingOf(g.market)) / allocRaw) * 100 : g.pnlPct;
    let reason = null;
    if (g.status === "Disabled") {
      // Disabled with pnl beyond thresholds = exchange backstop fired -> rotate.
      // Disabled with pnl inside thresholds = manual pause by the user -> leave untouched
      // (pending-stop retries above are the only path that touches those).
      if (isFinite(effPct) && (effPct >= cfg.takeProfitPct || effPct <= -cfg.stopLossPct)) {
        reason = `backstop fired (pnl ${effPct.toFixed(2)}%) — rotate`;
      } else {
        lines.push(`GRID ${g.market} DISABLED but pnl ${Number(effPct).toFixed(2)}% within thresholds — likely manual pause, leaving untouched`);
      }
    } else if (isFinite(effPct) && effPct >= cfg.takeProfitPct) reason = `TP: pnl ${effPct.toFixed(2)}% (funding-adj) >= ${cfg.takeProfitPct}%`;
    else if (isFinite(effPct) && effPct <= -cfg.stopLossPct) reason = `SL: pnl ${effPct.toFixed(2)}% (funding-adj) <= -${cfg.stopLossPct}%`;
    else if (tickersOk && isFinite(price) && isFinite(lo) && isFinite(hi)) {
      if (price < lo * (1 - cfg.exitBufferPct / 100)) reason = `OUT_OF_RANGE: price ${price} < low ${lo} - ${cfg.exitBufferPct}%`;
      else if (price > hi * (1 + cfg.exitBufferPct / 100)) reason = `OUT_OF_RANGE: price ${price} > high ${hi} + ${cfg.exitBufferPct}%`;
    }
    // liquidation danger (position-level safety net) — position data survives ticker outage
    const pos = (obs.positions || []).find((p) => p.market === g.market);
    if (!reason && pos) {
      const mark = num(pos.mark), liq = num(pos.liq);
      if (isFinite(mark) && isFinite(liq) && mark > 0) {
        const dist = Math.abs(mark - liq) / mark * 100;
        if (dist < cfg.liqDangerPct) reason = `LIQ_DANGER: mark ${mark} is ${dist.toFixed(1)}% from liq ${liq}`;
      }
    }
    lines.push(`GRID ${g.market} ${g.direction} ${g.range.join("~")} pnl=${g.pnlPct}% value=${g.value}${reason ? "  -> " + reason : "  ok"}`);
    if (reason) {
      // stop supersedes protect: the grid is about to be deleted, repairing its backstops
      // beforehand is pointless and must not delay the risk exit
      for (let i = actions.length - 1; i >= 0; i--) {
        if (actions[i].act === "protect" && actions[i].market === g.market) actions.splice(i, 1);
      }
      if (!actions.some((a) => a.market === g.market && a.act === "stop")) {
        actions.push({ act: "stop", market: g.market, range: g.range, reason });
      }
    }
  }

  // ---------- plan replacements for freed slots ----------
  const stops = actions.filter((a) => a.act === "stop").map((a) => a.market);
  const remaining = grids.filter((g) => !stops.includes(g.market) && g.status !== "Disabled").map((g) => g.market);
  const slots = cfg.maxGrids - remaining.length;
  const ecoOf = (perpName) => {
    const base = perpBase(perpName);
    for (const [eco, list] of Object.entries(cfg.ecosystems || {})) if (list.includes(base)) return eco;
    return base; // unknown symbols cluster by themselves
  };
  // analysis cache (used by replacement planning and paper directional tracking)
  const anaPath = path.join(ROOT, "state", "analysis.json");
  let ana = null;
  let anaAgeMin = Infinity;
  try {
    ana = JSON.parse(fs.readFileSync(anaPath, "utf8"));
    anaAgeMin = (Date.now() - new Date(ana.generatedAt).getTime()) / 60000;
    if (anaAgeMin > cfg.analysisMaxAgeMin) ana = null;
  } catch {}
  // whether new grids are allowed at all: breaker states, corrupt risk file, ticker outage,
  // or a queued pending stop (cleanup before new risk) all veto creation
  const corruptFlagExists = fs.existsSync(path.join(ROOT, "state", "pending_corrupt.json"));
  if (orphanPositions.length) lines.push(`ORPHAN POSITIONS (no grid): ${orphanPositions.map((p) => p.market).join(", ")} — new-risk blocked; pending verification still runs`);
  const mayCreate = breaker === null && !riskCorrupt && !pendCorrupt && !corruptFlagExists && tickersOk
    && Object.keys(pending).length === 0 && orphanPositions.length === 0;
  // phase semantics: risk exits must never wait for market analysis. When stops are
  // planned, defer creation to phase 2 (run_round re-observes, then BG_PHASE=creates);
  // when nothing needs to stop, plan creations inline. Phase 2 only creates.
  if (!PHASE2 && stops.length > 0 && mayCreate && slots > 0) {
    fs.writeFileSync(path.join(ROOT, "state", "needs_create_plan"), String(Date.now()));
    lines.push(`CREATE PLANNING DEFERRED to phase 2 (${stops.length} risk exit(s) execute first)`);
  }
  const planCreatesNow = mayCreate && slots > 0 && (PHASE2 ? stops.length === 0 : true);
  if (PHASE2 && stops.length > 0) {
    // phase 2 复评发现新的风险退出 → 立即执行，补仓再次顺延（下一轮 phase 1 无退出时内联规划）
    fs.writeFileSync(path.join(ROOT, "state", "needs_create_plan"), String(Date.now()));
    lines.push(`PHASE 2 defer: ${stops.length} risk exit(s) planned — creation deferred to next round`);
  }
  if (planCreatesNow) {
    // remaining risk budget for grid-configured stop-loss amounts (forward-looking):
    // sum over kept grids of allocation*SL% + exit-cost buffer, all within equity*budget
    const eqN = isFinite(eq) ? eq : 0;
    let usedRisk = 0;
    for (const m of remaining) {
      const g = grids.find((x) => x.market === m);
      if (g) {
        // budget premise: use the grid's ACTUAL stored native SL when it is looser than
        // config (protect reconciliation not yet confirmed) — conservative, never optimistic
        const effSl = Math.max(Number(g.nativeSL) || 0, wantSL);
        usedRisk += Number(g.allocationRaw || 0) * (effSl / 100);
      }
    }
    const exitCostBuffer = Number(cfg.exitCostBufferUsd || 15);
    const budget = eqN * (cfg.riskBudgetPct / 100) - exitCostBuffer;
    if (!ana) {
      console.log("analysis stale/missing -> recomputing ...");
      try {
        const { execFileSync } = require("node:child_process");
        const ex = [...remaining, ...stops].map((m) => apiSym(m));
        execFileSync("node", [path.join(ROOT, "scripts", "analyze.cjs")], {
          env: { ...process.env, EXCLUDE: ex.join(",") }, stdio: "inherit", timeout: 300000,
        });
        ana = JSON.parse(fs.readFileSync(anaPath, "utf8"));
        anaAgeMin = 0;
      } catch (e) {
        // analysis failure must never discard already-planned stops — only creation is cancelled
        ana = null;
        lines.push(`ANALYZE_FAILED (${String(e.message).slice(0, 80)}) — stops/protects still execute; replacement creation cancelled this round`);
      }
    }
    let created = 0;
    let plannedRisk = 0;
    let plannedMargin = 0;
    const ecoCount = {};
    for (const m of remaining) ecoCount[ecoOf(m)] = (ecoCount[ecoOf(m)] || 0) + 1;
    if (ana) for (const cand of ana.top) {
      if (created >= slots) break;
      const mkt = cand.symbol.replace("_USDC_PERP", "-PERP");
      if (remaining.includes(mkt) || stops.includes(mkt)) continue;
      // quality gate: sorted desc by score — first failing candidate means the rest are worse
      if (cand.score < cfg.minScore) { lines.push(`PLAN stop: best remaining score ${cand.score} < min ${cfg.minScore} — slot stays empty`); break; }
      // ecosystem concentration cap (counts include kept grids, same canonical names)
      const eco = ecoOf(cand.symbol);
      if ((ecoCount[eco] || 0) >= (cfg.maxPerEcosystem || 2)) { lines.push(`PLAN skip ${mkt}: ecosystem "${eco}" already at cap ${cfg.maxPerEcosystem}`); continue; }
      // account-level forward-risk invariant: kept risk + this grid's SL amount + buffer <= budget
      // Full size first; if it doesn't fit the remaining risk budget, SHRINK to the
      // largest 50-multiple that does (>=500) instead of abandoning the slot —
      // a smaller compliant grid beats an empty one.
      let value = Number(cfg.gridValueUsd);
      const budgetRoom = budget - usedRisk - plannedRisk;
      const maxByRisk = Math.floor(budgetRoom / (wantSL / 100) / 50) * 50;
      if (maxByRisk < value) {
        if (maxByRisk < 500) {
          lines.push(`PLAN stop: risk budget exhausted (used ${usedRisk.toFixed(0)} + planned ${plannedRisk.toFixed(0)}; room ${budgetRoom.toFixed(0)} fits < 500 min grid) — slot stays empty`);
          break;
        }
        value = maxByRisk;
        lines.push(`PLAN shrink: full ${cfg.gridValueUsd} exceeds remaining risk budget — creating ${value} instead`);
      }
      const estMargin = value / cfg.leverageCap;
      const numAvail = num(obs.margin.availableEquity);
      // cumulative reservation: N planned grids must not all size against the same balance
      if (numAvail - plannedMargin - estMargin < 20) value = Math.floor((numAvail - plannedMargin - 20) * cfg.leverageCap / 50) * 50;
      if (value < 500) { lines.push(`SKIP create ${mkt}: available equity ${(numAvail - plannedMargin).toFixed(0)} too low`); break; }
      plannedMargin += value / cfg.leverageCap;
      plannedRisk += value * (wantSL / 100);
      actions.push({
        act: "create", market: mkt, urlSymbol: cand.symbol.replace("_USDC_PERP", "_USD_PERP"),
        lower: cand.grid.lower, upper: cand.grid.upper, count: cand.grid.count, value,
        why: `score=${cand.score} chop=${cand.chop} r24=${cand.range24}% qvol=$${Math.round(cand.qvol24 / 1000)}k`,
      });
      remaining.push(mkt);
      ecoCount[eco] = (ecoCount[eco] || 0) + 1;
      created++;
      lines.push(`PLAN create ${mkt} ${cand.grid.lower}~${cand.grid.upper} x${cand.grid.count} $${value} (score=${cand.score} chop=${cand.chop} qvol=$${Math.round(cand.qvol24 / 1000)}k; risk ${usedRisk.toFixed(0)}+${(value * wantSL / 100).toFixed(0)}/${budget.toFixed(0)})`);
    }
  } else if (slots > 0 && stops.length > 0 && !mayCreate) {
    lines.push(`PLAN hold: new grids blocked (breaker=${breaker || "off"}, riskCorrupt=${riskCorrupt}, tickersOk=${tickersOk}, pendingStops=${Object.keys(pending).length}) — freed slots stay empty this round`);
  }

  // ---------- campaign volume tracking (Mystery Box campaign 1011: 2026-09-30 -> 2026-10-06, tier1 at 50k) ----------
  const CAMP = { start: "2026-09-30T00:00:00Z", end: "2026-10-06T23:59:59Z", tier1: 50000 };
  let camp = { last: {}, campaignVolume: 0 };
  const campPath = path.join(ROOT, "state", "campaign.json");
  try { camp = JSON.parse(fs.readFileSync(campPath, "utf8")); } catch {}
  if (new Date(obs.at) >= new Date(CAMP.start) && new Date(obs.at) <= new Date(CAMP.end)) {
    let delta = 0;
    for (const l of obs.ledger || []) {
      const prev = camp.last[l.symbol];
      if (prev === undefined) { camp.last[l.symbol] = l.vol; continue; }
      if (l.vol >= prev) delta += l.vol - prev; // ledger reset (grid rebuild) -> re-baseline, count future growth
      camp.last[l.symbol] = l.vol;
    }
    camp.campaignVolume += delta;
    writeAtomic(campPath, JSON.stringify(camp, null, 2));
    const pct = (camp.campaignVolume / CAMP.tier1 * 100).toFixed(1);
    lines.push(`CAMPAIGN volume ${camp.campaignVolume.toFixed(0)} / ${CAMP.tier1} USD (${pct}%) ${camp.campaignVolume >= CAMP.tier1 ? "TIER1 SECURED" : "to tier1"}`);
  } else {
    lines.push(`CAMPAIGN inactive (window ${CAMP.start} ~ ${CAMP.end})`);
  }

  // ---------- equity curve: one JSONL line per round ----------
  try {
    const rec = {
      at: obs.at,
      equity: num(obs.margin.totalEquity),
      available: num(obs.margin.availableEquity),
      ledgerPnl: +grids.reduce((s, g) => s + (Number(g.pnlRaw) || 0), 0).toFixed(2),
      floatingPnl: num(obs.margin.openPnl),
      funding: +(obs.positions || []).reduce((s, p) => s + (Number(p.fundingRaw) || 0), 0).toFixed(2),
      campaignVolume: Math.round(camp.campaignVolume || 0),
      drawdownPct: +ddPct.toFixed(2),
    };
    fs.appendFileSync(path.join(ROOT, "state", "equity_curve.jsonl"), JSON.stringify(rec) + "\n");
  } catch (e) { lines.push("equity curve append failed: " + e.message); }

  // ---------- paper directional tracking (NO real orders) ----------
  try {
    const paperPath = path.join(ROOT, "state", "directional_paper.json");
    let paper = { open: [], closed: [] };
    try { paper = JSON.parse(fs.readFileSync(paperPath, "utf8")); } catch {}
    const priceOfSym = (sym) => {
      const t = tmap ? tmap.get(sym) : null;
      const n = t ? Number(t.lastPrice) : NaN; // tmap holds ticker OBJECTS — extract the number
      return isFinite(n) ? n : NaN;
    };
    // mark legacy records polluted by the object-as-price bug (pre-fix entries)
    for (const p of [...paper.open, ...paper.closed]) {
      if (!isFinite(Number(p.entry))) p.invalid = true;
    }
    for (const p of paper.open) {
      if (p.invalid) continue;
      const px = priceOfSym(p.symbol);
      if (!isFinite(px)) continue;
      p.lastPrice = px;
      p.pnlPct = ((px - p.entry) / p.entry) * 100 * (p.dir === "long" ? 1 : -1);
      if (p.pnlPct <= -3 || Date.now() - new Date(p.at).getTime() > 24 * 3600e3) {
        p.closedAt = new Date().toISOString();
        p.reason = p.pnlPct <= -3 ? "adverse 3%" : "24h elapsed";
        paper.closed.push(p);
      }
    }
    // quarantine legacy-invalid opens: keep the record but free the slot/dedup
    const invalidOpen = paper.open.filter((p) => p.invalid);
    if (invalidOpen.length) {
      for (const p of invalidOpen) {
        p.closedAt = p.closedAt || new Date().toISOString();
        p.reason = p.reason || "quarantined: legacy invalid record (pre-fix object entry)";
        paper.closed.push(p);
      }
      paper.open = paper.open.filter((p) => !p.invalid);
      lines.push(`DIR-PAPER quarantined ${invalidOpen.length} legacy-invalid position(s)`);
    }
    paper.open = paper.open.filter((p) => !p.closedAt);
    if (ana && anaAgeMin < 35 && tmap && paper.open.length < 2) {
      for (const c of ana.directional || []) {
        if (paper.open.some((p) => p.symbol === c.symbol)) continue;
        const entry = priceOfSym(c.symbol);
        if (!isFinite(entry)) continue;
        paper.open.push({ symbol: c.symbol, dir: c.dir, entry, at: new Date().toISOString() });
        lines.push(`DIR-PAPER open ${c.dir} ${c.symbol} @ ${entry} (drift24 ${c.drift24}%) — paper only, no real order`);
        if (paper.open.length >= 2) break;
      }
    }
    const closedValid = paper.closed.filter((p) => !p.invalid);
    const closedPnl = closedValid.reduce((s, p) => s + (p.pnlPct || 0), 0);
    lines.push(`DIR-PAPER open=[${paper.open.filter((p) => !p.invalid).map((p) => `${p.dir}:${p.symbol}:${(p.pnlPct || 0).toFixed(2)}%`).join(", ") || "-"}] closedTotal=${closedPnl.toFixed(2)}% (n=${closedValid.length}${paper.closed.some((p) => p.invalid) ? ", legacy-invalid excluded" : ""})`);
    writeAtomic(paperPath, JSON.stringify(paper, null, 2));
  } catch (e) { lines.push("DIR-PAPER tracking error: " + e.message); }

  // ---------- persist pending stops for the stop actions we just planned ----------
  for (const a of actions.filter((x) => x.act === "stop")) {
    if (a.reason && a.reason.startsWith("circuit breaker")) {
      // breaker stops are latched via risk.json; the act step will persist pending entries
    }
  }
  writeAtomic(path.join(ROOT, "state", "actions.json"), JSON.stringify(actions, null, 2));
  // append log
  const logLine = `[${obs.at}] grids=${grids.length} pnl=${grids.map((g) => `${g.market}:${g.pnlPct}%`).join(" ")} actions=${actions.length ? actions.map((a) => a.act + ":" + (a.market || "")).join(",") : "none"}\n`;
  fs.appendFileSync(path.join(ROOT, "state", "log.md"), logLine);
  console.log(lines.join("\n"));
  console.log(actions.length ? `ACTIONS: ${actions.length}` : "ACTIONS: none");
})().catch((e) => { console.error("DECIDE FAILED:", e.message); process.exit(1); });
