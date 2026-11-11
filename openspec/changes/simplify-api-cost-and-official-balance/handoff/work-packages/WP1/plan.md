# WP1 包计划：同源费用估算读取（tasks 2.1～2.3）

版本：v1.0；日期：2026-11-02；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（串行）。

## 1. 目标与依据

- 目标：建立**不依赖资金账户、期初状态与余额差算法**的同源 API 消费费用估算读取（C1 合同），落地价格依据状态字段（迁移 0093），并将后端各消费聚合读取方对齐到同一费用来源；对应 ACE-01～07 的服务层前提。
- tasks：2.1（同源读取＋价格版本/分项计价保留）、2.2（未知/部分/失败 Attempt/重试/历史处置）、2.3（读取方对齐＋合同文档）。
- 验收 case（本包负责非浏览器部分）：AT-ACE-02/03/04/05/07/08/09/10/12；AT-ACE-05 的"资金账户不存在不影响估算"为核心退出条件。AT-ACE-01/06/11/13/14 含浏览器/联调部分 → 待 WP4/WP5 联调，本包不提前填 PASS。
- 依据：proposal/design（D1/D5）、specs/api-cost-estimation、development-plan §4 WP1、WP0 contracts.md §1 C1/§5、notes/inv-b.md。

## 2. 输入基线与依赖

- worktree：`/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，起点 HEAD `62f12de`（＝`ae506fed…933e`＋两笔纯文档提交 `5b16dd6`/`62f12de`；2026-11-02 核验远端 main 仍为 `ae506fed…933e`，工作树干净，业务实现为零）。
- WP0 依赖（已通过）：contracts.md（C1 合同、P6 参数草案、§5 委派基准）、baseline.md（迁移水位 0000-0092、0093 空闲）、notes/inv-b.md（费用链路事实与移交核实项）。遗留（生产核实 BLOCKED、P1-P6 待确认）不阻塞本包。
- 环境已核验：依赖 frozen-lockfile 安装；Docker 28.0.1 可用（Testcontainers PG17 夹具可跑）；`glm-flash` 子 Agent 类型本会话可用。

## 3. 交付物与允许修改范围

| 交付物 | 允许文件/模块 | 对应 requirement |
|---|---|---|
| 迁移 0093 价格依据状态字段 | `packages/database/migrations/0093_*.js`（新增；不改 0000-0092） | ACE-02 场景3、P6 |
| BillingRule 类型/快照扩展 | `packages/domain/src/billing-rule.ts`、`apps/gateway/src/pipeline/billing.ts`（仅映射＋快照补字段，最小改动） | ACE-02（价格证据） |
| 规则入口承接 source_status | `packages/database/src/repositories/billing-rule-persistence.ts`、kysely 类型、`apps/control-api/src/read-models/billing-rule-contract.ts`＋相关写路由 | ACE-02 场景3 |
| C1 统一聚合入口 | `packages/database/src/repositories/api-cost-estimation.ts`（新增）及必要导出 | ACE-03/04/05/07 |
| 聚合语义（未知/部分/零/处置/重试） | 同上＋测试 | ACE-04/05 |
| 读取方对齐 | `apps/control-api/src/providers/finance-usage-overview.ts`（移除 API remainingQuota 余额覆盖）、`dashboard-repository.ts`、`dashboard-monthly-spend.ts`、`dashboard-home-costs.ts`、`resource-insights/query.ts`、经营账单当前期读取（`operating-bill-draft.ts` 等费用来源切换，关账版本/历史快照不动）、部门/项目/年度聚合核查 | ACE-03/06/07 |
| 测试 | 各触及包的单测/集成测试（database 集成测试入 `src/__tests-integration__/`） | 全部 |
| 合同文档 | `handoff/work-packages/WP1/api-estimation-contract.md`（实际路由/字段/状态语义，供 WP3/WP4/WP5 使用） | C1 落地 |

范围外（禁止触碰）：套餐写入口（routes.ts W5/W6）、0081/0083/0061 触发器语义、官方余额同步与 C2（WP3）、Web 页面/CSV（WP4）、员工月度额度与 0092 相关代码、已关账账单版本与历史快照、`strict_writes_enabled`、resource-pool-repository 准入逻辑（:443/:450/:451 属 WP2）。相邻调用方确需改动时先报总指挥更新本表。

## 4. 总指挥决策（P6 草案落地，WP1 内生效）

1. **字段**：`billing_rule.source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`，CHECK ∈ (`VERIFIED`,`UNVERIFIED`)；存量规则默认 UNVERIFIED（不得宣称为已核实官方价）；`source`（0011 既有自由文本"规则来源"）保留不动，语义＝来源描述，≠核实状态。
2. **聚合返回形状**（C1 细化）：
   - `amounts: Array<{currency, amount}>`——按币种的已知金额（8 位小数字符串），仅 `resource_mode='API'` 行，不混币相加；币种为 NULL 的已计价行不入任何币种桶，计入 `CURRENCY_MISSING` 缺口（与既有"跳过 null 币种、以缺口呈现"口径一致）。
   - `completeness: 'KNOWN_COMPLETE' | 'KNOWN_PARTIAL' | 'ZERO_CONFIRMED'`——只反映金额可知性：任一行未知（UNKNOWN_COST 且未被合法处置排除）或 NOT_MIGRATED → KNOWN_PARTIAL；期间仅有 CONFIRMED_ZERO_NO_UPSTREAM（明确未触上游零费用）→ ZERO_CONFIRMED；全部已计价/已处置 → KNOWN_COMPLETE。
   - `gaps: Array<{reason, count}>`——`PRICE_MISSING`（用量已知缺价格：api_cost_status='UNKNOWN_COST' 且 usage_quality<>'UNKNOWN'）、`USAGE_UNKNOWN`（usage_quality='UNKNOWN'）、`NOT_MIGRATED`、`CURRENCY_MISSING`、`PRICE_BASIS_UNVERIFIED`（信息性：由 source_status='UNVERIFIED' 规则计价的行数；不影响 completeness）。
   - `priceBasis: Array<{ruleId, ruleVersion, sourceStatus}>`——期间内实际计价涉及的规则版本及依据状态。
   - `excludedNoRecordedCost: number`——被既有合法历史处置排除的行数（非缺口，保留处置可追溯，ACE-05 场景2）。
   - 金额列复用 `effectiveReportedApiCostSql`（处置投影权威口径）；对同一 Attempt 重复结算只计一次由既有 dedup/IfAbsent 约束保证，测试须覆盖。
3. **期间归集**：沿用既有消费结算时间口径（候选 `settled_at`，与 `dashboard-home-costs.loadWindowOperatingFinance` 一致）；实施者必须以 file:line 证据核实 ledger_line 期间过滤的既有口径（`settled_at` vs `created_at` 两处并存，见 inv-b §6 移交项），如与候选冲突先报总指挥裁定，不得自行发明新口径。
4. **remainingQuota 覆盖移除依据**：contracts.md C1 约束（"finance-usage-overview.ts:21-26 的 remainingQuota 覆盖行为移除，余额走 C2"）＋ ACE-06（不把货币余额放进 Token/套餐剩余额度）。`consumer-projection.test.ts` 既有断言按新合同调整时须注明此依据并补新用例，不无说明删除。

## 5. 子 Agent 分工与顺序（串行，不并行）

| 序 | 合同 | 内容 | 依赖 |
|---|---|---|---|
| S1 | task 2.1 | 调查（结算落库列/精度/期间口径/规则入口盘点）＋迁移 0093＋domain/gateway 依据链＋C1 聚合入口＋database 集成/单测 | 无 |
| S2 | task 2.2 | 聚合语义补全与定向测试：F02 三元部分合计、F03 0.03 元重试、历史处置不变、CONFIRMED_ZERO、混币分列、重复终态幂等 | S1 |
| S3 | task 2.3 | 读取方对齐（用量总览覆盖移除、首页/资源洞察/经营账单当前期/部门/项目/年度）＋consumer-projection 断言迁移＋合同文档；若体量过大由总指挥拆 S3a/S3b 并更新本表 | S1+S2 |

每份委派含：目标/task/case、基线 SHA、允许文件清单、禁止事项、验收方法（真实测试入口＋非零用例数）、必交证据（diff 摘要、命令与退出码、用例数、剩余问题）、回报格式。子 Agent 不得自审通过、不得扩范围；偏离计划的部分由总指挥退回原 scope。

## 6. 验证方法与完成条件

- 总指挥独立复核：逐 diff 对照本表范围；抽读关键断言；重跑关键命令（database `test:integration`、domain/gateway/control-api 相关 `test`；触及包 `typecheck`/`lint`）；核对非零用例数（根 vitest `passWithNoTests:true` 陷阱）。
- 证据目录：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/`（worktree 内新建；含命令、退出码、用例计数、关键断言摘录）。
- 完成条件（全部满足才勾选 tasks.md 2.1-2.3）：
  1. C1 聚合存在且有集成证据：无资金账户/期初/余额时估算正常产生（AT-ACE-05 服务层）；
  2. ACE-02/03/04/05/07/08/09/10/12 非浏览器部分有自动化证据（金额精确到 8 位、0.00104/3 元/0.03 元等夹具值逐项核对）；
  3. 相同范围/期间/币种的读取方金额可由同一批消费事实核对；混币不相加；
  4. 历史处置、原始用量、规则快照、已关账版本不被改写（回归证据）；
  5. 不删旧断言无依据；范围外文件零改动（`git diff --name-only` 对照）。
- 已知边界：页面/浏览器/导出/通知（WP4）、官方余额（WP3）、资金退役（WP2）、50 条总验收（WP5）——本包证据不得写成端到端 PASS。
