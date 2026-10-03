# 本轮修复后的运维与验收边界

## 手动意图

`node scripts/manual_pause.cjs HYPE-PERP hold` 登记该市场暂停自动轮换。
`node scripts/manual_pause.cjs '*' hold` 登记全局暂停自动轮换／新创建。
使用同样的市场名和 `clear` 清除登记；清除消失网格的登记也受支持。

登记使用与巡检相同的 round 内核锁，最多等待 45 秒；锁未取得的非零返回表示登记没有成功。该命令只写本地意图，不关闭交易所网格、不开平仓。账户熔断与已有 pending 清理仍优先执行。正常网格的保护由交易所原生字段执行；登记期间不自动修改保护字段。仪表盘显示暂停意图或损坏状态。

仅在交易所点击 Disabled 仍缺可靠停止原因字段。需要表达持续意图时先登记，不能依赖“当前盈亏越阈值后猜停止原因”的启发式。

## 账户与运行边界

私有 `state/account_identity.json` 固定已核实的登录 userId 和子账户，不自动接受另一登录者。更换账户时先停本地任务，人工核对新授权目标，并隔离旧风险、pending、成交数据库及归因账本；不能直接换 pin 然后继承旧状态。

归属未知的旧 pending 不自动标成当前账户。出现该类告警须检查历史意图与原账户，不能为了恢复开仓直接删除。创建请求响应未知时也不因“暂未找到网格”就解除意图。

浏览器空间不可用时入口会失败，保留 config，不自动另建空间。需要在现有授权空间恢复会话或明确迁移 watch 后再启动。

Python 一律使用 `/Users/nick/.browser-use-env/bin/python3`；Node 使用 22。`npm test` 为禁网络测试；实际交易所失败主要由生产入口的 mock I/O 覆盖。

## 成交与归因

`state/history.sqlite` 是新的账户绑定原始成交库。成交、游标和增量汇总同事务保存；重复填单不再累计，冲突拒绝提交。`trade_history.json` 是小型状态清单，`fees.json` 是派生展示，旧全量 JSON 保存在 `trade_history.pre-binding.json`，没有丢弃。

独立 `collect_history.sh` 回补、重扫并更新失败状态；每次截至采样前 60 秒，短期重扫 1 小时，旧时间段分轮每日再查。已追平不表示交易所不会随后补录更早的成交。

`ego-browser nodejs < scripts/collect_attribution.mjs` 只采集原始历史来源。结果包含账户与行级范围验证状态，不能直接作为“已完整归因”的导入。`import_ledger.cjs` 仅接收核对过的同账户、连续覆盖声明；详见已有 ledger-import 示例。

原始归因来源可能含钱包地址和银行信息，保持在忽略的 state 中，不上传公开快照或加入 Git。

## 服务恢复

四个 launchd 入口可用 `scripts/install_launch_agents.py --install` 重建；RunAtLoad=false，加载不会立即强制交易。主巡检与峰值采样共用 round 锁，history／research 分别使用独立锁。

关机或卸载任务后，交易所网格与原生保护继续运行；本地巡检、采样和本地熔断执行会暂停。恢复必须核验 plist、当前身份、最新观察、pending、风险锁存及软件验收结果。
