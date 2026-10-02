// 生产模块：峰值探测的提交时合并策略（peak_probe.mjs 与回归测试共用）。
// 规则：峰值取 max（磁盘最新值, 本次采样）、paused 逐字保留磁盘最新值、其余字段以磁盘为准。
"use strict";
function mergeProbe(latestOnDisk, sampledEquity) {
  const latestPeak = Number(latestOnDisk.peakEquity) || 0;
  const mergedPeak = Math.max(latestPeak, sampledEquity);
  return {
    ...latestOnDisk,
    peakEquity: mergedPeak,
    lastEquity: sampledEquity,
    lastAt: new Date().toISOString(),
  };
}
module.exports = { mergeProbe };
