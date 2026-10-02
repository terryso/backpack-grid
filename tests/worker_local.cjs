// Use only with wrangler dev --local, isolated persistence, and fixture-only token.
const assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:8793';
const post = (ip) => fetch(BASE + '/api/like', { method: 'POST', headers: { 'cf-connecting-ip': ip } }).then(async (r) => { assert.equal(r.status, 200); return r.json(); });
(async () => {
  const root = await fetch(BASE); assert.equal(root.status, 200); assert((await root.text()).includes('Backpack'));
  const before = await (await fetch(BASE + '/api/likes', { headers: { 'cf-connecting-ip': '192.0.2.210' } })).json();
  const same = await Promise.all(Array.from({ length: 20 }, () => post('192.0.2.210')));
  assert(same.every((r) => r.likes === before.likes + (before.alreadyLiked ? 0 : 1)));
  const uniqueBefore = same[0].likes;
  const batch = Date.now() % 240;
  await Promise.all(Array.from({ length: 20 }, (_, i) => post(`198.51.${batch}.${i + 1}`)));
  const after = await (await fetch(BASE + '/api/likes', { headers: { 'cf-connecting-ip': '192.0.2.210' } })).json();
  assert.equal(after.likes, uniqueBefore + 20);
  assert.equal(after.alreadyLiked, true);
  assert.equal((await fetch(BASE + '/api/snapshot', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(BASE + '/api/snapshot', { method: 'POST', headers: { 'x-token': 'fixture-only' }, body: 'broken' })).status, 400);
  const snap = { updatedAt: new Date().toISOString(), equity: 600, available: 450, equityChange: 65, strategyTotalPnl: null, strategyBaselineAt: '2026-09-30', dataValid: true, riskStateValid: true, pendingCorrupt: false, riskWriteValid: true, lastRoundStatus: 'ok', riskPaused: false, drawdownPct: 1, maxDrawdown: 3.5, campaignVolume: 45000, tier1: 50000, grids: [{ market: 'SOL-PERP', direction: '中性', status: 'Triggered', count: 20, value: 1500, price: 100, rangeLow: 90, rangeHigh: 110, pnl: 10, pnlPct: .67, effPnlPct: .67 }], positions: [], pending: [], orphans: [], runStats: { days: 3, rounds: 20, exits: 2 }, curve: [[new Date().toISOString(), 590, 40000], [new Date().toISOString(), 600, 45000]] };
  assert.equal((await fetch(BASE + '/api/snapshot', { method: 'POST', headers: { 'x-token': 'fixture-only' }, body: JSON.stringify(snap) })).status, 200);
  console.log('PASS actual local Worker + SQLite DO: same visitor, 20 concurrent visitors, readback, upload authentication, malformed payload, healthy snapshot');
})().catch((e) => { console.error(e); process.exitCode = 1; });
