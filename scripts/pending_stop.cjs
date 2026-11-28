'use strict';
const { isPositionRef } = require('./position_ref.cjs');

const isStopReview = entry => entry?.kind === 'stop_review';
const isOrdinaryTrail = entry => !!entry && entry.kind !== 'create' && !isStopReview(entry)
  && (Object.prototype.hasOwnProperty.call(entry, 'trailPositionRef') || /AUTO_TRAIL/.test(String(entry.reason || '')));
// Version 2 durably writes "issued" before sending. Older prepared records
// cannot prove that the issued transition survived a power loss.
const hasDurablePreparedTrail = entry => entry?.trailIntentVersion === 2 && entry.trailPhase === 'prepared'
  && isPositionRef(entry.trailPositionRef);
const trailWasUnsent = entry => isOrdinaryTrail(entry) && hasDurablePreparedTrail(entry);
const validPendingRisk = entry => entry?.status === 'pending' && typeof entry.reason === 'string' && !!entry.reason.trim()
  && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))
  && ['prepared','disable-issued','disable-acknowledged','delete-issued'].includes(entry.phase);

function previousOutcomeNeedsReview(entry) {
  if (!Array.isArray(entry?.previousRiskStops) || !entry.previousRiskStops.length) return true;
  return entry.previousRiskStops.some(record => {
    if (record?.kind === 'trail') return record.outcome !== 'unsent' || !trailWasUnsent(record.entry);
    if (record?.kind === 'risk') return !validPendingRisk(record.entry) || !(
      (record.outcome === 'unsent' && record.entry.phase === 'prepared') ||
      (record.outcome === 'acknowledged' && record.entry.phase === 'disable-acknowledged'));
    return true;
  });
}

function riskAttemptOutcome(attempt) {
  if (!validPendingRisk(attempt)) return 'unknown';
  if (attempt?.phase === 'prepared') return 'unsent';
  if (attempt?.phase === 'disable-acknowledged') return 'acknowledged';
  return 'unknown';
}

module.exports = { isStopReview, isOrdinaryTrail, hasDurablePreparedTrail, trailWasUnsent, validPendingRisk, previousOutcomeNeedsReview, riskAttemptOutcome };
