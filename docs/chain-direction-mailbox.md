# 外部分链方向快照

方向写入仍使用现有 dashboard Worker 的 `DirectionMailbox`，Mac 每次成功进入 `decide.cjs` 时从已有的 `/api/direction-event` 拉取。Worker 不再计算或定时生成方向；`*/5 * * * *` 持仓风险哨兵保留，A/B 持仓风险检查不变。原 C 告警依赖旧版五连判定，兼容旧快照，但新分链快照不再产生 streak。方向只影响新格，已有网格继续由原有止盈、止损、出界、熔断和其他退出规则处理。

## 调用方协议

向现有 `DASH_URL` 的 `POST /api/direction-snapshot` 发送 JSON，使用请求头 `x-token: <DASH_WRITE_TOKEN>`；这是现有 dashboard 上传使用的同一凭证。它也能写 dashboard 快照等数据，不是只限方向的权限：仅交给可信调用方，通过密钥管理安全注入，不要写入仓库、日志或命令行参数。响应及 `/api/direction-event`、`/api/direction-advice` 的读取均为公开数据，不要在方向内容中放秘密。

请求示例中的时间必须替换为真实的判定时间：

```json
{
  "asOf": "2026-11-28T03:00:00Z",
  "chains": {
    "BTC":  { "judgment": "偏多",   "direction": "Long" },
    "ETH":  { "judgment": "中性",   "direction": "Neutral" },
    "SOL":  { "judgment": "中性偏空", "direction": "Short" },
    "BNB":  { "judgment": "中性偏多", "direction": "Long" },
    "SUI":  { "judgment": "偏空",   "direction": "Short" },
    "HYPE": { "judgment": "Long",   "direction": "Long" },
    "TRX":  { "judgment": "Neutral", "direction": "Neutral" }
  }
}
```

- `asOf` 必须是 UTC ISO 8601，带秒和 `Z`，可带最多三位小数；服务器允许未来最多 60 秒，拒绝超过 2 小时的判定。
- 必须恰好提供 BTC、ETH、SOL、BNB、SUI、HYPE、TRX 七项；不接受遗漏或额外链。每项可以是上面的对象（`direction` 可省略），也可以直接写字符串，如 `"SOL": "中性偏空"` 或 `"SOL": "Short"`。返回的规范化结果总有 `judgment` 和 `direction`。
- 映射为：偏多 → Long、偏空 → Short、中性 → Neutral、中性偏空 → Short、中性偏多 → Long。也接受 Long、Short、Neutral；如果同时提供 `direction`，必须与判定对应。
- 请求超过 8 KiB、JSON 或字段非法返回 400/413，凭证错误返回 403；比已接收快照更早的 `asOf`、或同一 `asOf` 对应不同内容，返回 409。有效时间窗口内重试相同快照会返回原记录，不产生新事件；过期后重试仍会被拒绝。不同时间的完整新快照可取代尚未确认的旧快照。

例如，把上面的 JSON 保存为本地 `direction-snapshot.json`，并通过安全方式将现有 `DASH_URL` 和 `DASH_WRITE_TOKEN` 注入环境后：

```bash
printf 'x-token: %s\n' "$DASH_WRITE_TOKEN" | \
  curl --fail-with-body --silent --show-error \
    --header @- --header 'content-type: application/json' \
    --data-binary @direction-snapshot.json "$DASH_URL/api/direction-snapshot"
```

不要开启 shell 命令跟踪；调用方应检查 HTTP 状态。成功响应的 `advice.snapshot` 是已接收快照，`pending` 是尚待 Mac 确认的副本；接收成功不代表 Mac 已应用。Mac 写入后在正常 dashboard 上传中返回 `direction.lastCloudEvent`，邮箱仅清除匹配 ID 的待确认事件；看板显示本机已应用方向及未应用的新快照。已确认的完整 advice 仍保留，以便本地状态恢复后重放。网络或上传失败会在后续正常轮次重试。

Mac 首次应用时也检查时间及全部七项；超过 2 小时、未来超过 60 秒或早于本机已应用快照的事件不会覆盖方向。拉取失败、写入失败或快照过期时沿用本机上次已应用方向；已经应用的方向不会仅因变旧自动清除，看板会提示过期。新版本发布后到第一份分链快照实际应用前，仍沿用原本的本地指令；请在启用外部写入后核对本机已应用的七项和时间。

## 继承与优先级

读取端通过 `config.json` 的 `ecosystems` 将市场继承到分链：`btc → BTC`、`eth_l1 → ETH`、`solana → SOL`、`sui → SUI`、`bnb → BNB`、`hyperliquid → HYPE`、`tron → TRX`。七个链币自身也直接使用对应方向。映射到这些生态的市场，以已应用快照为权威，即使旧的单市场指令或全局 `*` 不同也如此；其他市场继续使用单市场指令、全局 `*`、默认 Neutral 的原有顺序。手动指令文件保留，但不会覆盖已覆盖生态的快照。

`requireDirection=true` 时 Neutral 只跳过该市场，并继续检查其他生态的候选；它不会触发已有网格退出。执行层再次检查方向，如果计划后的方向改变或变为 Neutral，该次建格会拒绝并等待重新规划。快照损坏时，已知生态退回 Neutral。

## 合并后的切换步骤

以下是操作说明，本 PR 不执行部署、重载或交易：

1. 在 Mac 的实际运行目录合并本 PR，让五分钟 `com.backpack.grid-monitor` 继续执行 `round_locked.sh → run_round.sh`；新代码仍能处理过渡期的旧全局待确认事件。保留现有 `state/dashboard.env` 和配置，不提交或复制凭证。
2. 停用并移走旧的每小时 `com.backpack-grid-direction` launch agent（新 installer 已不再生成它）；不要停五分钟 monitor。可在 Mac 上执行：

   ```bash
   launchctl bootout "gui/$(id -u)/com.backpack-grid-direction"
   mkdir -p state/retired-launch-agents
   mv ~/Library/LaunchAgents/com.backpack-grid-direction.plist "state/retired-launch-agents/com.backpack-grid-direction.$(date +%Y%m%d%H%M%S).plist"
   ```

   如果旧任务本来未加载，`bootout` 可能提示找不到服务；仍需处理遗留 plist，防止下次登录重新加载。无需重装或重启其他 launch agents。
3. 用项目现有 Cloudflare 发布流程，在明确安排的发布窗口部署 `cloudflare/wrangler.toml` 对应的 Worker；确认只配置 `*/5 * * * *`，并确认 `/api/sentinel` 与 dashboard 正常。部署前先完成 Mac 代码更新，部署后再启用外部快照写入。
4. 发送第一份七链快照后，通过只读 `/api/direction-event` 查看接收状态，等正常 monitor 轮次后查看 dashboard 的七链方向、时间和确认状态。不要为了验证触发交易或手动运行实盘轮次；若状态过期或未应用，检查写入方、Mac 正常轮次和 dashboard 上传日志。
