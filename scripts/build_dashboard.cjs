#!/usr/bin/env node
// Static UI traffic does not invoke Workers. Fallback is a dated PUBLIC snapshot,
// shown explicitly as degraded; credentials are never copied into the build.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.env.BG_ROOT || path.join(__dirname, '..');
const dir = path.join(ROOT, 'cloudflare/public');
fs.mkdirSync(dir, { recursive: true });
let snap = null;
try { snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/dashboard.json'), 'utf8')); } catch {}
let ops = null;
try { ops = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/ops.json'), 'utf8')); } catch {}
const inject = (html, value) => html.replace('const fmt =', `window.__SNAPSHOT_FALLBACK__ = ${JSON.stringify(value).replace(/</g, '\\u003c')};\nconst fmt =`);
fs.writeFileSync(path.join(dir, 'index.html'), inject(fs.readFileSync(path.join(ROOT, 'cloudflare/dashboard.html'), 'utf8'), snap));
// ops.html 的降级变量复用同一个注入点（页面里读 __OPS_FALLBACK__，构建后由下面一行改名）
const opsHtml = inject(fs.readFileSync(path.join(ROOT, 'cloudflare/ops.html'), 'utf8'), ops)
  .replace('window.__SNAPSHOT_FALLBACK__', 'window.__OPS_FALLBACK__');
fs.writeFileSync(path.join(dir, 'ops.html'), opsHtml);
fs.copyFileSync(path.join(ROOT, 'cloudflare/assets/backpack-icon.png'), path.join(dir, 'backpack-icon.png'));
fs.copyFileSync(path.join(ROOT, 'cloudflare/assets/campaign-history.json'), path.join(dir, 'campaign-history.json'));
console.log('static dashboard built; fallback timestamp:', snap?.updatedAt || 'unavailable',
  '; ops fallback:', ops?.updatedAt || 'unavailable');
