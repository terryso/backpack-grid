G01 网格时长生命周期修正（候选补丁，待确认）

基线：78f06b43ecc8e3161991f978e7c0a9d49440bb07。独立 worktree：/Users/nick/.codex/worktrees/grid-age-lifecycle/backpack_grid，分支 codex/grid-age-lifecycle。

问题：网格 A 曾由系统成功创建，后来成功停格；若同币种由人工重建而没有新的自动建格事件，现有 latestCreates 仍保留旧创建时间。生产 dashboard_data.cjs 的临时 fixture 实测把新网格显示成“3 天 0 小时”，正确结果应为未知（页面显示“—”）。

修改：按已记录的生命周期动作维护锚点，done=true 的 stop 清除旧创建时间；只有后续 done=true 的 create 才重新起算。失败或外账户的 stop 不清除本账户锚点。交易策略、资金、止盈止损参数、实际动作执行及原事件文件均不改变。

验证：完整禁止网络的 npm test 455/455 通过；grid_age 8 个场景，其中新增四个覆盖确认停格、失败/外账户停格，以及真实 dashboard_data.cjs 的未知/重新起算对照。原有断言未移除。基线与补丁对比见 docs/grid-age-lifecycle-2026-10-11/before-after.json；完整测试日志保存在 /Users/nick/.codex/automations/backpack-3/grid-age-lifecycle-2026-10-11/npm-test.log。

边界：本补丁只能依据已记录的成功动作识别生命周期；交易所侧未被系统观察或记录的删除/重建，仍需要额外实例身份或原生开始时间才能可靠区分。本次没有用历史旧记录猜测未知的新开始时间，没有回写真实状态。

合并状态：未合并、未部署，等待用户针对这份补丁确认。按定时巡检的“指标计算属于受保护范围”要求，只交付可审查补丁。运行目录中 scripts/position_age.cjs 和 tests/position_age.cjs 的既有未提交删除保留，未暂存或覆盖。已有 C02 候选未触碰。

回滚：合并前可保留/归档该独立候选，不影响运行目录；若日后合并，需要撤回时仅 revert 本补丁的实现提交并重建仪表盘数据，不删除或重置真实 run_events 等状态。
