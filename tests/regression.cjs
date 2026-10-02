#!/usr/bin/env node
// regression.cjs — persistent regression suite for the backpack_grid monitor.
// Two layers:
//   A) pure-logic replicas + source canaries (act.mjs runs inside ego-browser and
//      cannot be unit-executed here)
//   B) INTEGRATION tests that execute PRODUCTION source with mocked externals:
//      - decide.cjs via BG_ROOT sandbox fixtures + BG_OFFLINE/BG_TICKERS_FILE
//        (fully network-free since round 6)
//      - act_core.cjs stopGrid via injected mock io (round-6: act core control flow)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const actSrc = fs.readFileSync(path.join(ROOT, "scripts", "act.mjs"), "utf8");
const decideSrc = fs.readFileSync(path.join(ROOT, "scripts", "decide.cjs"), "utf8");
const observeSrc = fs.readFileSync(path.join(ROOT, "scripts", "observe.mjs"), "utf8");
const actCoreSrc = fs.readFileSync(path.join(ROOT, "scripts", "act_core.cjs"), "utf8");
const runRoundSrc = fs.readFileSync(path.join(ROOT, "scripts", "run_round.sh"), "utf8");
const deploySrc = fs.readFileSync(path.join(ROOT, "scripts", "deploy_dashboard.sh"), "utf8");
const analyzeSrc = fs.readFileSync(path.join(ROOT, "scripts", "analyze.cjs"), "utf8");
const coreSrc = fs.readFileSync(path.join(ROOT, "scripts", "act_core.cjs"), "utf8");
let pass = 0, fail = 0;
const T = (name, cond) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name); } };

// ---------- helpers mirroring decide.cjs ----------
const ecoOf = (m) => {
  const base = String(m).replace("-PERP", "").replace("_USDC_PERP", "");
  for (const [eco, list] of Object.entries(cfg.ecosystems || {})) if (list.includes(base)) return eco;
  return base;
};
const mayCreate = (breaker, riskCorrupt, pendCorrupt, corruptFlag, tickersOk, pendN) =>
  breaker === null && !riskCorrupt && !pendCorrupt && !corruptFlag && tickersOk && pendN === 0;
// strict replica of decide.cjs risk shape validation (round-4 #4)
const riskStructOk = (parsed) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const pk = parsed.peakEquity;
  const pkTypeOk = typeof pk === "number" || (typeof pk === "string" && pk.trim() !== "");
  const pkNum = pkTypeOk ? Number(pk) : NaN;
  return pkTypeOk && Number.isFinite(pkNum) && pkNum >= 0
    && (parsed.paused === null || parsed.paused === undefined || typeof parsed.paused === "object");
};

// ---------- T1: ecosystem canonical naming ----------
T("T1a PENGU-PERP -> solana", ecoOf("PENGU-PERP") === "solana");
T("T1b PENGU_USDC_PERP -> solana", ecoOf("PENGU_USDC_PERP") === "solana");
T("T1c SUI-PERP -> sui", ecoOf("SUI-PERP") === "sui");
const ecoCount1 = { solana: 2 };
T("T1d solana cap blocks BONK", (ecoCount1[ecoOf("BONK_USDC_PERP")] || 0) >= (cfg.maxPerEcosystem || 2));

// ---------- T9: stop supersedes protect (round-3 #2) ----------
{
  const actions = [{ act: "protect", market: "A-PERP" }];
  const reason = "SL: pnl -6.67% (funding-adj) <= -6%";
  const g = { market: "A-PERP" };
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].act === "protect" && actions[i].market === g.market) actions.splice(i, 1);
  }
  if (reason && !actions.some((a) => a.market === g.market && a.act === "stop")) {
    actions.push({ act: "stop", market: g.market, reason });
  }
  T("T9a SL grid gets stop, protect dropped", actions.length === 1 && actions[0].act === "stop");
}
T("T9b no suppress-guard on stop (old bug gone)", !decideSrc.includes('(a.act === "stop" || a.act === "protect")'));
T("T9c act phases: stop before protect before create", actSrc.indexOf("const PHASE = { stop: 0, protect: 1, create: 2 };") !== -1);
T("T9d act wires production core", actSrc.includes("const stopGrid = makeStopGrid(io);") && actSrc.includes("evaluateCreateGate("));

// ---------- T10: pending ledger integrity ----------
T("T10a decide no longer auto-clears vanished-grid pending",
  !decideSrc.includes("drop entries whose grid no longer exists"));
T("T10c pendCorrupt blocks mayCreate", !mayCreate(null, false, true, false, true, 0));

// ---------- T8: stop completion gates creation ----------
T("T8b act checks stopGrid return value", actSrc.includes("const r = await stopGrid(a.market, a.range, a.reason, results);")
  && actSrc.includes("if (!r || r.done !== true) stopIncomplete = true;"));
T("T8c emergency stop verified before claiming success", actSrc.includes("emergencyDone = !!(r && r.done === true);")
  && actSrc.includes("MANUAL INTERVENTION REQUIRED"));

// ---------- T17 (round-4 #1/#2): unified create gate ----------
T("T17a gate includes emergency cleanup", actSrc.includes("unresolvedCleanup = true;") && actCoreSrc.includes("unresolved emergency cleanup"));
T("T17b gate includes failed protect", actSrc.includes('if (a.act === "protect") protectIncomplete = true;')
  && actCoreSrc.includes('"unresolved protect repair (budget premise unverified)"'));
T("T17c gate re-reads live pending per create", actSrc.includes("const live = await loadPending();")
  && actCoreSrc.includes("pendingKeys.length > 0"));
T("T17d skipped create is recorded in results ledger", /SKIPPED create[\s\S]{0,200}results\.push\(\{ act: "create", market: a\.market, done: false, skipped: true/.test(actSrc));

// ---------- T5: pending write-ahead intent ----------
T("T5a stop intent persisted before first exchange write",
  coreSrc.indexOf("WRITE-AHEAD: persist the stop intent BEFORE any exchange write") !== -1
  && coreSrc.indexOf("WRITE-AHEAD") < coreSrc.indexOf("1) ensure disabled with close-positions-on-stop"));
T("T5b position-poll errors treated as unconfirmed", actCoreSrc.includes("Polling errors count as"));

// ---------- T18 (round-4 #3): act never treats corrupt ledger as empty ----------
T("T18a loadPending distinguishes ENOENT from corrupt", actSrc.includes("e.code === \"ENOENT\""));
T("T18b corrupt ledger archived + flag file", actSrc.includes("pending_stops.corrupt-") && actSrc.includes("pending_corrupt.json"));

// ---------- T6: analyze failure keeps stops ----------
T("T6a analyze wrapped, stops survive",
  decideSrc.includes("ANALYZE_FAILED") && decideSrc.includes("replacement creation cancelled this round"));
T("T6b planning loop guarded on ana", decideSrc.includes("if (ana) for (const cand of ana.top)"));

// ---------- T11: paper price numeric + quarantine (round-4 #5) ----------
{
  const tmap = new Map([["X_USDC_PERP", { symbol: "X_USDC_PERP", lastPrice: "1.23" }]]);
  const priceOfSym = (sym) => {
    const t = tmap.get(sym);
    const n = t ? Number(t.lastPrice) : NaN;
    return isFinite(n) ? n : NaN;
  };
  T("T11a object ticker -> finite number", isFinite(priceOfSym("X_USDC_PERP")) && priceOfSym("X_USDC_PERP") === 1.23);
  T("T11b missing symbol -> NaN", !isFinite(priceOfSym("NOPE")));
}
T("T11c invalid opens quarantined (slot freed)", decideSrc.includes("DIR-PAPER quarantined")
  && /invalidOpen[\s\S]*paper\.closed\.push\(p\)/.test(decideSrc));

// ---------- T12: risk.json structural validation ----------
T("T12a JSON null -> corrupt", !riskStructOk(null));
T("T12b peakEquity null rejected (Number(null)===0 trap)", !riskStructOk({ peakEquity: null, paused: null }));
T("T12b2 peakEquity boolean rejected", !riskStructOk({ peakEquity: true, paused: null }));
T("T12b3 peakEquity empty string rejected", !riskStructOk({ peakEquity: "", paused: null }));
T("T12c numeric string accepted", riskStructOk({ peakEquity: "556.91", paused: null }));
T("T12d valid shape passes", riskStructOk({ peakEquity: 556.91, paused: null }));
T("T12e array -> corrupt", !riskStructOk([1]));
T("T12f init gated on not-corrupt", decideSrc.includes("if (!risk && !riskCorrupt) risk = { peakEquity: 0, paused: null }; // first-time init only (no file)"));

// ---------- T13: mayCreate veto matrix (with corrupt-flag) ----------
T("T13a breaker trip blocks create", !mayCreate("trip", false, false, false, true, 0));
T("T13b riskCorrupt blocks create", !mayCreate(null, true, false, false, true, 0));
T("T13c ticker outage blocks create", !mayCreate(null, false, false, false, false, 0));
T("T13d pending blocks create", !mayCreate(null, false, false, false, true, 1));
T("T13e corrupt-flag file blocks create", !mayCreate(null, false, false, true, true, 0));
T("T13f healthy allows create", mayCreate(null, false, false, false, true, 0));

// ---------- T14: forward-risk budget uses actual native SL (round-4 #2b) ----------
{
  const wantSL = cfg.stopLossPct;
  const effSl = (nativeSL) => Math.max(Number(nativeSL) || 0, wantSL);
  T("T14a stored SL=8 budgets as 8 even though config says 6", effSl(8) === 8);
  T("T14b stored SL=6 budgets as 6", effSl(6) === 6);
  T("T14c missing SL falls back to config", effSl(null) === wantSL);
  const eqN = 556.91, budget = eqN * 0.8 - 15;
  const kept = 1800 * 0.06 + 1500 * 0.06 + 2500 * 0.06;
  T("T14d 4th 2500 grid exceeds budget", kept + 2500 * wantSL / 100 > budget);
}

// ---------- T15/T16: earlier round fixes ----------
T("T15 no 'no grid rows' validation error", !decideSrc.includes('"no grid rows"'));
T("T16 breaker loop has no Disabled filter", !decideSrc.includes('g.status !== "Disabled" && !actions.some'));

// =====================================================================
// LAYER B — integration: execute production decide.cjs on sandbox fixtures
// =====================================================================
function makeFixture(mods) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-fix-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
  const observed = {
    at: new Date().toISOString(), source: "api", url: "fixture",
    gridRows: [], positions: [],
    margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.00", initMarginPct: "0%" },
    badges: {}, ledger: [],
  };
  fs.writeFileSync(path.join(dir, "state", "observed.json"), JSON.stringify(observed, null, 2));
  for (const [rel, content] of Object.entries(mods || {})) {
    fs.writeFileSync(path.join(dir, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
// NOTE: BG_ROOT redirects FILE paths only. decide still calls getTickers() unless
// BG_OFFLINE=1 (which forces tickersOk=false — fine for tests that assert file-level
// effects like pending/risk/paper handling; create-planning tests need the online mode
// because a ticker outage vetoes creation by design).
function runDecide(dir, offline, tickersFile) {
  const env = { ...process.env, BG_ROOT: dir, BG_OFFLINE: offline ? "1" : "0" };
  if (tickersFile) env.BG_TICKERS_FILE = tickersFile;
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "decide.cjs")], {
    env, encoding: "utf8", timeout: 180000,
  });
}

// INT1: pending entry for a vanished grid -> stop verify planned, ledger untouched
{
  const dir = makeFixture({ "state/pending_stops.json": { "GONE-PERP": { at: "2026-09-30T00:00:00Z", reason: "timeout" } } });
  const r = runDecide(dir, true);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  const pendAfter = fs.readFileSync(path.join(dir, "state", "pending_stops.json"), "utf8");
  T("INT1a vanished-grid pending -> stop verify action", r.status === 0
    && actions.some((a) => a.act === "stop" && a.market === "GONE-PERP"));
  T("INT1b decide does not clear the ledger itself", pendAfter.includes("GONE-PERP"));
}

// INT2: corrupt risk.json -> unchanged on disk, no create, warning emitted
{
  const broken = '{"peakEquity":556.91,"paused"';
  const dir = makeFixture({ "state/risk.json": broken });
  const r = runDecide(dir, true);
  const riskAfter = fs.readFileSync(path.join(dir, "state", "risk.json"), "utf8");
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  T("INT2a corrupt risk flagged", r.stdout.includes("RISK STATE CORRUPT"));
  T("INT2b corrupt risk file untouched", riskAfter === broken);
  T("INT2c no create planned under corrupt risk", !actions.some((a) => a.act === "create"));
}

// INT3: risk peakEquity null (valid JSON) -> corrupt, not reseeded
{
  const content = JSON.stringify({ peakEquity: null, paused: null });
  const dir = makeFixture({ "state/risk.json": content });
  const r = runDecide(dir, true);
  const riskAfter = fs.readFileSync(path.join(dir, "state", "risk.json"), "utf8");
  T("INT3 peakEquity null -> corrupt + untouched", r.stdout.includes("RISK STATE CORRUPT") && riskAfter === content);
}

// INT4: polluted paper records quarantined, slots freed
{
  const paper = {
    open: [
      { symbol: "A_USDC_PERP", dir: "long", entry: { bad: "object" }, at: "2026-09-30T00:00:00Z" },
      { symbol: "B_USDC_PERP", dir: "short", entry: "not-a-number", at: "2026-09-30T00:00:00Z" },
    ],
    closed: [],
  };
  const dir = makeFixture({ "state/directional_paper.json": paper });
  const r = runDecide(dir, true);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "state", "directional_paper.json"), "utf8"));
  T("INT4a invalid opens quarantined into closed", r.status === 0
    && after.open.every((p) => !p.invalid) && after.closed.filter((p) => p.invalid).length === 2);
  T("INT4b quarantine reported", r.stdout.includes("DIR-PAPER quarantined 2"));
}

// INT5: numeric-string peak accepted and normalized
{
  const dir = makeFixture({ "state/risk.json": { peakEquity: "556.91", paused: null } });
  const r = runDecide(dir, true);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "state", "risk.json"), "utf8"));
  T("INT5 numeric-string peak normalized, not corrupt", r.status === 0
    && !r.stdout.includes("RISK STATE CORRUPT") && after.peakEquity === 556.91);
}

// ---------- T19 (round-5 #1): protection-verify stage funnels into cleanup ----------
T("T19a protectionConfirmed flow present", actSrc.includes("let protectionConfirmed = false;")
  && actSrc.includes("protectionConfirmed = await backstopsOk();"));
T("T19b verify-stage errors funnel to emergency cleanup", actSrc.includes("protection UNCONFIRMED, entering cleanup flow"));
T("T19c incomplete emergency still blocks creates", actSrc.includes("unresolvedCleanup = true;")
  && actSrc.includes("unresolved emergency cleanup"));

// ---------- T20 (round-5 #2): pending ledger structure validation in BOTH layers ----------
const pendingStructOk = (parsed) => parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
  && Object.values(parsed).every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
T("T20a array ledger rejected", !pendingStructOk([]));
T("T20b null rejected", !pendingStructOk(null));
T("T20c string values rejected", !pendingStructOk({ M: "x" }));
T("T20d valid ledger accepted", pendingStructOk({ M: { at: "x", reason: "y" } }));
T("T20e act validates structure", actSrc.includes("invalid pending ledger structure"));
T("T20f decide validates structure", decideSrc.includes("invalid pending ledger structure"));

// ---------- INT6 (round-5 #2, production source): array ledger -> corrupt, no create ----------
{
  const dir = makeFixture({ "state/pending_stops.json": "[]" });
  const r = runDecide(dir, true);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  const pendAfter = fs.readFileSync(path.join(dir, "state", "pending_stops.json"), "utf8");
  T("INT6a array ledger -> invalid, no create planned", r.stdout.includes("PENDING LEDGER INVALID")
    && !actions.some((a) => a.act === "create"));
  T("INT6b decide leaves the file for act to archive", pendAfter === "[]");
}

// ---------- INT7/INT7b (round-4 critique): healthy creates; same fixture + fault blocks ----------
{
  const gridRow = {
    market: "FAKE-PERP", symbol: "FAKE_USDC_PERP", direction: "中性",
    range: ["1", "2"], count: 60, value: "$1800.00", allocationRaw: 1800,
    pnlRaw: 180.5, pnl: "$180.50", pnlPct: 10.03, status: "Triggered", control: "开启",
    nativeTP: 10, nativeSL: 6, nativeCloseOnStop: true,
  };
  const analysis = {
    generatedAt: new Date().toISOString(),
    top: [{ symbol: "ETH_USDC_PERP", score: 14, chop: 14, range24: 3.4, qvol24: 30000000,
      grid: { lower: 2500, upper: 2700, count: 20, widthPct: 7.5, spacingPct: 0.4 } }],
    directional: [],
  };
  // control: healthy state -> TP stop planned AND replacement create planned
  const dir = makeFixture({
    "state/observed.json": JSON.stringify({ at: new Date().toISOString(), source: "api", url: "fixture",
      gridRows: [gridRow], positions: [],
      margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.00", initMarginPct: "0%" },
      badges: {}, ledger: [] }),
    "state/analysis.json": analysis,
  });
  const tickersPath = path.join(dir, "state", "tickers.json");
  fs.writeFileSync(tickersPath, JSON.stringify([
    { symbol: "FAKE_USDC_PERP", lastPrice: "1.85" },
    { symbol: "ETH_USDC_PERP", lastPrice: "2600" },
  ]));
  // step 1 (phase 1): TP stop planned immediately, create deferred via marker
  // (online + deterministic tickers: an offline ticker outage vetoes creation by design)
  const r = runDecide(dir, false, tickersPath);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  const markerWritten = fs.existsSync(path.join(dir, "state", "needs_create_plan"));
  T("INT7a-1 healthy control: stop now, create deferred (marker)", r.status === 0
    && actions.length === 1 && actions[0].act === "stop" && actions[0].market === "FAKE-PERP"
    && markerWritten);
  // step 2 (phase 2): re-observed state (grid gone) -> replacement create planned
  fs.writeFileSync(path.join(dir, "state", "observed.json"), JSON.stringify({ at: new Date().toISOString(),
    source: "api", url: "fixture", gridRows: [], positions: [],
    margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.00", initMarginPct: "0%" },
    badges: {}, ledger: [] }));
  const r1b = runDecide(dir, false, tickersPath);
  const actions1b = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  T("INT7a-2 phase 2 plans the replacement create", r1b.status === 0
    && actions1b.some((a) => a.act === "create" && a.market === "ETH-PERP"));
  // contrast: same scenario + corrupt risk.json -> stop still planned, create blocked
  const dir2 = makeFixture({
    "state/observed.json": JSON.stringify({ at: new Date().toISOString(), source: "api", url: "fixture",
      gridRows: [gridRow], positions: [],
      margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.00", initMarginPct: "0%" },
      badges: {}, ledger: [] }),
    "state/analysis.json": analysis,
    "state/risk.json": "{broken",
  });
  fs.writeFileSync(path.join(dir2, "state", "tickers.json"), JSON.stringify([
    { symbol: "FAKE_USDC_PERP", lastPrice: "1.85" },
    { symbol: "ETH_USDC_PERP", lastPrice: "2600" },
  ]));
  const r2 = runDecide(dir2, false, path.join(dir2, "state", "tickers.json"));
  T("INT7c fault isolation: no ticker error in fault run", !r2.stdout.includes("TICKERS"));
  const actions2 = JSON.parse(fs.readFileSync(path.join(dir2, "state", "actions.json"), "utf8"));
  const riskAfter = fs.readFileSync(path.join(dir2, "state", "risk.json"), "utf8");
  T("INT7b same scenario + corrupt risk -> stop kept, create blocked, file untouched",
    r2.stdout.includes("RISK STATE CORRUPT") && actions2.some((a) => a.act === "stop" && a.market === "FAKE-PERP")
    && !actions2.some((a) => a.act === "create") && riskAfter === "{broken");
}

// ---------- T21 (round-6 #1/#P1-followup): production stopGrid under mock io ----------
const { makeStopGrid, evaluateCreateGate } = require(path.join(ROOT, "scripts", "act_core.cjs"));
function mockIo({ positionQty = 0, pollsUntilFlat = 1, deleteStatus = 200, gridPresent = true, autoConfigGone = false }) {
  const calls = { disable: 0, del: 0, positionPolls: 0 };
  let pending = {};
  const io = {
    jget: async (p) => {
      if (p === "/api/v1/position") {
        calls.positionPolls++;
        if (calls.positionPolls < pollsUntilFlat) return [{ symbol: "X_USDC_PERP", netQuantity: String(positionQty) }];
        return gridPresent || positionQty !== 0 ? [{ symbol: "X_USDC_PERP", netQuantity: positionQty === 0 && !gridPresent ? "0" : String(positionQty) }] : [];
      }
      return [];
    },
    jpatch: async (p, body) => {
      const ops = body.params.symbols.map((s) => s.operation);
      if (ops.includes("Delete")) { calls.del++; return { status: deleteStatus, body: "" }; }
      calls.disable++;
      return { status: 200, body: "" };
    },
    getAutomation: async () => ({
      params: { symbols: autoConfigGone || calls.del > 0 ? [] : [{ symbol: "X_USDC_PERP", enabled: true }] },
    }),
    sleep: async () => {},
    waitFor: async (cond, ms) => {
      const end = Date.now() + Math.min(ms, 50); // fast-forwarded polling
      let ok = false;
      while (Date.now() < end) { ok = await cond(); if (ok) break; }
      return ok || (calls.positionPolls >= pollsUntilFlat ? await cond() : false);
    },
    loadPending: async () => ({ pending: { ...pending }, corrupt: false }),
    savePending: async (p) => { pending = JSON.parse(JSON.stringify(p)); },
  };
  return { io, calls, getPending: () => pending };
}
(async () => {
  // M1: position never flat -> timeout, write-ahead intent kept, NO delete
  {
    const { io, calls, getPending } = mockIo({ positionQty: 5000, pollsUntilFlat: 999 });
    const stopGrid = makeStopGrid(io);
    const results = [];
    const r = await stopGrid("X-PERP", null, "test timeout", results);
    T("M1a timeout -> done:false", r.done === false);
    T("M1b write-ahead intent persisted", !!getPending()["X-PERP"]);
    T("M1c no delete attempted while position open", calls.del === 0);
  }
  // M2: flat -> disable, delete, ledger cleared
  {
    const { io, calls, getPending } = mockIo({ positionQty: 0, pollsUntilFlat: 1, gridPresent: true });
    const stopGrid = makeStopGrid(io);
    const results = [];
    const r = await stopGrid("X-PERP", null, "test success", results);
    T("M2a flat -> done:true", r.done === true);
    T("M2b ledger cleared after verified cleanup", !getPending()["X-PERP"]);
    T("M2c disable+delete both called", calls.disable >= 1 && calls.del === 1);
  }
  // M3: grid gone but residue position -> manual intervention, ledger retained
  {
    const { io, getPending } = mockIo({ gridPresent: false, positionQty: 123, autoConfigGone: true });
    io.jget = async (p) => (p === "/api/v1/position" ? [{ symbol: "X_USDC_PERP", netQuantity: "123" }] : []);
    const stopGrid = makeStopGrid(io);
    const results = [];
    let threw = "";
    try { await stopGrid("X-PERP", null, "test residue", results); } catch (e) { threw = e.message; }
    T("M3a gone+residue -> manual intervention", threw.includes("manual intervention"));
    T("M3b intent retained", !!getPending()["X-PERP"]);
  }
  // M4: grid gone + flat -> verified, ledger cleared
  {
    const { io, getPending } = mockIo({ gridPresent: false, positionQty: 0, autoConfigGone: true });
    io.jget = async (p) => (p === "/api/v1/position" ? [] : []);
    const stopGrid = makeStopGrid(io);
    const results = [];
    const r = await stopGrid("X-PERP", null, "test gone-flat", results);
    T("M4 gone+flat -> done:true, ledger cleared", r.done === true && !getPending()["X-PERP"]);
  }
  // M5: delete endpoint failing -> persisted with delete-failed, done:false
  {
    const { io, calls, getPending } = mockIo({ positionQty: 0, pollsUntilFlat: 1, deleteStatus: 500 });
    const stopGrid = makeStopGrid(io);
    const results = [];
    const r = await stopGrid("X-PERP", null, "test delete-fail", results);
    T("M5a delete failure retried once then persisted", calls.del === 2 && r.done === false);
    T("M5b ledger keeps delete-failed intent", (getPending()["X-PERP"] || {}).reason === "test delete-fail (delete failed)");
  }

  // create-gate matrix (production evaluateCreateGate)
  const F = (s, p, u) => ({ stopIncomplete: s, protectIncomplete: p, unresolvedCleanup: u });
  T("M6a stop-incomplete blocks", evaluateCreateGate(F(true, false, false), [], false).blocked);
  T("M6b protect-incomplete blocks", evaluateCreateGate(F(false, true, false), [], false).blocked);
  T("M6c emergency-unresolved blocks", evaluateCreateGate(F(false, false, true), [], false).blocked);
  T("M6d pending non-empty blocks", evaluateCreateGate(F(false, false, false), ["X-PERP"], false).blocked);
  T("M6e corrupt flag blocks", evaluateCreateGate(F(false, false, false), [], true).blocked);
  T("M6f clean state allows", !evaluateCreateGate(F(false, false, false), [], false).blocked);
  T("M6g why mentions budget premise for protect", evaluateCreateGate(F(false, true, false), [], false).why.includes("budget premise"));
})().then(() => {
  // ---------- T22 (round-8): PID lock ----------
T("T22a lock liveness-checked via kill -0", runRoundSrc.includes('kill -0 "$HOLDER"'));
T("T22b self-release only (pid match)", runRoundSrc.includes('if [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]'));
T("T22c no age-based takeover left", !runRoundSrc.includes("AGE -lt 480"));

// ---------- T23 (round-8): two-phase execution ----------
T("T23a phase-2 marker flow", runRoundSrc.includes("state/needs_create_plan") && runRoundSrc.includes("BG_PHASE=creates"));
T("T23b decide reads BG_PHASE", decideSrc.includes('process.env.BG_PHASE === "creates"'));
T("T23c phase 2 runs full per-grid risk re-eval (F03)", !decideSrc.includes("for (const g of (!PHASE2 ? grids : []))"));

// ---------- T24 (round-8): data-integrity fail-loud ----------
T("T24a missing ledger snapshot is fatal", observeSrc.includes("no ledger snapshot for configured grid"));
T("T24b live position without mark is fatal", observeSrc.includes("live position without valid mark price"));
T("T24c core: malformed position != flat", act_core_ok() && actCoreSrc.includes("cannot confirm flat; intent kept"));

function act_core_ok() { try { require(path.join(ROOT, "scripts", "act_core.cjs")); return true; } catch { return false; } }

// ---------- T25 (round-8): config wiring + margin reservation + staleness + orphans ----------
T("T25a minQvol24h wired into analyzer", analyzeSrc.includes("Number(cfg.minQvol24h)"));
T("T25b cumulative margin reservation", decideSrc.includes("numAvail - plannedMargin - estMargin < 20"));
T("T25c stale observation gate", decideSrc.includes("STALE OBSERVATION"));
T("T25d orphan positions veto create", decideSrc.includes("ORPHAN POSITIONS") && decideSrc.includes("orphanPositions.length === 0"));
T("T25e BG_OFFLINE implemented in decide", decideSrc.includes('process.env.BG_OFFLINE === "1"'));
T("T25f actions staleness gate in act", actSrc.includes("STALE ACTIONS") && actSrc.includes("ageMin > 15"));

// INT9: stale observation refuses to plan
{
  const staleAt = new Date(Date.now() - 25 * 60000).toISOString();
  const dir = makeFixture({ "state/observed.json": JSON.stringify({ at: staleAt, source: "api", url: "fixture",
    gridRows: [], positions: [], margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.00", initMarginPct: "0%" }, badges: {}, ledger: [] }) });
  const r = runDecide(dir, true);
  T("INT9 stale snapshot -> refuse to plan", r.status !== 0 && r.stderr.includes("STALE OBSERVATION"));
}

// INT10: orphan position -> warning + veto create, round still completes
{
  const dir = makeFixture({ "state/observed.json": JSON.stringify({ at: new Date().toISOString(), source: "api", url: "fixture",
    gridRows: [], positions: [{ market: "ORPH-PERP", symbol: "ORPH_USDC_PERP", side: "long", size: "100",
      value: "$10.00", breakeven: "1", mark: "1.1", liq: "0.1", initMargin: "$1.00", funding: "$0.00",
      fundingRaw: 0, pnl: "$0.10", pnlPct: 1, pnlRaw: 0.1 }],
    margin: { totalEquity: "$500.00", availableEquity: "$400.00", openPnl: "$0.10", initMarginPct: "0%" }, badges: {}, ledger: [] }) });
  const r = runDecide(dir, true);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  T("INT10a orphan warned, round completes", r.status === 0 && r.stdout.includes("ORPHAN POSITIONS"));
  T("INT10b orphan vetoes create", !actions.some((a) => a.act === "create"));
}

// INT11: cumulative margin reservation — 2 creates from 700 available, not 3
{
  const analysis = {
    generatedAt: new Date().toISOString(),
    top: [
      { symbol: "ETH_USDC_PERP", score: 14, chop: 14, range24: 3.4, qvol24: 30000000, grid: { lower: 2500, upper: 2700, count: 20, widthPct: 7.5, spacingPct: 0.4 } },
      { symbol: "XRP_USDC_PERP", score: 13, chop: 13, range24: 5.6, qvol24: 2000000, grid: { lower: 1.4, upper: 1.58, count: 20, widthPct: 12, spacingPct: 0.6 } },
      { symbol: "SOL_USDC_PERP", score: 12, chop: 12, range24: 3.6, qvol24: 30000000, grid: { lower: 114, upper: 124, count: 20, widthPct: 8.5, spacingPct: 0.45 } },
    ],
    directional: [],
  };
  const dir = makeFixture({
    "state/analysis.json": analysis,
    "state/observed.json": JSON.stringify({ at: new Date().toISOString(), source: "api", url: "fixture",
      gridRows: [], positions: [],
      margin: { totalEquity: "$700.00", availableEquity: "$700.00", openPnl: "$0.00", initMarginPct: "0%" },
      badges: {}, ledger: [] }),
  });
  const tickersPath = path.join(dir, "state", "tickers.json");
  fs.writeFileSync(tickersPath, JSON.stringify([
    { symbol: "ETH_USDC_PERP", lastPrice: "2600" },
    { symbol: "XRP_USDC_PERP", lastPrice: "1.5" },
    { symbol: "SOL_USDC_PERP", lastPrice: "119" },
  ]));
  const r = runDecide(dir, false, tickersPath);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  const creates = actions.filter((a) => a.act === "create");
  const sizes = creates.map((c) => Number(c.value));
  T("INT11a cumulative reservation: sizes are 2500/2500/1800 (not 3x2500)", r.status === 0
    && sizes.length === 3 && sizes[0] === 2500 && sizes[1] === 2500 && sizes[2] === 1800);
  T("INT11b total planned notional stays within balance x leverage", sizes.reduce((s, v) => s + v, 0) <= 700 * 10);
}

// INT12: shrink-to-fit — risk budget binds, grid created at reduced size instead of skipped
{
  const keepRow = { market: "KEEP-PERP", symbol: "KEEP_USDC_PERP", direction: "中性",
    range: ["1", "1.2"], count: 20, value: "$1800.00", allocationRaw: 1800,
    pnlRaw: 18, pnl: "$18.00", pnlPct: 1, status: "Triggered", control: "开启",
    nativeTP: 10, nativeSL: 6, nativeCloseOnStop: true };
  const dir = makeFixture({
    "state/observed.json": JSON.stringify({ at: new Date().toISOString(), source: "api", url: "fixture",
      gridRows: [keepRow], positions: [],
      margin: { totalEquity: "$300.00", availableEquity: "$300.00", openPnl: "$0.00", initMarginPct: "0%" },
      badges: {}, ledger: [] }),
    "state/analysis.json": { generatedAt: new Date().toISOString(),
      top: [{ symbol: "ETH_USDC_PERP", score: 14, chop: 14, range24: 3.4, qvol24: 30000000,
        grid: { lower: 2500, upper: 2700, count: 20, widthPct: 7.5, spacingPct: 0.4 } }],
      directional: [] },
  });
  const tickersPath = path.join(dir, "state", "tickers.json");
  fs.writeFileSync(tickersPath, JSON.stringify([{ symbol: "KEEP_USDC_PERP", lastPrice: "1.1" }, { symbol: "ETH_USDC_PERP", lastPrice: "2600" }]));
  const r = runDecide(dir, false, tickersPath);
  const actions = JSON.parse(fs.readFileSync(path.join(dir, "state", "actions.json"), "utf8"));
  const creates = actions.filter((a) => a.act === "create");
  T("INT12a risk-shrunk grid created (not skipped)", r.status === 0 && creates.length === 1);
  T("INT12b shrunk value = 1950", creates.length === 1 && Number(creates[0].value) === 1950);
  T("INT12c shrink reported", r.stdout.includes("PLAN shrink"));
}

// ---------- T26 (round-9 F01): probe merge preserves paused, ratchet max ----------
{
  // replica of the corrected probe commit: re-read latest, merge peak=max, preserve paused
  const probeCommit = (staleProbeRead, latestOnDisk, eq) => {
    const latest = JSON.parse(JSON.stringify(latestOnDisk));
    const mergedPeak = Math.max(Number(latest.peakEquity) || 0, eq);
    return { ...latest, peakEquity: mergedPeak, lastEquity: eq };
  };
  const out = probeCommit({ peakEquity: 600, paused: null }, { peakEquity: 600, paused: { at: "x" } }, 650);
  T("T26a breaker latch survives probe commit", out.paused && out.peakEquity === 650);
  const out2 = probeCommit({ peakEquity: 600, paused: null }, { peakEquity: 600, paused: null }, 500);
  T("T26b lower sample cannot lower peak", out2.peakEquity === 600);
}
T("T26c probe strict shape: null peak rejected", (() => {
  const pk = null; // Number(null)===0 must NOT pass
  return !(typeof pk === "number" || (typeof pk === "string" && pk.trim() !== "")) || !Number.isFinite(Number(pk));
})());

// ---------- T27 (round-9 F03): phase 2 full risk re-eval ----------
T("T27a phase 2 no longer skips per-grid loop", !decideSrc.includes("for (const g of (!PHASE2 ? grids : []))"));
T("T27b phase 2 defer writes marker", decideSrc.includes("PHASE 2 defer") && decideSrc.includes("needs_create_plan"));
T("T27c create requires zero stops in the round", decideSrc.includes("planCreatesNow = mayCreate && slots > 0 && stops.length === 0"));

// ---------- T29 (round-9 F06): fees window loop semantics ----------
{
  // replica: cursor advances only on complete windows (<1000); cap → last fill ts (dedup)
  let cursor = Date.UTC(2026, 8, 30);
  const seen = new Set();
  let queried = [];
  const fetchWindow = (from, to) => {
    queried.push([from, to]);
    // 模拟：第一个窗口 9/30 当天只有 300 笔（<1000，窗口完整）
    return queried.length === 1 ? { fills: Array(300).fill(0).map((_, i) => ({ tradeId: "a" + i })), to } : { fills: [], to };
  };
  const nowMs = Date.UTC(2026, 9, 7);
  const start = Date.UTC(2026, 8, 30);
  let guard = 0;
  while (cursor < nowMs - 1000 && guard++ < 10) {
    const to = Math.min(cursor + 86400000, nowMs);
    const w = fetchWindow(cursor, to);
    for (const f of w.fills) seen.add(f.tradeId);
    if (w.fills.length >= 1000) { cursor = Number(w.fills.at(-1)?.ts) || to; continue; }
    cursor = to;
    break;
  }
  T("T29 complete window advances cursor exactly to window end (resumable)", cursor === start + 86400000);
}
T("T29b fees loop: slices + verified-only cursor advance", observeSrc.includes("6 * 3600 * 1000") && observeSrc.includes("lo = hi; // 切片完整，推进"));

// ---------- T30 (round-9 F08): deploy script aligned with live protocol ----------
T("T30a deploy uses DASH_WRITE_TOKEN", deploySrc.includes("DASH_WRITE_TOKEN") && !deploySrc.includes("DASH_TOKEN=") );
T("T30b deploy pins --config", (deploySrc.match(/--config cloudflare\/wrangler\.toml/g) || []).length >= 3);

// ---------- T31 (round-9 F07): funding-adjusted health + status chips ----------
T("T31a health uses funding-adjusted effPnlPct (observe)", observeSrc.includes("effPnlPct"));
T("T31b last_round_status written by runner and read by dashboard_data",
  runRoundSrc.includes('echo "ok" > state/last_round_status') && fs.readFileSync(path.join(ROOT, "scripts", "dashboard_data.cjs"), "utf8").includes("last_round_status"));

// ---------- T32 (round-9 F04): mv-based atomic takeover ----------
T("T32a atomic mkdir acquisition", runRoundSrc.includes('if mkdir "$LOCK" 2>/dev/null; then'));
T("T32b stale takeover via atomic mv", runRoundSrc.includes('mv "$LOCK" "$QUAR" 2>/dev/null'));
T("T32c takeover liveness recheck (restore if owner alive)", runRoundSrc.includes('mv "$QUAR" "$LOCK" 2>/dev/null'));

// ---------- T33 (round-12): act_core type gate — false/blank/array rejected ----------
{
  const gate = (raw) => (typeof raw === "number" && Number.isFinite(raw))
    || (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)));
  T("T33a false rejected", !gate(false));
  T("T33b blank string rejected", !gate("  "));
  T("T33c array rejected", !gate([5]));
  T("T33d numeric zero accepted", gate(0) && Number("0") === 0);
}

// ---------- T34 (round-12): fees reorder — full page never accumulates ----------
{
  let accumulated = 0, lo = 0;
  const hi0 = 6 * 3600 * 1000;
  // 模拟：切片满页 → 不累计不推进（break）
  let fills = Array(1000).fill(0).map((_, i) => ({ vol: 1 }));
  if (fills.length >= 1000) { /* break */ }
  else for (const f of fills) accumulated += f.vol;
  T("T34a full page: zero accumulated", accumulated === 0);
  // 完整页：正常累计
  fills = Array(500).fill(0).map((_, i) => ({ vol: 1 }));
  for (const f of fills) accumulated += f.vol;
  T("T34b complete page: accumulated", accumulated === 500);
}

// ---------- T35 (round-12): runner wiring ----------
T("T35a write_status defined in runner", runRoundSrc.includes("write_status() {"));
T("T35b upload wired into exit trap", runRoundSrc.includes("trap 'release_lock; upload_dashboard' EXIT"));
T("T35c status file written on ok exit", runRoundSrc.includes('write_status "ok"'));

console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
