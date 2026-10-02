"use strict";
const { finiteNumber } = require("./state_schema.cjs");
function tickDecimals(n) {
  const [a, exponent = "0"] = String(n).toLowerCase().split("e");
  return Math.max(0, (a.split(".")[1] || "").length - Number(exponent));
}
function sizeGrid(candidate, value) {
  const g = candidate.grid;
  if (!g || ![g.lower, g.upper, g.count, value].every(finiteNumber)
    || Number(g.lower) <= 0 || Number(g.upper) <= Number(g.lower) || Number(value) <= 0) return null;
  // Conservative upper price is used for minimum quantity at every level.
  const minOrder = Math.max(10, Number(candidate.minOrderUsd) || 0,
    (Number(candidate.minQuantity) || 0) * Number(g.upper) * 1.1);
  const count = Math.min(Math.floor(Number(g.count)), Math.floor(Number(value) / minOrder));
  if (count < 4) return null;
  return { ...g, count, minOrderUsd: minOrder, perOrderUsd: Number(value) / count };
}
module.exports = { sizeGrid, tickDecimals };
