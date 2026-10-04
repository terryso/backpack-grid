// Absolute preload path remains valid after runner tests change into fixture checkouts.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = path.join(__dirname, 'no_network.cjs');
for (const suite of ['regression.cjs', 'acceptance.cjs', 'safety_acceptance.cjs','hardening_extra.cjs','verified_window.cjs','stop_budget.cjs','campaign_volume.cjs']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }, timeout: 90000,
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
