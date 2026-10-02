#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
const p = (s) => path.join(ROOT, 'state', s);
const command = process.argv[2];
fs.mkdirSync(p(''), { recursive: true });
if (command === 'start') {
  const context = { runId: randomUUID(), startedAt: new Date().toISOString(), dryrun: process.env.DRYRUN === '1' };
  fs.writeFileSync(p('run_context.json'), JSON.stringify(context));
} else {
  const context = JSON.parse(fs.readFileSync(p('run_context.json'), 'utf8'));
  const event = { ...context, at: new Date().toISOString(), type: command };
  if (command === 'end') event.status = process.argv[3];
  if (command === 'actions') {
    const result = JSON.parse(fs.readFileSync(p('act_results.json'), 'utf8'));
    event.results = result.results;
    event.phase = process.argv[3];
  }
  fs.appendFileSync(p('run_events.jsonl'), JSON.stringify(event) + '\n');
}
