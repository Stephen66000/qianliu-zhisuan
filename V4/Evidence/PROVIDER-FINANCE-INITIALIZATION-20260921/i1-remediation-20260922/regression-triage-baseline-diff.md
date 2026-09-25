# 回归三分类（baseline diff）记录 — 整改提交 94482f0

> 目的：回答一个问题——**新 HEAD 上的失败，是本轮 I1 整改引入的，还是本就存在的？**
> 结论先行：**本轮整改引入的失败 = 0。** 全部 22 项失败在整改前的父提交 `7c2e5ca` 上原样存在。
> 方法：对同一组测试文件，在 `7c2e5ca`（整改前）与 `94482f0`（整改后）两侧用**完全相同**的
> 命令各跑一次，产出 vitest JSON 报告，再对**失败测试集合**做差集（不比对汇总计数）。
> 运行日期：2026-09-22。执行方：本候选整改方。

## 0. 环境与方法

| 项 | 值 |
|---|---|
| worktree | `/Users/mac/Projects/仟流智算-provider-finance-init-20260921` |
| 整改后 HEAD | `94482f06e5ac69a80357b6e17b9786f7690265c4` |
| 整改前基线 | `7c2e5ca1d21a6805660516ed387e532a13b406b7`（`94482f0^`） |
| 切换方式 | `git switch --detach 7c2e5ca` → 跑基线 → `git switch codex/provider-finance-initialization-20260921` → 跑变更 |
| 相同命令 | `vitest run --config ../../vitest.config.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=json --outputFile=<out.json> <同一组文件>` |
| 判定口径 | `NEW`（仅整改后失败）= 回归，须修；`UNCHANGED`（两侧同失败）= 既有，不在本轮修复范围；`FIXED`（仅整改前失败）= 波动信号 |
| Docker | 可用（Server 28.0.1），Testcontainers 真实起库 |

## 1. 全量单测门禁的原始结果（未做三分类前）

官方入口 `node scripts/run-bounded-vitest.mjs`（等价于 `quality` 链中的 `test`）在 `94482f0` 上的结果：

| 分组 | 结果 |
|---|---|
| 01 非 web 各包（adapters/domain/database/control-api/gateway/worker/…） | **2 fails / 8 passes** —— 失败包 = `packages/database`、`apps/gateway` |
| 02 web（`apps/web`） | **518 / 518 通过**（82 文件） |

> 注：该脚本在命令 01 非 0 退出时即 `process.exit`，故命令 02（web）不会自动执行，本记录单独补跑。

## 2. `packages/database` — A/B 结果

失败的 17 个文件全部位于 `src/__tests-integration__/`，**与本次整改提交改动的文件集无交集**
（本提交在 database 包只新增 `src/repositories/provider-finance-resource-enablement.ts` 与拆分
`src/index.ts` → `src/exports/*.ts`，未触碰任何 `__tests-integration__` 文件）。

| 侧 | 汇总 | NEW | FIXED | UNCHANGED |
|---|---|---|---|---|
| `7c2e5ca`（整改前，17 文件） | 92 tests / **20 failed** | — | — | — |
| `94482f0`（整改后，同 17 文件） | 92 tests / **20 failed** | **0** | **0** | **20** |

**套件级状态逐条一致**：17 个 suite 在两侧的 `status` 与各自 failed 计数完全相同（含
`exception-center-contract.integration.test.ts` 的 55 tests / 0 failed / suite=failed 采集期错误，
两侧同形）。即不存在「同一 suite 内失败用例互换」这种被汇总计数掩盖的情况。

### 2.1 20 项既有失败的成因分类

| 类别 | 数量 | 机制 | 代表 |
|---|---|---|---|
| **A. 迁移头数字断言链** | 12 | 断言 `migrateDown(db) === "<某个历史迁移>"`，head 被追加迁移改变后第一项即失配，后续整链错位 | `resource-fact-reconciliation-migration:63` `expected '0079_provider_finance_candidate_draft' to be '0072_admin_roles_security'` |
| **B. 迁移台账列表深比较** | 3 | 断言迁移清单长度/内容，条目数随新迁移增长而失配 | `runtime-admin-release-rehearsal:107` `expected ['0067_admin_cleanup', …(12)] to deeply equal […(5)]` |
| **C. 数据/性能口径断言** | 5 | 与迁移编号无关的独立失配 | `standard-home:263` `expected '280' to be '200'`；`standard-home:898` `expected '' to contain 'API_USAGE_COST_UNKNOWN:1'`；`w20-standard-capacity:281` P95 实测 1305ms > 1000ms 预算；`pool042` `monthlyTotalTokens` 失配 |

### 2.2 归属：这些失败是「本候选自己的迁移」造成的，不是上游基线红

- 失败断言的**期望值**是各功能自己的末端迁移号（`0072_admin_roles_security`、`0077_...`、`0073_credential_chat_probe`），
  **实测值**统一是 `0079_provider_finance_candidate_draft`；
- 迁移头对照：`ca533e3d`（本候选切入的 kimi 基线）= **0077**；`94482f0` = **0079**
  —— `0078_provider_finance_activation.js` / `0079_provider_finance_candidate_draft.js`
  是**本资金增量自己新增**的迁移（非 kimi 侧、非本轮整改）；
- 因此 A/B 两类失败的引入时点在 `ca533e3d` 之后的**资金增量提交**，早于本轮整改。
- **边界声明**：本轮整改提交 `94482f0` 未新增、未修改任何迁移文件（`packages/database/migrations/` 零改动），
  故对上述失败无因果贡献。本轮**未复跑** `ca533e3d` 侧以进一步定位到具体是哪一次资金增量提交引入
  （不改变「非本轮整改引入」这一结论，登记为待办）。

## 3. `apps/gateway` — A/B 结果

| 侧 | 汇总 | NEW | FIXED | UNCHANGED |
|---|---|---|---|---|
| `7c2e5ca`（整改前，单文件） | 9 tests / **2 failed** | — | — | — |
| `94482f0`（整改后，同文件） | 9 tests / **2 failed** | **0** | **0** | **2** |

- 失败文件：`src/__tests-integration__/pool043-operating-bill-settlement.test.ts`
- 失败断言：`api_cost` 期望 `null`、实测 `"0.00000000"`（两例同因），位于 `:840`、`:1047`
- 其余 42 个 gateway 测试文件（323 tests）在 `94482f0` 上全部通过。

## 4. 判定与处置

**判定：本轮 I1 整改提交 `94482f0` 未引入任何回归。**

| 包 | 既有失败 | 本轮引入 |
|---|---|---|
| `packages/database` | 20 | **0** |
| `apps/gateway` | 2 | **0** |
| 其余 9 个非 web 包 + web | 0 | **0** |
| 合计 | 22 | **0** |

**处置（按规范：既有失败登记、不擅自改测试为绿）**：

1. 上述 22 项**不在本轮 I1 整改范围**（本轮范围是 I1 报告 F-P1-1～F-P1-7）；
2. **不修改**任何失败测试的断言以求得绿色——A/B 已证明其为既有失败，改断言会掩盖真实问题；
3. 该 22 项失败与 WP06/WP07/WP08 自述的「集成测试全绿」**不一致**：I1 报告 §6 已将
   Testcontainers 集成测试列为 Evidence Gap（审核环境 Docker 不可用、未能独立证实）。
   本轮在有 Docker 的环境实测后，该 Gap 的结论是：**这些集成用例并非全绿**。
   这构成对「WP06/WP07/WP08 自述全绿」的实质反证，需单独立项裁决（A 类需按「迁移追加即失配」
   的既有惯例统一整改或登记豁免；C 类需逐项定位）。
4. 本候选若能通过 `ca533e3d` 侧复跑进一步把 A/B 失败钉到具体资金增量提交，应作为独立 Finding 登记。

## 5. 环境备注

- 集成套件每文件各起一个 Testcontainers Postgres，`--maxWorkers=1` 串行；整包 database 全量
  运行约 13 分钟。本记录使用**同一份显式文件清单 + 同一命令**在两侧运行，避免并发差异影响判定。
- `w20-standard-capacity` 的 P95 性能断言（实测 1305ms vs 1000ms 预算）在串行低并发下仍有失配，
  属**确定性**失配而非负载抖动（两侧一致失败），按既有失败登记。
