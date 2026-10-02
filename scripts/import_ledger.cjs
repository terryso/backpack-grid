#!/usr/bin/env node
// Import reconciled exported cashflows/funding/interest/rewards; never assumes missing = 0.
const fs = require('node:fs');
const path = require('node:path');
const { validateLedger } = require('./accounting.cjs');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
if (!process.argv[2]) throw new Error('usage: import_ledger.cjs <reconciled-export.json>');
const incoming = validateLedger(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (incoming.subaccountId !== (cfg.subaccountId || 3)) throw new Error('ledger subaccount mismatch');
const target = path.join(ROOT, 'state/attribution_ledger.json');
let old = { events: [], coverage: {} };
try { old = validateLedger(JSON.parse(fs.readFileSync(target, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const events = new Map(old.events.map((e) => [e.id, e]));
for (const e of incoming.events) {
  if (events.has(e.id) && JSON.stringify(events.get(e.id)) !== JSON.stringify(e)) throw new Error('immutable event ID conflict: ' + e.id);
  events.set(e.id, e);
}
const merged = validateLedger({ subaccountId: incoming.subaccountId, events: [...events.values()], coverage: { ...old.coverage, ...incoming.coverage } });
fs.writeFileSync(target + '.tmp', JSON.stringify(merged, null, 2));
fs.renameSync(target + '.tmp', target);
console.log('ledger imported:', events.size, 'events; coverage is caller-reconciled, not inferred');
