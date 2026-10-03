#!/usr/bin/env node
// Static UI traffic does not invoke Workers. Fallback is a dated PUBLIC snapshot,
// shown explicitly as degraded; credentials are never copied into the build.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'cloudflare/public');
fs.mkdirSync(dir, { recursive: true });
let snap = null;
try { snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/dashboard.json'), 'utf8')); } catch {}
const html = fs.readFileSync(path.join(ROOT, 'cloudflare/dashboard.html'), 'utf8')
  .replace('const fmt =', `window.__SNAPSHOT_FALLBACK__ = ${JSON.stringify(snap).replace(/</g, '\\u003c')};\nconst fmt =`);
fs.writeFileSync(path.join(dir, 'index.html'), html);
fs.copyFileSync(path.join(ROOT, 'cloudflare/assets/backpack-icon.png'), path.join(dir, 'backpack-icon.png'));
console.log('static dashboard built; fallback timestamp:', snap?.updatedAt || 'unavailable');
