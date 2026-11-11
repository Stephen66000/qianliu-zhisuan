# R4 回执：F2 缺分项价不补零＋CONFIRMED_ZERO 过滤器对齐（返修轮 R1）

日期：2026-11-05；执行：glm-flash 子 Agent（R4 实施合同）。基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`（分支 `remediation-r1-f1-f4`，HEAD `686100f`，R2/R3 改动为未提交工作树状态）。本批零迁移、零旧行重算、零主仓写入、未删任何用例。

## 1. 实际改动清单（9 文件，全部在白名单内）

| 文件 | 改动 |
|---|---|
| `packages/domain/src/billing-rule.ts` | `computeApiCostFromRule` 返回类型 `string` → `string \| null`；新增 ABSOLUTE/legacy 适用分项守卫（`cache>0` 缺 hitPrice、`miss=input-cache>0` 缺 missPrice、`output>0` 缺 outputPrice → 返回 null）；MULTIPLIER 抛 `incomplete_multiplier_price` 保留；doc comment 更新（原「缺失分项按 0 处理」措辞移除） |
| `apps/gateway/src/pipeline/billing.ts` | 仅注释（API 分支 :104 前补 F2 传导说明：null→UNKNOWN_COST 结算、反事实 null→NOT_CALCULABLE）；无逻辑改动——`BillingOutcome.apiCost` 本为 `string \| null`，结算链 `pricedApi` 判定（attempt-usage-settlement.ts :78-79）与事务级 `summarizePricingEvidence` 现成吞 NULL |
| `packages/database/src/repositories/api-cost-estimation.ts` | `basis_unverified_rows` FILTER 补 `coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'`（与 priced_rows 口径对齐）；文件头 gaps 语义注释同步 |
| `packages/domain/src/__tests__/api-multiplier.test.ts` | :46-51 重写不删：两处补零预期（0.00008200/0.00001800）→ null 断言＋注释注明依据（R1 阻断 C 裁定）；:50 MULTIPLIER 零倍率抛错原样保留 |
| `packages/domain/src/__tests__/billing-rule.test.ts` | 新增 2 用例：F2 验收场景（三项价齐→0.00104000；缺 hitPrice(cache=600>0)→null 不补零 0.00044000）；适用分项判定（缺 missPrice/outputPrice→null） |
| `apps/gateway/src/pipeline/attempt-usage-settlement.test.ts` | 新增 1 用例：缺适用分项价结算 UNKNOWN_COST＋api_cost/currency NULL＋billing_rule_id/rule_version/快照（含缺失价 null）仍冻结 |
| `apps/gateway/src/pipeline/billing-evidence.test.ts` | 反事实 NOT_CALCULABLE `it.each` 矩阵新增 1 条：`baseline_not_comparable`＋`baselineRule=缺 missPrice 的 ABSOLUTE 规则`（inv-r1 风险 3 保守化断言） |
| `packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts` | 套件 d 预期回改（见 §3）；新增 c2/F2 用例（UNKNOWN_COST＋快照冻结缺失价行 → PRICE_MISSING、金额不含该行、不进 priceBasis）；文件头覆盖清单同步 |
| `packages/database/src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts` | §1.5 预期回改（见 §3） |

未触碰：R2/R3 已改的其他文件（contracts/双滤三处/official-balance-states/provider-operating-repository/runner）、迁移、e2e spec、web。

## 2. 命令＋退出码＋用例数（日志见 logs/15~22）

| 步骤 | 命令（corepack pnpm@11.11.0） | 退出码 | 用例 |
|---|---|---|---|
| typecheck | `--filter @qianliu/{domain,gateway,database,control-api,worker} run typecheck` | 全 0 | — |
| domain 全量单测 | `--filter @qianliu/domain run test` | 0 | 413/413（基线 411＋新增 2） |
| gateway 单测（exec vitest 定向） | `src/pipeline/attempt-usage-settlement.test.ts src/pipeline/billing-evidence.test.ts`（log 15） | 0 | 19/19（10+9，各＋1 新用例） |
| gateway 集成（R3 基线集） | `wp2-pending-admission.test.ts w13-billing.test.ts`（log 16） | 0 | 7/7（=R3 基线） |
| database 下游（R3 基线 11 文件＋estimation） | operating-analysis / standard-home / finance-period-cost-integrity / provider-finance-cutover / wp2-finance-mode-parity / usage-overview / pool042-dashboard-resource-usage / api-cost-readers-alignment / wp2-cross-month-attribution / api-cost-draft-model-alignment / api-cost-estimation-attempts / api-cost-estimation（log 17） | 0 | 97/97（=R3 83＋estimation c2 新用例；含 R3 i-a/i-b 原样通过） |
| control-api 下游（R3 基线集） | dashboard-finance-estimation / resource-insights-api-cost-evidence（log 21） | 0 | 4/4 |
| worker（R3 基线集） | provider-operating-sync/runner.test.ts（log 22） | 0 | 4/4 |
| lint | domain/gateway/database `run lint`（eslint --max-warnings=0） | 全 0 | — |
| X06 脚本 | 见 §4 | 0 | 26 行/15 端点/待裁定 0 |

环境事实（与 WP5 S2B 回执一致）：集成测试需 `DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock`＋`TESTCONTAINERS_RYUK_DISABLED=true`（本机 docker context=colima，`/var/run/docker.sock` 指向未运行的 Docker Desktop；colima 不支持挂 socket 进 ryuk）。
运行方式备注：`pnpm run test -- <files>` 在 pnpm@11.11.0 下把 `--` 原样透传 vitest 致文件过滤失效（log 15/16 初次误跑全套已如实留痕）；定向复跑改用 `pnpm exec vitest run --config ../../vitest.config.ts <files>`。

## 3. CONFIRMED_ZERO 两处预期回改确认（R3 → R4 裁定 b）

1. estimation 套件 d（仅 CONFIRMED_ZERO → ZERO_CONFIRMED）：R3 曾按字面语义预期 `PRICE_BASIS_UNVERIFIED:1`；R4 回改为 `expect(result.gaps).toEqual([])`，注释注明依据＝总指挥采纳裁定 (b)（basis_unverified_rows 补 CONFIRMED_ZERO_NO_UPSTREAM 排除——零确认行恒快照 NULL、无价格依据语义）。实测通过。
2. attempts §1.5（零费用与未知并存）：R3 曾预期 `[USAGE_UNKNOWN:1, PRICE_BASIS_UNVERIFIED:1]`；R4 回改为 `[USAGE_UNKNOWN:1]`，注释同上。实测通过。
其余 R3 预期（套件 b/e/f、i-a/i-b 的 UNVERIFIED 计数）不涉 CONFIRMED_ZERO 行，原样保留且全部通过（estimation 文件 14/14）。

## 4. 四条实测摘要

**a) 验收复现场景（R1 阻断 C）**：
- 三项价齐：domain 新用例 `computeApiCostFromRule({hit:0.000001, miss:0.0000001, output:0.000002}, 1000, 200, 600)` → `"0.00104000"`（F01 规范公式 (600×1+400×0.1+200×2)/1e6），不变。
- 缺 hitPrice（cache=600>0）：同用量 → `null`；不再产出 0.00044000（=40+400 补零产物，验收指认反例）。
- 结算链：settlement 新用例实测落 `api_cost=NULL＋api_cost_currency=NULL＋api_cost_status=UNKNOWN_COST`，且 `billing_rule_id/rule_version/快照`（含 cacheHitPrice:null 原始证据）仍冻结。
- 聚合链：estimation c2 新用例实测该行形 → `PRICE_MISSING:1`、`amounts` 不含该行金额（仅已知 1.00000000）、`priceBasis` 不含该规则行。

**b) cache=0＋hitPrice 缺失（不适用分项）**：billing-rule.test.ts 既有「decimal 精度」用例（hitPrice:null＋cache=0）原样保留并通过（41.97530850）；domain 全量 413/413 无回归——不适用分项缺价不影响计价的行为不变。

**c) 既有断言更新**：api-multiplier :48/:49 重写为 null 断言（不删，注明依据）；w13-billing :128-143 与 billing-rule 全价用例未改且通过；billing-evidence「无可用价格」用例（三价全 null 规则被 matchPriceRule 过滤→ruleId null）未改且通过。其余套件按 §2 复跑全绿，未发现额外需改断言。

**f) dispatch saving 保守化**：billing-evidence `it.each` 新增 `baseline_not_comparable` 条目——反事实基线规则缺 missPrice（miss=800000>0，ABSOLUTE）→ `counterfactualCost=null` → `saving={NOT_CALCULABLE, baseline_not_comparable}`、`dispatchSaving=null/savingCalculable=false`。实测通过（log 15，9/9）。

**e) X06 金额链影响评估（隔离栈复跑）**：
- 栈：`x06-f2-pg`（postgres:17-alpine，**127.0.0.1:55433**；55432 被既存 `qianliu-pg` 容器＋ssh 隧道占用，不触碰他人资源，端口偏离如实记录）→ `seed:e2e`（migrateToLatest＋TRUNCATE＋播种，exit 0，enterprise/requestId 与基准一致 `…0001`/`…0030`）→ control-api `CONTROL_API_PORT=8899`（S3b 同款 5 环境变量＋5 特性开关，/health 200）→ 脚本 exit 0。收尾：control-api 已杀（8899 无监听）、容器已删。
- 结果：**26 行核对表、15 端点、待裁定差异 0**；12 个含金额行**逐字一致**（金额值出现次数也一致：3.00104000×20、0.50000000×22、96.00000000×10、137.00104000×2、137.50104000×2、126.00000000×5、8.00000000×9）；资源分解 3 行集合相等（仅组遍历顺序不同，无金额差异）。
- 唯一实质文本差异：基准 gaps `PRICE_BASIS_UNVERIFIED 4→9`（金额无影响）。归因＝**R3 F3 语义**（旧行快照缺 sourceStatus 键按 UNVERIFIED 计；seed 行为直插无快照 → 9 条已计价行全部计入），即 inv-r1 C4 副作用与风险 4 明示的「上线当期计数跳增（诚实但显著）」，**与 F2 及 CONFIRMED_ZERO 过滤器无关**（seed 无 CONFIRMED_ZERO 行，grep 实证）；priceBasis 数组（2 条 UNVERIFIED）与 completeness/amounts 不变。该差异需在 R6 矩阵/资产重装配时更新 X06 基线引用口径。

## 5. 剩余问题

1. X06 基准 PRICE_BASIS_UNVERIFIED 4→9（F3 语义跳增）需 R6 统一口径（§4e）。
2. F2 补零历史旧行仍为 PRICED_USAGE（AFR-06 不重算）；读侧识别口径已在 inv-r1 B5 记录、本轮不实施。
3. `pnpm run -- <files>` 过滤失效为工具链行为（pnpm@11.11.0 透传 `--`），R3 复跑集命令若按同法复现会全量误跑；建议后续轮次统一 `exec vitest` 形式（非代码问题，仅运维提示）。
4. 主目录 `/Users/mac/Projects/仟流智算` 与返修 worktree 为不同分支/检出（本批全部写入返修 worktree）；8899 无残留、55433 栈已清，x06-f2 相关零残留。

## 6. 证据路径（本目录）

- 改动 diff：`git -C /Users/mac/Projects/仟流智算-api-decouple diff -- <9 文件>`（§1 清单）
- 日志：`logs/15-f2-gateway-settlement-saving-unit.log`、`logs/16-f2-gateway-integration.log`、`logs/17-f2-database-downstream.log`、`logs/21-f2-control-api-downstream.log`、`logs/22-f2-worker-runner.log`、`logs/18-f2-x06-seed.log`、`logs/19-f2-x06-control-api.log`、`logs/20-f2-x06-script.log`
- X06 复跑产出：`x06-amount-reconciliation-f2-rerun.md`（对照基线 `../WP5-20261104/x06-amount-reconciliation.md`）
