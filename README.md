# Backpack Grid Autopilot

**[English](README.md) | [中文](README.zh-CN.md)**

An autonomous crypto grid-trading system that designs its own strategy, runs on a **live Backpack perpetual-futures account with real money**, and re-balances itself every 15 minutes — no human in the loop.

<p align="center">
  <a href="https://grid.terryso.dev">
    <img src="docs/dashboard.png" alt="Live dashboard" width="860">
  </a>
</p>

🔗 **[Live dashboard](https://grid.terryso.dev)** — real equity, positions, per-grid health and volume progress, updated every 15 minutes. Public, read-only.

> ⚠️ This is a personal live-trading experiment, not financial advice. Perps trading is extremely risky.

🎁 Running this on Backpack yourself? [Sign up with my referral link](https://backpack.exchange/join/suchuanyi) — it costs nothing extra and supports the experiment.

## What it does

Backpack provides native grid bots with exchange-side protection. This project adds selection, rotation, account risk rules, and recovery around those bots:

- **Runs its own strategy**: scans every USDC perp, scores markets by mean-reversion suitability (multi-window chop × liquidity − drift − funding), and picks up to 4 neutral grids
- **Trades with real money**: ~$590 account, 4 grids, automatic rotation when a grid hits +10% take-profit, −6% stop-loss, exits its range, or drifts near liquidation
- **Protects itself in layers**: exchange-side native backstop on every grid (survives a dead machine) → portfolio-level risk budget → equity-drawdown circuit breaker (40% warn / 80% kill-switch) → write-ahead intent ledger so a crashed process never leaves half-done trades
- **Reports publicly**: a Cloudflare Worker + KV dashboard updated after every round

It has been running unattended for 3+ days: 190+ inspection rounds, 5 autonomous rotations, roughly +10% account growth (includes market drift — see caveats).

## Architecture

No API keys, no trading library — the system drives Backpack through the **same authenticated session the web app uses** (browser-context `fetch` with cookies), executed by a local launchd job every 15 minutes:

```
observe   session-authenticated APIs: grid ledgers, positions, equity, fills
decide    risk gates (breaker / pending-cleanup / backstop reconciliation / orphans)
          → per-grid rules (TP / SL / range-exit / liquidation distance)
          → replacement planning (score gate, ecosystem cap, forward risk budget)
act       validate → create (with native TP/SL written at creation) → verify orders placed
          → on any failure: write-ahead ledger keeps the state recoverable
verify    re-observe; every number in state files is shape-checked, fail-loud
```

Engineering details that survived 8 rounds of adversarial AI code review (~25 real defects found and fixed):

- **Two-phase execution**: risk exits execute immediately; replacement creation waits for a re-observation — a stop is never delayed by market analysis
- **Write-ahead intent ledger**: disable/delete/create intents persist before any exchange write; a lost response can always be recovered
- **Shrink-to-fit risk budget**: if the portfolio stop-loss budget can't fit a full-size grid, it creates a smaller one instead of skipping
- **Kernel flock, whole lifetime**: all entries (scheduled, manual, peak probe) share one `fcntl` lock whose fd is passed to the business child (deeper descendants depend on their runtime) — a killed wrapper can't release the lock while the round is still running; corrupt state files quarantine new risk instead of silently resetting
- **Budget semantics note**: the forward position budget (≤ equity×80%) and the peak-drawdown breaker are two DIFFERENT mechanisms — the former is a nominal constraint that loosens as profits grow, the latter is the true equity-floor guarantee

## Selection logic

Markets are scored by **oscillation suitability** — grid trading earns from round-trips, not trends:

```
score = min(chop, 20) × 0.9 + range24 × 40) × liquidity − drift24 × 25 − funding penalty
chop  = mean(24h path ÷ 24h net drift, 72h path ÷ 72h net drift)   # capped to tame one-day spikes
```

Filters: volume floor, score floor (an empty slot beats a mediocre grid), max 2 grids per ecosystem (no four-correlated-coins blowups), per-grid health badges computed from live distance-to-trigger.

## Honest caveats

- **Small sample.** ~3 days live, 5 rotations, a rising market — the +10% includes drift a flat market wouldn't have given
- **No backtest yet.** Fixed-grid vs. rotation comparison, per-strategy attribution and a proper equity benchmark are the next milestone after the current campaign ends
- **Browser-session auth** means the automation dies if the login session dies — by design (no keys to leak); it fails loud and waits

## Testing

```bash
node tests/regression.cjs   # 110 cases, no network
```

Layer A: pure-logic replicas + source canaries. Layer B: **executes the production code** — decide.cjs runs against sandbox fixtures via `BG_ROOT`, and the grid-stop state machine runs against mocked exchange I/O.

## Operations

Single-command deployment of the dashboard (`scripts/deploy_dashboard.sh`, Cloudflare OAuth), launchd timers for the 15-minute round and the 1-minute peak sampler, full runbook in-repo. See [README.zh-CN.md](README.zh-CN.md) for the complete Chinese operations manual.

## Validation and accounting

Use Node 22 and `npm ci && npm test`. The offline suites forbid network I/O and execute production decisions, complete mocked act/runner lifecycles, history pagination, and state contracts. Kernel locks are tested with real disposable processes. Historical fills and research refresh independently of risk exits.

Equity change is not labeled strategy PnL without reconciled cashflow coverage and an exact baseline timestamp. Run statistics come from confirmed execution events. Static UI requests bypass Workers; a dated, visibly degraded deployment snapshot is shown if dynamic APIs are unavailable. Upload success requires snapshot readback. See [acceptance and outstanding external gates](docs/project-review-2026-10-02.md).

## Support

If this project was useful and you'd like to try Backpack, signing up via my referral link — <https://backpack.exchange/join/suchuanyi> — supports future experiments at no extra cost to you.
