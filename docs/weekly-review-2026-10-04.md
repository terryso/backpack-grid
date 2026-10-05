# 每周代码与验收复核 — 2026-10-04

更新（2026-10-05）：用户已批准，修复已随 `6201b0c` 合入并推送至 master。最新运行验收见 [合并与运行记录](rollout-2026-10-05.md)；下文保留审查当时的状态与证据。

本轮结论：确认 1 项新的执行入口配置传递缺陷。隔离补丁及离线验收完成；未合并、未上线。当前生产轮次与采集服务正常，没有将离线故障注入当成已发生的线上事故。

## 基线、并行工作与范围

- 主目录：`20addee24df7f3bd842111c71ec6c4516448e5f8`；开始检查时工作树干净。
- 已读最新项目审查、最终验收记录及每日 automation 审查游标。本轮重点为近期 `316ede7` 环境迁移后的高风险交互：launchd → 内核锁 → runner → Node → Python 风控 writer。
- 每日 C01 活动量补丁 `a7420cc` 尚待用户确认。本轮复用它的报告，不改动其 worktree，不重复报告其问题。
- 每日记录中的 S01 当时只是“解释器变量可能未导出”的疑点；本轮用生产 runner 反例确认，升级为 W01。
- 补丁 worktree：`/Users/nick/.codex/worktrees/weekly-interpreter-contract/backpack_grid`。

## W01 / P2：指定 Python 未传递给风控写入子进程

`run_round.sh` source `.env` 只创建 shell 变量。模板和当前配置的 `PY_BIN` 都不带 `export`，Node 子进程看不到该变量。`decide.cjs` 因此选择其 `python3` 默认值，而不是配置的 `/Users/nick/.browser-use-env/bin/python3`。

完整反例从未经改写的 `round_locked.sh` 启动，经过真实 `with_lock.py`、`run_round.sh` 和 `decide.cjs`。初始环境特意去掉 PY_BIN/NODE_BIN，模拟 launchd 的最小环境；fixture 的 `.env` 配置正确解释器。实际风控调用仍为 `python3`。测试在 spawn 边界拦截了这个错误命令，**没有执行系统 Python**。

如目标机默认解释器不兼容或不可用，原路径会报 `RISK WRITE FAILED`，禁止新风险但使风控写入无法正常提交。当前运行摘要显示真实风险写入成功，因此这是已证实的配置错配，不是已证实的线上风控中断。

补丁只在 runner source 配置后增加 `export PY_BIN NODE_BIN`，使 Node 子进程继承已配置的机器路径。它不改变预算、交易信号、锁协议或账本公式。本补丁保证“已配置路径被传递”，不扩张为“未配置的所有手动 CLI 入口都已覆盖”。

## 行为验收

新增 `tests/env_propagation.cjs`，接入现有生产验收套件。全部状态在临时 fixture；浏览器输出和上传边界是 mock。只有指定 Python 执行真实内核锁与风控 writer；Node 网络禁止器全程有效，真实 act 未运行。

10 项新增检查覆盖正常轮次与熔断轮次：

- 风控 spawn 使用完整指定路径，PY_BIN/NODE_BIN 均传入 Node。
- 风险 writer 在 fixture 成功提交，写入状态为 ok。
- dry-run 不执行交易，计划身份仍绑定 fixture 账户。
- 轮次结束后真实内核锁可重新获取。
- 健康状态不误熔断，亏损状态持久保存熔断锁存。

完整 `npm test`：**337/337**，包括 151 回归、80 生产行为验收、27 安全场景、38 契约/存储、28 核算/研究及 13 止损预算场景。没有降低断言或删除失败用例。`bash -n scripts/run_round.sh` 和补丁 `git diff --check` 通过。

| 复核领域 | 本轮检查与证据 | 边界 |
|---|---|---|
| 账户、计划、结果绑定 | 复核 contracts、act 与 run_events 的 accountKey/runId/planId/哈希检查；现有生产 mock 套件重跑；新增 runner 检查身份保持 | 没有切换真实账户 |
| 执行与异常恢复 | 复核 write-ahead、未知创建结果锁存、停止后确认平仓、保护失败闸门；既有 mock 场景通过 | 未注入交易所实盘网络故障 |
| 锁、执行者存活 | 复核共享 flock 和执行 lease；已有进程级测试重跑；新增完整入口验证锁释放 | 不声称覆盖任意远程执行树 |
| 数据与净收益核算 | 复核严格数值、baseline/source 哈希、账户身份、历史覆盖、消失支付拒绝及快照重放；现有 fixture 核算套件通过 | 不推断历史资料已补齐或策略盈利 |
| 历史游标与研究缓存 | 复核 SQLite 事务、同账户原始 fills/游标、analysis 的 schema/配置哈希/身份/新鲜度；存储及缓存场景重跑 | 未手动触发生产采集 |
| 仪表盘与部署入口 | 复核显式 Wrangler 配置、上传鉴权及 updatedAt/generatedAt 读回；当前生产上传读回正常 | 本轮无 UI 改动、无部署；不重复做浏览器视觉验收 |

## 证据与复验

- `weekly-review-2026-10-04/before.log`：基线反例，实际 `python3` 与预期完整路径不一致。
- `weekly-review-2026-10-04/focused-after.log`：10 项 runner 行为通过。
- `weekly-review-2026-10-04/full-test.log`：337 项完整离线验收。
- `weekly-review-2026-10-04/evidence.json`：脱敏机器摘要。

```bash
PATH="/Users/nick/.nvm/versions/node/v22.14.0/bin:$PATH" \
  PY_BIN=/Users/nick/.browser-use-env/bin/python3 npm test
```

worktree 的忽略配置由 `config.example.json` 构建，`.env` 仅提供解释器路径；不复制真实身份或凭证。

## 未完成项与发布边界

1. W01 已修并验收，但执行入口属于 heartbeat 指定的受保护范围，需用户针对这份结果确认后才能合并/上线。
2. 每日 C01 补丁继续待确认；两份补丁各自基于同一主目录基线，应在将来获准合并时重新检查最新 HEAD、并行修改并做组合回归。当前没有提前合并候选或恢复停用服务。
3. 本轮没有新增策略参数或长期收益结论；现有活动后复盘任务保留。本轮证据只支持上述生产路径和已执行用例，不支持“全项目没有任何问题”的无限范围结论。

提交标识与审查游标保存在 automation 的本地审查记录。当前未合并，无需回滚运行目录；未来若批准合并后需要撤回，使用 `git revert <本补丁提交>`，禁止 reset/stash/强推或覆盖并行工作。
