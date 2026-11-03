# WP4 本包计划：页面、导出与历史阅读（tasks 5.1～5.4）

版本：v1.0；日期：2026-11-03；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（串行，实施者不自审）。

## 1. 目标与对应关系

浏览器/展示层收口：所有现行页面/导出/含 API 金额报表统一新口径（API费用估算＋官方账户余额＋资金退役），历史与当前明确区分，交付浏览器级联调证据。

| Task | Requirement | 验收 case（本包负责的展示层） |
|---|---|---|
| 5.1 资源/用量页面 | ACE-01/03/04、OAB-01/02/03/04、AFR-01/02 | 浏览器核对 **ACE-01、OAB-01/04、AFR-07**（task.md 指名）＋ AT-AFR-01（资金表单退出）、AT-OAB-03/08 展示、AT-ACE-04 价格依据待核实角标 |
| 5.2 套餐与订阅＋历史只读 | AFR-01/04/06 | AT-AFR-01/04/06；旧金额来源可追溯且不可修改 |
| 5.3 首页/账单/年度/CSV/部门项目 | ACE-06/07、AFR-07 | AT-ACE-13/14（综合费用措辞＋混币分列）、AT-AFR-13/14 展示；缺价格/多币种/关账历史展示 |
| 5.4 报表/通知盘点 | ACE-06（通知域） | 实际含 API 金额产物换名＋完整性标注；纯 Token 模板与投递配置零改动；不发送任何消息（含补发） |

待联调（不填 PASS）：AT-X06 全页同源归 WP5 汇总核对；跨服务场景归 WP5。

## 2. 输入基线与依赖

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `745dae4`（＝WP3 结包 `ab86484`＋WP4 任务书；含远端主线 `ae506fed…933e`；2026-11-03 开工复核，工作树干净）。
- 后端合同（**直接消费、不改语义**）：WP1 `api-estimation-contract.md` v1.1（§5 WP4 消费指引四条）；WP2 `retired-api-funding-contract.md`（§5 客户端迁移指引）；WP3 C2＝GET /provider-resources `official_balance` 字段（s4-receipt §3 状态矩阵）＋`POST /provider-resources/:id/official-balance/refresh` 三态（ops-runbook §3）。
- WP2 遗留三项展示域欠账（本包收口）：① `apps/web/src/components/dashboard/standard-home-model.ts:87` 缺口码映射 `OPENING_BALANCE_MISSING`；② `apps/control-api/src/resource-insights/routes.ts` `projectFinanceUtilization`（`apiCost ?? account.monthlyApiCost` 兜底覆盖／`currentBalance`／`purchaseCashAmount ?? "0.00000000"` 充值兜底串）；③ `BRIDGE_UNAVAILABLE` 展示（`apps/web/src/pages/OperatingBillOverview.tsx:103-105` 消费区）。
- WP3 移交观察项：dispatch 全来源保留（quota ratio 偏好调度，非余额硬拒绝）——页面若出现相关表述按此口径，不渲染为"余额耗尽拒绝"。

## 3. 交付物与允许范围

| 交付 | 允许修改（S1 后可修正并记录依据） |
|---|---|
| 资源列表/详情/用量（5.1） | `apps/web/src/pages/Resources.tsx`、`pages/Usage.tsx`、`pages/RequestDrilldown.tsx`、`components/resources/**`、`components/usage/**`、`src/api/**`（客户端类型/取数） |
| 套餐与订阅＋历史只读（5.2） | `pages/OperatingBillRechargeEntry.tsx`、`components/operating-bill/OperatingProcurement.tsx`、`components/resources/ProviderFinancePanel.tsx`、`FinanceInitializationPanel.tsx` 等 API 分支处置；旧资金只读入口组件 |
| 首页/账单/年度/CSV/部门项目（5.3） | `pages/Dashboard.tsx`、`components/dashboard/**`、`pages/OperatingBill*.tsx`、`components/operating-bill/**`、CSV/导出工具函数 |
| 报表/通知（5.4） | 仅实际含 API 金额的模板/产物；`packages/domain/reports/**`（如涉及，只改名称/完整性标注，不动纯 Token 模板与投递配置） |
| 展示域后端投影 | `apps/control-api/src/resource-insights/routes.ts`（遗留欠账②；不改估算/退役语义） |
| e2e 夹具 | `apps/control-api/src/cli/seed-e2e.ts`（官方余额快照/估算消费等播种，如需）＋`apps/web/e2e/**` 新 spec |
| 测试/文档 | web 组件测试、e2e spec、页面说明文档；本包回执/report |

**禁止**：动 WP1 估算读取语义、WP2 退役合同（410/19 入口表/O1a/O2 守卫）、WP3 0095/0096/三态契约/恢复链；packages/database 迁移与 repository（**预计无新迁移；确需时 0097 起、先报批**）；已关账快照/CLOSED 版本渲染语义（只加旧口径标识，不改金额）；员工月度额度（0092）与 Worker 报表既有行为；纯 Token 模板、发送配置、任何真实消息发送；不新增厂商适配/自动充值/抓价/汇率；不改 spec；不用 mock/静态截图冒充 e2e。

### 3.1 S1 后范围增补与总指挥裁定（2026-11-03，依据 notes/inv-wp4.md，抽核 5/5 属实）

1. **范围增补**（均为七行表/验收 case 必需的相邻文件）：`apps/control-api/src/usage/routes.ts`（用量 CSV "API费用"表头/完整性，AT-ACE-13/14）；`apps/web/src/lib/usage-cost.ts`（缺口文案分支补 PRICE_MISSING/PRICE_BASIS_UNVERIFIED/CURRENCY_MISSING，ACE-04）；`apps/web/src/lib/currency.ts`（混币分列渲染）；`apps/web/e2e/` 新增 WP4 独立 spec；`components/resources/activation-*`＋`ProviderFinanceActivationWizard` 簇归 S3（API 分支退役）。
2. **e2e 主 spec 基线缺陷**：`wt-web.spec.ts`（HEAD 已提交）import 5 个从未提交的 helper（现存于主仓 `/Users/mac/Projects/仟流智算` 工作区未跟踪区，属其他任务在途修改，**不得动主仓**）。裁定：WP4 e2e 以**指定 spec 文件**运行（Playwright 按文件过滤不转译坏 spec）；全量 `test:e2e` 不可运行记为基线缺陷移交用户裁定是否补提交 helper。本包不复制、不重建该 5 文件。
3. **`POST /provider-resources/:id/purchases`**：核实只写 `resource_purchase_record`＋operation_log（不写 provider_finance_event，CLOSED 月有写屏障）——语义＝采购实付记录，与 WP2 合同 O1a/O1b 同域判定，**后端不动**；S3 退役前端 `OperatingBillRechargeEntry` 的 API_RECHARGE 表单（AFR-01 UI 层），报告记录移交。
4. **历史/现行分流维度**：以 `bill.status==="CLOSED"` 判定历史口径保留（D5/AFR-06）；DRAFT 一律新口径。
5. **"充值与订阅"改名形态**：Tab/标题改"套餐与订阅"（AFR-04），API 旧资金保留为 Tab 内"历史资金记录（旧口径，只读）"区块，不拆独立路由。
6. **e2e 官方余额夹具策略**：seed 播种 `source='PROVIDER_SYNC'＋balance_source='PROVIDER_API'` 快照＋SUCCESS attempt（展示态）；刷新交互以无凭证资源测 409 错误态——全程零真实上游调用。
7. **价格依据角标**：S2 先核 gateway-requests 透出字段；逐请求维度不可得时落点为估算聚合处角标，逐请求级记待办，不擅自扩 WP1 合同。

## 4. 阶段与分工（全部 glm-flash 串行；合同含目标/范围/禁止/验收/回报格式）

| 阶段 | 内容 | 验收方法 |
|---|---|---|
| S1 只读调查 | 盘点 web 全部受影响文件与数据流（v2-types/API 客户端→组件）、三项遗留精确改法、e2e 基础设施与 seed 扩展点、报表/通知含 API 金额产物清单、CSV 导出路径、历史只读入口现状、组件测试盘点；产出 `notes/inv-wp4.md` | 总指挥抽核 ≥3 项 file:line |
| S2＝5.1 | 资源/用量页面：官方余额 C2 接线（status 主标记＋`expired`/`last_attempt_failed` 布尔叠加渲染＋`next_refresh_at` 冷却展示＋刷新按钮调三态端点）、估算命名统一、移除 API 资金操作表单、缺口码映射收口 | 组件测试＋e2e spec（真实 API） |
| S3＝5.2 | 充值与订阅→套餐与订阅；API 资金表单退役（前端侧）；旧 API 资金只读入口（来源/版本保留） | 组件测试＋e2e |
| S4＝5.3 | 首页/账单/年度/部门/项目/CSV 列与"综合费用（含 API 估算）"措辞、混币分列、期初/充值/内部结余/待补账提示退出、遗留②③收口 | 组件测试＋e2e＋CSV 断言 |
| S5＝5.4 | 报表/通知盘点处置＋文档更新（页面说明） | 盘点清单＋本地预览/导出文件 |
| S6 | 全量复跑（web 测试＋e2e＋全仓相关包回归＋typecheck/lint＋openspec strict）＋浏览器证据归档 | 总指挥独立复跑＋截图/导出证据 |

证据目录：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP4-20261103/`（截图、CSV、导出文件、e2e 日志）；回执在 `handoff/work-packages/WP4/receipts/`。

## 5. 完成条件

- 七行表逐行落地：现行页面口径统一；历史与当前明确区分；浏览器证据为真实 API 联调（Playwright `_e2e` 专用库）。
- 界面红线全过：货币余额不进 Token 剩余额度；无一刀切隐藏"余额/额度"（套餐照常）；API 无资金初始化/充值表单；多币种分列；界面冷却/下次刷新时间消费后端字段零硬编码。
- 报表/通知仅含 API 金额产物改动；纯 Token 模板与投递配置 diff 为零；零消息发送。
- 已关账版本与旧资金历史：金额/来源/版本不变，可识别为历史记录。
- 范围外零改动（git diff 证伪）；待联调项如实记 NOT_RUN。
- tasks.md 5.1-5.4 仅在对应交付＋验证完成后勾选。
