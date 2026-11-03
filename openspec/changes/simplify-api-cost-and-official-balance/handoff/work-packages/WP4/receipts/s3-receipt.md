# WP4 S3 回执（task 5.2：套餐与订阅＋API 旧资金只读）

实施：glm-flash 子 Agent；日期：2026-11-04；分支 `codex/simplify-api-cost-and-official-balance`（不 commit，改动留工作树）。
基线复核：开工 `git status --short` ＝ S2 的 22 个修改文件＋未跟踪 WP4 文档（notes/plan.md/receipts/），与合同预期一致。全程只在 `/Users/mac/Projects/仟流智算-api-decouple/` 内写文件，主仓 `/Users/mac/Projects/仟流智算` 零触碰（其工作区的在途修改开工前已存在，非本阶段产生）。

## 1. 改动文件清单（S3 新增改动；其余 M 文件为 S2 交付，未触碰）

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/resources/ResourceTabs.tsx` | finance Tab 标签 "充值与订阅"→"套餐与订阅"（AFR-04）。 |
| `apps/web/src/components/resources/ResourceOnboardingSection.tsx` | :325 CP 引导改为"…在'套餐与订阅'中登记"；:328 API 期初/充值/资金账本整句退役，改"API 资金期初与充值已退役；费用参考 API 费用估算，余额参考官方账户余额"（AFR-01/§5 WP2 合同迁移指引）。 |
| `apps/web/src/components/resources/ProviderFinancePanel.tsx` | 标题/按钮改"套餐与订阅"/"订阅登记"，副文案改 Coding Plan 套餐语义；删除 API 充值类型钮、当前余额卡、充值金额/充值时间与 kind="API" 分支（登记表单只面向 CODING_PLAN，打开时非 CP 选中自动落到首个 CP 资源）；摘要卡移除"API 经营成本"/"当前 API 余额"（grid 5→3）；月度资金记录表改名"{month} 历史资金记录（旧口径，只读）"＋退役说明＋新增"来源"列（ADMIN/MANUAL/IMPORT/PROVIDER_SYNC/SYSTEM_RENEWAL/MIGRATION→中文标签，未知原样展示）；`SubscriptionAutoRenewal`/`SubscriptionHistory`/CP 表单零语义改动。 |
| `apps/web/src/api/provider-finance.ts` | 删除 `useProviderFinanceBalance`（唯一消费点＝已退役 API 充值表单）与 balance query key；`useRecordProviderFinance` 收窄为 CODING_PLAN-only（W4 `/finance/recharges` 已 410，客户端 API 写分支删除）。GET summary/events/periods 与缓存失效逻辑原样。 |
| `apps/web/src/components/resources/ActivationDraftEditor.tsx` | 三个 API 草稿区（期初/历史充值/历史消耗）编辑 UI 整体退役（删除 `OpeningRowFields`/`RechargeRowFields`/`HistoricalCostRowFields`、对应 DraftSectionCard、`requiredAccounts`/`cutoverAt` props）；CP 购买/续费、跨切换周期、旧记录关闭三区原样保留；LegacyRowFields 的 MIGRATED 提示改指向服务端退役拒绝（原文案指向已退役的「历史 API 充值」区）。 |
| `apps/web/src/components/resources/ProviderFinanceActivationWizard.tsx` | :196"请补齐 API 期初、历史充值…"措辞退役（改 CP 购买/续订＋旧记录关闭，注明 API 登记已退役）；不再向编辑器传 `cutoverAt`/`requiredAccounts`。 |
| `apps/web/src/components/resources/activation-draft-state.ts` | `DRAFT_SECTION_LABELS` 三个 API 区标签加"（已退役）"（Record 类型完整性保留，历史本机草稿的校验提示可见）。 |
| `apps/web/src/components/resources/activation-preflight-model.ts` | :30 OPENING_BALANCE 类别标签加"（已退役）"；GAP_CODE_LABELS 删除 4 个 API 期初缺口码文案（:43-46，服务端已不产，回退服务端 message）。 |
| `apps/web/src/pages/OperatingBillRechargeEntry.tsx` | 删除（API_RECHARGE 登记表单整体退役；该组件实为孤儿——全仓无挂载点，仅自测试引用）。 |
| `apps/web/src/pages/OperatingBillRechargeEntry.test.tsx` | 删除（3 个用例全为 API 充值表单用例，无 CP 用例可保留）。 |
| `apps/web/src/components/operating-bill/MonthlyPayments.tsx` | `API_RECHARGE` 标签 "API 充值"→"API 充值（历史）"（历史实付事实保留＋历史口径标注）。 |
| 测试：`ProviderFinancePanel.test.tsx` | API 充值提交流用例删除（注明 AFR-01），替换为"API 资源无充值表单＋登记表单只列 CP 资源"用例；CP 提交/重复入账用例迁移到新按钮名"订阅登记"与 CP 字段。 |
| 测试：`ProviderFinancePanel.confirmation.test.tsx` | 夹具 API 资源→CODING_PLAN；open() 补 CP 必填字段（服务周期开始日）；按钮/区域名与字段名同步；幂等/重复候选/只读锁语义断言原样保留。 |
| 测试：`Resources.test.tsx` | DARK 用例改断言 Tab 名"套餐与订阅"＋摘要无 API 经营成本/当前 API 余额卡；ACTIVE 用例走"订阅登记"入口；:325/:359 引导文案断言同步；新增 2 用例（AFR-01 场景1 API 资源无充值表单；历史资金记录只读区渲染来源标签＋无写按钮）。 |
| 测试：`ActivationDraftEditor.test.tsx` | 删除"历史 API 充值行六项"（3 用例）与"历史 API 消耗行"（2 用例）——注明 AFR-01；新增"API 资金草稿区退役"2 用例（无添加期初/充值/消耗入口，即使旧草稿含 API 行）；CP 购买与跨切换周期用例保留。 |
| 测试：`ProviderFinanceActivationWizard.test.tsx` | NO_GO 缺口断言迁为服务端 message 回退＋退役文案不出现；R3 清除草稿种子由期初行改为 CP 购买行（期初 UI 已退役）；其余候选时效/幂等/取数链路用例原样。 |
| 测试：`activation-preflight-model.test.ts` | :67 类别标签断言同步"API 期初余额（已退役）"。 |
| 测试：`MonthlyPayments.test.tsx` | 新增 1 用例：API_RECHARGE 流水以"API 充值（历史）"呈现。 |

未触碰（核对过）：`FinanceInitializationPanel.tsx`（两个分支结构保留）、`FinanceInitializationPanel.test.tsx`、`activation-draft-model(.test).ts`/`activation-draft-validation.ts`/`activation-draft-payload.ts`/`draft-autosave(.test).ts`（类型/序列化/校验层按合同保留，测试全绿）、`api/provider-finance-activation*`、`resource-form-contract.ts`（`API_OPERATING_KEYS` 已为空集，登记表单无资金字段）、operating-bill 其余组件（S4）、e2e、后端全部文件。

## 2. 命令与用例数

- `corepack pnpm@11.11.0 --filter @qianliu/web run test` → **Test Files 94 passed (94)；Tests 753 passed (753)**，全绿。用例净变化：−3（RechargeEntry 删）−3（ActivationDraftEditor API 区 7→4，删 5 增 2）＋2（Resources 新增）＋1（MonthlyPayments 新增）＝净 −3，即基线 756→现 753。
- `corepack pnpm@11.11.0 --filter @qianliu/web run lint` → 0 error 0 warning（`--max-warnings=0`）。
- `corepack pnpm@11.11.0 --filter @qianliu/web run typecheck` → src 0 错误；全项目仅 6 个 e2e 错误（`e2e/global-setup.ts`、`e2e/wt-web.spec.ts` 引用 5 个从未提交的 helper——inv §7.2 已知基线缺陷，本阶段未触碰 e2e）。
- 未运行 e2e、未写库、未发送任何消息（合同红线）。

## 3. 偏离点及原因

1. **historicalApiCosts（历史 API 消耗）草稿区编辑 UI 一并退役**（合同 item 4 字面只列 apiOpeningBalances/historicalApiRecharges）：后端 `activation-contracts.ts:21-26` 明确"三类 API 资金事实（api_opening_balances/historical_api_recharges/historical_api_costs）任一非空即显式拒绝"，:174-176 三键同判；保留该表单＝提供必然预检失败的表单，与合同目标"激活草稿 API 区从 UI 退役（AFR-01）"直接冲突，故按目标口径纳入退役。类型/序列化层与模型测试按合同保留。
2. **OperatingBillRechargeEntry 选择删除而非"简短说明"**：组件为孤儿（无任何挂载点），"说明"无处渲染；删除＋删自测试即"整体退役"。后端 `POST /provider-resources/:id/purchases` 未动（plan §3.1 裁定 3）；客户端 `useRecordResourcePurchase` hook 保留（`operating-bills.pool043.test.tsx:134` 有 hook 级测试钉住，未在本包测试清单内）。
3. **客户端写/读函数随表单删除**：`useRecordProviderFinance` 的 kind="API" 分支与 `useProviderFinanceBalance` 均仅被退役表单引用，按合同"可一并删除，回执说明"处理；`ProviderFinanceBalance` 类型与 GET 端点本身未动。
4. **LegacyRowFields 的 MIGRATED 提示语改写**：原文案"还需要在「历史 API 充值」中登记…"指向已退役草稿区，按 item 4"措辞退役"改写为服务端退役拒绝口径；legacyResolutions 区本身零功能改动。
5. **摘要卡"经营成本合计"（operatingCostCny，含 API 分量合成值）与"人民币实付"（cashOutflowCny，含 API 充值实付）保留**：合同仅点名 :204/:207-210 两卡退役；两卡属历史/合成口径，是否需改 CP-only 口径移交 S4/总指挥裁定。
6. **GAP_CATEGORY_LABELS.RECHARGE（"历史 API 充值"）与 MISSING_RECHARGE_AMOUNT/CASH_PAID 两码文案未动**：合同仅点名 :30/:43-46；同类已死文案（服务端拒绝 API 行后不可达）留作移交项。

## 4. 剩余问题/移交

1. **e2e 基线缺陷维持**：`wt-web.spec.ts` 引用 5 个从未提交的 helper（含 `finance-subscription-flow`），整个 `test:e2e` 不可运行；`wt-web.spec.ts:61` 仍有"充值与订阅"字样（不碰 e2e ＋ spec 本身坏，未改）。待总指挥裁定 helper 处置后，S6 前需补"套餐与订阅"命名与 AFR-01 场景的 e2e 断言。
2. **后端 purchases 端点**：前端 API_RECHARGE 表单已退役，`POST /provider-resources/:id/purchases` 仍可写（裁定 3 明示后端不动）——是否补 410/守卫移交 WP2 域/总指挥。
3. **偏离点 5/6**的两组合成口径/死文案候选，建议 S4（账单/首页）或 S6 收口时统一裁定。
4. 未核实项：无新增。S1 遗留的 e2e/seed 项维持原状（本阶段未涉及）。

## 5. 证据（关键输出行）

- 测试：`Test Files  94 passed (94)` / `Tests  753 passed (753)` / `Duration  18.53s`（vitest run，2026-11-04）。
- lint：`eslint src --max-warnings=0` 无输出（0 error 0 warning）。
- typecheck：`error TS` 全项目 6 条，全部位于 `e2e/global-setup.ts(15)` 与 `e2e/wt-web.spec.ts(8-12)` 的 TS2307（缺失 helper）；`grep "error TS" | grep -v "^e2e" | wc -l` ＝ 0。
- 残留检查：`grep -rn "充值与订阅|充值／订阅|useProviderFinanceBalance" apps/web/src`（排除测试）零命中（exit=1）。
- 后端拒绝范围核实：`apps/control-api/src/provider-finance/activation-contracts.ts:21-26`"三类 API 资金事实…任一非空即显式拒绝（不静默剥离后继续激活混合候选）"。
- git：`D apps/web/src/pages/OperatingBillRechargeEntry.tsx`、`D apps/web/src/pages/OperatingBillRechargeEntry.test.tsx`；主仓 `git status` 与开工基线一致（在途修改为其他任务所有）。
