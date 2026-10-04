---
name: backpack-grid-ops
description: Backpack 网格巡检系统（~/CascadeProjects/backpack_grid）的运维操作——启动/停止/重启定时巡检、部署或更新线上仪表盘、手动跑巡检与测试、处理 OBSERVE_FAILED / ACT_FAILED / 熔断等故障。当用户要求管理 backpack_grid 项目、看巡检状态、启动定时服务、部署网页时使用。
---

# Backpack 网格巡检运维

项目根：`/Users/nick/CascadeProjects/backpack_grid`（下述命令默认在此目录执行）。
完整架构与参数见项目 `README.md`；本文件只放操作步骤与坑。

## 环境要点（先读）

- 机器本地解释器路径在仓库根 `.env`（不提交，模板 `.env.example`）：PY_BIN、NODE_BIN；shell 入口自动 source，测试经 `tests/env.cjs` 读取
- ego-browser 的 Node 进程不继承 cwd/env：被派发脚本内机器相关值写成 `__BG_ROOT__`／`__PY_BIN__` 占位符，由 `scripts/ego_dispatch.sh` 注入后经 stdin 派发。手动派发一律用 `bash scripts/ego_dispatch.sh scripts/xxx.mjs`，**不要直接 `ego-browser nodejs <`**
- `act.mjs` 加载 `act_core.cjs` 用 `createRequire(path.join(ROOT, "scripts/act.mjs"))` 锚定——**不要改回 `import.meta.url`**（ego-browser 运行器里是 eval 产物，会 MODULE_NOT_FOUND）
- wrangler 需要 Node ≥22：`export PATH="$(dirname "$(grep '^NODE_BIN' .env | cut -d= -f2)"):$PATH"` 或直接 source .env（grep 的 ^ 模式务必加引号，zsh 下裸 ^ 会被当 glob 展开）
- 给用户看的汇报**禁止使用裸 $ 符号**（聊天界面渲染成公式吞字），金额写 "USD" 后缀
- `state/` 整体 gitignored；任何密钥只进 `state/dashboard.env`；`.env` 同样不提交

## 巡检轮次

```bash
bash scripts/run_round.sh            # 手动跑一轮（入口自锁——被持有时等待45s后跳过exit 3）
DRYRUN=1 bash scripts/run_round.sh   # 空跑：只观察+判定（同样持锁）
PATH="$(dirname "$(grep '^NODE_BIN' .env | cut -d= -f2)"):$PATH" npm test # 离线回归 + 生产行为验收
```

## 定时巡检（launchd，每 15 分钟）

```bash
# 状态 / 立即触发一轮
launchctl print gui/$(id -u)/com.backpack.grid-monitor | grep -E "state|last exit"
launchctl kickstart gui/$(id -u)/com.backpack.grid-monitor
# 启动（重启同理）
launchctl bootout gui/$(id -u)/com.backpack.grid-monitor 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.backpack.grid-monitor.plist
# 停止定时
launchctl bootout gui/$(id -u)/com.backpack.grid-monitor
```

日志：`state/launchd.log`（执行层）、`state/log.md`（每轮摘要）。
注意：launchd 只负责**执行**；ZCode 定时任务只负责读文件汇报。两者靠 run_round.sh
的内核 flock 防重。

排障：ZCode 定时任务"已工作 1 秒"无输出 = ZCode 会话层问题（常见于套餐额度耗尽），
与本机执行无关；换绑定模型或新聊天重建定时任务。

## 仪表盘（Cloudflare Worker + KV）

```bash
# 地址与密钥
# 仪表盘公开读取；不要输出 state/dashboard.env 中的上传凭证
# 改了页面(cloudflare/dashboard.html)或接口(worker.js)后部署：
. ./.env 2>/dev/null || true  # 提供 NODE_BIN
export PATH="$(dirname "$NODE_BIN"):$PATH"
npx wrangler deploy --config cloudflare/wrangler.toml
# 只推最新数据：bash scripts/upload_dashboard.sh
# 本地预览：node scripts/dashboard_data.cjs --preview → state/dashboard_preview.html
# 首次部署/重置密钥：bash scripts/deploy_dashboard.sh（依赖 wrangler OAuth 登录）
```

- wrangler deploy **必须带 `--config cloudflare/wrangler.toml`**（曾误吃上层项目配置建错 Worker）
- 改完页面用 390px 移动视口验证无横向溢出（CDP `Emulation.setDeviceMetricsOverride`）
- 403 = dashboard.env 的 DASH_WRITE_TOKEN 与 Worker secret 不一致 → 重跑 deploy / secret put

## 常见故障

| 现象 | 处理 |
|---|---|
| OBSERVE_FAILED | 多为 ego lite 浏览器 Backpack 登录态失效或数据不完整（fail-loud 设计）；人工重新登录后下一轮自愈 |
| ACT_FAILED | 读 `state/act_results.json` 定位；`pending_stops.json` 非空 = 有未完成清理，下轮自动重试，期间禁止新开仓 |
| 熔断恢复 | 编辑 `state/risk.json`：保留 `peakEquity`、删除 `paused` 字段 |
| 无 pending 但网格 Disabled 且盈亏未越阈值 | 用户手动暂停，巡检不碰；若盈亏已越阈值会被视为兜底触发而轮换 |
| 仪表盘 403 | 见上节 |

## 纪律

- 改代码后：`npm test` 全绿 → git commit → 需要时再部署仪表盘
- 不要手动开平仓、不要绕过 act 直接调交易所接口、不要动浏览器里的网格
- 观察类操作可随时执行（只读）；执行类操作失败先读 state 文件再重试

## 新增采集与账本

- 所有 Python 命令均使用 `.env` 里的 PY_BIN（本机为 browser-use-env 的 python3）。
- 定时入口由 `scripts/install_launch_agents.py --install` 生成，RunAtLoad=false，不会因重载立刻执行交易。
- 历史成交：`collect_history.sh`，独立 history.lock、独立 Page；`trade_history.json` 保存原始 fill ID 和游标，`fees.json` 为派生汇总。
- 研究候选：`refresh_research.sh`，独立 research.lock，无空槽时也刷新。
- 核对后的出入金／资金费／利息／奖励导入：`node scripts/import_ledger.cjs <export.json>`；见 docs/ledger-import.example.json。覆盖未声明或未追平时不把权益变化称作策略收益。
- 运行次数与停止次数取 run_events.jsonl 的确认事件，从接入之日起计数，不反推旧计划日志。
- 不使用实盘微型网格做故障注入；act 完整入口的控制流通过模拟 session I/O 验证。
