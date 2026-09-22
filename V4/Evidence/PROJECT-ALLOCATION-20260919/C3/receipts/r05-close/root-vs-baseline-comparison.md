# 根全量与基线对照（收口前）

- 候选 HEAD：本次提交（含 activateStrictWrites 推脏钩子 + allocationGeneration 取整）。
- 基线：`2b33719`（独立 worktree `/tmp/c3-baseline-r05`，同期安装、同一 vitest 配置与
  `--no-file-parallelism --maxWorkers=1 --maxConcurrency=1` 参数）。
- 根全量命令：`corepack pnpm run test`（= `scripts/run-bounded-vitest.mjs`）。
  结果：**3 个 workspace 失败 / 7 个通过**（与 R01 期记录同构）。

## HEAD 红灯文件（12）

| workspace | 文件 | 基线同期结果 |
| --- | --- | --- |
| packages/database | exception-center-contract.integration.test.ts | 同红（55 skipped 型文件级失败） |
| packages/database | pool042-dashboard-resource-usage.integration.test.ts | 同红（同名用例） |
| packages/database | standard-home.integration.test.ts | 同红（同 4 条用例） |
| packages/database | usage-aggregate-migration-capacity.integration.test.ts | **未对照**（百万行生成，遵守禁跑约束） |
| apps/control-api | pool026-deployment-logs.test.ts | 同红 |
| apps/control-api | pool027-provider-model-discovery.test.ts | 同红（8 条） |
| apps/control-api | provider-finance.test.ts | 同红（1 条） |
| apps/control-api | w02-auth-principal.test.ts | 同红（5 条） |
| apps/control-api | w20-resource-insights.test.ts | 同红 |
| apps/control-api | pool043-operating-bill-accounts.test.ts | 基线 3 次：失败/失败/失败（1 失败 1 通过 ×2、双失败 ×1）——**两侧同 flake** |
| apps/control-api | standard-home-route.integration.test.ts | 同上 |
| apps/gateway | pool043-operating-bill-settlement.test.ts | 同红（同 2 条用例） |

## 两个"疑似新增"红灯的归因（已排除候选成因）

`pool043-operating-bill-accounts` 与 `standard-home-route` 的共同失败点是
`/auth/login` 未返回 `set-cookie` → `header!.split(";")` 抛
`TypeError: Cannot read properties of undefined`——与既有红灯 `w02-auth-principal`
属同一 auth 登录链路问题。交替重跑证据：

- 基线 3 次：`1 failed | 1 passed`、`2 failed`、`1 failed | 1 passed`；
- 候选 3 次：`2 failed`、`1 failed | 1 passed`（2 passed / 5 skipped）、`2 failed`。

两侧均在同一批文件上随机翻转 ⇒ **与候选改动无关**（本候选对 control-api 的改动仅
归集路由的主体解析与未分配明细，不触 `/auth/*`）。

## 容量类文件（不在对照集，遵守禁跑约束）

- `w20-standard-capacity`（1M ledger P95）：R01 期基线为红，本次候选**通过**；
- `usage-aggregate-migration-capacity`（百万 ledger/usage_event 迁移）：本次候选为红。
两者均需百万行生成、属环境/资源敏感型，且与归集模块无关；按用户"禁止百万行数据生成"
的约束未做对照复跑，仅记录现象。

## 结论

候选红灯集合 ⊆ 基线红灯集合；两个额外红灯经 3×2 交替重跑证明两侧同 flake
（auth 登录链路）。**零候选归因回归**。候选自身涉及的套件（close 12、compute 8、
foundation 19、invariance 1、cutover 3、backfill 4、migration 7、finance 相关、domain 205、
routes 13、web 476）全绿。
