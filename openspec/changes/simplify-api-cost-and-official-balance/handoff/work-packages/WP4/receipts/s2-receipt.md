# WP4 S2 回执：task 5.1 资源/用量页面（展示层）

实施：glm-flash（WP4-S2 合同）；日期：2026-11-04；基线＝worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD 745dae4＋未跟踪 WP4 文档（未 commit，改动留在工作树）。未运行 e2e（S6）、未写库、未发消息、未真实调用上游（refresh 集成测试走 fetchMock，`official-balance-refresh.http.test.ts:40-41`）。

## 0. 事故披露与已完全恢复的偏差（必读）

实施中途因 bash 相对路径 cwd 解析到主仓 `/Users/mac/Projects/仟流智算`，曾把 10 个文件的编辑误写入主仓工作区。**已当场全部精确回滚**：反向应用替换后逐文件与 `git show HEAD:<path>` 比对，10/10 完全一致（证明这些文件在我误写前是干净的，零数据丢失）；主仓 `git status` 的 apps/packages 下无本事故残留（剩余的 M 文件与未跟踪 e2e helper 均为主仓原有在途内容，未触碰）。随后全部编辑以绝对路径在 worktree 重做并验证。

## 1. 实际改动文件清单（worktree，22 文件，+467/−82）

### 交付 1（C2 类型与 hook 接线）
| 文件 | 改动 |
|---|---|
| `apps/web/src/api/types.ts` | 新增 `ProviderOfficialBalanceState`（形状对齐 `official-balance-states.ts:18-39`，Date→ISO string）与 `OfficialBalanceRefreshResult`（三态）；`ProviderResourceItem` 增加 `official_balance?` 字段 |
| `apps/web/src/api/hooks.ts` | 新增 `useRefreshOfficialBalance(resourceId)`（POST `/provider-resources/:id/official-balance/refresh`，成功后 invalidate `providerResources`；照 quota-sync 模式 hooks.ts:226-236） |
| `apps/web/src/api/diagnostic-types.ts` | `AttemptMetering.billingRuleSnapshot` 补 `sourceStatus?: "VERIFIED" \| "UNVERIFIED"`（gateway billing.ts:147 随结算快照冻结并经 gateway-requests 透出） |

### 交付 2/3（资源列表官方余额列＋快照 title）
| 文件 | 改动 |
|---|---|
| `apps/web/src/components/resources/resource-page-display.tsx` | API 分支重写为 `OfficialBalanceColumn`：官方余额（total_balance+currencyMoney，null→"暂无官方数据"不显 0）、状态主标记（OK 不标注/FAILED 同步失败/EXPIRED 数据过期/NEVER_SYNCED 未同步/UNSUPPORTED 暂不支持/SYNCING 同步中）、`expired`/`last_attempt_failed` 布尔叠加标记、`last_success_at` 最近成功时间、UNSUPPORTED 整区"暂不支持官方余额同步"、受支持资源显示刷新按钮（`next_refresh_at` 非空禁用＋倒计时秒数，纯消费后端字段零硬编码）；删除内部资金三行（D5）与"资金账本未启用"；导出 `OFFICIAL_BALANCE_STATUS_LABEL`；CP 分支零改动 |
| `apps/web/src/components/resources/ResourceTable.tsx` | 列头"资金"→"官方余额 / 订阅"；:91-107 title 提示由旧 operating_sync 余额/费用状态改为消费 `official_balance.status`/`last_success_at`/`last_attempt.reason`；快照版本/时间本体保留 |

### 交付 4（首页资源面板）
| 文件 | 改动 |
|---|---|
| `apps/web/src/components/dashboard/ResourceBreakdown.tsx` | 列头"余额 / 剩余额度"拆为"官方余额"＋"剩余额度"两列（columns 6→7）；API 行官方余额降级"—"（usage-overview 链无 C2 字段，见 §4 数据缺口），删除"余额待补"（AFR-07）；:61 API 缺口措辞改 `API费用估算不可计算（原因）`；CP 剩余额度/费用措辞零改动 |
| `apps/web/src/components/resources/ResourceUtilizationPanel.tsx` | :109 "API 花费不可计算"→"API费用估算不可计算"（ACE-01 命名统一；inv §1.2 列出的展示点） |

### 交付 5/6（命名统一＋币种＋缺口文案）
| 文件 | 改动 |
|---|---|
| `apps/web/src/components/usage/UsageOverviewPanel.tsx` | 指标卡与排名表头 "API 费用"→"API费用估算" |
| `apps/web/src/pages/Usage.tsx` | 明细表头 "API 费用"→"API费用估算" |
| `apps/web/src/pages/RequestDrilldown.tsx` | 结算汇总 label "API 费用"→"API费用估算"（settlement 无行内币种字段→`costMoneyText` 回退 ¥）；计量明细 `· 费用 X 元`→`· 估算 {costMoneyText(apiCost, billingRuleSnapshot.currency)}`；计价决策 "最终费用"→"估算费用"＋行内币种；新增 `priceBasisSuffix`——`sourceStatus==="VERIFIED"` 不标注，否则"（价格依据待核实）"（旧快照缺省按 UNVERIFIED，对齐 billing.ts:146） |
| `apps/web/src/lib/usage-cost.ts` | 新增 `PRICE_MISSING`→"价格缺失"、`PRICE_BASIS_UNVERIFIED`→"价格依据待核实"（信息项，不带"待计价"措辞）、`CURRENCY_MISSING`→"币种缺失"（ACE-04）；新增 `costMoneyText(value, currency)`（单币种金额展示，无币种回退 ¥/CNY，不跨币种相加） |

### 交付 7（control-api 展示投影收口）
| 文件 | 改动 |
|---|---|
| `apps/control-api/src/resource-insights/routes.ts` | `projectFinanceUtilization` API 分支：资金读模型兜底整体退出——`?? account?.monthlyApiCost`、账户 currency 覆盖、balanceState 门控、`"0.00000000"` 充值兜底串全部移除，改为 `{ ...resource, currentBalance: null, purchaseCashAmount: null }`（apiCost/currency 与预算利用率由基础行 `applyApiBudgetFacts` 按 C1 同源估算计算，finance 开/关双路同源同值）；**CODING_PLAN 分支零改动** |
| `apps/control-api/src/resource-insights/query.ts` | `ResourceUtilizationRow.purchaseCashAmount: string`→`string \| null`（类型同步；web `v2-types.ts:137` 本已是 `string \| null`，无需改） |

### 测试（交付 8）
| 文件 | 改动 |
|---|---|
| `apps/web/src/components/resources/resource-page-display.test.tsx` | API 三行断言迁移（注明 D5/AFR-07 原因）；新增 8 用例：OK/FAILED 保鲜值不显 0/EXPIRED/FAILED＋expired 叠加/NEVER_SYNCED 暂无官方数据/UNSUPPORTED 无刷新入口/SYNCING 叠加/冷却禁用消费 `next_refresh_at`/点击调刷新端点/official_balance 缺省降级 |
| `apps/web/src/pages/Resources.test.tsx` | hooks mock 补 `useRefreshOfficialBalance`；"资金账本未启用"断言迁移（AFR-07）为"暂无官方数据" |
| `apps/web/src/components/dashboard/ResourceBreakdown.pool042.test.tsx` | 列头断言迁移为"官方余额"＋"剩余额度"；cell 索引右移（注明拆列原因）；API currentBalance 断言迁移为"—"且断言 `余额待补`/内部金额不再出现 |
| `apps/web/src/components/resources/ResourceUsageOverviewPanel.test.tsx` | 列头断言迁移同上 |
| `apps/web/src/lib/usage-cost.test.ts` | 新增三分支断言＋`costMoneyText` 5 组断言（CNY/无币种回退/USD/EUR） |
| `apps/web/src/components/usage/UsageOverviewPanel.test.tsx` | 新增命名断言（指标卡＋表头"API费用估算"，旧名不存在） |
| `apps/web/src/pages/RequestDrilldown.test.tsx` | 新增 3 用例：结算汇总命名＋¥ 回退；行内币种 USD＋UNVERIFIED 角标；VERIFIED 无角标 |
| `apps/control-api/src/provider-finance/consumer-projection.test.ts` | 首用例断言迁移（注明 WP2 遗留②/AFR-07）：资金账户 498.4/600 不再进入 API 行，currentBalance/purchaseCashAmount 恒 null，基础行估算字段透传 |
| `apps/control-api/src/__tests-integration__/provider-finance.test.ts` | utilization 断言迁移：`currentBalance: "65.00000000"`→`null`（注明资金账户投影退役） |

## 2. 实际命令与用例数

| 命令（均在 worktree 根执行） | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/web run test` | **95 文件 / 756 用例全绿**（首跑曾 1 例无关抖动：ProviderFinanceActivationWizard（S3 域，未触碰）失败，单独跑与两次全量复跑均通过；最终两轮全量 756/756） |
| `corepack pnpm@11.11.0 --filter @qianliu/web run typecheck` | **src 0 错误**；剩 6 个错误全在 `e2e/global-setup.ts`/`e2e/wt-web.spec.ts`——即 inv-wp4 §7.2 记录的基线缺陷（wt-web.spec.ts import 5 个从未提交进本仓的 helper，HEAD 上同样缺失），非本次引入 |
| `corepack pnpm@11.11.0 --filter @qianliu/web run lint` | 0 错误 0 警告（--max-warnings=0 通过） |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test` | **66 文件 / 482 用例全绿**（含 w20-resource-insights 9/9、provider-finance 19/19、official-balance-refresh.http 7/7、resource-insights-api-cost-evidence 2/2、provider-review 17/17） |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run typecheck` ＋ `lint` | 均 0 错误 |
| 未运行 | e2e（S6）；主仓/数据库包测试（零改动） |

基线对照证据：临时以 HEAD 版本替换 `resource-insights/routes.ts`+`query.ts`（纯文件级，已恢复）复跑 `provider-finance.test.ts` 19/19 通过 → 证明该文件 2 例失败确由投影收口引起并已正确迁移（其一为 DARK 用例的前置用例中断级联）。

## 3. 与合同偏离点及原因

1. **事故披露**（§0）：10 文件曾误写主仓，已精确回滚并逐文件验证 `== HEAD`。主仓剩余的在途修改（V4 evidence、openspec/README.md、未跟踪 e2e helper 等）自始至终未触碰。
2. **`query.ts:24` 类型扩展**：合同授权"字段恒 null 或删除，同步类型"点名 web 类型；后端 `ResourceUtilizationRow.purchaseCashAmount` 需同步放宽为 `string | null` 才能 typecheck，属同一收口的相邻类型改动（resource-insights 域内）。
3. **`ResourceUtilizationPanel.tsx:109` 措辞**：不在合同交付 5 点名清单，但属目标"资源页面费用命名统一"与 inv §1.2 展示点清单，且交付 8 点名其测试系；做最小措辞替换（1 处），无测试断言变化。
4. **列头命名**：ResourceTable 列头改"官方余额 / 订阅"（API 行＝官方余额，CP 行仍＝订阅金额实付，不能单称"官方余额"）；ResourceBreakdown 拆列同理。
5. **`lib/currency.ts` 零改动**（合同交付 9）：官方余额复用既有 `currencyMoney`，行内金额回退逻辑落点为 `usage-cost.ts costMoneyText`（usage-cost 在 §3.1 允许清单），无需扩展 currency.ts。
6. **`UsageOverviewPanel.tsx:35/:50` 的 `¥` 回退保留**：合同交付 5 仅点名 RequestDrilldown :79/:211/:263 做币种消费；overview 聚合 `apiCost` 本身无币种字段（混币时为 null），不在本阶段范围（见 §4-3）。
7. **`UsageRow.tsx` 未改**：其 ：35 缺失文案走 `unavailableUsageCostLabel`（已扩分支），行内币种 `costCurrency` 原本已消费（:43-44），无硬编码问题。

## 4. 剩余问题 / 移交项

1. **价格依据角标数据可得性结论（裁定 7 核查项）**：**逐请求维度数据可得，已消费**。核查结论：gateway-requests 路由虽未透出合同猜测的 `priceBasis[].sourceStatus`，但结算时冻结在 `ledger_line.billing_rule_snapshot` 的 `sourceStatus`（gateway `billing.ts:147` 写入，旧快照缺省按 UNVERIFIED）已随 `/gateway-requests/:id/attempts` 的 `metering[].billingRuleSnapshot` 原样透出 → RequestDrilldown 已实现逐计量行/计价决策卡的"价格依据待核实"角标。**无需扩 WP1 合同**。局限：角标只在请求下钻维度；估算聚合处（overview/账单）的角标依赖 `gaps` 的 `PRICE_BASIS_UNVERIFIED`，后端当前未在聚合 gaps 中产出该码（usage `costStatus` 枚举无此值），故聚合维度角标暂不可达——`usage-cost.ts` 分支已就绪（前向兼容），聚合透出归 WP1/后端域。
2. **ResourceBreakdown 官方余额数据缺口（回执报告项）**：`GET /provider-resources/usage-overview`（dashboard-breakdown 链）无 C2 `official_balance` 字段，API 行官方余额列按合同降级"—"；未新增后端字段（后端属 S4/移交）。若 S4 接通，前端仅需替换该单元格。
3. **settlement 级币种未透出**：`/gateway-requests/:id` 结算汇总无币种字段（ledger_transaction 无 currency 列；行级币种在 billing_rule_snapshot），结算金额按合同回退 ¥。如需精确标注需后端透出（WP1/gateway-requests 域，本阶段未扩）。
4. **e2e 基线缺陷维持**：wt-web.spec.ts 引用的 5 个 helper 仅存于主仓未跟踪区（本次未复制、未重建，遵守裁定 2）；web typecheck 的 6 个 e2e 错误与之同源，S6 前需用户裁定。
5. **web 首跑抖动记录**：ProviderFinanceActivationWizard.test.tsx 首轮全量失败 1 例、单独跑与复跑均过——属环境/时序抖动观察项，非本次改动（S3 域文件零 diff），S6 复跑时留意。
6. **`POST /provider-resources/:id/purchases`**（inv §9.1）等 WP2 域移交项不在 S2 范围，未触碰。

## 5. 证据

- web 全量：`Test Files 95 passed (95) / Tests 756 passed (756)`（复跑两轮一致）。
- control-api 全量：`Test Files 66 passed (66) / Tests 482 passed (482)`。
- 受影响集成套件：w20-resource-insights `9 passed (9)`；provider-finance `19 passed (19)`；official-balance-refresh.http `7 passed (7)`；resource-insights-api-cost-evidence `2 passed (2)`；provider-review `17 passed (17)`；consumer-projection＋resource-insights/routes 单测 `14 passed (14)`。
- web typecheck：`grep "error" | grep -v "e2e/"` 计数＝0；web lint / control-api typecheck+lint 输出均无错误行。
- 工作树：`git diff --stat`＝22 files changed, 467 insertions(+), 82 deletions(-)；未跟踪仅 WP4 notes/plan（预期内）。
- 主仓恢复验证：10 个误写文件反向应用后逐一与 `git show HEAD:<path>` 全等（脚本输出 10×"reversed == HEAD"）。
