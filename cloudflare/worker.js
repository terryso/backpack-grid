// Cloudflare Worker: receives inspection snapshots (token-protected POST) and serves
// the dashboard (token-gated read). KV stores the latest snapshot.
// 2026-11-20 起新增两类职责（与本地管线解耦，全部只读公开数据）：
//   1) 方向判定影子模式：每小时 cron，逐字移植 direction_watch.cjs 纯函数，
//      写入独立 KV key `advice_cloud`（影子验证期与本地 advice 比对，不碰权威链路）；
//   2) 哨兵：5 分钟 cron，KV 快照 + 公开实时行情评估 A/B/C 触发器 → Bark 推送。
export { LikeCounter } from "./likes.js";
export { DirectionMailbox } from "./direction_mailbox.js";
import * as patterns from "./patterns.js";

const BACKPACK_API = "https://api.backpack.exchange/api/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const writeToken = env.DASH_WRITE_TOKEN; // POST 上传专用，永不公开
    if (!writeToken) return new Response("DASH_WRITE_TOKEN secret not set", { status: 500 });
    // 读取与首页公开（实盘展示用途）；只有写入受 DASH_WRITE_TOKEN 保护

    if (url.pathname === "/api/snapshot" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      const body = await request.text();
      let parsed; try { parsed = JSON.parse(body); } catch { return new Response("invalid JSON", { status: 400 }); }
      // 单调性门控：拒绝 updatedAt 回退的上传（11-15 事故：第二持有 token 的数据源
      // 用停在 22:39 的旧 state 覆盖了最新快照 3.5 小时）。相同 updatedAt 幂等放行。
      const current = await env.DASH.get("latest");
      if (current) {
        let prevAt = null; try { prevAt = JSON.parse(current).updatedAt ?? null; } catch {}
        const nextAt = parsed.updatedAt ?? null;
        if (prevAt && nextAt && Date.parse(nextAt) < Date.parse(prevAt)) {
          return new Response(`stale snapshot rejected: ${nextAt} < ${prevAt}`, { status: 409 });
        }
      }
      await env.DASH.put("latest", body);
      return new Response("ok");
    }

    if (url.pathname === "/api/ops" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      const body = await request.text();
      try { JSON.parse(body); } catch { return new Response("invalid JSON", { status: 400 }); }
      await env.DASH.put("ops", body);
      return new Response("ok");
    }

    if ((url.pathname === "/api/like" && request.method === "POST") || (url.pathname === "/api/likes" && request.method === "GET")) {
      const ip = request.headers.get("cf-connecting-ip");
      if (!ip) return new Response("visitor address unavailable", { status: 400 });
      const day = new Date().toISOString().slice(0, 10);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + writeToken + "|" + day));
      const visitor = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!env.LIKES) return new Response("likes storage unavailable", { status: 503 });
      const stub = env.LIKES.get(env.LIKES.idFromName("dashboard-likes"));
      return stub.fetch(new Request("https://likes.internal/", { method: "POST", body: JSON.stringify({ visitor, day, increment: request.method === "POST" }) }));
    }

    if (url.pathname === "/api/snapshot") {
      const snap = await env.DASH.get("latest");
      return new Response(snap ?? "{}", {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ops") {
      const ops = await env.DASH.get("ops");
      return new Response(ops ?? "{}", {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // 方向指令（影子验证期后将成为权威源；现在 advice key 尚无人写，返回 {}）
    if (url.pathname === "/api/direction-advice") {
      const state = await mailbox(env).fetch('https://direction.internal/state').then(r => r.json());
      return json(JSON.stringify(state.advice || {}));
    }
    if (url.pathname === '/api/direction-event' && request.method === 'GET') {
      return mailbox(env).fetch('https://direction.internal/state');
    }
    // 影子判定结果（与本地 direction_watch 比对用）
    if (url.pathname === "/api/direction-advice-cloud") {
      const a = await env.DASH.get("advice_cloud");
      return json(a ?? "{}");
    }
    // 哨兵状态（最近评估详情 + 各触发器上次推送时间）
    if (url.pathname === "/api/sentinel") {
      const s = await env.DASH.get("sentinel_state");
      return json(s ?? "{}");
    }
    // 手动触发（测试用，token 保护）：立即执行一次影子判定 / 哨兵评估
    if (url.pathname === "/api/judge-cloud/run" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      return json(JSON.stringify(await runShadowJudge(env)));
    }
    if (url.pathname === "/api/sentinel/run" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      return json(JSON.stringify(await runSentinel(env, { forcePersist: true })));
    }

    return new Response("not found", { status: 404 });
  },

  // cron 触发：*/5 = 哨兵；每小时 11 分 = 影子判定（保持与本地一致的每小时节奏——
  // 频率是参数：streak「5 连 = 5 小时」的语义依赖每小时判定一次，不可加密）。
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") await runSentinel(env);
    else if (event.cron === "11 * * * *") await runShadowJudge(env);
  },
};

function json(body) {
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function mailbox(env) { return env.DIRECTION.get(env.DIRECTION.idFromName('direction-mailbox')); }

// ---------- Bark 推送 ----------

async function bark(env, title, body, opts = {}) {
  if (!env.BARK_KEY) return { status: 0, error: "BARK_KEY not set" };
  const u = new URL(`https://api.day.app/${env.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  u.searchParams.set("group", opts.group || "grid");
  u.searchParams.set("level", opts.level || "timeSensitive");
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

// ---------- 公开行情 ----------

async function fetchMarks() {
  const r = await fetch(`${BACKPACK_API}/markPrices`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`markPrices ${r.status}`);
  const arr = await r.json();
  const m = {};
  for (const it of Array.isArray(arr) ? arr : []) m[it.symbol] = Number(it.markPrice);
  return m;
}

// 与 scripts/api.cjs getKlines 同参：1h 收盘价序列，取 340 根（t14 需 337+）。
async function fetchCloses(sym) {
  const startTime = Math.floor(Date.now() / 1000) - 340 * 3600; // seconds!
  const u = `${BACKPACK_API}/klines?symbol=${sym}&interval=1h&startTime=${startTime}&limit=340`;
  for (let attempt = 0; attempt < 2; attempt++) { // 与本地一致：先重试再定性
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const kl = await r.json();
        const closes = (Array.isArray(kl) ? kl : []).map((k) => Number(k && k.close)).filter((c) => Number.isFinite(c));
        if (closes.length >= 25) return closes;
      }
    } catch {}
    if (attempt < 1) await new Promise((r2) => setTimeout(r2, 3000));
  }
  return null;
}

// ---------- 哨兵（5 分钟检查，平稳时 30 分钟持久化心跳） ----------

const SENTINEL_STATUS_WRITE_INTERVAL_MS = 30 * 60 * 1000;
const monitoredPosition = position => position?.side === "short" || position?.side === "long";

async function persistSentinelState(env, state) {
  state.lastPersistedAt = new Date().toISOString();
  state.statusWriteIntervalSeconds = SENTINEL_STATUS_WRITE_INTERVAL_MS / 1000;
  await env.DASH.put("sentinel_state", JSON.stringify(state));
}

async function recordSentinelFailure(env, state, stage) {
  state.monitoringStatus = "degraded";
  state.monitoringReasons = [stage];
  state.lastFailure = { at: new Date().toISOString(), stage };
  try { await persistSentinelState(env, state); }
  catch { console.error("sentinel failure state could not be persisted"); }
}

async function runSentinel(env, { forcePersist = false } = {}) {
  const state = JSON.parse(await env.DASH.get("sentinel_state") || "{}");
  let latest;
  try { latest = JSON.parse(await env.DASH.get("latest") || "null"); }
  catch (error) { await recordSentinelFailure(env, state, "snapshot-read"); throw error; }
  if (!latest || !Array.isArray(latest.positions) || !latest.positions.length || !latest.updatedAt) {
    state.lastSkip = { at: new Date().toISOString(), reason: "no snapshot or no positions" };
    state.monitoringStatus = "skipped";
    state.monitoringReasons = ["snapshot-unavailable-or-no-positions"];
    // Missing data can be a failure, so do not suppress this path.
    await persistSentinelState(env, state);
    return state;
  }
  const previousStatus = state.monitoringStatus;
  const previousTriggers = Array.isArray(state.activeTriggers) && state.activeTriggers.every((t) => typeof t === "string")
    ? [...state.activeTriggers].sort() : null;
  const previousWriteAt = Date.parse(state.lastPersistedAt || state.lastRunAt || "");
  let liveMarks = null;
  let marketDataFailed = false;
  try {
    liveMarks = await fetchMarks();
    if (!Object.values(liveMarks).some((mark) => Number.isFinite(mark) && mark > 0)) {
      liveMarks = null; marketDataFailed = true;
    } else if (latest.positions.some((position) => monitoredPosition(position) &&
      (!position.symbol || !(Number.isFinite(liveMarks[position.symbol]) && liveMarks[position.symbol] > 0)))) {
      // Keep the valid live prices for other positions, but record the partial
      // fallback immediately instead of treating it as a healthy quiet check.
      marketDataFailed = true;
    }
  } catch { marketDataFailed = true; } // 拉不到就用快照 mark（降级可用）
  let evaluation;
  try {
    evaluation = patterns.evaluate(latest, liveMarks);
    if (!evaluation || !Array.isArray(evaluation.triggers) || !evaluation.detail || typeof evaluation.detail !== "object" ||
      evaluation.triggers.some((t) => !t || typeof t.type !== "string" || !t.type || typeof t.title !== "string" || typeof t.body !== "string")) {
      throw new Error("invalid sentinel evaluation");
    }
  }
  catch (error) { await recordSentinelFailure(env, state, "risk-evaluation"); throw error; }
  const { triggers, detail } = evaluation;
  const monitoredPositions = latest.positions.filter(monitoredPosition).length;
  const riskDataIncomplete = monitoredPositions > 0 && (!Number.isSafeInteger(detail.positionsEvaluated) || detail.positionsEvaluated < monitoredPositions);
  const snapshotAt = Date.parse(latest.updatedAt);
  const snapshotAge = Date.now() - snapshotAt;
  const snapshotStale = !Number.isFinite(snapshotAt) || snapshotAge < 0 || snapshotAge > patterns.SENTINEL.BLIND_MIN * 60000;
  const activeTriggers = [...new Set(triggers.map((t) => t.type))].sort();
  const triggerChanged = !previousTriggers || JSON.stringify(previousTriggers) !== JSON.stringify(activeTriggers);
  state.activeTriggers = activeTriggers;
  const pushed = [];
  let notificationFailed = false;
  for (const t of triggers) {
    const last = state[t.type] && state[t.type].lastAt;
    if (last && Date.now() - Date.parse(last) < patterns.SENTINEL.COOLDOWN_MS) continue;
    let r;
    try { r = await bark(env, t.title, t.body, { group: "grid-" + t.type, level: t.level }); }
    catch (error) {
      // Preserve successful earlier notifications and record the failure, then
      // rethrow so the scheduled invocation still reports the error.
      state[`${t.type}_err`] = { at: new Date().toISOString(), result: { status: 0, error: "notification request failed" } };
      state.lastRunAt = new Date().toISOString();
      state.lastDetail = detail;
      state.lastPushed = pushed;
      await recordSentinelFailure(env, state, "notification");
      throw error;
    }
    if (r.status === 200) { state[t.type] = { lastAt: new Date().toISOString() }; pushed.push(t.type); }
    else { state[`${t.type}_err`] = { at: new Date().toISOString(), result: r }; notificationFailed = true; }
  }
  const reasons = [];
  if (latest.dataValid === false) reasons.push("snapshot-invalid");
  if (snapshotStale) reasons.push("snapshot-stale");
  if (marketDataFailed) reasons.push("market-data");
  if (riskDataIncomplete) reasons.push("risk-data-incomplete");
  if (notificationFailed) reasons.push("notification");
  const monitoringStatus = reasons.length ? "degraded" : "healthy";
  const statusChanged = previousStatus !== monitoringStatus;
  state.monitoringStatus = monitoringStatus;
  state.monitoringReasons = reasons;
  state.lastRunAt = new Date().toISOString();
  state.lastDetail = detail;
  state.lastPushed = pushed;
  const elapsed = Date.now() - previousWriteAt;
  const heartbeatDue = !Number.isFinite(previousWriteAt) || elapsed < 0 || elapsed >= SENTINEL_STATUS_WRITE_INTERVAL_MS;
  // Never defer active alerts, degraded data, recovery, manual runs or state
  // transitions. In a quiet state lastRunAt is the most recently persisted
  // check, not proof of the most recent five-minute invocation.
  if (forcePersist || triggers.length || reasons.length || triggerChanged || statusChanged || heartbeatDue) {
    await persistSentinelState(env, state);
  }
  return state;
}

// ---------- 影子判定（每小时 cron，写 advice_cloud，不碰权威链路） ----------

async function runShadowJudge(env) {
  const latest = JSON.parse(await env.DASH.get("latest") || "null");
  const directive = latest?.direction?.directive;
  if (!directive) {
    return { skipped: "no directive in latest snapshot — 无指令不判（DATA_FAIL 精神）" };
  }
  // Acknowledgments must not depend on the market-data endpoint being healthy.
  const initial = await mailbox(env).fetch('https://direction.internal/advance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: latest }),
  }).then(r => r.json());
  if (initial.pending || initial.resolved || initial.skipped === 'versioned snapshot unavailable') return initial;
  // 在跑网格市场 → 符号（快照 grids 无 symbol 字段，从 market 映射）
  const markets = [...new Set((Array.isArray(latest.grids) ? latest.grids : []).map((g) => g.market).filter(Boolean))];
  const running = markets.map((m) => String(m).replace("-PERP", "_USDC_PERP")).filter((s) => s.endsWith("_USDC_PERP"));
  const symbols = [...new Set(["BTC_USDC_PERP", ...running])];
  const series = {};
  await Promise.all(symbols.map(async (s) => { series[s] = await fetchCloses(s); }));
  const btcM = patterns.metrics(series.BTC_USDC_PERP);
  if (!btcM) {
    return { dataFail: true, missing: symbols.filter((s) => !series[s]), note: "no judgement — streak untouched（失败小时不计数）" };
  }
  const refSym = running.find((s) => s !== "BTC_USDC_PERP") || null;
  const refM = refSym ? patterns.metrics(series[refSym]) : null;
  const note = `btc t7=${btcM.t7?.toFixed(1)}% t14=${Number.isFinite(btcM.t14) ? btcM.t14.toFixed(1) + "%" : "n/a"} pos=${btcM.rangePos.toFixed(2)} bounce=${btcM.bounce.toFixed(1)}%`;
  const ref = refM ? { symbol: refSym, t7: refM.t7, t14: refM.t14, rangePos: refM.rangePos } : null;

  const result = await mailbox(env).fetch('https://direction.internal/advance', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot: latest, metrics: btcM, note, ref }),
  }).then(r => r.json());
  // KV copies are display-only; the Durable Object is the authority.
  if (result.advice) {
    await env.DASH.put("advice", JSON.stringify({ ...result.advice, source: "cloud" }));
    await env.DASH.put("advice_cloud", JSON.stringify({ ...result.advice, shadow: true }));
  }
  return { ...result, symbols };
}
