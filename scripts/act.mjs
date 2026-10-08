// act.mjs — runs INSIDE ego-browser (ESM). Executes state/actions.json via the
// session-authenticated automation API (no UI interaction):
//   stop:    PATCH disable (closePositionsOnStop) -> wait position flat -> PATCH Delete.
//            On position-close timeout the stop is PERSISTED to state/pending_stops.json
//            and retried next round; deletion never happens while a position may be open.
//   create:  POST validate -> PATCH Upsert (with native TP/SL/closeOnStop) -> verify config,
//            verify backstops stored (self-heal once), verify orders placed (kick once).
//            If backstops still fail, the just-created grid is EMERGENCY-STOPPED, not left live.
//   protect: restore native TP/SL/closeOnStop on an existing grid and verify.
// Every step verifies; any failure aborts with non-zero exit for the caller to report.
const fs = await import("node:fs/promises");
const path = await import("node:path");
const ROOT = "__BG_ROOT__"; // placeholder injected by ego_dispatch.sh (ego-browser does not inherit cwd/env)
const { createRequire } = await import("node:module");
const requireLocal = createRequire(path.join(ROOT, "scripts/act.mjs"));
const { expectedIdentity, assertIdentity, collateralFor, validateConfig, positionsRisk, gridConfigConfirmed, gridConfirmed, forwardRisk, marginEstimate, manualPausesFor } = requireLocal("./contracts.cjs");
const {verifyLease} = requireLocal("./execution_lease.cjs");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
validateConfig(cfg);
const identity = expectedIdentity(ROOT, cfg);
const runContext = JSON.parse(await fs.readFile(path.join(ROOT, "state/run_context.json"), "utf8"));
assertIdentity(identity, runContext.identity);
const SUB = cfg.subaccountId ?? 3;
const API = "https://api.backpack.exchange";
const actionsFile = path.join(ROOT, "state/actions.json");
const actionsStat = await fs.stat(actionsFile);
const ageMin = (Date.now() - actionsStat.mtime.getTime()) / 60000;
if (ageMin > 15) {
  // a stale plan was written by an older decide round (decide failed midway?) — executing
  // it against current state would be blind. Let the next decide round re-plan instead.
  console.log(`STALE ACTIONS: actions.json is ${ageMin.toFixed(1)} min old — refusing to execute; next decide round will re-plan`);
  process.exit(2); // report refused execution, do not mark the round successful
}
const actions = JSON.parse(await fs.readFile(actionsFile, "utf8"));
const { createHash } = await import("node:crypto");
const meta = JSON.parse(await fs.readFile(path.join(ROOT, "state/actions_meta.json"), "utf8"));
assertIdentity(identity, meta.identity);
if(meta.runId !== runContext.runId || typeof meta.planId !== "string") throw Error("plan/run binding failed");
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
if (meta.configHash !== hash(cfg) || meta.actionsHash !== hash(actions) || meta.subaccountId !== SUB
  || !Number.isFinite(Date.parse(meta.at)) || Date.now() - Date.parse(meta.at) > 10 * 60000 || Date.parse(meta.at) > Date.now() + 60000) {
  throw new Error("action plan binding/staleness check failed");
}
const results = [];
const resultEnvelope = (status) => ({ at:new Date().toISOString(),runId:meta.runId,planId:meta.planId,identity,status,results });
async function persistResults(status="executing") { await assertExecutionLease(); const target=path.join(ROOT,"state/act_results.json");const tmp=target+".tmp";await fs.writeFile(tmp,JSON.stringify(resultEnvelope(status),null,2));await fs.rename(tmp,target); }
await persistResults("executing");
if (!actions.length) { console.log("no actions"); process.exit(0); }

const task = await taskSpace(cfg.watch.spaceId);
const page = task.page(cfg.watch.page);
// session origin
await page.goto("https://backpack.exchange/portfolio/balances/assets"); // 资产总览页：有会话 origin，比交易页轻
await page.waitForTimeout(4000);

async function jget(pathname) {
  const r = await page.fetch(API + pathname, { credentials: "include", timeout: 15000 });
  if (r.status !== 200) throw new Error(`GET ${pathname} -> ${r.status}`);
  return JSON.parse(r.body);
}
async function jpatch(pathname, body) {
  await assertExecutionLease();
  await accountCheck();
  await assertExecutionLease();
  const r = await page.fetch(API + pathname, {
    method: "PATCH", credentials: "include", timeout: 15000,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: String(r.body).slice(0, 300) };
}
async function jpost(pathname, body) {
  await assertExecutionLease();
  await accountCheck();
  await assertExecutionLease();
  const r = await page.fetch(API + pathname, {
    method: "POST", credentials: "include", timeout: 15000,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: String(r.body).slice(0, 300) };
}
const getAutomation = () => jget(`/wapi/v1/subaccount/${SUB}/automation`);
const symOf = (market) => market.replace("-PERP", "_USDC_PERP");
const writeAtomic = (p, data) => fs.writeFile(p + ".tmp", data).then(() => fs.rename(p + ".tmp", p));
// production control flow lives in act_core.cjs (CJS) with injected io so the REAL
// stop/create-gate logic is executable under Node with mocked exchange access
// import.meta.url is an eval artifact under the ego-browser runner — anchor the require
// base to the real file location (round-7 #1: MODULE_NOT_FOUND before any action)
const { makeStopGrid, evaluateCreateGate, pendingStructOk } = createRequire(path.join(ROOT, "scripts/act.mjs"))("./act_core.cjs");

async function currentMark(symbol) {
  const marks = await jget("/api/v1/markPrices");
  const m = marks.find((x) => x.symbol === symbol);
  return m ? String(m.markPrice) : null;
}

async function waitFor(cond, ms, step = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await page.waitForTimeout(step);
  }
  return false;
}

// io adapters: act_core.cjs executes the REAL control flow with these injected
async function loadPending() {
  const p = path.join(ROOT, "state/pending_stops.json");
  try {
    const parsed = JSON.parse(await fs.readFile(p, "utf8"));
    if (pendingStructOk(parsed) && Object.values(parsed).some(e=>e.accountKey!==identity.accountKey)) throw Error("pending account mismatch");
    const structOk = pendingStructOk(parsed);
    if (!structOk) throw Object.assign(new Error("invalid pending ledger structure"), { code: "EBADSTRUCT" });
    return { pending: parsed, corrupt: false };
  } catch (e) {
    if (e.message === "pending account mismatch") throw e;
    if (e.code === "ENOENT") return { pending: {}, corrupt: false };
    // corrupt or malformed ledger: archive the evidence and leave a persistent block flag —
    // it must never be silently treated as empty (unknown unresolved cleanups)
    try { await fs.rename(p, path.join(ROOT, `state/pending_stops.corrupt-${Date.now()}.json`)); } catch {}
    await writeAtomic(path.join(ROOT, "state/pending_corrupt.json"), JSON.stringify({ at: new Date().toISOString(), note: "pending ledger was corrupt and archived; new-risk creation stays blocked until this flag file is manually removed after inspecting the archive" }, null, 2));
    console.log("WARNING: pending_stops.json was corrupt — archived, flag file written, new-risk blocked");
    return { pending: {}, corrupt: true };
  }
}
async function savePending(p) {
  await assertExecutionLease();
  for(const entry of Object.values(p)) entry.accountKey=identity.accountKey;
  await writeAtomic(path.join(ROOT, "state/pending_stops.json"), JSON.stringify(p, null, 2));
}
async function assertExecutionLease() { verifyLease(ROOT,meta,identity); }
async function accountCheck() { const all = await jget("/wapi/v1/portfolio/collateral"); return collateralFor(all, identity); }
const io = {
  assertAccount: accountCheck,
  jget: async (pathname) => {
    const real = pathname === "/api/v1/position" ? `/api/v1/position?subaccountId=${SUB}` : pathname;
    return jget(real);
  },
  jpatch: async (pathname, body) => {
    const real = pathname === "/wapi/v1/subaccount/automation" ? `/wapi/v1/subaccount/${SUB}/automation` : pathname;
    return jpatch(real, body);
  },
  getAutomation: () => jget(`/wapi/v1/subaccount/${SUB}/automation`),
  sleep: (ms) => page.waitForTimeout(ms),
  waitFor,
  loadPending,
  savePending,
};
const stopGrid = makeStopGrid(io);

// execution phases: all stops first (risk exits), then protects, then creates.
// An incomplete stop blocks ALL creates in this run; per-action failures are recorded
// and do not abort the remaining actions.
const PHASE = { stop: 0, protect: 1, create: 2 };
actions.sort((x, y) => (PHASE[x.act] ?? 3) - (PHASE[y.act] ?? 3));
let stopIncomplete = false;
let protectIncomplete = false;
let unresolvedCleanup = false; // emergency stop did not complete — grid may be live unprotected
let anyFailure = false;
let riskChanged = false;
for (const a of actions) {
  const result = await (async () => {
    try {
      await accountCheck(); // every action, including stops/protects, belongs to the pinned owner
      if (a.act === "stop") {
        const r = await stopGrid(a.market, a.range, a.reason, results);
        if (!r || r.done !== true) stopIncomplete = true;
        return { done: true };
      }
      if (a.act === "protect") {
        const held=manualPausesFor(ROOT,identity);
        if(held['*']||held[a.market])throw Error('manual hold: protection edit skipped');
        const symbol = symOf(a.market);
        const auto1 = await getAutomation();
        const entry = (auto1.params?.symbols || []).find((s) => s.symbol === symbol);
        if (!entry) throw new Error(`protect ${a.market}: grid not found`);
        const r = await jpatch(`/wapi/v1/subaccount/${SUB}/automation`, {
          active: true,
          params: { strategyType: "Grid", symbols: [{ ...entry, takeProfitPercentage: a.tp, stopLossPercentage: a.sl, closePositionsOnStop: a.closeOnStop, operation: "Upsert" }] },
        });
        if (r.status !== 200) throw new Error(`protect ${a.market}: patch failed ${r.status} ${r.body}`);
        const ok = await waitFor(async () => {
          const a2 = await getAutomation();
          const e = (a2.params?.symbols || []).find((s) => s.symbol === symbol);
          return !!e && Number(e.takeProfitPercentage) === Number(a.tp)
            && Number(e.stopLossPercentage) === Number(a.sl)
            && e.closePositionsOnStop === a.closeOnStop;
        }, 8000);
        if (!ok) throw new Error(`protect ${a.market}: backstops not confirmed after patch`);
        results.push({ ...a, done: true });
        console.log(`PROTECTED ${a.market}: TP=${a.tp} SL=${a.sl} closeOnStop=${a.closeOnStop} verified`);
        return { done: true };
      }
      if (a.act === "create") {
        const held=manualPausesFor(ROOT,identity);
        if(held['*']||held[a.market])throw Error('manual hold: creation blocked');
        // HARD GATE, re-verified per create: no unresolved stop/protect/emergency cleanup,
        // and the live pending ledger (re-read, not the run-start snapshot) must be empty
        const live = await loadPending();
        const corruptFlag = await fs.readFile(path.join(ROOT, "state/pending_corrupt.json"), "utf8").then(() => true).catch(() => false);
        const gate = evaluateCreateGate(
          { stopIncomplete, protectIncomplete, unresolvedCleanup, riskChanged },
          Object.keys(live.pending), corruptFlag || live.corrupt);
        if (gate.blocked) {
          console.log(`SKIPPED create ${a.market}: ${gate.why} — no new grids this run`);
          results.push({ act: "create", market: a.market, done: false, skipped: true, error: `skipped: ${gate.why}` });
          anyFailure = true;
          return { done: false, skipped: true, error: `skipped: ${gate.why}` };
        }
        if (!meta.riskWriteOk) throw new Error("risk state write unconfirmed");
        const { riskStructOk } = createRequire(path.join(ROOT, "scripts/act.mjs"))("./state_schema.cjs");
        const risk = JSON.parse(await fs.readFile(path.join(ROOT, "state/risk.json"), "utf8"));
        if (!riskStructOk(risk) || risk.paused) throw new Error("risk state invalid or paused");
        const symbol = symOf(a.market);
        const auto1 = await getAutomation();
        if (!Array.isArray(auto1.params?.symbols)) throw new Error("invalid automation config");
        if ((auto1.params?.symbols || []).some((s) => s.symbol === symbol))
          throw new Error(`create ${a.market}: already configured — refusing to overwrite`);
        if (auto1.params.symbols.length >= cfg.maxGrids) throw new Error("live grid slot cap reached");
        const livePositions = await jget(`/api/v1/position?subaccountId=${SUB}`);
        if (!Array.isArray(livePositions) || livePositions.some((p) => !auto1.params.symbols.some((g) => g.symbol === p.symbol))) throw new Error("live orphan/unknown positions: new risk blocked");
        const latestRisk = positionsRisk(livePositions, cfg, identity);
        if (latestRisk.blocked) {
          riskChanged = true;
          if (latestRisk.market) await stopGrid(latestRisk.market, null, latestRisk.reason, results);
          throw Error("new risk veto: " + latestRisk.reason);
        }
        const colAll = await jget("/wapi/v1/portfolio/collateral");
        const col = collateralFor(colAll, identity);
        const { finiteNumber } = createRequire(path.join(ROOT, "scripts/act.mjs"))("./state_schema.cjs");
        if (!finiteNumber(col?.netEquity)) throw new Error("account equity unknown");
        const eq = Number(col.netEquity);
        const dd = Number(risk.peakEquity) > 0 ? (Number(risk.peakEquity) - eq) / Number(risk.peakEquity) * 100 : 0;
        if (dd >= cfg.warnDrawdownPct) throw new Error("account drawdown warning: new risk blocked");
        let existingRisk = 0;
        for (const g of auto1.params.symbols) {
          if (!finiteNumber(g.allocationUsd) || Number(g.allocationUsd)<=0 || !finiteNumber(g.stopLossPercentage) || Number(g.stopLossPercentage)<=0 || g.closePositionsOnStop !== true) throw new Error("existing grid risk premise unconfirmed");
          existingRisk += Number(g.allocationUsd) * Math.max(Number(g.stopLossPercentage), cfg.stopLossPct) / 100;
        }
        if (!finiteNumber(a.value) || Number(a.value) <= 0 || existingRisk + Number(a.value) * cfg.stopLossPct / 100 + cfg.exitCostBufferUsd > eq * cfg.riskBudgetPct / 100) throw new Error("live forward-risk budget exceeded");
        const liveAccount=await jget(`/api/v1/account?subaccountId=${SUB}`);
        if(typeof liveAccount.liquidating!=="boolean") {riskChanged=true;throw Error("account liquidation status unknown: new risk blocked");}
        if(liveAccount.liquidating===true) {riskChanged=true;throw Error("account liquidating: new risk blocked");}
        if(!finiteNumber(liveAccount.leverageLimit)||Number(liveAccount.leverageLimit)<=0||!finiteNumber(col.netEquityAvailable)) throw Error("available margin/leverage unknown");
        const markets=await jget("/api/v1/markets");const marketInfo=Array.isArray(markets)?markets.find(m=>m.symbol===symbol):null;
        if(!marketInfo?.imfFunction)throw Error("market margin constraints unknown");
        const marginCfg={...cfg,leverageCap:Math.min(cfg.leverageCap,Number(liveAccount.leverageLimit))};
        if(marginEstimate(a.value,marginCfg,marketInfo.imfFunction)+20>Number(col.netEquityAvailable))throw Error("live margin reservation insufficient");
        const mark = await currentMark(symbol);
        if (!Number.isFinite(Number(mark)) || Number(mark) <= 0) throw new Error(`create ${a.market}: no mark price`);
        if(Number(mark)<Number(a.lower)||Number(mark)>Number(a.upper))throw Error("current mark outside proposed grid range");
        const base = {
          strategyType: "Grid", symbol,
          priceLow: String(a.lower), priceHigh: String(a.upper),
          levels: Number(a.count), allocationUsd: String(a.value),
          closePositionsOnStop: true, direction: "Neutral",
          // exchange-side backstops must be set AT creation, not patched afterwards
          takeProfitPercentage: cfg.takeProfitPct, stopLossPercentage: cfg.stopLossPct,
        };
        // validate is side-effect-free: explicit rejections here must NOT leave a
        // create intent behind (it would make the next round delete an existing grid)
        const v = await jpost(`/wapi/v1/subaccount/${SUB}/automation/validate`, { params: { ...base, enabled: true } });
        if (v.status !== 200) throw new Error(`create ${a.market}: validate rejected ${v.status} ${v.body}`);
        // WRITE-AHEAD create intent, immediately before the first side-effecting request:
        // from here the grid is in an unconfirmed state; the ledger entry keeps that visible
        // (blocks new risk, drives next-round cleanup) until full confirmation or verified
        // cleanup releases it. Request-issued-but-unknown outcomes MUST keep this entry.
        {
          const intent = await loadPending();
          intent.pending[a.market] = { kind:"create",phase:"issued",accountKey: identity.accountKey, planId: meta.planId, runId: meta.runId, at: new Date().toISOString(), reason: "create intent (unconfirmed)" };
          await savePending(intent.pending);
        }
        const r = await jpatch(`/wapi/v1/subaccount/${SUB}/automation`, {
          params: { strategyType: "Grid", symbols: [{ operation: "Upsert", ...base, enabled: true, initialPrice: mark }] },
        });
        if (r.status !== 200) throw new Error(`create ${a.market}: upsert failed ${r.status} ${r.body}`);
        const acknowledged=await loadPending();
        acknowledged.pending[a.market].phase="acknowledged";await savePending(acknowledged.pending);
        const ok = await waitFor(async () => {
          const auto2 = await getAutomation();
          const e = (auto2.params?.symbols || []).find((s) => s.symbol === symbol);
          return gridConfigConfirmed(e, a);
        }, 10000);
        if (!ok) {
          let cleaned=false;
          try { const stopped=await stopGrid(a.market,null,"emergency: stored grid parameters not confirmed",results); cleaned=stopped?.done===true; } catch {}
          if(!cleaned) { unresolvedCleanup=true;stopIncomplete=true; }
          throw Error("create parameters unconfirmed" + (cleaned ? "; emergency cleanup verified" : "; MANUAL INTERVENTION REQUIRED"));
        }
        // verify backstops actually stored; self-heal once if not. ANY error in this stage
        // (timeout / lost response / read failure) leaves protection UNCONFIRMED — the grid
        // may be live unpatched — so the whole stage funnels into the emergency cleanup flow.
        const backstopsOk = async () => {
          const a3 = await getAutomation();
          const e3 = (a3.params?.symbols || []).find((s) => s.symbol === symbol);
          return !!e3 && Number(e3.stopLossPercentage) === Number(cfg.stopLossPct)
            && Number(e3.takeProfitPercentage) === Number(cfg.takeProfitPct)
            && e3.closePositionsOnStop === true;
        };
        let protectionConfirmed = false;
        try {
          if (!(await backstopsOk())) {
            const a3 = await getAutomation();
            const e3 = (a3.params?.symbols || []).find((s) => s.symbol === symbol);
            if (!e3) throw new Error(`create ${a.market}: config vanished during backstop check`);
            await jpatch(`/wapi/v1/subaccount/${SUB}/automation`, {
              active: true, params: { strategyType: "Grid", symbols: [{ ...e3, takeProfitPercentage: cfg.takeProfitPct, stopLossPercentage: cfg.stopLossPct, closePositionsOnStop: true, operation: "Upsert" }] },
            });
            await page.waitForTimeout(1000);
          }
          protectionConfirmed = await backstopsOk();
        } catch (eVerify) {
          console.log(`create ${a.market}: protection verification error (${eVerify.message}) — protection UNCONFIRMED, entering cleanup flow`);
          protectionConfirmed = false;
        }
        if (!protectionConfirmed) {
          // EMERGENCY: the grid may be live WITHOUT protection — stop it before reporting
          // failure, and verify the stop actually completed; an incomplete emergency stop is
          // MANUAL INTERVENTION
          console.log(`create ${a.market}: protection unconfirmed — emergency-stopping`);
          const resultsSink = [];
          let emergencyDone = false;
          try {
            const r = await stopGrid(a.market, null, "emergency: created without confirmed protection", resultsSink);
            emergencyDone = !!(r && r.done === true);
          } catch (e2) { emergencyDone = false; }
          if (!emergencyDone) {
            unresolvedCleanup = true;
            stopIncomplete = true; // an unresolved emergency cleanup must block later creates too
            throw new Error(`create ${a.market}: protection unconfirmed AND emergency stop did not complete — grid possibly live WITHOUT protection — MANUAL INTERVENTION REQUIRED`);
          }
          stopIncomplete = false; // emergency cleanup fully verified: it must not block later creates
          throw new Error(`create ${a.market}: protection unconfirmed even after self-heal — grid was emergency-stopped`);
        }
        // verify orders actually placed; known engine quirk: recreate-after-delete on the
        // same symbol can leave the grid enabled with zero orders — a disable/enable cycle kicks it
        const ordersUp = () => jget(`/api/v1/orders?subaccountId=${SUB}`)
          .then((os) => os.filter((o) => o.symbol === symbol).length >= Math.floor(Number(a.count) * 0.8))
          .catch(() => false);
        let placed = await waitFor(ordersUp, 12000);
        if (!placed) {
          const auto3 = await getAutomation();
          const e3 = (auto3.params?.symbols || []).find((s) => s.symbol === symbol);
          if (!e3) throw new Error(`create ${a.market}: config vanished during order check`);
          await jpatch(`/wapi/v1/subaccount/${SUB}/automation`, { active: true, params: { strategyType: "Grid", symbols: [{ ...e3, enabled: false, operation: "Upsert" }] } });
          await page.waitForTimeout(5000);
          const auto4 = await getAutomation();
          const e4 = (auto4.params?.symbols || []).find((s) => s.symbol === symbol);
          if (!e4) throw new Error(`create ${a.market}: config vanished during kick`);
          await jpatch(`/wapi/v1/subaccount/${SUB}/automation`, { active: true, params: { strategyType: "Grid", symbols: [{ ...e4, enabled: true, operation: "Upsert" }] } });
          placed = await waitFor(ordersUp, 15000);
        }
        if (!placed) throw new Error(`create ${a.market}: orders not placed even after disable/enable kick`);
        const finalAuto = await getAutomation();
        const finalEntry = finalAuto.params?.symbols?.find(e=>e.symbol===symbol);
        const finalCol = await accountCheck();
        const finalPositions=await jget(`/api/v1/position?subaccountId=${SUB}`);
        const finalAccount=await jget(`/api/v1/account?subaccountId=${SUB}`);
        const finalRisk=positionsRisk(finalPositions,cfg,identity);
        let finalBudgetOk=false;try{finalBudgetOk=forwardRisk(finalAuto.params?.symbols,finalCol.netEquity,cfg);}catch{}
        const finalDD=Number(risk.peakEquity)>0?(Number(risk.peakEquity)-Number(finalCol.netEquity))/Number(risk.peakEquity)*100:0;
        const finalOrphan=!Array.isArray(finalPositions)||finalPositions.some(p=>!finalAuto.params?.symbols?.some(g=>g.symbol===p.symbol));
        if(finalAccount.liquidating!==false || !finalBudgetOk || finalRisk.blocked || finalOrphan || finalDD>=cfg.warnDrawdownPct)riskChanged=true;
        if(finalAccount.liquidating!==false || !gridConfirmed(finalEntry,a,cfg) || !finalBudgetOk || finalRisk.blocked || finalOrphan || finalDD>=cfg.warnDrawdownPct) {
          let cleaned=false;try { const r=await stopGrid(a.market,null,"emergency: final grid/risk reconciliation failed",results);cleaned=r?.done===true; } catch {}
          if(!cleaned){unresolvedCleanup=true;stopIncomplete=true;}
          throw Error("final grid reconciliation failed"+(cleaned?"; cleanup verified":"; MANUAL INTERVENTION REQUIRED"));
        }
        console.log(`CREATED ${a.market} ${a.lower}~${a.upper} x${a.count} $${a.value} (mark ${mark}, backstops TP=${cfg.takeProfitPct}/SL=${cfg.stopLossPct}, orders verified)`);
        // fully confirmed — release the create intent
        const rel = await loadPending();
        if(rel.pending[a.market]?.planId!==meta.planId) throw Error("creation intent ownership lost");
        delete rel.pending[a.market];
        await savePending(rel.pending);
        results.push({ ...a, done: true });
        return { done: true };
      }
      return { done: true };
    } catch (e) {
      // per-action failure: record and CONTINUE — one market's failed protect/stop/create
      // must never block another market's already-decided risk exit
      results.push({ ...(a.market ? { market: a.market } : {}), act: a.act, done: false, error: String(e.message || e) });
      console.log(`FAILED ${a.act} ${a.market || ""}: ${e.message}`);
      if (a.act === "stop") stopIncomplete = true;
      if (a.act === "protect") protectIncomplete = true; // budget premise (config SL) unverified
      anyFailure = true;
      return { done: false, error: String(e.message || e) };
    }
  })();
  if (result.done === false && result.skipped) anyFailure = true;
  await persistResults();
}
await persistResults(anyFailure || stopIncomplete ? "failed" : "complete");
if (anyFailure || stopIncomplete) {
  console.log("COMPLETED_WITH_FAILURES — see state/act_results.json" + (stopIncomplete ? " (pending_stops.json has unresolved cleanups; next round will retry and creations stay blocked until clear)" : ""));
  process.exit(2);
}
console.log("ALL_DONE " + results.length + " actions");
