#!/bin/bash
# 每日 README 实盘截图：ego 截图 → 缩放 1280 宽 → 有变化才 commit+push（失败非致命，次日重试）。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then . ./.env; fi
export BG_ROOT="$PWD"
export PATH="${NODE_BIN:+$(dirname "$NODE_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
bash scripts/ego_dispatch.sh scripts/capture_dashboard_shot.mjs || { echo "capture failed — keep old image"; exit 1; }
RAW=state/dashboard_shot_raw.png
[ -s "$RAW" ] || { echo "shot missing — keep old image"; exit 1; }
sips --resampleWidth 1280 "$RAW" --out docs/dashboard.png >/dev/null || exit 1
git add docs/dashboard.png
if git diff --cached --quiet docs/dashboard.png; then echo "screenshot unchanged"; exit 0; fi
git commit -m "docs: 每日实盘截图同步 $(date -u '+%F')" docs/dashboard.png || exit 0
git push origin master || echo "push failed — will retry tomorrow"
