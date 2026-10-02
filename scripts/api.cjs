// Backpack public API helpers (no auth needed). Node16-compatible (no global fetch).
const https = require("node:https");
const BASE = "https://api.backpack.exchange/api/v1";

function jfetch(path) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(BASE + path, { headers: { accept: "application/json" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET ${path} -> ${res.statusCode} ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
    const deadline = setTimeout(() => req.destroy(new Error(`GET ${path} exceeded 15s total deadline`)), 15000);
    req.on("close", () => clearTimeout(deadline));
    req.setTimeout(15000, () => req.destroy(new Error(`GET ${path} timed out after 15s`)));
  });
}

async function getMarkets() { return jfetch("/markets"); }
async function getTickers() { return jfetch("/tickers"); }

async function getKlines(symbol, interval, hoursBack, limit) {
  const startTime = Math.floor(Date.now() / 1000) - hoursBack * 3600; // seconds!
  return jfetch(`/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${limit}`);
}

async function getFunding(symbol) {
  try { return await jfetch(`/fundingRates?symbol=${symbol}&limit=1`); } catch { return null; }
}

function perpMarkets(markets) {
  return markets.filter((m) => m.symbol.endsWith("_USDC_PERP") || m.symbol.endsWith("_USD_PERP"));
}

module.exports = { jfetch, getMarkets, getTickers, getKlines, getFunding, perpMarkets };
