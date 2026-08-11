# POOL-045／046 生产发布与业务验收证据

- 日期：2026-08-11（Asia/Shanghai）
- GitHub `main`／生产候选：`ffd2b31c1809569b38e60fa65f0cc2baf818f4ea`
- POOL-045 提交：`1b15819`（修复额度耗尽错误合同）
- POOL-046 提交：`ffd2b31`（修复智谱工作日时段门禁与计费规则）
- Mac Mini release：`/Users/stephen/releases/qianliu-zhisuan-pool045046-ffd2b31-20260811-174036`
- 上一 release：`/Users/stephen/releases/qianliu-zhisuan-pool042-0dd283e-20260810-191440`
- 发布脚本 SHA-256：`ab3f0fc037f8ff886b98de68b8a45edb0a2a43270fa3ca119dfbbd20b7e8635c`
- 发布日志：`/Users/stephen/logs/qianliu-zhisuan/deploy-pool045046-ffd2b31-20260811-174036.log`

## 发布事实

1. 两个问题保持独立提交、测试和双审，随后按同一受控发布批次进入 GitHub `main`；Mac Mini
   使用既有 GitHub SSH 身份拉取同一完整 SHA，没有使用本地未提交工作树替换生产候选。
2. 发布前数据库精确处于 `0044_operating_bill_model_identity`；预检确认仅有 1 条目标旧 alias
   策略、0 条目标新 alias 策略和 2 个目标全周计费版本。
3. 停写后生成并验证 PostgreSQL 备份：
   - 路径：`/Users/stephen/backups/qianliu-zhisuan/pre-pool045046-20260811-174036.dump`
   - SHA-256：`bff34cfe77a7c102db2d51446bd8204627469f0abff8f79fb13ca88e0e127795`
4. 数据库由 `0044` 升至 `0045_zhipu_weekday_window_alias`；迁移后精确断言：新 alias 策略 1 条、
   旧 alias 目标策略 0 条、两条智谱计费版本均为工作日窗口，且无非法全周窗口残留。
5. Control API、Gateway、Web 均为 HTTP 200，Worker healthy；Control API、Gateway、Worker、Web
   与 Caddy 均运行当前 release 镜像，重启数为 0；公网 Gateway health 与管理页分别返回 200。

## POOL-045 验收

- 最终候选真实 PostgreSQL／Stub 定向回归 `w18-quota-pipeline.test.ts`：23/23 PASS。
- 额度耗尽稳定返回 HTTP 429、`insufficient_quota`、`retryable: false`、
  `额度不足，请联系管理员`，不带 `Retry-After`。
- Stub 上游调用、`upstream_attempt`、`usage_event` 和成功账本均为 0；额度计数器不增加，
  请求失败事实为 `DOWNSTREAM_AUTH_OR_QUOTA / insufficient_quota`。
- 发布前已通过正式额度规则恢复王涛工作：Kimi 额度 `80,000,000`、智谱额度 `60,000,000`，
  均不允许超额；DeepSeek 保持 `100,000,000`。发布后生产页只读复核仍为 3 个厂商、6 个正式模型，
  Kimi 已用 `65,057,665 / 80,000,000`，智谱已用 `50,453,193 / 60,000,000`。

## POOL-046 验收

- 最终候选真实 PostgreSQL／Stub 定向回归 `w16-dispatch.test.ts`：10/10 PASS；迁移专测 1/1 PASS。
- 工作日 13:59:59 和 18:00:00 可用；14:00:00 与 17:59:59 返回 HTTP 403、
  `dispatch_rejected`、`retryable: false`、`14:00-18:00暂停使用`；周末不误拒绝。
- 被拒绝请求的 Stub 调用、`upstream_attempt`、`usage_event`、`ledger_line` 和额度扣减均为 0。
- 生产页面刷新后只读核验：已发布 `v2` 策略模型为 `ql-glm-5.2`，时段为
  `工作日 Asia/Shanghai 14:00–18:00`，动作 `REJECT`、优先级 10；`zhipu-peak-v1 / 5.2`
  与 `zhipu-peak-v2 / glm-5.2` 两条 ×3 规则均显示为工作日，不再显示每天。

## 双审与门禁边界

- Gateway 独立审核：PASS，无 P0/P1/P2/P3 Finding。
- 0045 与发布脚本独立审核：PASS；5 个相关真实 PostgreSQL 测试、`bash -n`、ShellCheck、
  `git diff --check` 均通过，无 P0/P1/P2/P3 Finding。
- 候选合入后定向复跑：Gateway 33/33、0045 迁移 1/1 PASS。
- GitHub Actions `31478152148` 在既有 coverage ratchet 编排处失败：未生成
  `apps/gateway/coverage/pool040-gateway/coverage-summary.json`。该错误与前一主线提交 `7ec225b`
  的失败完全相同，发生在 POOL-045／046 定向测试已通过之后，属于既有 CI 编排缺口，不是本次产品回归。

## 结论

POOL-045／046 的代码、独立双审、GitHub 主线集成、Mac Mini 发布、数据库迁移、服务健康和生产
配置只读核验均已完成。两个问题允许关闭；既有 POOL-040 coverage ratchet 生成顺序缺口应独立处理，
不得倒算为 POOL-045／046 功能失败。
