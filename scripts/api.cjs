// Backpack public API helpers (no auth needed). Node16-compatible (no global fetch).
const https = require("node:https");
const http = require("node:http");
const tls = require("node:tls");
const BASE = "https://api.backpack.exchange/api/v1";

// Node ignores the OS-level proxy (macOS system proxy / Clash etc.) and most machines
// have no env proxy set, so raw https.get connects DIRECTLY — which gets RST from some
// networks (10-08: ECONNRESET all day while the browser path worked fine through the
// system proxy). Tunnel through an explicit HTTP CONNECT proxy when one is configured.
// Priority: BG_PROXY > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY. Empty/unset = direct.
function proxyFromEnv(env = process.env) {
  const v = env.BG_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || "";
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function connectViaProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxyUrl); } catch { reject(new Error(`invalid proxy URL: ${proxyUrl}`)); return; }
    const req = http.request({
      host: u.hostname, port: Number(u.port) || 80, method: "CONNECT",
      path: `${host}:${port}`, headers: { host: `${host}:${port}` },
    });
    const deadline = setTimeout(() => req.destroy(new Error("proxy CONNECT exceeded 15s")), 15000);
    req.on("connect", (res, socket) => {
      clearTimeout(deadline);
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT -> ${res.statusCode}`)); return; }
      resolve(socket);
    });
    req.on("error", (e) => { clearTimeout(deadline); reject(e); });
    req.end();
  });
}

async function jfetch(path) {
  const target = new URL(BASE + path);
  const host = target.hostname;
  const proxy = proxyFromEnv();
  let req;
  if (proxy) {
    const socket = await connectViaProxy(proxy, host, 443);
    const tlsSocket = tls.connect({ socket, servername: host });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => tlsSocket.destroy(new Error("TLS handshake exceeded 15s")), 15000);
      tlsSocket.once("secureConnect", () => { clearTimeout(t); resolve(); });
      tlsSocket.once("error", (e) => { clearTimeout(t); reject(e); });
    });
    // Plain http.ClientRequest over the established TLS socket. (https.request with a
    // custom createConnection resets here, and Node 22 with agent:false IGNORES
    // options.createConnection — a custom Agent whose createConnection returns the
    // ready TLS socket is the pattern that actually works, verified 10-08.)
    const agent = new http.Agent();
    agent.createConnection = () => tlsSocket;
    req = http.request({
      host, path: `${target.pathname}${target.search}`, method: "GET",
      headers: { accept: "application/json" }, agent,
    });
  } else {
    req = https.request({
      host, port: 443, path: `${target.pathname}${target.search}`, method: "GET",
      headers: { accept: "application/json" }, agent: false,
    });
  }
  return new Promise((resolve, reject) => {
    req.on("response", (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${path} -> ${res.statusCode} ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error(`GET ${path} exceeded 15s total deadline`)), 15000);
    req.on("close", () => clearTimeout(deadline));
    req.setTimeout(15000, () => req.destroy(new Error(`GET ${path} timed out after 15s`)));
    req.on("error", reject);
    req.end();
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

module.exports = { jfetch, proxyFromEnv, getMarkets, getTickers, getKlines, getFunding, perpMarkets };
