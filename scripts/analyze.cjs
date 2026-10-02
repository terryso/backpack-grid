#!/usr/bin/env node
// Grid pair analysis for Backpack perps.
// Ranks perp markets by grid suitability: oscillation (chop) over trend,
// liquidity, tolerable funding. Outputs top candidates with suggested grid params.
const fs = require("node:fs");
const path = require("node:path");
const { getMarkets, getTickers, getKlines, getFunding, perpMarkets } = require("./api.cjs");
const ROOT = process.env.BG_ROOT || path.join(__dirname, "..");
const { finiteNumber } = require("./state_schema.cjs");
const { tickDecimals } = require("./grid_sizing.cjs");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

const TOP_N = Number(process.argv[2] || 15);
const MIN_QVOL = Number(cfg.minQvol24h) || 800_000; // 24h quote volume floor (liquidity)
const EXCLUDE = (process.env.EXCLUDE || "").split(",");

function analyze(symbol, kl) {
  const num = (k, objKey, arrIdx) => (k[objKey] !== undefined ? Number(k[objKey]) : Number(k[arrIdx]));
  const closes = kl.map((k) => num(k, "close", 4));
  const highs = kl.map((k) => num(k, "high", 2));
  const lows = kl.map((k) => num(k, "low", 3));
  if (closes.length < 72 || closes.some((c) => !isFinite(c) || c <= 0) || highs.some((c) => !isFinite(c) || c <= 0) || lows.some((c) => !isFinite(c) || c <= 0)) return null;
  const logRet = [];
  for (let i = 1; i < closes.length; i++) logRet.push(Math.abs(Math.log(closes[i] / closes[i - 1])));
  const path24 = logRet.slice(-24).reduce((s, x) => s + x, 0);
  const path72 = logRet.slice(-72).reduce((s, x) => s + x, 0);
  const sDrift24 = Math.log(closes[closes.length - 1] / closes[Math.max(0, closes.length - 25)]); // signed
  const drift24 = Math.abs(sDrift24);
  const sDrift72 = Math.log(closes[closes.length - 1] / closes[Math.max(0, closes.length - 73)]); // signed
  const drift72 = Math.abs(sDrift72);
  const drift7d = Math.abs(Math.log(closes[closes.length - 1] / closes[0]));
  // smooth chop across 24h and 72h windows so a single wild day doesn't dominate
  const chop = (path24 / (drift24 + 0.0005) + path72 / (drift72 + 0.001)) / 2;
  const pathDay = (path24 + path72 / 3) / 2; // daily-ized oscillation path
  const price = closes[closes.length - 1];
  const range24 = (Math.max(...highs.slice(-24)) - Math.min(...lows.slice(-24))) / price;
  const range7d = (Math.max(...highs) - Math.min(...lows)) / price;
  return { price, path24, pathDay, drift24, drift7d, sDrift24, sDrift72, chop, range24, range7d };
}

(async () => {
  const markets = perpMarkets(await getMarkets());
  const tickers = await getTickers();
  const tmap = new Map(tickers.map((t) => [t.symbol, t]));

  const rows = [];
  for (const m of markets) {
    const sym = m.symbol;
    if (EXCLUDE.includes(sym)) continue;
    if (sym.includes(".US_")) continue; // skip TradFi (stock) perps: session gaps, not 24/7
    const t = tmap.get(sym);
    if (!t) continue;
    const qvol = Number(t.quoteVolume || 0);
    if (qvol < MIN_QVOL) continue;
    let kl;
    try { kl = await getKlines(sym, "1h", 168, 168); } catch { continue; }
    const a = analyze(sym, kl);
    if (!a) continue;
    const f = await getFunding(sym);
    const fundingRaw = Array.isArray(f) && f.length ? f[f.length - 1].rate ?? f[f.length - 1].fundingRate : null;
    if (!finiteNumber(fundingRaw)) continue; // unknown funding cannot score as free
    const fundingRate = Number(fundingRaw);

    const liq = Math.min(2.2, Math.log10(qvol / 1e6 + 1));
    // cap chop so a near-zero net displacement (one big round-trip back to start)
    // cannot dominate the ranking
    const chopEff = Math.min(a.chop, 20);
    const score = (chopEff * 0.9 + a.range24 * 40) * (0.5 + liq / 3)
      - a.drift24 * 25 - Math.min(2, Math.abs(fundingRate) * 800);

    let widthPct = Math.max(0.06, Math.min(0.30, Math.max(a.range7d * 0.85, a.range24 * 2.2, 0.07)));
    const spacing = Math.max(0.0035, Math.min(0.008, a.pathDay / 8));
    // exchange constraints
    const tickSize = Number(m.filters?.price?.tickSize || 0) || null;
    const minQuantity = Number(m.filters?.quantity?.minQuantity || 0) || 0;
    const decimals = tickSize ? tickDecimals(tickSize) : 6;
    const rnd = (v, up) => {
      if (!tickSize) return +v.toPrecision(6);
      const t = up ? Math.ceil(v / tickSize) : Math.floor(v / tickSize);
      return +(t * tickSize).toFixed(decimals);
    };
    let lower = rnd(a.price * (1 - widthPct / 2), false);
    let upper = rnd(a.price * (1 + widthPct / 2), true);
    widthPct = (upper - lower) / a.price;
    let count = Math.round(widthPct / spacing);
    count = Math.max(20, Math.min(110, count));
    // per-order notional must respect min quantity (with buffer) — use the actual planned value
    const planValue = Number(cfg.gridValueUsd || 2500);
    const minOrderUsd = Math.max(minQuantity * a.price * 1.1, 10);
    while (count > 4 && (planValue / count) < minOrderUsd) count--;
    rows.push({
      symbol: sym, price: a.price, score: +score.toFixed(3), chop: +a.chop.toFixed(2),
      sDrift24: a.sDrift24, sDrift72: a.sDrift72,
      range24: +(a.range24 * 100).toFixed(1), range7d: +(a.range7d * 100).toFixed(1),
      drift24: +(a.drift24 * 100).toFixed(2), fundingRate,
      qvol24: Math.round(qvol), tickSize, minQuantity, minOrderUsd,
      grid: { lower, upper, count, widthPct: +(widthPct * 100).toFixed(1), spacingPct: +((widthPct / count) * 100).toFixed(3) },
    });
  }

  rows.sort((x, y) => y.score - x.score);
  const top = rows.slice(0, TOP_N);
  // directional candidates (paper mode only — no real orders): sustained efficient trend,
  // 24h and 72h drift aligned, not choppy
  const directional = rows
    .filter((r) => r.sDrift24 !== undefined
      && Math.abs(r.sDrift24) >= 0.04
      && Math.sign(r.sDrift24) === Math.sign(r.sDrift72)
      && r.chop < 2.5)
    .sort((a, b) => Math.abs(b.sDrift24) - Math.abs(a.sDrift24))
    .slice(0, 5)
    .map((r) => ({ symbol: r.symbol, dir: r.sDrift24 > 0 ? "long" : "short", drift24: +(r.sDrift24 * 100).toFixed(2), price: r.price }));
  const out = { generatedAt: new Date().toISOString(), top, directional };
  const target = path.join(ROOT, "state", "analysis.json");
  const tmp = target + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, target);

  console.log("rank symbol            score chop r24%  r7d%  drift24% funding   qvol24       grid lower~upper / count (width%)");
  top.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}  ${r.symbol.padEnd(16)} ${String(r.score).padStart(6)} ${String(r.chop).padStart(5)} ${String(r.range24).padStart(5)} ${String(r.range7d).padStart(5)} ${String(r.drift24).padStart(6)} ${(r.fundingRate * 100).toFixed(4).padStart(7)}% ${String(r.qvol24).padStart(11)}  ${r.grid.lower} ~ ${r.grid.upper} / ${r.grid.count} (${r.grid.widthPct}%)`
    );
  });
})().catch((e) => { console.error("ANALYZE FAILED:", e.message); process.exit(1); });
