// Absolute preload path remains valid after runner tests change into fixture checkouts.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = path.join(__dirname, 'no_network.cjs');
for (const suite of ['regression.cjs', 'acceptance.cjs', 'safety_acceptance.cjs','hardening_extra.cjs','verified_window.cjs','stop_budget.cjs','campaign_volume.cjs','campaign_period.cjs','dead_grid_safety.cjs','auto_exits.cjs','stop_owner.cjs','auto_ui.cjs','grid_age.cjs','ego_space.cjs','browser_alignment.cjs','collector_pages.cjs','ops_history.cjs','position_roi.cjs','infeasible_gate.cjs']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }, timeout: 90000,
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
