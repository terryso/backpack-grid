"use strict";
const { money, finiteNumber, plainObject } = require("./state_schema.cjs");

// Chart rendering may be bounded, but lifetime statistics must retain all samples.
function historyMetrics(rows, current) {
  const unique = new Map();
  for (const r of rows) {
    if (!r || r.dryrun === true || !Number.isFinite(Date.parse(r.at)) || money(r.equity) === null) continue;
    unique.set(r.at, { at: r.at, equity: money(r.equity), campaignVolume: money(r.campaignVolume) });
  }
  const points = [...unique.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const drawdownPoints = [...points];
  if (points.length && current && Number.isFinite(Date.parse(current.at)) && money(current.equity) !== null
    && Date.parse(current.at) > Date.parse(points.at(-1).at)) drawdownPoints.push({ at: current.at, equity: money(current.equity) });
  let peak = 0, maxDrawdown = null;
  for (const p of drawdownPoints) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown ?? 0, (peak - p.equity) / peak * 100);
  }
  return { points, count: points.length, since: points[0]?.at || null, maxDrawdown,
    curve: points.slice(-400).map((p) => [p.at, p.equity, p.campaignVolume]) };
}

function confirmedRuns(events) {
  const runs = new Map();
  for (const e of events) if (e?.type === "end" && e.dryrun === false && typeof e.runId === "string") runs.set(e.runId, e);
  const all = [...runs.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { successful: all.filter((e) => e.status === "ok").length,
    failed: all.filter((e) => e.status !== "ok").length, since: all[0]?.startedAt || null };
}

// Nominal forward stop budget, not an estimate of liquidation loss or drawdown.
// Disabled-but-configured grids still consume budget, matching creation guards.
function stopBudgetUsage(grids, equity, cfg) {
  const unknown=reason=>({valid:false,pct:null,reason});
  if(!finiteNumber(equity)||Number(equity)<=0)return unknown('权益不足或未知');
  if(!cfg||![cfg.riskBudgetPct,cfg.stopLossPct,cfg.exitCostBufferUsd].every(v=>typeof v==='number'&&Number.isFinite(v))
    ||cfg.riskBudgetPct<=0||cfg.riskBudgetPct>100||cfg.stopLossPct<=0||cfg.stopLossPct>100||cfg.exitCostBufferUsd<0)return unknown('预算参数待核对');
  if(!Array.isArray(grids)||grids.some(g=>!plainObject(g)||!finiteNumber(g.allocationRaw)||Number(g.allocationRaw)<=0
    ||!finiteNumber(g.nativeSL)||Number(g.nativeSL)<=0||Number(g.nativeSL)>100||g.nativeCloseOnStop!==true))return unknown('网格止损保护待核实');
  const gridRiskUsd=grids.reduce((sum,g)=>sum+Number(g.allocationRaw)*Math.max(Number(g.nativeSL),cfg.stopLossPct)/100,0);
  const usedUsd=gridRiskUsd+cfg.exitCostBufferUsd,budgetUsd=Number(equity)*cfg.riskBudgetPct/100,pct=usedUsd/budgetUsd*100;
  if(![gridRiskUsd,usedUsd,budgetUsd,pct].every(Number.isFinite)||budgetUsd<=0)return unknown('止损额度无法估算');
  return {valid:true,pct,gridRiskUsd,bufferUsd:cfg.exitCostBufferUsd,usedUsd,budgetUsd,
    remainingUsd:budgetUsd-usedUsd,overBudget:usedUsd>budgetUsd,riskBudgetPct:cfg.riskBudgetPct};
}
module.exports = { historyMetrics, confirmedRuns, stopBudgetUsage };
