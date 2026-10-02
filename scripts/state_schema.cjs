"use strict";
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const finiteNumber = (v) => (typeof v === "number" || (typeof v === "string" && decimal.test(v.trim())))
  && Number.isFinite(Number(v));
const riskStructOk = (v) => plainObject(v) && finiteNumber(v.peakEquity) && Number(v.peakEquity) >= 0
  && (v.paused == null || plainObject(v.paused));
const pendingStructOk = (v) => plainObject(v) && Object.values(v).every(plainObject);
const money = (v) => {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const cleaned = typeof v === "string" ? v.replace(/[$,%\s,]/g, "") : v;
  return finiteNumber(cleaned) ? Number(cleaned) : null;
};
module.exports = { plainObject, finiteNumber, riskStructOk, pendingStructOk, money };
