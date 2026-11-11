# WP3 S6 回执：全量复跑与收尾证据

实施：glm-flash；日期：2026-11-03；基线＝S2～S5 工作树（未提交）。**S6 补充授权后追加一处测试头适配（见 §1.1），除此之外零代码/迁移改动。**openspec：`OPENSPEC_TELEMETRY=0 openspec validate simplify-api-cost-and-official-balance --strict --no-interactive` → **"Change 'simplify-api-cost-and-official-balance' is valid"**。

## 1. 全量结果表（包×命令×用例数×结果×与 WP2 基线差）

| 包 | 命令 | 结果 | WP2 基线 | 差值解释 |
|---|---|---|---|---|
| config | `pnpm test` | **15/15 绿** | （WP2 未单列） | +3＝S2 新增 P1/P2/P3 读取器用例 |
| domain | `pnpm test` | **22 文件 411/411 绿** | 409/409 | +2＝S5 两个 reason 常量用例（精确吻合） |
| provider-adapters | `pnpm test` | **22 文件 398/398 绿**（940s） | （WP2 未单列） | 900s+ 为 `real-slow-stream` 真实本地 HTTP 慢流用例设计使然（300s 空闲窗口×3），非卡死 |
| worker | `pnpm test` / `test:integration` | **36 文件 200/200** ＋ **3 文件 10/10 绿** | 199/199 | +1＝S2 runner 用例 2→3；集成 3 文件为静默套件（S2 时钟适配） |
| gateway | `pnpm test`（含集成） | **51 文件 411/411 绿** | 250/250 | **执行口径差非回归**：WP2 数字来自分层 pool 配置子集；本次为默认 vitest.config 全包含。git 证伪：`git status apps/gateway` 零改动，且 HEAD 含 WP2——测试集不可能凭空增 161 |
| database | `pnpm test` / `test:integration --maxWorkers=4` | 全量 **114 文件 834/836**；集成子集 **81 文件 589/591**（§1.1 修复后复跑：**836/836 ＋ 591/591 全绿**） | 569/570 | 执行口径差（全包含 wp3 五个新套件约 +17 用例＋上游增量）＋2 失败（1 已修复复绿，1 flake 隔离复绿） |
| control-api | `pnpm test` / `test:integration` | 全量 **66 文件 482/482**；集成子集 **43 文件 359/359** | 475/475 ＋ 352/352 | +7/+7＝S3 刷新 http 6 用例＋S4 列表字段 1 用例（精确吻合） |

**失败清单（初始 2，均非业务回归；其中 1 项已按补充授权修复并复绿）**：
1. `w20-standard-capacity.integration.test.ts` P95（resourceUtilizationP95 1019.4ms > 1000ms 阈值）——负载相关 flake：全量电池尾段复现，隔离复跑三次＝红（1019ms）→红→冷却 90s 后**绿 2/2**。与 WP1/WP2 同款（WP2 记录"隔离 2/2 绿，CI 自裁"）。
2. `provider-finance-activation-migration.integration.test.ts` "0094 down 恢复种入触发器"——**确定性失败，根因（WP2 测试头钉死）**：断言 `expect(rolledBack).toEqual(["0094_…"])` 钉死回滚数组恰为一项；现迁移尾含 0096/0095，`rollbackTo` 实际返回三段。**回滚链本身执行完全正确**（三段 down 全部成功落到 0094）。

### 1.1 补充授权修复（S6 后追加，2026-11-03）

授权范围：仅该测试头适配。修复 diff（`packages/database/src/__tests-integration__/provider-finance-activation-migration.integration.test.ts:389-395`）：

```diff
       // 回退 0094：down 逐字恢复 0081 种入触发器（参照 rollbackTo 链式回退模式）。
+      // WP3：迁移尾演进至 0096 后回滚链为 0096→0095→0094 三段（rollbackTo 语义
+      // 不变——链末必为 0094；头不写死，同 migration-rollback.ts 既有约定）。
       const rolledBack = await rollbackTo(db, "0094_retire_api_finance_pending_admission");
-      expect(rolledBack).toEqual(["0094_retire_api_finance_pending_admission"]);
+      expect(rolledBack.at(-1)).toBe("0094_retire_api_finance_pending_admission");
+      expect(rolledBack).toContain("0096_official_balance_refresh_request");
+      expect(rolledBack).toContain("0095_official_balance_sync_decouple");
```

修复后该套件全量复跑：**6/6 绿**（含正控制"down 后种入行为恢复"与反控制"重放 0094 后停止"——语义断言全部执行且通过）；database 包 typecheck＋lint 0 错误。database 全量口径更新：`pnpm test` 114 文件 **836/836**（0 失败）；集成子集 81 文件 **591/591**（0 失败）。

## 2. 七包 typecheck＋lint

config / domain / provider-adapters / database / gateway / worker / control-api：`tsc --noEmit`＋`eslint --max-warnings=0` **全部 0 错误**。

## 3. 范围外终查（文件×归属阶段×允许依据）

| 文件 | 阶段 | 允许依据 |
|---|---|---|
| packages/config/src/index.ts ＋ __tests__ | S2 | S2 合同 §1（P1/P2/P3 读取器） |
| apps/worker/src/provider-operating-sync/runner.ts ＋ runner.test.ts | S2/S3 | S2 §2（解耦/门禁/0095 同批）＋S3 裁定 5（共享原语消费） |
| apps/worker/…/provider-finance-quiescence-worker.integration.test.ts | S2 | S2 合同允许"对应测试文件"适配（时钟推进，静默断言原样，已追认） |
| packages/database/migrations/0095_…/0096_…（新建） | S2/S3 | 裁定 A＋S3 §1（本包迁移编号 0095 起） |
| packages/database/src/repositories/official-balance-refresh-repository.ts ＋ official-balance-sync-writes.ts ＋ official-balance-states.ts（新建） | S3/S4 | S3 §2/裁定 5＋S4 合同（C2 读取） |
| packages/database/src/kysely.ts ＋ index.ts | S3/S4 | 表类型注册＋导出（S3/S4 允许范围） |
| apps/control-api/src/providers/official-balance-routes.ts（新建）＋ routes.ts | S3/S4 | S3 §3（requireAuth 端点）＋S4 挂接（GET 列表 official_balance） |
| apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts（新建） | S3/S4 | S3 §6＋S4 §2 |
| packages/database/src/repositories/provider-operating-repository.ts | S5 | S5 §3（官方来源变体读取，加性） |
| packages/database/src/repositories/supply-forecast-repository.ts | S5 | S5 §3（API 来源/时效门禁，CP 不变） |
| apps/worker/src/supply-forecast/runner.ts | S5 | S5 §3（P2 注入，database 无 config 依赖） |
| packages/domain/src/supply-forecast.ts ＋ index.ts ＋ test | S5 | S5 §3（reason 枚举最小扩展＋单测，数学不变） |
| packages/database/src/__tests-integration__/pool022… | S5 | S5 §5（夹具按新口径调整＋注明依据，断言不动） |
| wp3 四个集成测试文件（新建） | S2/S3/S4/S5 | 各阶段测试条款 |
| openspec/…/WP3/notes、ops-runbook.md、receipts/、plan.md（总指挥建）、report.md（总指挥建） | S1-S6 | 合同指定输出 |

**保护面证伪（git diff/status 实测）**：0000-0094 迁移零改动（status 仅 ？? 0095/0096 新文件）；`resource-pool-repository.ts` 无 diff（:252-273/:443/:451 逐字未动）；`subscription-renewal/` 零改动；`apps/web/` 零改动；`provider-finance/`（410 区）与 `operating-bills/` 零改动；`providers/contracts.ts` 零改动（WP2 守卫区）；gateway 零改动。

## 4. V4/Evidence 副作用处理

worker 全量电池触发 reporting 渲染副作用 2 次（S6 内）：均为 3 个跟踪文件重渲染＋12 个合成输出——已两次按 WP2 §4.3 先例 `git checkout --`＋`git clean -f` 回置/清理，终态 `git status` V4 计数 **0**。

## 5. 遗留问题清单（移交）

1. ~~待授权修复：provider-finance-activation-migration 回滚数组断言~~ **已按补充授权修复并复绿（§1.1）**。
2. w20 P95 负载 flake：维持 WP1/WP2 处置（隔离复绿，CI 自裁）。
3. gateway 411 vs WP2 250、database 836 vs 569：执行口径差（全包含 vs 分层 pool 子集）——WP6/验收如需逐池对照请以本回执口径为准。
4. S3 遗留③（手动刷新占 P1 节奏）已裁定维持；insights 15min 硬编码保留依据已记录（S5）；dispatch 全来源已裁定移交 WP4/WP5 观察（S5 审核确认）。
5. 浏览器/联调锚点（AT-OAB-01/03/07/08/09/10 展示、AT-OAB-11 联调）未填 PASS，待 WP4/WP5。
