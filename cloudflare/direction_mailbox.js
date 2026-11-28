// The existing Durable Object is the sole writer and durable mailbox for directions.
const CHAINS = ['BTC', 'ETH', 'SOL', 'BNB', 'SUI', 'HYPE', 'TRX'];
const MAPPING = {
  '偏多': 'Long', '偏空': 'Short', '中性': 'Neutral', '中性偏空': 'Short', '中性偏多': 'Long',
  Long: 'Long', Short: 'Short', Neutral: 'Neutral',
};
const MAX_AGE = 2 * 3600 * 1000;
const error = (message, status = 400) => Response.json({ error: message }, { status });
const stateResponse = state => Response.json(state, { headers: { 'cache-control': 'no-store' } });

function normalizeSnapshot(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['asOf', 'chains'].includes(k))) throw Error('expected asOf and chains');
  // An explicit UTC timestamp avoids local-time ambiguity and JS date normalization.
  if (typeof input.asOf !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.asOf)) throw Error('invalid asOf');
  const ms = Date.parse(input.asOf);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== input.asOf.slice(0, 19) ||
      ms > now + 60000 || now - ms > MAX_AGE) throw Error('asOf is invalid, in the future, or more than two hours old');
  if (!input.chains || typeof input.chains !== 'object' || Array.isArray(input.chains) ||
      Object.keys(input.chains).length !== CHAINS.length || CHAINS.some(c => !Object.hasOwn(input.chains, c))) {
    throw Error('chains must contain exactly BTC, ETH, SOL, BNB, SUI, HYPE and TRX');
  }
  const chains = {};
  for (const chain of CHAINS) {
    const entry = input.chains[chain];
    const judgment = typeof entry === 'string' ? entry : entry?.judgment;
    const mapped = typeof judgment === 'string' && Object.hasOwn(MAPPING, judgment) ? MAPPING[judgment] : null;
    if (!mapped || (typeof entry !== 'string' && (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(k => !['judgment', 'direction'].includes(k)) ||
        (Object.hasOwn(entry, 'direction') && entry.direction !== mapped)))) {
      throw Error('invalid judgment or mismatched direction for ' + chain);
    }
    chains[chain] = { judgment, direction: mapped };
  }
  return { asOf: new Date(ms).toISOString(), chains };
}

export class DirectionMailbox {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname === '/state') {
      return stateResponse(await this.ctx.storage.get('state') || { advice: null, pending: null });
    }
    if (request.method !== 'POST' || !['/snapshot', '/ack'].includes(pathname)) return error('not found', 404);
    let input;
    try { input = await request.json(); } catch { return error('invalid JSON'); }
    return this.ctx.blockConcurrencyWhile(async () => {
      const prior = await this.ctx.storage.get('state') || { advice: null, pending: null };
      if (pathname === '/ack') {
        const snapshot = input?.snapshot, direction = snapshot?.direction;
        const at = Date.parse(snapshot?.updatedAt);
        if (snapshot?.dataValid !== true || !Number.isFinite(at) || at > Date.now() + 60000 ||
            !['Long', 'Short', 'Neutral'].includes(direction?.directive) ||
            !/^[a-f0-9]{64}$/.test(direction?.version || '')) return stateResponse(prior);
        const ack = direction.lastCloudEvent;
        if (!prior.pending || ack?.id !== prior.pending.id || !['applied', 'conflict', 'expired'].includes(ack?.status)) return stateResponse(prior);
        if (prior.pending.type !== 'chain_snapshot' && ack.status === 'applied' && prior.advice) {
          prior.advice.switchLog = [...(Array.isArray(prior.advice.switchLog) ? prior.advice.switchLog : []).slice(-49),
            { at: prior.pending.at, from: prior.pending.from, to: prior.pending.to, via: 'cloud' }];
        }
        prior.lastAcknowledged = ack;
        prior.pending = null;
        await this.ctx.storage.put('state', prior);
        return stateResponse({ ...prior, resolved: true });
      }
      let normalized;
      try { normalized = normalizeSnapshot(input, Date.now()); }
      catch (e) { return error(e.message); }
      const last = prior.advice?.snapshot;
      if (last?.type === 'chain_snapshot') {
        if (Date.parse(normalized.asOf) < Date.parse(last.asOf)) return error('asOf is older than the accepted snapshot', 409);
        if (normalized.asOf === last.asOf) {
          if (JSON.stringify(normalized.chains) !== JSON.stringify(last.chains)) return error('asOf already used with different directions', 409);
          return stateResponse(prior);
        }
      }
      const event = { type: 'chain_snapshot', id: crypto.randomUUID(), at: new Date().toISOString(), ...normalized };
      // A full newer snapshot supersedes an unacknowledged older event. The
      // advice retains it after ack, so a restored Mac can recover.
      const next = { ...prior, advice: { at: event.asOf, source: 'external', type: event.type, snapshot: event }, pending: event };
      await this.ctx.storage.put('state', next);
      return stateResponse(next);
    });
  }
}
