# 修复暂停与续做记录

暂停日期：2026-10-03。用户准备关电脑，明确要求先暂停，稍后继续。

## 当前状态

- 工作目录：`/Users/nick/CascadeProjects/backpack_grid`；分支 `master`；基线提交 `73a55d7`。
- 本轮修复尚未完成最终验收，修改均保留在工作区，未提交、未推送、未部署。
- 四个本地 launchd 服务均已卸载：`com.backpack.grid-monitor`、`com.backpack-grid-peak`、`com.backpack-grid-history`、`com.backpack-grid-research`。恢复工作时先检查实际状态，验收前不要直接恢复定时执行。
- 本地暂停不会停止交易所现有网格。最后只读巡检确认四格具有原生 TP=10、SL=6、closeOnStop=true；关机期间本地巡检、权益峰值采样与本地熔断执行暂停。
- 本轮没有创建实盘测试网格，也没有手动执行真实账户的交易动作。

## 已实施但仍须复审

账户登录用户与子账户绑定、共享数据校验器、创建配置完整读回、实时持仓与保证金校验、执行进程存活凭据、轮次/计划/结果绑定、行情故障降级、分析缓存配置绑定、SQLite 成交存储与补采、归因账本账户隔离。

新增 `scripts/manual_pause.cjs` 提供本地显式暂停意图；新增 `scripts/collect_attribution.mjs` 保存只读历史来源。这两项是在最近一次完整测试之后新增，不能视为已全面验收。

`config.json` 中巡检页面 spaceId 从 42 改为 51 及数组格式变化是本轮开始前已有修改；保留，不随意提交或撤销。

## 已取得证据及边界

- `/tmp/bg-hardening-tests.log`：247 项通过（原回归 151、验收 66、安全 13、附加 17）；此结果不覆盖随后新增的手动暂停与归因采集代码。
- `/tmp/bg-ego-runtime-probe.log`：真实 ego 运行器执行生产 act，外部写入全部为 mock；创建确认、意图释放、结果记录通过。
- `/tmp/bg-ego-cancel-probe.log`：真实 ego 运行器下终止临时执行者，后续模拟写入被阻止，监督进程记录 aborted。
- `/tmp/bg-hardening-dryrun.log`：真实账户只读 observe→decide、仪表盘上传读回通过；未执行实盘 act。
- `/tmp/bg-hardening-history.log`：SQLite 历史重建仍未完成，不可宣称成交历史完整。
- `/tmp/bg-attribution-sources.log`：历史资金费、利息、持仓、入金、出金来源分页已采集；来源完整分页不等于账户范围及净收益归因已确认。

日志位于临时目录，可能被系统清理。最终验收必须针对当时工作区重新运行，不能仅引用上述结果。

## 恢复后的必要步骤

1. 确认用户要求继续；重读 git 状态及当前差异，保留未完成修改。
2. 检查最新源码语法，完整运行 `tests/run.cjs`，补充手动暂停、归因采集及新交互路径测试。
3. 独立复审账户绑定、stop/protect/create、执行凭据、未知创建结果、观察降级和 SQLite 游标/汇总；发现问题继续修复。
4. 完成成交历史回补与深度补采，核对账户范围、不可变成交、游标及汇总。
5. 按源码变化需要复验真实 ego mock 与取消探针；运行真实只读 dry-run，核验仪表盘快照与线上展示。
6. 通过软件验收后更新原审查文档，按授权完成部署及读回，再恢复必要定时服务。准确区分工作区、提交、线上及策略有效性。

## 尚缺的事实与数据

- 534.70 USD 初始权益对应的准确日期时间。
- 从该时刻起的入金、出金和子账户转账是否完整、如何归属。已向用户询问，尚未获得答案。
- 历史净收益归因和长期样本外策略有效性不能用软件测试通过代替，也不能补造数据或基准时间。

原始 `state/attribution_sources.json` 含私密账户数据，保持忽略，不放入 docs、Git 或公开仪表盘。Python 调用统一使用 `/Users/nick/.browser-use-env/bin/python3`；浏览器操作统一使用 ego-browser skill。
