'use strict';
// Decide only when to publish the already-built public ops payload. This code
// does not participate in observation, decisions, execution or risk controls.
const fs = require('node:fs'), path = require('node:path');
const { hash, atomic, identityOk } = require('./contracts.cjs');
const { plainObject } = require('./state_schema.cjs');
const ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 15 * 60 * 1000;
// The prior upload finishes after its round starts. Allow one minute of timing
// variation so a normal five-minute round does not accidentally defer to 20m.
const INTERVAL_GRACE_MS = 60 * 1000;
// ops.html marks coverage stale after 30 minutes. Leave two monitor intervals
// of headroom when a newer collection watermark is already available.
const COVERAGE_HEADROOM_MS = 20 * 60 * 1000;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function inspect(payload, snapshot, identity, snapshotUpload) {
  if (!plainObject(payload) || !Array.isArray(payload.ops) || !Array.isArray(payload.fills)
      || !Array.isArray(payload.rounds) || !plainObject(payload.collection)) throw Error('invalid operations payload');
  const accountHash = identityOk(identity) ? hash(identity.accountKey) : null;
  const data = { ...payload }; delete data.updatedAt;
  const contentHash = hash(data), c = payload.collection, s = plainObject(snapshot) ? snapshot : {};
  const coverageAt = payload.ledgerAsOf == null ? null : payload.ledgerAsOf;
  if (coverageAt !== null && (typeof coverageAt !== 'string' || !Number.isFinite(Date.parse(coverageAt)))) throw Error('invalid collection watermark');
  const health = { lastRoundStatus: s.lastRoundStatus ?? null, dataValid: s.dataValid ?? null,
    identityValid: s.identityValid ?? null, riskStateValid: s.riskStateValid ?? null,
    riskWriteValid: s.riskWriteValid ?? null, manualPauseValid: s.manualPauseValid ?? null,
    pendingCorrupt: s.pendingCorrupt ?? null, riskPaused: s.riskPaused ?? null,
    marketDataAvailable: s.marketDataAvailable ?? null, pending: Array.isArray(s.pending) ? [...s.pending].sort() : null,
    orphans: Array.isArray(s.orphans) ? [...s.orphans].sort() : null,
    trailEnabled: s.autoExits?.trailEnabled ?? null, trailReady: s.autoExits?.trailReady ?? null,
    snapshotUploadOk: snapshotUpload?.ok ?? null,
    collection: { ok: c.ok ?? null, incomplete: c.incomplete ?? null,
      forwardIncomplete: c.forwardIncomplete ?? null, auditIncomplete: c.auditIncomplete ?? null } };
  const unhealthy = !accountHash || !['ok', 'dryrun'].includes(health.lastRoundStatus)
    || health.dataValid !== true || health.identityValid !== true || health.riskStateValid !== true
    || health.riskWriteValid !== true || health.manualPauseValid !== true || health.pendingCorrupt !== false
    || health.riskPaused !== false || health.marketDataAvailable !== true || health.snapshotUploadOk !== true || !health.pending || health.pending.length > 0
    || !health.orphans || health.orphans.length > 0 || (health.trailEnabled === true && health.trailReady !== true)
    || health.collection.ok !== true || health.collection.incomplete !== false
    || health.collection.forwardIncomplete !== false || health.collection.auditIncomplete !== false;
  return { accountHash, contentHash, importantHash: hash({ accountHash, ops: payload.ops, fills: payload.fills, health }), unhealthy, coverageAt };
}

function validCheckpoint(c) {
  return plainObject(c) && c.version === 1 && hex(c.accountHash) && hex(c.contentHash)
    && hex(c.importantHash) && typeof c.lastSuccessAt === 'string' && Number.isFinite(Date.parse(c.lastSuccessAt))
    && Object.prototype.hasOwnProperty.call(c, 'coverageAt')
    && (c.coverageAt === null || (typeof c.coverageAt === 'string' && Number.isFinite(Date.parse(c.coverageAt))));
}

function decide({ view, checkpoint, legacyHash, lastAttempt, routine, now }) {
  const valid = validCheckpoint(checkpoint), accountMatches = valid && checkpoint.accountHash === view.accountHash;
  if ((accountMatches && checkpoint.contentHash === view.contentHash)
      || (!valid && legacyHash === view.contentHash)) return { upload: false, reason: 'unchanged' };
  if (!routine) return { upload: true, reason: 'manual' };
  if (!valid || !accountMatches || !hex(view.accountHash)) return { upload: true, reason: 'checkpoint-unknown' };
  const last = Date.parse(checkpoint.lastSuccessAt), age = now - last;
  if (!Number.isFinite(now) || age < 0 || age >= INTERVAL_MS - INTERVAL_GRACE_MS) return { upload: true, reason: 'interval-or-clock' };
  if (!plainObject(lastAttempt) || lastAttempt.httpStatus !== 200) return { upload: true, reason: 'retry-or-unknown' };
  if (view.unhealthy) return { upload: true, reason: 'health' };
  if (checkpoint.importantHash !== view.importantHash) return { upload: true, reason: 'important-change' };
  const nextCoverage = view.coverageAt === null ? null : Date.parse(view.coverageAt);
  const sentCoverage = checkpoint.coverageAt === null ? null : Date.parse(checkpoint.coverageAt);
  // A backward or newly unknown watermark must not leave the public page
  // claiming coverage that the collector can no longer substantiate.
  if (sentCoverage !== null && (nextCoverage === null || nextCoverage < sentCoverage))
    return { upload: true, reason: 'coverage-regressed' };
  if (nextCoverage !== null && (sentCoverage === null || (nextCoverage > sentCoverage && now - sentCoverage >= COVERAGE_HEADROOM_MS)))
    return { upload: true, reason: 'coverage-headroom' };
  return { upload: false, reason: 'routine-batch' };
}

function cli() {
  const [mode, payloadFile, planFile] = process.argv.slice(2);
  const state = name => path.join(ROOT, 'state', name);
  if (mode === 'plan') {
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    const view = inspect(payload, read(state('dashboard.json')), read(state('account_identity.json')), read(state('dashboard_upload.json')));
    const checkpoint = read(state('ops_upload_checkpoint.json'));
    let legacyHash = null; try { legacyHash = fs.readFileSync(state('ops_upload.hash'), 'utf8').trim(); } catch {}
    const lastAttempt = read(state('ops_upload.json'));
    const result = decide({ view, checkpoint, legacyHash, lastAttempt, routine: process.env.BG_LOCKED === '1', now: Date.now() });
    fs.writeFileSync(planFile, JSON.stringify({ ...view, version: 1 }));
    process.stdout.write(result.upload ? 'upload' : 'skip');
  } else if (mode === 'commit') {
    const view = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    if (view.version !== 1 || !hex(view.accountHash) || !hex(view.contentHash) || !hex(view.importantHash)
        || !(view.coverageAt === null || (typeof view.coverageAt === 'string' && Number.isFinite(Date.parse(view.coverageAt))))) throw Error('invalid upload plan');
    const checkpoint = { version: 1, accountHash: view.accountHash, contentHash: view.contentHash,
      importantHash: view.importantHash, coverageAt: view.coverageAt, lastSuccessAt: new Date().toISOString() };
    atomic(state('ops_upload_checkpoint.json'), checkpoint);
    atomic(state('ops_upload.hash'), view.contentHash);
  } else throw Error('invalid policy mode');
}
if (require.main === module) {
  try { cli(); } catch { console.error('operations upload policy unavailable'); process.exitCode = 1; }
}
module.exports = { inspect, validCheckpoint, decide, INTERVAL_MS, COVERAGE_HEADROOM_MS };
