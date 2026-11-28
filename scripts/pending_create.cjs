'use strict';

// A prepared record is safe to clear only when it is bound to one concrete
// creation attempt. Older, malformed or issued create records are uncertain.
function createIntentState(entry) {
  if (!entry || entry.kind !== 'create' || entry.phase === 'acknowledged') return null;
  const bound = ['intentId', 'planId', 'runId', 'accountKey']
    .every(key => typeof entry[key] === 'string' && entry[key].trim() === entry[key] && entry[key].length > 0);
  const validId = typeof entry.intentId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(entry.intentId);
  return entry.phase === 'prepared' && bound && validId ? 'prepared' : 'unknown';
}

function samePreparedCreate(entry, expected, accountKey) {
  return createIntentState(entry) === 'prepared' && entry.accountKey === accountKey &&
    ['intentId', 'planId', 'runId'].every(key => entry[key] === expected?.[key]);
}

module.exports = { createIntentState, samePreparedCreate };
