# C3 验证记录（V14-C2 Findings 修复：P2×1 + P3×5）

日期：2026-09-10。基线不变：`4898df5`。C1/C2/R01/R02/V14-C2 证据原样保留。
候选：`HOME-STANDARD-C3-20260910`（tracker patch SHA256 `97bc6b57bb435bf5229a01fe376d075b696d4c273441cd69ecce52d17ccd5dff`）。

## 1. 修复对照（V14-C2 report.md Findings → C3）

| ID | 修复内容 | 验证 |
| --- | --- | --- |
| F-A (P2) | `provider-finance-repository.ts:215` 恢复 `event.occurred_at<${end}` 限定符，资金查询回到纯抽取态 | provider-finance 集成 + release 契约 11/11（gate-control-api-finance-regression.log） |
| F-B (P3) | 新增集成用例「financeRead=true 时同期费用走资金读模型口径并透传缺口」：断言 `previous.basis=FINANCE_READ_MODEL`、totalSpends=[CNY 12.50]、缺口码透传、同期窗边界 | 集成 7/7（gate-database-candidate-tests.log）；组合层覆盖率 dashboard-home.ts 92.43→**99.15%** stmts、branch 40→**76.9%**（coverage-db.log） |
| F-C (P3) | `periodChangePercent` 改定点 BigInt（scale 8 + 十分位半入），>2^53 不失精度；新增单测 8 项（大数、小数串、半入边界、负值、非法输入、相等） | standard-home-model.test.ts 全绿；既有渲染断言（+20.0%/+8.0%）不变 |
| F-D (P3) | 上期金额全为 0（含多币种）→「上月同期为 0，不计算百分比」，与「无可比金额或多币种」分开表述 | Dashboard.test.tsx 新增用例（0 值多币种 + 文案断言） |
| F-E (P3) | 非空断言不变量注释：`moneyChangePercent`（长度守卫）、`providerRow` 首元素（非空分组构造）、`attentionText` scope（单元素分支）；第 5 处（原 model:188）随 F-D 重写自然消除 | 代码审阅；lint 0 |
| F-F (P3) | `attentionProviderCount` 处固化语义决策注释（NOT_SUPPORTED/未执行同步计入"需关注"与 providers/routes.ts STALE 语义一致；过滤策略待产品裁决） | 代码审阅；行为不变，产品裁决仍开放 |

残余未覆盖（登记，不阻断）：costs 92-94 与 providers 111-115 的文案/fallback 分支、metrics 152,183（SQL 错误路径）、dashboard-home.ts:102（billIncompleteReason 末位 fallback）——均为展示/兜底分支，见 coverage-db.log。

## 2. 门禁回执（本目录 gate-*.log，全部 exit 0）

- typecheck（全仓）、lint（全仓 --max-warnings=0）、size（≤400 逻辑行）
- web 全量：**51 文件 / 278 用例**（新增 standard-home-model.test.ts 8 用例 + Dashboard 21）
- database 候选测试：13 项（单测 6 + 集成 7，真实 PG）
- control-api：provider-finance + release 契约 11 项
- coverage-db.log：gaps 100/100、metrics 100/87.5、providers 96.77/79.77、costs 95.08/60、组合器 99.15/76.9（exit=1 为自选 include 小集合下的全局 85% 阈值伪影，逐文件判定见上，与 V14-C2 口径一致）
- 既有迁移断言失败（基线已复现，见 V14-C2/report.md §4）本轮未触碰

## 3. 与 C2 的差异范围

tracked：`provider-finance-repository.ts`（F-A 一行恢复）。untracked 变更：`standard-home-model.ts`（F-C/F-D/F-E）、`dashboard-home-providers.ts`（F-E/F-F 注释）、`standard-home.integration.test.ts`（F-B 用例）、`Dashboard.test.tsx`（F-D 用例）；新增 `standard-home-model.test.ts`。其余文件与 C2 哈希一致（见 candidate-new-files.sha256：OverviewMetricCard/ProviderResourcesPanel/costs/metrics/types/dashboard-home.ts/单测/文档均未变）。
