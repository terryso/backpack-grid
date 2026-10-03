"use strict";
const { money } = require("./state_schema.cjs");

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

module.exports = { historyMetrics, confirmedRuns };
