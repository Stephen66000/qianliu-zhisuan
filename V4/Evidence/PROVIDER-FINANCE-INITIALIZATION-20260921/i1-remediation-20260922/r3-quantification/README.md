# R3 必需量化门禁证据 — 资金核心路径

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-22 |
| 响应 | 复审拒绝意见 [P1/Evidence Gap]：「资金核心路径没有增量变异测试；没有资金变更代码覆盖率；complexity / cognitive complexity / CRAP 没有配置或报告」 |
| 对象提交 | `c88e366`（分支 `codex/provider-finance-initialization-20260921`，未推送） |
| 度量范围 | 资金激活核心：domain 投影五模块（草稿规范化 / 期初解析 / 守恒窗口 / 余额公式 / 缺口发射） |

## 一、增量变异测试（已执行，结果 61.10%，低于 break 阈值 —— 诚实登记）

新增配置（沿用项目既有 Stryker 惯例）：

- `packages/domain/stryker.provider-finance.json`：`mutate` 限定 5 个资金模块，
  `coverageAnalysis: perTest`，阈值 `break: 70`（沿用 GAP-MUT-1 的 70/80 惯例）；
- `packages/domain/vitest.provider-finance.mutation.config.ts`：测试集为两个资金投影单测文件。

执行命令：

```
cd packages/domain && corepack pnpm@11.11.0 exec stryker run stryker.provider-finance.json
```

结果（原始 JSON：`r3-quantification/pf-domain-mutation.json`）：

| 文件 | 变异总分 | killed | survived | no-cov |
|---|---|---|---|---|
| provider-finance-activation-balances.ts | 67.68 | 67 | 29 | 3 |
| provider-finance-activation-conservation.ts | 51.45 | 160 | 123 | 28 |
| provider-finance-activation-draft.ts | 58.64 | 129 | 88 | 3 |
| provider-finance-activation-inputs.ts | 57.14 | 36 | 26 | 1 |
| provider-finance-activation-projection.ts | 68.57 | 288 | 132 | 0 |
| **合计** | **61.10** | **680** | **398** | **35** |

**诚实登记**：61.10% **未达到** break 阈值 70%，Stryker 以退出码 1 结束。
存活突变体类型分布显示主要缺口是 `ConditionalExpression`（149 个）与 `StringLiteral`
（85 个，多为 gap message 文案）——即守恒/草稿模块的**分支级负路径**尚不足以杀死
全部分支突变。这是**后续测试增补的工作清单**（按文件×突变类型在 JSON 中可逐条导出），
本包**不通过下调阈值或豁免登记来掩盖**。本证据的作用是把"变异测试未执行"的
Evidence Gap 转化为**已量化、可复核、带改进清单**的 FAIL 态事实。

## 二、资金变更代码覆盖率（已产出）

测试集同上（两个资金单测文件），v8 coverage，原始 JSON：
`r3-quantification/pf-domain-coverage-summary.json`。

| 模块 | stmts | branch | funcs | lines |
|---|---|---|---|---|
| provider-finance-activation-projection.ts | 100 | 98.94 | 100 | 100 |
| provider-finance-activation-inputs.ts | 100 | 91.30 | 100 | 100 |
| provider-finance-activation-draft.ts | 100 | 96.42 | 100 | 100 |
| provider-finance-activation-balances.ts | 97.53 | 92.85 | 100 | 97.53 |
| provider-finance-activation-conservation.ts | 98.27 | 84.37 | 100 | 98.27 |
| provider-finance-activation-contract.ts | 68.65 | 88.88 | 66.66 | 68.65 |
| provider-finance-activation.ts | 93.91 | 81.48 | 89.47 | 93.91 |

核心投影五模块（一、表中的 mutate 对象）行覆盖 **97.5～100%**；
`-contract.ts` 与 `-activation.ts` 偏低的部分主要是错误分支与哈希序列化路径
（由 database 集成套件覆盖，不在本单测集内）。

## 三、复杂度 / cognitive complexity / CRAP（配置 + 报告，可复现）

- 脚本：`r3-quantification/complexity-report.py`（仅标准库，可独立复现：
  `python3 complexity-report.py <repo> <coverage-summary.json>`）；
- 报告：`r3-quantification/complexity-report.md`（115 个函数逐条 CC / cognitive / CRAP）。

摘要：

| 指标 | 值 |
|---|---|
| 函数总数 | 115 |
| MAX cyclomatic | 16（`projection.resolveOpeningAccounts`，行覆盖 100%） |
| MAX cognitive | 30（`projection.collectLegacyResolutionGaps`，行覆盖 100%） |
| MAX CRAP | 16.0（同 MAX CC；因被测函数覆盖率高，CRAP≈CC，无"低覆盖×高复杂度"热点） |

TOP10 中全部函数行覆盖 ≥94%，即**复杂度热点与测试盲区无重叠**。

## 四、第二轮整改（2026-09-23）：变异门禁复跑 **79.25% ≥ 70 —— 通过**

针对 61.10% 轮登记的 398 个存活 + 35 个无覆盖突变体，新增定向加固测试
`packages/domain/src/__tests__/provider-finance-activation-hardening.test.ts`（38 例）并纳入
变异测试集（`vitest.provider-finance.mutation.config.ts` include +1，**mutate 范围与
`break: 70` 阈值均未改动**）。覆盖目标：

- `inputs`：`compareStrings` 三分支 / `instantOf` 报错带原值 / `isWithin` 闭开区间四边界 /
  `hasTokens` 逐维度 / `isSameShanghaiDay` UTC+8 折算；
- `draft`：`usageRepairFieldDigests` 键名与目标/非目标字段敏感性（与 `hashStable` 手工期望对比）/
  `eligibleFieldsFor` 全分支 / `coveringPeriods` 起含终不含+冲销+跨资源+id 排序 /
  `planUsageRepairs` 全部修复分支（CNY/USD 快照、币种冲突仅补时间、零元确认、UNKNOWN_COST、
  NOT_APPLICABLE、周期唯一/歧义/缺失、touched=false 不入计划、基线行摘要与排序）；
- `conservation`：`shanghaiMonthOf`/`shanghaiMonthBounds` 错误信息与 `^`/`$` 锚点 / 12 月跨年 /
  `conservationMonths` 水位早于切换时报错、跨年多月、水位恰在月末（末月为下月 1ms 截断）/
  `mapMonthlyGapCode` 全 7 分支 / 逐月抵消四计数器 + 期初/现金封顶 `Math.min` /
  归属与分类缺口的精确 message/detail/月份；
- `balances`：`computeUsageDebitDeltas` 状态迁移增量（定价/转未知/换币种无增量语义）/
  `projectAccountBalances` 虚拟叠加、公式失配精确 detail、null 落库不校验、负余额、范围外跳过、排序。

结果（原始 JSON：`r3-quantification/pf-domain-mutation-round3.json`，独立重算 882/(882+231)=79.245%）：

| 文件 | 变异总分 | killed | survived | no-cov |
|---|---|---|---|---|
| provider-finance-activation-balances.ts | 79.80 | 79 | 20 | 0 |
| provider-finance-activation-conservation.ts | 81.99 | 255 | 56 | 0 |
| provider-finance-activation-draft.ts | 90.91 | 200 | 20 | 0 |
| provider-finance-activation-inputs.ts | 95.24 | 60 | 3 | 0 |
| provider-finance-activation-projection.ts | 68.57 | 288 | 132 | 0 |
| **合计** | **79.25** | **882** | **231** | **0** |

Stryker 判定：`Final mutation score of 79.25 is greater than or equal to break threshold 70`，
退出码 0。较 61.10% 轮新增歼灭 **202** 个突变体；无覆盖残留清零。
剩余 231 个存活突变体集中在 `projection.ts`（132，属公共投影编排层，其关键分支由
公共面测试与 database 集成套件守护）与 conservation/balances 的等价突变（如
`counted()` 换币种同金额恒等分支），已在闭环报告登记为后续改进清单，不影响本轮门禁判定。

## 五、与 V1.5 要求的对照（第二轮后更新）

| V1.5 R3 要求 | 状态 |
|---|---|
| 增量变异测试 | **已执行且达标**（第二轮 79.25% ≥ 70，break 阈值未改动；首轮 61.10% 已如实登记为历史 FAIL） |
| 资金变更代码覆盖率 | **已产出**（核心五模块 97.5～100% lines） |
| complexity / cognitive / CRAP 配置与报告 | **已产出**（脚本 + 逐函数报告，入库可复现） |
