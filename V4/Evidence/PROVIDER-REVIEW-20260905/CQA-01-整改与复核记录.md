# CQA-01 Token 一致性整改与复核

> 后续口径修正（2026-09-05）：用户明确只执行 I1，不再要求 I2。本轮 CQA-01 已通过 I1 复核关闭；下文 I2 相关限制不再作为推进门槛。后续两项 P3 的处置见 [P3 精度修复与 I1 复核记录](P3精度修复与I1复核记录.md)。本文件其余内容保留为 R2 历史记录。

日期：2026-09-05

基线：`6e4fb4b37e99ba0290f19c13a011adf53a34d1c0`

分支：`codex/provider-module-review-20260905`

## 整改范围

用户同意处置上一轮 V1.4 预审的 CQA-01：资源利用主表真实 Token 与利用率分子截止口径不一致。本轮没有修改额度分配、计费、凭证或采购复盘的业务规则。

- `listResourceUtilization` 增加可选 `asOf`，仅厂商资源利用快照传入；原采购复盘调用不传，保留旧自然月读取行为。
- 新 `loadResourceUtilizationSnapshot` 固定一个截止时间，在同一个 `REPEATABLE READ` 事务里依次读取主表与 Token 分子/基线；两者共享账本与资源列表的 MVCC 快照。
- `generatedAt` 返回统计截止时间。接口从快照组装 Token 结果，财务投影保留本月 Token 字段。
- 任一资源的 Token 聚合缺失时抛错并回滚，不返回缺字段或错误拼接的成功响应。
- 前端测试夹具的主表 Token 和利用率分子已统一，并断言主表文字与悬停信息一致。

## 回归证据

### 先失败后通过

真实接口回归在产品代码整改前失败：预期主表 `realTokens=100, requestCount=1`，实际为 `1000,2`；同一响应的 `tokenUtilization.currentMonthTokens` 是 `100`。

整改后 API 与 Coding Plan 均返回 `100,1,100`，未来结算记录不进入当前 Token/请求数，`generatedAt` 与统一截止时刻相同。直接调用不传截止时刻的旧查询仍返回 1000，确认采购复盘旧合同未被静默改写。

### 并发与失败场景

- 在真实主表 SELECT 完成后，通过另一数据库连接提交 900 Token 及新资源；当前响应仍为主表 100 / 分子 100，且不提前出现新资源；下一响应一起变为 1000 / 1000 并显示新增资源。
- 在真实 SQL 返回边界注入 Token 结果缺失：接口返回 500 且不返回 resources；数据库无 `idle in transaction` 会话；下一请求恢复 200 且所有资源满足 `realTokens === currentMonthTokens`。
- 故障注入只用于 PG17 测试库，不修改生产 SQL 或真实公司数据。

### 检查结果

| 检查 | 最新结果 |
| --- | --- |
| provider-review 集成 | 8/8 通过 |
| 资源利用/采购复盘既有集成 | 9/9 通过 |
| 财务投影回归 | 4/4 通过 |
| 资源利用组件 | 11/11 通过 |
| Control API / Web typecheck | 通过 |
| 受影响代码 ESLint / diff check | 通过 |
| source-size / architecture | 通过，417 个生产源码文件 |
| Web build | 通过；既有 bundle 大小提示仍保留 |
| token-utilization.ts V8 覆盖率 | 语句/分支/函数/行均 100% |

合计 32 项定向行为测试通过。覆盖检查最初为分支 83.33%，低于项目 85%；补上聚合缺失的失败关闭测试后达标，没有降低阈值。V8 不展开 SQL 字符串内的 CASE/FILTER，SQL 语义依靠上述实库断言；该文件覆盖率不能代表全候选 V1.4 质量门禁已全部通过。

检查使用显式 `/usr/local/bin/node`，Vitest 3.2.4、PG17 Testcontainers。相关命令：

```text
apps/control-api:
../../node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts src/__tests-integration__/provider-review.test.ts --maxWorkers=1 --no-file-parallelism --coverage --coverage.include=src/resource-insights/token-utilization.ts --coverage.reportsDirectory=/tmp/qianliu-cqa01-fixed-r2-coverage
../../node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts src/__tests-integration__/provider-review.test.ts src/__tests-integration__/w20-resource-insights.test.ts src/provider-finance/consumer-projection.test.ts --maxWorkers=1 --no-file-parallelism
apps/web:
../../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/components/resources/ResourceUtilizationPanel.test.tsx
node_modules/vite/bin/vite.js build
```

## 对象与审阅记录

- 初始整改代码摘要：`eed4a599fb69c210fa70b7086112757894dbd307e6dd247fd72db1f5a423420f`。
- 因缺失异常分支测试，暂停首次审阅；仅增加测试后重新冻结，保留初始对象记录。
- 当前对象：`CQA-01-整改代码对象-R2.json`。
- 当前代码/测试摘要：`e6d9c1a4ea082ee1c05298e18885ea945347c02844dec6e463887f406339c914`。
- Reviewer：`/root/provider_review`，未参与实现，不继承实现聊天历史；同模型族的新会话，实际独立性为 I1，不宣称 I2。
- 审阅回传：**CQA-01 后端截止与快照一致性问题可关闭；未发现新增 P0/P1/P2，另记录两项 P3 显示精度问题。**
- Reviewer 首尾核对 R2 清单的 21 个文件，逐文件 SHA 均一致；审阅未修改实现、测试或既有 Evidence。
- Reviewer 通过只读代码检查及 Node 表达式复核给出意见；未重复运行测试，前述测试结果为执行方证据。

## I1 复核意见及剩余事项

CQA-01 关闭依据：同一截止时间与 `REPEATABLE READ` 快照覆盖资源列表、主表指标、新 Token 聚合；两側结算过滤一致，财务投影不覆盖主表 Token；真实数据库并发和结果缺失的故障注入断言保护该约束。采购复盘不传 `asOf`，原合同继续成立。DeepSeek 有效池优先、历史 Grant 回退及缓存失效键也符合批准计划。

以下两项 P3 未修改，待产品/技术 Owner 决定处置；记录不等于已经接受残余风险：

| ID | 位置 | 触发与影响 | 最小处置建议 |
| --- | --- | --- | --- |
| CQA-P3-01 | `ResourceUtilizationPanel.tsx:24` | `rate="0.01150000"` 经 `Number * 100` 再 `toFixed(1)` 显示 1.1%，十进制四舍五入应为 1.2%；E2E 期望复用了相同表达式，不能保护该边界 | 使用精确十进制百分比格式化并增加半位边界断言 |
| CQA-P3-02 | `ResourceUtilizationPanel.tsx:86` | `realTokens="9007199254740993"` 在主表经 Number 显示为 9,007,199,254,740,992，悬停 `formatCount` 显示精确原值；接口两个字段本身相等 | 主表复用 `formatCount(row.realTokens)`，增加超安全整数断言 |

P3-02 的主表 Number 转换属于既有代码，由新增精确悬停暴露差异；不视为 CQA-01 接口快照问题复发。当前场景量级极高、原始接口值正确，未升级为 P2。

实际独立性为 I1：新 Reviewer 会话、无实现过程聊天、未参与作者链，但同模型族。正式 V1.4 PASS 所需的同候选功能审计、冻结独立性等级、开审握手/预算/完整对象锁、全候选适用质量证据仍未齐备，本轮不作正式 PASS 声明。

## 交付边界

尚未提交、推送或部署。原 V1.4 预审报告保留，不覆盖其 Findings 与历史结论。本记录关闭具体整改与定向验证，不代替正式独立功能审核、完整 V1.4 质量门禁或公司实际数据验收。
