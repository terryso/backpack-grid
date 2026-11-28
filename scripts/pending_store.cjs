// Called only under with_lock.py --name pending. All pending ledger mutations
// use this transaction so an older reader cannot overwrite a newer intent.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pendingStructOk } = require('./state_schema.cjs');
const { samePreparedCreate } = require('./pending_create.cjs');

const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
const target = path.join(ROOT, 'state/pending_stops.json');
const version = raw => raw === null ? 'missing' : createHash('sha256').update(raw).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function read() {
  try { return fs.readFileSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function write(data, durable) {
  // The fixed temporary path is safe because all writers hold the same lock.
  // The issued transition uses an exclusive unique file and syncs both file
  // and directory before it may be sent to the exchange.
  const temporary = durable ? target + '.' + randomUUID() + '.tmp' : target + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, durable ? 'wx' : 'w', 0o600);
    fs.writeFileSync(fd, data);
    if (durable) fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
    if (durable) {
      const dir = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (durable) try { fs.unlinkSync(temporary); } catch {}
  }
}

function issue(request) {
  const raw = read();
  const pending = raw === null ? null : JSON.parse(raw.toString('utf8'));
  if (!pendingStructOk(pending) || Object.keys(pending).length !== 1 ||
      !samePreparedCreate(pending[request.market], request.expected, request.accountKey))
    fail('PENDING_CONFLICT', 'prepared intent changed');
  pending[request.market] = { ...pending[request.market], phase:'issued', reason:'create intent (outcome unconfirmed)' };
  write(JSON.stringify(pending, null, 2), true);
  return { version:version(read()) };
}

function main(request) {
  const raw = read();
  if (request.op === 'issue') return issue(request);
  if (version(raw) !== request.version) fail('PENDING_CONFLICT', 'pending ledger changed');
  if (request.op === 'save') {
    if (!pendingStructOk(request.pending) || Object.values(request.pending).some(e => e.accountKey !== request.accountKey))
      fail('PENDING_INVALID', 'invalid pending ledger');
    const data = JSON.stringify(request.pending, null, 2);
    write(data, request.durable === true);
    return { version:version(Buffer.from(data)) };
  }
  if (request.op === 'quarantine') {
    const flag = path.join(ROOT, 'state/pending_corrupt.json');
    fs.writeFileSync(flag + '.tmp', JSON.stringify({ at:new Date().toISOString(), note:'pending ledger was corrupt and archived; new-risk creation stays blocked until this flag is manually removed after inspecting the archive' }, null, 2));
    fs.renameSync(flag + '.tmp', flag);
    // Never remove the only evidence before a persistent block exists.
    if (raw !== null) fs.renameSync(target, path.join(ROOT, `state/pending_stops.corrupt-${Date.now()}-${randomUUID()}.json`));
    return {};
  }
  fail('PENDING_INVALID', 'unknown pending operation');
}

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify({ ok:true, ...main(request) }));
} catch (error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'PENDING_ERROR';
  process.stdout.write(JSON.stringify({ ok:false, code }));
  process.exitCode = 1;
}
