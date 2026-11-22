import * as patterns from './patterns.js';

// One Durable Object owns the hourly counter and its unacknowledged event.
export class DirectionMailbox {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method === 'GET') {
      const value = await this.ctx.storage.get('state');
      return Response.json(value || { advice: null, pending: null });
    }
    if (request.method !== 'POST') return new Response('method', { status: 405 });
    const input = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      const prior = await this.ctx.storage.get('state') || { advice: null, pending: null };
      const snapshot = input.snapshot;
      const now = Date.now();
      const snapshotAt = Date.parse(snapshot?.updatedAt);
      const direction = snapshot?.direction;
      // A Mac may be offline for hours. The snapshot carries only the last
      // known direction/version; its age must not stop fresh market judgments.
      // The local transaction checks that version again before acting.
      if (snapshot?.dataValid !== true || !Number.isFinite(snapshotAt) || now - snapshotAt < -60000 ||
          !['Long', 'Short', 'Neutral'].includes(direction?.directive) || !/^[a-f0-9]{64}$/.test(direction?.version || '')) {
        return Response.json({ skipped: 'versioned snapshot unavailable', ...prior });
      }
      if (prior.pending) {
        if (direction.lastCloudEvent?.id === prior.pending.id && ['applied', 'conflict', 'expired'].includes(direction.lastCloudEvent.status)) {
          if (direction.lastCloudEvent.status === 'applied' && prior.advice) {
            prior.advice.switchLog = [...(Array.isArray(prior.advice.switchLog) ? prior.advice.switchLog : []).slice(-49),
              { at: prior.pending.at, from: prior.pending.from, to: prior.pending.to, via: 'cloud' }];
          }
          prior.lastAcknowledged = direction.lastCloudEvent;
          prior.pending = null;
          await this.ctx.storage.put('state', prior);
          return Response.json({ ...prior, resolved: true });
        }
        // Never replace an outstanding event or count another judgment on the ack turn.
        return Response.json(prior);
      }
      const hour = Math.floor(now / 3600000);
      if (prior.lastJudgedHour === hour) return Response.json(prior);
      if (!input.metrics || !Number.isFinite(input.metrics.t7) || !Number.isFinite(input.metrics.rangePos)) return Response.json({ skipped: 'market data unavailable', ...prior });
      const rec = patterns.judge(input.metrics, direction.directive);
      const at = new Date(now).toISOString();
      const { advice, switching } = patterns.nextAdvice(prior.advice, rec, direction.directive, at);
      advice.source = 'cloud';
      if (typeof input.note === 'string') advice.note = input.note;
      if (input.ref && typeof input.ref === 'object') advice.ref = input.ref;
      // Older clients must not act on a non-durable legacy flag during rollout.
      advice.switchingObserved = false;
      advice.verdict = rec === direction.directive ? `维持 ${rec}` : `${rec} (streak ${advice.streak}/${patterns.SWITCH_THRESHOLD})`;
      const pending = switching ? { id: crypto.randomUUID(), at, from: direction.directive, to: rec, version: direction.version } : null;
      const next = { ...prior, advice, pending, lastJudgedHour: hour };
      await this.ctx.storage.put('state', next);
      return Response.json(next);
    });
  }
}
